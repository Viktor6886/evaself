"""Инфраструктура: RDAP, RIPEstat, журналы сертификатов (crt.sh), DNS.

Все четыре источника — открытые реестры и публичные журналы. Ни один не
обращается к самому исследуемому хосту: регистрационные данные берутся у
реестров, история сертификатов — из журналов Certificate Transparency,
записи DNS — у резолвера.

Из ответа берётся только то, что относится к инфраструктуре и
организациям. Контакты физических лиц в RDAP (имя, телефон, адрес
регистранта-человека) не извлекаются: регистратор скрывает их не
случайно, и сервис не должен собирать то, что владелец домена прятал.
Организация-регистрант остаётся — это открытая информация о компании.

Каждый HTTP-запрос идёт через `safe_fetch`: адрес и редиректы
проверяются так же, как у сборщиков профилей.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx

from .limits import CircuitBreaker, DomainGate, classify_failure
from .netguard import FetchResult, UnsafeTarget, safe_fetch, system_resolver

IANA_BOOTSTRAP = "https://data.iana.org/rdap/{kind}.json"
BOOTSTRAP_TTL_SECONDS = 24 * 3600
RIPESTAT = "https://stat.ripe.net/data/{name}/data.json"
CRTSH = "https://crt.sh/"
MAX_CT_NAMES = 200
MAX_DNS_RECORDS = 20
MAX_TXT_LENGTH = 500
MAX_JSON_BYTES = 4 * 1024 * 1024

DOMAIN = re.compile(r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$")


class InvalidTarget(ValueError):
    pass


class SourceFailure(Exception):
    """Источник не ответил пригодно: причина деградации, а не «ничего нет»."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def normalize_domain(value: str) -> str:
    raw = value.strip().rstrip(".").lower()
    try:
        ascii_name = raw.encode("idna").decode("ascii")
    except UnicodeError as error:
        raise InvalidTarget("domain") from error
    if not DOMAIN.match(ascii_name):
        raise InvalidTarget("domain")
    return ascii_name


def normalize_ip(value: str) -> str:
    try:
        address = ipaddress.ip_address(value.strip())
    except ValueError as error:
        raise InvalidTarget("ip") from error
    # Частный адрес не принадлежит никому снаружи: спрашивать о нём
    # реестры бессмысленно, а о внутренней сети — нельзя.
    if not address.is_global:
        raise InvalidTarget("ip")
    return str(address)


def normalize_asn(value: str | int) -> int:
    text = str(value).strip().upper().removeprefix("AS")
    if not text.isdigit():
        raise InvalidTarget("asn")
    asn = int(text)
    if not 1 <= asn <= 4_294_967_295:
        raise InvalidTarget("asn")
    return asn


@dataclass
class InfraResult:
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


def _vcard(entity: dict[str, Any]) -> dict[str, str]:
    """Поля vCard сущности RDAP: `fn`, `kind`, `org`."""
    result: dict[str, str] = {}
    card = entity.get("vcardArray")
    if not isinstance(card, list) or len(card) < 2 or not isinstance(card[1], list):
        return result
    for item in card[1]:
        if isinstance(item, list) and len(item) >= 4 and item[0] in {"fn", "kind", "org"}:
            value = item[3]
            if isinstance(value, list):
                value = " ".join(str(part) for part in value if part)
            if isinstance(value, str) and value.strip():
                result[item[0]] = value.strip()
    return result


REDACTED = re.compile(r"redact|privacy|withheld|not disclosed|data protected|gdpr", re.I)


def _organizations(rdap: dict[str, Any], role: str) -> list[str]:
    """Организации с заданной ролью. Физические лица не извлекаются."""
    names: list[str] = []
    stack = list(rdap.get("entities") or [])
    while stack:
        entity = stack.pop()
        if not isinstance(entity, dict):
            continue
        stack.extend(entity.get("entities") or [])
        if role not in (entity.get("roles") or []):
            continue
        card = _vcard(entity)
        if card.get("kind") == "individual":
            continue
        name = card.get("org") or (card.get("fn") if card.get("kind") == "org" or role == "registrar" else None)
        if name and not REDACTED.search(name) and name not in names:
            names.append(name[:200])
    return names


def _events(rdap: dict[str, Any]) -> dict[str, str]:
    events: dict[str, str] = {}
    for event in rdap.get("events") or []:
        if not isinstance(event, dict):
            continue
        action, date = event.get("eventAction"), event.get("eventDate")
        if isinstance(action, str) and isinstance(date, str):
            events[action.replace(" ", "_")] = date
    return events


