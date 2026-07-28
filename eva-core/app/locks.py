"""Per-user processing locks.

Letta processes messages for one agent sequentially and explicitly warns
that concurrent requests to the same agent produce undefined behaviour.
Telegram, on the other hand, happily delivers three messages in a row.

A Valkey lock keyed by Telegram ID makes that safe: the second message is
rejected with a retryable `user_busy` error that n8n turns into a "one
moment…" reply, instead of corrupting the agent's message history.
"""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

from redis.asyncio import Redis

from .errors import UserBusy

# Release only if we still own the lock: a lock that expired and was taken
# by another worker must never be deleted by the previous owner.
_RELEASE_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
else
    return 0
end
"""


class UserLocks:
    def __init__(self, redis: Redis, ttl: int = 180, prefix: str = "eva:lock:user:"):
        self._redis = redis
        self._ttl = ttl
        self._prefix = prefix

    def _key(self, telegram_id: int) -> str:
        return f"{self._prefix}{telegram_id}"

    async def acquire(self, telegram_id: int) -> str:
        token = uuid.uuid4().hex
        acquired = await self._redis.set(self._key(telegram_id), token, nx=True, ex=self._ttl)
        if not acquired:
            ttl = await self._redis.ttl(self._key(telegram_id))
            raise UserBusy(
                "a previous message from this user is still being processed",
                details={"retry_after_seconds": max(ttl, 1)},
            )
        return token

    async def release(self, telegram_id: int, token: str) -> bool:
        released = await self._redis.eval(_RELEASE_SCRIPT, 1, self._key(telegram_id), token)
        return bool(released)

    async def force_release(self, telegram_id: int) -> bool:
        """Operator escape hatch, exposed as POST /v1/locks/{telegram_id}/release."""
        return bool(await self._redis.delete(self._key(telegram_id)))

    async def is_locked(self, telegram_id: int) -> bool:
        return bool(await self._redis.exists(self._key(telegram_id)))

    @asynccontextmanager
    async def hold(self, telegram_id: int):
        token = await self.acquire(telegram_id)
        try:
            yield token
        finally:
            await self.release(telegram_id, token)
