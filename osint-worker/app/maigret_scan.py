"""Поиск аккаунтов по username через Maigret.

Maigret (MIT) — основной сборщик цифрового следа по имени пользователя.
Здесь он вызывается как библиотека, а не как CLI, и с жёсткими рамками:

- база сайтов — та, что идёт в пакете; автообновление по сети не
  включается: набор правил версии сервиса должен быть воспроизводим;
- обход Cloudflare, прокси и Tor выключены — обход защиты запрещён;
- число сайтов, время на сайт, общий срок и число соединений ограничены;
- сайты с тегами, раскрывающими особые категории персональных данных
  (знакомства, здоровье, религия, взрослый контент), и геосоциальные
  сервисы исключены: слежение за местоположением запрещено.

Из найденного профиля берутся только публичные данные, которые Maigret
извлекает сам (`ids_usernames`, `ids_links`): они уходят во frontier
следующей итерации, но решение, кому они принадлежат, принимает не он.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass, field
from typing import Any

from .limits import classify_failure

EXCLUDED_TAGS = ("dating", "erotic", "porn", "webcam", "medicine", "religion", "geosocial")

MAX_DISCOVERED_PER_PROFILE = 20


@dataclass
class FoundProfile:
    site: str
    url: str
    tags: list[str]
    http_status: int | None
    ids: dict[str, str] = field(default_factory=dict)
    discovered_usernames: list[str] = field(default_factory=list)
    discovered_links: list[str] = field(default_factory=list)


@dataclass
class ScanResult:
    username: str
    status: str  # ok | degraded
    checked: int
    found: list[FoundProfile]
    degraded: dict[str, int]

    def to_dict(self) -> dict[str, Any]:
        return {
            "username": self.username,
            "status": self.status,
            "checked": self.checked,
            "found": [asdict(profile) for profile in self.found],
            "degraded": self.degraded,
        }


_database = None


def _load_database():
    """База сайтов из пакета: загружается один раз на процесс."""
    global _database
    if _database is None:
        from maigret import MaigretDatabase
        from maigret.db_updater import BUNDLED_DB_PATH

        _database = MaigretDatabase().load_from_path(BUNDLED_DB_PATH)
    return _database


def _status_name(result: dict[str, Any]) -> tuple[str, Any]:
    check = result.get("status")
    status = getattr(check, "status", None)
    return (str(getattr(status, "value", status)) if status is not None else "Unknown"), check


def parse_results(username: str, results: dict[str, dict[str, Any]]) -> ScanResult:
    found: list[FoundProfile] = []
    degraded: dict[str, int] = {}
    for site_name, result in results.items():
        status, check = _status_name(result)
        if status == "Claimed":
            site = result.get("site")
            ids = getattr(check, "ids_data", None) or {}
            usernames = sorted({str(k) for k in (result.get("ids_usernames") or {})} - {username})
            found.append(
                FoundProfile(
                    site=site_name,
                    url=str(result.get("url_user") or ""),
                    tags=sorted(getattr(site, "tags", []) or []),
                    http_status=result.get("http_status") if isinstance(result.get("http_status"), int) else None,
                    ids={str(k): str(v) for k, v in ids.items() if isinstance(v, str | int | float)},
                    discovered_usernames=usernames[:MAX_DISCOVERED_PER_PROFILE],
                    discovered_links=[str(link) for link in (result.get("ids_links") or [])][
                        :MAX_DISCOVERED_PER_PROFILE
                    ],
                )
            )
        elif status == "Unknown":
            error = getattr(check, "error", None)
            reason = (
                classify_failure(
                    result.get("http_status") if isinstance(result.get("http_status"), int) else None,
                    error=f"{getattr(error, 'type', '')} {getattr(error, 'desc', '')}",
                )
                or "unavailable"
            )
            degraded[reason] = degraded.get(reason, 0) + 1
    found.sort(key=lambda profile: profile.site.lower())
    return ScanResult(
        username=username,
        status="degraded" if degraded else "ok",
        checked=len(results),
        found=found,
        degraded=degraded,
    )


async def scan_username(
    username: str,
    *,
    top_sites: int,
    site_timeout: float,
    deadline: float,
    max_connections: int,
    search=None,
    database=None,
) -> ScanResult:
    """Проверить username на `top_sites` самых популярных сайтах базы Maigret."""
    if search is None:
        from maigret import search as maigret_search

        search = maigret_search
    db = database or _load_database()
    sites = db.ranked_sites_dict(top=top_sites, excluded_tags=list(EXCLUDED_TAGS), id_type="username")
    logger = logging.getLogger("maigret")
    logger.setLevel(logging.WARNING)
    results = await asyncio.wait_for(
        search(
            username=username,
            site_dict=sites,
            logger=logger,
            timeout=site_timeout,
            is_parsing_enabled=True,
            max_connections=max_connections,
            no_progressbar=True,
            retries=0,
            # Обход защиты сайтов запрещён: никаких cloudflare_bypass,
            # прокси и Tor.
            cloudflare_bypass=None,
            proxy=None,
            tor_proxy=None,
            i2p_proxy=None,
            check_domains=False,
        ),
        timeout=deadline,
    )
    return parse_results(username, results)
