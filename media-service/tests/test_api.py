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


# =====================================================================
# Проверка провайдера записью из браузера
# =====================================================================
def test_stt_test_converts_uploaded_recording_before_sending(client, monkeypatch):
    """Запись из браузера не WAV, и уходить провайдеру как WAV не должна.

    Chrome пишет webm/opus, Safari — mp4/aac. Раньше присланные байты
    клались прямо в probe.wav и отправлялись под этим именем: Deepgram
    выживал, потому что определяет формат сам, а OpenAI получал
    multipart с враньём в имени файла. Теперь между ними стоит ffmpeg —
    ровно тот же, через который проходит обычное распознавание.
    """
    import base64

    from app import main as media_main

    converted = {}

    async def fake_probe(path):
        # Пришло что угодно, только не WAV.
        assert path.name == "upload.bin", f"сырьё должно лечь как есть, а не как {path.name}"
        return {"has_audio": True, "duration_seconds": 2.0}

    async def fake_to_asr_wav(source, destination):
        converted["from"] = source.name
        converted["to"] = destination.name
        destination.write_bytes(b"RIFF....WAVE")
        return destination

    seen = {}

    class FakeAdapter:
        def validate(self, config):
            from app.stt.types import ValidationResult
            return ValidationResult(ok=True)

        async def test(self, config, audio):
            from app.stt.types import SttResult
            seen["filename"] = audio.filename
            seen["mime"] = audio.mime_type
            return SttResult(
                text="проверка", provider="deepgram", model=config.model, latency_ms=11,
            )

    class FakeRegistry:
        def has(self, provider):
            return True

        def get(self, provider):
            return FakeAdapter()

    monkeypatch.setattr(media_main, "probe", fake_probe)
    monkeypatch.setattr(media_main, "to_asr_wav", fake_to_asr_wav)
    monkeypatch.setattr(media_main, "STT_REGISTRY", FakeRegistry())

    response = client.post("/stt/test", json={
        "config": {
            "name": "Deepgram", "provider": "deepgram", "mode": "batch",
            "base_url": "https://api.deepgram.com/v1/listen", "model": "nova-3",
            "params": {}, "secret": "k",
        },
        # Заголовок webm — то, что реально присылает Chrome.
        "audio_base64": base64.b64encode(b"\x1aE\xdf\xa3webm-data").decode(),
    })

    assert response.status_code == 200, response.text
    assert response.json()["success"] is True
    assert converted == {"from": "upload.bin", "to": "probe.wav"}
    # Провайдеру уходит уже перекодированный WAV.
    assert seen == {"filename": "probe.wav", "mime": "audio/wav"}


def test_stt_test_rejects_a_recording_without_audio(client, monkeypatch):
    from app import main as media_main

    async def fake_probe(path):
        return {"has_audio": False, "duration_seconds": 0.0}

    class FakeRegistry:
        def has(self, provider):
            return True

        def get(self, provider):
            class Adapter:
                def validate(self, config):
                    from app.stt.types import ValidationResult
                    return ValidationResult(ok=True)
            return Adapter()

    monkeypatch.setattr(media_main, "probe", fake_probe)
    monkeypatch.setattr(media_main, "STT_REGISTRY", FakeRegistry())

    import base64
    response = client.post("/stt/test", json={
        "config": {
            "name": "Deepgram", "provider": "deepgram", "mode": "batch",
            "base_url": "https://api.deepgram.com/v1/listen", "model": "nova-3",
            "params": {}, "secret": "k",
        },
        "audio_base64": base64.b64encode(b"not audio at all").decode(),
    })

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "stt_audio_invalid"


def test_speech_request_carries_the_voice_prompt_only_when_it_is_set():
    """Описание манеры речи уходит провайдеру полем `instructions`.

    Пустое поле часть провайдеров отвергает как неизвестный параметр,
    поэтому оно не должно появляться в теле «на всякий случай».
    """
    from app.main import _speech_request

    plain = _speech_request(
        model="google/gemini-3.1-flash-tts-preview", voice="Kore",
        text="привет", voice_prompt=None,
    )
    assert plain == {
        "model": "google/gemini-3.1-flash-tts-preview",
        "voice": "Kore",
        "input": "привет",
        "response_format": "mp3",
    }

    described = _speech_request(
        model="google/gemini-3.1-flash-tts-preview", voice="Kore",
        text="привет", voice_prompt="  Тёплый голос, спокойный темп  ",
    )
    assert described["instructions"] == "Тёплый голос, спокойный темп"
    # Пробелы вместо описания — это отсутствие описания.
    assert "instructions" not in _speech_request(
        model="m", voice="v", text="t", voice_prompt="   ",
    )


