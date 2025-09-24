#!/usr/bin/env python3
"""Fetch LinkedIn profile updates via the voyager GraphQL endpoint.

The script mirrors the browser call to
``https://www.linkedin.com/voyager/api/graphql`` with the
``voyagerFeedDashProfileUpdates`` query. A valid LinkedIn session cookie string
and CSRF token (copied from DevTools) are required; LinkedIn may revoke access
or change the private API at any time.

Example usage:

    export LINKEDIN_COOKIE='bcookie="..."; li_at=...; ...'
    export LINKEDIN_CSRF_TOKEN='ajax:123456789'
    python fetch_linkedin_profile_updates.py \
        'urn:li:fsd_profile:ACoAAByAzQoB9-VHcgJ_Fx6moaCchiwhtPfz7rw' \
        --count 20 --limit 60 --verbose
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Iterable
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote, urlencode
from urllib.parse import quote

import requests

GRAPHQL_URL = "https://www.linkedin.com/voyager/api/graphql"
QUERY_ID = "voyagerFeedDashProfileUpdates.80d5abb3cd25edff72c093a5db696079"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

DEFAULT_COOKIE = (
    'bcookie="v=2&b547fdce-9b25-4aec-8c48-b54594867e3f"; '
    'bscookie="v=1&20250630094358c73916cd-196e-44c7-8ba0-934d4ff07048AQG-dij0LfkX4D2Au-rAxHfM4YGIQC8m"; '
    'li_rm=AQGjr2R-4XJUmQAAAZfAOrRtxMbNYjm0t9_Y9tgeEyZkM0uwb2RLv0Rci84Vov50mhS-Fdm1-I-QvcDGW_DkSIZKMtN6F8lvD1xHxXKxsiqKXr8OO0uBXjfbpcdz2bkgolUGppGWkpeJAqw97sBu_eNk18uS5swv9jXrTEsgbbEzIjmANhMYh-XB0tbj5mjkVn0NdZJh7sT1Sswz6vfLnXMRo2Eo0CyRGkkVjza4gbTGxqbkPMcf8cpCsKzpSlbro8qMENEwqGv8jF1hfpiUSViG5JqAUN3zNlemRyn-ORbtwEjcKWsaxV5i1SugAgtQMU_p5AjgJOQZ3ytHawxmUQ; '
    'li_theme=light; li_theme_set=app; li_sugr=1e6d5f96-bde7-4e68-bdcb-6ab3d4f84666; '
    '_guid=9f56aeb4-1a86-458f-83e9-eb85f5d0bd00; dfpfpt=60bd7d78a1454f43abf63411953aaced; '
    'li_alerts=e30=; visit=v=1&M; li_gc=MTsyMTsxNzUyNjA0MDMzOzI7MDIxBdIl/WWhFLDdz5jvdvz4li/moU2Te5zQySTR4rjuyTs=; '
    'g_state={"i_l":0}; JSESSIONID="ajax:8501284286692389632"; '
    'gpv_pn=www.linkedin.com%2Fpremium%2Fproducts%2F; li_theme_set=app; timezone=Europe/Moscow; '
    's_ips=990; s_tp=3577; s_tslv=1757399912937; bitmovin_analytics_uuid=df7e738b-d1dc-4ffc-b75a-f8b3c5bc852c; '
    'sdui_ver=sdui-flagship:0.1.13827+sdui-flagship.production; liap=true; '
    'li_at=AQEDAVcbsPUE0YjbAAABmVvHFdwAAAGZf9OZ3E0Ag1xLw7E8txAAnJGvPfUYdK7EJi6yOGc0K3_q3kKbgIHKqh1EapKrVgUkZSI9n7zgWPk5QgWR2BQo3STA3jx9ao_WQiCFoNVMaKylitg8WctB0v_j; '
    'AnalyticsSyncHistory=AQJYx95gGqDLCAAAAZlzl68f7UUXyFutq1NT5flBhYY1xbCu4GiQf6f_mFVnvFr6FvlHXm3cos-BCvfgbmuQPw; '
    'lms_ads=AQGlcSR0tkssqgAAAZlzl8dqp9yzKSGyad3PFaTKX_rNFxwwYJzV32kh4PMBPDwnTayofZpQkgYQANfAr36Oe2eJHKcanEnG; '
    'lms_analytics=AQGlcSR0tkssqgAAAZlzl8dqp9yzKSGyad3PFaTKX_rNFxwwYJzV32kh4PMBPDwnTayofZpQkgYQANfAr36Oe2eJHKcanEnG; '
    'AMCV_14215E3D5995C57C0A495C55%40AdobeOrg=-637568504%7CMCIDTS%7C20355%7CMCMID%7C11925510526656657471056281237154640983%7CMCAAMLH-1759238483%7C6%7CMCAAMB-1759238483%7C6G1ynYcLPuiQxYZrsz_pkqfLG9yMXBpb2zX5dvJdYQJzPXImdj0y%7CMCOPTOUT-1758640883s%7CNONE%7CMCCIDH%7C397513766%7CvVersion%7C5.1.1; '
    '_gcl_au=1.1.1390433584.1751276789.692418993.1758636483.1758636504; lang=v=2&lang=en-us; '
    'fptctx2=taBcrIH61PuCVH7eNCyH0J9Fjk1kZEyRnBbpUW3FKs82AdPde5B%252fj%252fDVSqPDOVOK0buh5HLnDTxf%252fLJii%252fq%252fhEp10mLVMnAvEf4%252fcOIJwFjdJfyvS4M%252fKbhObJD0BytNYYBWawZk3%252fmeoxveIfYaC3Wet60oegJzX6GCMGd5qYkl0Puv6YmxgRt1IBr5IDkXkkhNfee0%252b68G8HtX6iMZINviB0onL8UiG%252bd7sEQDEoqvLsNawMZdecG35oSvY0CQLYMBCisPBxlF1ewry3N4s%252fjNF0sBoAR0%252bAikQichM%252fMRUkvmBXGcmIgtGVzxyiLFF8tOaxiIkLPgjQfOKTlpilsFPAM4uRwq9WyWTUWAKjc%253d; '
    'li_mc=MTsyMTsxNzU4NjYwMzExOzI7MDIx+bhKBpgW4chyLLHDnfDIEsFMdHUFBFuOopgl1Ki7ql8=; '
    '__cf_bm=t8VqYbhMtexH9wTkDs9z4m2boAKLthDY8.N2ZerarYA-1758660454-1.0.1.1-w.gB6zleTxsJkdlLy5TWja0cCHvxFMXl_sB2paXOiqyC9e7ov4Myas.Vo_sWg0QFMmvO0Me3_w4zTju3VFeCYVUS23rhiPQYnalZaC2ooEs; '
    'lidc="b=VB65:s=V:r=V:a=V:p=V:g=47:u=67:x=1:i=1758660500:t=1758706097:v=2:sig=AQHNWhc4fFw_J7SF5ekeQm9_NuUTC7Tv"; '
    'UserMatchHistory=AQITJ7j6XEHT2gAAAZl4Vp_kdT_lGKVxZVXMOSiyiKvTApQJMzwBU-pJUhvBZzzhpj4i9HZUWYK7yW0QrcjveUvE-zCC37aLGBRwiMsyjOOOIpdtM0lF0h_bAuF13F-vlqgKqEXt0nqOAuaH7g-dwdMqkMRjHgdfel8VJHfec7027eJtOGR6jkdGj0WO4nGySitRjdub8Nax-_sOYmO-Liym-VH2QT2QVXs6MmdHp2jdX0TUN7Mxt0QnRk_GXrkfNkXG3_zcd7S_Q0QjHIIVg-0tQCNDaKIk5peiaNrd1u6cGCTXAN-k0DxDlaO0yr0Q7voEbNb6xdoLzGXandVKKsMTA4rZnGr4k_ujo9fYsxQjCitzOQ'
)

DEFAULT_CSRF_TOKEN = "ajax:8501284286692389632"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Fetch LinkedIn profile updates using the voyagerFeedDashProfileUpdates "
            "GraphQL query"
        ),
    )
    parser.add_argument(
        "profile_urn",
        help=(
            "Profile URN, e.g. 'urn:li:fsd_profile:ACoAAByAzQoB9-VHcgJ_Fx6moaCchiwhtPfz7rw'. "
            "Use DevTools on the profile page to copy the URN from network calls."
        ),
    )
    parser.add_argument(
        "--count",
        default="20",
        help="Page size for each request (default: 20, must be <= 100). Use 'all' to fetch with the maximum page size until pagination ends.",
    )
    parser.add_argument(
        "--start",
        type=int,
        default=0,
        help="Initial offset to request (default: 0).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Maximum number of updates to collect across all pages.",
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
        "--referer",
        help=(
            "Optional referer header. If omitted, https://www.linkedin.com/feed/ is used."
        ),
    )
    parser.add_argument(
        "--output",
        help="Optional path to write the collected updates as pretty-printed JSON.",
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
        help="Print pagination progress details to stderr.",
    )
    parser.add_argument(
        "--include-raw",
        action="store_true",
        help="Embed the raw LinkedIn update payload for each result.",
    )
    parser.add_argument(
        "--header",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Extra request header(s) to include; can be repeated.",
    )
    parser.add_argument(
        "--social-counts-only",
        action="store_true",
        help="Return only social activity counts (numComments/numLikes/numShares).",
    )
    parser.add_argument(
        "--organization-reactions-only",
        action="store_true",
        help="Return only included records that contain organization reactions.",
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


def build_session(
    cookie_header: str,
    csrf_token: str,
    referer: Optional[str],
    extra_headers: Iterable[str],
) -> requests.Session:
    session = requests.Session()
    headers = {
        "accept": "application/vnd.linkedin.normalized+json+2.1",
        "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
        "user-agent": USER_AGENT,
        "csrf-token": csrf_token,
        "x-restli-protocol-version": "2.0.0",
        "x-li-lang": "en_US",
        "x-li-deco-include-micro-schema": "true",
    }
    if referer:
        headers["referer"] = referer
    else:
        headers["referer"] = "https://www.linkedin.com/feed/"

    for header in extra_headers:
        if "=" not in header:
            raise SystemExit(f"Invalid header format (expected KEY=VALUE): {header}")
        key, value = header.split("=", 1)
        headers[key.strip()] = value.strip()

    session.headers.update(headers)

    for name, value in parse_cookie_header(cookie_header).items():
        session.cookies.set(name, value)
    return session


def extract_text_block(block: Any) -> Optional[str]:
    """Attempt to pull a human-readable string from a commentary/text block."""
    if block is None:
        return None
    if isinstance(block, str):
        return block
    if isinstance(block, dict):
        if "text" in block:
            return extract_text_block(block["text"])
        if "value" in block:
            return extract_text_block(block["value"])
        if "textViewModel" in block:
            return extract_text_block(block["textViewModel"])
        if "attributes" in block:
            return extract_text_block(block.get("string"))
        if "attributedText" in block:
            return extract_text_block(block["attributedText"])
        if "rawText" in block:
            return extract_text_block(block["rawText"])
    if isinstance(block, Iterable):
        parts: List[str] = []
        for item in block:
            text = extract_text_block(item)
            if text:
                parts.append(text)
        return "".join(parts) if parts else None
    return None


def simplify_actor(actor_ref: Optional[Any], index: Dict[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if actor_ref is None:
        return None
    if isinstance(actor_ref, dict):
        actor = actor_ref
        actor_urn = actor_ref.get("entityUrn")
    else:
        actor_urn = actor_ref
        actor = index.get(actor_urn)
    if not isinstance(actor, dict):
        return {"entityUrn": actor_urn} if actor_urn else None

    # Profiles often appear as miniProfile entries or profile view models.
    name = None
    first = actor.get("firstName") or actor.get("localizedFirstName")
    last = actor.get("lastName") or actor.get("localizedLastName")
    if first or last:
        name = " ".join(filter(None, [first, last]))

    public_id = actor.get("publicIdentifier")
    if not public_id and isinstance(actor.get("miniProfile"), dict):
        mini = actor["miniProfile"]
        public_id = mini.get("publicIdentifier")
        if not name:
            first = mini.get("firstName") or mini.get("localizedFirstName")
            last = mini.get("lastName") or mini.get("localizedLastName")
            if first or last:
                name = " ".join(filter(None, [first, last]))

    return {
        "entityUrn": actor_urn,
        "name": name,
        "publicIdentifier": public_id,
    }


def simplify_content_entities(content: Any) -> List[Dict[str, Any]]:
    entities: List[Dict[str, Any]] = []
    if isinstance(content, dict):
        if "contentEntities" in content and isinstance(content["contentEntities"], list):
            for entity in content["contentEntities"]:
                if not isinstance(entity, dict):
                    continue
                simplified = {
                    "title": extract_text_block(entity.get("title")),
                    "entity": entity.get("entity"),
                    "thumbnails": entity.get("thumbnails"),
                    "landingUrl": entity.get("landingUrl"),
                }
                entities.append(simplified)
        # Recursively inspect nested dicts for additional collections.
        for value in content.values():
            if isinstance(value, dict):
                entities.extend(simplify_content_entities(value))
            elif isinstance(value, list):
                for item in value:
                    entities.extend(simplify_content_entities(item))
    elif isinstance(content, list):
        for item in content:
            entities.extend(simplify_content_entities(item))
    return entities


def simplify_update(
    update: Dict[str, Any],
    index: Dict[str, Dict[str, Any]],
    include_raw: bool,
    social_counts: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    commentary = None
    for key in ("commentaryV2", "commentary", "header", "body"):
        if key in update:
            commentary = extract_text_block(update[key])
            if commentary:
                break

    actor_info = simplify_actor(update.get("actor") or update.get("actorUrn"), index)
    content_entities = simplify_content_entities(update.get("content"))

    entity_urn = update.get("entityUrn")
    simplified: Dict[str, Any] = {
        "entityUrn": update.get("entityUrn"),
        "type": update.get("updateType") or update.get("$type"),
        "actor": actor_info,
        "permalink": update.get("permalink") or update.get("updateMetadata", {}).get("permalink"),
        "lifecycleState": update.get("lifecycleState"),
        "createdAt": update.get("createdAt")
        or update.get("firstPublishedAt")
        or update.get("lastModified"),
        "commentary": commentary,
        "contentEntities": content_entities if content_entities else None,
    }

    social = None
    if isinstance(entity_urn, str):
        social = social_counts.get(entity_urn)
        if not social and entity_urn.endswith(")"):
            # Strip update URN wrapper to match social counts keyed by activity URN.
            inner_start = entity_urn.find("(")
            if inner_start != -1:
                inner = entity_urn[inner_start + 1 : -1]
                social = social_counts.get(inner)
    if not social:
        # Social counts can also be stored under preDashEntityUrn.
        pre_dash = update.get("preDashEntityUrn") or update.get("dashEntityUrn")
        if isinstance(pre_dash, str):
            social = social_counts.get(pre_dash)

    if isinstance(social, dict):
        simplified["numLikes"] = social.get("numLikes")
        simplified["numComments"] = social.get("numComments")
        simplified["numShares"] = social.get("numShares")

    if not simplified["contentEntities"]:
        simplified.pop("contentEntities")

    if include_raw:
        simplified["raw"] = update

    return simplified


def index_included(payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    index: Dict[str, Dict[str, Any]] = {}
    for item in payload.get("included", []):
        if isinstance(item, dict) and "entityUrn" in item:
            index[item["entityUrn"]] = item
    return index


def get_updates_section(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Attempt to locate the portion of the payload with items/metadata."""
    data_root = payload.get("data") if isinstance(payload, dict) else None
    queue: List[Dict[str, Any]] = []
    if isinstance(data_root, dict):
        queue.append(data_root)
    visited: set[int] = set()

    while queue:
        node = queue.pop(0)
        node_id = id(node)
        if node_id in visited:
            continue
        visited.add(node_id)

        if isinstance(node.get("items"), list):
            return node

        for value in node.values():
            if isinstance(value, dict):
                queue.append(value)
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        queue.append(item)

    return {}


