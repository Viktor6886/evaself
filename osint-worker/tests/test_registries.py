import json
from urllib.parse import parse_qs

import httpx
import pytest

from app.limits import CircuitBreaker
from app.registries import EgrulRegistry, InvalidQuery, normalize_query, parse_row
from tests.conftest import public_resolver

TOKEN = "A1B2C3D4E5F60718293A4B5C6D7E8F90"

ORGANIZATION = {
    "a": "117312, Г.МОСКВА, УЛ. ВАВИЛОВА, Д.19",
    "c": "ПАО СБЕРБАНК",
    "g": "ПРЕЗИДЕНТ, ПРЕДСЕДАТЕЛЬ ПРАВЛЕНИЯ: ГРЕФ ГЕРМАН ОСКАРОВИЧ",
    "i": "7707083893",
    "k": "ul",
    "n": 'ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "СБЕРБАНК РОССИИ"',
    "o": "1027700132195",
    "p": "773601001",
    "r": "16.08.2002",
    "rn": "Г.МОСКВА",
    "t": "SOME-EXTRACT-TOKEN",
}

ENTREPRENEUR = {
    "i": "500100732259",
    "k": "fl",
    "n": "ИВАНОВ ИВАН ИВАНОВИЧ",
    "o": "304500116000157",
    "r": "01.02.2004",
    "e": "15.03.2019",
    "a": "должно быть отброшено",
    "g": "и это тоже",
}


def test_queries_are_validated_by_checksum():
    assert normalize_query("tax_id", " 7707083893 ") == "7707083893"
    assert normalize_query("tax_id", "500100732259") == "500100732259"
    assert normalize_query("registration_number", "1027700132195") == "1027700132195"
    assert normalize_query("organization", "  Ромашка   ООО ") == "Ромашка ООО"
    for kind, value in (
        ("tax_id", "7707083894"),
        ("tax_id", "12345"),
        ("registration_number", "1027700132196"),
        ("organization", "ab"),
        ("name", "Иванов"),
    ):
        with pytest.raises(InvalidQuery):
            normalize_query(kind, value)


def test_rows_keep_registry_fields_only():
    organization = parse_row(ORGANIZATION)
    assert organization == {
        "kind": "organization",
        "name": 'ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "СБЕРБАНК РОССИИ"',
        "inn": "7707083893",
        "ogrn": "1027700132195",
        "registered": "2002-08-16",
        "terminated": None,
        "region": "Г.МОСКВА",
        "short_name": "ПАО СБЕРБАНК",
        "kpp": "773601001",
        "address": "117312, Г.МОСКВА, УЛ. ВАВИЛОВА, Д.19",
        "head": "ПРЕЗИДЕНТ, ПРЕДСЕДАТЕЛЬ ПРАВЛЕНИЯ: ГРЕФ ГЕРМАН ОСКАРОВИЧ",
    }
    entrepreneur = parse_row(ENTREPRENEUR)
    # У ИП нет ни адреса, ни «руководителя»: даже если строка их принесла,
    # запись их не содержит.
    assert "address" not in entrepreneur and "head" not in entrepreneur
    assert entrepreneur["kind"] == "entrepreneur" and entrepreneur["terminated"] == "2019-03-15"
    assert parse_row({"k": "xx", "n": "x", "i": "1"}) is None
    assert parse_row({"k": "ul", "n": "", "i": "7707083893"}) is None


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.slept = []

    def __call__(self):
        return self.now

    async def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


def _registry(handler, breaker=None):
    clock = FakeClock()
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    registry = EgrulRegistry(client, resolver=public_resolver, breaker=breaker, clock=clock, sleep=clock.sleep)
    return registry, client, clock


async def test_search_posts_query_then_polls_the_token():
    seen = []
    polls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, str(request.url)))
        if request.method == "POST":
            form = parse_qs(request.content.decode())
            assert form["query"] == ["7707083893"]
            return httpx.Response(200, json={"t": TOKEN, "captchaRequired": False})
        polls["count"] += 1
        if polls["count"] == 1:
            return httpx.Response(200, json={"status": "wait"})
        return httpx.Response(200, json={"rows": [ORGANIZATION]})

    registry, client, clock = _registry(handler)
    async with client:
        result = await registry.search("tax_id", "7707083893")
    assert result.status == "ok", result
    assert result.requests == 3
    assert result.source_url == "https://egrul.nalog.ru/"
    assert [record["inn"] for record in result.data["records"]] == ["7707083893"]
    assert seen[1][1] == f"https://egrul.nalog.ru/search-result/{TOKEN}"
    # Темп: между запросами к ФНС выдерживается пауза.
    assert clock.slept and all(delay > 0 for delay in clock.slept)


