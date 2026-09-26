import json

import httpx
import pytest

from app.infra import (
    InfraCollector,
    InvalidTarget,
    normalize_asn,
    normalize_domain,
    normalize_ip,
    parse_crtsh,
    parse_rdap,
)
from app.limits import CircuitBreaker
from tests.conftest import public_resolver

BOOTSTRAP = {
    "dns": {
        "services": [
            [["com", "net"], ["https://rdap.verisign.example/com/v1/"]],
            [["ru"], ["https://rdap.tcinet.example/"]],
        ]
    },
    "ipv4": {
        "services": [
            [["193.0.0.0/8"], ["https://rdap.db.ripe.example/"]],
            [["8.0.0.0/8"], ["https://rdap.arin.example/registry/"]],
        ]
    },
    "ipv6": {"services": []},
    "asn": {
        "services": [
            [["3154-3353", "3354-4607"], ["https://rdap.arin.example/registry/"]],
            [["196608-213403"], ["https://rdap.db.ripe.example/"]],
        ]
    },
}

DOMAIN_RDAP = {
    "ldhName": "EXAMPLE.COM",
    "handle": "2336799_DOMAIN_COM-VRSN",
    "status": ["client transfer prohibited"],
    "events": [
        {"eventAction": "registration", "eventDate": "1995-08-14T04:00:00Z"},
        {"eventAction": "expiration", "eventDate": "2027-08-13T04:00:00Z"},
    ],
    "nameservers": [{"ldhName": "A.IANA-SERVERS.NET"}, {"ldhName": "B.IANA-SERVERS.NET."}],
    "entities": [
        {
            "roles": ["registrar"],
            "vcardArray": [
                "vcard",
                [["version", {}, "text", "4.0"], ["fn", {}, "text", "RESERVED-Internet Assigned Numbers Authority"]],
            ],
        },
        {
            "roles": ["registrant"],
            "vcardArray": [
                "vcard",
                [
                    ["kind", {}, "text", "individual"],
                    ["fn", {}, "text", "Ivan Petrov"],
                    ["tel", {}, "uri", "tel:+79120000000"],
                ],
            ],
        },
        {
            "roles": ["registrant"],
            "vcardArray": ["vcard", [["kind", {}, "text", "org"], ["fn", {}, "text", "REDACTED FOR PRIVACY"]]],
        },
        {"roles": ["administrative"], "vcardArray": ["vcard", [["org", {}, "text", "Example Holdings"]]]},
    ],
}


def test_targets_are_normalized_and_private_space_is_refused():
    assert normalize_domain("Пример.РФ.") == "xn--e1afmkfd.xn--p1ai"
    assert normalize_domain("Sub.Example.com") == "sub.example.com"
    assert normalize_asn("AS3333") == 3333
    assert normalize_ip("8.8.8.8") == "8.8.8.8"
    for bad in ("10.0.0.1", "127.0.0.1", "192.168.1.1", "::1"):
        with pytest.raises(InvalidTarget):
            normalize_ip(bad)
    for bad in ("localhost", "a", "exa mple.com", "http://x.com"):
        with pytest.raises(InvalidTarget):
            normalize_domain(bad)


def test_rdap_keeps_organizations_and_drops_private_persons():
    parsed = parse_rdap("domain", DOMAIN_RDAP)
    assert parsed["name"] == "example.com"
    assert parsed["registrar"] == "RESERVED-Internet Assigned Numbers Authority"
    # Человек-регистрант и скрытая запись не извлекаются.
    assert parsed["registrant_organizations"] == []
    assert "Ivan Petrov" not in json.dumps(parsed)
    assert "+7912" not in json.dumps(parsed)
    assert parsed["nameservers"] == ["a.iana-servers.net", "b.iana-servers.net"]
    assert parsed["events"]["registration"] == "1995-08-14T04:00:00Z"


def test_certificate_log_names_are_scoped_to_the_domain():
    rows = [
        {
            "name_value": "*.example.com\nwww.example.com",
            "issuer_name": "C=US, O=Let's Encrypt, CN=R3",
            "not_before": "2024-01-01T00:00:00",
        },
        {
            "name_value": "mail.example.com\nexample.com.evil.org\nexample.org",
            "issuer_name": 'O="DigiCert Inc"',
            "not_before": "2023-05-01T00:00:00",
        },
    ]
    parsed = parse_crtsh("example.com", rows)
    assert parsed["names"] == ["example.com", "mail.example.com", "www.example.com"]
    assert parsed["certificates"] == 2
    assert parsed["first_seen"] == "2023-05-01T00:00:00"
    assert set(parsed["issuers"]) == {"Let's Encrypt", "DigiCert Inc"}


def _collector(handler, breaker=None):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return InfraCollector(client, resolver=public_resolver, breaker=breaker), client


