"""Скачать наборы правил WhatsMyName и Sherlock с закреплённых коммитов.

Наборы — данные, а не код, но от них зависит, что сервис считает
«аккаунт найден». Поэтому они закреплены по коммиту и по sha256: новая
версия набора — это осознанное изменение этого файла, а не сюрприз при
очередной сборке образа. Несовпадение хэша останавливает сборку.

Запуск: python tools/fetch_datasets.py <каталог>
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

DATASETS = {
    # WhatsMyName — CC BY-SA 4.0, https://github.com/WebBreacher/WhatsMyName
    "wmn-data.json": (
        "https://raw.githubusercontent.com/WebBreacher/WhatsMyName/"
        "062bcfe48df79fa618e96edc79dc9673f3fe5643/wmn-data.json",
        "507d2f8aa5b1297ae2d713634ccc7ce08357fed85b1d40130585810f456c1cfe",
    ),
    # Sherlock — MIT, https://github.com/sherlock-project/sherlock
    "sherlock-data.json": (
        "https://raw.githubusercontent.com/sherlock-project/sherlock/"
        "376018708c0f6948d3f978a9ae2915024e794654/sherlock_project/resources/data.json",
        "3fdfc6694c5cd99798881215554b09e617c6d5284a6219fae309882566a9fb30",
    ),
}


def main(target: Path) -> int:
    target.mkdir(parents=True, exist_ok=True)
    for name, (url, expected) in DATASETS.items():
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
        actual = hashlib.sha256(data).hexdigest()
        if actual != expected:
            print(f"{name}: sha256 {actual} != {expected}", file=sys.stderr)
            return 1
        (target / name).write_bytes(data)
        print(f"{name}: {len(data)} bytes, sha256 ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1] if len(sys.argv) > 1 else "datasets")))
