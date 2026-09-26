import pytest
from fastapi.testclient import TestClient

import app.main as main

RAW = (
    ["AS13335", "junk"],
    [],
    [],
    [],
    [],
    [],
    ["93.184.216.34", "10.0.0.1", "not-an-ip"],
    ["info@example.com", "ceo@other.org", "hr@mail.example.com"],
    ["www.example.com:93.184.216.34", "evil.org", "example.com.attacker.net", "api.example.com"],
)


@pytest.fixture
def client(monkeypatch):
    calls = []

    async def fake(arguments):
        calls.append(arguments)
        print("found info@example.com")  # вывод theHarvester не должен уйти в журнал
        return RAW

    monkeypatch.setattr(main, "run_harvester", fake)
    with TestClient(main.app) as test_client:
        test_client.calls = calls
        yield test_client


def test_only_passive_arguments_are_ever_passed(client, capsys):
    response = client.post("/v1/domain/harvest", json={"domain": "Example.com"})
    assert response.status_code == 200
    arguments = client.calls[0]
    assert arguments.domain == "example.com"
    assert not arguments.dns_brute and not arguments.take_over and not arguments.api_scan
    assert not arguments.shodan and not arguments.proxies and not arguments.filename and not arguments.screenshot
    assert set(arguments.source.split(",")) <= set(main.ALLOWED_SOURCES)
    assert "info@example.com" not in capsys.readouterr().out


def test_results_are_scoped_to_the_domain(client):
    body = client.post("/v1/domain/harvest", json={"domain": "example.com"}).json()
    assert body["hosts"] == ["api.example.com", "www.example.com"]
    assert body["ips"] == ["93.184.216.34"]
    assert body["emails"] == ["hr@mail.example.com", "info@example.com"]
    assert body["asns"] == ["AS13335"]


@pytest.mark.parametrize(
    "source", ["haveibeenpwned", "dehashed", "leakix", "intelx", "linkedin", "hunter", "duckduckgo"]
)
def test_leak_people_and_search_engine_sources_are_refused(client, source):
    response = client.post("/v1/domain/harvest", json={"domain": "example.com", "sources": [source]})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "source_not_allowed"
    assert client.calls == []


def test_harvester_exit_is_degradation_not_a_crash(client, monkeypatch):
    async def exiting(_arguments):
        raise SystemExit(1)

    monkeypatch.setattr(main, "run_harvester", exiting)
    body = client.post("/v1/domain/harvest", json={"domain": "example.com"}).json()
    assert body["status"] == "degraded" and body["hosts"] == []


def test_bad_domain_and_missing_key(client, monkeypatch):
    assert client.post("/v1/domain/harvest", json={"domain": "localhost"}).status_code == 400
    monkeypatch.setattr(main, "SERVICE_TOKEN", "secret")
    assert client.post("/v1/domain/harvest", json={"domain": "example.com"}).status_code == 401
