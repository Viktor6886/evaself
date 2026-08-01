"""Стабильные коды ошибок распознавания и нормализация ответов провайдеров.

Смысл этого модуля — в том, что ни одна строка от провайдера не доходит
до пользователя Telegram. Deepgram, OpenAI, Google и OpenRouter
описывают одни и те же беды по-разному: 401 против «invalid api key»,
429 против «rate limit exceeded», таймаут против оборванного соединения.
Роутингу нужно ровно одно решение — можно ли пробовать резерв, — и
принимать его по тексту чужого сообщения нельзя.

Поэтому каждый адаптер обязан выбросить SttError с кодом из этого
списка. Всё остальное считается ошибкой самого адаптера.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# ---------------------------------------------------------------------
# Коды
# ---------------------------------------------------------------------
# Конфигурация и учётные данные
STT_CONFIG_INVALID = "stt_config_invalid"
STT_SECRET_MISSING = "stt_secret_missing"
STT_AUTH_FAILED = "stt_auth_failed"
STT_MODEL_NOT_FOUND = "stt_model_not_found"

# Входное аудио
STT_AUDIO_INVALID = "stt_audio_invalid"
STT_AUDIO_TOO_LARGE = "stt_audio_too_large"
STT_AUDIO_TOO_LONG = "stt_audio_too_long"

# Поведение провайдера
STT_TIMEOUT = "stt_timeout"
STT_RATE_LIMITED = "stt_rate_limited"
STT_PROVIDER_UNAVAILABLE = "stt_provider_unavailable"
STT_TRANSCRIPTION_FAILED = "stt_transcription_failed"

# Маршрутизация
STT_ROUTE_NOT_CONFIGURED = "stt_route_not_configured"
STT_ALL_PROVIDERS_FAILED = "stt_all_providers_failed"

ALL_CODES = frozenset({
    STT_CONFIG_INVALID,
    STT_SECRET_MISSING,
    STT_AUTH_FAILED,
    STT_MODEL_NOT_FOUND,
    STT_AUDIO_INVALID,
    STT_AUDIO_TOO_LARGE,
    STT_AUDIO_TOO_LONG,
    STT_TIMEOUT,
    STT_RATE_LIMITED,
    STT_PROVIDER_UNAVAILABLE,
    STT_TRANSCRIPTION_FAILED,
    STT_ROUTE_NOT_CONFIGURED,
    STT_ALL_PROVIDERS_FAILED,
})

# Ошибки, на которых резерв имеет смысл: провайдер не смог ответить, но
# запрос был корректным. Повторять на другом провайдере то, что он
# отвергнет ровно так же, — значит платить дважды за один и тот же отказ.
RETRYABLE_CODES = frozenset({
    STT_TIMEOUT,
    STT_RATE_LIMITED,
    STT_PROVIDER_UNAVAILABLE,
    STT_TRANSCRIPTION_FAILED,
})

# Ошибки, помечающие конфигурацию неисправной. Это не «сбой сети», это
# «дальше будет то же самое, пока администратор не вмешается».
CONFIG_FAULT_CODES = frozenset({
    STT_AUTH_FAILED,
    STT_MODEL_NOT_FOUND,
    STT_CONFIG_INVALID,
    STT_SECRET_MISSING,
})

# То, что видит пользователь. Один текст на все технические причины:
# «провайдер вернул 429» ему нечего делать, а «попробуй ещё раз» —
# есть что.
USER_FACING_MESSAGE = (
    "Не получилось распознать голосовое сообщение. "
    "Попробуй отправить его ещё раз или напиши текстом."
)


class SttError(Exception):
    """Отказ распознавания с кодом, по которому принимается решение."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int | None = None,
        provider_request_id: str | None = None,
        retryable: bool | None = None,
    ) -> None:
        if code not in ALL_CODES:
            # Тихо подставить STT_TRANSCRIPTION_FAILED здесь было бы
            # хуже: опечатка в коде осталась бы незамеченной, а решение о
            # резерве принималось бы неправильно до самого прода.
            raise ValueError(f"неизвестный код ошибки STT: {code}")
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.provider_request_id = provider_request_id
        self._retryable = retryable

    @property
    def retryable(self) -> bool:
        if self._retryable is not None:
            return self._retryable
        return self.code in RETRYABLE_CODES

    @property
    def marks_config_faulty(self) -> bool:
        return self.code in CONFIG_FAULT_CODES

    def as_dict(self) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "provider_request_id": self.provider_request_id,
        }


def classify_http_status(status: int, body: str = "") -> str:
    """HTTP-статус провайдера → код из общего списка.

    Общая часть для всех адаптеров: расхождения между провайдерами
    начинаются ниже, на разборе тела, и обрабатываются в самих
    адаптерах.
    """
    if status in (401, 403):
        return STT_AUTH_FAILED
    if status == 404:
        # 404 на пути транскрибации почти всегда означает «нет такой
        # модели или распознавателя», а не «сервис переехал».
        return STT_MODEL_NOT_FOUND
    if status == 413:
        return STT_AUDIO_TOO_LARGE
    if status == 429:
        return STT_RATE_LIMITED
    if status in (408, 504):
        return STT_TIMEOUT
    if status >= 500:
        return STT_PROVIDER_UNAVAILABLE
    if status == 400:
        lowered = body.lower()
        # Отличаем «не та модель» от «не то аудио»: первое чинится
        # администратором, второе — пользователем, и резерв помогает
        # только в первом случае (там его как раз не запускаем).
        if "model" in lowered and ("not" in lowered or "invalid" in lowered or "unsupported" in lowered):
            return STT_MODEL_NOT_FOUND
        if "audio" in lowered or "file" in lowered or "format" in lowered:
            return STT_AUDIO_INVALID
        return STT_CONFIG_INVALID
    return STT_TRANSCRIPTION_FAILED


@dataclass
class SttWarning:
    """Замечание, которое не мешает результату, но должно быть видно."""

    code: str
    message: str


@dataclass
class ProviderAttempt:
    """Одно обращение к одному провайдеру — для телеметрии и аудита."""

    config_id: str | None
    provider: str
    model: str
    ok: bool
    latency_ms: int
    is_fallback: bool = False
    error_code: str | None = None
    error_message: str | None = None
    provider_request_id: str | None = None
    warnings: list[str] = field(default_factory=list)
    # Каким ключом отработала попытка и сколько ключей пришлось
    # перебрать. Смена ключа — не fallback: провайдер, модель и цена те
    # же, поэтому в статистике это отдельная величина.
    key_id: str | None = None
    key_label: str | None = None
    keys_tried: int = 1
    key_failures: list[dict] = field(default_factory=list)
