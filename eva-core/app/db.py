"""PostgreSQL access for Eva Core.

Eva Core owns only the small slice of the schema that must stay
transactionally consistent with agent creation (users + agent_links) plus
the usage counters it increments on every processed message. Everything
else — subscriptions, payments, tasks, notifications — is written by n8n.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

import asyncpg

from .errors import DatabaseUnavailable

log = logging.getLogger("eva.db")


class Database:
    def __init__(self, dsn: str):
        self._dsn = dsn
        self._pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        if not self._dsn:
            log.warning("DATABASE_URL is empty; Eva Core runs without persistence")
            return
        self._pool = await asyncpg.create_pool(
            self._dsn, min_size=1, max_size=10, command_timeout=30
        )

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    @property
    def available(self) -> bool:
        return self._pool is not None

    def _require(self) -> asyncpg.Pool:
        if self._pool is None:
            raise DatabaseUnavailable("Eva Core has no database connection")
        return self._pool

    async def ping(self) -> bool:
        try:
            async with self._require().acquire() as conn:
                return await conn.fetchval("SELECT 1") == 1
        except DatabaseUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - reported as a health failure
            raise DatabaseUnavailable(f"database ping failed: {exc}") from exc

    # -----------------------------------------------------------------
    # users
    # -----------------------------------------------------------------
    async def upsert_user(
        self,
        *,
        telegram_id: int,
        username: str | None = None,
        first_name: str | None = None,
        last_name: str | None = None,
        language_code: str | None = None,
    ) -> dict:
        query = """
            INSERT INTO users (telegram_id, username, first_name, last_name,
                               language_code, last_seen_at)
            VALUES ($1, $2, $3, $4, COALESCE($5, 'ru'), now())
            ON CONFLICT (telegram_id) DO UPDATE SET
                username      = COALESCE(EXCLUDED.username, users.username),
                first_name    = COALESCE(EXCLUDED.first_name, users.first_name),
                last_name     = COALESCE(EXCLUDED.last_name, users.last_name),
                language_code = COALESCE(EXCLUDED.language_code, users.language_code),
                last_seen_at  = now()
            RETURNING *
        """
        async with self._require().acquire() as conn:
            row = await conn.fetchrow(
                query, telegram_id, username, first_name, last_name, language_code
            )
        return dict(row)

    async def get_user(self, telegram_id: int) -> dict | None:
        async with self._require().acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM users WHERE telegram_id = $1", telegram_id)
        return dict(row) if row else None

    async def get_user_overview(self, telegram_id: int) -> dict | None:
        async with self._require().acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM v_user_overview WHERE telegram_id = $1", telegram_id
            )
        return dict(row) if row else None

    async def set_user_state(self, telegram_id: int, state: str) -> None:
        async with self._require().acquire() as conn:
            await conn.execute(
                "UPDATE users SET state = $2 WHERE telegram_id = $1", telegram_id, state
            )

    # -----------------------------------------------------------------
    # agent links
    # -----------------------------------------------------------------
    async def get_agent_link(self, telegram_id: int, kind: str = "eva") -> dict | None:
        query = """
            SELECT a.* FROM agent_links a
            JOIN users u ON u.id = a.user_id
            WHERE u.telegram_id = $1 AND a.kind = $2 AND a.status = 'active'
            ORDER BY a.created_at DESC LIMIT 1
        """
        async with self._require().acquire() as conn:
            row = await conn.fetchrow(query, telegram_id, kind)
        return dict(row) if row else None

    async def save_agent_link(
        self,
        *,
        user_id: int,
        agent_id: str,
        agent_name: str | None,
        model: str | None,
        embedding_model: str | None,
        kind: str = "eva",
    ) -> dict:
        query = """
            INSERT INTO agent_links (user_id, kind, agent_id, agent_name, model, embedding_model)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (agent_id) DO UPDATE SET
                agent_name      = EXCLUDED.agent_name,
                model           = EXCLUDED.model,
                embedding_model = EXCLUDED.embedding_model,
                status          = 'active'
            RETURNING *
        """
        async with self._require().acquire() as conn:
            row = await conn.fetchrow(
                query, user_id, kind, agent_id, agent_name, model, embedding_model
            )
        return dict(row)

    async def mark_agent_used(self, agent_id: str) -> None:
        async with self._require().acquire() as conn:
            await conn.execute(
                """
                UPDATE agent_links
                   SET last_message_at = now(), message_count = message_count + 1
                 WHERE agent_id = $1
                """,
                agent_id,
            )

    async def archive_agent_link(self, agent_id: str) -> None:
        async with self._require().acquire() as conn:
            await conn.execute(
                "UPDATE agent_links SET status = 'archived' WHERE agent_id = $1", agent_id
            )

    async def list_agent_links(self, limit: int = 500) -> list[dict]:
        async with self._require().acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT a.agent_id, a.kind, a.status, u.telegram_id
                  FROM agent_links a JOIN users u ON u.id = a.user_id
                 WHERE a.status = 'active'
                 ORDER BY a.created_at
                 LIMIT $1
                """,
                limit,
            )
        return [dict(r) for r in rows]

    # -----------------------------------------------------------------
    # usage & quotas
    # -----------------------------------------------------------------
    @staticmethod
    def _period_start(period: str) -> date:
        today = date.today()
        if period == "day":
            return today
        if period == "week":
            return date.fromordinal(today.toordinal() - today.weekday())
        if period == "month":
            return today.replace(day=1)
        return date(1970, 1, 1)

    async def increment_usage(
        self, telegram_id: int, metric: str, amount: int = 1, period: str = "day"
    ) -> int:
        query = """
            INSERT INTO usage_counters (user_id, metric, period, period_start, used)
            SELECT id, $2, $3, $4, $5 FROM users WHERE telegram_id = $1
            ON CONFLICT (user_id, metric, period, period_start) DO UPDATE
                SET used = usage_counters.used + EXCLUDED.used,
                    updated_at = now()
            RETURNING used
        """
        async with self._require().acquire() as conn:
            used = await conn.fetchval(
                query, telegram_id, metric, period, self._period_start(period), amount
            )
        return int(used or 0)

    async def get_quota_status(self, telegram_id: int) -> list[dict]:
        async with self._require().acquire() as conn:
            rows = await conn.fetch(
                "SELECT metric, period, limit_value, used, remaining "
                "FROM v_quota_status WHERE telegram_id = $1",
                telegram_id,
            )
        return [dict(r) for r in rows]

    async def check_quota(self, telegram_id: int, metric: str) -> dict:
        """Return {allowed, used, limit, remaining} for one metric."""
        async with self._require().acquire() as conn:
            row = await conn.fetchrow(
                "SELECT limit_value, used, remaining FROM v_quota_status "
                "WHERE telegram_id = $1 AND metric = $2 LIMIT 1",
                telegram_id,
                metric,
            )
        if row is None:
            # No quota row configured for this metric/plan => not limited.
            return {"allowed": True, "used": 0, "limit": None, "remaining": None}
        limit_value = row["limit_value"]
        used = row["used"]
        allowed = limit_value < 0 or used < limit_value
        return {
            "allowed": allowed,
            "used": used,
            "limit": None if limit_value < 0 else limit_value,
            "remaining": row["remaining"],
        }

    # -----------------------------------------------------------------
    # misc read helpers used by the WebApp
    # -----------------------------------------------------------------
    async def list_tasks(self, telegram_id: int, limit: int = 50) -> list[dict]:
        async with self._require().acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT t.id, t.title, t.description, t.status, t.priority,
                       t.due_at, t.completed_at, t.created_at
                  FROM tasks t JOIN users u ON u.id = t.user_id
                 WHERE u.telegram_id = $1
                 ORDER BY (t.status = 'done'), t.due_at NULLS LAST, t.created_at DESC
                 LIMIT $2
                """,
                telegram_id,
                limit,
            )
        return [dict(r) for r in rows]

    async def stats(self) -> dict[str, Any]:
        async with self._require().acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT
                    (SELECT count(*) FROM users)                                   AS users,
                    (SELECT count(*) FROM users WHERE state = 'active')            AS active_users,
                    (SELECT count(*) FROM agent_links WHERE status = 'active')     AS agents,
                    (SELECT count(*) FROM subscriptions
                      WHERE status IN ('trialing','active','past_due'))            AS subscriptions,
                    (SELECT count(*) FROM crisis_events WHERE handled = false)     AS open_crisis_events
                """
            )
        return dict(row)
