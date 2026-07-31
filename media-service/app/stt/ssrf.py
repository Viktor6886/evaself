"""Проверка base URL перед тем, как отправить туда чужое аудио.

Адрес провайдера задаёт администратор через панель. Это означает, что
поле base_url — управляемый снаружи вход для запроса, который делает
сервер изнутри доверенной сети. Без проверки достаточно вписать
http://169.254.169.254/latest/meta-data/ или http://valkey:6379, чтобы
media-service сходил туда сам и вернул ответ в панель.

Проверка идёт в два приёма, и второй важнее первого:

  1. до резолва — схема, порт, очевидно запрещённые имена;
  2. ПОСЛЕ резолва DNS и после каждого редиректа — фактический IP.

Только на первом шаге защита не работает: имя evil.example.com может
резолвиться в 127.0.0.1, и проверка «хост не localhost» его пропустит.
Поэтому решение принимается по адресам, которые вернул резолвер, а
соединение открывается на тот же самый адрес.

Приватный endpoint не запрещён совсем — self-hosted Whisper на соседнем
хосте это законный сценарий. Но он требует явного разрешения на
конкретную конфигурацию (allow_private_endpoint), которое в admin-api
закрыто sudo-подтверждением и пишется в аудит.
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

ALLOWED_SCHEMES = frozenset({"https", "wss"})

# Имена, которые не должны доходить до резолвера вообще. Список не
# заменяет проверку IP, а отсекает самые частые попытки раньше и с
# понятным сообщением.
BLOCKED_HOSTNAMES = frozenset({
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
})

# Имена сервисов из compose.yaml. Попадание сюда означает попытку
# увести аудио на соседний контейнер стека.
BLOCKED_SUFFIXES = ("localhost", ".local", ".internal", ".localdomain")

MAX_REDIRECTS = 3


class UnsafeUrlError(ValueError):
    """Адрес отвергнут. Сообщение безопасно показывать администратору."""


@dataclass(frozen=True)
class UrlCheck:
    url: str
    host: str
    port: int
    addresses: tuple[str, ...]
    is_private: bool


def _classify(address: str) -> str:
    """Куда ведёт адрес: 'public', 'private' или 'forbidden'.

    Три категории, а не две, потому что allow_private снимает запрет не
    со всего. Self-hosted Whisper живёт на адресе в локальной сети —
    это 'private' и разрешается явной настройкой. Loopback самого
    контейнера, link-local и метаданные облака — это 'forbidden': такой
    адрес не может быть чужим STT-сервером ни при каких настройках, и
    разрешать его означало бы открыть ровно ту дыру, ради которой
    проверка написана.
    """
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return "forbidden"

    # IPv4-mapped IPv6 (::ffff:127.0.0.1) обошёл бы проверки ниже.
    if ip.version == 6:
        mapped = getattr(ip, "ipv4_mapped", None)
        if mapped is not None:
            return _classify(str(mapped))

    if (
        ip.is_loopback
        or ip.is_link_local  # включая 169.254.169.254 — метаданные облака
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return "forbidden"

    if ip.is_private or (ip.version == 6 and ip.is_site_local):
        return "private"

    # ipaddress не считает CGNAT приватным, а в нём находятся и Docker
    # overlay, и внутренние сети некоторых хостеров.
    if ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"):
        return "private"

    return "public"


def _resolve(host: str, port: int) -> tuple[str, ...]:
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise UnsafeUrlError(f"не удалось разрешить имя {host}: {exc}") from exc
    addresses = tuple(sorted({info[4][0] for info in infos}))
    if not addresses:
        raise UnsafeUrlError(f"имя {host} не разрешается ни в один адрес")
    return addresses


def check_url(url: str, *, allow_private: bool = False) -> UrlCheck:
    """Проверяет один адрес. Бросает UnsafeUrlError, если он опасен.

    allow_private снимает запрет на приватные диапазоны, но не на схему
    и не на loopback-имена: self-hosted STT живёт на адресе в локальной
    сети, а не на localhost самого media-service, и не по http://.
    """
    parts = urlsplit(url.strip())

    if parts.scheme not in ALLOWED_SCHEMES:
        raise UnsafeUrlError(
            f"схема {parts.scheme or '(пусто)'} запрещена; разрешены https:// и wss://"
        )
    if not parts.hostname:
        raise UnsafeUrlError("в адресе нет имени хоста")
    if parts.username or parts.password:
        raise UnsafeUrlError("учётные данные в адресе не допускаются")

    host = parts.hostname.lower().rstrip(".")
    if host in BLOCKED_HOSTNAMES or host.endswith(BLOCKED_SUFFIXES):
        raise UnsafeUrlError(f"адрес {host} указывает внутрь инфраструктуры")

    port = parts.port or (443 if parts.scheme in ("https", "wss") else 0)
    if not 1 <= port <= 65535:
        raise UnsafeUrlError(f"недопустимый порт {port}")

    # Литеральный IP в адресе проверяем без резолвера.
    try:
        ipaddress.ip_address(host)
        addresses: tuple[str, ...] = (host,)
    except ValueError:
        addresses = _resolve(host, port)

    classified = {addr: _classify(addr) for addr in addresses}

    forbidden = [addr for addr, kind in classified.items() if kind == "forbidden"]
    if forbidden:
        raise UnsafeUrlError(
            f"{host} разрешается в адрес {forbidden[0]}, который не может быть "
            "внешним сервисом распознавания"
        )

    private = [addr for addr, kind in classified.items() if kind == "private"]
    if private and not allow_private:
        raise UnsafeUrlError(
            f"{host} разрешается в непубличный адрес {private[0]}; "
            "для self-hosted endpoint включите отдельное разрешение"
        )

    return UrlCheck(
        url=url.strip(),
        host=host,
        port=port,
        addresses=addresses,
        is_private=bool(private),
    )


def check_redirect_chain(urls: list[str], *, allow_private: bool = False) -> None:
    """Перепроверяет каждый адрес после редиректа.

    Провайдер, отвечающий 302 на внутренний адрес, обошёл бы проверку
    исходного URL целиком. Число переходов ограничено: бесконечная
    цепочка редиректов — тоже отказ, а не повод ходить по ней вечно.
    """
    if len(urls) > MAX_REDIRECTS:
        raise UnsafeUrlError(f"слишком много редиректов (более {MAX_REDIRECTS})")
    for url in urls:
        check_url(url, allow_private=allow_private)


def safe_error_message(exc: Exception) -> str:
    """Текст ошибки, который можно показать администратору.

    Сообщения UnsafeUrlError составлены здесь и безопасны. Всё
    остальное сводится к общей фразе: в тексте исключения httpx может
    оказаться полный URL с query-параметрами.
    """
    if isinstance(exc, UnsafeUrlError):
        return str(exc)
    return "адрес отклонён проверкой безопасности"
