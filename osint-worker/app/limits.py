"""Пределы нагрузки на внешние сайты.

Сборщик ходит по сотням сайтов, и без пределов один запрос человека
превращается в поток к каждому из них. Здесь три ограничения:

- не больше `per_domain` одновременных запросов к одному домену;
- автоматический выключатель: после `threshold` подряд отказов вида
  «капча», «429», «таймаут» домен пропускается `cooldown` секунд.
  Долбить сайт, который уже просит остановиться, бессмысленно и вредно;
- общий предел одновременных запросов на весь процесс.

Состояние живёт в памяти процесса и сбрасывается перезапуском: это
операционная мера, а не данные.
"""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from collections.abc import Callable

DEGRADED_REASONS = {"rate_limited", "captcha", "timeout", "unavailable", "disabled"}


class CircuitBreaker:
    def __init__(
        self,
        threshold: int = 3,
        cooldown_seconds: float = 300.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.threshold = threshold
        self.cooldown = cooldown_seconds
        self.clock = clock
        self._failures: dict[str, int] = defaultdict(int)
        self._open_until: dict[str, float] = {}
        self._reason: dict[str, str] = {}

    def blocked(self, domain: str) -> str | None:
        """Причина, по которой домен сейчас пропускается, или None."""
        until = self._open_until.get(domain)
        if until is None:
            return None
        if self.clock() >= until:
            del self._open_until[domain]
            self._failures[domain] = 0
            return None
        return self._reason.get(domain, "unavailable")

    def record(self, domain: str, outcome: str | None) -> None:
        """`outcome` — причина деградации или None при нормальном ответе."""
        if outcome is None:
            self._failures[domain] = 0
            return
        self._failures[domain] += 1
        if self._failures[domain] >= self.threshold:
            self._open_until[domain] = self.clock() + self.cooldown
            self._reason[domain] = outcome


class DomainGate:
    """Семафоры: общий на процесс и отдельный на каждый домен."""

    def __init__(self, total: int = 20, per_domain: int = 2) -> None:
        self._total = asyncio.Semaphore(total)
        self._per_domain = per_domain
        self._domains: dict[str, asyncio.Semaphore] = {}

    def _domain(self, domain: str) -> asyncio.Semaphore:
        if domain not in self._domains:
            self._domains[domain] = asyncio.Semaphore(self._per_domain)
        return self._domains[domain]

    async def __call__(self, domain: str, work):
        async with self._total, self._domain(domain):
            return await work()


def classify_failure(status: int | None, text: str = "", error: str = "") -> str | None:
    """Вид деградации по ответу сайта; None — ответ пригоден для решения."""
    lowered = f"{text[:4000]} {error}".lower()
    if status == 429 or "too many requests" in lowered or "rate limit" in lowered:
        return "rate_limited"
    if (
        "captcha" in lowered
        or "bot protection" in lowered
        or "just a moment" in lowered
        or "attention required" in lowered
        or "access denied" in lowered
    ):
        return "captcha"
    if "timeout" in lowered or "timed out" in lowered:
        return "timeout"
    if status is None or status >= 500:
        return "unavailable"
    return None