async def test_captcha_is_degradation_not_bypass():
    calls = []

    def handler(request):
        calls.append(request.method)
        return httpx.Response(200, json={"t": "", "captchaRequired": True})

    registry, client, _ = _registry(handler)
    async with client:
        result = await registry.search("organization", "Ромашка")
    assert result.status == "degraded" and result.degraded_reason == "captcha"
    # После капчи сервис не пытается ни второго запроса, ни «решения».
    assert calls == ["POST"]


async def test_ordinary_answer_with_captcha_field_is_not_captcha():
    def handler(request):
        if request.method == "POST":
            return httpx.Response(200, text=json.dumps({"t": TOKEN, "captchaRequired": False}))
        return httpx.Response(200, json={"rows": []})

    registry, client, _ = _registry(handler)
    async with client:
        result = await registry.search("tax_id", "7707083893")
    # Пустой ответ реестра — «записи нет», а не деградация.
    assert result.status == "ok" and result.data["records"] == []


async def test_unknown_shape_and_html_are_degradations():
    def unknown(request):
        if request.method == "POST":
            return httpx.Response(200, json={"t": TOKEN})
        return httpx.Response(200, json={"unexpected": True})

    def html(request):
        return httpx.Response(200, text="<html>Введите код с картинки (captcha)</html>")

    for handler, reason in ((unknown, "unavailable"), (html, "captcha")):
        registry, client, _ = _registry(handler)
        async with client:
            result = await registry.search("tax_id", "7707083893")
        assert result.status == "degraded" and result.degraded_reason == reason


async def test_endless_wait_times_out():
    def handler(request):
        if request.method == "POST":
            return httpx.Response(200, json={"t": TOKEN})
        return httpx.Response(200, json={"status": "wait"})

    registry, client, _ = _registry(handler)
    async with client:
        result = await registry.search("tax_id", "7707083893")
    assert result.status == "degraded" and result.degraded_reason == "timeout"
    assert result.requests == 5


async def test_rate_limit_opens_the_breaker():
    calls = []

    def handler(request):
        calls.append(request.method)
        return httpx.Response(429)

    registry, client, _ = _registry(handler, CircuitBreaker(threshold=1))
    async with client:
        first = await registry.search("tax_id", "7707083893")
        second = await registry.search("tax_id", "7707083893")
    assert first.degraded_reason == "rate_limited"
    assert second.status == "degraded" and second.requests == 0
    assert calls == ["POST"]


async def test_rows_are_capped():
    def handler(request):
        if request.method == "POST":
            return httpx.Response(200, json={"t": TOKEN})
        return httpx.Response(200, json={"rows": [ORGANIZATION] * 25})

    registry, client, _ = _registry(handler)
    async with client:
        result = await registry.search("organization", "Сбербанк")
    assert len(result.data["records"]) == 10


async def test_rows_in_unknown_form_are_unavailable_not_empty():
    def handler(request):
        if request.method == "POST":
            return httpx.Response(200, json={"t": TOKEN})
        return httpx.Response(200, json={"rows": [{"inn": "7707083893", "title": "новый формат"}]})

    registry, client, _ = _registry(handler)
    async with client:
        result = await registry.search("tax_id", "7707083893")
    assert result.status == "degraded" and result.degraded_reason == "unavailable"


async def test_whole_search_has_a_deadline(monkeypatch):
    import asyncio

    import app.registries as registries

    monkeypatch.setattr(registries, "REGISTRY_DEADLINE_SECONDS", 0.05)

    def handler(request):
        if request.method == "POST":
            return httpx.Response(200, json={"t": TOKEN})
        return httpx.Response(200, json={"status": "wait"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    # Настоящая пауза между опросами: срок истекает посреди ожидания.
    registry = EgrulRegistry(client, resolver=public_resolver, sleep=lambda _seconds: asyncio.sleep(10))
    async with client:
        result = await registry.search("tax_id", "7707083893")
    assert result.status == "degraded" and result.degraded_reason == "timeout"
