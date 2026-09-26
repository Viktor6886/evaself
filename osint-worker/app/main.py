"""osint-worker — детерминированные сборщики OSINT для Евы.

Сервис ничего не решает и ничего не помнит. Он получает от
`eva-agent-service` конкретный запрос (проверить username, подтвердить
профили, сравнить две сущности) и возвращает структурированный результат.
Выбор сборщиков, бюджет исследования, тождество и отчёт остаются в
`eva-agent-service`, а когнитивная работа — в Letta.

Сервис живёт в сети `tools` без опубликованных портов. «Не опубликован»
не значит «недоступен»: любой контейнер сети может к нему обратиться,
поэтому каждый запрос предъявляет общий секрет `OSINT_WORKER_TOKEN`.
"""

from __future__ import annotations

import os
import re
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import matching
from .infra import InfraCollector, InvalidTarget, normalize_asn, normalize_domain, normalize_ip
from .limits import CircuitBreaker, DomainGate
from .maigret_scan import scan_username
from .registries import EgrulRegistry, InvalidQuery
from .site_rules import ProfileVerifier, load_sherlock, load_whatsmyname

SERVICE_TOKEN = os.environ.get("OSINT_WORKER_TOKEN", "").strip()
EVA_ENV = os.environ.get("EVA_ENV", "production").strip().lower()
IS_PRODUCTION = EVA_ENV not in {"development", "dev", "local", "test"}

if IS_PRODUCTION and not SERVICE_TOKEN:
    raise RuntimeError(
        f"OSINT_WORKER_TOKEN пуст при EVA_ENV={EVA_ENV}. osint-worker ходит во "
        "внешний интернет от имени установки, и без общего секрета его может "
        "вызвать любой контейнер сети compose. Задайте OSINT_WORKER_TOKEN в .env "
        "(`make configure` генерирует его сам) или выставьте EVA_ENV=development."
    )


def _bounded(name: str, default: float, low: float, high: float) -> float:
    try:
        value = float(os.environ.get(name, default))
    except ValueError:
        value = default
    return min(high, max(low, value))


TOP_SITES_DEFAULT = int(_bounded("OSINT_TOP_SITES", 300, 10, 1500))
SITE_TIMEOUT = _bounded("OSINT_SITE_TIMEOUT_SECONDS", 6, 1, 30)
SCAN_DEADLINE = _bounded("OSINT_SCAN_DEADLINE_SECONDS", 180, 10, 900)
MAX_CONNECTIONS = int(_bounded("OSINT_MAX_CONNECTIONS", 20, 1, 100))
PER_DOMAIN = int(_bounded("OSINT_PER_DOMAIN_CONCURRENCY", 2, 1, 10))
INFRA_TIMEOUT = _bounded("OSINT_INFRA_TIMEOUT_SECONDS", 45, 5, 120)
DATASETS = Path(os.environ.get("OSINT_DATASETS_DIR", "/app/datasets"))

# Та же форма, что у normalizeUsername в eva-agent-service: имя, которое
# туда не проходит, сюда тоже не должно.
USERNAME = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_])?$")


def require_token(x_osint_key: str | None = Header(default=None)) -> None:
    if not SERVICE_TOKEN:
        return
    if x_osint_key is None or not secrets.compare_digest(x_osint_key, SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail=_error_body("unauthorized", "X-Osint-Key is missing or wrong"))


def _error_body(code: str, message: str, retryable: bool = False) -> dict:
    return {"error": {"code": code, "message": message, "retryable": retryable}}


class State:
    verifier: ProfileVerifier | None = None
    infra: InfraCollector | None = None
    egrul: EgrulRegistry | None = None
    client: httpx.AsyncClient | None = None


state = State()


def _load_rules():
    rules = []
    wmn, sherlock = DATASETS / "wmn-data.json", DATASETS / "sherlock-data.json"
    if wmn.exists():
        rules.extend(load_whatsmyname(wmn))
    if sherlock.exists():
        rules.extend(load_sherlock(sherlock))
    return rules


@asynccontextmanager
async def lifespan(_app: FastAPI):
    state.client = httpx.AsyncClient(
        timeout=httpx.Timeout(SITE_TIMEOUT),
        headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) evaself-osint"},
        trust_env=False,
    )
    state.verifier = ProfileVerifier(
        _load_rules(),
        client=state.client,
        gate=DomainGate(total=MAX_CONNECTIONS, per_domain=PER_DOMAIN),
        breaker=CircuitBreaker(),
        timeout_seconds=SITE_TIMEOUT,
    )
    # Реестры и журналы сертификатов отвечают медленнее профилей: crt.sh
    # на крупном домене отдаёт ответ за десятки секунд.
    state.infra = InfraCollector(
        state.client,
        gate=DomainGate(total=MAX_CONNECTIONS, per_domain=PER_DOMAIN),
        breaker=CircuitBreaker(),
        timeout_seconds=INFRA_TIMEOUT,
    )
    # ФНС встречает частые запросы капчей: к её сервису — один запрос за
    # раз, темп задаёт сам EgrulRegistry.
    state.egrul = EgrulRegistry(
        state.client,
        gate=DomainGate(total=MAX_CONNECTIONS, per_domain=1),
        breaker=CircuitBreaker(),
        timeout_seconds=INFRA_TIMEOUT,
    )
    try:
        yield
    finally:
        await state.client.aclose()


