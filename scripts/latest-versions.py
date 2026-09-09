#!/usr/bin/env python3
"""Find the newest stable tag of each pinned image.

Reads versions.env, queries the registry, and prints one line per image:

    KEY<TAB>current<TAB>latest<TAB>status

status is one of: up-to-date, update, pinned-major, unknown.

Rules that matter:
  * Only tags that look like a release are considered — nothing named
    latest/stable/next/beta/nightly/dev/rc/pre, and nothing architecture-
    suffixed.
  * PostgreSQL never crosses a major version automatically. A major
    upgrade needs a dump/restore and is the operator's decision.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

VERSIONS_FILE = sys.argv[1] if len(sys.argv) > 1 else "versions.env"
TIMEOUT = 20

# key_prefix -> (image env key, version env key)
TRACKED = [
    ("POSTGRES", "POSTGRES_IMAGE", "POSTGRES_VERSION"),
    ("VALKEY", "VALKEY_IMAGE", "VALKEY_VERSION"),
    ("CADDY", "CADDY_IMAGE", "CADDY_VERSION"),
    ("LETTA", "LETTA_IMAGE", "LETTA_VERSION"),
    ("SEARXNG", "SEARXNG_IMAGE", "SEARXNG_VERSION"),
    ("CRAWL4AI", "CRAWL4AI_IMAGE", "CRAWL4AI_VERSION"),
]

BAD_TAG = re.compile(
    r"(latest|stable|next|beta|nightly|dev|rc|alpha|pre|test|windows|nanoserver|builder)",
    re.I,
)
ARCH_SUFFIX = re.compile(r"-(amd64|arm64|arm|386|ppc64le|s390x)$")


def read_env(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def fetch_tags(image: str, pages: int = 3) -> list[str]:
    repo = image if "/" in image else f"library/{image}"
    tags: list[str] = []
    url = (
        f"https://hub.docker.com/v2/repositories/{repo}/tags"
        "?page_size=100&ordering=last_updated"
    )
    for _ in range(pages):
        try:
            with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
                payload = json.load(response)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
            break
        tags.extend(item["name"] for item in payload.get("results", []))
        url = payload.get("next")
        if not url:
            break
    return tags


def version_key(tag: str):
    """Sortable key for a tag; None when it is not a comparable version."""
    core = tag.split("-", 1)[0]
    parts = core.split(".")
    if not parts or not parts[0].isdigit():
        return None
    numbers = []
    for part in parts:
        if not part.isdigit():
            return None
        numbers.append(int(part))
    return tuple(numbers + [0] * (4 - len(numbers)))[:4]


def same_shape(candidate: str, current: str) -> bool:
    """Keep the tag's flavour: -alpine stays -alpine, pg17 stays pg17."""
    def suffix(tag: str) -> str:
        head, _, rest = tag.partition("-")
        return rest
    return suffix(candidate) == suffix(current)


def postgres_major(tag: str) -> str | None:
    """Major PostgreSQL version of a tag, whichever tag style is in use."""
    marked = re.search(r"pg(\d+)", tag)
    if marked:
        return marked.group(1)
    leading = re.match(r"(\d+)", tag)
    return leading.group(1) if leading else None


def newest(image: str, current: str) -> str | None:
    best, best_key = None, None
    for tag in fetch_tags(image):
        if BAD_TAG.search(tag) or ARCH_SUFFIX.search(tag):
            continue
        if not same_shape(tag, current):
            continue
        key = version_key(tag)
        if key is None:
            continue
        if best_key is None or key > best_key:
            best, best_key = tag, key
    return best


def main() -> int:
    env = read_env(VERSIONS_FILE)
    for label, image_key, version_key_name in TRACKED:
        image = env.get(image_key, "")
        current = env.get(version_key_name, "")
        if not image or not current:
            continue

        latest = newest(image, current)

        if latest is None:
            print(f"{version_key_name}\t{current}\t?\tunknown")
            continue

        status = "up-to-date" if latest == current else "update"

        # Never cross a PostgreSQL major automatically: that needs a
        # dump/restore and is the operator's decision. This catches both
        # tag styles — pgvector's "0.8.5-pg17" and the official image's
        # "17.10-trixie".
        if label == "POSTGRES" and status == "update":
            if postgres_major(current) != postgres_major(latest):
                print(f"{version_key_name}\t{current}\t{latest}\tpinned-major")
                continue

        print(f"{version_key_name}\t{current}\t{latest}\t{status}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
