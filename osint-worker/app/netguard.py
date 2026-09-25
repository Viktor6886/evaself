"""Исходящие запросы только к публичным адресам.

Сборщик ходит по адресам из наборов правил (WhatsMyName, Sherlock), но
адрес профиля собирается из шаблона и имени, а ответ сайта может
перенаправить куда угодно — в том числе на `127.0.0.1`, на metadata
облака или на соседний контейнер сети compose. Поэтому каждый шаг
проверяется заново: имя хоста разрешается, и все его адреса обязаны быть
публичными. Редиректы идут вручную, по одному, с той же проверкой.

Ограничение, которое остаётся: между проверкой адреса и соединением DNS
может ответить иначе (DNS rebinding). Сервис не видит внутренних
секретов и живёт в сети `tools`, где нет PostgreSQL, Valkey и App Server,
так что окно обходится дорого атакующему и дёшево нам.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

MAX_REDIRECTS = 3
MAX_BODY_BYTES = 512 * 1024
ALLOWED_PORTS = {None, 80, 443}

Resolver = Callable[[str], Awaitable[list[str]]]


class UnsafeTarget(Exception):
    """Адрес ведёт не в публичный интернет."""


async def system_resolver(host: str) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return sorted({info[4][0] for info in infos})


def is_public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    return address.is_global and not address.is_multicast


async def assert_public_url(url: str, resolver: Resolver = system_resolver) -> None:
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise UnsafeTarget("scheme")
    if parts.username or parts.password:
        raise UnsafeTarget("credentials")
    if parts.port not in ALLOWED_PORTS:
        raise UnsafeTarget("port")
    host = parts.hostname
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    addresses = [str(literal)] if literal else await resolver(host)
    if not addresses or not all(is_public_ip(address) for address in addresses):
        raise UnsafeTarget("address")


@dataclass
class FetchResult:
    requested_url: str
    final_url: str
    status: int
    text: str
    redirects: int


async def safe_fetch(
    client: httpx.AsyncClient,
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    content: str | None = None,
    resolver: Resolver = system_resolver,
    max_redirects: int = MAX_REDIRECTS,
    max_bytes: int = MAX_BODY_BYTES,
) -> FetchResult:
    """Запрос с проверкой адреса на каждом шаге и ограниченным телом ответа."""
    current = url
    for hop in range(max_redirects + 1):
        await assert_public_url(current, resolver)
        request = client.build_request(method, current, headers=headers, content=content)
        response = await client.send(request, stream=True, follow_redirects=False)
        try:
            location = response.headers.get("location")
            if response.is_redirect and location:
                if hop == max_redirects:
                    return FetchResult(url, current, response.status_code, "", hop)
                current = urljoin(current, location)
                # После редиректа тело не отправляется повторно: так
                # поступают браузеры для 301/302/303.
                method, content = "GET", None
                continue
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) >= max_bytes:
                    break
            text = bytes(body[:max_bytes]).decode(response.encoding or "utf-8", errors="replace")
            return FetchResult(url, current, response.status_code, text, hop)
        finally:
            await response.aclose()
    raise UnsafeTarget("redirects")  # pragma: no cover — цикл возвращает раньше
