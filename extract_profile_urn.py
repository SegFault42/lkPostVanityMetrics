#!/usr/bin/env python3
"""Fetch a LinkedIn profile HTML page and extract the profile URN component key.

The script replicates a browser visit to a profile vanity URL (e.g.
``https://www.linkedin.com/in/ramzib/``) and searches the returned HTML for the
``componentkey="com.linkedin.sdui.profile.card.ref<URN>Topcard"`` attribute that
appears on the top-card module. The ``<URN>`` portion uniquely identifies the
profile and is printed to stdout once extracted.

Environment variables ``LINKEDIN_COOKIE`` and ``LINKEDIN_CSRF_TOKEN`` must be
set to values copied from an authenticated browser session. They can be
overridden via ``--cookie`` and ``--csrf-token`` CLI arguments. The script
prints a JSON object with the extracted profile URN (`id`), the profile
vanity (`username`), the requested URL (`url`), and the best effort profile
image URL (`imageUrl`).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from html import unescape
from typing import Dict, Iterable, Optional, Tuple
from urllib.parse import urlparse

import requests

DEFAULT_PROFILE_URL = "https://www.linkedin.com/in/ramzib/"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
PRIMARY_COMPONENT_PATTERN = re.compile(
    r"componentkey[\s:='\"]+com\\.linkedin\\.sdui\\.profile\\.card\\.ref"
    r"(?P<urn>[A-Za-z0-9_-]+?)(?:Topcard|TopCard)?",
    re.IGNORECASE,
)

FALLBACK_COMPONENT_PATTERN = re.compile(
    r"com\\.linkedin\\.sdui\\.profile\\.card\\.ref"
    r"(?P<urn>[A-Za-z0-9_-]+?)(?:Topcard|TopCard)?",
    re.IGNORECASE,
)

IDENTITY_DASH_PATTERN = re.compile(
    r"identityDashProfilesByMemberIdentity.*?urn:li:(?:fsd?_)?profile:(?P<urn>[A-Za-z0-9_-]+)",
    re.IGNORECASE | re.DOTALL,
)

URN_PATTERN = re.compile(
    r"urn:li:(?:fsd?_)?profile:(?P<urn>[A-Za-z0-9_-]+)",
    re.IGNORECASE,
)

ROOT_URL_PATTERN = re.compile(
    r'"rootUrl"\s*:\s*"(?P<root>https://media\.licdn\.com/dms/image[^"\\]+)"',
    re.IGNORECASE,
)

ARTIFACT_SEGMENT_PATTERN = re.compile(
    r'"fileIdentifyingUrlPathSegment"\s*:\s*"(?P<segment>[^"\\]+)"',
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Fetch a LinkedIn profile HTML page and extract the profile URN "
            "from the top-card component key."
        )
    )
    parser.add_argument(
        "url",
        nargs="?",
        default=DEFAULT_PROFILE_URL,
        help=f"Profile vanity URL to visit (default: {DEFAULT_PROFILE_URL})",
    )
    parser.add_argument(
        "--cookie",
        help="Raw Cookie header string. Defaults to LINKEDIN_COOKIE environment variable.",
    )
    parser.add_argument(
        "--csrf-token",
        dest="csrf_token",
        help="CSRF token value. Defaults to LINKEDIN_CSRF_TOKEN environment variable.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="Timeout in seconds for the HTTP request (default: 30).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print debug information to stderr.",
    )
    return parser.parse_args()


def parse_cookie_header(cookie_header: str) -> Dict[str, str]:
    cookies: Dict[str, str] = {}
    for part in cookie_header.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, value = part.split("=", 1)
        cookies[name.strip()] = value.strip().strip('"')
    return cookies


def build_session(cookie_header: str, csrf_token: str, referer: str) -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "user-agent": USER_AGENT,
            "accept-language": "en-US,en;q=0.9",
            "csrf-token": csrf_token,
            "referer": referer,
        }
    )
    for name, value in parse_cookie_header(cookie_header).items():
        session.cookies.set(name, value)
    return session


def infer_vanity_from_url(url: str) -> str | None:
    parsed = urlparse(url)
    path = parsed.path.strip("/")
    if not path:
        return None
    segments = [segment for segment in path.split("/") if segment]
    if not segments:
        return None
    if segments[0] in {"in", "pub", "profile"} and len(segments) >= 2:
        return segments[1]
    return segments[0]


def ordered_unique(values: Iterable[str]) -> list[str]:
    seen: Dict[str, None] = {}
    for value in values:
        if value not in seen:
            seen[value] = None
    return list(seen.keys())


def normalize_html(html: str) -> Tuple[str, str]:
    plain = unescape(html)
    normalized = re.sub(r"\\+\"", '"', plain)
    normalized = normalized.replace("\\/", "/")
    normalized = normalized.replace("\\u002F", "/")
    normalized = normalized.replace("\\u0026", "&")
    return plain, normalized


def extract_profile_urn(html: str, vanity: str | None = None) -> str:
    plain, normalized = normalize_html(html)

    for pattern in (PRIMARY_COMPONENT_PATTERN, FALLBACK_COMPONENT_PATTERN):
        match = pattern.search(normalized)
        if match:
            return match.group("urn")

    match = IDENTITY_DASH_PATTERN.search(normalized)
    if match:
        return match.group("urn")

    if vanity:
        public_pattern = re.compile(
            r'"publicIdentifier"\s*:\s*"' + re.escape(vanity) + r'"',
            re.IGNORECASE,
        )
        context_match = public_pattern.search(normalized)
        if not context_match:
            # Some payloads keep the quotes escaped even after HTML unescaping.
            escaped_public_pattern = re.compile(
                r'\\"publicIdentifier\\"\s*:\s*\\"' + re.escape(vanity) + r'\\"',
                re.IGNORECASE,
            )
            context_match = escaped_public_pattern.search(plain)
            source = plain
        else:
            source = normalized

        if context_match:
            start = max(0, context_match.start() - 500)
            end = min(len(source), context_match.end() + 500)
            window = source[start:end]
            urn_match = URN_PATTERN.search(window)
            if urn_match:
                return urn_match.group("urn")

    urns = ordered_unique(URN_PATTERN.findall(normalized))
    if len(urns) == 1:
        return urns[0]

    raise ValueError(
        "Unable to locate profile component key or URN. Did the page layout change or "
        "are you signed in?"
    )


def artifact_segment_score(segment: str) -> Tuple[int, int]:
    exact_200 = 1 if "scale_200_200" in segment else 0
    size_match = re.search(r"_(\d{2,4})_(\d{2,4})", segment)
    width = int(size_match.group(1)) if size_match else 0
    return exact_200, width


def choose_artifact_segment(segments: Iterable[str]) -> Optional[str]:
    best_segment: Optional[str] = None
    best_score: Optional[Tuple[int, int]] = None
    for segment in segments:
        score = artifact_segment_score(segment)
        if best_score is None or score > best_score:
            best_score = score
            best_segment = segment
    return best_segment


def extract_profile_image_url(html: str) -> Optional[str]:
    plain, normalized = normalize_html(html)

    def extract_object(text: str, start_index: int) -> Tuple[Optional[str], int]:
        depth = 0
        i = start_index
        in_string = False
        while i < len(text):
            char = text[i]
            if char == '"' and (i == 0 or text[i - 1] != '\\'):
                in_string = not in_string
            if not in_string:
                if char == '{':
                    depth += 1
                elif char == '}':
                    depth -= 1
                    if depth == 0:
                        return text[start_index:i + 1], i + 1
            i += 1
        return None, len(text)

    def iter_vector_images(text: str) -> Iterable[str]:
        needle = '"vectorImage"'
        idx = 0
        while True:
            idx = text.find(needle, idx)
            if idx == -1:
                break
            brace_start = text.find('{', idx + len(needle))
            if brace_start == -1:
                break
            body, next_idx = extract_object(text, brace_start)
            if body is None:
                break
            yield body
            idx = next_idx

    def collect_candidates(text: str) -> Optional[str]:
        ranked: list[Tuple[Tuple[int, int], str]] = []
        for body in iter_vector_images(text):
            if "profile-displayphoto" not in body:
                continue
            root_match = ROOT_URL_PATTERN.search(body)
            if not root_match:
                continue
            root = (
                root_match.group("root")
                .replace("\\/", "/")
                .replace("\\u002F", "/")
                .replace("\\u0026", "&")
            )
            segments = [seg for seg in ARTIFACT_SEGMENT_PATTERN.findall(body)]
            if not segments:
                continue
            segment = choose_artifact_segment(segments)
            if not segment:
                continue
            segment = (
                segment.replace("\\/", "/")
                .replace("\\u002F", "/")
                .replace("\\u0026", "&")
            )
            score = artifact_segment_score(segment)
            ranked.append((score, root + segment))

        if not ranked:
            return None
        ranked.sort(reverse=True)
        return ranked[0][1]

    primary = collect_candidates(normalized)
    if primary:
        return primary

    return collect_candidates(plain)


def main() -> int:
    args = parse_args()
    cookie_header = args.cookie or os.getenv("LINKEDIN_COOKIE")
    if not cookie_header:
        print("Missing LinkedIn cookie. Set LINKEDIN_COOKIE or pass --cookie.", file=sys.stderr)
        return 1

    csrf_token = args.csrf_token or os.getenv("LINKEDIN_CSRF_TOKEN")
    if not csrf_token:
        print("Missing CSRF token. Set LINKEDIN_CSRF_TOKEN or pass --csrf-token.", file=sys.stderr)
        return 1

    session = build_session(cookie_header, csrf_token, referer=args.url)
    vanity = infer_vanity_from_url(args.url)

    if args.verbose:
        print(f"Fetching {args.url}", file=sys.stderr)
        if vanity:
            print(f"Detected vanity: {vanity}", file=sys.stderr)

    try:
        response = session.get(args.url, timeout=args.timeout)
    except requests.RequestException as exc:  # pragma: no cover - network failure surface
        print(f"HTTP request failed: {exc}", file=sys.stderr)
        return 1

    if response.status_code != requests.codes.ok:
        print(
            f"Unexpected status {response.status_code} when fetching profile page.",
            file=sys.stderr,
        )
        return 1

    try:
        profile_urn = extract_profile_urn(response.text, vanity=vanity)
    except ValueError as exc:
        if args.verbose:
            print(response.text, file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 1

    profile_image_url = extract_profile_image_url(response.text)

    username = vanity
    if not username:
        parsed = urlparse(args.url)
        path = parsed.path.strip("/")
        if path:
            username = path.split("/")[-1]

    if not username:
        print("Unable to infer username from the supplied URL.", file=sys.stderr)
        return 1

    result = {
        "id": profile_urn,
        "username": username,
        "url": args.url,
        "imageUrl": profile_image_url,
    }

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