def collect_updates(payload: Dict[str, Any]) -> Tuple[List[str], Dict[str, Dict[str, Any]]]:
    updates: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []

    included_updates: List[Dict[str, Any]] = []
    for item in payload.get("included", []):
        if not isinstance(item, dict):
            continue
        type_name = item.get("$type", "")
        if "Update" in type_name and "UpdateAction" not in type_name:
            entity_urn = item.get("entityUrn")
            if isinstance(entity_urn, str):
                updates[entity_urn] = item
                included_updates.append(item)

    items = get_updates_section(payload).get("items", [])

    for item in items:
        if not isinstance(item, dict):
            continue
        candidate = None
        for key, value in item.items():
            if key.endswith("Urn") and isinstance(value, str):
                candidate = value
                break
            if isinstance(value, str) and value.startswith("urn:li:fsd_update"):
                candidate = value
                break
        if not candidate:
            for key in ("entityUrn", "update", "updateUrn", "itemUrn"):
                value = item.get(key)
                if isinstance(value, str):
                    candidate = value
                    break
        if candidate and candidate in updates and candidate not in order:
            order.append(candidate)

    if not order:
        # Fallback to the order items appear in the included list.
        for item in included_updates:
            urn = item.get("entityUrn")
            if isinstance(urn, str) and urn not in order:
                order.append(urn)

    return order, updates


