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


def test_infra_endpoints_refuse_private_targets(monkeypatch):
    main = _app(monkeypatch)
    with TestClient(main.app) as client:
        response = client.post(
            "/v1/infra/rdap",
            json={"kind": "ip", "value": "10.0.0.1"},
            headers={"X-Osint-Key": "secret"},
        )
        unauthorized = client.post("/v1/infra/dns", json={"domain": "example.com"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_target"
    assert unauthorized.status_code == 401


def test_registry_endpoint_validates_before_any_request(monkeypatch):
    main = _app(monkeypatch)
    with TestClient(main.app) as client:
        bad_checksum = client.post(
            "/v1/registry/egrul",
            json={"kind": "tax_id", "value": "7707083894"},
            headers={"X-Osint-Key": "secret"},
        )
        person_name = client.post(
            "/v1/registry/egrul",
            json={"kind": "name", "value": "Иванов Иван"},
            headers={"X-Osint-Key": "secret"},
        )
        unauthorized = client.post("/v1/registry/egrul", json={"kind": "tax_id", "value": "7707083893"})
    assert bad_checksum.status_code == 400
    assert bad_checksum.json()["error"]["code"] == "invalid_target"
    # Поиск ИП по ФИО не поддерживается: однофамильцы — не след.
    assert person_name.status_code == 422
    assert unauthorized.status_code == 401


@pytest.mark.parametrize("failure", [TimeoutError(), RuntimeError("private username")])
def test_scan_preserves_independent_findings_when_maigret_fails(monkeypatch, failure):
    from app.site_rules import Verification

    main = _app(monkeypatch)

    async def broken(*args, **kwargs):
        raise failure

    async def discover(username, limit, deadline):
        assert limit == 10
        return [Verification("sherlock", "GitHub", "https://github.com/alice", "found")], 1

    monkeypatch.setattr(main, "scan_username", broken)
    with TestClient(main.app) as client:
        monkeypatch.setattr(main.state.verifier, "discover", discover)
        response = client.post(
            "/v1/username/scan",
            json={"username": "alice", "top_sites": 20, "rule_requests": 10},
            headers={"X-Osint-Key": "secret"},
        )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "degraded"
    assert data["checked"] == 20
    assert data["verification_requests"] == 1
    assert data["verifications"][0]["status"] == "found"
    assert "private username" not in response.text


def test_scan_rejects_unbounded_independent_requests(monkeypatch):
    main = _app(monkeypatch)
    with TestClient(main.app) as client:
        response = client.post(
            "/v1/username/scan", json={"username": "alice", "rule_requests": 101}, headers={"X-Osint-Key": "secret"}
        )
    assert response.status_code == 422


def test_scan_preserves_maigret_findings_when_independent_rules_fail(monkeypatch):
    from app.maigret_scan import FoundProfile, ScanResult

    main = _app(monkeypatch)

    async def found(*args, **kwargs):
        return ScanResult("alice", "ok", 10, [FoundProfile("GitHub", "https://github.com/alice", [], 200)], {})

    async def broken(*args, **kwargs):
        raise RuntimeError("private username")

    monkeypatch.setattr(main, "scan_username", found)
    with TestClient(main.app) as client:
        monkeypatch.setattr(main.state.verifier, "discover", broken)
        response = client.post(
            "/v1/username/scan",
            json={"username": "alice", "top_sites": 10, "rule_requests": 5},
            headers={"X-Osint-Key": "secret"},
        )
    data = response.json()
    assert data["status"] == "degraded"
    assert data["found"][0]["url"] == "https://github.com/alice"
    assert data["verification_requests"] == 5
    assert data["degraded"] == {"unavailable": 1}
    assert "private username" not in response.text
