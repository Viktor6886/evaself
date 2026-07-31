"""Google Cloud Speech-to-Text v2.

Сверено с официальной документацией 31.07.2026:
https://cloud.google.com/speech-to-text/v2/docs/reference/rest

Почему v2, а не v1. Постановка просит проверить актуальную версию и не
привязываться к v1, если рекомендуемый API использует другой ресурсный
формат — он и использует. v2 адресует запрос через recognizer:

    POST https://{location}-speech.googleapis.com/v2
         /projects/{project}/locations/{location}/recognizers/{recognizer}:recognize

Распознаватель `_` означает «настройки берутся из тела запроса» — это
и есть режим по умолчанию, при котором администратору не нужно заранее
создавать ресурс в консоли.

Про учётные данные. Путь к файлу не хранится нигде: администратор
загружает JSON один раз, admin-api проверяет и кладёт всё содержимое в
Secret Store, а в конфигурации остаются только project_id, маскированный
client_email, версия API и регион. Сюда JSON приходит уже расшифрованным
и живёт только в памяти процесса.

Access token добывается стандартным потоком service account: подписанный
RS256 JWT обменивается на токен в oauth2.googleapis.com. Токен кэшируется
до истечения минус минута — иначе каждое голосовое сообщение стоило бы
двух запросов вместо одного.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any

import httpx

from ..errors import (
    STT_AUDIO_INVALID,
    STT_AUTH_FAILED,
    STT_CONFIG_INVALID,
    STT_PROVIDER_UNAVAILABLE,
    STT_SECRET_MISSING,
    STT_TIMEOUT,
    STT_TRANSCRIPTION_FAILED,
    SttError,
    classify_http_status,
)
from ..schema import Field, Option, ProviderSchema, validate_params
from ..types import (
    SttAudioInput,
    SttCapabilities,
    SttResolvedConfig,
    SttResult,
    SttSegment,
    SttWord,
    ValidationResult,
)

TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/cloud-platform"
JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"

# Поля, без которых service account JSON бесполезен. Проверяются при
# загрузке в admin-api и повторно здесь: файл мог быть заменён в обход
# панели.
REQUIRED_CREDENTIAL_FIELDS = (
    "type", "project_id", "private_key", "client_email", "token_uri",
)

CAPABILITIES = SttCapabilities(
    batch=True,
    streaming=True,
    interim_results=True,
    endpointing=False,  # v2 не даёт настраиваемого endpointing в recognize
    word_timestamps=True,
    segment_timestamps=True,
    diarization=True,
    language_detection=True,
    multiple_languages=True,
    custom_vocabulary=True,
    transcript_normalization=True,
    confidence=True,
    supported_audio_formats=("wav", "flac", "mp3", "ogg", "opus", "webm", "m4a", "amr"),
)

# Регионы, где доступны модели chirp. Список — подсказка: поле допускает
# ручной ввод, потому что Google открывает регионы чаще, чем обновляется
# этот файл.
LOCATIONS = (
    Option("global", "global", "Общий пул. chirp_2 недоступен"),
    Option("us-central1", "us-central1", ""),
    Option("europe-west4", "europe-west4", ""),
    Option("asia-southeast1", "asia-southeast1", ""),
)

SCHEMA = ProviderSchema(
    provider="google",
    label="Google Cloud Speech-to-Text",
    summary="Модели chirp. Учётные данные — service account JSON, он загружается один раз "
            "и целиком уходит в Secret Store.",
    docs_url="https://cloud.google.com/speech-to-text/v2/docs/reference/rest",
    default_base_url="https://speech.googleapis.com",
    verified_on="2026-07-31",
    model_presets=(
        Option("chirp_2", "chirp_2", "Актуальная модель. Не во всех регионах"),
        Option("chirp", "chirp", "Первое поколение chirp"),
        Option("long", "long", "Длинные записи"),
        Option("short", "short", "Команды и короткие реплики"),
    ),
    fields=(
        Field("api_version", "select", "Версия API", section="basic", default="v2",
              options=(
                  Option("v2", "v2", "Рекомендуемая. Адресация через recognizer"),
                  Option("v1", "v1", "Устаревшая. Оставлена для существующих установок"),
              )),
        Field("location", "select", "Регион", section="basic", default="us-central1",
              allow_custom=True, options=LOCATIONS,
              hint="Определяет и адрес endpoint, и доступность моделей"),
        Field("recognizer", "text", "Распознаватель", section="advanced", default="_",
              hint="«_» — настройки берутся из запроса. Иначе имя ресурса, "
                   "созданного в консоли Google"),
        Field("language_codes", "string_list", "Языки", section="model",
              hint="Один или несколько кодов, например ru-RU. Несколько включают "
                   "автоопределение среди них",
              default=["ru-RU"], requires_capability="multiple_languages"),
        Field("automatic_punctuation", "boolean", "Пунктуация", section="formatting",
              default=True),
        Field("spoken_punctuation", "boolean", "Произнесённая пунктуация",
              section="formatting",
              hint="«запятая» в речи превращается в знак, а не в слово"),
        Field("spoken_emojis", "boolean", "Произнесённые эмодзи", section="formatting"),
        Field("transcript_normalization", "boolean", "Нормализация текста",
              section="formatting", requires_capability="transcript_normalization"),
        Field("word_time_offsets", "boolean", "Таймкоды слов", section="features",
              requires_capability="word_timestamps"),
        Field("diarization", "boolean", "Разделять говорящих", section="features",
              requires_capability="diarization"),
        Field("adaptation_phrases", "string_list", "Фразы для адаптации",
              section="features",
              hint="Имена и термины, которые надо распознавать увереннее",
              requires_capability="custom_vocabulary"),
        Field("adaptation_boost", "number", "Сила адаптации", section="features",
              minimum=0, maximum=20,
              hint="0–20. Слишком большое значение начинает слышать фразы там, где их нет"),
        Field("timeout_ms", "number", "Таймаут запроса, мс", section="advanced",
              minimum=5000, maximum=600000, default=120000),
    ),
)


class GoogleSttAdapter:
    provider = "google"

    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client
        # Ключ кэша — client_email + project_id, а не весь JSON: держать
        # приватный ключ ещё и в ключе словаря незачем.
        self._tokens: dict[str, tuple[str, float]] = {}

    def capabilities(self) -> SttCapabilities:
        return CAPABILITIES

    def schema(self) -> ProviderSchema:
        return SCHEMA

    # -----------------------------------------------------------------
    def validate(self, config: SttResolvedConfig) -> ValidationResult:
        caps = CAPABILITIES.as_dict()
        cleaned, errors, warnings = validate_params(SCHEMA, config.params, caps, config.mode)

        location = str(cleaned.get("location") or "us-central1")
        model = (config.model or "").lower()
        if model.startswith("chirp") and location == "global":
            errors.append(
                "модели chirp недоступны в регионе global — выберите региональный "
                "endpoint, например us-central1"
            )
        if cleaned.get("adaptation_boost") is not None and not cleaned.get("adaptation_phrases"):
            warnings.append("сила адаптации задана, но список фраз пуст — параметр ни на что не влияет")
        if str(cleaned.get("api_version") or "v2") == "v1":
            warnings.append(
                "v1 объявлен устаревшим; для новых установок используйте v2"
            )
        if config.mode == "streaming":
            warnings.append(
                "потоковое распознавание Google поддерживает, но режим живой Евы "
                "ещё не реализован — конфигурация будет работать как batch"
            )
        return ValidationResult(ok=not errors, errors=errors, warnings=warnings)

    # -----------------------------------------------------------------
    # Учётные данные
    # -----------------------------------------------------------------
    def _credentials(self, config: SttResolvedConfig) -> dict:
        if not config.secret:
            raise SttError(
                STT_SECRET_MISSING,
                "service account JSON для Google не загружен",
            )
        try:
            data = json.loads(config.secret)
        except ValueError as exc:
            raise SttError(
                STT_CONFIG_INVALID,
                "сохранённые учётные данные Google не разбираются как JSON",
            ) from exc
        if not isinstance(data, dict):
            raise SttError(STT_CONFIG_INVALID, "учётные данные Google должны быть JSON-объектом")
        missing = [name for name in REQUIRED_CREDENTIAL_FIELDS if not data.get(name)]
        if missing:
            raise SttError(
                STT_CONFIG_INVALID,
                f"в service account JSON нет обязательных полей: {', '.join(missing)}",
            )
        return data

    async def _access_token(self, credentials: dict) -> str:
        """Подписанный JWT → access token, с кэшем до истечения.

        Импорт jwt локальный: без учётных данных Google модуль не нужен,
        и падать на импорте при отсутствии зависимости остальным трём
        адаптерам незачем.
        """
        cache_key = f"{credentials.get('client_email')}|{credentials.get('project_id')}"
        cached = self._tokens.get(cache_key)
        if cached and cached[1] > time.time():
            return cached[0]

        try:
            import jwt  # PyJWT c поддержкой RS256
        except ImportError as exc:  # pragma: no cover - защита от неполной сборки
            raise SttError(
                STT_CONFIG_INVALID,
                "в образе media-service нет PyJWT — Google STT недоступен",
            ) from exc

        now = int(time.time())
        token_uri = str(credentials.get("token_uri") or TOKEN_URL)
        claims = {
            "iss": credentials["client_email"],
            "scope": SCOPE,
            "aud": token_uri,
            "iat": now,
            "exp": now + 3600,
        }
        try:
            assertion = jwt.encode(
                claims,
                credentials["private_key"],
                algorithm="RS256",
                headers={"kid": credentials.get("private_key_id")},
            )
        except Exception as exc:  # noqa: BLE001 - причина уходит в общий код
            raise SttError(
                STT_CONFIG_INVALID,
                "не удалось подписать запрос приватным ключом из service account JSON",
            ) from exc

        try:
            response = await self._client.post(
                token_uri,
                data={"grant_type": JWT_GRANT, "assertion": assertion},
                timeout=30.0,
            )
        except httpx.TimeoutException as exc:
            raise SttError(STT_TIMEOUT, "Google не выдал токен вовремя") from exc
        except httpx.TransportError as exc:
            raise SttError(
                STT_PROVIDER_UNAVAILABLE, "не удалось соединиться с oauth2.googleapis.com"
            ) from exc

        if response.status_code >= 400:
            # Отказ в выдаче токена — это всегда проблема учётных данных,
            # а не временный сбой: повторять на резерве незачем.
            raise SttError(
                STT_AUTH_FAILED,
                f"Google отклонил service account (HTTP {response.status_code})",
                status=response.status_code,
            )

        try:
            body = response.json()
            token = str(body["access_token"])
            expires_in = int(body.get("expires_in", 3600))
        except (ValueError, KeyError, TypeError) as exc:
            raise SttError(STT_AUTH_FAILED, "Google вернул неожиданный ответ на запрос токена") from exc

        # Минута запаса: токен не должен протухнуть между проверкой и
        # отправкой самого запроса распознавания.
        self._tokens[cache_key] = (token, time.time() + max(expires_in - 60, 30))
        return token

    # -----------------------------------------------------------------
    def _endpoint(self, config: SttResolvedConfig, project_id: str) -> str:
        params = config.params
        version = str(params.get("api_version") or "v2")
        location = str(params.get("location") or "us-central1")
        recognizer = str(params.get("recognizer") or "_")

        # Региональный endpoint обязателен для всего, кроме global:
        # запрос в speech.googleapis.com к региональному ресурсу
        # возвращает 404.
        host = (
            config.base_url.rstrip("/")
            if location == "global"
            else f"https://{location}-speech.googleapis.com"
        )
        if version == "v1":
            return f"{host}/v1/speech:recognize"
        return (
            f"{host}/v2/projects/{project_id}/locations/{location}"
            f"/recognizers/{recognizer}:recognize"
        )

    def _recognition_config(self, config: SttResolvedConfig, language: str) -> dict:
        params = config.params
        languages = list(params.get("language_codes") or ["ru-RU"])
        if language:
            # Язык конкретного сообщения ставим первым, не выбрасывая
            # остальные: Google использует список как множество кандидатов.
            normalized = language if "-" in language else f"{language}-{language.upper()}"
            languages = [normalized] + [item for item in languages if item != normalized]

        features: dict[str, Any] = {
            "enableAutomaticPunctuation": bool(params.get("automatic_punctuation", True)),
        }
        if params.get("word_time_offsets"):
            features["enableWordTimeOffsets"] = True
            features["enableWordConfidence"] = True
        if params.get("spoken_punctuation"):
            features["enableSpokenPunctuation"] = True
        if params.get("spoken_emojis"):
            features["enableSpokenEmojis"] = True
        if params.get("diarization"):
            features["diarizationConfig"] = {"minSpeakerCount": 1, "maxSpeakerCount": 6}

        recognition: dict[str, Any] = {
            "model": config.model,
            "languageCodes": languages,
            "features": features,
            # autoDecodingConfig просит Google определить кодек сам. Мы
            # присылаем WAV после ffmpeg, но полагаться на угаданные
            # параметры контейнера надёжнее, чем описывать их вручную.
            "autoDecodingConfig": {},
        }

        phrases = params.get("adaptation_phrases") or []
        if phrases:
            boost = params.get("adaptation_boost")
            phrase_set = {
                "phrases": [
                    {"value": str(phrase), **({"boost": float(boost)} if boost else {})}
                    for phrase in phrases
                ]
            }
            recognition["adaptation"] = {"phraseSets": [{"inlinePhraseSet": phrase_set}]}
        if params.get("transcript_normalization"):
            recognition["transcriptNormalization"] = {"entries": []}
        return recognition

    # -----------------------------------------------------------------
    async def transcribe(
        self, config: SttResolvedConfig, audio: SttAudioInput, options: dict
    ) -> SttResult:
        credentials = self._credentials(config)
        token = await self._access_token(credentials)
        project_id = str(credentials["project_id"])
        language = str(options.get("language") or "").strip()

        # v2 recognize принимает аудио инлайном в base64. Ограничение
        # Google — 10 МБ и ~1 минута на синхронный вызов; более длинные
        # записи требуют batchRecognize и Cloud Storage, чего в этой
        # версии нет. Предупреждаем понятной ошибкой, а не 400 от Google.
        raw = audio.path.read_bytes()
        if len(raw) > 10 * 1024 * 1024:
            raise SttError(
                "stt_audio_too_large",
                "Google принимает синхронно не больше 10 МБ; "
                "для длинных записей нужен batchRecognize",
            )

        body = {
            "config": self._recognition_config(config, language),
            "content": base64.b64encode(raw).decode("ascii"),
        }
        url = self._endpoint(config, project_id)

        started = time.monotonic()
        try:
            response = await self._client.post(
                url,
                headers={"Authorization": f"Bearer {token}"},
                json=body,
                timeout=config.timeout_ms / 1000.0,
            )
        except httpx.TimeoutException as exc:
            raise SttError(STT_TIMEOUT, "Google не ответил вовремя") from exc
        except httpx.TransportError as exc:
            raise SttError(
                STT_PROVIDER_UNAVAILABLE, "не удалось соединиться с Google Speech-to-Text"
            ) from exc

        latency_ms = int((time.monotonic() - started) * 1000)
        request_id = response.headers.get("x-request-id")

        if response.status_code >= 400:
            raise SttError(
                classify_http_status(response.status_code, response.text),
                f"Google вернул HTTP {response.status_code}",
                status=response.status_code,
                provider_request_id=request_id,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise SttError(
                STT_TRANSCRIPTION_FAILED,
                "Google вернул ответ, который не разбирается как JSON",
                provider_request_id=request_id,
            ) from exc

        return self._normalize(payload, config, latency_ms, request_id, language)

    async def test(
        self, config: SttResolvedConfig, audio: SttAudioInput | None = None
    ) -> SttResult:
        if audio is None:
            raise SttError(STT_AUDIO_INVALID, "для проверки Google нужен аудиофайл")
        return await self.transcribe(config, audio, {})

    # -----------------------------------------------------------------
    def _normalize(
        self,
        payload: dict,
        config: SttResolvedConfig,
        latency_ms: int,
        request_id: str | None,
        requested_language: str,
    ) -> SttResult:
        """Ответ v2/v1 → общий SttResult.

        results[] — куски записи, каждый со своими alternatives[].
        Склеиваем первые альтернативы: это и есть непрерывная расшифровка.
        """
        results = payload.get("results") or []
        chunks: list[str] = []
        words: list[SttWord] = []
        segments: list[SttSegment] = []
        confidences: list[float] = []
        language: str | None = None

        for result in results:
            if not isinstance(result, dict):
                continue
            language = result.get("languageCode") or language
            alternatives = result.get("alternatives") or []
            if not alternatives or not isinstance(alternatives[0], dict):
                continue
            best = alternatives[0]
            text = str(best.get("transcript") or "").strip()
            if text:
                chunks.append(text)
            confidence = _as_float(best.get("confidence"))
            # Google возвращает 0.0 там, где уверенность не считалась.
            # Считать это «нулевой уверенностью» было бы неверно.
            if confidence:
                confidences.append(confidence)

            starts: list[int] = []
            ends: list[int] = []
            for raw in best.get("words") or []:
                if not isinstance(raw, dict):
                    continue
                start_ms = _duration_to_ms(raw.get("startOffset"))
                end_ms = _duration_to_ms(raw.get("endOffset"))
                words.append(SttWord(
                    text=str(raw.get("word") or ""),
                    start_ms=start_ms,
                    end_ms=end_ms,
                    confidence=_as_float(raw.get("confidence")),
                ))
                if start_ms is not None:
                    starts.append(start_ms)
                if end_ms is not None:
                    ends.append(end_ms)
            if text:
                segments.append(SttSegment(
                    text=text,
                    start_ms=min(starts) if starts else None,
                    end_ms=max(ends) if ends else None,
                ))

        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        duration_ms = _duration_to_ms((metadata or {}).get("totalBilledDuration"))

        return SttResult(
            text=" ".join(chunks).strip(),
            provider=self.provider,
            model=config.model,
            latency_ms=latency_ms,
            language=language or requested_language or None,
            duration_ms=duration_ms,
            confidence=(sum(confidences) / len(confidences)) if confidences else None,
            words=words,
            segments=segments,
            provider_request_id=request_id,
        )


# ---------------------------------------------------------------------
def public_metadata(credentials: dict) -> dict:
    """Безопасные метаданные service account для хранения и показа.

    Всё, что может уйти в public_config и на экран. private_key и
    private_key_id сюда не попадают ни при каких условиях, а почта
    маскируется: полный адрес сервисного аккаунта — это подсказка для
    атакующего, какой ресурс запрашивать.
    """
    email = str(credentials.get("client_email") or "")
    local, _, domain = email.partition("@")
    masked = f"{local[:3]}***@{domain}" if len(local) > 3 else f"***@{domain}"
    return {
        "project_id": str(credentials.get("project_id") or ""),
        "client_email_masked": masked if email else "",
        "credential_type": str(credentials.get("type") or ""),
    }


def _duration_to_ms(value: Any) -> int | None:
    """Google отдаёт длительности строкой вида «1.320s»."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(round(float(value) * 1000))
    text = str(value).strip()
    if text.endswith("s"):
        text = text[:-1]
    try:
        return int(round(float(text) * 1000))
    except ValueError:
        return None


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