def harvest_social_counts(payload: Dict[str, Any], store: Dict[str, Dict[str, Any]]) -> None:
    for item in payload.get("included", []):
        if not isinstance(item, dict):
            continue
        if item.get("$type") != "com.linkedin.voyager.dash.feed.SocialActivityCounts":
            continue
        urn = item.get("entityUrn") or item.get("urn")
        if not isinstance(urn, str):
            continue
        record = dict(item)
        record.setdefault("entityUrn", urn)
        store[urn] = record


def harvest_organization_reactions(
    payload: Dict[str, Any], store: Dict[str, Dict[str, Any]]
) -> None:
    for item in payload.get("included", []):
        if not isinstance(item, dict):
            continue
        if "reactionByOrganizationActor" not in item:
            continue
        key = item.get("entityUrn") or item.get("urn") or item.get("$id")
        if not isinstance(key, str):
            key = json.dumps(item, sort_keys=True)
        if key not in store:
            store[key] = dict(item)


def extract_pagination_token(payload: Dict[str, Any]) -> Optional[str]:
    """Search the payload for the next pagination token, if any."""

    def scan(obj: Any) -> Optional[str]:
        queue: List[Any] = [obj]
        visited: set[int] = set()
        while queue:
            current = queue.pop(0)
            current_id = id(current)
            if current_id in visited:
                continue
            visited.add(current_id)

            if isinstance(current, dict):
                token = current.get("paginationToken")
                if isinstance(token, str):
                    return token
                for value in current.values():
                    if isinstance(value, (dict, list)):
                        queue.append(value)
            elif isinstance(current, list):
                for item in current:
                    if isinstance(item, (dict, list)):
                        queue.append(item)
        return None

    section = get_updates_section(payload)
    if section:
        token = scan(section)
        if token:
            return token
    return scan(payload)


