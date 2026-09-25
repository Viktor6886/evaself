import httpx
import pytest

from app.netguard import UnsafeTarget, assert_public_url, is_public_ip, safe_fetch
from tests.conftest import public_resolver


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "::1",
        "fd00::1",
        "0.0.0.0",
        "100.64.0.1",
    ],
)
def test_private_and_special_addresses_are_not_public(ip):
    assert not is_public_ip(ip)


def test_public_address_is_public():
    assert is_public_ip("93.184.216.34")


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "file:///etc/passwd",
        "ftp://example.com/",
        "http://user:pw@example.com/",
        "http://example.com:8080/",
        "http://internal.service/",
    ],
)
async def test_unsafe_targets_are_rejected(url):
    with pytest.raises(UnsafeTarget):
        await assert_public_url(url, public_resolver)


async def test_redirect_to_internal_address_is_rejected():
    def handler(request):
        if request.url.host == "site.example":
            return httpx.Response(302, headers={"location": "http://internal.service/admin"})
        return httpx.Response(200, text="secret")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(UnsafeTarget):
            await safe_fetch(client, "https://site.example/u/alice", resolver=public_resolver)


async def test_redirects_are_followed_with_limit_and_body_is_bounded():
    def handler(request):
        if request.url.path == "/start":
            return httpx.Response(301, headers={"location": "/final"})
        return httpx.Response(200, text="x" * 2000)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await safe_fetch(client, "https://site.example/start", resolver=public_resolver, max_bytes=100)
    assert result.final_url == "https://site.example/final"
    assert result.redirects == 1
    assert len(result.text) == 100
