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

from .audio import (
    MediaError,
    convert,
    make_test_tone,
    probe,
    to_asr_wav,
    to_telegram_voice,
)
from .runtime_config import RuntimeConfig
from .stt import (
    SttAudioInput,
    SttError,
    SttProviderRegistry,
    SttResolvedConfig,
    SttRoutingService,
    SttRuntime,
)

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
ASR_LANGUAGE = os.environ.get("MEDIA_ASR_LANGUAGE", "")

TTS_BASE_URL = os.environ.get("MEDIA_TTS_BASE_URL", "").rstrip("/")
TTS_API_KEY = os.environ.get("MEDIA_TTS_API_KEY", "")
TTS_MODEL = os.environ.get("MEDIA_TTS_MODEL", "tts-1")
TTS_VOICE = os.environ.get("MEDIA_TTS_VOICE", "nova")

# Переопределения из админ-панели поверх окружения. Значения из .env
# остаются значениями по умолчанию — установка без панели работает как
# раньше.
RUNTIME = RuntimeConfig(
    WORK_DIR / "runtime-config.json",
    {
        "asr": {
            "base_url": ASR_BASE_URL,
            "api_key": ASR_API_KEY,
            "model": ASR_MODEL,
            "language": ASR_LANGUAGE,
        },
        "tts": {
            "base_url": TTS_BASE_URL,
            "api_key": TTS_API_KEY,
            "model": TTS_MODEL,
            "voice": TTS_VOICE,
            "response_format": "mp3",
        },
        "telegram": {"bot_token": os.environ.get("EVA_TELEGRAM_BOT_TOKEN", "")},
    },
)

# Реестр STT-провайдеров и действующий снимок маршрутов. Снимок
# присылает admin-api; RUNTIME выше остаётся для установок, которые ещё
# не завели ни одной конфигурации в панели — см. _transcribe_path.
STT_RUNTIME = SttRuntime(WORK_DIR / "stt-runtime.json")
STT_REGISTRY: SttProviderRegistry | None = None
STT_ROUTER: SttRoutingService | None = None

TELEGRAM_API = "https://api.telegram.org"


def telegram_token() -> str:
    """Действующий токен бота.

    Читается на каждый вызов, а не один раз при импорте: переезд на
    другого бота меняет токен без пересоздания контейнера, и запомненное
    при старте значение означало бы, что голосовые перестают
    распознаваться — молча, с общим «не получилось».
    """
    return RUNTIME.telegram().get("bot_token", "")

# Shared secret presented by eva-agent-service. The service is not routed by
# Caddy, but "not routed" is not "not reachable": every other container on the
# compose network can address it, and these endpoints spend the bot token and
# the paid ASR/TTS keys.
SERVICE_TOKEN = os.environ.get("MEDIA_SERVICE_TOKEN", "").strip()

# Окружение. Неизвестное или незаданное значение считается production:
# ошибиться в сторону «не запустились» дешевле, чем в сторону «подняли
# незащищённый сервис». Установка настраивается configure.sh, который
# генерирует MEDIA_SERVICE_TOKEN сам, а ensure-env-defaults.sh дописывает
# ключ при обновлении, поэтому пустой токен в production — это ошибка
# конфигурации, а не штатный случай.
EVA_ENV = os.environ.get("EVA_ENV", "production").strip().lower()
IS_PRODUCTION = EVA_ENV not in {"development", "dev", "local", "test"}

if IS_PRODUCTION and not SERVICE_TOKEN:
    raise RuntimeError(
        f"MEDIA_SERVICE_TOKEN пуст при EVA_ENV={EVA_ENV}. media-service тратит "
        "токен бота и платные ключи ASR/TTS, и без общего секрета его может "
        "вызвать любой контейнер сети compose. Задайте MEDIA_SERVICE_TOKEN "
        "в .env (`make configure` генерирует его сам) или выставьте "
        "EVA_ENV=development."
    )


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
    global STT_REGISTRY, STT_ROUTER
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    app.state.http = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=15.0))
    # Реестру нужен тот же HTTP-клиент: пул соединений один на сервис.
    STT_REGISTRY = SttProviderRegistry(app.state.http)
    STT_ROUTER = SttRoutingService(STT_RUNTIME, STT_REGISTRY)
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


