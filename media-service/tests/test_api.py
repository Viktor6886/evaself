"""API-level tests using FastAPI's TestClient (no network calls)."""

import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_health_reports_ffmpeg_and_configuration(client):
    body = client.get("/health").json()
    assert body["service"] == "media-service"
    assert body["ffmpeg"] is (shutil.which("ffmpeg") is not None)
    # ASR/TTS are intentionally unset at install time.
    assert body["asr_configured"] is False
    assert body["tts_configured"] is False


def test_transcribe_without_asr_configured_returns_a_clear_error(client, tmp_path):
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg is not installed")

    voice: Path = tmp_path / "voice.ogg"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
            "-ac", "1", "-ar", "48000", "-c:a", "libopus", str(voice),
        ],
        check=True,
    )

    with voice.open("rb") as handle:
        response = client.post("/transcribe", files={"file": ("voice.ogg", handle, "audio/ogg")})

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "asr_not_configured"
    assert response.json()["error"]["retryable"] is True


def test_probe_endpoint_rejects_a_non_media_upload(client, tmp_path):
    junk = tmp_path / "notes.txt"
    junk.write_text("not audio")
    with junk.open("rb") as handle:
        response = client.post("/probe", files={"file": ("notes.txt", handle, "text/plain")})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "probe_failed"


def test_tts_without_configuration_returns_a_clear_error(client):
    response = client.post("/tts", json={"text": "привет"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "tts_not_configured"


def test_telegram_transcribe_without_a_token_is_refused(client):
    response = client.post("/telegram/transcribe", json={"file_id": "abc"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "telegram_not_configured"


def test_temp_directory_is_empty_after_requests(client):
    from app.main import WORK_DIR

    leftovers = list(Path(WORK_DIR).glob("job-*"))
    assert leftovers == [], f"temporary workspaces were not cleaned up: {leftovers}"
