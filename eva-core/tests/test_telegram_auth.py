import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

import pytest

from app.errors import Unauthorized
from app.telegram_auth import telegram_user_from_init_data, verify_init_data

BOT_TOKEN = "123456:TEST-TOKEN-FOR-UNIT-TESTS"


def make_init_data(token: str = BOT_TOKEN, *, auth_date: int | None = None, user_id: int = 42) -> str:
    fields = {
        "auth_date": str(auth_date if auth_date is not None else int(time.time())),
        "query_id": "AAF_test",
        "user": json.dumps(
            {"id": user_id, "first_name": "Test", "username": "tester", "language_code": "ru"},
            separators=(",", ":"),
        ),
    }
    check_string = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


def test_valid_init_data_is_accepted():
    parsed = verify_init_data(make_init_data(), BOT_TOKEN)
    assert parsed["user"]["id"] == 42
    assert parsed["user"]["username"] == "tester"


def test_user_helper_returns_the_user_object():
    user = telegram_user_from_init_data(make_init_data(user_id=777), BOT_TOKEN)
    assert user["id"] == 777


def test_signature_from_another_bot_is_rejected():
    forged = make_init_data(token="999:ANOTHER-BOT")
    with pytest.raises(Unauthorized):
        verify_init_data(forged, BOT_TOKEN)


def test_tampered_payload_is_rejected():
    init_data = make_init_data()
    tampered = init_data.replace("Test", "Evil")
    with pytest.raises(Unauthorized):
        verify_init_data(tampered, BOT_TOKEN)


def test_missing_hash_is_rejected():
    with pytest.raises(Unauthorized):
        verify_init_data("auth_date=1&user=%7B%7D", BOT_TOKEN)


def test_expired_init_data_is_rejected():
    old = make_init_data(auth_date=int(time.time()) - 60 * 60 * 48)
    with pytest.raises(Unauthorized):
        verify_init_data(old, BOT_TOKEN)


def test_missing_bot_token_is_rejected():
    with pytest.raises(Unauthorized):
        verify_init_data(make_init_data(), "")
