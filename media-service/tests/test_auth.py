"""The media service holds the bot token and the paid ASR/TTS keys.

It is not routed by Caddy, but "not routed" is not "not reachable": any
container on the compose network can address it. These tests pin the
shared-secret gate, including the compatibility case where an installation
upgraded without setting a token yet.
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


def _client(monkeypatch, token: str):
    """Reload the module so the module-level token is re-read."""
    monkeypatch.setenv("MEDIA_SERVICE_TOKEN", token)
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


def test_an_unset_token_keeps_an_upgraded_installation_working(monkeypatch):
    main, client = _client(monkeypatch, "")
    with client:
        assert client.get("/health").json()["auth_required"] is False
        # No token configured means no gate — eva-agent-service warns at boot.
        response = client.post("/tts", json={"text": "привет"})
    assert response.status_code == 503
    importlib.reload(main)
