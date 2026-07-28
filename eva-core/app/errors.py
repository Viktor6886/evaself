"""Unified error handling.

Everything that can go wrong between n8n and Letta is mapped onto a single
JSON shape so the workflows only ever have to inspect one field:

    {"error": {"code": "letta_timeout", "message": "...", "retryable": true}}
"""

from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse


class EvaError(Exception):
    """Base class for every error Eva Core reports to its callers."""

    code = "internal_error"
    status_code = 500
    retryable = False

    def __init__(self, message: str, *, details: Any = None):
        super().__init__(message)
        self.message = message
        self.details = details

    def payload(self) -> dict:
        body: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.details is not None:
            body["details"] = self.details
        return {"error": body}


class Unauthorized(EvaError):
    code = "unauthorized"
    status_code = 401


class NotFound(EvaError):
    code = "not_found"
    status_code = 404


class BadRequest(EvaError):
    code = "bad_request"
    status_code = 400


class UserBusy(EvaError):
    """Another message from the same user is still being processed."""

    code = "user_busy"
    status_code = 409
    retryable = True


class LettaUnavailable(EvaError):
    code = "letta_unavailable"
    status_code = 503
    retryable = True


class LettaTimeout(EvaError):
    code = "letta_timeout"
    status_code = 504
    retryable = True


class LettaBadResponse(EvaError):
    code = "letta_bad_response"
    status_code = 502
    retryable = False


class DatabaseUnavailable(EvaError):
    code = "database_unavailable"
    status_code = 503
    retryable = True


async def eva_error_handler(_request: Request, exc: EvaError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=exc.payload())


async def unhandled_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    err = EvaError(f"unhandled error: {exc.__class__.__name__}: {exc}")
    return JSONResponse(status_code=500, content=err.payload())