app = FastAPI(title="osint-worker", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(HTTPException)
async def http_error(_request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else _error_body("error", str(exc.detail))
    return JSONResponse(status_code=exc.status_code, content=detail)


@app.get("/health")
async def health() -> dict:
    rules = state.verifier.rules if state.verifier else []
    return {
        "status": "ok",
        "rules": {
            "whatsmyname": sum(1 for rule in rules if rule.source == "whatsmyname"),
            "sherlock": sum(1 for rule in rules if rule.source == "sherlock"),
        },
    }


class ScanRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    top_sites: int | None = Field(default=None, ge=10, le=1500)


def _username(value: str) -> str:
    username = value.strip().lstrip("@").lower()
    if not USERNAME.match(username):
        raise HTTPException(status_code=400, detail=_error_body("invalid_username", "username has an unsupported form"))
    return username


@app.post("/v1/username/scan", dependencies=[Depends(require_token)])
async def scan(request: ScanRequest) -> dict:
    username = _username(request.username)
    try:
        result = await scan_username(
            username,
            top_sites=min(request.top_sites or TOP_SITES_DEFAULT, 1500),
            site_timeout=SITE_TIMEOUT,
            deadline=SCAN_DEADLINE,
            max_connections=MAX_CONNECTIONS,
        )
    except TimeoutError as error:
        raise HTTPException(
            status_code=504,
            detail=_error_body("scan_deadline", "the scan did not finish in time", retryable=True),
        ) from error
    return {"collector": "maigret", **result.to_dict()}


class VerifyRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    hosts: list[str] = Field(min_length=1, max_length=100)
    sources: list[str] = Field(default_factory=lambda: ["whatsmyname"], max_length=2)


@app.post("/v1/username/verify", dependencies=[Depends(require_token)])
async def verify(request: VerifyRequest) -> dict:
    username = _username(request.username)
    sources = set(request.sources) & {"whatsmyname", "sherlock"}
    if not sources:
        raise HTTPException(status_code=400, detail=_error_body("invalid_sources", "unknown verifier source"))
    assert state.verifier is not None
    hosts = {host.strip().lower() for host in request.hosts if host.strip()}
    results = await state.verifier.verify(username, hosts, sources)
    return {"username": username, "results": [result.__dict__ for result in results]}


class CompareRequest(BaseModel):
    left: dict
    right: dict


@app.post("/v1/match/compare", dependencies=[Depends(require_token)])
async def compare(request: CompareRequest) -> dict:
    try:
        return matching.compare(request.left, request.right)
    except matching.InvalidEntity as error:
        raise HTTPException(status_code=400, detail=_error_body("invalid_entity", str(error))) from error


class DomainRequest(BaseModel):
    domain: str = Field(min_length=4, max_length=253)


class RdapRequest(BaseModel):
    kind: str = Field(pattern="^(domain|ip|asn)$")
    value: str = Field(min_length=1, max_length=253)


class NetworkRequest(BaseModel):
    kind: str = Field(pattern="^(ip|asn)$")
    value: str = Field(min_length=1, max_length=64)


def _target(kind: str, value: str) -> str:
    try:
        if kind == "domain":
            return normalize_domain(value)
        if kind == "ip":
            return normalize_ip(value)
        return str(normalize_asn(value))
    except InvalidTarget as error:
        detail = _error_body("invalid_target", f"{kind} has an unsupported form")
        raise HTTPException(status_code=400, detail=detail) from error


@app.post("/v1/infra/rdap", dependencies=[Depends(require_token)])
async def rdap(request: RdapRequest) -> dict:
    assert state.infra is not None
    return (await state.infra.rdap(request.kind, _target(request.kind, request.value))).to_dict()


@app.post("/v1/infra/ripestat", dependencies=[Depends(require_token)])
async def ripestat(request: NetworkRequest) -> dict:
    assert state.infra is not None
    return (await state.infra.ripestat(request.kind, _target(request.kind, request.value))).to_dict()


@app.post("/v1/infra/certificates", dependencies=[Depends(require_token)])
async def certificates(request: DomainRequest) -> dict:
    assert state.infra is not None
    return (await state.infra.certificates(_target("domain", request.domain))).to_dict()


@app.post("/v1/infra/dns", dependencies=[Depends(require_token)])
async def dns_records(request: DomainRequest) -> dict:
    assert state.infra is not None
    return (await state.infra.dns(_target("domain", request.domain))).to_dict()


class RegistryRequest(BaseModel):
    kind: str = Field(pattern="^(tax_id|registration_number|organization)$")
    value: str = Field(min_length=3, max_length=200)


@app.post("/v1/registry/egrul", dependencies=[Depends(require_token)])
async def egrul(request: RegistryRequest) -> dict:
    assert state.egrul is not None
    try:
        return (await state.egrul.search(request.kind, request.value)).to_dict()
    except InvalidQuery as error:
        detail = _error_body("invalid_target", f"{request.kind} has an unsupported form")
        raise HTTPException(status_code=400, detail=detail) from error
