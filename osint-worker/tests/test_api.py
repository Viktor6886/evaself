import importlib

import pytest
from fastapi.testclient import TestClient


def _app(monkeypatch, token="secret", env="development"):
    monkeypatch.setenv("OSINT_WORKER_TOKEN", token)
    monkeypatch.setenv("EVA_ENV", env)
    import app.main as main

    return importlib.reload(main)


def test_production_refuses_to_start_without_token(monkeypatch):
    main = _app(monkeypatch)
    monkeypatch.setenv("OSINT_WORKER_TOKEN", "  ")
    monkeypatch.setenv("EVA_ENV", "production")
    with pytest.raises(RuntimeError, match="OSINT_WORKER_TOKEN"):
        importlib.reload(main)
    monkeypatch.setenv("EVA_ENV", "development")
    importlib.reload(main)


def test_requests_without_key_are_rejected(monkeypatch):
    main = _app(monkeypatch)
    with TestClient(main.app) as client:
        response = client.post("/v1/username/verify", json={"username": "alice", "hosts": ["codehub.example"]})
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"
        assert client.get("/health").status_code == 200


def test_malformed_username_is_rejected_before_any_request(monkeypatch):
    main = _app(monkeypatch)
    with TestClient(main.app) as client:
        response = client.post(
            "/v1/username/scan",
            json={"username": "../../etc"},
            headers={"X-Osint-Key": "secret"},
        )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_username"


def test_compare_endpoint_returns_features(monkeypatch):
    main = _app(monkeypatch)
    with TestClient(main.app) as client:
        response = client.post(
            "/v1/match/compare",
            json={
                "left": {"schema": "Person", "properties": {"name": ["Ivan Ivanov"]}},
                "right": {"schema": "Person", "properties": {"name": ["Иван Иванов"]}},
            },
            headers={"X-Osint-Key": "secret"},
        )
        bad = client.post(
            "/v1/match/compare",
            json={"left": {"schema": "Vessel"}, "right": {"schema": "Person"}},
            headers={"X-Osint-Key": "secret"},
        )
    assert response.status_code == 200
    assert any(feature["name"] == "name_match" for feature in response.json()["features"])
    assert bad.status_code == 400
