#!/usr/bin/env python3
"""Каждый маршрут административного API объявляет, кому он доступен.

В server.ts проверка роли выглядит так:

    if (access.roles && !roleAllowed(session.user.role, access.roles)) {
      throw adminForbidden();
    }

Условие начинается с `access.roles`, поэтому маршрут, забывший объявить
роли, проверку не проваливает — он её пропускает. Такой маршрут доступен
любому вошедшему, включая viewer, и снаружи это выглядит как обычная
рабочая ручка: ни ошибки, ни записи в журнале.

Скрипт требует, чтобы у каждого маршрута было либо `public: true`, либо
непустой список `roles`. Дополнительно проверяется, что мутирующие
маршруты не раздают права шире, чем читающие: POST/PUT/PATCH/DELETE не
может быть доступен viewer.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Раньше проверялся один server.ts. Маршруты с тех пор появились и в
# соседних модулях каталога — регистрация вынесена из файла, который и без
# того за тысячу строк. Проверка обязана видеть их все: маршрут, уехавший в
# другой файл, не перестаёт быть административным.
ADMIN_DIR = ROOT / "eva-agent-service" / "src" / "admin"

METHODS = ("get", "post", "put", "patch", "delete")
MUTATING = {"post", "put", "patch", "delete"}
KNOWN_ROLES = {"owner", "admin", "operator", "viewer"}

# Запрет «viewer не меняет состояние» метит в состояние установки. Эти
# маршруты действуют на самого вызывающего: выйти из системы и сменить
# собственный пароль обязан уметь любой, иначе viewer не сможет даже
# завершить свою сессию.
SELF_SERVICE = {
    "/api/admin/v1/auth/logout",
    "/api/admin/v1/auth/password",
    "/api/admin/v1/sudo",
}

CALL = re.compile(r"\bapp\.(" + "|".join(METHODS) + r")\(\s*\"([^\"]+)\"")


def options_after(source: str, start: int) -> str:
    """Текст объекта опций сразу за путём, со сбалансированными скобками.

    Регулярным выражением это не берётся: внутри лежат вложенные `{}`
    (`config: { roles: [...] }`), и ленивый `.*?` обрывается на первой
    закрывающей скобке.
    """
    i = start
    while i < len(source) and source[i] not in ",)":
        i += 1
    if i >= len(source) or source[i] == ")":
        return ""
    i += 1
    while i < len(source) and source[i].isspace():
        i += 1
    if i >= len(source) or source[i] != "{":
        return ""

    depth = 0
    begin = i
    while i < len(source):
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                return source[begin:i + 1]
        i += 1
    return ""


def main() -> int:
    problems: list[str] = []
    routes = 0
    public = 0
    files = sorted(ADMIN_DIR.glob("*.ts"))
    if not files:
        print(f"каталог {ADMIN_DIR} пуст — проверка потеряла цель", file=sys.stderr)
        return 1

    for source_file in files:
      source = source_file.read_text("utf-8")
      for match in CALL.finditer(source):
        method, path = match.group(1), match.group(2)
        # /health и /healthz объявляются без конфигурации и живут вне
        # административного контура.
        if not path.startswith("/api/admin/"):
            continue
        routes += 1
        label = f"{source_file.name}: {method.upper()} {path}"
        options = options_after(source, match.end())

        if "public: true" in options:
            public += 1
            continue

        roles_match = re.search(r"roles:\s*\[([^\]]*)\]", options)
        if not roles_match:
            problems.append(
                f"{label}: нет ни `public: true`, ни `roles` — "
                f"маршрут будет доступен любому вошедшему",
            )
            continue

        roles = {r.strip().strip("\"'") for r in roles_match.group(1).split(",") if r.strip()}
        if not roles:
            problems.append(f"{label}: список `roles` пуст")
            continue

        unknown = roles - KNOWN_ROLES
        if unknown:
            problems.append(f"{label}: неизвестные роли {sorted(unknown)}")

        if method in MUTATING and "viewer" in roles and path not in SELF_SERVICE:
            problems.append(f"{label}: viewer не должен менять состояние")

    if not routes:
        print("не найдено ни одного маршрута — проверка потеряла цель", file=sys.stderr)
        return 1

    if problems:
        print("Проверка доступа к маршрутам не пройдена:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    print(f"{routes} маршрутов админского API объявляют доступ ({public} публичных)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