def parse_rdap(kind: str, rdap: dict[str, Any]) -> dict[str, Any]:
    base = {
        "handle": rdap.get("handle"),
        "status": [str(item) for item in rdap.get("status") or []][:20],
        "events": _events(rdap),
    }
    if kind == "domain":
        return {
            **base,
            "name": str(rdap.get("ldhName") or "").lower() or None,
            "registrar": (_organizations(rdap, "registrar") or [None])[0],
            "registrant_organizations": _organizations(rdap, "registrant"),
            "nameservers": sorted(
                {
                    str(ns.get("ldhName")).lower().rstrip(".")
                    for ns in rdap.get("nameservers") or []
                    if isinstance(ns, dict) and ns.get("ldhName")
                }
            )[:MAX_DNS_RECORDS],
        }
    if kind == "ip":
        cidrs = []
        for item in rdap.get("cidr0_cidrs") or []:
            prefix = item.get("v4prefix") or item.get("v6prefix")
            if prefix and item.get("length") is not None:
                cidrs.append(f"{prefix}/{item['length']}")
        return {
            **base,
            "name": rdap.get("name"),
            "start_address": rdap.get("startAddress"),
            "end_address": rdap.get("endAddress"),
            "cidrs": cidrs[:20],
            "country": rdap.get("country"),
            "organizations": _organizations(rdap, "registrant"),
        }
    return {
        **base,
        "name": rdap.get("name"),
        "country": rdap.get("country"),
        "start": rdap.get("startAutnum"),
        "end": rdap.get("endAutnum"),
        "organizations": _organizations(rdap, "registrant"),
    }