# Форматы ответа синтеза и расширение файла для каждого. Список
# закрытый: значение уходит провайдеру как есть, а произвольная строка
# из панели превратилась бы в его 400 вместо нашей понятной ошибки.
TTS_FORMATS = {"mp3": ".mp3", "wav": ".wav", "pcm": ".pcm", "opus": ".opus"}


def _tts_format(value: str | None) -> str:
    name = (value or "").strip().lower()
    return name if name in TTS_FORMATS else "mp3"


class TtsRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    voice: str | None = None
    model: str | None = None
    # Описание манеры речи: темп, интонация, характер. Пусто — берётся
    # значение из конфигурации, заданной в панели.
    voice_prompt: str | None = Field(default=None, max_length=2000)
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
        "asr_configured": bool(RUNTIME.asr().get("base_url") and RUNTIME.asr().get("api_key")),
        "tts_configured": bool(RUNTIME.tts().get("base_url") and RUNTIME.tts().get("api_key")),
        # Отдельно от asr_configured: реестр и устаревшие переменные —
        # разные источники, и оператор должен видеть, какой из них
        # действует.
        "stt_registry_configured": STT_RUNTIME.is_configured(),
        "stt_snapshot_version": STT_RUNTIME.describe()["version"],
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
    if not telegram_token():
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
    asr = RUNTIME.asr()
    if not (asr.get("base_url") and asr.get("api_key")):
        return _error(
            "asr_not_configured",
            "ASR не настроен: задайте Base URL и ключ в панели или в .env",
            503,
        )

    wav = work / "asr.wav"
    try:
        await to_asr_wav(source, wav)
    except MediaError as exc:
        return _error("conversion_failed", exc.message, 422, details=exc.details)

    data = {"model": asr["model"]}
    # Язык из запроса важнее настройки: конкретное сообщение может быть
    # на другом языке, чем обычно у пользователя.
    if language or asr.get("language"):
        data["language"] = language or asr["language"]
    if prompt:
        data["prompt"] = prompt

    try:
        with wav.open("rb") as handle:
            response = await app.state.http.post(
                f"{asr['base_url']}/audio/transcriptions",
                headers={"Authorization": f"Bearer {asr['api_key']}"},
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
# STT: реестр провайдеров, снимок маршрутов, распознавание по сценарию
# =====================================================================
class SttTranscribeRequest(BaseModel):
    """Запрос распознавания по сценарию.

    Либо file_id (Telegram скачает media-service сам), либо загруженный
    файл через multipart-вариант эндпоинта.
    """

    use_case: str = Field(min_length=1)
    file_id: str | None = None
    language: str | None = None
    # Ключ идемпотентности. Для Telegram — file_unique_id: он не меняется
    # при повторной доставке апдейта, в отличие от file_id.
    idempotency_key: str | None = None


@app.get("/stt/provider-schemas", dependencies=[Depends(require_service_token)])
async def stt_provider_schemas() -> dict:
    """Описание форм и возможностей всех провайдеров.

    Это источник истины для админ-панели: она не знает ни одного
    параметра Deepgram или Google и строит форму по этому ответу.
    admin-api проксирует эндпоинт, чтобы не держать вторую копию правды.
    """
    if STT_REGISTRY is None:
        return _error("stt_not_ready", "сервис ещё не инициализирован", 503)
    return {"providers": STT_REGISTRY.schemas()}


@app.get("/stt/runtime", dependencies=[Depends(require_service_token)])
async def stt_runtime_state() -> dict:
    """Действующий снимок без единого символа секретов."""
    state = STT_RUNTIME.describe()
    state["faulty"] = STT_ROUTER.faulty() if STT_ROUTER else {}
    # Какие ключи сейчас пропускаются перебором. Живёт это только в
    # памяти сервиса, и раздел здоровья в панели — единственное место,
    # где картину видно целиком.
    state["keys"] = STT_ROUTER.key_state() if STT_ROUTER else {}
    return state


@app.put("/stt/runtime", dependencies=[Depends(require_service_token)])
async def stt_runtime_apply(payload: dict) -> dict:
    """Приём снимка от admin-api.

    Применяется целиком: частично обновлённый маршрут отправил бы аудио
    туда, куда администратор его не назначал. Следующий запрос
    распознавания уже использует новые значения — перезапуск контейнера
    не нужен, в этом и смысл горячего применения.
    """
    applied = STT_RUNTIME.apply(payload if isinstance(payload, dict) else {})
    if not applied.get("applied"):
        return _error(
            "stt_snapshot_invalid",
            "снимок отклонён: " + "; ".join(applied.get("errors", [])[:5]),
            400,
        )
    # Администратор что-то починил — снимаем пометки о неисправности,
    # иначе исправленная конфигурация осталась бы в чёрном списке до
    # перезапуска.
    if STT_ROUTER is not None:
        STT_ROUTER.clear_faulty()
    return applied


@app.post("/stt/transcribe", dependencies=[Depends(require_service_token)])
async def stt_transcribe(payload: SttTranscribeRequest):
    """Распознавание по сценарию: маршрут, основной провайдер, резерв."""
    if STT_ROUTER is None:
        return _error("stt_not_ready", "сервис ещё не инициализирован", 503)
    if not payload.file_id:
        return _error("stt_audio_invalid", "не передан file_id", 400)
    if not telegram_token():
        return _error("telegram_not_configured", "EVA_TELEGRAM_BOT_TOKEN is not set", 503)

    with Workspace(WORK_DIR) as work:
        try:
            source = await _download_telegram_file(payload.file_id, work)
        except MediaError as exc:
            return _error("telegram_download_failed", exc.message, 502, details=exc.details)
        return await _route_transcription(
            source, work, payload.use_case, payload.language, payload.idempotency_key
        )


@app.post("/stt/transcribe/upload", dependencies=[Depends(require_service_token)])
async def stt_transcribe_upload(
    use_case: str = Form(...),
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
    idempotency_key: str | None = Form(default=None),
):
    """То же, но для WebApp: аудио приходит загрузкой, а не по file_id."""
    if STT_ROUTER is None:
        return _error("stt_not_ready", "сервис ещё не инициализирован", 503)
    with Workspace(WORK_DIR) as work:
        try:
            source = await _save_upload(file, work)
        except MediaError as exc:
            return _error("stt_audio_too_large", exc.message, 413)
        return await _route_transcription(
            source, work, use_case, language, idempotency_key
        )


async def _route_transcription(
    source: Path,
    work: Path,
    use_case: str,
    language: str | None,
    idempotency_key: str | None,
):
    """Общий путь: проверить файл, привести к WAV, отдать маршрутизатору."""
    try:
        info = await probe(source)
    except MediaError as exc:
        return _error("stt_audio_invalid", exc.message, 422, details=exc.details)
    if not info["has_audio"]:
        return _error("stt_audio_invalid", "в файле нет звуковой дорожки", 422)
    if info["duration_seconds"] > MAX_AUDIO_SECONDS:
        return _error(
            "stt_audio_too_long",
            f"запись длиной {info['duration_seconds']:.0f} с превышает предел "
            f"{MAX_AUDIO_SECONDS} с",
            413,
        )

    wav = work / "asr.wav"
    try:
        await to_asr_wav(source, wav)
    except MediaError as exc:
        return _error("stt_audio_invalid", exc.message, 422, details=exc.details)

    audio = SttAudioInput(
        path=wav,
        duration_seconds=info["duration_seconds"],
        mime_type="audio/wav",
        filename="audio.wav",
    )
    try:
        outcome = await STT_ROUTER.transcribe(
            use_case, audio, language=language, idempotency_key=idempotency_key
        )
    except SttError as exc:
        if exc.code == "stt_route_not_configured":
            # Установка ещё не завела ни одной конфигурации в панели.
            # Поддержку MEDIA_ASR_* нельзя убирать в том же релизе,
            # который вводит реестр: `make update` не должен ломать
            # голосовые сообщения на работающем сервере. Переменные
            # объявлены устаревшими, срок удаления — в docs/stt.md.
            legacy = RUNTIME.asr()
            if legacy.get("base_url") and legacy.get("api_key"):
                log.info(
                    "маршрут «%s» не настроен — распознаю по устаревшим MEDIA_ASR_*",
                    use_case,
                )
                return await _transcribe_path(source, work, language, None)
        # Техническая причина уходит в ответ для admin-api и в лог; в
        # Telegram eva-agent-service покажет свой безопасный текст.
        log.warning("распознавание %s не удалось: %s — %s", use_case, exc.code, exc.message)
        return _error(exc.code, exc.message, 502 if exc.retryable else 422)

    result = outcome.result
    return {
        **result.as_dict(),
        "use_case": use_case,
        "duration_seconds": info["duration_seconds"],
        "duration_minutes": round(info["duration_seconds"] / 60.0, 3),
        "used_fallback": outcome.used_fallback,
        "from_cache": outcome.from_cache,
        # Телеметрию пишет admin-api: у него есть база, у media-service нет.
        "attempts": [
            {
                "config_id": attempt.config_id,
                "provider": attempt.provider,
                "model": attempt.model,
                "ok": attempt.ok,
                "latency_ms": attempt.latency_ms,
                "is_fallback": attempt.is_fallback,
                "error_code": attempt.error_code,
                "error_message": attempt.error_message,
                "provider_request_id": attempt.provider_request_id,
                # Каким ключом отработала попытка и что случилось с
                # остальными. Состояние ключей живёт в памяти этого
                # сервиса; другого способа довезти его до панели нет.
                "key_id": attempt.key_id,
                "key_label": attempt.key_label,
                "keys_tried": attempt.keys_tried,
                "key_failures": attempt.key_failures,
            }
            for attempt in outcome.attempts
        ],
    }


@app.post("/stt/test", dependencies=[Depends(require_service_token)])
async def stt_test(payload: dict):
    """Проверка конкретной конфигурации на коротком аудио.

    Конфигурация приходит в теле целиком, вместе с секретом: проверять
    надо и ещё не сохранённые правки, иначе администратор вынужден
    сохранить заведомо непроверенный ключ, чтобы его проверить.

    Тест не активирует конфигурацию и ничего не записывает в снимок.
    Аудио удаляется вместе с рабочей директорией.
    """
    if STT_REGISTRY is None:
        return _error("stt_not_ready", "сервис ещё не инициализирован", 503)

    config_raw = payload.get("config")
    if not isinstance(config_raw, dict):
        return _error("stt_config_invalid", "в запросе нет объекта config", 400)

    params = config_raw.get("params")
    config = SttResolvedConfig(
        config_id=str(config_raw.get("id") or "") or None,
        name=str(config_raw.get("name") or "проверяемая конфигурация"),
        provider=str(config_raw.get("provider") or ""),
        mode=str(config_raw.get("mode") or "batch"),
        base_url=str(config_raw.get("base_url") or ""),
        model=str(config_raw.get("model") or ""),
        params=params if isinstance(params, dict) else {},
        secret=str(config_raw.get("secret") or ""),
        timeout_ms=int(config_raw.get("timeout_ms") or 60000),
    )

    if not STT_REGISTRY.has(config.provider):
        return _error("stt_config_invalid", f"провайдер «{config.provider}» неизвестен", 400)

    adapter = STT_REGISTRY.get(config.provider)
    validation = adapter.validate(config)
    if not validation.ok:
        return {
            "success": False,
            "stage": "validation",
            "error": {"code": "stt_config_invalid", "message": "; ".join(validation.errors)},
            "warnings": validation.warnings,
        }

    # Только проверка параметров, без обращения к провайдеру и без
    # оплаты распознавания.
    if payload.get("validate_only"):
        return {
            "success": True,
            "stage": "validation",
            "provider": config.provider,
            "model": config.model,
            "warnings": validation.warnings,
        }

    with Workspace(WORK_DIR) as work:
        sample = work / "probe.wav"
        uploaded = payload.get("audio_base64")
        if uploaded:
            import base64

            # Запись из браузера — это webm/opus в Chrome и mp4/aac в
            # Safari, а не WAV. Раньше присланные байты клались прямо в
            # probe.wav и уходили провайдеру под видом WAV: Deepgram это
            # переживал, потому что определяет формат сам, а OpenAI
            # получал multipart с враньём в имени файла. Поэтому сначала
            # сохраняем как есть, а потом отдаём ffmpeg — ровно так же,
            # как поступает обычное распознавание.
            raw = work / "upload.bin"
            try:
                raw.write_bytes(base64.b64decode(str(uploaded), validate=True))
            except (ValueError, TypeError):
                return _error("stt_audio_invalid", "аудио не разбирается как base64", 400)
            try:
                info = await probe(raw)
            except MediaError as exc:
                return _error("stt_audio_invalid", exc.message, 422, details=exc.details)
            if not info["has_audio"]:
                return _error("stt_audio_invalid", "в записи нет звуковой дорожки", 422)
            duration = info["duration_seconds"]
            if duration > MAX_AUDIO_SECONDS:
                return _error("stt_audio_too_long", "тестовая запись слишком длинная", 413)
            try:
                await to_asr_wav(raw, sample)
            except MediaError as exc:
                return _error("stt_audio_invalid", exc.message, 422, details=exc.details)
        else:
            try:
                await make_test_tone(sample)
            except MediaError as exc:
                return _error("stt_sample_failed", exc.message, 500, details=exc.details)
            duration = 3.0

        audio = SttAudioInput(
            path=sample, duration_seconds=duration,
            mime_type="audio/wav", filename="probe.wav",
        )
        try:
            result = await adapter.test(config, audio)
        except SttError as exc:
            return {
                "success": False,
                "stage": "transcription",
                "provider": config.provider,
                "model": config.model,
                "error": exc.as_dict(),
                "warnings": validation.warnings,
            }

    body = {
        "success": True,
        "stage": "transcription",
        "provider": result.provider,
        "model": result.model,
        "latency_ms": result.latency_ms,
        "audio_duration_ms": int(duration * 1000),
        "transcript": result.text,
        "warnings": validation.warnings + result.warnings,
    }
    # Поля, которых провайдер не вернул, отсутствуют, а не заполняются
    # выдуманными значениями: по confidence=0.94 «чтобы было» оператор
    # примет решение, думая, что видит измеренное число.
    if result.language:
        body["language"] = result.language
    if result.confidence is not None:
        body["confidence"] = result.confidence
    if result.provider_request_id:
        body["provider_request_id"] = result.provider_request_id
    if result.upstream_provider:
        body["upstream_provider"] = result.upstream_provider
    return body


# =====================================================================
# runtime configuration and self-tests
# =====================================================================
@app.get("/config/media", dependencies=[Depends(require_service_token)])
async def read_media_config() -> dict:
    """Действующие значения. Ключи не возвращаются — только «настроен»."""
    return RUNTIME.describe()


@app.put("/config/media", dependencies=[Depends(require_service_token)])
async def write_media_config(payload: dict) -> dict:
    """Переопределения из админ-панели.

    Применяются немедленно: следующий же запрос к /transcribe или /tts
    читает новые значения. Перезапуск контейнера не требуется — в этом и
    смысл требования «смена провайдера без правки workflow».
    """
    applied = RUNTIME.update(payload if isinstance(payload, dict) else {})
    if not applied:
        return _error("nothing_to_apply", "в запросе нет известных полей", 400)
    return {"applied": applied, "config": RUNTIME.describe()}


@app.post("/tts/test", dependencies=[Depends(require_service_token)])
async def test_tts(payload: dict | None = None) -> dict:
    """Настоящий синтез короткой фразы.

    Проверяет не доступность хоста, а весь путь: адрес, ключ, модель и
    голос. Успех означает, что провайдер вернул воспроизводимый звук.
    """
    tts = RUNTIME.tts()
    if not (tts.get("base_url") and tts.get("api_key")):
        return _error("tts_not_configured", "TTS не настроен", 503)
    phrase = (payload or {}).get("text") or "Проверка синтеза речи."

    configured_format = _tts_format(tts.get("response_format"))
    prompt = (tts.get("voice_prompt") or "").strip()
    started = time.monotonic()

    # Сочетания, которые пробуются по очереди. Первое — то, что задано в
    # панели; остальные включаются, только когда провайдер отверг
    # заданное. Без этого администратор видел «провайдер вернул 400» и
    # не мог узнать, какое поле ему не нравится: у Gemini TTS это либо
    # формат (модель отдаёт PCM), либо `instructions`, документированное
    # у моделей OpenAI. Проверка стоит несколько центов и запускается
    # руками, поэтому перебор здесь уместен, а в рабочем пути — нет.
    formats = list(dict.fromkeys([configured_format, "wav", "pcm", "mp3"]))
    variants = [
        (fmt, use_prompt)
        for fmt in formats
        for use_prompt in ([True, False] if prompt else [False])
    ]

    first_failure: httpx.Response | None = None
    for index, (fmt, use_prompt) in enumerate(variants):
        try:
            response = await app.state.http.post(
                f"{tts['base_url']}/audio/speech",
                headers={"Authorization": f"Bearer {tts['api_key']}"},
                json=_speech_request(
                    model=tts["model"],
                    voice=tts["voice"],
                    text=phrase,
                    voice_prompt=prompt if use_prompt else None,
                    response_format=fmt,
                ),
            )
        except httpx.TimeoutException:
            return _error("tts_timeout", "провайдер не ответил вовремя", 504)
        except httpx.TransportError as exc:
            return _error("tts_unavailable", f"не удалось соединиться: {exc}", 503)

        if response.status_code >= 400:
            if first_failure is None:
                first_failure = response
            # 401, 402 и 404 перебором не лечатся: ключ, оплата и имя
            # модели от формата не зависят, а лишние запросы только
            # задержат ответ.
            if response.status_code in (401, 402, 403, 404) or response.status_code >= 500:
                break
            continue
        if not response.content:
            if first_failure is None:
                first_failure = response
            continue

        hint = ""
        if index > 0:
            parts = [f"формат «{fmt}»"]
            if prompt and not use_prompt:
                parts.append("без Voice Prompt")
            hint = (
                f"; заданное сочетание провайдер отверг, принято: {', '.join(parts)}"
                " — сохраните это в настройках"
            )
        return {
            "ok": True,
            "provider": tts["base_url"],
            "model": tts["model"],
            "voice": tts["voice"],
            "response_format": fmt,
            "instructions_sent": use_prompt,
            "bytes": len(response.content),
            "latency_ms": int((time.monotonic() - started) * 1000),
            "message": f"синтез выполнен, получено {len(response.content)} байт аудио{hint}",
        }

    if first_failure is None:
        return _error("tts_empty", "провайдер вернул пустой ответ", 502)
    if not first_failure.content and first_failure.status_code < 400:
        return _error("tts_empty", "провайдер вернул пустой ответ", 502)
    return _error(
        "tts_error",
        f"провайдер вернул {first_failure.status_code}",
        502,
        # Ответ провайдера — единственное место, где написано, что
        # именно ему не понравилось. Без него администратору остаётся
        # только гадать.
        details=first_failure.text[:500],
    )


@app.post("/asr/test", dependencies=[Depends(require_service_token)])
async def test_asr() -> dict:
    """Круговой тест распознавания.

    Отправляет провайдеру короткий корректный WAV, сгенерированный
    ffmpeg. Проверяется, что адрес, ключ и модель приняты и endpoint
    вернул разбираемый ответ. Это проверка тракта, а не точности:
    в записи нет речи, и пустой текст — нормальный успешный результат.
    """
    asr = RUNTIME.asr()
    if not (asr.get("base_url") and asr.get("api_key")):
        return _error("asr_not_configured", "ASR не настроен", 503)

    with Workspace(WORK_DIR) as work:
        sample = work / "probe.wav"
        try:
            await make_test_tone(sample)
        except MediaError as exc:
            return _error("sample_failed", exc.message, 500, details=exc.details)

        started = time.monotonic()
        data = {"model": asr["model"]}
        if asr.get("language"):
            data["language"] = asr["language"]
        try:
            with sample.open("rb") as handle:
                response = await app.state.http.post(
                    f"{asr['base_url']}/audio/transcriptions",
                    headers={"Authorization": f"Bearer {asr['api_key']}"},
                    data=data,
                    files={"file": ("probe.wav", handle, "audio/wav")},
                )
        except httpx.TimeoutException:
            return _error("asr_timeout", "провайдер не ответил вовремя", 504)
        except httpx.TransportError as exc:
            return _error("asr_unavailable", f"не удалось соединиться: {exc}", 503)

    if response.status_code >= 400:
        return _error(
            "asr_error",
            f"провайдер вернул {response.status_code}",
            502,
            details=response.text[:300],
        )
    try:
        text = response.json().get("text", "")
    except ValueError:
        return _error("asr_invalid_response", "ответ не разбирается как JSON", 502,
                      details=response.text[:300])

    return {
        "ok": True,
        "provider": asr["base_url"],
        "model": asr["model"],
        "language": asr.get("language") or "автоопределение",
        "latency_ms": int((time.monotonic() - started) * 1000),
        "transcript": str(text).strip(),
        "message": "тракт распознавания работает: провайдер принял файл и ответил",
    }


# =====================================================================
# speech synthesis
# =====================================================================
def _speech_request(
    *,
    model: str,
    voice: str,
    text: str,
    voice_prompt: str | None,
    response_format: str = "mp3",
) -> dict[str, object]:
    """Тело запроса синтеза для OpenAI-совместимого /audio/speech.

    Формат один и тот же у OpenAI и у OpenRouter, но принимаемые
    значения — разные: `response_format` и `instructions` каждый
    провайдер объявляет сам. Gemini TTS отдаёт PCM 24 кГц и mp3
    поддерживает не везде, а `instructions` документирован у моделей
    OpenAI — поэтому оба поля здесь параметры, а не зашитые значения:
    зашитое «mp3 плюс instructions» давало у провайдера 400, в котором
    администратору нечего было менять.
    """
    body: dict[str, object] = {
        "model": model,
        "voice": voice,
        "input": text,
        "response_format": _tts_format(response_format),
    }
    prompt = (voice_prompt or "").strip()
    if prompt:
        body["instructions"] = prompt
    return body


@app.post("/tts", dependencies=[Depends(require_service_token)])
async def synthesize(payload: TtsRequest):
    tts = RUNTIME.tts()
    if not (tts.get("base_url") and tts.get("api_key")):
        return _error(
            "tts_not_configured",
            "TTS не настроен: задайте Base URL и ключ в панели или в .env",
            503,
        )

    # Формат, в котором провайдер отдаёт звук, задаётся в панели: у
    # Gemini TTS это не mp3. Наружу контракт не меняется — голосовое
    # сообщение всегда OGG/Opus, файл всегда mp3, — перекодирует ffmpeg.
    source_format = _tts_format(tts.get("response_format"))

    work = WORK_DIR / f"job-{uuid.uuid4().hex}"
    work.mkdir(parents=True, exist_ok=True)

    try:
        response = await app.state.http.post(
            f"{tts['base_url']}/audio/speech",
            headers={"Authorization": f"Bearer {tts['api_key']}"},
            json=_speech_request(
                model=payload.model or tts["model"],
                voice=payload.voice or tts["voice"],
                text=payload.text,
                voice_prompt=payload.voice_prompt or tts.get("voice_prompt"),
                response_format=source_format,
            ),
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

    if not response.content:
        shutil.rmtree(work, ignore_errors=True)
        return _error("tts_empty", "провайдер вернул пустой аудиоответ", 502)

    raw = work / f"speech{TTS_FORMATS[source_format]}"
    raw.write_bytes(response.content)
    raw_pcm = source_format == "pcm"

    if payload.format == "voice":
        out = work / "speech.ogg"
        try:
            await to_telegram_voice(raw, out, raw_pcm=raw_pcm)
        except MediaError as exc:
            shutil.rmtree(work, ignore_errors=True)
            return _error("voice_encoding_failed", exc.message, 422, details=exc.details)
        media_type, filename = "audio/ogg", "speech.ogg"
    elif source_format == "mp3":
        out, media_type, filename = raw, "audio/mpeg", "speech.mp3"
    else:
        # Файл наружу — всегда mp3: у вызывающего один контракт
        # независимо от того, в чём отдаёт звук провайдер.
        out = work / "speech.mp3"
        try:
            await convert(raw, out, raw_pcm=raw_pcm)
        except MediaError as exc:
            shutil.rmtree(work, ignore_errors=True)
            return _error("tts_transcode_failed", exc.message, 422, details=exc.details)
        media_type, filename = "audio/mpeg", "speech.mp3"

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
        f"{TELEGRAM_API}/bot{telegram_token()}/getFile", params={"file_id": file_id}
    )
    if meta.status_code >= 400:
        raise MediaError("getFile failed", details=meta.text[:300])

    body = meta.json()
    if not body.get("ok"):
        raise MediaError("getFile returned ok=false", details=str(body)[:300])

    file_path = body["result"]["file_path"]
    target = work / Path(file_path).name

    async with app.state.http.stream(
        "GET", f"{TELEGRAM_API}/file/bot{telegram_token()}/{file_path}"
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
