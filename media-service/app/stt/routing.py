"""Выбор провайдера, одна попытка резерва, учёт расхода.

Здесь собраны правила из раздела 10 постановки, и каждое из них — про
деньги или про доверие:

  * Не более одного резервного запроса на одно аудио. Не «повторять до
    успеха»: цепочка из трёх провайдеров на минутной записи стоит трёх
    распознаваний, а пользователь всё равно ждёт один ответ.

  * Резерв только на ошибках, которые может исправить смена провайдера:
    сеть, таймаут, 429, 5xx, недоступность. Битое аудио, превышение
    лимита и провал валидации резерв отвергнет ровно так же — платить за
    это второй раз незачем.

  * Ошибка авторизации помечает конфигурацию неисправной. Это не сбой
    сети: пока администратор не заменит ключ, каждое следующее сообщение
    будет падать так же.

  * Идемпотентность по file_unique_id. Telegram повторяет доставку
    апдейта при таймауте вебхука, и без этой проверки одно голосовое
    оплачивалось бы дважды.

Маршрутизация живёт в media-service, а не в eva-agent-service, по одной
причине: только здесь есть сам файл. Роутинг в TypeScript означал бы
либо гонять аудио между контейнерами дважды, либо кэшировать его на
полпути.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from .errors import (
    STT_ALL_PROVIDERS_FAILED,
    STT_AUDIO_TOO_LONG,
    STT_CONFIG_INVALID,
    STT_ROUTE_NOT_CONFIGURED,
    ProviderAttempt,
    SttError,
)
from .registry import SttProviderRegistry
from .runtime import SttRoute, SttRuntime
from .types import SttAudioInput, SttResolvedConfig, SttResult

log = logging.getLogger("media.stt")


@dataclass
class TranscriptionOutcome:
    """Результат плюс всё, что нужно записать в телеметрию."""

    result: SttResult
    attempts: list[ProviderAttempt] = field(default_factory=list)
    used_fallback: bool = False
    from_cache: bool = False

    @property
    def attempt_count(self) -> int:
        return len(self.attempts)


class TranscriptCache:
    """Память о том, что уже распознано.

    Живёт в процессе, а не в PostgreSQL: media-service один, повтор
    прилетает через секунды, и ради этого ходить в базу незачем.
    Долговременная запись остаётся в stt_transcript_cache, её пишет
    admin-api по событию телеметрии.
    """

    def __init__(self, ttl_seconds: int = 24 * 3600, capacity: int = 512) -> None:
        self._ttl = ttl_seconds
        self._capacity = capacity
        self._entries: dict[str, tuple[SttResult, float]] = {}

    def get(self, key: str) -> SttResult | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        result, expires_at = entry
        if expires_at < time.time():
            self._entries.pop(key, None)
            return None
        return result

    def put(self, key: str, result: SttResult) -> None:
        if len(self._entries) >= self._capacity:
            # Вычищаем протухшее, и только если не помогло — самое старое.
            now = time.time()
            for stale in [k for k, (_, exp) in self._entries.items() if exp < now]:
                self._entries.pop(stale, None)
            if len(self._entries) >= self._capacity:
                oldest = min(self._entries, key=lambda k: self._entries[k][1])
                self._entries.pop(oldest, None)
        self._entries[key] = (result, time.time() + self._ttl)


class SttRoutingService:
    def __init__(
        self,
        runtime: SttRuntime,
        registry: SttProviderRegistry,
        cache: TranscriptCache | None = None,
    ) -> None:
        self._runtime = runtime
        self._registry = registry
        self._cache = cache or TranscriptCache()
        # Конфигурации, помеченные неисправными до вмешательства
        # администратора. Ключ — config_id, значение — код ошибки.
        self._faulty: dict[str, str] = {}

    # -----------------------------------------------------------------
    def faulty(self) -> dict[str, str]:
        return dict(self._faulty)

    def clear_faulty(self, config_id: str | None = None) -> None:
        """Снимается при обновлении снимка: администратор что-то починил."""
        if config_id is None:
            self._faulty.clear()
        else:
            self._faulty.pop(config_id, None)

    # -----------------------------------------------------------------
    async def transcribe(
        self,
        use_case: str,
        audio: SttAudioInput,
        *,
        language: str | None = None,
        idempotency_key: str | None = None,
    ) -> TranscriptionOutcome:
        route = self._runtime.route(use_case)
        if route is None or not route.enabled or route.primary is None:
            raise SttError(
                STT_ROUTE_NOT_CONFIGURED,
                f"для сценария «{use_case}» не назначен основной провайдер распознавания",
            )

        if route.max_audio_seconds and audio.duration_seconds > route.max_audio_seconds:
            raise SttError(
                STT_AUDIO_TOO_LONG,
                f"запись длиной {audio.duration_seconds:.0f} с превышает лимит "
                f"{route.max_audio_seconds} с для сценария «{use_case}»",
            )

        # Повтор доставки того же файла не должен стоить второго
        # распознавания.
        if idempotency_key:
            cached = self._cache.get(idempotency_key)
            if cached is not None:
                log.info("повторная доставка %s — расшифровка взята из памяти", idempotency_key)
                return TranscriptionOutcome(result=cached, from_cache=True)

        options = {"language": language} if language else {}
        attempts: list[ProviderAttempt] = []

        primary_error = await self._attempt(
            route.primary, audio, options, route, attempts, is_fallback=False
        )
        if isinstance(primary_error, SttResult):
            outcome = TranscriptionOutcome(result=primary_error, attempts=attempts)
            if idempotency_key:
                self._cache.put(idempotency_key, primary_error)
            return outcome

        # Сюда попадаем только с ошибкой основного провайдера.
        if not self._should_fallback(primary_error, route):
            raise primary_error

        log.info(
            "основной провайдер отказал (%s), пробую резерв %s",
            primary_error.code,
            route.fallback.name if route.fallback else "(нет)",
        )
        fallback_error = await self._attempt(
            route.fallback, audio, options, route, attempts, is_fallback=True
        )
        if isinstance(fallback_error, SttResult):
            outcome = TranscriptionOutcome(
                result=fallback_error, attempts=attempts, used_fallback=True
            )
            if idempotency_key:
                self._cache.put(idempotency_key, fallback_error)
            return outcome

        # Оба отказали. Код общий, но причина первого важнее: резерв мог
        # упасть по другой причине, а чинить надо основной.
        raise SttError(
            STT_ALL_PROVIDERS_FAILED,
            f"основной провайдер: {primary_error.message}; "
            f"резервный: {fallback_error.message}",
        )

    # -----------------------------------------------------------------
    def _should_fallback(self, error: SttError, route: SttRoute) -> bool:
        if route.fallback is None:
            return False
        if route.fallback.config_id in self._faulty:
            log.info("резерв %s помечен неисправным — не пробую", route.fallback.name)
            return False
        return error.retryable

    async def _attempt(
        self,
        config: SttResolvedConfig | None,
        audio: SttAudioInput,
        options: dict,
        route: SttRoute,
        attempts: list[ProviderAttempt],
        *,
        is_fallback: bool,
    ) -> SttResult | SttError:
        """Одно обращение. Возвращает результат или ошибку, не бросает."""
        if config is None:
            return SttError(STT_ROUTE_NOT_CONFIGURED, "провайдер не назначен")

        # Таймаут маршрута перекрывает таймаут конфигурации: сценарий
        # знает, сколько пользователь готов ждать, конфигурация — нет.
        effective = SttResolvedConfig(
            config_id=config.config_id,
            name=config.name,
            provider=config.provider,
            mode=config.mode,
            base_url=config.base_url,
            model=config.model,
            params=config.params,
            secret=config.secret,
            timeout_ms=min(config.timeout_ms, route.timeout_ms),
        )

        started = time.monotonic()
        try:
            adapter = self._registry.get(effective.provider)
            validation = adapter.validate(effective)
            if not validation.ok:
                raise SttError(
                    STT_CONFIG_INVALID,
                    f"конфигурация «{effective.name}» не проходит проверку: "
                    + "; ".join(validation.errors),
                )
            result = await adapter.transcribe(effective, audio, options)
        except SttError as error:
            latency_ms = int((time.monotonic() - started) * 1000)
            attempts.append(ProviderAttempt(
                config_id=effective.config_id,
                provider=effective.provider,
                model=effective.model,
                ok=False,
                latency_ms=latency_ms,
                is_fallback=is_fallback,
                error_code=error.code,
                error_message=error.message,
                provider_request_id=error.provider_request_id,
            ))
            if error.marks_config_faulty and effective.config_id:
                # Помечаем до возврата: если резерв тоже с плохим ключом,
                # следующий же запрос его пропустит.
                self._faulty[effective.config_id] = error.code
                log.warning(
                    "конфигурация «%s» помечена неисправной: %s",
                    effective.name, error.code,
                )
            return error
        except Exception as exc:  # noqa: BLE001 - чужой ответ не должен ронять сервис
            latency_ms = int((time.monotonic() - started) * 1000)
            log.exception("адаптер %s упал неожиданно", effective.provider)
            error = SttError(
                "stt_transcription_failed",
                f"адаптер {effective.provider} завершился ошибкой",
            )
            attempts.append(ProviderAttempt(
                config_id=effective.config_id,
                provider=effective.provider,
                model=effective.model,
                ok=False,
                latency_ms=latency_ms,
                is_fallback=is_fallback,
                error_code=error.code,
                error_message=str(exc)[:200],
            ))
            return error

        latency_ms = int((time.monotonic() - started) * 1000)
        attempts.append(ProviderAttempt(
            config_id=effective.config_id,
            provider=effective.provider,
            model=result.model,
            ok=True,
            latency_ms=latency_ms,
            is_fallback=is_fallback,
            provider_request_id=result.provider_request_id,
            warnings=list(result.warnings),
        ))
        # Удачное распознавание снимает пометку: ключ мог быть заменён.
        if effective.config_id:
            self._faulty.pop(effective.config_id, None)
        return result
