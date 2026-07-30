"""Every API path a front-end calls must exist in the service.

The Mini App once shipped against three /public/* routes that were never
implemented, and nothing noticed until someone opened it. This check
compares the paths the browser code builds against the routes Fastify
actually declares.

Matching is per segment: a `${...}` interpolation on the caller's side and
a `:param` on the route's side each match any single segment, so
`/public/work-blocks/${id}/${op}` legitimately resolves against
`/public/work-blocks/:id/start`.
"""

from __future__ import annotations

import pathlib
import re
import sys

SENTINEL = "\x00"

SOURCES = [
    "webapp/public/app/app.js",
    "webapp/public/assets/bot-link.js",
    "letta-ui/public/ui.js",
    "admin-ui/public/ui.js",
]

# Fastify registers the public group under a prefix, and the admin API is
# mounted by Caddy under /api/admin/v1.
ROUTE_FILES = [
    ("eva-agent-service/src/server.ts", ""),
    ("eva-agent-service/src/public/routes.ts", "/public"),
    ("eva-agent-service/src/public/webapp-core.ts", "/public/v2"),
    ("eva-agent-service/src/admin/server.ts", "/api/admin/v1"),
]

ROUTE_RE = re.compile(
    r'(?:app|publicApp|webApp|adminApp|instance)\.(?:get|post|patch|delete)\(\s*"([^"]+)"'
)
# Шаблонная строка может содержать кавычки внутри ${...}
# (`/x/${encodeURIComponent(id || "0")}/y`), поэтому у backtick-варианта
# своё правило: он читается до закрывающего backtick, а не до первой
# кавычки. Иначе путь обрезался на середине и «не находился».
CALL_RE = re.compile(
    r'(?:api|streamApi)\(\s*(?:`([^`]+)`|"([^"]+)"|\'([^\']+)\')'
)
FETCH_RE = re.compile(r'fetch\(\s*"(/api/[^"?]+)')


def declared_routes() -> set[str]:
    routes: set[str] = set()
    for path, prefix in ROUTE_FILES:
        source = pathlib.Path(path)
        if not source.exists():
            continue
        for route in ROUTE_RE.findall(source.read_text()):
            routes.add(route if route.startswith(prefix) else prefix + route)
    return routes


def segments_match(call: str, route: str) -> bool:
    left, right = call.strip("/").split("/"), route.strip("/").split("/")
    if len(left) != len(right):
        return False
    for a, b in zip(left, right):
        if SENTINEL in a or b.startswith(":") or b == "*":
            continue
        if a != b:
            return False
    return True


def main() -> int:
    routes = declared_routes()
    missing: list[str] = []
    checked = 0

    for name in SOURCES:
        source = pathlib.Path(name)
        if not source.exists():
            continue
        text = source.read_text()
        # findall с группами возвращает кортежи — берём непустую.
        calls = [next(filter(None, m), "") for m in CALL_RE.findall(text)]
        # /api is stripped by Caddy before the service sees the request.
        calls += [c[len("/api"):] for c in FETCH_RE.findall(text)]
        for call in calls:
            # Плейсхолдеры снимаются ДО отрезания query string: внутри
            # ${...} встречается optional chaining (session?.id), и
            # split("?") резал путь на середине выражения.
            path = re.sub(r"\$\{[^}]*\}", SENTINEL, call).split("?")[0]
            if not path.startswith("/"):
                continue
            checked += 1
            if not any(segments_match(path, route) for route in routes):
                missing.append(f"{name}: {call}")

    if missing:
        print("::error::front-end calls routes the service does not define:")
        for item in sorted(set(missing)):
            print(f"  {item}")
        return 1
    print(f"{checked} front-end call sites resolve against {len(routes)} declared routes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
