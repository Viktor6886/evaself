#!/usr/bin/env python3
"""Граница арендатора: SQL по пользовательской таблице обязан её называть.

Проверка существует потому, что утечка между пользователями не выглядит
как поломка. Забытый `WHERE user_id = $1` даёт зелёные тесты и рабочий
интерфейс — расхождение всплывает, когда один человек видит чужие данные.

Правило простое: если запрос трогает таблицу, у которой есть колонка
`user_id`, он обязан либо ограничивать выборку по `user_id`/`telegram_id`,
либо нести явную пометку, объясняющую, почему ограничения нет.

    -- tenant: system — общесистемная операция, не запрос пользователя
    -- tenant: by <колонка> — ограничение через собственный ключ владельца

Пометка обязана содержать причину: молчаливое исключение ничем не лучше
забытого условия.

Список пользовательских таблиц выводится ИЗ МИГРАЦИЙ, а не задан здесь
списком. Иначе новая таблица с user_id молча оказалась бы вне проверки —
ровно в тот момент, когда проверка нужнее всего.
"""
from __future__ import annotations

import glob
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

CREATE_TABLE = re.compile(
    r"CREATE TABLE IF NOT EXISTS (\w+)\s*\((.*?)\n\);", re.S
)
ADD_USER_COLUMN = re.compile(
    r"ALTER TABLE (\w+)[^;]*ADD COLUMN[^;]*\buser_id\b", re.S
)
DROPPED_TABLE = re.compile(r"DROP TABLE\s+(?:IF EXISTS\s+)?%\w+|'(\w+)'")

SQL_VERB = re.compile(r"\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b", re.I)
SQL_TABLE = re.compile(r"\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)", re.I)
TENANT_COLUMN = re.compile(r"\b(user_id|telegram_id)\b")
MARKER = re.compile(r"--\s*tenant:\s*(system|by\s+[a-z_][a-z0-9_]*)\s*(?:—|-|:)?\s*(.*)", re.I)


def _references_users(body: str) -> bool:
    """user_id ведёт именно на users, а не на admin_users.

    У admin_sessions и admin_user_notes тоже есть user_id, но принадлежат
    они администратору. Это другая область доступа, и мешать их с данными
    пользователей значит размывать смысл проверки.
    """
    inline = re.search(
        r"^\s*user_id\b[^,\n]*REFERENCES\s+users\b", body, re.M | re.I
    )
    named = re.search(
        r"FOREIGN KEY\s*\(\s*user_id\s*\)\s*REFERENCES\s+users\b", body, re.I
    )
    return bool(inline or named)


def owned_tables() -> set[str]:
    """Таблицы, чей user_id ссылается на users, по фактическим миграциям."""
    owned: set[str] = set()
    for path in sorted(glob.glob(str(ROOT / "postgres/migrations/*.sql"))):
        text = Path(path).read_text(encoding="utf-8")
        for match in CREATE_TABLE.finditer(text):
            body = match.group(2)
            if re.search(r"^\s*user_id\b", body, re.M) and _references_users(body):
                owned.add(match.group(1))
        for match in ADD_USER_COLUMN.finditer(text):
            owned.add(match.group(1))
    # Таблицы, которые миграция 016 удаляет как незаполненные, в схеме
    # не существуют — проверять обращения к ним не по чему.
    cleanup = ROOT / "postgres/migrations/016_cleanup_and_safety.sql"
    if cleanup.exists():
        text = cleanup.read_text(encoding="utf-8")
        block = re.search(r"FOREACH candidate IN ARRAY ARRAY\[(.*?)\]", text, re.S)
        if block:
            for name in re.findall(r"'(\w+)'", block.group(1)):
                owned.discard(name)
    return owned


def main() -> int:
    owned = owned_tables()
    if not owned:
        print("::error::не удалось определить пользовательские таблицы", file=sys.stderr)
        return 1

    problems: list[str] = []
    marked = 0
    checked = 0

    for path in sorted(glob.glob(str(ROOT / "eva-agent-service/src/**/*.ts"), recursive=True)):
        rel = Path(path).relative_to(ROOT)
        source = Path(path).read_text(encoding="utf-8")
        for literal in re.finditer(r"`([^`]*)`", source, re.S):
            sql = literal.group(1)
            if not SQL_VERB.search(sql):
                continue
            tables = {t.lower() for t in SQL_TABLE.findall(sql)} & owned
            if not tables:
                continue
            checked += 1
            if TENANT_COLUMN.search(sql):
                continue
            marker = MARKER.search(sql)
            reason = marker.group(2).strip() if marker else ""
            # Причина должна быть причиной, а не остатком запроса: `--`
            # комментирует строку до конца, поэтому «пометка», за которой
            # идёт SQL, означает закомментированный запрос.
            if reason and len(reason) >= 12 and not SQL_VERB.search(reason):
                marked += 1
                continue
            line = source[: literal.start()].count("\n") + 1
            statement = " ".join(sql.split())[:100]
            if marker:
                problems.append(
                    f"{rel}:{line}: пометка tenant без причины — {statement}"
                )
            else:
                problems.append(
                    f"{rel}:{line}: {','.join(sorted(tables))} без user_id и без пометки — {statement}"
                )

    print(
        f"пользовательских таблиц: {len(owned)}; "
        f"запросов к ним: {checked}; с явной пометкой: {marked}"
    )
    if problems:
        print()
        for problem in problems:
            print(f"  {problem}")
        print()
        print(
            "Добавьте ограничение по user_id или пометку с причиной:\n"
            "  -- tenant: system — почему это общесистемная операция\n"
            "  -- tenant: by agent_id — через какой ключ владельца идёт ограничение",
            file=sys.stderr,
        )
        print(f"::error::запросов без границы арендатора: {len(problems)}", file=sys.stderr)
        return 1

    print("каждый запрос к пользовательской таблице имеет границу арендатора")
    return 0


if __name__ == "__main__":
    sys.exit(main())
