import asyncio
from types import SimpleNamespace

import pytest

from app.maigret_scan import EXCLUDED_TAGS, parse_results, scan_username


def _check(status, ids=None, error=None):
    return SimpleNamespace(status=SimpleNamespace(value=status), ids_data=ids or {}, error=error)


def test_parse_results_keeps_public_profile_data_and_discovered_identifiers():
    results = {
        "GitHub": {
            "status": _check("Claimed", {"fullname": "Alice A.", "links": ["x"]}),
            "site": SimpleNamespace(tags=["coding"]),
            "url_user": "https://github.com/alice",
            "http_status": 200,
            "ids_usernames": {"alice": "username", "alice_dev": "username"},
            "ids_links": ["https://alice.example"],
        },
        "Forum": {"status": _check("Available"), "url_user": "https://forum.example/alice"},
        "Slow": {"status": _check("Unknown", error=SimpleNamespace(type="Request timeout", desc=""))},
        "Guarded": {"status": _check("Unknown", error=SimpleNamespace(type="Captcha", desc="Cloudflare"))},
    }
    result = parse_results("alice", results)
    assert result.checked == 4
    assert [profile.site for profile in result.found] == ["GitHub"]
    profile = result.found[0]
    # Сам искомый username в «найденные» не попадает.
    assert profile.discovered_usernames == ["alice_dev"]
    assert profile.discovered_links == ["https://alice.example"]
    assert profile.ids == {"fullname": "Alice A."}
    # Капча и таймаут — деградация, а не «аккаунта нет».
    assert result.status == "degraded"
    assert result.degraded == {"timeout": 1, "captcha": 1}


class _Db:
    def __init__(self):
        self.calls = []

    def ranked_sites_dict(self, **kwargs):
        self.calls.append(kwargs)
        return {"GitHub": object()}


async def test_scan_never_enables_protection_bypass_and_excludes_sensitive_tags():
    captured = {}

    async def fake_search(**kwargs):
        captured.update(kwargs)
        return {}

    db = _Db()
    result = await scan_username(
        "alice", top_sites=50, site_timeout=3, deadline=5, max_connections=4, search=fake_search, database=db
    )
    assert result.status == "ok"
    assert captured["cloudflare_bypass"] is None
    assert captured["proxy"] is None and captured["tor_proxy"] is None
    assert db.calls[0]["top"] == 50
    assert set(db.calls[0]["excluded_tags"]) == set(EXCLUDED_TAGS)
    assert {"dating", "geosocial", "medicine"} <= set(EXCLUDED_TAGS)


async def test_scan_is_bounded_by_deadline():
    async def slow_search(**kwargs):
        await asyncio.sleep(10)

    with pytest.raises(TimeoutError):
        await scan_username(
            "alice", top_sites=10, site_timeout=1, deadline=0.05, max_connections=1, search=slow_search, database=_Db()
        )
