#!/usr/bin/env python3
"""Fetch recent LinkedIn notification cards for a vanity profile.

This script mirrors the browser request to
``https://www.linkedin.com/voyager/api/voyagerIdentityDashNotificationCards``
to retrieve cards that reference activity for a specific vanity profile. It
requires a valid browser session cookie string and CSRF token that already
belong to the viewer (the same values you would see in DevTools while signed
in). LinkedIn can change this private API at any time.

Example usage:

    export LINKEDIN_COOKIE='bcookie="..."; li_at=...; ...'
    export LINKEDIN_CSRF_TOKEN='ajax:123456789'
    python fetch_linkedin_posts.py ramzib --count 20 --limit 100

Use the ``--output`` flag to write the simplified card data to disk.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Iterable, List, Optional

import requests

BASE_URL = "https://www.linkedin.com/voyager/api/voyagerIdentityDashNotificationCards"
DECORATION_ID = (
    "com.linkedin.voyager.dash.deco.identity.notifications."
    "CardsCollectionWithInjectionsNoPills-24"
)
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch LinkedIn notification cards scoped to a vanity profile",
    )
    parser.add_argument(
        "vanity_name",
        help="Profile vanity name, e.g. the 'ramzib' portion of linkedin.com/in/ramzib",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=10,
        help="Page size for each request (default: 10)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Stop after collecting this many cards (default: fetch until pagination ends)",
    )
    parser.add_argument(
        "--cookie",
        help="Cookie header string. Defaults to LINKEDIN_COOKIE environment variable.",
    )
    parser.add_argument(
        "--csrf-token",
        dest="csrf_token",
        help="CSRF token value. Defaults to LINKEDIN_CSRF_TOKEN environment variable.",
    )
    parser.add_argument(
        "--output",
        help="Optional path to write the collected cards as pretty-printed JSON.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="HTTP timeout in seconds (default: 30).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print pagination progress to stderr.",
    )
    return parser.parse_args()


def parse_cookie_header(cookie_header: str) -> Dict[str, str]:
    """Split a browser cookie header into a name->value mapping."""
    cookies: Dict[str, str] = {}
    for part in cookie_header.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, value = part.split("=", 1)
        cookies[name.strip()] = value.strip().strip('"')
    return cookies


def build_session(cookie_header: str, csrf_token: str, vanity_name: str) -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "accept": "application/vnd.linkedin.normalized+json+2.1",
            "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
            "user-agent": USER_AGENT,
            "csrf-token": csrf_token,
            "x-restli-protocol-version": "2.0.0",
            "x-li-lang": "en_US",
            "x-li-deco-include-micro-schema": "true",
            "referer": f"https://www.linkedin.com/in/{vanity_name}/recent-activity/all/",
        }
    )
    for name, value in parse_cookie_header(cookie_header).items():
        session.cookies.set(name, value)
    return session


def extract_text(entry: Optional[Dict[str, Any]]) -> Optional[str]:
    if isinstance(entry, dict):
        return entry.get("text")
    return None


def extract_texts(entries: Optional[Iterable[Dict[str, Any]]]) -> List[str]:
    texts: List[str] = []
    if not entries:
        return texts
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        text = entry.get("text")
        if text:
            texts.append(text)
    return texts


def capture_action(action: Dict[str, Any]) -> Dict[str, Any]:
    display_text = extract_text(action.get("displayText"))
    return {
        "type": action.get("type"),
        "actionTarget": action.get("actionTarget"),
        "displayText": display_text,
    }


def simplify_card(card: Dict[str, Any]) -> Dict[str, Any]:
    simplified = {
        "entityUrn": card.get("entityUrn"),
        "objectUrn": card.get("objectUrn"),
        "contentType": card.get("contentType"),
        "publishedAt": card.get("publishedAt"),
        "read": card.get("read"),
        "headline": extract_text(card.get("headline")),
        "kickerText": extract_text(card.get("kickerText")),
        "contentPrimaryText": extract_texts(card.get("contentPrimaryText")),
        "contentSecondaryText": extract_texts(card.get("contentSecondaryText")),
    }

    primary_action = card.get("cardAction") or card.get("contentAction")
    if isinstance(primary_action, dict):
        simplified["primaryAction"] = capture_action(primary_action)

    actions = card.get("actions") or []
    simplified_actions = [capture_action(action) for action in actions if isinstance(action, dict)]
    if simplified_actions:
        simplified["actions"] = simplified_actions

    return simplified


def extract_cards(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    included = payload.get("included", [])
    cards: List[Dict[str, Any]] = []
    for item in included:
        if not isinstance(item, dict):
            continue
        if item.get("$type") == "com.linkedin.voyager.dash.identity.notifications.Card":
            cards.append(simplify_card(item))
    return cards


def fetch_notification_page(
    session: requests.Session,
    vanity_name: str,
    start: int,
    count: int,
    timeout: float,
) -> Dict[str, Any]:
    params = {
        "decorationId": DECORATION_ID,
        "count": count,
        "q": "filterVanityName",
        "start": start,
        "filterVanityName": vanity_name,
    }
    response = session.get(BASE_URL, params=params, timeout=timeout)
    response.raise_for_status()
    return response.json()


def fetch_cards(
    session: requests.Session,
    vanity_name: str,
    count: int,
    timeout: float,
    limit: Optional[int],
    verbose: bool = False,
) -> List[Dict[str, Any]]:
    start = 0
    collected: List[Dict[str, Any]] = []
    seen: set[str] = set()

    while True:
        payload = fetch_notification_page(session, vanity_name, start, count, timeout)
        new_cards = extract_cards(payload)
        for card in new_cards:
            urn = card.get("entityUrn")
            if urn and urn in seen:
                continue
            if urn:
                seen.add(urn)
            collected.append(card)
            if limit and len(collected) >= limit:
                break
        if limit and len(collected) >= limit:
            break

        metadata = payload.get("data", {}).get("metadata", {})
        next_start = metadata.get("nextStart")
        if verbose:
            total = payload.get("data", {}).get("paging", {}).get("total")
            print(
                f"Fetched {len(collected)} cards (start={start}, nextStart={next_start}, total={total})",
                file=sys.stderr,
            )
        if next_start is None or next_start <= start:
            break
        start = next_start

    if limit:
        return collected[:limit]
    return collected


def main() -> None:
    args = parse_args()
    cookie_header = args.cookie or os.getenv("LINKEDIN_COOKIE")
    csrf_token = args.csrf_token or os.getenv("LINKEDIN_CSRF_TOKEN")

    if not cookie_header:
        raise SystemExit("Cookie header missing. Provide --cookie or set LINKEDIN_COOKIE.")
    if not csrf_token:
        raise SystemExit("CSRF token missing. Provide --csrf-token or set LINKEDIN_CSRF_TOKEN.")

    session = build_session(cookie_header, csrf_token, args.vanity_name)
    cards = fetch_cards(
        session=session,
        vanity_name=args.vanity_name,
        count=args.count,
        timeout=args.timeout,
        limit=args.limit,
        verbose=args.verbose,
    )

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(cards, handle, indent=2, ensure_ascii=False)
    else:
        json.dump(cards, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
