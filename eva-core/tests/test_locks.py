"""Lock behaviour, exercised against a minimal in-memory Valkey stand-in.

The stand-in implements exactly the four operations UserLocks uses
(SET NX EX, TTL, EVAL of the compare-and-delete script, DEL/EXISTS), so
the test covers the real code path rather than a mock of it.
"""

import pytest

from app.errors import UserBusy
from app.locks import UserLocks


class FakeRedis:
    def __init__(self):
        self.store: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        if ex is not None:
            self.ttls[key] = ex
        return True

    async def ttl(self, key):
        return self.ttls.get(key, -1)

    async def eval(self, _script, _numkeys, key, arg):
        # mirrors the Lua compare-and-delete
        if self.store.get(key) == arg:
            del self.store[key]
            self.ttls.pop(key, None)
            return 1
        return 0

    async def delete(self, key):
        existed = key in self.store
        self.store.pop(key, None)
        self.ttls.pop(key, None)
        return 1 if existed else 0

    async def exists(self, key):
        return 1 if key in self.store else 0


@pytest.mark.asyncio
async def test_second_message_from_same_user_is_rejected():
    locks = UserLocks(FakeRedis(), ttl=30)
    await locks.acquire(1001)
    with pytest.raises(UserBusy) as excinfo:
        await locks.acquire(1001)
    assert excinfo.value.retryable is True
    assert excinfo.value.details["retry_after_seconds"] == 30


@pytest.mark.asyncio
async def test_different_users_do_not_block_each_other():
    locks = UserLocks(FakeRedis(), ttl=30)
    await locks.acquire(1001)
    await locks.acquire(1002)  # must not raise


@pytest.mark.asyncio
async def test_lock_is_released_and_can_be_taken_again():
    locks = UserLocks(FakeRedis(), ttl=30)
    token = await locks.acquire(1001)
    assert await locks.release(1001, token) is True
    await locks.acquire(1001)


@pytest.mark.asyncio
async def test_release_with_a_foreign_token_is_a_no_op():
    redis = FakeRedis()
    locks = UserLocks(redis, ttl=30)
    await locks.acquire(1001)
    assert await locks.release(1001, "not-my-token") is False
    assert await locks.is_locked(1001) is True


@pytest.mark.asyncio
async def test_hold_releases_even_when_the_body_raises():
    locks = UserLocks(FakeRedis(), ttl=30)
    with pytest.raises(RuntimeError):
        async with locks.hold(1001):
            raise RuntimeError("letta blew up")
    assert await locks.is_locked(1001) is False


@pytest.mark.asyncio
async def test_force_release_clears_a_stuck_lock():
    locks = UserLocks(FakeRedis(), ttl=30)
    await locks.acquire(1001)
    assert await locks.force_release(1001) is True
    assert await locks.is_locked(1001) is False
