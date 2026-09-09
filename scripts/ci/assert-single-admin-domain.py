#!/usr/bin/env python3
"""Административная поверхность живёт на одном домене и под одним входом.

Проверка появилась вместе с единой панелью. До неё установка публиковала
пять имён, и два из них — консоль Letta и страница статуса — были
отдельными входами: у первой собственный HTTP Basic Auth в Caddy, у второй
не было входа вовсе. Ошибка в такой раскладке не выглядит как поломка:
всё работает, просто административная поверхность шире, чем кажется.

Проверяется структура, а не поведение:

  * наружу проксируются ровно три имени — сайт, Mini App и публичный API;
  * прежние имена консоли и статуса остались только редиректом;
  * `basic_auth` не встречается ни в одном Caddyfile репозитория;
  * панель и её API проксируются с основного домена, а не с поддомена;
  * ни одного сервиса `letta-ui` / `uptime-kuma` в compose, и Caddy
    получает подстановку `:-` для выведенных из эксплуатации имён —
    в самом Caddyfile `{$VAR:default}` пустую строку считает значением.

Поведение (что именно отдаёт живой Caddy) проверяют `caddy adapt` и
`assert-caddy-order.py` рядом.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CADDYFILE = ROOT / "Caddyfile"
COMPOSE = ROOT / "compose.yaml"

# Имена, которые установка публикует наружу с настоящим содержимым.
PUBLIC_HOSTS = {"{$DOMAIN}", "{$DOMAIN_APP}", "{$DOMAIN_API}"}
# Имена, оставшиеся только ради закладок: на них ничего не проксируется.
REDIRECT_HOSTS = {"{$DOMAIN_LETTA_LEGACY}", "{$DOMAIN_STATUS_LEGACY}"}

SITE = re.compile(r"^(\{\$[A-Z_]+\})\s*\{$", re.M)


def site_blocks(text: str) -> dict[str, str]:
    """Тело каждого site-блока верхнего уровня, по имени хоста."""
    blocks: dict[str, str] = {}
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        match = SITE.match(lines[index])
        if not match:
            index += 1
            continue
        depth = 1
        body: list[str] = []
        index += 1
        while index < len(lines) and depth > 0:
            depth += lines[index].count("{") - lines[index].count("}")
            if depth > 0:
                body.append(lines[index])
            index += 1
        blocks[match.group(1)] = "\n".join(body)
    return blocks


def main() -> int:
    failures: list[str] = []
    text = CADDYFILE.read_text("utf-8")
    blocks = site_blocks(text)

    unknown = set(blocks) - PUBLIC_HOSTS - REDIRECT_HOSTS
    if unknown:
        failures.append(f"неизвестные публичные имена в Caddyfile: {sorted(unknown)}")
    missing = PUBLIC_HOSTS - set(blocks)
    if missing:
        failures.append(f"в Caddyfile нет обязательных имён: {sorted(missing)}")

    for host in REDIRECT_HOSTS & set(blocks):
        body = blocks[host]
        if "reverse_proxy" in body:
            failures.append(f"{host}: выведенное из эксплуатации имя всё ещё что-то проксирует")
        if "redir https://{$DOMAIN}/admin/" not in body:
            failures.append(f"{host}: нет редиректа на раздел панели")

    main_site = blocks.get("{$DOMAIN}", "")
    if "reverse_proxy admin-ui:8083" not in main_site:
        failures.append("панель не проксируется с основного домена")
    if "reverse_proxy admin-api:8071" not in main_site:
        failures.append("административный API не проксируется с основного домена")

    # Второго входа нет ни в одном Caddyfile: отдельный Basic Auth был
    # ровно тем, из-за чего администратору приходилось логиниться дважды.
    for path in sorted(ROOT.glob("**/Caddyfile")):
        if "node_modules" in path.parts:
            continue
        if "basic_auth" in path.read_text("utf-8"):
            failures.append(f"{path.relative_to(ROOT)}: остался отдельный basic_auth")

    compose = yaml.safe_load(COMPOSE.read_text("utf-8"))
    services = compose.get("services", {})
    for retired in ("letta-ui", "uptime-kuma"):
        if retired in services:
            failures.append(f"сервис {retired} выведен из эксплуатации, но остался в compose")

    caddy_env = services.get("caddy", {}).get("environment", {}) or {}
    for name in ("DOMAIN_LETTA_LEGACY", "DOMAIN_STATUS_LEGACY"):
        value = str(caddy_env.get(name, ""))
        if ":-" not in value:
            failures.append(
                f"caddy.{name} обязан подставлять значение через `:-`: "
                "в Caddyfile пустая переменная считается заданной и оставит блок без имени хоста"
            )
    for name in ("LETTA_UI_USER", "LETTA_UI_PASSWORD_HASH"):
        if name in caddy_env:
            failures.append(f"caddy получает {name}, хотя basic_auth снят")

    if failures:
        print("::error::административная поверхность шире одного домена:")
        for item in failures:
            print(f"  {item}")
        return 1
    print(
        f"публичных имён: {len(PUBLIC_HOSTS)}; "
        f"выведенных из эксплуатации редиректов: {len(REDIRECT_HOSTS & set(blocks))}; "
        "второго входа нет"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
