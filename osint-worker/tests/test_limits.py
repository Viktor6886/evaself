import pytest

from app.limits import CircuitBreaker, classify_failure


def test_breaker_opens_after_threshold_and_closes_after_cooldown():
    now = [0.0]
    breaker = CircuitBreaker(threshold=2, cooldown_seconds=60, clock=lambda: now[0])
    breaker.record("site.example", "rate_limited")
    assert breaker.blocked("site.example") is None
    breaker.record("site.example", "rate_limited")
    # Источник, который просит остановиться, не долбится дальше.
    assert breaker.blocked("site.example") == "rate_limited"
    now[0] = 61
    assert breaker.blocked("site.example") is None


def test_success_resets_failures():
    breaker = CircuitBreaker(threshold=2)
    breaker.record("a.example", "timeout")
    breaker.record("a.example", None)
    breaker.record("a.example", "timeout")
    assert breaker.blocked("a.example") is None


@pytest.mark.parametrize(
    ("status", "text", "error", "expected"),
    [
        (429, "", "", "rate_limited"),
        (200, "<title>Just a moment...</title>", "", "captcha"),
        (403, "Attention Required! | Cloudflare", "", "captcha"),
        (None, "", "Request timeout", "timeout"),
        (503, "", "", "unavailable"),
        (200, "profile page", "", None),
        (404, "not found", "", None),
    ],
)
def test_failure_classification(status, text, error, expected):
    assert classify_failure(status, text, error) == expected
