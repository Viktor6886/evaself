import pytest
from fastapi.testclient import TestClient

import app.main as main

OUTPUT = "\n".join(
    [
        '[{"type": "Internet Name", "data": "example.com", "module": "SpiderFoot UI", "source": "example.com"},',
        '{"type": "IP Address", "data": "93.184.216.34", "module": "sfp_dnsresolve", "source": "example.com"},',
        '{"type": "IP Address", "data": "10.1.2.3", "module": "sfp_dnsresolve", "source": "example.com"},',
        '{"type": "Internet Name", "data": "www.example.com", "module": "sfp_crt", "source": "example.com"},',
        '{"type": "Human Name", "data": "Ivan Petrov", "module": "sfp_arin", "source": "example.com"},',
        '{"type": "Physical Address", "data": "Lenina 1, Moscow", "module": "sfp_arin", "source": "example.com"},',
        '{"type": "Raw Data from RIRs/APIs", "data": "{person: ...}", "module": "sfp_ripe", "source": "example.com"},',
        '{"type": "Blacklisted IP Address", "data": "blocklist.de [93.184.216.34]", "module": "sfp_blocklistde", "source": "x"},',
        '{"type": "BGP AS Membership", "data": "15133", "module": "sfp_bgpview", "source": "x"},',
        '{"type": "Leak Site Content", "data": "dump", "module": "sfp_psbdmp", "source": "x"},',
        '{"type": "Co-Hosted Site", "data": "unrelated-shop.org", "module": "sfp_robtex", "source": "x"},',
        '{"type": "Company Name", "data": "Example Inc", "module": "sfp_gleif", "source": "x"}',
    ]
)


@pytest.fixture
def client(monkeypatch):
    calls = []

    async def fake(target, home):
        calls.append((target, home))
        return OUTPUT, True

    monkeypatch.setattr(main, "run_spiderfoot", fake)
    with TestClient(main.app) as test_client:
        test_client.calls = calls
        yield test_client


def test_only_infrastructure_events_leave_the_container(client):
    body = client.post("/v1/scan", json={"kind": "domain", "target": "Example.com"}).json()
    assert client.calls[0][0] == "example.com"
    assert body["ips"] == ["93.184.216.34"]
    assert body["hosts"] == ["www.example.com"]
    # Сайт на общем хостинге — отдельно, не среди хостов домена.
    assert body["cohosts"] == ["unrelated-shop.org"]
    assert body["asns"] == ["15133"]
    assert body["organizations"] == ["Example Inc"]
    assert body["reputation"][0]["module"] == "sfp_blocklistde"
    text = str(body)
    for forbidden in ("Ivan Petrov", "Lenina", "person", "dump"):
        assert forbidden not in text


def test_scan_home_is_removed_after_the_request(client, tmp_path):
    client.post("/v1/scan", json={"kind": "domain", "target": "example.com"})
    import os

    assert not os.path.exists(client.calls[0][1])


def test_the_command_enables_only_allowlisted_modules():
    command = main.command("example.com")
    modules = command[command.index("-m") + 1].split(",")
    assert modules == list(main.ALLOWED_MODULES)
    assert "-u" not in command and "-x" not in command
    forbidden = {
        "sfp_psbdmp",
        "sfp_scylla",
        "sfp_wikileaks",
        "sfp_haveibeenpwned",
        "sfp_whois",
        "sfp_pgp",
        "sfp_keybase",
        "sfp_accounts",
        "sfp_ipapico",
        "sfp_openstreetmap",
        "sfp_names",
        "sfp_phone",
    }
    assert not forbidden & set(modules)


def test_partial_output_after_deadline_is_still_parsed():
    partial = '[{"type": "IP Address", "data": "8.8.8.8", "module": "sfp_dnsresolve", "source": "x"},\n{"type": "IP Ad'
    events = main.parse_events(partial)
    assert [event["data"] for event in events] == ["8.8.8.8"]


@pytest.mark.parametrize(
    "payload",
    [
        {"kind": "ip", "target": "10.0.0.1"},
        {"kind": "ip", "target": "127.0.0.1"},
        {"kind": "domain", "target": "localhost"},
        {"kind": "domain", "target": "osint-worker"},
    ],
)
def test_private_and_internal_targets_are_refused(client, payload):
    response = client.post("/v1/scan", json=payload)
    assert response.status_code == 400
    assert client.calls == []


def test_missing_key_is_refused(client, monkeypatch):
    monkeypatch.setattr(main, "SERVICE_TOKEN", "secret")
    assert client.post("/v1/scan", json={"kind": "domain", "target": "example.com"}).status_code == 401