def fetch_profile_updates(
    session: requests.Session,
    profile_urn: str,
    start: int,
    count: int,
    timeout: float,
    pagination_token: Optional[str],
) -> Dict[str, Any]:
    params = {
        "includeWebMetadata": "true",
        "queryId": QUERY_ID,
    }
    encoded_params = urlencode(params)
    escaped_profile = profile_urn.replace(":", "%3A")
    parts = [
        f"count:{count}",
        f"start:{start}",
        f"profileUrn:{escaped_profile}",
    ]
    if pagination_token:
        parts.append(f"paginationToken:{pagination_token}")
    variables = f"({','.join(parts)})"
    encoded_variables = quote(variables, safe="(),:%")
    url = f"{GRAPHQL_URL}?{encoded_params}&variables={encoded_variables}"
    response = session.get(url, timeout=timeout)
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        details = response.text.strip()
        if details:
            raise requests.HTTPError(f"{exc} -> {details[:500]}", response=response) from None
        raise
    return response.json()


def fetch_all_updates(
    session: requests.Session,
    profile_urn: str,
    start: int,
    count: int,
    timeout: float,
    limit: Optional[int],
    verbose: bool,
    include_raw: bool,
    social_counts_only: bool,
    organization_reactions_only: bool,
) -> List[Dict[str, Any]]:
    collected: List[Dict[str, Any]] = []
    seen: set[str] = set()
    social_counts: Dict[str, Dict[str, Any]] = {}
    org_reactions: Dict[str, Dict[str, Any]] = {}
    cursor = start
    pagination_token: Optional[str] = None
    seen_tokens: set[str] = set()

    while True:
        payload = fetch_profile_updates(
            session,
            profile_urn,
            cursor,
            count,
            timeout,
            pagination_token,
        )
        if social_counts_only:
            harvest_social_counts(payload, social_counts)
            new_in_page = 0
            item_count = len(social_counts)
            if verbose:
                print(
                    f"Fetched start={cursor} count={count}: collected social counts={item_count}",
                    file=sys.stderr,
                )
        elif organization_reactions_only:
            harvest_organization_reactions(payload, org_reactions)
            new_in_page = 0
            item_count = len(org_reactions)
            if verbose:
                print(
                    f"Fetched start={cursor} count={count}: collected org reactions={item_count}",
                    file=sys.stderr,
                )
        else:
            index = index_included(payload)
            harvest_social_counts(payload, social_counts)
            order, updates = collect_updates(payload)

            new_in_page = 0
            for urn in order:
                if urn in seen:
                    continue
                update = updates.get(urn)
                if not update:
                    continue
                collected.append(
                    simplify_update(update, index, include_raw, social_counts)
                )
                seen.add(urn)
                new_in_page += 1
                if limit and len(collected) >= limit:
                    break
            if verbose:
                item_count = len(order)
                print(
                    f"Fetched start={cursor} count={count}: {new_in_page} new / {item_count} items (total={len(collected)})",
                    file=sys.stderr,
                )

        if social_counts_only and limit and len(social_counts) >= limit:
            break
        if organization_reactions_only and limit and len(org_reactions) >= limit:
            break
        if not social_counts_only and limit and len(collected) >= limit:
            break
        # Determine whether another page likely exists.
        section = get_updates_section(payload)
        items = section.get("items", []) if isinstance(section, dict) else []
        next_token = extract_pagination_token(payload)
        if len(items) < count and not next_token:
            break
        if not next_token:
            break
        if next_token in seen_tokens:
            break
        seen_tokens.add(next_token)
        pagination_token = next_token
        cursor += count

    if social_counts_only:
        results = list(social_counts.values())
        if limit:
            return results[:limit]
        return results
    if organization_reactions_only:
        results = list(org_reactions.values())
        if limit:
            return results[:limit]
        return results

    if limit:
        return collected[:limit]
    return collected


