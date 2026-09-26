# SPDX-License-Identifier: GPL-2.0-only
#
# osint-harvester — HTTP-обёртка над theHarvester (GPL-2.0-only).
#
# Файл вызывает theHarvester как библиотеку и потому распространяется под
# той же лицензией GPL-2.0-only. Остальной Evaself с ним не связан: он
# обращается к сервису только по HTTP из соседнего контейнера (docs/OSINT.md,
# правило о GPL-компонентах).
"""Организация → домены, хосты, почта из пассивных источников theHarvester.

Сервис разрешает ровно то, что допускает контур OSINT:

- только пассивные источники без ключей (журналы сертификатов, пассивный
  DNS, архивы). Утечки и базы взломов (haveibeenpwned, dehashed, leakix,
  leaklookup, intelx, hudsonrock), поиск людей (linkedin, hunter,
  rocketreach, tomba) и выдача поисковиков не разрешены вовсе;
- никаких активных действий: перебор DNS, сканирование API, проверка
  захвата поддоменов, скриншоты, прокси и запись файлов выключены жёстко,
  параметрами вызова, а не настройкой;
- найденное не печатается в журнал контейнера: theHarvester пишет
  результаты в stdout, и вывод перехватывается.

Запрос предъявляет общий секрет `OSINT_WORKER_TOKEN` (заголовок X-Osint-Key).
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import ipaddress
import os
import re
import secrets
import shutil
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

SERVICE_TOKEN = os.environ.get("OSINT_WORKER_TOKEN", "").strip()
EVA_ENV = os.environ.get("EVA_ENV", "production").strip().lower()
if EVA_ENV not in {"development", "dev", "local", "test"} and not SERVICE_TOKEN:
    raise RuntimeError(
        f"OSINT_WORKER_TOKEN пуст при EVA_ENV={EVA_ENV}: без общего секрета сервис "
        "мог бы вызвать любой контейнер сети compose."
    )

# Пассивные источники без ключей. Список закрыт: источник вне его не
# выполняется, даже если theHarvester его поддерживает.
ALLOWED_SOURCES = (
    "certspotter",
    "commoncrawl",
    "crtsh",
    "hackertarget",
    "otx",
    "rapiddns",
    "robtex",
    "subdomaincenter",
    "thc",
    "urlscan",
    "waybackarchive",
)
DEFAULT_SOURCES = ("crtsh", "certspotter", "hackertarget", "otx", "rapiddns", "urlscan", "waybackarchive")
DEADLINE_SECONDS = float(os.environ.get("OSINT_HARVEST_DEADLINE_SECONDS", "180"))
MAX_ITEMS = 200
DOMAIN = re.compile(r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$")
EMAIL = re.compile(r"^[^@\s]{1,64}@([a-z0-9.-]+)$", re.I)
STASH = Path(os.path.expanduser("~/.local/share/theHarvester"))

# theHarvester пишет в stdout и держит sqlite-кэш: одновременный вызов
# перемешал бы вывод и кэш. Один прогон за раз.
_lock = asyncio.Lock()


def _error(code: str, message: str, retryable: bool = False) -> dict:
    return {"error": {"code": code, "message": message, "retryable": retryable}}


def require_token(x_osint_key: str | None = Header(default=None)) -> None:
    if not SERVICE_TOKEN:
        return
    if x_osint_key is None or not secrets.compare_digest(x_osint_key, SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail=_error("unauthorized", "X-Osint-Key is missing or wrong"))


app = FastAPI(title="osint-harvester", docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(HTTPException)
async def http_error(_request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else _error("error", str(exc.detail))
    return JSONResponse(status_code=exc.status_code, content=detail)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "sources": list(ALLOWED_SOURCES)}


class HarvestRequest(BaseModel):
    domain: str = Field(min_length=4, max_length=253)
    sources: list[str] | None = Field(default=None, max_length=len(ALLOWED_SOURCES))


def normalize_domain(value: str) -> str:
    raw = value.strip().rstrip(".").lower()
    try:
        name = raw.encode("idna").decode("ascii")
    except UnicodeError as error:
        raise HTTPException(
            status_code=400, detail=_error("invalid_domain", "domain has an unsupported form")
        ) from error
    if not DOMAIN.match(name):
        raise HTTPException(status_code=400, detail=_error("invalid_domain", "domain has an unsupported form"))
    return name


def passive_arguments(domain: str, sources: list[str]) -> argparse.Namespace:
    """Аргументы theHarvester. Все активные режимы выключены здесь, а не настройкой."""
    return argparse.Namespace(
        domain=domain,
        source=",".join(sources),
        limit=500,
        start=0,
        dns_brute=False,
        dns_lookup=False,
        dns_resolve="",
        dns_server="",
        take_over=False,
        api_scan=False,
        wordlist="",
        shodan=False,
        proxies=False,
        screenshot="",
        filename="",
        quiet=True,
    )


def in_scope(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def clean(domain: str, raw: tuple) -> dict:
    """Только то, что относится к домену: чужие хосты и частные адреса отбрасываются."""
    asns, _iurls, _twitter, _linkedin_people, _linkedin_links, _aurls, ips, emails, hosts = raw
    host_names: set[str] = set()
    for item in hosts or []:
        name = str(item).split(":", 1)[0].strip().lower().rstrip(".")
        if DOMAIN.match(name) and in_scope(name, domain):
            host_names.add(name)
    addresses: set[str] = set()
    for item in ips or []:
        try:
            address = ipaddress.ip_address(str(item).strip())
        except ValueError:
            continue
        if address.is_global:
            addresses.add(str(address))
    mailboxes: set[str] = set()
    for item in emails or []:
        match = EMAIL.match(str(item).strip())
        if match and in_scope(match.group(1).lower(), domain):
            mailboxes.add(str(item).strip().lower())
    return {
        "hosts": sorted(host_names)[:MAX_ITEMS],
        "ips": sorted(addresses)[:MAX_ITEMS],
        "emails": sorted(mailboxes)[:MAX_ITEMS],
        "asns": sorted({str(item) for item in asns or [] if re.fullmatch(r"AS?\d{1,10}", str(item))})[:MAX_ITEMS],
    }


async def run_harvester(arguments: argparse.Namespace):  # pragma: no cover — вызывает сеть
    from theHarvester import __main__ as harvester

    return await harvester.start(arguments)


@app.post("/v1/domain/harvest", dependencies=[Depends(require_token)])
async def harvest(request: HarvestRequest) -> dict:
    domain = normalize_domain(request.domain)
    sources = list(dict.fromkeys(request.sources or DEFAULT_SOURCES))
    refused = [source for source in sources if source not in ALLOWED_SOURCES]
    if refused:
        raise HTTPException(
            status_code=400, detail=_error("source_not_allowed", "source is not in the passive allowlist")
        )
    async with _lock:
        sink = io.StringIO()
        try:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                raw = await asyncio.wait_for(run_harvester(passive_arguments(domain, sources)), DEADLINE_SECONDS)
        except TimeoutError as error:
            raise HTTPException(
                status_code=504, detail=_error("harvest_deadline", "harvest did not finish in time", True)
            ) from error
        except SystemExit:
            # theHarvester завершает процесс при сбое источника. Для сервиса
            # это деградация одного запроса, а не остановка.
            return {
                "collector": "theharvester",
                "status": "degraded",
                "sources": sources,
                "requests": len(sources),
                "hosts": [],
                "ips": [],
                "emails": [],
                "asns": [],
            }
        finally:
            # Кэш theHarvester хранит найденное между запусками. Данные о
            # чужих доменах не должны переживать запрос.
            shutil.rmtree(STASH, ignore_errors=True)
    return {
        "collector": "theharvester",
        "status": "ok",
        "sources": sources,
        "requests": len(sources),
        **clean(domain, raw),
    }