def _registry(request: httpx.Request) -> httpx.Response:
    url = str(request.url)
    for kind, payload in BOOTSTRAP.items():
        if url == f"https://data.iana.org/rdap/{kind}.json":
            return httpx.Response(200, json=payload)
    if url == "https://rdap.verisign.example/com/v1/domain/example.com":
        return httpx.Response(200, json=DOMAIN_RDAP)
    if url == "https://rdap.db.ripe.example/ip/193.0.6.139":
        return httpx.Response(
            200,
            json={
                "handle": "193.0.0.0 - 193.0.7.255",
                "name": "RIPE-NCC",
                "country": "NL",
                "startAddress": "193.0.0.0",
                "endAddress": "193.0.7.255",
                "cidr0_cidrs": [{"v4prefix": "193.0.0.0", "length": 21}],
                "entities": [
                    {
                        "roles": ["registrant"],
                        "vcardArray": ["vcard", [["kind", {}, "text", "org"], ["fn", {}, "text", "RIPE NCC"]]],
                    }
                ],
            },
        )
    if url == "https://rdap.db.ripe.example/autnum/196615":
        return httpx.Response(200, json={"handle": "AS196615", "name": "EXAMPLE-AS", "startAutnum": 196615})
    if url.startswith("https://stat.ripe.net/data/prefix-overview/"):
        return httpx.Response(
            200,
            json={
                "data": {
                    "resource": "193.0.6.139",
                    "announced": True,
                    "asns": [{"asn": 3333, "holder": "RIPE-NCC-AS"}],
                    "block": {"resource": "193.0.0.0/8", "name": "IANA IPv4", "desc": "RIPE NCC"},
                }
            },
        )
    if url.startswith("https://crt.sh/"):
        return httpx.Response(
            200, json=[{"name_value": "www.example.com", "issuer_name": "O=Test CA", "not_before": "2024-01-01"}]
        )
    return httpx.Response(404, json={})


async def test_rdap_uses_iana_bootstrap_and_the_most_specific_registry():
    collector, client = _collector(_registry)
    async with client:
        domain = await collector.rdap("domain", "example.com")
        ip = await collector.rdap("ip", "193.0.6.139")
        asn = await collector.rdap("asn", "196615")
        missing = await collector.rdap("domain", "example.zz")
    assert domain.status == "ok" and domain.data["registrar"].startswith("RESERVED")
    assert ip.data["cidrs"] == ["193.0.0.0/21"] and ip.data["organizations"] == ["RIPE NCC"]
    assert asn.data["name"] == "EXAMPLE-AS"
    assert missing.data == {"found": False}
    # Файлы bootstrap берутся один раз и кэшируются.
    assert domain.requests == 2 and ip.requests == 2 and asn.requests == 2


async def test_ripestat_and_certificates():
    collector, client = _collector(_registry)
    async with client:
        prefix = await collector.ripestat("ip", "193.0.6.139")
        ct = await collector.certificates("example.com")
    assert prefix.data["asns"] == [{"asn": 3333, "holder": "RIPE-NCC-AS"}]
    assert ct.data["names"] == ["www.example.com"]


async def test_rate_limited_registry_degrades_instead_of_reporting_nothing():
    collector, client = _collector(
        lambda request: httpx.Response(429, text="Too Many Requests"), CircuitBreaker(threshold=1)
    )
    async with client:
        first = await collector.certificates("example.com")
        second = await collector.certificates("example.com")
    assert first.status == "degraded" and first.degraded_reason == "rate_limited"
    # Выключатель открыт: второй раз источник не опрашивается.
    assert second.status == "degraded" and second.requests == 0


async def test_redirect_into_the_internal_network_is_not_followed():
    def handler(request):
        if request.url.host == "data.iana.org":
            return httpx.Response(302, headers={"location": "http://internal.metadata/"})
        return httpx.Response(404)

    collector, client = _collector(handler)
    async with client:
        result = await collector.rdap("domain", "example.com")
    assert result.status == "degraded"


class FakeAnswer(list):
    pass


class FakeRecord:
    def __init__(self, text, strings=None):
        self._text = text
        self.strings = strings

    def to_text(self):
        return self._text


class FakeResolver:
    lifetime = 0

    async def resolve(self, name, rtype):
        import dns.resolver

        table = {
            "A": [FakeRecord("93.184.216.34")],
            "MX": [FakeRecord("10 mail.example.com.")],
            "TXT": [FakeRecord("", [b"v=spf1 -all"])],
        }
        if rtype not in table:
            raise dns.resolver.NoAnswer()
        return FakeAnswer(table[rtype])


async def test_dns_records_are_collected_through_the_resolver():
    collector = InfraCollector(httpx.AsyncClient(), dns_resolver=FakeResolver())
    result = await collector.dns("example.com")
    assert result.status == "ok"
    assert result.data["records"] == {"A": ["93.184.216.34"], "MX": ["10 mail.example.com."], "TXT": ["v=spf1 -all"]}


def test_registry_without_https_is_not_used():
    from app.infra import _https

    assert _https(["http://rdap.example/", "https://rdap.example/"]) == "https://rdap.example/"
    assert _https(["http://rdap.example/"]) is None
