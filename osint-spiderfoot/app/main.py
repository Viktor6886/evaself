"""osint-spiderfoot — пассивные модули SpiderFoot за HTTP-обёрткой.

SpiderFoot (MIT, ветка master) запускается отдельным процессом на каждый
скан, и только с модулями из закрытого списка `ALLOWED_MODULES`:
пассивный DNS, публичные реестры (ARIN, RIPE, GLEIF), журналы
сертификатов и репутационные списки. Режим «passive» самого SpiderFoot не
используется: в него входят модули утечек (psbdmp, scylla, wikileaks),
соцсетей, геолокации и разбора чужих страниц — всё это контуру OSINT
запрещено.

Из результата наружу уходят только инфраструктурные события
(`EVENT_KINDS`). Имена людей, физические адреса, геоданные, сырые ответы
реестров (в них бывают контакты людей) и баннеры серверов отбрасываются.

Каждый скан идёт в собственном временном каталоге: база SpiderFoot с
найденным удаляется сразу после ответа. Вывод процесса не пишется в
журнал контейнера.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import os
import re
import secrets
import shutil
import signal
import sys
import tempfile
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

SPIDERFOOT_HOME = Path(os.environ.get("SPIDERFOOT_HOME", "/opt/spiderfoot"))
CACHE_DIR = Path(os.environ.get("SPIDERFOOT_CACHE", "/tmp/spiderfoot-cache"))
DEADLINE_SECONDS = float(os.environ.get("OSINT_SPIDERFOOT_DEADLINE_SECONDS", "240"))
MAX_THREADS = 4
MAX_ITEMS = 200

ALLOWED_MODULES = (
    # DNS и пассивный DNS
    "sfp_dnsresolve",
    "sfp_dnsraw",
    "sfp_dnsgrep",
    "sfp_mnemonic",
    "sfp_robtex",
    "sfp_sublist3r",
    # Публичные реестры
    "sfp_arin",
    "sfp_ripe",
    "sfp_gleif",
    "sfp_bgpview",
    # Журналы сертификатов и открытые индексы
    "sfp_crt",
    "sfp_threatminer",
    "sfp_urlscan",
    "sfp_commoncrawl",
    # Репутационные списки
    "sfp_abusech",
    "sfp_alienvaultiprep",
    "sfp_blocklistde",
    "sfp_botvrij",
    "sfp_cinsscore",
    "sfp_cybercrimetracker",
    "sfp_emergingthreats",
    "sfp_greensnow",
    "sfp_isc",
    "sfp_openphish",
    "sfp_phishtank",
    "sfp_threatfox",
    "sfp_torexits",
    "sfp_vxvault",
)

# Описание события SpiderFoot → вид находки. Всё, чего здесь нет, не
# покидает контейнер.
EVENT_KINDS: dict[str, str] = {
    "Internet Name": "host",
    # Сайт на том же сервере — не часть исследуемого домена: на общем
    # хостинге это чужие сайты. Отдельная группа, без привязки к домену.
    "Co-Hosted Site": "cohost",
    "Domain Name": "domain",
    "IP Address": "ip",
    "IPv6 Address": "ip",
    "BGP AS Membership": "asn",
    "BGP AS Ownership": "asn",
    "Netblock Membership": "netblock",
    "Netblock Ownership": "netblock",
    "Netblock IPv6 Membership": "netblock",
    "Netblock IPv6 Ownership": "netblock",
    "Company Name": "organization",
    "Legal Entity Identifier": "lei",
    "DNS SPF Record": "dns",
    "DNS TXT Record": "dns",
    "Email Gateway (DNS MX Records)": "dns",
    "Name Server (DNS NS Records)": "dns",
    "Malicious IP Address": "reputation",
    "Malicious Internet Name": "reputation",
    "Malicious IP on Owned Netblock": "reputation",
    "Malicious IP on Same Subnet": "reputation",
    "Malicious Co-Hosted Site": "reputation",
    "Blacklisted IP Address": "reputation",
    "Blacklisted Internet Name": "reputation",
    "Blacklisted IP on Owned Netblock": "reputation",
    "Blacklisted IP on Same Subnet": "reputation",
    "Blacklisted Co-Hosted Site": "reputation",
    "TOR Exit Node": "reputation",
}

DOMAIN = re.compile(r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$")

_lock = asyncio.Lock()


def _error(code: str, message: str, retryable: bool = False) -> dict:
    return {"error": {"code": code, "message": message, "retryable": retryable}}


def require_token(x_osint_key: str | None = Header(default=None)) -> None:
    if not SERVICE_TOKEN:
        return
    if x_osint_key is None or not secrets.compare_digest(x_osint_key, SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail=_error("unauthorized", "X-Osint-Key is missing or wrong"))


app = FastAPI(title="osint-spiderfoot", docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(HTTPException)
async def http_error(_request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else _error("error", str(exc.detail))
    return JSONResponse(status_code=exc.status_code, content=detail)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "modules": list(ALLOWED_MODULES)}


class ScanRequest(BaseModel):
    kind: str = Field(pattern="^(domain|ip)$")
    target: str = Field(min_length=3, max_length=253)


INVALID_TARGET = _error("invalid_target", "target has an unsupported form")


def normalize_target(kind: str, value: str) -> str:
    if kind == "ip":
        try:
            address = ipaddress.ip_address(value.strip())
        except ValueError as error:
            raise HTTPException(status_code=400, detail=INVALID_TARGET) from error
        if not address.is_global:
            raise HTTPException(status_code=400, detail=INVALID_TARGET)
        return str(address)
    raw = value.strip().rstrip(".").lower()
    try:
        name = raw.encode("idna").decode("ascii")
    except UnicodeError as error:
        raise HTTPException(status_code=400, detail=INVALID_TARGET) from error
    if not DOMAIN.match(name):
        raise HTTPException(status_code=400, detail=INVALID_TARGET)
    return name


def parse_events(output: str) -> list[dict]:
    """События из вывода `-o json`, в том числе из оборванного на сроке."""
    events: list[dict] = []
    for line in output.splitlines():
        text = line.strip().lstrip("[").rstrip("]").rstrip(",").strip()
        if not text.startswith("{"):
            continue
        try:
            event = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def summarize(events: list[dict]) -> dict:
    groups: dict[str, list] = {
        "hosts": [],
        "cohosts": [],
        "domains": [],
        "ips": [],
        "asns": [],
        "netblocks": [],
        "organizations": [],
        "lei": [],
        "dns": [],
        "reputation": [],
    }
    seen: set[tuple[str, str]] = set()
    for event in events:
        kind = EVENT_KINDS.get(str(event.get("type")))
        data = str(event.get("data") or "").strip()
        module = str(event.get("module") or "")
        if not kind or not data or module not in ALLOWED_MODULES or len(data) > 1000:
            continue
        key = (kind, data)
        if key in seen:
            continue
        seen.add(key)
        if kind == "ip":
            try:
                if not ipaddress.ip_address(data).is_global:
                    continue
            except ValueError:
                continue
        target = {
            "host": "hosts",
            "cohost": "cohosts",
            "domain": "domains",
            "ip": "ips",
            "asn": "asns",
            "netblock": "netblocks",
            "organization": "organizations",
            "lei": "lei",
            "dns": "dns",
            "reputation": "reputation",
        }[kind]
        if kind in {"reputation", "dns"}:
            groups[target].append({"type": event.get("type"), "data": data[:500], "module": module})
        else:
            groups[target].append(data)
    return {key: value[:MAX_ITEMS] for key, value in groups.items()}


def command(target: str) -> list[str]:
    return [
        sys.executable,
        str(SPIDERFOOT_HOME / "sf.py"),
        "-s",
        target,
        "-m",
        ",".join(ALLOWED_MODULES),
        "-o",
        "json",
        "-q",
        "-max-threads",
        str(MAX_THREADS),
    ]


async def run_spiderfoot(target: str, home: str) -> tuple[str, bool]:
    """Вывод процесса и признак того, что он уложился в срок."""
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": home,
        "SPIDERFOOT_DATA": home,
        "SPIDERFOOT_CACHE": str(CACHE_DIR),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    process = await asyncio.create_subprocess_exec(
        *command(target),
        cwd=str(SPIDERFOOT_HOME),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), DEADLINE_SECONDS)
        return stdout.decode("utf-8", "replace"), True
    except TimeoutError:
        # SpiderFoot запускает потоки модулей: снимается вся группа.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        stdout = await process.stdout.read() if process.stdout else b""
        await process.wait()
        return stdout.decode("utf-8", "replace"), False


@app.post("/v1/scan", dependencies=[Depends(require_token)])
async def scan(request: ScanRequest) -> dict:
    target = normalize_target(request.kind, request.target)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    async with _lock:
        home = tempfile.mkdtemp(prefix="sf-")
        try:
            output, finished = await run_spiderfoot(target, home)
        finally:
            # База SpiderFoot с найденным не переживает запрос.
            shutil.rmtree(home, ignore_errors=True)
    events = parse_events(output)
    return {
        "collector": "spiderfoot",
        "status": "ok" if finished else "degraded",
        "degraded_reason": None if finished else "timeout",
        "modules": len(ALLOWED_MODULES),
        "events": len(events),
        **summarize(events),
    }
