"""Configuration for Eva Core, read once from the process environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    port: int = field(default_factory=lambda: _int("EVA_CORE_PORT", 8080))
    log_level: str = field(default_factory=lambda: os.environ.get("EVA_CORE_LOG_LEVEL", "info"))

    # Shared secret n8n must present on every /v1/* call.
    api_key: str = field(default_factory=lambda: os.environ.get("EVA_CORE_API_KEY", ""))

    # Letta
    letta_url: str = field(
        default_factory=lambda: os.environ.get("LETTA_URL", "http://letta:8283").rstrip("/")
    )
    letta_password: str = field(default_factory=lambda: os.environ.get("LETTA_SERVER_PASSWORD", ""))
    letta_timeout: float = field(default_factory=lambda: float(_int("EVA_CORE_LETTA_TIMEOUT", 180)))

    # Model handles used when creating a new agent.
    llm_model: str = field(default_factory=lambda: os.environ.get("EVA_LLM_MODEL", ""))
    llm_context_window: int = field(default_factory=lambda: _int("EVA_LLM_CONTEXT_WINDOW", 131072))
    embedding_model: str = field(default_factory=lambda: os.environ.get("EVA_EMBEDDING_MODEL", ""))

    # Infrastructure
    database_url: str = field(default_factory=lambda: os.environ.get("DATABASE_URL", ""))
    valkey_url: str = field(default_factory=lambda: os.environ.get("VALKEY_URL", ""))

    # Per-user message lock
    lock_ttl: int = field(default_factory=lambda: _int("EVA_CORE_LOCK_TTL", 180))

    # Telegram (used to verify Mini App initData signatures)
    telegram_bot_token: str = field(
        default_factory=lambda: os.environ.get("EVA_TELEGRAM_BOT_TOKEN", "")
    )

    persona_file: str = field(
        default_factory=lambda: os.environ.get(
            "EVA_AGENT_PERSONA_FILE", "/app/library/persona/eva.md"
        )
    )

    def persona_text(self) -> str:
        """Eva's persona, loaded from library/ so it can be edited without a rebuild."""
        try:
            with open(self.persona_file, "r", encoding="utf-8") as handle:
                return handle.read().strip()
        except OSError:
            return (
                "You are Eva, an AI companion and self-discovery assistant. "
                "You are warm, attentive and honest. You help the person understand "
                "themselves better, you never diagnose, and you never pretend to be a "
                "licensed therapist."
            )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
