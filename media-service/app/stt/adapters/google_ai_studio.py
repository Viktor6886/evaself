"""Google AI Studio — распознавание через Gemini.

Сверено с официальной документацией 01.08.2026:
https://ai.google.dev/gemini-api/docs/generate-content/audio

Это не то же самое, что Google Cloud Speech-to-Text (адаптер google).
Разница принципиальная для администратора:

  * здесь обычный API-ключ из AI Studio, а не service account JSON;
  * ключ выдаётся за минуту на ai.google.dev, без облачного проекта,
    биллинга и IAM;
  * распознаёт не специализированная модель, а Gemini — он принимает
    аудио как часть обычного запроса generateContent.

Отсюда и особенности. Ответ приходит текстом от языковой модели,
поэтому его надо просить не комментировать запись, а расшифровать;
уверенности и таймкодов Gemini не возвращает вовсе. Зато он хорошо
справляется с русской речью и не требует настройки региона.

Ограничение на inline-аудио — 20 МБ на весь запрос. Более длинные
записи требуют Files API, которого в этой версии нет: вместо мутного
400 от Google возвращаем понятную ошибку.
"""

from __future__ import annotations

import base64
import time
from typing import Any

import httpx

from ..errors import (
    STT_AUDIO_INVALID,
    STT_AUDIO_TOO_LARGE,
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
    ValidationResult,
)

# Предел inline-аудио в generateContent — 20 МБ на весь запрос вместе с
# промптом. Берём с запасом на base64 (он раздувает объём на треть).
MAX_INLINE_BYTES = 14 * 1024 * 1024

DEFAULT_PROMPT = (
    "Расшифруй речь из аудио дословно. Верни только текст расшифровки, "
    "без комментариев, без описания записи и без пояснений. "
    "Если речи нет, верни пустую строку."
)

CAPABILITIES = SttCapabilities(
    batch=True,
    streaming=False,
    interim_results=False,
    endpointing=False,
    # Gemini возвращает связный текст, а не размеченный поток слов.
    word_timestamps=False,
    segment_timestamps=False,
    diarization=False,
    language_detection=True,
    multiple_languages=True,
    # Подсказка в промпте влияет на написание имён, но это не словарь.
    custom_vocabulary=False,
    transcript_normalization=False,
    confidence=False,
    supported_audio_formats=("wav", "mp3", "aiff", "aac", "ogg", "flac"),
)

SCHEMA = ProviderSchema(
    provider="google_ai_studio",
    label="Google AI Studio (Gemini)",
    summary="Ключ из AI Studio за минуту, без облачного проекта и биллинга. "
            "Расшифровывает Gemini, поэтому таймкодов и уверенности не будет.",
    docs_url="https://ai.google.dev/gemini-api/docs/generate-content/audio",
    default_base_url="https://generativelanguage.googleapis.com",
    verified_on="2026-08-01",
    model_presets=(
        Option("gemini-2.5-flash", "gemini-2.5-flash", "Быстрая и дешёвая. Рекомендуется"),
        Option("gemini-2.5-pro", "gemini-2.5-pro", "Точнее на сложной записи, но медленнее"),
        Option("gemini-2.0-flash", "gemini-2.0-flash", "Предыдущее поколение"),
    ),
    fields=(
        Field("language", "text", "Язык", section="model",
              hint="Подсказка модели, например ru. Пусто — определит сама",
              placeholder="ru"),
        Field("prompt", "text", "Указание модели", section="features",
              hint="Чем заменить формулировку задачи по умолчанию. "
                   "Сюда же уместно вписать имена и термины из записи"),
        Field("temperature", "number", "Температура", section="advanced",
              hint="0 — самая дословная расшифровка", minimum=0, maximum=1, default=0),
        Field("timeout_ms", "number", "Таймаут запроса, мс", section="advanced",
              minimum=5000, maximum=600000, default=120000),
    ),
)