def parse_crtsh(domain: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    names: set[str] = set()
    issuers: dict[str, int] = {}
    first, last = None, None
    for row in rows:
        for name in str(row.get("name_value") or "").lower().split("\n"):
            name = name.strip().removeprefix("*.")
            if (name == domain or name.endswith("." + domain)) and DOMAIN.match(name):
                names.add(name)
        issuer = str(row.get("issuer_name") or "")
        match = re.search(r"O=([^,]+)", issuer)
        if match:
            issuers[match.group(1).strip('"')] = issuers.get(match.group(1).strip('"'), 0) + 1
        not_before = row.get("not_before")
        if isinstance(not_before, str):
            first = min(first or not_before, not_before)
            last = max(last or not_before, not_before)
    ordered = sorted(names)
    return {
        "certificates": len(rows),
        "names": ordered[:MAX_CT_NAMES],
        "names_truncated": len(ordered) > MAX_CT_NAMES,
        "issuers": dict(sorted(issuers.items(), key=lambda item: -item[1])[:10]),
        "first_seen": first,
        "last_seen": last,
    }


def parse_prefix_overview(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data") or {}
    block = data.get("block") or {}
    return {
        "resource": data.get("resource"),
        "announced": data.get("announced"),
        "asns": [
            {"asn": item.get("asn"), "holder": item.get("holder")}
            for item in data.get("asns") or []
            if isinstance(item, dict) and isinstance(item.get("asn"), int)
        ][:10],
        "block": {"resource": block.get("resource"), "name": block.get("name"), "description": block.get("desc")},
    }


def parse_as_overview(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data") or {}
    return {"resource": data.get("resource"), "holder": data.get("holder"), "announced": data.get("announced")}


class InfraCollector:
    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        gate: DomainGate | None = None,
        breaker: CircuitBreaker | None = None,
        resolver=system_resolver,
        dns_resolver=None,
        timeout_seconds: float = 20.0,
        clock=time.monotonic,
    ) -> None:
        self.client = client
        self.gate = gate or DomainGate()
        self.breaker = breaker or CircuitBreaker()
        self.resolver = resolver
        self.dns_resolver = dns_resolver
        self.timeout = timeout_seconds
        self.clock = clock
        self._bootstrap: dict[str, tuple[float, list[Any]]] = {}

    async def _fetch_json(self, url: str, requests: list[int]) -> Any:
        host = httpx.URL(url).host
        blocked = self.breaker.blocked(host)
        if blocked:
            raise SourceFailure(blocked)
        requests[0] += 1

        async def work() -> FetchResult:
            return await asyncio.wait_for(
                safe_fetch(
                    self.client,
                    url,
                    headers={"Accept": "application/rdap+json, application/json"},
                    resolver=self.resolver,
                    max_bytes=MAX_JSON_BYTES,
                ),
                self.timeout,
            )

        try:
            result = await self.gate(host, work)
        except UnsafeTarget as error:
            raise SourceFailure("unavailable") from error
        except (TimeoutError, httpx.TimeoutException) as error:
            self.breaker.record(host, "timeout")
            raise SourceFailure("timeout") from error
        except httpx.HTTPError as error:
            self.breaker.record(host, "unavailable")
            raise SourceFailure("unavailable") from error
        failure = classify_failure(result.status, result.text)
        self.breaker.record(host, failure)
        if failure:
            raise SourceFailure(failure)
        if result.status == 404:
            return None
        if result.status >= 400:
            raise SourceFailure("unavailable")
        try:
            return json.loads(result.text)
        except json.JSONDecodeError as error:
            raise SourceFailure("unavailable") from error

    async def _servers(self, kind: str, requests: list[int]) -> list[Any]:
        cached = self._bootstrap.get(kind)
        if cached and self.clock() - cached[0] < BOOTSTRAP_TTL_SECONDS:
            return cached[1]
        payload = await self._fetch_json(IANA_BOOTSTRAP.format(kind=kind), requests)
        services = payload.get("services") if isinstance(payload, dict) else None
        if not isinstance(services, list):
            raise SourceFailure("unavailable")
        self._bootstrap[kind] = (self.clock(), services)
        return services

    async def _rdap_base(self, kind: str, value: str, requests: list[int]) -> str | None:
        if kind == "domain":
            services = await self._servers("dns", requests)
            labels = value.split(".")
            for size in range(len(labels) - 1, 0, -1):
                suffix = ".".join(labels[-size:])
                for entries, urls in services:
                    if suffix in entries and urls:
                        return _https(urls)
            return None
        if kind == "ip":
            address = ipaddress.ip_address(value)
            services = await self._servers("ipv4" if address.version == 4 else "ipv6", requests)
            best: tuple[int, str] | None = None
            for entries, urls in services:
                for entry in entries:
                    network = ipaddress.ip_network(entry, strict=False)
                    secure = _https(urls) if urls else None
                    if address in network and secure and (best is None or network.prefixlen > best[0]):
                        best = (network.prefixlen, secure)
            return best[1] if best else None
        services = await self._servers("asn", requests)
        asn = int(value)
        for entries, urls in services:
            for entry in entries:
                low, _, high = entry.partition("-")
                if int(low) <= asn <= int(high or low) and urls:
                    return _https(urls)
        return None

    async def rdap(self, kind: str, value: str) -> InfraResult:
        requests = [0]
        path = {"domain": "domain", "ip": "ip", "asn": "autnum"}[kind]
        try:
            base = await self._rdap_base(kind, value, requests)
            if not base:
                return InfraResult("rdap", "ok", requests[0], None, {"found": False})
            url = f"{base.rstrip('/')}/{path}/{quote(value, safe='')}"
            payload = await self._fetch_json(url, requests)
        except SourceFailure as failure:
            return InfraResult("rdap", "degraded", requests[0], None, {}, failure.reason)
        if not isinstance(payload, dict):
            return InfraResult("rdap", "ok", requests[0], url, {"found": False})
        return InfraResult("rdap", "ok", requests[0], url, {"found": True, **parse_rdap(kind, payload)})

    async def ripestat(self, kind: str, value: str) -> InfraResult:
        requests = [0]
        name = "prefix-overview" if kind == "ip" else "as-overview"
        resource = value if kind == "ip" else f"AS{value}"
        url = RIPESTAT.format(name=name) + f"?resource={quote(resource, safe='')}&sourceapp=evaself"
        try:
            payload = await self._fetch_json(url, requests)
        except SourceFailure as failure:
            return InfraResult("ripestat", "degraded", requests[0], None, {}, failure.reason)
        if not isinstance(payload, dict):
            return InfraResult("ripestat", "ok", requests[0], url, {"found": False})
        data = parse_prefix_overview(payload) if kind == "ip" else parse_as_overview(payload)
        return InfraResult("ripestat", "ok", requests[0], url, {"found": True, **data})

    async def certificates(self, domain: str) -> InfraResult:
        requests = [0]
        url = f"{CRTSH}?q={quote('%.' + domain, safe='')}&output=json"
        try:
            payload = await self._fetch_json(url, requests)
        except SourceFailure as failure:
            return InfraResult("ct", "degraded", requests[0], None, {}, failure.reason)
        rows = [row for row in payload or [] if isinstance(row, dict)] if isinstance(payload, list) else []
        return InfraResult("ct", "ok", requests[0], url, parse_crtsh(domain, rows))

    async def dns(self, domain: str) -> InfraResult:
        """Записи DNS через резолвер. Сам хост домена не опрашивается."""
        import dns.asyncresolver
        import dns.exception
        import dns.resolver

        resolver = self.dns_resolver or dns.asyncresolver.Resolver()
        resolver.lifetime = min(self.timeout, 8.0)
        records: dict[str, list[str]] = {}
        failures = 0
        for rtype in ("A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA"):
            try:
                answer = await resolver.resolve(domain, rtype)
            except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers):
                continue
            except dns.exception.DNSException:
                failures += 1
                continue
            values = []
            for item in answer:
                text = (
                    item.to_text().strip('"')
                    if rtype != "TXT"
                    else "".join(part.decode("utf-8", "replace") for part in item.strings)
                )
                values.append(text[:MAX_TXT_LENGTH])
            records[rtype] = sorted(set(values))[:MAX_DNS_RECORDS]
        status = "degraded" if failures and not records else "ok"
        return InfraResult("dns", status, 7, None, {"records": records}, "timeout" if status == "degraded" else None)


def _https(urls: list[str]) -> str | None:
    """Адрес реестра только по https: регистрационные данные не идут открытым каналом."""
    secure = [url for url in urls if isinstance(url, str) and url.startswith("https://")]
    return secure[0] if secure else None
