import asyncio
from types import SimpleNamespace

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
    assert db.calls[0]["disabled"] is False
    assert set(db.calls[0]["excluded_tags"]) == set(EXCLUDED_TAGS)
    assert {"dating", "geosocial", "medicine"} <= set(EXCLUDED_TAGS)


async def test_scan_is_bounded_by_deadline():
    async def slow_search(**kwargs):
        await asyncio.sleep(10)

    result = await scan_username(
        "alice", top_sites=10, site_timeout=1, deadline=0.01, max_connections=1, search=slow_search, database=_Db()
    )
    assert result.status == "degraded"
    assert result.degraded == {"timeout": 1}
    assert result.checked == 1


async def test_timeout_keeps_completed_profiles_and_limits_upstream_mirrors():
    class Db:
        def ranked_sites_dict(self, **kwargs):
            return {f"Site{i}": object() for i in range(25)}

    async def partial_search(**kwargs):
        assert len(kwargs["site_dict"]) == 10
        kwargs["output_container"]["GitHub"] = {
            "status": _check("Claimed"),
            "url_user": "https://github.com/alice",
        }
        await asyncio.Event().wait()

    result = await scan_username(
        "alice",
        top_sites=10,
        site_timeout=1,
        deadline=0.01,
        max_connections=1,
        search=partial_search,
        database=Db(),
    )
    assert result.checked == 10
    assert [profile.url for profile in result.found] == ["https://github.com/alice"]
    assert result.degraded == {"timeout": 1}


async def test_bundled_maigret_database_and_installed_api_contract():
    import inspect

    from maigret import search

    async def check(**kwargs):
        inspect.signature(search).bind(**kwargs)
        assert len(kwargs["site_dict"]) <= 100
        assert not any(site.disabled for site in kwargs["site_dict"].values())
        assert "output_container" in inspect.signature(search).parameters
        return {}

    await scan_username("example", top_sites=100, site_timeout=1, deadline=5, max_connections=1, search=check)
