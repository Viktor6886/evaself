#!/usr/bin/env python3
"""Путь, названный в документации, обязан существовать.

Документ переживает код: файл удаляют, а строка о нём остаётся и врёт
дальше. Так `docs/BACKGROUND_JOBS.md` продолжал описывать
`src/jobs/cpu-offload.ts` после того, как модуль был удалён как мёртвый —
уборка прошла по коду и не дошла до текста.

Проверяются пути репозитория, названные в обратных кавычках: они читаются
как «загляни сюда», и несуществующий адрес обесценивает весь документ.

Шаблоны с `*` пропускаются: это описание группы, а не адрес.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

DOCS = [
    *sorted(ROOT.glob("docs/*.md")),
    ROOT / "README.md",
    ROOT / "CLAUDE.md",
    ROOT / "eva-agent-service" / "CLAUDE.md",
    ROOT / "library" / "README.md",
    ROOT / "skills" / "README.md",
    ROOT / "evals" / "README.md",
]

PREFIXES = (
    "eva-agent-service/", "src/", "scripts/", "postgres/", "library/", "skills/",
    "admin-ui/", "webapp/", "evals/", "letta-app-server/", "backup-service/",
    "media-service/", ".github/",
)

PATH = re.compile(r"`((?:" + "|".join(re.escape(p) for p in PREFIXES) + r")[A-Za-z0-9_./*-]+)`")

# Каталоги, которых нет и быть не должно: их создаёт прогон, а в git они
# намеренно не попадают. Причина обязательна — молчаливое исключение
# ничем не лучше устаревшей ссылки.
GENERATED = {
    "evals/reports/": "создаётся прогоном evals и не коммитится",
    "evals/.cache/": "кэш прогона evals, не коммитится",
}


def main() -> int:
    problems: list[str] = []
    checked = 0
    for doc in DOCS:
        if not doc.exists():
            continue
        for match in PATH.finditer(doc.read_text(encoding="utf-8")):
            raw = match.group(1)
            if "*" in raw or raw in GENERATED:
                continue
            checked += 1
            # Путь внутри сервиса пишут и от корня, и от самого сервиса.
            if (ROOT / raw).exists() or (ROOT / "eva-agent-service" / raw).exists():
                continue
            problems.append(f"{doc.relative_to(ROOT)}: путь `{raw}` не существует")

    if problems:
        for problem in problems:
            print(f"::error::{problem}", file=sys.stderr)
        print(
            "\nЛибо путь устарел вместе с кодом, либо документ описывает то, "
            "чего нет. Генерируемые каталоги вносятся в GENERATED с причиной.",
            file=sys.stderr,
        )
        return 1

    print(f"путей в документации проверено: {checked}; все существуют")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
