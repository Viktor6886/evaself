"""Реестры РФ: ЕГРЮЛ и ЕГРИП через публичный поиск ФНС (egrul.nalog.ru).

Сведения ЕГРЮЛ и ЕГРИП открыты по закону (129-ФЗ, ст. 6), и ФНС
показывает их в публичном сервисе поиска. Сервис работает в два шага:
POST с запросом возвращает токен, GET по токену — строки результата
(иногда сначала «ещё ищем», и тогда запрос повторяется).

Граница:

- капча — деградация «captcha», а не повод её обходить: сервис просит
  человека подтвердить, что он человек, и автомат этого не делает;
- из строки берутся только поля реестровой записи: наименование, ИНН,
  ОГРН, КПП, даты, регион; у организации — адрес и руководитель, у ИП —
  только ФИО и номера (адрес ИП сервис не показывает, и мы его не ищем);
- выписку (PDF) сервис не скачивает: для отчёта хватает строки поиска;
- незнакомая форма ответа — деградация «unavailable»: пустой результат
  означал бы «такой организации нет», а это неправда.

Контракт сервиса описан по его публичному поведению и не сверен из
окружения разработки (сеть до nalog.ru там закрыта); первая проверка —
на развёртывании, за отдельным выключенным флагом.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

import httpx

from .limits import CircuitBreaker, DomainGate
from .netguard import FetchResult, UnsafeTarget, safe_fetch, system_resolver

EGRUL = "https://egrul.nalog.ru/"
EGRUL_HOST = "egrul.nalog.ru"
MAX_ROWS = 10
MAX_POLLS = 3
POLL_DELAY_SECONDS = 1.0
# Между запросами к сервису ФНС — не меньше секунды: частые запросы он
# встречает капчей, и вежливый темп дешевле деградации.
MIN_INTERVAL_SECONDS = 1.0
MAX_JSON_BYTES = 1024 * 1024

INN = re.compile(r"^\d{10}$|^\d{12}$")
OGRN = re.compile(r"^\d{13}$|^\d{15}$")
DATE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")


class InvalidQuery(ValueError):
    pass


class SourceFailure(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _inn_valid(value: str) -> bool:
    digits = [int(char) for char in value]

    def check(weights: list[int], count: int) -> int:
        return sum(weight * digit for weight, digit in zip(weights, digits[:count], strict=False)) % 11 % 10

    if len(digits) == 10:
        return check([2, 4, 10, 3, 5, 9, 4, 6, 8], 9) == digits[9]
    if len(digits) == 12:
        first = check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10)
        second = check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11)
        return first == digits[10] and second == digits[11]
    return False


def _ogrn_valid(value: str) -> bool:
    body, control = int(value[:-1]), int(value[-1])
    modulus = 11 if len(value) == 13 else 13
    return body % modulus % 10 == control


def normalize_query(kind: str, value: str) -> str:
    """Запрос к реестру: ИНН и ОГРН — с контрольной суммой, наименование — как есть."""
    text = re.sub(r"\s+", " ", value).strip()
    if kind == "tax_id":
        digits = re.sub(r"[\s-]", "", text)
        if not INN.match(digits) or not _inn_valid(digits):
            raise InvalidQuery("tax_id")
        return digits
    if kind == "registration_number":
        digits = re.sub(r"[\s-]", "", text)
        if not OGRN.match(digits) or not _ogrn_valid(digits):
            raise InvalidQuery("registration_number")
        return digits
    if kind == "organization":
        if not 3 <= len(text) <= 200:
            raise InvalidQuery("organization")
        return text
    raise InvalidQuery("kind")


def _date(value: Any) -> str | None:
    """ДД.ММ.ГГГГ → ГГГГ-ММ-ДД; иное — не дата."""
    if isinstance(value, str) and DATE.match(value.strip()):
        day, month, year = value.strip().split(".")
        return f"{year}-{month}-{day}"
    return None


def _text(value: Any, limit: int = 500) -> str | None:
    if isinstance(value, str) and value.strip():
        return re.sub(r"\s+", " ", value).strip()[:limit]
    return None


def parse_row(row: dict[str, Any]) -> dict[str, Any] | None:
    """Строка поиска ЕГРЮЛ/ЕГРИП → запись реестра; чужая форма — None."""
    kind = row.get("k")
    inn = _text(row.get("i"), 12)
    ogrn = _text(row.get("o"), 15)
    name = _text(row.get("n"))
    if kind not in {"ul", "fl"} or not name or not (inn or ogrn):
        return None
    record: dict[str, Any] = {
        "kind": "organization" if kind == "ul" else "entrepreneur",
        "name": name,
        "inn": inn if inn and INN.match(inn) else None,
        "ogrn": ogrn if ogrn and OGRN.match(ogrn) else None,
        "registered": _date(row.get("r")),
        "terminated": _date(row.get("e")),
        "region": _text(row.get("rn"), 200),
    }
    if kind == "ul":
        # Адрес и руководитель организации — открытая часть записи ЕГРЮЛ.
        # У ИП их нет в строке поиска, и сервис их не дополняет.
        record.update(
            {
                "short_name": _text(row.get("c")),
                "kpp": _text(row.get("p"), 9),
                "address": _text(row.get("a")),
                "head": _text(row.get("g")),
            }
        )
    return record


def parse_rows(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
        raise SourceFailure("unavailable")
    records = [parse_row(row) for row in payload["rows"] if isinstance(row, dict)]
    return [record for record in records if record][:MAX_ROWS]


@dataclass
class RegistryResult:
    collector: str
    status: str  # ok | degraded
    requests: int
    source_url: str | None
    data: dict[str, Any] = field(default_factory=dict)
    degraded_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "collector": self.collector,
            "status": self.status,
            "requests": self.requests,
            "source_url": self.source_url,
            "degraded_reason": self.degraded_reason,
            "data": self.data,
        }


class EgrulRegistry:
    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        gate: DomainGate | None = None,
        breaker: CircuitBreaker | None = None,
        resolver=system_resolver,
        timeout_seconds: float = 20.0,
        clock=time.monotonic,
        sleep=asyncio.sleep,
    ) -> None:
        self.client = client
        self.gate = gate or DomainGate()
        self.breaker = breaker or CircuitBreaker()
        self.resolver = resolver
        self.timeout = timeout_seconds
        self.clock = clock
        self.sleep = sleep
        self._last = -MIN_INTERVAL_SECONDS
        self._pace = asyncio.Lock()

    async def _request(self, method: str, url: str, requests: list[int], form: dict[str, str] | None = None) -> Any:
        blocked = self.breaker.blocked(EGRUL_HOST)
        if blocked:
            raise SourceFailure(blocked)
        async with self._pace:
            wait = MIN_INTERVAL_SECONDS - (self.clock() - self._last)
            if wait > 0:
                await self.sleep(wait)
            self._last = self.clock()
        requests[0] += 1
        headers = {"Accept": "application/json", "X-Requested-With": "XMLHttpRequest"}
        if form is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"

        async def work() -> FetchResult:
            return await asyncio.wait_for(
                safe_fetch(
                    self.client,
                    url,
                    method=method,
                    headers=headers,
                    content=urlencode(form) if form is not None else None,
                    resolver=self.resolver,
                    max_bytes=MAX_JSON_BYTES,
                ),
                self.timeout,
            )

        try:
            result = await self.gate(EGRUL_HOST, work)
        except UnsafeTarget as error:
            raise SourceFailure("unavailable") from error
        except (TimeoutError, httpx.TimeoutException) as error:
            self.breaker.record(EGRUL_HOST, "timeout")
            raise SourceFailure("timeout") from error
        except httpx.HTTPError as error:
            self.breaker.record(EGRUL_HOST, "unavailable")
            raise SourceFailure("unavailable") from error
        # Классификация по статусу, а не по тексту: в обычном ответе ФНС
        # есть поле `captchaRequired: false`, и поиск слова «captcha» в
        # теле принял бы каждый ответ за капчу.
        if result.status == 429:
            self.breaker.record(EGRUL_HOST, "rate_limited")
            raise SourceFailure("rate_limited")
        if result.status >= 400:
            self.breaker.record(EGRUL_HOST, "unavailable")
            raise SourceFailure("unavailable")
        try:
            payload = json.loads(result.text)
        except json.JSONDecodeError as error:
            # HTML вместо JSON — страница защиты или ошибки, а не ответ.
            failure = "captcha" if re.search(r"captcha|капч", result.text[:4000], re.I) else "unavailable"
            self.breaker.record(EGRUL_HOST, failure)
            raise SourceFailure(failure) from error
        if isinstance(payload, dict) and payload.get("captchaRequired") is True:
            self.breaker.record(EGRUL_HOST, "captcha")
            raise SourceFailure("captcha")
        self.breaker.record(EGRUL_HOST, None)
        return payload

    async def search(self, kind: str, value: str) -> RegistryResult:
        query = normalize_query(kind, value)
        requests = [0]
        try:
            started = await self._request(
                "POST",
                EGRUL,
                requests,
                {"vyp3CaptchaToken": "", "page": "", "query": query, "region": "", "PreventChromeAutocomplete": ""},
            )
            token = started.get("t") if isinstance(started, dict) else None
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_=-]{8,256}", token):
                raise SourceFailure("unavailable")
            url = f"{EGRUL}search-result/{token}"
            payload: Any = None
            for attempt in range(MAX_POLLS + 1):
                payload = await self._request("GET", url, requests)
                if not (isinstance(payload, dict) and payload.get("status") == "wait"):
                    break
                if attempt == MAX_POLLS:
                    raise SourceFailure("timeout")
                await self.sleep(POLL_DELAY_SECONDS)
            records = parse_rows(payload)
        except SourceFailure as failure:
            return RegistryResult("egrul", "degraded", requests[0], None, {}, failure.reason)
        # Адрес результата — страница поиска, а не токен: токен живёт
        # минуты, и ссылка на него в отчёте вела бы в никуда.
        return RegistryResult("egrul", "ok", requests[0], EGRUL, {"query_kind": kind, "records": records})
