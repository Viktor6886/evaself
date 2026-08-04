"""The media service holds the bot token and the paid ASR/TTS keys.

It is not routed by Caddy, but "not routed" is not "not reachable": any
container on the compose network can address it. These tests pin the
shared-secret gate on both sides: в production пустой токен не даёт
сервису стартовать, в разработке прежнее поведение сохраняется.
"""

import importlib

import pytest
from fastapi.testclient import TestClient

PROTECTED = [
    ("post", "/tts", {"json": {"text": "привет"}}),
    ("post", "/telegram/transcribe", {"json": {"file_id": "abc"}}),
    ("post", "/probe", {"files": {"file": ("a.bin", b"x", "application/octet-stream")}}),
    ("post", "/transcribe", {"files": {"file": ("a.bin", b"x", "application/octet-stream")}}),
]


def _client(monkeypatch, token: str, env: str = "development"):
    """Reload the module so the module-level token is re-read."""
    monkeypatch.setenv("MEDIA_SERVICE_TOKEN", token)
    monkeypatch.setenv("EVA_ENV", env)
    import app.main as main

    importlib.reload(main)
    return main, TestClient(main.app)


@pytest.mark.parametrize(("method", "path", "kwargs"), PROTECTED)
def test_protected_routes_reject_a_missing_key(monkeypatch, method, path, kwargs):
    _, client = _client(monkeypatch, "s3cret")
    with client:
        response = getattr(client, method)(path, **kwargs)
    assert response.status_code == 401, path


@pytest.mark.parametrize(("method", "path", "kwargs"), PROTECTED)
def test_protected_routes_reject_a_wrong_key(monkeypatch, method, path, kwargs):
    _, client = _client(monkeypatch, "s3cret")
    with client:
        response = getattr(client, method)(path, headers={"X-Media-Key": "nope"}, **kwargs)
    assert response.status_code == 401, path


def test_the_correct_key_gets_past_the_gate(monkeypatch):
    _, client = _client(monkeypatch, "s3cret")
    with client:
        response = client.post(
            "/tts", json={"text": "привет"}, headers={"X-Media-Key": "s3cret"}
        )
    # Past auth: TTS is simply not configured in the test environment.
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "tts_not_configured"


def test_health_stays_open_for_the_docker_healthcheck(monkeypatch):
    _, client = _client(monkeypatch, "s3cret")
    with client:
        body = client.get("/health").json()
    assert body["status"] in {"ok", "degraded"}
    assert body["auth_required"] is True


def test_an_unset_token_is_still_allowed_in_development(monkeypatch):
    """В разработке поведение прежнее: пустой токен — просто нет шлюза."""
    main, client = _client(monkeypatch, "", env="development")
    with client:
        assert client.get("/health").json()["auth_required"] is False
        response = client.post("/tts", json={"text": "привет"})
    assert response.status_code == 503
    importlib.reload(main)


# ---------------------------------------------------------------------
# production: пустой токен — не «совместимость», а незащищённый сервис
# ---------------------------------------------------------------------
@pytest.mark.parametrize("env", ["production", "staging", "", "чтотоневнятное"])
def test_production_refuses_to_start_without_a_token(monkeypatch, env):
    """Неизвестное и незаданное окружение считаются production."""
    monkeypatch.setenv("MEDIA_SERVICE_TOKEN", "")
    monkeypatch.setenv("EVA_ENV", env)
    import app.main as main

    with pytest.raises(RuntimeError, match="MEDIA_SERVICE_TOKEN"):
        importlib.reload(main)

    # Прерванный reload оставляет модуль на полпути: возвращаем его в
    # рабочее состояние, чтобы порядок тестов ни на что не влиял.
    monkeypatch.setenv("EVA_ENV", "development")
    importlib.reload(main)


def test_production_starts_once_a_token_is_configured(monkeypatch):
    main, client = _client(monkeypatch, "s3cret", env="production")
    with client:
        assert client.get("/health").json()["auth_required"] is True
    importlib.reload(main)


def test_a_whitespace_only_token_counts_as_empty(monkeypatch):
    """Пробелы в .env — распространённая опечатка, и это не секрет."""
    monkeypatch.setenv("MEDIA_SERVICE_TOKEN", "   ")
    monkeypatch.setenv("EVA_ENV", "production")
    import app.main as main

    with pytest.raises(RuntimeError, match="MEDIA_SERVICE_TOKEN"):
        importlib.reload(main)

    monkeypatch.setenv("EVA_ENV", "development")
    importlib.reload(main)
