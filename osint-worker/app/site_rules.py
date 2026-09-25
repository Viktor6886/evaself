"""Проверка профилей по наборам правил WhatsMyName и Sherlock.

Maigret — основной сборщик, но его находка — это одно свидетельство.
Здесь тот же профиль проверяется независимо, чужим набором правил:
WhatsMyName (CC BY-SA 4.0) и Sherlock (MIT). Запись, подтверждённая
двумя сборщиками, сохраняет оба подтверждения, и уверенность потом
считается по ним, а не по «так сказал Maigret».

Правила только читаются из файлов наборов; своих правил поверх них здесь
нет. Сайты, которые набор помечает защищёнными (капча, Cloudflare,
DDoS-Guard), пропускаются: обход защиты запрещён, а ответ страницы-заглушки
выдал бы ложную находку.

Категории, по которым само наличие аккаунта раскрывает особые категории
персональных данных — знакомства, здоровье, политика, взрослый контент, —
исключены по умолчанию.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .limits import CircuitBreaker, DomainGate, classify_failure
from .netguard import FetchResult, UnsafeTarget, safe_fetch, system_resolver

EXCLUDED_WMN_CATEGORIES = frozenset({"dating", "health", "political", "xx NSFW xx"})

Verdict = str  # "found" | "not_found" | "unknown"


@dataclass(frozen=True)
class SiteRule:
    source: str  # "whatsmyname" | "sherlock"
    name: str
    check_url: str  # шаблон с {account}
    profile_url: str  # шаблон с {account}
    method: str = "GET"
    body: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    # WhatsMyName
    e_code: int | None = None
    e_string: str | None = None
    m_code: int | None = None
    m_string: str | None = None
    strip_chars: str = ""
    # Sherlock
    error_type: str | None = None  # status_code | message | response_url
    error_messages: tuple[str, ...] = ()
    error_codes: tuple[int, ...] = ()
    username_regex: str | None = None

    @property
    def host(self) -> str:
        return normalize_host(self.profile_url.replace("{account}", "x"))

    def username_for(self, username: str) -> str | None:
        """Имя в виде, который принимает сайт, или None — сайт его не допускает."""
        value = username
        for char in self.strip_chars:
            value = value.replace(char, "")
        if self.username_regex and not re.search(self.username_regex, value):
            return None
        return value or None


def normalize_host(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def load_whatsmyname(path: Path, excluded: frozenset[str] = EXCLUDED_WMN_CATEGORIES) -> list[SiteRule]:
    data = json.loads(path.read_text(encoding="utf-8"))
    rules: list[SiteRule] = []
    for site in data.get("sites", []):
        if site.get("valid") is False or site.get("protection") or site.get("cat") in excluded:
            continue
        check = site.get("uri_check")
        if not isinstance(check, str) or "{account}" not in check:
            continue
        rules.append(
            SiteRule(
                source="whatsmyname",
                name=str(site.get("name")),
                check_url=check,
                profile_url=site.get("uri_pretty") or check,
                method="POST" if site.get("post_body") else "GET",
                body=site.get("post_body") or None,
                headers={str(k): str(v) for k, v in (site.get("headers") or {}).items()},
                e_code=site.get("e_code"),
                e_string=site.get("e_string") or None,
                m_code=site.get("m_code"),
                m_string=site.get("m_string") or None,
                strip_chars=site.get("strip_bad_char") or "",
            )
        )
    return rules


def load_sherlock(path: Path) -> list[SiteRule]:
    data = json.loads(path.read_text(encoding="utf-8"))
    rules: list[SiteRule] = []
    for name, site in data.items():
        if name.startswith("$") or not isinstance(site, dict):
            continue
        url = site.get("url")
        error_type = site.get("errorType")
        if not isinstance(url, str) or "{}" not in url or not isinstance(error_type, str):
            continue
        messages = site.get("errorMsg") or ()
        if isinstance(messages, str):
            messages = (messages,)
        codes = site.get("errorCode") or ()
        if isinstance(codes, int):
            codes = (codes,)
        payload = site.get("request_payload")
        rules.append(
            SiteRule(
                source="sherlock",
                name=name,
                check_url=str(site.get("urlProbe") or url).replace("{}", "{account}"),
                profile_url=url.replace("{}", "{account}"),
                method=str(site.get("request_method") or "GET").upper(),
                body=json.dumps(payload).replace("{}", "{account}") if payload else None,
                headers={str(k): str(v) for k, v in (site.get("headers") or {}).items()},
                error_type=error_type,
                error_messages=tuple(str(m) for m in messages),
                error_codes=tuple(int(c) for c in codes),
                username_regex=site.get("regexCheck"),
            )
        )
    return rules


def evaluate(rule: SiteRule, result: FetchResult) -> Verdict:
    """Есть ли аккаунт — строго по правилу набора, без догадок."""
    status, text = result.status, result.text
    if rule.source == "whatsmyname":
        if rule.e_code is not None and status == rule.e_code and (not rule.e_string or rule.e_string in text):
            return "found"
        if rule.m_code is not None and status == rule.m_code and (not rule.m_string or rule.m_string in text):
            return "not_found"
        return "unknown"
    if rule.error_type == "status_code":
        if status in rule.error_codes or status >= 300:
            return "not_found"
        return "found" if 200 <= status < 300 else "unknown"
    if rule.error_type == "message":
        if any(message in text for message in rule.error_messages):
            return "not_found"
        return "found" if 200 <= status < 300 else "unknown"
    if rule.error_type == "response_url":
        # Аккаунт есть, если сайт ответил по запрошенному адресу, не уводя
        # на страницу «не найдено».
        if result.redirects == 0 and 200 <= status < 300:
            return "found"
        return "not_found"
    return "unknown"


@dataclass
class Verification:
    source: str
    site: str
    profile_url: str
    status: str  # found | not_found | unknown | skipped | degraded
    reason: str | None = None


class ProfileVerifier:
    def __init__(
        self,
        rules: list[SiteRule],
        *,
        client: httpx.AsyncClient,
        gate: DomainGate | None = None,
        breaker: CircuitBreaker | None = None,
        resolver=system_resolver,
        timeout_seconds: float = 8.0,
    ) -> None:
        self.rules = rules
        self.client = client
        self.gate = gate or DomainGate()
        self.breaker = breaker or CircuitBreaker()
        self.resolver = resolver
        self.timeout = timeout_seconds

    def rules_for_hosts(self, hosts: set[str], sources: set[str]) -> list[SiteRule]:
        return [rule for rule in self.rules if rule.source in sources and rule.host in hosts]

    async def verify(self, username: str, hosts: set[str], sources: set[str]) -> list[Verification]:
        rules = self.rules_for_hosts({normalize_host(f"https://{h}") for h in hosts}, sources)
        return list(await asyncio.gather(*(self._check(rule, username) for rule in rules)))

    async def _check(self, rule: SiteRule, username: str) -> Verification:
        account = rule.username_for(username)
        if account is None:
            return Verification(rule.source, rule.name, "", "skipped", "username_not_allowed")
        profile = rule.profile_url.replace("{account}", account)
        domain = rule.host
        blocked = self.breaker.blocked(domain)
        if blocked:
            return Verification(rule.source, rule.name, profile, "degraded", blocked)

        async def work() -> FetchResult:
            return await asyncio.wait_for(
                safe_fetch(
                    self.client,
                    rule.check_url.replace("{account}", account),
                    method=rule.method,
                    headers=rule.headers or None,
                    content=rule.body.replace("{account}", account) if rule.body else None,
                    resolver=self.resolver,
                ),
                self.timeout,
            )

        try:
            result = await self.gate(domain, work)
        except UnsafeTarget:
            return Verification(rule.source, rule.name, profile, "skipped", "unsafe_target")
        except (TimeoutError, httpx.TimeoutException):
            self.breaker.record(domain, "timeout")
            return Verification(rule.source, rule.name, profile, "degraded", "timeout")
        except httpx.HTTPError:
            self.breaker.record(domain, "unavailable")
            return Verification(rule.source, rule.name, profile, "degraded", "unavailable")
        failure = classify_failure(result.status, result.text)
        self.breaker.record(domain, failure)
        if failure:
            return Verification(rule.source, rule.name, profile, "degraded", failure)
        return Verification(rule.source, rule.name, profile, evaluate(rule, result))
