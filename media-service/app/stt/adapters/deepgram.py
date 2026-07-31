"""Deepgram.

Сверено с официальной документацией 31.07.2026:
https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded

Что важно и не совпадает с наивным ожиданием:

  * Параметр называется keyterm (единственное число) и повторяется для
    каждого термина, а не keyterms с массивом. Постановка называет его
    keyterms — здесь хранится массив, наружу уходит повторяющийся ключ.
  * keyterm работает только с nova-3 и конфликтует с language=multi:
    такая пара возвращает 400. Проверяем до отправки, а не после.
  * endpointing задаётся в миллисекундах и осмыслен только в потоковом
    режиме. Умолчание Deepgram — 10 мс; ставить его как универсальное
    значение постановка запрещает, и правильно: для русской речи с
    паузами это обрывает фразу на середине. Значение оставляем пустым,
    то есть провайдерским, а диапазон ограничиваем разумным.
  * batch и streaming — разные схемы: https:// и wss://.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from ..errors import (
    STT_AUDIO_INVALID,
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

CAPABILITIES = SttCapabilities(
    batch=True,
    streaming=True,
    interim_results=True,
    endpointing=True,
    word_timestamps=True,
    segment_timestamps=True,
    diarization=True,
    language_detection=True,
    multiple_languages=True,
    custom_vocabulary=True,
    transcript_normalization=True,
    confidence=True,
    supported_audio_formats=(
        "wav", "mp3", "mp4", "m4a", "aac", "flac", "ogg", "opus", "webm", "amr",
    ),
)

MODEL_PRESETS = (
    Option("nova-3", "nova-3", "Актуальная модель. Только она поддерживает keyterm"),
    Option("nova-3-general", "nova-3-general", "Общая речь"),
    Option("nova-3-medical", "nova-3-medical", "Медицинская лексика"),
    Option("nova-2", "nova-2", "Предыдущее поколение; вместо keyterm — keywords"),
    Option("whisper-large", "whisper-large", "Whisper в инфраструктуре Deepgram"),
)

SCHEMA = ProviderSchema(
    provider="deepgram",
    label="Deepgram",
    summary="Собственные модели Deepgram. Единственный из четырёх с подтверждённым потоковым распознаванием.",
    docs_url="https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded",
    default_base_url="https://api.deepgram.com/v1/listen",
    default_streaming_base_url="wss://api.deepgram.com/v1/listen",
    verified_on="2026-07-31",
    model_presets=MODEL_PRESETS,
    fields=(
        Field("language", "text", "Язык", section="model",
              hint="Код языка, например ru или en. Пусто — язык модели по умолчанию. "
                   "multi включает многоязычный режим",
              placeholder="ru"),
        Field("detect_language", "boolean", "Определять язык", section="model",
              hint="Deepgram определит язык сам и вернёт его в ответе",
              requires_capability="language_detection"),
        Field("punctuate", "boolean", "Пунктуация", section="formatting", default=True),
        Field("smart_format", "boolean", "Умное форматирование", section="formatting",
              hint="Даты, числа, телефоны в читаемом виде", default=True),
        Field("numerals", "boolean", "Числа цифрами", section="formatting"),
        Field("profanity_filter", "boolean", "Фильтр брани", section="formatting"),
        Field("filler_words", "boolean", "Оставлять «э-э», «ну»", section="formatting"),
        Field("diarize", "boolean", "Разделять говорящих", section="features",
              requires_capability="diarization"),
        Field("keyterms", "string_list", "Ключевые термины", section="features",
              hint="Имена, бренды, термины — до 500 токенов. Только nova-3 "
                   "и несовместимо с language=multi",
              requires_capability="custom_vocabulary"),
        Field("channels", "number", "Число каналов", section="advanced",
              minimum=1, maximum=8, default=1),
        Field("endpointing_ms", "number", "Пауза до конца реплики, мс", section="advanced",
              hint="Сколько молчания считать концом фразы. Пусто — умолчание Deepgram. "
                   "Малые значения обрывают речь с паузами",
              minimum=10, maximum=5000, requires_capability="endpointing",
              only_mode="streaming"),
        Field("utterance_end_ms", "number", "Пауза до конца высказывания, мс",
              section="advanced", minimum=1000, maximum=10000, only_mode="streaming"),
        Field("interim_results", "boolean", "Промежуточные результаты", section="advanced",
              requires_capability="interim_results", only_mode="streaming"),
    ),
)

# Булевы параметры Deepgram передаёт строками "true"/"false" в query.
_BOOLEAN_PARAMS = (
    "punctuate", "smart_format", "numerals", "profanity_filter",
    "filler_words", "diarize", "detect_language", "interim_results",
)


class DeepgramAdapter:
    provider = "deepgram"

    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    def capabilities(self) -> SttCapabilities:
        return CAPABILITIES

    def schema(self) -> ProviderSchema:
        return SCHEMA

    # -----------------------------------------------------------------
    def validate(self, config: SttResolvedConfig) -> ValidationResult:
        caps = CAPABILITIES.as_dict()
        cleaned, errors, warnings = validate_params(SCHEMA, config.params, caps, config.mode)

        model = (config.model or "").strip().lower()
        keyterms = cleaned.get("keyterms") or []
        language = str(cleaned.get("language") or "").strip().lower()

        # Обе несовместимости подтверждены документацией и багрепортом
        # deepgram-python-sdk#515: пара возвращает 400 Invalid.
        if keyterms and not model.startswith("nova-3"):
            errors.append(
                "ключевые термины (keyterm) поддерживает только nova-3; "
                f"для {config.model} используйте модель nova-3"
            )
        if keyterms and language == "multi":
            errors.append(
                "keyterm несовместим с language=multi — Deepgram отвечает 400. "
                "Уберите термины или задайте конкретный язык"
            )
        if cleaned.get("detect_language") and language and language != "multi":
            warnings.append(
                "заданы одновременно язык и автоопределение; Deepgram использует автоопределение"
            )
        if config.mode == "streaming" and not config.base_url.startswith("wss://"):
            errors.append("для потокового режима нужен адрес wss://, а не https://")
        if config.mode == "batch" and not config.base_url.startswith("https://"):
            errors.append("для пакетного режима нужен адрес https://")

        return ValidationResult(ok=not errors, errors=errors, warnings=warnings)

    # -----------------------------------------------------------------
    def _query(self, config: SttResolvedConfig) -> list[tuple[str, str]]:
        params = config.params
        query: list[tuple[str, str]] = [("model", config.model)]

        language = str(params.get("language") or "").strip()
        if language:
            query.append(("language", language))
        for name in _BOOLEAN_PARAMS:
            if name in params and params[name] is not None:
                query.append((name, "true" if params[name] else "false"))
        if params.get("channels"):
            channels = int(params["channels"])
            query.append(("channels", str(channels)))
            if channels > 1:
                # Без multichannel Deepgram сведёт каналы в один и число
                # каналов ни на что не повлияет.
                query.append(("multichannel", "true"))
        if params.get("endpointing_ms") is not None and config.mode == "streaming":
            query.append(("endpointing", str(int(params["endpointing_ms"]))))
        if params.get("utterance_end_ms") is not None and config.mode == "streaming":
            query.append(("utterance_end_ms", str(int(params["utterance_end_ms"]))))
        # keyterm повторяется, а не передаётся массивом.
        for term in params.get("keyterms") or []:
            query.append(("keyterm", str(term)))
        return query

    async def transcribe(
        self, config: SttResolvedConfig, audio: SttAudioInput, options: dict
    ) -> SttResult:
        if not config.secret:
            raise SttError(STT_SECRET_MISSING, "API-ключ Deepgram не настроен")

        query = self._query(config)
        # Язык конкретного сообщения важнее настройки: пользователь мог
        # надиктовать на другом языке, чем обычно.
        override = str(options.get("language") or "").strip()
        if override:
            query = [(key, value) for key, value in query if key != "language"]
            query.append(("language", override))

        started = time.monotonic()
        try:
            with audio.path.open("rb") as handle:
                response = await self._client.post(
                    config.base_url,
                    params=query,
                    headers={
                        "Authorization": f"Token {config.secret}",
                        "Content-Type": audio.mime_type,
                    },
                    content=handle.read(),
                    timeout=config.timeout_ms / 1000.0,
                )
        except httpx.TimeoutException as exc:
            raise SttError(STT_TIMEOUT, "Deepgram не ответил вовремя") from exc
        except httpx.TransportError as exc:
            raise SttError(
                STT_PROVIDER_UNAVAILABLE, "не удалось соединиться с Deepgram"
            ) from exc

        latency_ms = int((time.monotonic() - started) * 1000)
        request_id = response.headers.get("dg-request-id")

        if response.status_code >= 400:
            raise SttError(
                classify_http_status(response.status_code, response.text),
                f"Deepgram вернул HTTP {response.status_code}",
                status=response.status_code,
                provider_request_id=request_id,
            )

        try:
            body = response.json()
        except ValueError as exc:
            raise SttError(
                STT_TRANSCRIPTION_FAILED,
                "Deepgram вернул ответ, который не разбирается как JSON",
                provider_request_id=request_id,
            ) from exc

        return self._normalize(body, config, latency_ms, request_id)

    async def test(
        self, config: SttResolvedConfig, audio: SttAudioInput | None = None
    ) -> SttResult:
        if audio is None:
            raise SttError(STT_AUDIO_INVALID, "для проверки Deepgram нужен аудиофайл")
        return await self.transcribe(config, audio, {})

    # -----------------------------------------------------------------
    def _normalize(
        self,
        body: dict,
        config: SttResolvedConfig,
        latency_ms: int,
        request_id: str | None,
    ) -> SttResult:
        """Ответ Deepgram → общий SttResult.

        Структура: results.channels[].alternatives[]. Берём первый
        канал и первую альтернативу — остальные это варианты той же
        речи, и бизнес-логике они не нужны.
        """
        results = _dig(body, "results") or {}
        channels = results.get("channels") or []
        alternative: dict[str, Any] = {}
        if channels and isinstance(channels[0], dict):
            alternatives = channels[0].get("alternatives") or []
            if alternatives and isinstance(alternatives[0], dict):
                alternative = alternatives[0]

        words: list[SttWord] = []
        for raw in alternative.get("words") or []:
            if not isinstance(raw, dict):
                continue
            words.append(SttWord(
                text=str(raw.get("punctuated_word") or raw.get("word") or ""),
                start_ms=_seconds_to_ms(raw.get("start")),
                end_ms=_seconds_to_ms(raw.get("end")),
                confidence=_as_float(raw.get("confidence")),
            ))

        segments: list[SttSegment] = []
        for utterance in results.get("utterances") or []:
            if not isinstance(utterance, dict):
                continue
            speaker = utterance.get("speaker")
            segments.append(SttSegment(
                text=str(utterance.get("transcript") or ""),
                start_ms=_seconds_to_ms(utterance.get("start")),
                end_ms=_seconds_to_ms(utterance.get("end")),
                speaker=None if speaker is None else f"speaker_{speaker}",
            ))

        metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
        duration_ms = _seconds_to_ms((metadata or {}).get("duration"))
        detected = _dig(results, "channels", 0, "detected_language")

        return SttResult(
            text=str(alternative.get("transcript") or "").strip(),
            provider=self.provider,
            model=config.model,
            latency_ms=latency_ms,
            language=str(detected) if detected else (config.params.get("language") or None),
            duration_ms=duration_ms,
            confidence=_as_float(alternative.get("confidence")),
            words=words,
            segments=segments,
            provider_request_id=request_id or (metadata or {}).get("request_id"),
        )


# ---------------------------------------------------------------------
def _dig(source: Any, *path: Any) -> Any:
    """Безопасный проход по вложенной структуре чужого ответа."""
    current = source
    for key in path:
        if isinstance(key, int):
            if not isinstance(current, list) or len(current) <= key:
                return None
            current = current[key]
        else:
            if not isinstance(current, dict):
                return None
            current = current.get(key)
    return current


def _seconds_to_ms(value: Any) -> int | None:
    try:
        return int(round(float(value) * 1000))
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
