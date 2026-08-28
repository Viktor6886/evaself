#!/usr/bin/env python3
"""Список видов апдейтов Telegram — один на всех, кто ставит вебхук.

Чего в списке нет, того webhook не увидит: молча, без ошибки где-либо.
Так не работала оплата звёздами — `pre_checkout_query` добавили в код, а
бот, зарегистрированный раньше, остался с прежним списком, и Telegram
отменял платёж по таймауту.

Ставят вебхук трое: рантайм при старте, переезд на другого бота в панели
и скрипт установщика. Первые два берут список из одного модуля; третий —
скрипт на shell, и его сверяет эта проверка. Проверка живёт здесь, а не
в тестах сервиса: те выполняются внутри образа, где каталога `scripts`
нет и быть не должно.
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "eva-agent-service" / "src" / "telegram" / "allowed-updates.ts"
SCRIPT = ROOT / "scripts" / "telegram-webhook.sh"


def declared_in_source() -> list[str]:
    text = SOURCE.read_text("utf-8")
    block = re.search(
        r"TELEGRAM_ALLOWED_UPDATES\s*=\s*\[(.*?)\]\s*as const;", text, re.S
    )
    if not block:
        sys.exit(f"::error::в {SOURCE.name} не найден TELEGRAM_ALLOWED_UPDATES")
    return re.findall(r'"([a-z_]+)"', block.group(1))


def declared_in_script() -> list[str]:
    text = SCRIPT.read_text("utf-8")
    block = re.search(r"allowed_updates=(\[[^\]]*\])", text)
    if not block:
        sys.exit(f"::error::в {SCRIPT.name} не найден allowed_updates")
    return json.loads(block.group(1))


def main() -> None:
    source = sorted(declared_in_source())
    script = sorted(declared_in_script())
    if source != script:
        only_source = sorted(set(source) - set(script))
        only_script = sorted(set(script) - set(source))
        print("::error::установщик и рантайм регистрируют разные виды апдейтов")
        if only_source:
            print(f"  нет в установщике: {', '.join(only_source)}")
        if only_script:
            print(f"  нет в коде:        {', '.join(only_script)}")
        sys.exit(1)
    # Отдельно назван тот вид, без которого не работает оплата: его легче
    # всего потерять, а отказ от его потери — самый тихий.
    if "pre_checkout_query" not in source:
        sys.exit("::error::без pre_checkout_query оплата звёздами не работает вовсе")
    print(f"виды апдейтов совпадают у кода и установщика: {', '.join(source)}")


if __name__ == "__main__":
    main()