def test_tts_reports_an_empty_answer_instead_of_sending_silence(client, monkeypatch):
    """Пустой ответ провайдера — отказ, а не голосовое сообщение из нуля байт."""
    from app import main as media_main

    monkeypatch.setattr(
        media_main.RUNTIME, "tts",
        lambda: {
            "base_url": "https://openrouter.ai/api/v1", "api_key": "k",
            "model": "google/gemini-3.1-flash-tts-preview", "voice": "Kore",
            "voice_prompt": "спокойный темп",
        },
    )

    sent = {}

    class EmptyResponse:
        status_code = 200
        content = b""
        text = ""

    async def fake_post(url, **kwargs):
        sent["url"] = url
        sent["json"] = kwargs.get("json")
        return EmptyResponse()

    monkeypatch.setattr(media_main.app.state.http, "post", fake_post)

    response = client.post("/tts", json={"text": "привет"})
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "tts_empty"
    # Настройка панели доходит до провайдера без участия вызывающего.
    assert sent["url"].endswith("/audio/speech")
    assert sent["json"]["instructions"] == "спокойный темп"
    assert sent["json"]["voice"] == "Kore"


def test_speech_request_uses_the_configured_response_format():
    """Формат — настройка, а не зашитое «mp3».

    Gemini TTS отдаёт PCM 24 кГц, и зашитый mp3 давал у провайдера 400,
    в котором администратору нечего было менять.
    """
    from app.main import _speech_request

    assert _speech_request(
        model="m", voice="v", text="t", voice_prompt=None, response_format="wav",
    )["response_format"] == "wav"
    # Неизвестное значение не уходит провайдеру: его 400 объяснить труднее.
    assert _speech_request(
        model="m", voice="v", text="t", voice_prompt=None, response_format="ogg-opus",
    )["response_format"] == "mp3"


def test_tts_test_names_the_combination_the_provider_accepts(client, monkeypatch):
    """Проверка синтеза подбирает сочетание и называет его.

    «Провайдер вернул 400» администратору бесполезно: по такому
    сообщению нечего менять. Отказавшее сочетание сменяется следующим,
    а в ответе написано, что именно принято.
    """
    from app import main as media_main

    monkeypatch.setattr(
        media_main.RUNTIME, "tts",
        lambda: {
            "base_url": "https://openrouter.ai/api/v1", "api_key": "k",
            "model": "google/gemini-3.1-flash-tts-preview", "voice": "Kore",
            "voice_prompt": "тёплый голос", "response_format": "mp3",
        },
    )

    attempts = []

    class Response:
        def __init__(self, status_code, content=b"", text=""):
            self.status_code = status_code
            self.content = content
            self.text = text

    async def fake_post(url, **kwargs):
        body = kwargs.get("json")
        attempts.append((body["response_format"], "instructions" in body))
        if body["response_format"] == "wav" and "instructions" not in body:
            return Response(200, b"RIFFfake-audio")
        return Response(400, text='{"error":{"message":"unsupported response_format"}}')

    monkeypatch.setattr(media_main.app.state.http, "post", fake_post)

    payload = client.post("/tts/test").json()
    assert payload["ok"] is True, payload
    assert payload["response_format"] == "wav"
    assert payload["instructions_sent"] is False
    assert "wav" in payload["message"] and "Voice Prompt" in payload["message"]
    # Первым пробуется именно то, что задано в панели.
    assert attempts[0] == ("mp3", True)


def test_tts_test_relays_what_the_provider_said(client, monkeypatch):
    """Ответ провайдера доходит до администратора целиком.

    Он единственное место, где написано, что именно не понравилось.
    """
    from app import main as media_main

    monkeypatch.setattr(
        media_main.RUNTIME, "tts",
        lambda: {
            "base_url": "https://openrouter.ai/api/v1", "api_key": "k",
            "model": "нет-такой-модели", "voice": "Kore",
            "voice_prompt": "", "response_format": "mp3",
        },
    )

    calls = []

    class Response:
        status_code = 404
        content = b""
        text = '{"error":{"message":"model not found"}}'

    async def fake_post(url, **kwargs):
        calls.append(kwargs.get("json"))
        return Response()

    monkeypatch.setattr(media_main.app.state.http, "post", fake_post)

    response = client.post("/tts/test")
    assert response.status_code == 502
    error = response.json()["error"]
    assert error["code"] == "tts_error"
    assert "404" in error["message"]
    assert "model not found" in error["details"]
    # Имя модели от формата не зависит — перебирать нечего.
    assert len(calls) == 1
