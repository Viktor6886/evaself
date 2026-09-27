import httpx
import pytest

from app.limits import CircuitBreaker
from app.netguard import FetchResult
from app.site_rules import ProfileVerifier, SiteRule, evaluate, load_sherlock, load_whatsmyname
from tests.conftest import public_resolver


def test_whatsmyname_skips_protected_invalid_and_sensitive_categories(fixtures):
    rules = load_whatsmyname(fixtures / "wmn-mini.json")
    # Знакомства — особая категория данных; защищённый сайт не обходится.
    assert [rule.name for rule in rules] == ["CodeHub"]
    assert rules[0].host == "codehub.example"


def test_sherlock_rules_are_loaded_with_their_detection_type(fixtures):
    rules = {rule.name: rule for rule in load_sherlock(fixtures / "sherlock-mini.json")}
    assert set(rules) == {"CodeHub", "Forum", "Redirector"}
    assert rules["Forum"].error_type == "message"
    assert rules["Forum"].username_for("Bad Name!") is None
    assert rules["Forum"].username_for("alice") == "alice"


def _result(status, text="", redirects=0):
    return FetchResult("https://x.example/a", "https://x.example/a", status, text, redirects)


def test_evaluation_follows_the_rule_not_a_guess(fixtures):
    wmn = load_whatsmyname(fixtures / "wmn-mini.json")[0]
    assert evaluate(wmn, _result(200, '{"login": "alice"}')) == "found"
    assert evaluate(wmn, _result(404, "Not Found")) == "not_found"
    # 200 без ожидаемой строки — не находка, а «неизвестно».
    assert evaluate(wmn, _result(200, "<html>maintenance</html>")) == "unknown"

    rules = {rule.name: rule for rule in load_sherlock(fixtures / "sherlock-mini.json")}
    assert evaluate(rules["CodeHub"], _result(200)) == "found"
    assert evaluate(rules["CodeHub"], _result(404)) == "not_found"
    assert evaluate(rules["Forum"], _result(200, "User not found")) == "not_found"
    assert evaluate(rules["Forum"], _result(200, "alice's page")) == "found"
    assert evaluate(rules["Redirector"], _result(200, redirects=1)) == "not_found"
    assert evaluate(rules["Redirector"], _result(200)) == "found"


def _verifier(fixtures, handler, breaker=None):
    rules = load_whatsmyname(fixtures / "wmn-mini.json") + load_sherlock(fixtures / "sherlock-mini.json")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ProfileVerifier(rules, client=client, resolver=public_resolver, breaker=breaker), client


async def test_verifier_confirms_found_profile_with_both_sources(fixtures):
    def handler(request):
        if request.url.path.startswith("/api/users/alice"):
            return httpx.Response(200, text='{"login": "alice"}')
        if request.url.path == "/alice":
            return httpx.Response(200, text="profile")
        return httpx.Response(404, text="Not Found")

    verifier, client = _verifier(fixtures, handler)
    async with client:
        results = await verifier.verify("alice", {"codehub.example"}, {"whatsmyname", "sherlock"})
    assert sorted((r.source, r.status) for r in results) == [("sherlock", "found"), ("whatsmyname", "found")]
    assert all(r.profile_url == "https://codehub.example/alice" for r in results)


async def test_rate_limited_site_degrades_and_trips_the_breaker(fixtures):
    calls = []

    def handler(request):
        calls.append(request.url.host)
        return httpx.Response(429, text="Too Many Requests")

    breaker = CircuitBreaker(threshold=1, cooldown_seconds=600)
    verifier, client = _verifier(fixtures, handler, breaker)
    async with client:
        first = await verifier.verify("alice", {"codehub.example"}, {"whatsmyname"})
        second = await verifier.verify("alice", {"codehub.example"}, {"whatsmyname"})
    assert first[0].status == "degraded" and first[0].reason == "rate_limited"
    # Второй раз сайт не запрашивается вовсе: выключатель открыт.
    assert second[0].status == "degraded" and len(calls) == 1


async def test_redirect_into_internal_network_is_skipped(fixtures):
    def handler(request):
        return httpx.Response(302, headers={"location": "http://internal.admin/"})

    verifier, client = _verifier(fixtures, handler)
    async with client:
        results = await verifier.verify("alice", {"codehub.example"}, {"whatsmyname"})
    assert results[0].status == "skipped" and results[0].reason == "unsafe_target"


async def test_username_not_allowed_by_site_is_skipped(fixtures):
    verifier, client = _verifier(fixtures, lambda request: httpx.Response(200))
    async with client:
        results = await verifier.verify("a_very_long_name_x", {"forum.example"}, {"sherlock"})
    assert results[0].status == "skipped"


@pytest.mark.parametrize("hosts", [{"www.codehub.example"}, {"CODEHUB.example"}])
async def test_hosts_are_matched_without_www_and_case(fixtures, hosts):
    verifier, client = _verifier(fixtures, lambda request: httpx.Response(404, text="Not Found"))
    async with client:
        results = await verifier.verify("alice", {h.lower() for h in hosts}, {"whatsmyname"})
    assert [r.status for r in results] == ["not_found"]


async def test_discovery_finds_profiles_without_maigret_and_caps_http_requests():
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, text="profile")

    rules = [
        SiteRule(
            "sherlock",
            f"GitHub{i}",
            "https://github.com/{account}",
            "https://github.com/{account}",
            error_type="status_code",
        )
        for i in range(5)
    ]
    # Этот хост не входит в список публичных площадок независимого поиска.
    rules.append(
        SiteRule(
            "sherlock",
            "Unknown",
            "https://other.example/{account}",
            "https://other.example/{account}",
            error_type="status_code",
        )
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        verifier = ProfileVerifier(rules, client=client, resolver=public_resolver)
        found, requests = await verifier.discover("alice", limit=2, deadline=1)
    assert requests == len(calls) == 2
    assert all(item.status == "found" for item in found)
    assert all(item.profile_url == "https://github.com/alice" for item in found)


async def test_discovery_does_not_follow_redirects_or_claim_login_as_a_profile():
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(302, headers={"location": "https://github.com/login"})

    rule = SiteRule(
        "sherlock", "GitHub", "https://github.com/{account}", "https://github.com/{account}", error_type="status_code"
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        verifier = ProfileVerifier([rule], client=client, resolver=public_resolver)
        results, requests = await verifier.discover("alice", limit=10, deadline=1)
    assert requests == len(calls) == 1
    assert results[0].status == "unknown"


async def test_discovery_deadline_retains_completed_results_and_cancels_pending(monkeypatch):
    import asyncio

    from app.site_rules import Verification

    def rule(name):
        return SiteRule("sherlock", name, "https://github.com/{account}", "https://github.com/{account}")

    cancelled = asyncio.Event()

    async def check(site, username, **kwargs):
        if site.name == "Fast":
            return Verification("sherlock", site.name, "https://github.com/alice", "found")
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async with httpx.AsyncClient() as client:
        verifier = ProfileVerifier([rule("Fast"), rule("Slow")], client=client)
        monkeypatch.setattr(verifier, "_check", check)
        results, requests = await verifier.discover("alice", limit=2, deadline=0.02)
    assert requests == 2
    assert [(item.site, item.status) for item in results] == [("Fast", "found"), ("Slow", "degraded")]
    assert cancelled.is_set()
