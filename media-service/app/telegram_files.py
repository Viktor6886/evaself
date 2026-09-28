"""Файл из Telegram: по HTTP у облачного Bot API или с диска своего сервера.

Облачный Bot API отдаёт ботам файлы до 20 МБ по ссылке
`/file/bot<token>/<file_path>`. Свой сервер Bot API в локальном режиме
(`telegram-bot-api --local`) скачивает файл любого размера сам и
возвращает в `getFile` абсолютный путь на своём диске, а по HTTP файлы не
раздаёт вовсе. media-service видит этот диск томом и забирает файл
оттуда — и сразу удаляет оригинал: запись нужна ровно на время
распознавания, а сервер Bot API сам ничего не удаляет и копил бы
гигабайты чужих записей.
"""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path

import httpx

from .audio import MediaError

# Каталог данных своего сервера Bot API, смонтированный в media-service.
# Путь из getFile принимается, только если он лежит внутри него: иначе
# ошибка или подмена ответа читала бы с диска что угодно.
LOCAL_FILES_DIR = Path(os.environ.get("EVA_TELEGRAM_LOCAL_FILES_DIR", "/var/lib/telegram-bot-api"))


async def fetch_telegram_file(
    http: httpx.AsyncClient,
    api_base: str,
    token: str,
    file_id: str,
    work: Path,
    max_bytes: int,
    *,
    local_root: Path | None = None,
) -> Path:
    """Скачать файл в рабочий каталог запроса и вернуть путь к копии."""
    meta = await http.get(f"{api_base}/bot{token}/getFile", params={"file_id": file_id})
    if meta.status_code >= 400:
        raise MediaError("getFile failed", details=meta.text[:300])
    body = meta.json()
    if not body.get("ok"):
        raise MediaError("getFile returned ok=false", details=str(body)[:300])
    file_path = str((body.get("result") or {}).get("file_path") or "")
    if not file_path:
        raise MediaError("getFile не вернул file_path")

    if file_path.startswith("/"):
        # Копия до 350 МБ между томами — секунды блокирующего ввода-вывода.
        # В потоке: иначе на это время встал бы весь сервис, вместе с
        # проверкой здоровья и чужими распознаваниями.
        return await asyncio.to_thread(
            take_local_file, Path(file_path), work, max_bytes, root=local_root or LOCAL_FILES_DIR
        )

    target = work / Path(file_path).name
    async with http.stream("GET", f"{api_base}/file/bot{token}/{file_path}") as stream:
        if stream.status_code >= 400:
            raise MediaError(f"file download returned {stream.status_code}")
        written = 0
        with target.open("wb") as handle:
            async for chunk in stream.aiter_bytes():
                written += len(chunk)
                if written > max_bytes:
                    raise MediaError("Telegram file exceeds the configured size limit")
                handle.write(chunk)
    return target


def take_local_file(path: Path, work: Path, max_bytes: int, *, root: Path) -> Path:
    """Забрать файл с диска сервера Bot API: копия в рабочий каталог, оригинал удалён.

    Копия, а не перенос: том сервера Bot API и рабочий каталог — разные
    файловые системы. Файл больше предела тоже удаляется — распознавать
    его не будут, а место он занимал бы до конца жизни тома.
    """
    try:
        resolved = path.resolve(strict=True)
    except (FileNotFoundError, RuntimeError) as exc:
        raise MediaError("файл сервера Bot API не найден") from exc
    if not resolved.is_relative_to(root.resolve()) or not resolved.is_file():
        raise MediaError("путь getFile вне каталога сервера Bot API")
    size = resolved.stat().st_size
    if size > max_bytes:
        resolved.unlink(missing_ok=True)
        raise MediaError("Telegram file exceeds the configured size limit")
    target = work / resolved.name
    shutil.copyfile(resolved, target)
    resolved.unlink(missing_ok=True)
    return target
