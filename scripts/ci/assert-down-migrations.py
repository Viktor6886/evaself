#!/usr/bin/env python3
"""У каждой миграции админского контура есть обратимый down.

Соглашение об откате появилось вместе с административной панелью:
миграции 001–013 и 016 писались до него и down не имеют. Дописывать им
откат задним числом незачем — это переписывание работающего, — поэтому
проверка начинается с той миграции, с которой соглашение действует.

Скрипт не выполняет SQL: он следит только за тем, что файл существует,
не пуст и снимает свою запись из schema_migrations. Работоспособность
самого отката проверяет CI, прогоняя down на настоящей базе.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Первая миграция, для которой откат обязателен.
FIRST_REVERSIBLE = 14

# Исключения — только там, где откат бессмыслен по существу, а не там,
# где его поленились написать. Список намеренно короткий и объяснённый:
# новая миграция в него не попадёт, пока кто-то не впишет причину руками.
EXCEPTIONS = {
    "016_cleanup_and_safety.sql": (
        "удаляет мёртвую схему и только когда таблицы пусты; обратный файл "
        "воссоздавал бы четыре таблицы, которые ни один компонент не читает "
        "и не пишет"
    ),
}

ROOT = Path(__file__).resolve().parents[2]
UP_DIR = ROOT / "postgres" / "migrations"
DOWN_DIR = UP_DIR / "down"


def version_of(name: str) -> int | None:
    match = re.match(r"^(\d+)_", name)
    return int(match.group(1)) if match else None


def main() -> int:
    problems: list[str] = []
    checked = 0

    for up in sorted(UP_DIR.glob("*.sql")):
        version = version_of(up.name)
        if version is None:
            problems.append(f"{up.name}: имя не начинается с номера версии")
            continue
        if version < FIRST_REVERSIBLE:
            continue
        if up.name in EXCEPTIONS:
            print(f"  пропущена {up.name}: {EXCEPTIONS[up.name]}")
            continue

        checked += 1
        down = DOWN_DIR / up.name
        if not down.exists():
            problems.append(f"{up.name}: нет обратного файла down/{up.name}")
            continue

        body = down.read_text("utf-8")
        if not body.strip():
            problems.append(f"down/{up.name}: файл пуст")
            continue

        # Откат, не снявший запись, оставит миграцию «применённой»: она
        # не накатится повторно, а схемы под неё уже нет.
        stem = up.stem
        if f"DELETE FROM schema_migrations" not in body or stem not in body:
            problems.append(
                f"down/{up.name}: не удаляет запись '{stem}' из schema_migrations",
            )

    # Осиротевший down — след переименованной или удалённой миграции.
    for down in sorted(DOWN_DIR.glob("*.sql")):
        if not (UP_DIR / down.name).exists():
            problems.append(f"down/{down.name}: нет соответствующей миграции")

    if problems:
        print("Проверка обратимости миграций не пройдена:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    print(f"{checked} миграций начиная с {FIRST_REVERSIBLE:03d} имеют обратимый down")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
