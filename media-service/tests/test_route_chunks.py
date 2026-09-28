"""Длина части и оплаченный остаток в распознавании по сценарию.

Часть длинной записи должна пройти у каждого провайдера цепочки: Google
синхронно принимает около минуты, Gemini — 14 МБ. И запись длиннее
оплаченного остатка отклоняется до того, как за неё заплачено.
"""

import asyncio
import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import main
from app.audio import MediaError
from app.stt import max_chunk_seconds
from app.stt.adapters.google_ai_studio import MAX_INLINE_BYTES


def _config(provider: str) -> SimpleNamespace:
    return SimpleNamespace(provider=provider)


def test_chunk_fits_every_provider_of_the_chain():
    assert max_chunk_seconds([_config("openai")]) is None
    assert max_chunk_seconds([_config("deepgram"), _config("openrouter")]) is None
    assert max_chunk_seconds([_config("google")]) == 55
    gemini = max_chunk_seconds([_config("google_ai_studio")])
    assert gemini is not None and gemini * 32000 + 44 <= MAX_INLINE_BYTES
    # Резерв тоже должен принять часть: предел — самый строгий в цепочке.
    assert max_chunk_seconds([_config("openai"), _config("google")]) == 55


@pytest.fixture()
def tone(tmp_path: Path) -> Path:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        pytest.skip("ffmpeg is not installed")
    path = tmp_path / "tone.ogg"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-ac", "1", "-ar", "48000", "-c:a", "libopus", str(path),
        ],
        check=True,
    )
    return path


class _Runtime:
    def __init__(self, providers: list[str]) -> None:
        self._route = SimpleNamespace(
            max_audio_seconds=None,
            usable_chain=[_config(provider) for provider in providers],
        )

    def route(self, use_case: str):
        return self._route


class _Router:
    async def transcribe(self, *args, **kwargs):
        raise AssertionError("распознавание не должно было начаться")


def test_google_chain_splits_to_its_synchronous_limit(tone, tmp_path, monkeypatch):
    seen: list[float] = []

    async def split(source, directory, segment_seconds):
        seen.append(segment_seconds)
        raise MediaError("stop")

    monkeypatch.setattr(main, "STT_RUNTIME", _Runtime(["openai", "google"]))
    monkeypatch.setattr(main, "STT_ROUTER", _Router())
    monkeypatch.setattr(main, "split_to_asr_wav", split)
    asyncio.run(main._route_transcription(tone, tmp_path, "telegram_audio", "ru", None))
    assert seen == [55]


def test_recording_over_paid_budget_is_rejected_before_stt(tone, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STT_RUNTIME", _Runtime(["openai"]))
    monkeypatch.setattr(main, "STT_ROUTER", _Router())
    response = asyncio.run(
        main._route_transcription(tone, tmp_path, "telegram_audio", "ru", None, max_seconds=1)
    )
    assert response.status_code == 413
    assert json.loads(response.body)["error"]["code"] == "stt_audio_over_budget"


def test_budget_is_optional_for_old_agents():
    request = main.SttTranscribeRequest(use_case="telegram_audio", file_id="f")
    assert request.max_seconds is None
    with pytest.raises(ValueError):
        main.SttTranscribeRequest(use_case="telegram_audio", file_id="f", max_seconds=-1)
