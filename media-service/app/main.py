"""Evaself media service.

Handles everything Eva needs around audio and files:

  * download a Telegram file by file_id
  * convert Telegram OGG/Opus (and anything else) for ASR
  * call an OpenAI-compatible ASR endpoint
  * call an OpenAI-compatible TTS endpoint and return a Telegram voice note
  * probe media (duration, codec) so quotas can be charged in minutes
  * delete every temporary file, always

Called only from inside evaself-network — it is never routed by Caddy.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import shutil
import time
import uuid
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .audio import MediaError, probe, to_asr_wav, to_telegram_voice

VERSION = "0.1.0"

log = logging.getLogger("media")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

WORK_DIR = Path(os.environ.get("MEDIA_WORK_DIR", "/data/media"))
MAX_UPLOAD_BYTES = int(os.environ.get("MEDIA_MAX_UPLOAD_MB", "50")) * 1024 * 1024
MAX_AUDIO_SECONDS = int(os.environ.get("MEDIA_MAX_AUDIO_SECONDS", "1800"))
TMP_TTL_SECONDS = int(os.environ.get("MEDIA_TMP_TTL_SECONDS", "900"))

ASR_BASE_URL = os.environ.get("MEDIA_ASR_BASE_URL", "").rstrip("/")
ASR_API_KEY = os.environ.get("MEDIA_ASR_API_KEY", "")
ASR_MODEL = os.environ.get("MEDIA_ASR_MODEL", "whisper-1")

TTS_BASE_URL = os.environ.get("MEDIA_TTS_BASE_URL", "").rstrip("/")
TTS_API_KEY = os.environ.get("MEDIA_TTS_API_KEY", "")
TTS_MODEL = os.environ.get("MEDIA_TTS_MODEL", "tts-1")
TTS_VOICE = os.environ.get("MEDIA_TTS_VOICE", "nova")

TELEGRAM_TOKEN = os.environ.get("EVA_TELEGRAM_BOT_TOKEN", "")
TELEGRAM_API = "https://api.telegram.org"

# Shared secret presented by eva-agent-service. The service is not routed by
# Caddy, but "not routed" is not "not reachable": every other container on the
# compose network can address it, and these endpoints spend the bot token and
# the paid ASR/TTS keys.
SERVICE_TOKEN = os.environ.get("MEDIA_SERVICE_TOKEN", "")


def require_service_token(x_media_key: str | None = Header(default=None)) -> None:
    """Reject unauthenticated callers whenever a token is configured."""
    if not SERVICE_TOKEN:
        # Empty token keeps an already-running installation working after an
        # upgrade; eva-agent-service logs a warning about it at boot.
        return
    if x_media_key is None or not secrets.compare_digest(x_media_key, SERVICE_TOKEN):
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "code": "unauthorized",
                    "message": "X-Media-Key is missing or wrong",
                    "retryable": False,
                }
            },
        )


def _error(code: str, message: str, status: int = 400, *, details: str | None = None):
    body = {"error": {"code": code, "message": message, "retryable": status >= 500}}
    if details:
        body["error"]["details"] = details
    return JSONResponse(status_code=status, content=body)


# =====================================================================
# temp-file handling
# =====================================================================
class Workspace:
    """A per-request directory that is always removed afterwards."""

    def __init__(self, root: Path):
        self.path = root / f"job-{uuid.uuid4().hex}"

    def __enter__(self) -> Path:
        self.path.mkdir(parents=True, exist_ok=True)
        return self.path

    def __exit__(self, *_exc) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


async def _sweep_temp_files() -> None:
    """Safety net: remove leftovers from crashed requests."""
    while True:
        cutoff = time.time() - TMP_TTL_SECONDS
        try:
            for entry in WORK_DIR.glob("job-*"):
                with suppress(OSError):
                    if entry.stat().st_mtime < cutoff:
                        shutil.rmtree(entry, ignore_errors=True)
                        log.info("swept stale workspace %s", entry.name)
        except Exception as exc:  # noqa: BLE001 - a sweeper must never die
            log.warning("temp sweep failed: %s", exc)
        await asyncio.sleep(max(TMP_TTL_SECONDS // 3, 60))


@asynccontextmanager
async def lifespan(app: FastAPI):
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    app.state.http = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=15.0))
    sweeper = asyncio.create_task(_sweep_temp_files())
    log.info("media service %s ready (workdir=%s)", VERSION, WORK_DIR)
    try:
        yield
    finally:
        sweeper.cancel()
        with suppress(asyncio.CancelledError):
            await sweeper
        await app.state.http.aclose()


app = FastAPI(title="Evaself media service", version=VERSION, lifespan=lifespan)


# =====================================================================
# models
# =====================================================================
class TelegramTranscribeRequest(BaseModel):
    file_id: str = Field(min_length=1)
    language: str | None = None
    prompt: str | None = None


class TtsRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    voice: str | None = None
    model: str | None = None
    # "voice" => OGG/Opus for a Telegram voice note, "mp3" => plain file
    format: str = "voice"


# =====================================================================
# health
# =====================================================================
@app.get("/health")
async def health() -> dict:
    ffmpeg_ok = shutil.which("ffmpeg") is not None
    return {
        "service": "media-service",
        "version": VERSION,
        "status": "ok" if ffmpeg_ok else "degraded",
        "ffmpeg": ffmpeg_ok,
        "asr_configured": bool(ASR_BASE_URL and ASR_API_KEY),
        "tts_configured": bool(TTS_BASE_URL and TTS_API_KEY),
        "auth_required": bool(SERVICE_TOKEN),
        "work_dir": str(WORK_DIR),
    }


# =====================================================================
# probing
# =====================================================================
@app.post("/probe", dependencies=[Depends(require_service_token)])
async def probe_upload(file: UploadFile = File(...)):
    with Workspace(WORK_DIR) as work:
        try:
            source = await _save_upload(file, work)
        except MediaError as exc:
            return _error("upload_too_large", exc.message, 413)
        try:
            return await probe(source)
        except MediaError as exc:
            return _error("probe_failed", exc.message, 422, details=exc.details)


# =====================================================================
# transcription
# =====================================================================
@app.post("/transcribe", dependencies=[Depends(require_service_token)])
async def transcribe_upload(
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
    prompt: str | None = Form(default=None),
):
    """Transcribe an uploaded file (any format ffmpeg understands)."""
    with Workspace(WORK_DIR) as work:
        try:
            source = await _save_upload(file, work)
        except MediaError as exc:
            return _error("upload_too_large", exc.message, 413)
        return await _transcribe_path(source, work, language, prompt)


@app.post("/telegram/transcribe", dependencies=[Depends(require_service_token)])
async def transcribe_telegram(payload: TelegramTranscribeRequest):
    """Download a Telegram voice note by file_id, then transcribe it."""
    if not TELEGRAM_TOKEN:
        return _error("telegram_not_configured", "EVA_TELEGRAM_BOT_TOKEN is not set", 503)

    with Workspace(WORK_DIR) as work:
        try:
            source = await _download_telegram_file(payload.file_id, work)
        except MediaError as exc:
            return _error("telegram_download_failed", exc.message, 502, details=exc.details)
        return await _transcribe_path(source, work, payload.language, payload.prompt)


async def _transcribe_path(
    source: Path, work: Path, language: str | None, prompt: str | None
):
    try:
        info = await probe(source)
    except MediaError as exc:
        return _error("probe_failed", exc.message, 422, details=exc.details)

    if not info["has_audio"]:
        return _error("no_audio_stream", "the file contains no audio track", 422)
    if info["duration_seconds"] > MAX_AUDIO_SECONDS:
        return _error(
            "audio_too_long",
            f"audio is {info['duration_seconds']:.0f}s, limit is {MAX_AUDIO_SECONDS}s",
            413,
        )
    if not (ASR_BASE_URL and ASR_API_KEY):
        return _error(
            "asr_not_configured",
            "MEDIA_ASR_BASE_URL / MEDIA_ASR_API_KEY are not set in .env",
            503,
        )

    wav = work / "asr.wav"
    try:
        await to_asr_wav(source, wav)
    except MediaError as exc:
        return _error("conversion_failed", exc.message, 422, details=exc.details)

    data = {"model": ASR_MODEL}
    if language:
        data["language"] = language
    if prompt:
        data["prompt"] = prompt

    try:
        with wav.open("rb") as handle:
            response = await app.state.http.post(
                f"{ASR_BASE_URL}/audio/transcriptions",
                headers={"Authorization": f"Bearer {ASR_API_KEY}"},
                data=data,
                files={"file": ("audio.wav", handle, "audio/wav")},
            )
    except httpx.TimeoutException:
        return _error("asr_timeout", "the ASR endpoint did not answer in time", 504)
    except httpx.TransportError as exc:
        return _error("asr_unavailable", f"cannot reach the ASR endpoint: {exc}", 503)

    if response.status_code >= 400:
        return _error(
            "asr_error",
            f"ASR endpoint returned {response.status_code}",
            502,
            details=response.text[:500],
        )

    try:
        body = response.json()
        text = body.get("text", "")
    except ValueError:
        text = response.text

    return {
        "text": text.strip(),
        "language": language,
        "duration_seconds": info["duration_seconds"],
        "duration_minutes": round(info["duration_seconds"] / 60.0, 3),
        "source_codec": info["audio_codec"],
    }


# =====================================================================
# speech synthesis
# =====================================================================
@app.post("/tts", dependencies=[Depends(require_service_token)])
async def synthesize(payload: TtsRequest):
    if not (TTS_BASE_URL and TTS_API_KEY):
        return _error(
            "tts_not_configured",
            "MEDIA_TTS_BASE_URL / MEDIA_TTS_API_KEY are not set in .env",
            503,
        )

    work = WORK_DIR / f"job-{uuid.uuid4().hex}"
    work.mkdir(parents=True, exist_ok=True)

    try:
        response = await app.state.http.post(
            f"{TTS_BASE_URL}/audio/speech",
            headers={"Authorization": f"Bearer {TTS_API_KEY}"},
            json={
                "model": payload.model or TTS_MODEL,
                "voice": payload.voice or TTS_VOICE,
                "input": payload.text,
                "response_format": "mp3",
            },
        )
    except httpx.TimeoutException:
        shutil.rmtree(work, ignore_errors=True)
        return _error("tts_timeout", "the TTS endpoint did not answer in time", 504)
    except httpx.TransportError as exc:
        shutil.rmtree(work, ignore_errors=True)
        return _error("tts_unavailable", f"cannot reach the TTS endpoint: {exc}", 503)

    if response.status_code >= 400:
        shutil.rmtree(work, ignore_errors=True)
        return _error(
            "tts_error",
            f"TTS endpoint returned {response.status_code}",
            502,
            details=response.text[:500],
        )

    raw = work / "speech.mp3"
    raw.write_bytes(response.content)

    if payload.format == "voice":
        out = work / "speech.ogg"
        try:
            await to_telegram_voice(raw, out)
        except MediaError as exc:
            shutil.rmtree(work, ignore_errors=True)
            return _error("voice_encoding_failed", exc.message, 422, details=exc.details)
        media_type, filename = "audio/ogg", "speech.ogg"
    else:
        out, media_type, filename = raw, "audio/mpeg", "speech.mp3"

    # The workspace is deleted after the response has been streamed.
    return FileResponse(
        path=out,
        media_type=media_type,
        filename=filename,
        background=_cleanup_task(work),
    )


# =====================================================================
# helpers
# =====================================================================
def _cleanup_task(directory: Path):
    from starlette.background import BackgroundTask

    return BackgroundTask(lambda: shutil.rmtree(directory, ignore_errors=True))


async def _save_upload(upload: UploadFile, work: Path) -> Path:
    """Stream an upload to disk, enforcing MEDIA_MAX_UPLOAD_MB."""
    name = Path(upload.filename or "upload.bin").name
    target = work / name
    written = 0
    with target.open("wb") as handle:
        while chunk := await upload.read(1024 * 256):
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                raise MediaError(
                    f"file exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit"
                )
            handle.write(chunk)
    return target


async def _download_telegram_file(file_id: str, work: Path) -> Path:
    meta = await app.state.http.get(
        f"{TELEGRAM_API}/bot{TELEGRAM_TOKEN}/getFile", params={"file_id": file_id}
    )
    if meta.status_code >= 400:
        raise MediaError("getFile failed", details=meta.text[:300])

    body = meta.json()
    if not body.get("ok"):
        raise MediaError("getFile returned ok=false", details=str(body)[:300])

    file_path = body["result"]["file_path"]
    target = work / Path(file_path).name

    async with app.state.http.stream(
        "GET", f"{TELEGRAM_API}/file/bot{TELEGRAM_TOKEN}/{file_path}"
    ) as stream:
        if stream.status_code >= 400:
            raise MediaError(f"file download returned {stream.status_code}")
        written = 0
        with target.open("wb") as handle:
            async for chunk in stream.aiter_bytes():
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise MediaError("Telegram file exceeds the configured size limit")
                handle.write(chunk)

    return target