class GoogleAiStudioAdapter:
    provider = "google_ai_studio"

    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    def capabilities(self) -> SttCapabilities:
        return CAPABILITIES

    def schema(self) -> ProviderSchema:
        return SCHEMA

    # -----------------------------------------------------------------
    def validate(self, config: SttResolvedConfig) -> ValidationResult:
        caps = CAPABILITIES.as_dict()
        _, errors, warnings = validate_params(SCHEMA, config.params, caps, config.mode)

        if config.mode == "streaming":
            errors.append(
                "Google AI Studio не поддерживает потоковое распознавание — "
                "выберите режим batch"
            )
        model = (config.model or "").strip().lower()
        if model and not model.startswith("gemini"):
            warnings.append(
                f"модель «{config.model}» не похожа на Gemini; "
                "аудио принимают только модели семейства gemini"
            )
        return ValidationResult(ok=not errors, errors=errors, warnings=warnings)

    # -----------------------------------------------------------------
    async def transcribe(
        self, config: SttResolvedConfig, audio: SttAudioInput, options: dict
    ) -> SttResult:
        if not config.secret:
            raise SttError(STT_SECRET_MISSING, "API-ключ Google AI Studio не задан")

        raw = audio.path.read_bytes()
        if len(raw) > MAX_INLINE_BYTES:
            raise SttError(
                STT_AUDIO_TOO_LARGE,
                "Gemini принимает не больше 20 МБ в одном запросе; "
                "для длинной записи нужен Files API",
            )

        params = config.params
        language = str(options.get("language") or params.get("language") or "").strip()
        instruction = str(params.get("prompt") or DEFAULT_PROMPT)
        if language:
            instruction = f"{instruction} Речь на языке: {language}."

        body: dict[str, Any] = {
            "contents": [{
                "parts": [
                    {"text": instruction},
                    {"inline_data": {
                        "mime_type": audio.mime_type,
                        "data": base64.b64encode(raw).decode("ascii"),
                    }},
                ],
            }],
            "generationConfig": {
                "temperature": float(params.get("temperature") or 0),
                # Расшифровка — это текст, размышления тут только мешают
                # и оплачиваются отдельно.
                "responseMimeType": "text/plain",
            },
        }

        url = (
            f"{config.base_url.rstrip('/')}/v1beta/models/"
            f"{config.model}:generateContent"
        )
        started = time.monotonic()
        try:
            response = await self._client.post(
                url,
                # Ключ заголовком, а не в query: query-строка попадает в
                # логи прокси и серверов целиком.
                headers={"x-goog-api-key": config.secret},
                json=body,
                timeout=config.timeout_ms / 1000.0,
            )
        except httpx.TimeoutException as exc:
            raise SttError(STT_TIMEOUT, "Gemini не ответил вовремя") from exc
        except httpx.TransportError as exc:
            raise SttError(
                STT_PROVIDER_UNAVAILABLE, "не удалось соединиться с Google AI Studio"
            ) from exc

        latency_ms = int((time.monotonic() - started) * 1000)
        if response.status_code >= 400:
            raise SttError(
                classify_http_status(response.status_code, response.text),
                f"Google AI Studio вернул HTTP {response.status_code}",
                status=response.status_code,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise SttError(
                STT_TRANSCRIPTION_FAILED,
                "Google AI Studio вернул ответ, который не разбирается как JSON",
            ) from exc

        return self._normalize(payload, config, latency_ms, language)

    async def test(
        self, config: SttResolvedConfig, audio: SttAudioInput | None = None
    ) -> SttResult:
        if audio is None:
            raise SttError(STT_AUDIO_INVALID, "для проверки Google AI Studio нужен аудиофайл")
        return await self.transcribe(config, audio, {})

    # -----------------------------------------------------------------
    def _normalize(
        self,
        payload: dict,
        config: SttResolvedConfig,
        latency_ms: int,
        language: str,
    ) -> SttResult:
        """Ответ generateContent → общий SttResult."""
        warnings: list[str] = []
        candidates = payload.get("candidates") or []
        text_parts: list[str] = []

        for candidate in candidates[:1]:
            if not isinstance(candidate, dict):
                continue
            reason = candidate.get("finishReason")
            # SAFETY означает, что модель отказалась расшифровывать
            # запись. Молча вернуть пустой текст нельзя: администратор
            # решит, что провайдер сломан.
            if reason and reason not in ("STOP", "MAX_TOKENS"):
                warnings.append(f"Gemini прервал расшифровку: {reason}")
            content = candidate.get("content")
            if not isinstance(content, dict):
                continue
            for part in content.get("parts") or []:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    text_parts.append(part["text"])

        if not candidates:
            feedback = payload.get("promptFeedback")
            if isinstance(feedback, dict) and feedback.get("blockReason"):
                raise SttError(
                    STT_TRANSCRIPTION_FAILED,
                    f"Gemini отклонил запись: {feedback['blockReason']}",
                )

        usage = payload.get("usageMetadata")
        duration_ms = None
        if isinstance(usage, dict):
            # Gemini считает аудио в токенах по 32 токена на секунду.
            tokens = usage.get("promptTokenCount")
            if isinstance(tokens, int) and tokens > 0:
                duration_ms = None  # оценка ненадёжна, длительность берём из ffprobe

        return SttResult(
            text="".join(text_parts).strip(),
            provider=self.provider,
            model=config.model,
            latency_ms=latency_ms,
            language=language or None,
            duration_ms=duration_ms,
            # Ни уверенности, ни таймкодов Gemini не возвращает — полей
            # в результате не будет, вместо выдуманных значений.
            warnings=warnings,
        )
