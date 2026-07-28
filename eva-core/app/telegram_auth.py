"""Verification of Telegram Mini App `initData`.

The WebApp served on {$DOMAIN_APP} is public, so every /public/* request
must prove which Telegram user it belongs to. Telegram signs the launch
parameters with the bot token; the check below is the documented
algorithm:

    secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
    hash       = HMAC_SHA256(key=secret_key, msg=data_check_string)

`data_check_string` is every field except `hash`, formatted as `k=v`,
sorted by key and joined with newlines.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl

from .errors import Unauthorized

# Reject launches older than this: initData is replayable until it expires.
MAX_AUTH_AGE_SECONDS = 24 * 60 * 60


def verify_init_data(
    init_data: str, bot_token: str, *, max_age: int = MAX_AUTH_AGE_SECONDS
) -> dict:
    """Return the parsed, verified initData, or raise Unauthorized."""
    if not bot_token:
        raise Unauthorized("Telegram bot token is not configured on the server")
    if not init_data:
        raise Unauthorized("missing Telegram initData")

    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = pairs.pop("hash", "")
    if not received_hash:
        raise Unauthorized("initData has no hash")

    data_check_string = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(
        secret_key, data_check_string.encode(), hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(expected, received_hash):
        raise Unauthorized("initData signature does not match")

    auth_date = pairs.get("auth_date")
    if auth_date:
        try:
            age = time.time() - int(auth_date)
        except ValueError as exc:
            raise Unauthorized("initData auth_date is not a number") from exc
        if age > max_age:
            raise Unauthorized("initData has expired, please reopen the app")

    user_raw = pairs.get("user")
    if user_raw:
        try:
            pairs["user"] = json.loads(user_raw)
        except json.JSONDecodeError as exc:
            raise Unauthorized("initData user payload is not valid JSON") from exc

    return pairs


def telegram_user_from_init_data(init_data: str, bot_token: str) -> dict:
    """Convenience wrapper returning just the Telegram user object."""
    verified = verify_init_data(init_data, bot_token)
    user = verified.get("user")
    if not isinstance(user, dict) or "id" not in user:
        raise Unauthorized("initData does not contain a user")
    return user
