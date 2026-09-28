"""Файл своего сервера Bot API: копия в рабочий каталог, оригинал удалён."""

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from app.audio import MediaError
from app.telegram_files import fetch_telegram_file, take_local_file


def test_local_file_is_copied_and_the_original_removed(tmp_path: Path):
    root = tmp_path / "bot-api"
    original = root / "TOKEN" / "music" / "lecture.mp3"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"ID3" + b"x" * 100)
    work = tmp_path / "work"
    work.mkdir()

    copy = take_local_file(original, work, 1024, root=root)

    assert copy.read_bytes() == b"ID3" + b"x" * 100
    assert copy.parent == work
    assert not original.exists(), "запись осталась на диске сервера Bot API"


def test_path_outside_the_bot_api_directory_is_refused(tmp_path: Path):
    root = tmp_path / "bot-api"
    root.mkdir()
    secret = tmp_path / "secret.txt"
    secret.write_text("не для чтения")
    with pytest.raises(MediaError):
        take_local_file(secret, tmp_path, 1024, root=root)
    assert secret.exists()


def test_oversized_local_file_is_refused_and_removed(tmp_path: Path):
    root = tmp_path / "bot-api"
    original = root / "documents" / "huge.wav"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"0" * 2048)
    with pytest.raises(MediaError):
        take_local_file(original, tmp_path, 1024, root=root)
    assert not original.exists()


def test_absolute_file_path_from_get_file_is_read_from_disk(tmp_path: Path):
    root = tmp_path / "bot-api"
    original = root / "voice" / "file_7.oga"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"OggS")
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(request.url.path)
        return httpx.Response(200, content=json.dumps(
            {"ok": True, "result": {"file_id": "f", "file_path": str(original)}}
        ))

    async def run() -> Path:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            work = tmp_path / "work"
            work.mkdir()
            return await fetch_telegram_file(
                http, "http://telegram-bot-api:8081", "TOKEN", "f", work, 1024, local_root=root
            )

    copy = asyncio.run(run())
    assert copy.read_bytes() == b"OggS"
    # Скачивания по /file/ нет: локальный сервер файлы по HTTP не раздаёт.
    assert requested == ["/botTOKEN/getFile"]
    assert not original.exists()
