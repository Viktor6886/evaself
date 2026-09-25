"""Общие предусловия тестов osint-worker.

Сервис отказывается стартовать в production без OSINT_WORKER_TOKEN, а
набор тестов — среда разработки. Сеть в тестах не используется: HTTP
подменяется httpx.MockTransport, DNS — фейковым резолвером.
"""

import os
from pathlib import Path

import pytest

os.environ.setdefault("EVA_ENV", "development")

FIXTURES = Path(__file__).parent / "fixtures"


async def public_resolver(host: str) -> list[str]:
    """Все тестовые хосты «разрешаются» в публичный адрес, кроме internal.*."""
    if host.startswith("internal."):
        return ["10.0.0.5"]
    return ["93.184.216.34"]


@pytest.fixture
def fixtures() -> Path:
    return FIXTURES
