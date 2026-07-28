"""Thin async client for the Letta REST API (verified against Letta 0.16.8).

Everything Eva Core needs from Letta lives here, so a Letta upgrade only
ever touches one file.

Authentication
--------------
A self-hosted server started with SECURE=true wraps every route except the
health probes in `CheckPasswordMiddleware`, which accepts either
`Authorization: Bearer <password>` or `X-BARE-PASSWORD: password <password>`.
We send the bearer form.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable

import httpx

from .errors import LettaBadResponse, LettaTimeout, LettaUnavailable, NotFound

log = logging.getLogger("eva.letta")

# Tag every agent Evaself creates so `GET /v1/agents/?tags=` finds it again
# even if the local database is ever rebuilt from scratch.
EVASELF_TAG = "evaself"
EVA_AGENT_TAG = "eva-companion"


def _telegram_tag(telegram_id: int) -> str:
    return f"tg:{telegram_id}"


def extract_text(content: Any) -> str:
    """Letta message content is either a plain string or a list of parts."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and part.get("type") in (None, "text"):
                text = part.get("text")
                if text:
                    parts.append(str(text))
        return "\n".join(parts).strip()
    return str(content)


class LettaClient:
    def __init__(self, base_url: str, password: str, timeout: float = 180.0):
        self._base_url = base_url.rstrip("/")
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if password:
            headers["Authorization"] = f"Bearer {password}"
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers=headers,
            timeout=httpx.Timeout(timeout, connect=10.0),
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=10),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    # -----------------------------------------------------------------
    # low-level
    # -----------------------------------------------------------------
    async def _request(self, method: str, path: str, **kwargs) -> Any:
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise LettaTimeout(f"Letta did not answer in time ({method} {path})") from exc
        except httpx.TransportError as exc:
            raise LettaUnavailable(f"cannot reach Letta at {self._base_url}: {exc}") from exc

        if response.status_code == 404:
            raise NotFound(f"Letta returned 404 for {method} {path}")
        if response.status_code >= 400:
            raise LettaBadResponse(
                f"Letta returned {response.status_code} for {method} {path}",
                details=response.text[:600],
            )
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise LettaBadResponse("Letta returned a non-JSON body") from exc

    # -----------------------------------------------------------------
    # health
    # -----------------------------------------------------------------
    async def health(self) -> dict:
        # /v1/health/ is deliberately excluded from password protection.
        return await self._request("GET", "/v1/health/")

    # -----------------------------------------------------------------
    # providers — register Eva's OpenAI-compatible endpoint once
    # -----------------------------------------------------------------
    async def list_providers(self) -> list[dict]:
        return await self._request("GET", "/v1/providers/") or []

    async def ensure_provider(self, name: str, base_url: str, api_key: str) -> dict | None:
        """Create the custom provider if it is not registered yet.

        Returns the provider record, or None when no base_url/api_key is
        configured (in that case Letta falls back to its own env vars).
        """
        if not base_url or not api_key:
            return None

        for provider in await self.list_providers():
            if provider.get("name") == name:
                return provider

        return await self._request(
            "POST",
            "/v1/providers/",
            json={
                "name": name,
                "provider_type": "openai",
                "api_key": api_key,
                "base_url": base_url,
            },
        )

    # -----------------------------------------------------------------
    # agents
    # -----------------------------------------------------------------
    async def find_agent_by_telegram_id(self, telegram_id: int) -> dict | None:
        agents = await self._request(
            "GET",
            "/v1/agents/",
            params={
                "tags": [EVASELF_TAG, _telegram_tag(telegram_id)],
                "match_all_tags": "true",
                "limit": 1,
            },
        )
        return agents[0] if agents else None

    async def get_agent(self, agent_id: str) -> dict:
        return await self._request("GET", f"/v1/agents/{agent_id}")

    async def create_agent(
        self,
        *,
        telegram_id: int,
        display_name: str,
        persona: str,
        model: str | None,
        embedding: str | None,
        context_window: int | None,
        human_block: str = "",
        extra_tags: Iterable[str] = (),
    ) -> dict:
        """Create the personal Eva agent for one Telegram user.

        Two core memory blocks are seeded:
          persona — who Eva is (read-only-ish, edited only by the operator)
          human   — what Eva knows about this person; Eva updates it herself
        """
        payload: dict[str, Any] = {
            "name": f"eva-{telegram_id}",
            "description": f"Eva companion agent for Telegram user {telegram_id}",
            "agent_type": "letta_v1_agent",
            "memory_blocks": [
                {"label": "persona", "value": persona, "limit": 6000},
                {
                    "label": "human",
                    "value": human_block
                    or f"Name (from Telegram): {display_name}\nTelegram ID: {telegram_id}",
                    "limit": 6000,
                },
            ],
            "tags": [EVASELF_TAG, EVA_AGENT_TAG, _telegram_tag(telegram_id), *extra_tags],
            "include_base_tools": True,
            "metadata": {"telegram_id": str(telegram_id), "source": "evaself"},
        }
        if model:
            payload["model"] = model
        if embedding:
            payload["embedding"] = embedding
        if context_window:
            payload["context_window_limit"] = context_window

        return await self._request("POST", "/v1/agents/", json=payload)

    async def delete_agent(self, agent_id: str) -> None:
        await self._request("DELETE", f"/v1/agents/{agent_id}")

    # -----------------------------------------------------------------
    # messaging
    # -----------------------------------------------------------------
    async def send_message(
        self,
        agent_id: str,
        text: str,
        *,
        max_steps: int = 20,
        name: str | None = None,
    ) -> dict:
        payload: dict[str, Any] = {
            "messages": [{"role": "user", "content": text, **({"name": name} if name else {})}],
            "max_steps": max_steps,
            "streaming": False,
        }
        return await self._request("POST", f"/v1/agents/{agent_id}/messages", json=payload)

    async def list_messages(self, agent_id: str, limit: int = 50) -> Any:
        return await self._request(
            "GET", f"/v1/agents/{agent_id}/messages", params={"limit": limit}
        )

    # -----------------------------------------------------------------
    # memory
    # -----------------------------------------------------------------
    async def list_memory_blocks(self, agent_id: str) -> list[dict]:
        return await self._request("GET", f"/v1/agents/{agent_id}/core-memory/blocks") or []

    async def update_memory_block(self, agent_id: str, label: str, value: str) -> dict:
        return await self._request(
            "PATCH",
            f"/v1/agents/{agent_id}/core-memory/blocks/{label}",
            json={"value": value},
        )

    async def list_archival(self, agent_id: str, limit: int = 50) -> list[dict]:
        return await self._request(
            "GET", f"/v1/agents/{agent_id}/archival-memory", params={"limit": limit}
        ) or []

    async def insert_archival(self, agent_id: str, text: str) -> list[dict]:
        return await self._request(
            "POST", f"/v1/agents/{agent_id}/archival-memory", json={"text": text}
        ) or []

    # -----------------------------------------------------------------
    # export / import — used by make backup and make restore
    # -----------------------------------------------------------------
    async def export_agent(self, agent_id: str) -> Any:
        return await self._request("GET", f"/v1/agents/{agent_id}/export")

    async def import_agent(self, payload: Any) -> Any:
        return await self._request("POST", "/v1/agents/import", json=payload)

    # -----------------------------------------------------------------
    # tools
    # -----------------------------------------------------------------
    async def list_tools(self, limit: int = 100) -> list[dict]:
        return await self._request("GET", "/v1/tools/", params={"limit": limit}) or []