def main() -> None:
    args = parse_args()
    cookie_header = args.cookie or os.getenv("LINKEDIN_COOKIE") or DEFAULT_COOKIE
    csrf_token = args.csrf_token or os.getenv("LINKEDIN_CSRF_TOKEN") or DEFAULT_CSRF_TOKEN

    if args.social_counts_only and args.organization_reactions_only:
        raise SystemExit(
            "--social-counts-only and --organization-reactions-only are mutually exclusive"
        )

    count_arg = args.count
    if isinstance(count_arg, str):
        if count_arg.lower() == "all":
            count_value = 100
        else:
            try:
                count_value = int(count_arg)
            except ValueError as exc:
                raise SystemExit(f"Invalid value for --count: {count_arg}") from exc
    else:
        count_value = int(count_arg)

    if count_value <= 0:
        raise SystemExit("--count must be a positive integer or 'all'")
    if count_value > 100:
        raise SystemExit("--count cannot exceed 100")

    args.count = count_value

    session = build_session(cookie_header, csrf_token, args.referer, args.header)
    updates = fetch_all_updates(
        session=session,
        profile_urn=args.profile_urn,
        start=args.start,
        count=args.count,
        timeout=args.timeout,
        limit=args.limit,
        verbose=args.verbose,
        include_raw=args.include_raw,
        social_counts_only=args.social_counts_only,
        organization_reactions_only=args.organization_reactions_only,
    )

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(updates, handle, indent=2, ensure_ascii=False)
    else:
        json.dump(updates, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
