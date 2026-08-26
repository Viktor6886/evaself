#!/usr/bin/env python3
"""Правило в таблице стилей должно кого-то оформлять.

Мёртвое правило не ломает страницу — в этом и беда. Оно копится незаметно,
и через год половину файла нельзя тронуть, потому что неизвестно, что из
неё ещё работает. `.letta-link` пережил удаление самой ссылки на консоль
Letta и остался оформлять элемент, которого больше нет в разметке.

Проверяется только то, что можно проверить честно: класс, который не
встречается ни в разметке, ни в скриптах панели — ни целиком, ни как
основа для собираемого имени вроде `color-${...}`. Селекторы по тегам,
псевдоклассам и атрибутам не рассматриваются: они не «мёртвые» в этом
смысле.

Список исключений намеренно пуст. Класс, который нужен, но не виден
проверке, — повод объяснить это здесь, а не молча обойти.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "admin-ui" / "public"
CSS = PUBLIC / "ui.css"

# Класс, который собирают из частей: `color-${status}` в скрипте даёт
# `.color-green` в таблице стилей. Проверять такие по полному имени
# нельзя — сверяется основа.
DYNAMIC_PREFIX = re.compile(r"([a-z][\w-]*?-)\$\{")

EXEMPT: dict[str, str] = {}


def declared_classes(css: str) -> set[str]:
    without_comments = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    # Только селекторная часть правил: имя класса внутри значения
    # (например, в `content:`) объявлением не является.
    selectors = re.findall(r"(^|\})([^{}]+)\{", without_comments, flags=re.M)
    names: set[str] = set()
    for _, chunk in selectors:
        if chunk.strip().startswith("@"):
            continue
        names.update(re.findall(r"\.([a-zA-Z][\w-]*)", chunk))
    return names


def main() -> int:
    css = CSS.read_text("utf-8")
    sources = "\n".join(
        path.read_text("utf-8")
        for path in sorted(PUBLIC.glob("*.js")) + [PUBLIC / "index.html"]
    )

    literal = set(re.findall(r"[a-zA-Z][\w-]*", sources))
    prefixes = set(DYNAMIC_PREFIX.findall(sources))

    dead = []
    for name in sorted(declared_classes(css)):
        if name in EXEMPT or name in literal:
            continue
        if any(name.startswith(prefix) for prefix in prefixes):
            continue
        dead.append(name)

    if dead:
        print("::error::в таблице стилей есть правила, которым нечего оформлять:")
        for name in dead:
            print(f"  .{name}")
        print("  Уберите правило или объясните исключение в EXEMPT.")
        return 1
    print(f"классов в ui.css: {len(declared_classes(css))}; все встречаются в панели")
    return 0


if __name__ == "__main__":
    sys.exit(main())
