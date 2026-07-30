"""A prefix rewrite must not fire on a URI that already carries the prefix.

The Mini App is served from /app on the static server, so the edge maps the
bare host onto it with `rewrite * /app{uri}`. Written that way the rule also
fires on requests the page itself makes: /app/app.css became /app/app/app.css,
missed, and fell through to the SPA's index.html — which Caddy serves as
text/html. Combined with the X-Content-Type-Options: nosniff header set on the
same host, the browser then refuses to apply it as CSS or execute it as JS.

Nothing 404s in that state. The page loads and renders, completely unstyled
and without any script, which is why it went unnoticed through a deploy. So
this is checked structurally: every prefix rewrite has to be guarded by a
matcher that excludes the prefix it adds.

Usage: assert-caddy-prefix-rewrite.py <adapted-caddy-config.json>
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

PLACEHOLDER = "{http.request.uri}"
# "/app{http.request.uri}" -> "/app"; a rewrite that does anything else
# (strip_path_prefix, a literal target) is not a prefix map and is ignored.
PREFIX_RE = re.compile(r"^(/[^{}]+?)/?" + re.escape(PLACEHOLDER) + "$")


def walk(node: object, matchers: tuple[object, ...] = ()) -> list[tuple[str, tuple]]:
    """Collect (prefix, matchers-in-scope) for every prefix rewrite."""
    found: list[tuple[str, tuple]] = []
    if isinstance(node, list):
        for item in node:
            found += walk(item, matchers)
        return found
    if not isinstance(node, dict):
        return found

    scope = matchers
    if "match" in node:
        scope = matchers + (node["match"],)

    if node.get("handler") == "rewrite":
        match = PREFIX_RE.match(str(node.get("uri", "")))
        if match:
            found.append((match.group(1), scope))

    for key, value in node.items():
        if key != "match":
            found += walk(value, scope)
    return found


def guarded(prefix: str, matchers: tuple) -> bool:
    """True when some matcher in scope excludes the prefix being added."""
    wanted = {prefix, f"{prefix}/*"}
    for match_list in matchers:
        for clause in match_list if isinstance(match_list, list) else [match_list]:
            if not isinstance(clause, dict):
                continue
            for negated in clause.get("not", []):
                paths = set(negated.get("path", []))
                # Both the bare prefix and everything under it must be
                # excluded — guarding only /app/* still double-prefixes /app.
                if wanted <= paths:
                    return True
    return False


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: assert-caddy-prefix-rewrite.py <adapted-config.json>")
        return 2

    config = json.loads(pathlib.Path(sys.argv[1]).read_text())
    rewrites = walk(config)
    if not rewrites:
        print("::error::no prefix rewrite found — the check is not exercising anything")
        return 1

    unguarded = [prefix for prefix, matchers in rewrites if not guarded(prefix, matchers)]
    if unguarded:
        print("::error::prefix rewrite fires on URIs that already carry the prefix:")
        for prefix in sorted(set(unguarded)):
            print(f"  rewrite to {prefix}{PLACEHOLDER} is not guarded by")
            print(f"  a matcher excluding {prefix} and {prefix}/*")
        return 1

    print(f"{len(rewrites)} prefix rewrite(s) guarded against double-prefixing")
    return 0


if __name__ == "__main__":
    sys.exit(main())
