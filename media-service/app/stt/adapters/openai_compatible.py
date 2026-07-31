"""OpenAI и OpenRouter — один транспорт, два провайдера в интерфейсе.

Сверено с официальной документацией 31.07.2026:
  https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
  https://openrouter.ai/docs/guides/overview/multimodal/stt

Оба принимают multipart POST на {base_url}/audio/transcriptions с полями
file и model, оба отвечают JSON с полем text. Поэтому запрос собирает
один класс. В панели они остаются разными: у них разные base URL,
разные каталоги моделей, разные подсказки и у OpenRouter есть
маршрутизация по upstream-провайдерам, которой у OpenAI нет.

Два ограничения, которые нельзя обойти и о которых должен знать
администратор:

  * timestamp_granularities работает только с response_format=verbose_json,
    а verbose_json поддерживает whisper-1. Модели gpt-4o-transcribe
    отвечают только json. Просить у них таймкоды бессмысленно.
  * streaming здесь нет. У OpenAI потоковая расшифровка живёт в
    отдельном realtime-API с другим транспортом, у OpenRouter её нет
    вовсе. Постановка прямо запрещает обещать streaming без
    подтверждения документацией — capabilities.streaming = False.
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

# Общая матрица: транспорт один, значит и возможности одни. Различия
# между OpenAI и OpenRouter лежат в наборе моделей, а не в том, что
# умеет адаптер.
CAPABILITIES = SttCapabilities(
    batch=True,
    streaming=False,
    interim_results=False,
    endpointing=False,
    word_timestamps=True,
    segment_timestamps=True,
    diarization=False,
    language_detection=True,
    multiple_languages=True,
    custom_vocabulary=False,  # prompt подсказывает лексику, но это не словарь
    transcript_normalization=False,
    confidence=False,  # ни OpenAI, ни OpenRouter не возвращают уверенность
    supported_audio_formats=(
        "wav", "mp3", "mp4", "m4a", "mpeg", "mpga", "webm", "flac", "ogg",
    ),
)

# Форматы, при которых можно просить таймкоды.
_VERBOSE_FORMATS = frozenset({"verbose_json"})

_COMMON_FIELDS = (
    Field("language", "text", "Язык", section="model",
          hint="Код ISO-639-1, например ru. Пусто — определить автоматически",
          placeholder="ru"),
    Field("response_format", "select", "Формат ответа", section="formatting",
          default="json", allow_custom=True,
          options=(
              Option("json", "json", "Только текст. Поддерживают все модели"),
              Option("verbose_json", "verbose_json", "С таймкодами. Нужен для granularities"),
              Option("text", "text", "Голый текст"),
              Option("srt", "srt", "Субтитры SRT"),
              Option("vtt", "vtt", "Субтитры WebVTT"),
          )),
    Field("temperature", "number", "Температура", section="advanced",
          hint="0 — самый предсказуемый результат", minimum=0, maximum=1, default=0),
    Field("timestamp_granularities", "multiselect", "Таймкоды", section="features",
          hint="Требует response_format=verbose_json, который поддерживает whisper-1",
          options=(Option("word", "по словам"), Option("segment", "по сегментам"))),
    Field("timeout_ms", "number", "Таймаут запроса, мс", section="advanced",
          minimum=5000, maximum=600000, default=120000),
)

OPENAI_SCHEMA = ProviderSchema(
    provider="openai",
    label="OpenAI",
    summary="Whisper и модели gpt-4o-transcribe. Пакетное распознавание.",
    docs_url="https://developers.openai.com/api/docs/guides/speech-to-text",
    default_base_url="https://api.openai.com/v1",
    verified_on="2026-07-31",
    model_presets=(
        Option("gpt-4o-transcribe", "gpt-4o-transcribe", "Точнее Whisper. Отвечает только json"),
        Option("gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe", "Дешевле и быстрее"),
        Option("whisper-1", "whisper-1", "Единственная модель с verbose_json и таймкодами"),
    ),
    fields=_COMMON_FIELDS + (
        Field("prompt", "text", "Подсказка", section="features",
              hint="Имена и термины, которые встречаются в записи. Улучшает их написание"),
    ),
)

OPENROUTER_SCHEMA = ProviderSchema(
    provider="openrouter",
    label="OpenRouter",
    summary="Один ключ ко многим STT-моделям. Провайдера выбирает OpenRouter, "
            "поэтому маршрутизацию стоит ограничить явно.",
    docs_url="https://openrouter.ai/docs/guides/overview/multimodal/stt",
    default_base_url="https://openrouter.ai/api/v1",
    verified_on="2026-07-31",
    model_presets=(
        Option("openai/gpt-4o-transcribe", "openai/gpt-4o-transcribe", ""),
        Option("openai/gpt-4o-mini-transcribe", "openai/gpt-4o-mini-transcribe", ""),
        Option("openai/whisper-1", "openai/whisper-1", ""),
        Option("mistralai/voxtral-mini-transcribe", "mistralai/voxtral-mini-transcribe", ""),
    ),
    fields=_COMMON_FIELDS + (
        Field("provider_order", "string_list", "Порядок провайдеров", section="advanced",
              hint="Список upstream-провайдеров в порядке предпочтения"),
        Field("require_parameters", "boolean", "Только полная поддержка параметров",
              section="advanced",
              hint="Отсеивает провайдеров, которые молча игнорируют часть настроек"),
        Field("data_collection", "select", "Сбор данных провайдером", section="advanced",
              default="deny",
              options=(
                  Option("deny", "запретить", "Только провайдеры, не хранящие данные"),
                  Option("allow", "разрешить", "Любые провайдеры"),
              )),
        Field("zero_data_retention", "boolean", "Нулевое хранение", section="advanced",
              hint="Отправлять только провайдерам с zero-data-retention"),
        Field("provider_options", "json", "Дополнительные параметры маршрутизации",
              section="advanced",
              hint="JSON-объект, добавляется в поле provider запроса"),
    ),
)


class OpenAiCompatibleAdapter:
    """Общая реализация. Экземпляр знает, каким провайдером он выступает."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        provider: str,
        schema: ProviderSchema,
    ) -> None:
        self._client = client
        self.provider = provider
        self._schema = schema

    def capabilities(self) -> SttCapabilities:
        return CAPABILITIES

    def schema(self) -> ProviderSchema:
        return self._schema

    # -----------------------------------------------------------------
    def validate(self, config: SttResolvedConfig) -> ValidationResult:
        caps = CAPABILITIES.as_dict()
        cleaned, errors, warnings = validate_params(
            self._schema, config.params, caps, config.mode
        )

        if config.mode == "streaming":
            errors.append(
                f"{self._schema.label} не поддерживает потоковое распознавание "
                "через этот интерфейс — выберите режим batch"
            )

        granularities = cleaned.get("timestamp_granularities") or []
        response_format = str(cleaned.get("response_format") or "json")
        if granularities and response_format not in _VERBOSE_FORMATS:
            errors.append(
                "таймкоды требуют response_format=verbose_json; "
                f"сейчас выбран {response_format}"
            )
        if response_format in _VERBOSE_FORMATS and "whisper" not in config.model.lower():
            warnings.append(
                f"verbose_json подтверждён для whisper-1; модель {config.model} "
                "может ответить отказом — проверьте кнопкой «Проверить»"
            )

        if self.provider == "openrouter":
            options = cleaned.get("provider_options")
            if options is not None and not isinstance(options, dict):
                errors.append("дополнительные параметры маршрутизации должны быть JSON-объектом")

        return ValidationResult(ok=not errors, errors=errors, warnings=warnings)

    # -----------------------------------------------------------------
    def _provider_routing(self, params: dict) -> dict:
        """Блок provider для OpenRouter.

        Собирается только из полей, которые описаны в схеме. Чужие ключи
        сюда не попадают: постановка запрещает передавать провайдеру
        неизвестные параметры автоматически.
        """
        routing: dict[str, Any] = {}
        if params.get("provider_order"):
            routing["order"] = list(params["provider_order"])
        if params.get("require_parameters"):
            routing["require_parameters"] = True
        if params.get("data_collection"):
            routing["data_collection"] = str(params["data_collection"])
        if params.get("zero_data_retention"):
            routing["zdr"] = True
        extra = params.get("provider_options")
        if isinstance(extra, dict):
            routing.update(extra)
        return routing

    async def transcribe(
        self, config: SttResolvedConfig, audio: SttAudioInput, options: dict
    ) -> SttResult:
        if not config.secret:
            raise SttError(
                STT_SECRET_MISSING, f"API-ключ {self._schema.label} не настроен"
            )

        params = config.params
        # Словарь, а не список кортежей: httpx принимает list[tuple] в
        # data как сырое тело запроса (с DeprecationWarning) и строит
        # синхронный поток, который AsyncClient отправить не может.
        # Повторяющиеся поля задаются списком в значении.
        data: dict[str, str | list[str]] = {"model": config.model}

        language = str(options.get("language") or params.get("language") or "").strip()
        if language:
            data["language"] = language
        if params.get("prompt"):
            data["prompt"] = str(params["prompt"])
        response_format = str(params.get("response_format") or "json")
        data["response_format"] = response_format
        if params.get("temperature") is not None:
            data["temperature"] = str(params["temperature"])
        if response_format in _VERBOSE_FORMATS:
            granularities = [
                str(item) for item in (params.get("timestamp_granularities") or [])
            ]
            if granularities:
                data["timestamp_granularities[]"] = granularities

        headers = {"Authorization": f"Bearer {config.secret}"}
        if self.provider == "openrouter":
            # OpenRouter просит идентифицировать приложение; это влияет
            # на квоты и на страницу статистики ключа.
            headers["HTTP-Referer"] = "https://github.com/Viktor6886/evaself"
            headers["X-Title"] = "Evaself"
            routing = self._provider_routing(params)
            if routing:
                import json

                data["provider"] = json.dumps(routing, ensure_ascii=False)

        url = f"{config.base_url.rstrip('/')}/audio/transcriptions"
        # Именно bytes, а не открытый дескриптор: httpx.AsyncClient
        # заворачивает файловый объект в синхронный поток и падает с
        # «Attempted to send an sync request with an AsyncClient
        # instance». Читаем целиком — размер уже ограничен проверкой
        # длительности и MEDIA_MAX_UPLOAD_MB.
        payload = audio.path.read_bytes()
        started = time.monotonic()
        try:
            response = await self._client.post(
                url,
                headers=headers,
                data=data,
                files={"file": (audio.filename, payload, audio.mime_type)},
                timeout=config.timeout_ms / 1000.0,
            )
        except httpx.TimeoutException as exc:
            raise SttError(
                STT_TIMEOUT, f"{self._schema.label} не ответил вовремя"
            ) from exc
        except httpx.TransportError as exc:
            raise SttError(
                STT_PROVIDER_UNAVAILABLE,
                f"не удалось соединиться с {self._schema.label}",
            ) from exc

        latency_ms = int((time.monotonic() - started) * 1000)
        request_id = (
            response.headers.get("x-request-id")
            or response.headers.get("openai-request-id")
            or response.headers.get("x-openrouter-id")
        )

        if response.status_code >= 400:
            raise SttError(
                classify_http_status(response.status_code, response.text),
                f"{self._schema.label} вернул HTTP {response.status_code}",
                status=response.status_code,
                provider_request_id=request_id,
            )

        # Форматы text/srt/vtt — не JSON, и это нормальный успех.
        if response_format in ("text", "srt", "vtt"):
            return SttResult(
                text=response.text.strip(),
                provider=self.provider,
                model=config.model,
                latency_ms=latency_ms,
                language=language or None,
                provider_request_id=request_id,
            )

        try:
            body = response.json()
        except ValueError as exc:
            raise SttError(
                STT_TRANSCRIPTION_FAILED,
                f"{self._schema.label} вернул ответ, который не разбирается как JSON",
                provider_request_id=request_id,
            ) from exc

        return self._normalize(body, config, latency_ms, request_id, language)

    async def test(
        self, config: SttResolvedConfig, audio: SttAudioInput | None = None
    ) -> SttResult:
        if audio is None:
            raise SttError(
                STT_AUDIO_INVALID, f"для проверки {self._schema.label} нужен аудиофайл"
            )
        return await self.transcribe(config, audio, {})

    # -----------------------------------------------------------------
    def _normalize(
        self,
        body: dict,
        config: SttResolvedConfig,
        latency_ms: int,
        request_id: str | None,
        requested_language: str,
    ) -> SttResult:
        if not isinstance(body, dict):
            raise SttError(
                STT_TRANSCRIPTION_FAILED,
                f"{self._schema.label} вернул неожиданную структуру ответа",
                provider_request_id=request_id,
            )

        words: list[SttWord] = []
        for raw in body.get("words") or []:
            if not isinstance(raw, dict):
                continue
            words.append(SttWord(
                text=str(raw.get("word") or ""),
                start_ms=_seconds_to_ms(raw.get("start")),
                end_ms=_seconds_to_ms(raw.get("end")),
            ))

        segments: list[SttSegment] = []
        for raw in body.get("segments") or []:
            if not isinstance(raw, dict):
                continue
            segments.append(SttSegment(
                text=str(raw.get("text") or "").strip(),
                start_ms=_seconds_to_ms(raw.get("start")),
                end_ms=_seconds_to_ms(raw.get("end")),
            ))

        # OpenRouter сообщает, какой upstream в итоге отработал. Показать
        # это администратору важно: счёт и качество зависят именно от
        # него, а не от строки в поле «модель».
        upstream = None
        if isinstance(body.get("provider"), str):
            upstream = body["provider"]
        elif isinstance(body.get("provider"), dict):
            upstream = body["provider"].get("name")

        return SttResult(
            text=str(body.get("text") or "").strip(),
            provider=self.provider,
            model=str(body.get("model") or config.model),
            latency_ms=latency_ms,
            language=str(body.get("language") or requested_language) or None,
            duration_ms=_seconds_to_ms(body.get("duration")),
            # confidence сознательно не заполняется: ни один из двух
            # провайдеров его не возвращает, а выдумывать значение хуже,
            # чем оставить поле пустым.
            words=words,
            segments=segments,
            provider_request_id=str(body.get("id") or request_id or "") or None,
            upstream_provider=upstream,
        )


def _seconds_to_ms(value: Any) -> int | None:
    try:
        return int(round(float(value) * 1000))
    except (TypeError, ValueError):
        return None