def summarize_response(response: dict) -> dict:
    """Reduce a LettaResponse to the handful of fields n8n cares about."""
    messages = response.get("messages") or []
    reply_parts: list[str] = []
    reasoning: list[str] = []
    tool_calls: list[str] = []

    for message in messages:
        kind = message.get("message_type")
        if kind == "assistant_message":
            text = extract_text(message.get("content"))
            if text:
                reply_parts.append(text)
        elif kind in ("reasoning_message", "hidden_reasoning_message"):
            text = extract_text(message.get("reasoning") or message.get("content"))
            if text:
                reasoning.append(text)
        elif kind == "tool_call_message":
            call = message.get("tool_call") or {}
            if call.get("name"):
                tool_calls.append(call["name"])

    usage = response.get("usage") or {}
    stop_reason = response.get("stop_reason") or {}

    return {
        "reply": "\n\n".join(reply_parts).strip(),
        "reasoning": reasoning,
        "tool_calls": tool_calls,
        "stop_reason": stop_reason.get("stop_reason") if isinstance(stop_reason, dict) else None,
        "usage": {
            "completion_tokens": usage.get("completion_tokens"),
            "prompt_tokens": usage.get("prompt_tokens"),
            "total_tokens": usage.get("total_tokens"),
            "step_count": usage.get("step_count"),
        },
        "message_count": len(messages),
    }
