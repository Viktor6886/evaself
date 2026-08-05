#!/usr/bin/env python3
"""Что сервис читает из окружения, то compose обязан ему передать.

Так был потерян EVA_ROUTER_API_KEY. Переменная появилась в .env.example,
в configure.sh и в ensure-env-defaults.sh, ключ исправно создавался на
сервере — но в compose его получал только сам llm-router. Агент, который
и выполняет переключение LLM, не получал ничего, и активация провайдера
отказывала с «EVA_ROUTER_API_KEY не задан», хотя ключ в .env был.

Найти это чтением кода почти невозможно: каждый файл по отдельности
выглядит правильно, а ошибка живёт в промежутке между ними. Поэтому здесь
сравниваются два списка — что config.ts читает и что compose передаёт.

Умолчание в коде обязательным не считается, но и молча пропущенным тоже:
переменная либо передаётся, либо перечислена в EXEMPT с причиной.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "eva-agent-service" / "src" / "config.ts"
COMPOSE = ROOT / "compose.yaml"
SERVICE = "eva-agent-service"

# Внутренние настройки производительности: у них есть рабочие умолчания в
# коде, в .env.example они не выносились, и трогать их на установке
# незачем. Всё остальное должно доходить до контейнера.
EXEMPT = {
    "EVA_AGENT_HOST": "адрес прослушивания внутри контейнера, всегда 0.0.0.0",
    "EVA_AGENT_SESSION_POOL": "размер пула сессий SDK, умолчание в коде",
    "EVA_AGENT_SESSION_IDLE_MS": "время простоя сессии SDK, умолчание в коде",
}

# clampedInt читает окружение так же, как остальные, но в список
# читателей не входил: `\b` перед `Int` внутри `clampedInt` не стоит,
# и семь переменных проходили мимо проверки, ради которой она есть.
READER = re.compile(r'(?:\bstr|\bint|\bbool|nullableInt|clampedInt)\("([A-Z][A-Z0-9_]*)"')
DIRECT = re.compile(r"process\.env\.([A-Z][A-Z0-9_]*)")


def main() -> int:
    source = CONFIG.read_text("utf-8")
    read = set(READER.findall(source)) | set(DIRECT.findall(source))

    compose = yaml.safe_load(COMPOSE.read_text("utf-8"))
    service = compose["services"].get(SERVICE)
    if not service:
        print(f"в compose нет сервиса {SERVICE}", file=sys.stderr)
        return 1
    passed = set(service.get("environment") or {})

    missing = sorted(read - passed - set(EXEMPT))
    stale = sorted(name for name in EXEMPT if name in passed)

    if missing:
        print("Переменные читаются кодом, но не передаются сервису:", file=sys.stderr)
        for name in missing:
            print(f"  - {name}", file=sys.stderr)
        print(
            f"\nДобавьте их в environment сервиса {SERVICE} в compose.yaml "
            "или впишите в EXEMPT с причиной.",
            file=sys.stderr,
        )
        return 1

    if stale:
        # Исключение перестало быть исключением — список должен это отражать,
        # иначе он потихоньку превратится в свалку.
        print("Эти переменные уже передаются, уберите их из EXEMPT:", file=sys.stderr)
        for name in stale:
            print(f"  - {name}", file=sys.stderr)
        return 1

    print(
        f"{len(read)} переменных окружения читает config.ts, "
        f"{len(read) - len(EXEMPT)} доходят до {SERVICE} "
        f"({len(EXEMPT)} с умолчанием в коде)",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
