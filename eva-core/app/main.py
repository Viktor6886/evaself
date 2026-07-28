"""Eva Core — the small internal service between n8n and Letta.

Scope, on purpose kept minimal (everything else belongs in n8n):

  * speak the current Letta REST API
  * create one Letta agent per Telegram user
  * find a user's agent again
  * send messages to Letta and normalise the answer
  * serialise concurrent messages from the same user
  * turn every failure into one uniform error shape
  * expose /health
  * back the Telegram Mini App with a signed-initData API

Two authentication surfaces:
  /v1/*      internal, requires X-API-Key: $EVA_CORE_API_KEY (n8n only)
  /public/*  public, requires a valid Telegram Mini App initData signature
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from redis.asyncio import Redis

from .config import Settings, get_settings
from .db import Database
from .errors import (
    BadRequest,
    EvaError,
    NotFound,
    Unauthorized,
    eva_error_handler,
    unhandled_error_handler,
)
from .letta_client import LettaClient, summarize_response
from .locks import UserLocks
from .telegram_auth import telegram_user_from_init_data

VERSION = "0.1.0"
PROVIDER_NAME = "eva-llm"

log = logging.getLogger("eva.core")


# =====================================================================
# request/response models
# =====================================================================
class EnsureUserRequest(BaseModel):
    telegram_id: int
    username: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    language_code: str | None = None
    create_agent: bool = True


class MessageRequest(BaseModel):
    telegram_id: int
    text: str = Field(min_length=1)
    max_steps: int = Field(default=20, ge=1, le=50)
    # n8n has already checked quotas; Eva Core only counts what it did.
    count_usage: bool = True
    metric: str = "messages"


class MemoryBlockUpdate(BaseModel):
    label: str
    value: str


class ArchivalInsert(BaseModel):
    text: str = Field(min_length=1)


# =====================================================================
# lifespan
# =====================================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    app.state.settings = settings
    app.state.letta = LettaClient(
        settings.letta_url, settings.letta_password, timeout=settings.letta_timeout
    )
    app.state.db = Database(settings.database_url)
    await app.state.db.connect()

    app.state.redis = Redis.from_url(settings.valkey_url, decode_responses=True)
    app.state.locks = UserLocks(app.state.redis, ttl=settings.lock_ttl)

    # Register Eva's OpenAI-compatible provider once, best effort: Letta may
    # still be starting up, and n8n retries anyway.
    try:
        await app.state.letta.ensure_provider(
            PROVIDER_NAME,
            os.environ.get("EVA_LLM_BASE_URL", ""),
            os.environ.get("EVA_LLM_API_KEY", ""),
        )
    except EvaError as exc:
        log.warning("could not register the Letta provider yet: %s", exc)

    log.info("eva-core %s ready (letta=%s)", VERSION, settings.letta_url)
    try:
        yield
    finally:
        await app.state.letta.aclose()
        await app.state.db.close()
        await app.state.redis.aclose()


app = FastAPI(
    title="Eva Core",
    version=VERSION,
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.add_exception_handler(EvaError, eva_error_handler)
app.add_exception_handler(Exception, unhandled_error_handler)


# =====================================================================
# dependencies
# =====================================================================
def settings_dep(request: Request) -> Settings:
    return request.app.state.settings


async def require_internal_key(
    request: Request, x_api_key: str | None = Header(default=None)
) -> None:
    expected = request.app.state.settings.api_key
    if not expected:
        raise Unauthorized("EVA_CORE_API_KEY is not configured on the server")
    if not x_api_key or not _constant_time_eq(x_api_key, expected):
        raise Unauthorized("invalid or missing X-API-Key")


def _constant_time_eq(a: str, b: str) -> bool:
    import hmac

    return hmac.compare_digest(a.encode(), b.encode())


async def require_telegram_user(
    request: Request, x_telegram_init_data: str | None = Header(default=None)
) -> dict:
    settings: Settings = request.app.state.settings
    if not x_telegram_init_data:
        raise Unauthorized("missing X-Telegram-Init-Data header")
    return telegram_user_from_init_data(x_telegram_init_data, settings.telegram_bot_token)


# =====================================================================
# health
# =====================================================================
@app.get("/health")
async def health(request: Request) -> JSONResponse:
    """Liveness + dependency probe. Never requires authentication."""
    report: dict[str, Any] = {"service": "eva-core", "version": VERSION, "status": "ok"}
    checks: dict[str, Any] = {}

    try:
        letta_health = await request.app.state.letta.health()
        checks["letta"] = {"ok": True, "version": (letta_health or {}).get("version")}
    except EvaError as exc:
        checks["letta"] = {"ok": False, "error": exc.code}
        report["status"] = "degraded"

    try:
        await request.app.state.db.ping()
        checks["postgres"] = {"ok": True}
    except EvaError as exc:
        checks["postgres"] = {"ok": False, "error": exc.code}
        report["status"] = "degraded"

    try:
        await request.app.state.redis.ping()
        checks["valkey"] = {"ok": True}
    except Exception as exc:  # noqa: BLE001 - reported, not raised
        checks["valkey"] = {"ok": False, "error": str(exc)[:200]}
        report["status"] = "degraded"

    report["checks"] = checks
    return JSONResponse(status_code=200 if report["status"] == "ok" else 503, content=report)


# =====================================================================
# internal API — called by n8n
# =====================================================================
@app.post("/v1/users/ensure", dependencies=[Depends(require_internal_key)])
async def ensure_user(payload: EnsureUserRequest, request: Request) -> dict:
    """Idempotently create the user row and their personal Letta agent."""
    db: Database = request.app.state.db
    letta: LettaClient = request.app.state.letta
    settings: Settings = request.app.state.settings

    user = await db.upsert_user(
        telegram_id=payload.telegram_id,
        username=payload.username,
        first_name=payload.first_name,
        last_name=payload.last_name,
        language_code=payload.language_code,
    )

    link = await db.get_agent_link(payload.telegram_id)
    created = False

    if link is None and payload.create_agent:
        # The database may have been restored without Letta, or the other
        # way round: always ask Letta before creating a duplicate agent.
        existing = await letta.find_agent_by_telegram_id(payload.telegram_id)
        if existing is None:
            display_name = " ".join(
                part for part in (payload.first_name, payload.last_name) if part
            ) or (payload.username or str(payload.telegram_id))
            existing = await letta.create_agent(
                telegram_id=payload.telegram_id,
                display_name=display_name,
                persona=settings.persona_text(),
                model=_model_handle(settings.llm_model),
                embedding=_model_handle(settings.embedding_model),
                context_window=settings.llm_context_window,
            )
            created = True

        link = await db.save_agent_link(
            user_id=user["id"],
            agent_id=existing["id"],
            agent_name=existing.get("name"),
            model=settings.llm_model,
            embedding_model=settings.embedding_model,
        )

    return {
        "user": _public_user(user),
        "agent": _public_agent(link),
        "agent_created": created,
    }


@app.get("/v1/users/{telegram_id}", dependencies=[Depends(require_internal_key)])
async def get_user(telegram_id: int, request: Request) -> dict:
    db: Database = request.app.state.db
    overview = await db.get_user_overview(telegram_id)
    if overview is None:
        raise NotFound(f"no user with telegram_id={telegram_id}")
    overview["quotas"] = await db.get_quota_status(telegram_id)
    return _jsonable(overview)


@app.get("/v1/agents/by-telegram/{telegram_id}", dependencies=[Depends(require_internal_key)])
async def get_agent_for_user(telegram_id: int, request: Request) -> dict:
    link = await request.app.state.db.get_agent_link(telegram_id)
    if link is None:
        raise NotFound(f"no active agent for telegram_id={telegram_id}")
    return {"agent": _public_agent(link)}


@app.post("/v1/messages", dependencies=[Depends(require_internal_key)])
async def send_message(payload: MessageRequest, request: Request) -> dict:
    """Send one user message to that user's agent and return the reply.

    The whole turn runs under a per-user lock, so a burst of Telegram
    messages can never interleave inside one agent.
    """
    db: Database = request.app.state.db
    letta: LettaClient = request.app.state.letta
    locks: UserLocks = request.app.state.locks

    link = await db.get_agent_link(payload.telegram_id)
    if link is None:
        raise NotFound(
            f"no agent for telegram_id={payload.telegram_id}; call /v1/users/ensure first"
        )

    async with locks.hold(payload.telegram_id):
        response = await letta.send_message(
            link["agent_id"], payload.text, max_steps=payload.max_steps
        )
        summary = summarize_response(response)
        await db.mark_agent_used(link["agent_id"])
        if payload.count_usage:
            summary["usage_after"] = await db.increment_usage(
                payload.telegram_id, payload.metric
            )

    summary["agent_id"] = link["agent_id"]
    return summary


@app.get("/v1/agents/{telegram_id}/memory", dependencies=[Depends(require_internal_key)])
async def get_memory(telegram_id: int, request: Request) -> dict:
    link = await _require_link(request, telegram_id)
    blocks = await request.app.state.letta.list_memory_blocks(link["agent_id"])
    return {
        "agent_id": link["agent_id"],
        "blocks": [
            {"label": b.get("label"), "value": b.get("value"), "limit": b.get("limit")}
            for b in blocks
        ],
    }


@app.patch("/v1/agents/{telegram_id}/memory", dependencies=[Depends(require_internal_key)])
async def patch_memory(telegram_id: int, payload: MemoryBlockUpdate, request: Request) -> dict:
    link = await _require_link(request, telegram_id)
    block = await request.app.state.letta.update_memory_block(
        link["agent_id"], payload.label, payload.value
    )
    return {"agent_id": link["agent_id"], "block": block}


@app.post("/v1/agents/{telegram_id}/archival", dependencies=[Depends(require_internal_key)])
async def add_archival(telegram_id: int, payload: ArchivalInsert, request: Request) -> dict:
    link = await _require_link(request, telegram_id)
    passages = await request.app.state.letta.insert_archival(link["agent_id"], payload.text)
    return {"agent_id": link["agent_id"], "passages": len(passages)}


@app.get("/v1/agents/{telegram_id}/export", dependencies=[Depends(require_internal_key)])
async def export_agent(telegram_id: int, request: Request) -> Any:
    link = await _require_link(request, telegram_id)
    return await request.app.state.letta.export_agent(link["agent_id"])


@app.get("/v1/agents", dependencies=[Depends(require_internal_key)])
async def list_agents(request: Request) -> dict:
    """Agent inventory, used by scripts/backup.sh to export every agent."""
    return {"agents": await request.app.state.db.list_agent_links()}


@app.post("/v1/locks/{telegram_id}/release", dependencies=[Depends(require_internal_key)])
async def release_lock(telegram_id: int, request: Request) -> dict:
    released = await request.app.state.locks.force_release(telegram_id)
    return {"telegram_id": telegram_id, "released": released}


@app.get("/v1/stats", dependencies=[Depends(require_internal_key)])
async def stats(request: Request) -> dict:
    return _jsonable(await request.app.state.db.stats())


@app.get("/v1/quota/{telegram_id}/{metric}", dependencies=[Depends(require_internal_key)])
async def quota(telegram_id: int, metric: str, request: Request) -> dict:
    return _jsonable(await request.app.state.db.check_quota(telegram_id, metric))


# =====================================================================
# public API — called by the Telegram Mini App
# =====================================================================
@app.post("/public/session")
async def public_session(request: Request, tg_user: dict = Depends(require_telegram_user)) -> dict:
    db: Database = request.app.state.db
    user = await db.upsert_user(
        telegram_id=int(tg_user["id"]),
        username=tg_user.get("username"),
        first_name=tg_user.get("first_name"),
        last_name=tg_user.get("last_name"),
        language_code=tg_user.get("language_code"),
    )
    overview = await db.get_user_overview(int(tg_user["id"])) or {}
    return _jsonable(
        {
            "user": _public_user(user),
            "plan": overview.get("plan", "free"),
            "subscription_status": overview.get("subscription_status", "none"),
            "quotas": await db.get_quota_status(int(tg_user["id"])),
        }
    )


@app.get("/public/tasks")
async def public_tasks(request: Request, tg_user: dict = Depends(require_telegram_user)) -> dict:
    tasks = await request.app.state.db.list_tasks(int(tg_user["id"]))
    return _jsonable({"tasks": tasks})


@app.get("/public/usage")
async def public_usage(request: Request, tg_user: dict = Depends(require_telegram_user)) -> dict:
    return _jsonable({"quotas": await request.app.state.db.get_quota_status(int(tg_user["id"]))})


# =====================================================================
# helpers
# =====================================================================
async def _require_link(request: Request, telegram_id: int) -> dict:
    link = await request.app.state.db.get_agent_link(telegram_id)
    if link is None:
        raise NotFound(f"no agent for telegram_id={telegram_id}")
    return link


def _model_handle(model: str | None) -> str | None:
    """Letta model handles are `provider/model`.

    EVA_LLM_MODEL may be written either way; a bare model name is
    qualified with the provider Eva Core registers at start-up.
    """
    if not model:
        return None
    return model if "/" in model else f"{PROVIDER_NAME}/{model}"


def _public_user(user: dict | None) -> dict | None:
    if not user:
        return None
    return _jsonable(
        {
            "id": user.get("id"),
            "telegram_id": user.get("telegram_id"),
            "username": user.get("username"),
            "first_name": user.get("first_name"),
            "language_code": user.get("language_code"),
            "state": user.get("state"),
            "is_blocked": user.get("is_blocked"),
            "created_at": user.get("created_at"),
        }
    )


def _public_agent(link: dict | None) -> dict | None:
    if not link:
        return None
    return _jsonable(
        {
            "agent_id": link.get("agent_id"),
            "agent_name": link.get("agent_name"),
            "kind": link.get("kind"),
            "model": link.get("model"),
            "message_count": link.get("message_count"),
            "last_message_at": link.get("last_message_at"),
        }
    )


def _jsonable(value: Any) -> Any:
    """datetime/date/Decimal -> JSON-friendly primitives."""
    import datetime
    import decimal

    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    return value


def _raise_bad_request(message: str) -> None:  # pragma: no cover - guard helper
    raise BadRequest(message)
