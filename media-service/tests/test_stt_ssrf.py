"""Проверка адреса провайдера перед отправкой туда чужого аудио.

base_url задаёт администратор, то есть это управляемый снаружи вход для
запроса, который сервер делает изнутри доверенной сети. Тесты проверяют
именно те адреса, которыми такую дыру и эксплуатируют.
"""

from __future__ import annotations

import pytest

from app.stt.ssrf import UnsafeUrlError, check_redirect_chain, check_url


@pytest.mark.parametrize(
    "url",
    [
        "https://api.deepgram.com/v1/listen",
        "https://api.openai.com/v1",
        "https://openrouter.ai/api/v1",
        "https://us-central1-speech.googleapis.com",
        "wss://api.deepgram.com/v1/listen",
    ],
)
def test_public_provider_endpoints_pass(url):
    assert check_url(url).host


@pytest.mark.parametrize(
    ("url", "why"),
    [
        ("http://api.deepgram.com", "http не шифрует аудио"),
        ("ftp://example.com/audio", "не тот протокол"),
        ("file:///etc/passwd", "чтение локальных файлов"),
        ("gopher://example.com", "экзотическая схема"),
        ("https://localhost/v1", "сам media-service"),
        ("https://127.0.0.1/v1", "loopback"),
        ("https://[::1]/v1", "loopback IPv6"),
        ("https://[::ffff:127.0.0.1]/v1", "IPv4-mapped обход loopback"),
        ("https://169.254.169.254/latest/meta-data/", "метаданные облака"),
        ("https://metadata.google.internal/", "метаданные GCP по имени"),
        ("https://10.1.2.3/v1", "приватная сеть"),
        ("https://192.168.0.5/v1", "домашняя сеть"),
        ("https://172.17.0.2/v1", "сеть Docker"),
        ("https://100.64.0.1/v1", "CGNAT"),
        ("https://valkey.local/v1", "соседний контейнер стека"),
        ("https://user:secret@api.openai.com/v1", "учётные данные в адресе"),
        ("https:///v1", "нет хоста"),
    ],
)
def test_dangerous_urls_are_refused(url, why):
    with pytest.raises(UnsafeUrlError):
        check_url(url)


def test_private_endpoint_allowed_only_with_explicit_permission():
    """Self-hosted STT — законный сценарий, но требует явного разрешения."""
    with pytest.raises(UnsafeUrlError):
        check_url("https://192.168.1.50:8443/v1")
    assert check_url("https://192.168.1.50:8443/v1", allow_private=True).is_private


def test_loopback_stays_refused_even_when_private_is_allowed():
    """Разрешение на приватную сеть не должно открывать сам контейнер."""
    for url in ("https://localhost/v1", "https://127.0.0.1/v1"):
        with pytest.raises(UnsafeUrlError):
            check_url(url, allow_private=True)


def test_redirect_chain_is_rechecked():
    """302 на внутренний адрес обошёл бы проверку исходного URL."""
    with pytest.raises(UnsafeUrlError):
        check_redirect_chain([
            "https://api.openai.com/v1",
            "https://169.254.169.254/latest/meta-data/",
        ])


def test_redirect_chain_is_bounded():
    with pytest.raises(UnsafeUrlError):
        check_redirect_chain(["https://api.openai.com/v1"] * 9)


def test_error_message_is_safe_to_show():
    """Сообщения составлены нами и не содержат внутренностей запроса."""
    with pytest.raises(UnsafeUrlError) as caught:
        check_url("http://api.deepgram.com/v1/listen?token=leak")
    assert "leak" not in str(caught.value)
