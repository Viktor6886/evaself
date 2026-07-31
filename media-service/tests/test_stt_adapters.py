"""Адаптеры против настоящего HTTP-сервера с ответами провайдеров.

Ключей Deepgram, Google и OpenRouter у разработчика нет, поэтому
работоспособность подтверждается иначе: поднимается локальный HTTP-мок,
который отвечает ровно так, как описано в документации провайдера, и
адаптер проверяется целиком — сборка запроса, разбор ответа,
классификация ошибок.

Это не заменяет проверку живыми ключами. Кнопка «Проверить» в панели
делает настоящий запрос, и расхождения с реальным API ловятся там.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import httpx
import pytest

from app.stt.adapters.deepgram import DeepgramAdapter
from app.stt.adapters.google import GoogleSttAdapter, public_metadata
from app.stt.adapters.openai_compatible import (
    OPENAI_SCHEMA,
    OPENROUTER_SCHEMA,
    OpenAiCompatibleAdapter,
)
from app.stt.errors import (
    STT_AUTH_FAILED,
    STT_MODEL_NOT_FOUND,
    STT_PROVIDER_UNAVAILABLE,
    STT_RATE_LIMITED,
    STT_TIMEOUT,
    STT_TRANSCRIPTION_FAILED,
    SttError,
)
from app.stt.types import SttAudioInput, SttResolvedConfig


# =====================================================================
# мок-сервер
# =====================================================================
class MockState:
    """Что вернуть и что запомнить о запросе."""

    def __init__(self) -> None:
        self.status = 200
        self.body: object = {}
        self.raw_body: bytes | None = None
        self.delay = 0.0
        self.headers: dict[str, str] = {}
        self.requests: list[dict] = []


class _Handler(BaseHTTPRequestHandler):
    state: MockState

    def do_POST(self) -> None:  # noqa: N802 - имя задаёт BaseHTTPRequestHandler
        import time

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        parts = urlsplit(self.path)
        self.state.requests.append({
            "path": parts.path,
            "query": dict(parse_qsl(parts.query)),
            "query_pairs": parse_qsl(parts.query),
            "headers": {key.lower(): value for key, value in self.headers.items()},
            "body": raw,
        })
        if self.state.delay:
            time.sleep(self.state.delay)

        payload = (
            self.state.raw_body
            if self.state.raw_body is not None
            else json.dumps(self.state.body).encode()
        )
        self.send_response(self.state.status)
        for key, value in self.state.headers.items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args) -> None:
        pass


@pytest.fixture
def mock_provider():
    state = MockState()
    handler = type("Handler", (_Handler,), {"state": state})
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state.base_url = f"http://127.0.0.1:{server.server_port}"  # type: ignore[attr-defined]
    yield state
    server.shutdown()
    server.server_close()


@pytest.fixture
def client():
    return httpx.AsyncClient()


@pytest.fixture
def audio(tmp_path: Path) -> SttAudioInput:
    # 44 байта заголовка WAV — адаптеру важно, что файл читается, а не
    # что в нём слышно.
    path = tmp_path / "probe.wav"
    path.write_bytes(
        b"RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00"
        b"\x80>\x00\x00\x00}\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    )
    return SttAudioInput(path=path, duration_seconds=3.0)


def deepgram_config(base_url: str, **params) -> SttResolvedConfig:
    return SttResolvedConfig(
        config_id="cfg-dg", name="Deepgram", provider="deepgram", mode="batch",
        base_url=base_url, model="nova-3", params=params, secret="dg-key",
        timeout_ms=5000,
    )


def openai_config(base_url: str, model: str = "whisper-1", **params) -> SttResolvedConfig:
    return SttResolvedConfig(
        config_id="cfg-oa", name="OpenAI", provider="openai", mode="batch",
        base_url=base_url, model=model, params=params, secret="sk-test",
        timeout_ms=5000,
    )


# =====================================================================
# Deepgram
# =====================================================================
DEEPGRAM_OK = {
    "metadata": {"request_id": "dg-req-1", "duration": 3.42},
    "results": {
        "channels": [{
            "alternatives": [{
                "transcript": "Привет, это проверка распознавания.",
                "confidence": 0.978,
                "words": [
                    {"word": "привет", "punctuated_word": "Привет,",
                     "start": 0.1, "end": 0.6, "confidence": 0.99},
                    {"word": "это", "punctuated_word": "это",
                     "start": 0.7, "end": 0.9, "confidence": 0.95},
                ],
            }],
            "detected_language": "ru",
        }],
        "utterances": [
            {"transcript": "Привет, это проверка распознавания.",
             "start": 0.1, "end": 3.2, "speaker": 0},
        ],
    },
}


@pytest.mark.asyncio
async def test_deepgram_success(mock_provider, client, audio):
    mock_provider.body = DEEPGRAM_OK
    mock_provider.headers = {"dg-request-id": "dg-header-1"}
    adapter = DeepgramAdapter(client)

    result = await adapter.transcribe(
        deepgram_config(mock_provider.base_url, language="ru", punctuate=True,
                        smart_format=True, keyterms=["Ева", "Evaself"]),
        audio, {},
    )

    assert result.text == "Привет, это проверка распознавания."
    assert result.provider == "deepgram"
    assert result.language == "ru"
    assert result.confidence == pytest.approx(0.978)
    assert result.duration_ms == 3420
    assert result.provider_request_id == "dg-header-1"
    assert [word.text for word in result.words] == ["Привет,", "это"]
    assert result.words[0].start_ms == 100
    assert result.segments[0].speaker == "speaker_0"

    sent = mock_provider.requests[0]
    # keyterm повторяется, а не передаётся массивом — это и есть формат
    # Deepgram, и главная причина, по которой тест смотрит на пары.
    keyterms = [value for key, value in sent["query_pairs"] if key == "keyterm"]
    assert keyterms == ["Ева", "Evaself"]
    assert sent["query"]["model"] == "nova-3"
    assert sent["query"]["punctuate"] == "true"
    assert sent["headers"]["authorization"] == "Token dg-key"


@pytest.mark.asyncio
async def test_deepgram_language_override_wins(mock_provider, client, audio):
    mock_provider.body = DEEPGRAM_OK
    adapter = DeepgramAdapter(client)
    await adapter.transcribe(
        deepgram_config(mock_provider.base_url, language="ru"), audio, {"language": "en"}
    )
    languages = [v for k, v in mock_provider.requests[0]["query_pairs"] if k == "language"]
    assert languages == ["en"], "язык сообщения должен перекрывать настройку"


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (401, STT_AUTH_FAILED),
        (403, STT_AUTH_FAILED),
        (404, STT_MODEL_NOT_FOUND),
        (429, STT_RATE_LIMITED),
        (500, STT_PROVIDER_UNAVAILABLE),
        (503, STT_PROVIDER_UNAVAILABLE),
    ],
)
@pytest.mark.asyncio
async def test_deepgram_error_codes(mock_provider, client, audio, status, expected):
    mock_provider.status = status
    mock_provider.body = {"err_msg": "нечто своё"}
    adapter = DeepgramAdapter(client)

    with pytest.raises(SttError) as caught:
        await adapter.transcribe(deepgram_config(mock_provider.base_url), audio, {})
    assert caught.value.code == expected
    # Текст провайдера не должен просачиваться в сообщение.
    assert "нечто своё" not in caught.value.message


@pytest.mark.asyncio
async def test_deepgram_timeout(mock_provider, client, audio):
    mock_provider.delay = 1.5
    adapter = DeepgramAdapter(client)
    config = deepgram_config(mock_provider.base_url)
    config.timeout_ms = 300

    with pytest.raises(SttError) as caught:
        await adapter.transcribe(config, audio, {})
    assert caught.value.code == STT_TIMEOUT
    assert caught.value.retryable is True


@pytest.mark.asyncio
async def test_deepgram_broken_json(mock_provider, client, audio):
    mock_provider.raw_body = b"<html>gateway</html>"
    adapter = DeepgramAdapter(client)
    with pytest.raises(SttError) as caught:
        await adapter.transcribe(deepgram_config(mock_provider.base_url), audio, {})
    assert caught.value.code == STT_TRANSCRIPTION_FAILED


@pytest.mark.asyncio
async def test_deepgram_empty_result_is_not_an_error(mock_provider, client, audio):
    """Тишина в записи — успех с пустым текстом, а не сбой."""
    mock_provider.body = {"results": {"channels": [{"alternatives": [{"transcript": ""}]}]}}
    adapter = DeepgramAdapter(client)
    result = await adapter.transcribe(deepgram_config(mock_provider.base_url), audio, {})
    assert result.text == ""
    assert result.confidence is None


def test_deepgram_rejects_keyterm_on_wrong_model(client):
    adapter = DeepgramAdapter(client)
    config = deepgram_config("https://api.deepgram.com/v1/listen", keyterms=["Ева"])
    config.model = "nova-2"
    verdict = adapter.validate(config)
    assert not verdict.ok
    assert any("nova-3" in error for error in verdict.errors)


def test_deepgram_rejects_keyterm_with_multi_language(client):
    """Пара keyterm + language=multi возвращает 400 — ловим до отправки."""
    adapter = DeepgramAdapter(client)
    config = deepgram_config(
        "https://api.deepgram.com/v1/listen", keyterms=["Ева"], language="multi"
    )
    verdict = adapter.validate(config)
    assert not verdict.ok
    assert any("multi" in error for error in verdict.errors)


def test_deepgram_rejects_unknown_parameter(client):
    adapter = DeepgramAdapter(client)
    verdict = adapter.validate(
        deepgram_config("https://api.deepgram.com/v1/listen", magic_boost=True)
    )
    assert not verdict.ok
    assert any("magic_boost" in error for error in verdict.errors)


def test_deepgram_streaming_requires_wss(client):
    adapter = DeepgramAdapter(client)
    config = deepgram_config("https://api.deepgram.com/v1/listen")
    config.mode = "streaming"
    verdict = adapter.validate(config)
    assert not verdict.ok
    assert any("wss" in error for error in verdict.errors)


def test_deepgram_endpointing_only_in_streaming(client):
    adapter = DeepgramAdapter(client)
    verdict = adapter.validate(
        deepgram_config("https://api.deepgram.com/v1/listen", endpointing_ms=300)
    )
    assert not verdict.ok, "endpointing не имеет смысла в пакетном режиме"


# =====================================================================
# OpenAI / OpenRouter
# =====================================================================
@pytest.mark.asyncio
async def test_openai_success(mock_provider, client, audio):
    mock_provider.body = {
        "text": "Проверка синтеза и распознавания.",
        "language": "russian",
        "duration": 3.1,
        "segments": [{"text": "Проверка синтеза и распознавания.", "start": 0.0, "end": 3.1}],
    }
    adapter = OpenAiCompatibleAdapter(client, "openai", OPENAI_SCHEMA)

    result = await adapter.transcribe(
        openai_config(mock_provider.base_url, language="ru", prompt="Ева"), audio, {}
    )

    assert result.text == "Проверка синтеза и распознавания."
    assert result.provider == "openai"
    assert result.duration_ms == 3100
    # Ни OpenAI, ни OpenRouter не возвращают уверенность — поле должно
    # отсутствовать, а не быть выдуманным.
    assert result.confidence is None
    assert result.segments[0].end_ms == 3100

    body = mock_provider.requests[0]["body"]
    assert b'name="model"' in body and b"whisper-1" in body
    assert b'name="prompt"' in body and "Ева".encode() in body
    assert mock_provider.requests[0]["headers"]["authorization"] == "Bearer sk-test"


@pytest.mark.asyncio
async def test_openai_text_format_is_not_json(mock_provider, client, audio):
    mock_provider.raw_body = "Просто текст без JSON.".encode()
    adapter = OpenAiCompatibleAdapter(client, "openai", OPENAI_SCHEMA)
    result = await adapter.transcribe(
        openai_config(mock_provider.base_url, response_format="text"), audio, {}
    )
    assert result.text == "Просто текст без JSON."


def test_openai_timestamps_require_verbose_json(client):
    adapter = OpenAiCompatibleAdapter(client, "openai", OPENAI_SCHEMA)
    verdict = adapter.validate(openai_config(
        "https://api.openai.com/v1",
        response_format="json",
        timestamp_granularities=["word"],
    ))
    assert not verdict.ok
    assert any("verbose_json" in error for error in verdict.errors)


def test_openai_streaming_is_refused(client):
    """streaming не обещаем: у OpenAI это отдельный realtime-API."""
    adapter = OpenAiCompatibleAdapter(client, "openai", OPENAI_SCHEMA)
    config = openai_config("https://api.openai.com/v1")
    config.mode = "streaming"
    verdict = adapter.validate(config)
    assert not verdict.ok
    assert adapter.capabilities().streaming is False


@pytest.mark.asyncio
async def test_openrouter_routing_options(mock_provider, client, audio):
    mock_provider.body = {
        "text": "Ответ через OpenRouter.",
        "model": "openai/whisper-1",
        "id": "gen-abc123",
        "provider": "Together",
    }
    adapter = OpenAiCompatibleAdapter(client, "openrouter", OPENROUTER_SCHEMA)
    config = SttResolvedConfig(
        config_id="cfg-or", name="OpenRouter", provider="openrouter", mode="batch",
        base_url=mock_provider.base_url, model="openai/whisper-1",
        params={
            "provider_order": ["Together", "DeepInfra"],
            "require_parameters": True,
            "data_collection": "deny",
            "zero_data_retention": True,
            "provider_options": {"allow_fallbacks": False},
        },
        secret="or-key", timeout_ms=5000,
    )

    result = await adapter.transcribe(config, audio, {})

    # Фактически отработавший upstream важнее строки «модель»: счёт и
    # качество зависят от него.
    assert result.upstream_provider == "Together"
    assert result.provider_request_id == "gen-abc123"

    body = mock_provider.requests[0]["body"].decode("utf-8", "replace")
    marker = 'name="provider"'
    routing = json.loads(body.split(marker, 1)[1].split("\r\n\r\n", 1)[1].split("\r\n", 1)[0])
    assert routing["order"] == ["Together", "DeepInfra"]
    assert routing["require_parameters"] is True
    assert routing["data_collection"] == "deny"
    assert routing["zdr"] is True
    assert routing["allow_fallbacks"] is False


def test_openrouter_provider_options_must_be_object(client):
    adapter = OpenAiCompatibleAdapter(client, "openrouter", OPENROUTER_SCHEMA)
    config = SttResolvedConfig(
        config_id="cfg-or", name="OpenRouter", provider="openrouter", mode="batch",
        base_url="https://openrouter.ai/api/v1", model="openai/whisper-1",
        params={"provider_options": "[1,2,3]"}, secret="or-key",
    )
    verdict = adapter.validate(config)
    assert not verdict.ok


def test_openrouter_unknown_parameter_is_not_forwarded(client):
    adapter = OpenAiCompatibleAdapter(client, "openrouter", OPENROUTER_SCHEMA)
    config = SttResolvedConfig(
        config_id="cfg-or", name="OpenRouter", provider="openrouter", mode="batch",
        base_url="https://openrouter.ai/api/v1", model="openai/whisper-1",
        params={"secret_flag": True}, secret="or-key",
    )
    verdict = adapter.validate(config)
    assert not verdict.ok
    assert any("secret_flag" in error for error in verdict.errors)


# =====================================================================
# Google
# =====================================================================
def test_google_metadata_never_exposes_private_key():
    credentials = {
        "type": "service_account",
        "project_id": "eva-prod",
        "private_key_id": "abc123",
        "private_key": "-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n",
        "client_email": "evaself-stt@eva-prod.iam.gserviceaccount.com",
        "token_uri": "https://oauth2.googleapis.com/token",
    }
    meta = public_metadata(credentials)

    serialized = json.dumps(meta)
    assert "SECRET" not in serialized
    assert "private_key" not in serialized
    assert "abc123" not in serialized
    assert meta["project_id"] == "eva-prod"
    # Полный адрес сервисного аккаунта — подсказка атакующему.
    assert meta["client_email_masked"] == "eva***@eva-prod.iam.gserviceaccount.com"


@pytest.mark.asyncio
async def test_google_rejects_incomplete_credentials(client, audio):
    adapter = GoogleSttAdapter(client)
    config = SttResolvedConfig(
        config_id="cfg-g", name="Google", provider="google", mode="batch",
        base_url="https://speech.googleapis.com", model="chirp_2",
        params={"location": "us-central1"},
        secret=json.dumps({"type": "service_account", "project_id": "eva"}),
    )
    with pytest.raises(SttError) as caught:
        await adapter.transcribe(config, audio, {})
    assert caught.value.code == "stt_config_invalid"
    assert "private_key" in caught.value.message


@pytest.mark.asyncio
async def test_google_missing_secret(client, audio):
    adapter = GoogleSttAdapter(client)
    config = SttResolvedConfig(
        config_id="cfg-g", name="Google", provider="google", mode="batch",
        base_url="https://speech.googleapis.com", model="chirp_2", params={}, secret="",
    )
    with pytest.raises(SttError) as caught:
        await adapter.transcribe(config, audio, {})
    assert caught.value.code == "stt_secret_missing"
    assert caught.value.retryable is False


def test_google_chirp_needs_regional_endpoint(client):
    adapter = GoogleSttAdapter(client)
    config = SttResolvedConfig(
        config_id="cfg-g", name="Google", provider="google", mode="batch",
        base_url="https://speech.googleapis.com", model="chirp_2",
        params={"location": "global"}, secret="{}",
    )
    verdict = adapter.validate(config)
    assert not verdict.ok
    assert any("global" in error for error in verdict.errors)


def test_google_v2_endpoint_shape(client):
    """v2 адресует запрос через recognizer, а не через speech:recognize."""
    adapter = GoogleSttAdapter(client)
    config = SttResolvedConfig(
        config_id="cfg-g", name="Google", provider="google", mode="batch",
        base_url="https://speech.googleapis.com", model="chirp_2",
        params={"location": "europe-west4", "recognizer": "_"}, secret="{}",
    )
    url = adapter._endpoint(config, "eva-prod")
    assert url == (
        "https://europe-west4-speech.googleapis.com/v2"
        "/projects/eva-prod/locations/europe-west4/recognizers/_:recognize"
    )


def test_google_normalizes_v2_response(client):
    adapter = GoogleSttAdapter(client)
    config = SttResolvedConfig(
        config_id="cfg-g", name="Google", provider="google", mode="batch",
        base_url="https://speech.googleapis.com", model="chirp_2", params={}, secret="{}",
    )
    payload = {
        "results": [
            {
                "alternatives": [{
                    "transcript": "Первая часть",
                    "confidence": 0.9,
                    "words": [
                        {"word": "Первая", "startOffset": "0.100s", "endOffset": "0.700s",
                         "confidence": 0.93},
                    ],
                }],
                "languageCode": "ru-RU",
            },
            {
                "alternatives": [{"transcript": "вторая часть", "confidence": 0.8}],
                "languageCode": "ru-RU",
            },
        ],
        "metadata": {"totalBilledDuration": "4.500s"},
    }
    result = adapter._normalize(payload, config, 321, None, "")

    assert result.text == "Первая часть вторая часть"
    assert result.language == "ru-RU"
    assert result.duration_ms == 4500
    assert result.confidence == pytest.approx(0.85)
    assert result.words[0].start_ms == 100
    assert len(result.segments) == 2


def test_google_zero_confidence_is_not_reported(client):
    """confidence=0.0 у Google означает «не считалось», а не «нулевая»."""
    adapter = GoogleSttAdapter(client)
    config = SttResolvedConfig(
        config_id="cfg-g", name="Google", provider="google", mode="batch",
        base_url="https://speech.googleapis.com", model="long", params={}, secret="{}",
    )
    payload = {"results": [{"alternatives": [{"transcript": "текст", "confidence": 0.0}]}]}
    result = adapter._normalize(payload, config, 100, None, "")
    assert result.confidence is None
