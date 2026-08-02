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
from dataclasses import dataclass, field, replace

from .errors import (
    STT_ALL_PROVIDERS_FAILED,
    STT_AUDIO_TOO_LONG,
    STT_AUTH_FAILED,
    STT_CONFIG_INVALID,
    STT_RATE_LIMITED,
    STT_ROUTE_NOT_CONFIGURED,
    ProviderAttempt,
    SttError,
)
from .registry import SttProviderRegistry
from .runtime import SttRoute, SttRuntime
from .types import SttAudioInput, SttKey, SttResolvedConfig, SttResult

log = logging.getLogger("media.stt")

# Ошибки, которые чинит следующий ключ того же провайдера.
#
# 401/403 — ключ отозван или неверен, 429 — по нему кончился лимит. Всё
# остальное (таймаут, 5xx, битое аудио) от ключа не зависит: другой ключ
# получит ровно тот же отказ, а запрос будет стоить вдвое дороже.
KEY_ROTATION_CODES = frozenset({STT_AUTH_FAILED, STT_RATE_LIMITED})

# Сколько ключ считается исчерпанным после 429. Суточные лимиты
# сбрасываются сами, поэтому выключать ключ навсегда нельзя; но и
# долбиться в него каждым сообщением бессмысленно.
RATE_LIMIT_COOLDOWN_SECONDS = 15 * 60


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
        # Состояние отдельных ключей: key_id → (код, до какого времени
        # пропускать). Живёт в памяти: перебор должен быть мгновенным, а
        # долговременную картину показывает admin-api по телеметрии.
        self._key_state: dict[str, tuple[str, float]] = {}

    # -----------------------------------------------------------------
    def faulty(self) -> dict[str, str]:
        return dict(self._faulty)

    def key_state(self) -> dict[str, dict]:
        """Что известно о ключах: для GET /stt/runtime и панели.

        Бесконечность отдаётся как null, а не как есть: json.dumps пишет
        её литералом Infinity, которого в JSON нет, и JSON.parse в
        браузере на нём падает. Для панели «не вернётся сам» и
        «неизвестно когда» — одно и то же.
        """
        now = time.time()
        return {
            key_id: {
                "error_code": code,
                "skipped_until": None if until == float("inf") else until,
                "active": until <= now,
            }
            for key_id, (code, until) in self._key_state.items()
        }

    def clear_faulty(self, config_id: str | None = None) -> None:
        """Снимается при обновлении снимка: администратор что-то починил."""
        if config_id is None:
            self._faulty.clear()
            # Новый снимок означает, что администратор что-то менял:
            # возможно, как раз добавил рабочий ключ вместо мёртвого.
            self._key_state.clear()
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

        # Перебор идёт по цепочке сверху вниз. Ротация выключена —
        # цепочка обрезана до первого, и отказ остаётся отказом.
        chain = route.usable_chain
        first_error: SttError | None = None
        last_error: SttError | None = None
        failures: list[str] = []

        for position, config in enumerate(chain):
            if position > 0:
                verdict = self._rotation_verdict(last_error, config, route)
                if verdict == "stop":
                    break
                # Неисправного пропускаем, но цепочку не обрываем: за ним
                # может стоять рабочий провайдер.
                if verdict == "skip":
                    continue

            outcome = await self._attempt(
                config, audio, options, route, attempts, is_fallback=position > 0
            )
            if isinstance(outcome, SttResult):
                if position:
                    log.info(
                        "распознал резервный провайдер «%s» (позиция %s из %s)",
                        config.name, position + 1, len(chain),
                    )
                result = TranscriptionOutcome(
                    result=outcome, attempts=attempts, used_fallback=position > 0,
                )
                if idempotency_key:
                    self._cache.put(idempotency_key, outcome)
                return result

            if first_error is None:
                first_error = outcome
            last_error = outcome
            failures.append(f"«{config.name}»: {outcome.message}")

        # Первая ошибка важнее последней: резерв мог упасть по своей
        # причине, а чинить надо того, кто должен был справиться сам.
        if first_error is None:
            raise SttError(
                STT_ROUTE_NOT_CONFIGURED,
                f"для сценария «{use_case}» не назначен провайдер распознавания",
            )
        if len(failures) == 1:
            raise first_error
        raise SttError(STT_ALL_PROVIDERS_FAILED, "; ".join(failures))

    # -----------------------------------------------------------------
    def _rotation_verdict(
        self,
        error: SttError | None,
        candidate: SttResolvedConfig,
        route: SttRoute,
    ) -> str:
        """«try» — пробовать, «skip» — пропустить этого, «stop» — хватит.

        Отказ по учётным данным теперь тоже повод перейти дальше. Раньше
        не был: считалось, что чинить его должен администратор. Но
        конфигурация помечается неисправной, только когда мертвы ВСЕ её
        ключи (026), — а это ровно тот случай, ради которого цепочка и
        нужна. Молчать в ответ на голосовое, имея рабочего второго
        провайдера, только потому, что у первого кончились ключи, —
        именно та беспомощность, от которой ротация и избавляет.

        На битом аудио и превышении лимита цепочка обрывается: следующий
        провайдер отвергнет запись ровно так же, а стоить это будет как
        настоящее распознавание.
        """
        if error is None or not route.rotation_enabled:
            return "stop"
        if not (error.retryable or error.marks_config_faulty):
            log.info("ошибка %s не лечится сменой провайдера — цепочку не продолжаю", error.code)
            return "stop"
        if candidate.config_id in self._faulty:
            log.info("провайдер «%s» помечен неисправным — пропускаю", candidate.name)
            return "skip"
        return "try"

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
        # replace, а не сборка по полям: при добавлении нового поля в
        # SttResolvedConfig ручная копия молча теряла бы его. Именно так
        # и потерялся список ключей, когда он появился.
        effective = replace(config, timeout_ms=min(config.timeout_ms, route.timeout_ms))

        # Ключи перебираются внутри одной попытки: для пользователя это
        # один запрос, для провайдера — тот же провайдер и та же цена.
        # Резервом (и вторыми деньгами) считается только смена
        # провайдера, а не смена ключа.
        keys = self._usable_keys(effective)
        if not keys:
            error = SttError(
                STT_CONFIG_INVALID,
                f"у конфигурации «{effective.name}» нет ни одного рабочего ключа",
            )
            attempts.append(ProviderAttempt(
                config_id=effective.config_id, provider=effective.provider,
                model=effective.model, ok=False, latency_ms=0,
                is_fallback=is_fallback, error_code=error.code, error_message=error.message,
            ))
            return error

        started = time.monotonic()
        key_failures: list[dict] = []
        last_error: SttError | None = None

        for index, key in enumerate(keys):
            attempt_config = replace(effective, secret=key.secret)
            try:
                adapter = self._registry.get(attempt_config.provider)
                validation = adapter.validate(attempt_config)
                if not validation.ok:
                    raise SttError(
                        STT_CONFIG_INVALID,
                        f"конфигурация «{attempt_config.name}» не проходит проверку: "
                        + "; ".join(validation.errors),
                    )
                result = await adapter.transcribe(attempt_config, audio, options)
            except SttError as error:
                last_error = error
                if error.code in KEY_ROTATION_CODES:
                    self._mark_key(key, error.code)
                    key_failures.append({
                        "key_id": key.key_id, "label": key.label, "error_code": error.code,
                    })
                    if index + 1 < len(keys):
                        log.info(
                            "ключ «%s» отпал (%s), беру следующий",
                            key.label, error.code,
                        )
                        continue
                    # Ключи кончились. Для маршрутизации это по-прежнему
                    # отказ провайдера: пусть решает, звать ли резерв.
                break
            except Exception as exc:  # noqa: BLE001 - чужой ответ не должен ронять сервис
                latency_ms = int((time.monotonic() - started) * 1000)
                log.exception("адаптер %s упал неожиданно", attempt_config.provider)
                error = SttError(
                    "stt_transcription_failed",
                    f"адаптер {attempt_config.provider} завершился ошибкой",
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
                    key_id=key.key_id,
                    key_label=key.label,
                    keys_tried=index + 1,
                    key_failures=key_failures,
                ))
                return error
            else:
                latency_ms = int((time.monotonic() - started) * 1000)
                self._key_state.pop(key.key_id, None)
                attempts.append(ProviderAttempt(
                    config_id=effective.config_id,
                    provider=effective.provider,
                    model=result.model,
                    ok=True,
                    latency_ms=latency_ms,
                    is_fallback=is_fallback,
                    provider_request_id=result.provider_request_id,
                    warnings=list(result.warnings),
                    key_id=key.key_id,
                    key_label=key.label,
                    keys_tried=index + 1,
                    key_failures=key_failures,
                ))
                if effective.config_id:
                    self._faulty.pop(effective.config_id, None)
                return result

        # Сюда попадаем, только если ни один ключ не сработал.
        error = last_error or SttError(STT_CONFIG_INVALID, "ключи исчерпаны")
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
            keys_tried=len(key_failures) or 1,
            key_failures=key_failures,
        ))
        # Конфигурацию помечаем неисправной, только если ВСЕ ключи
        # отвергнуты по учётным данным: один мёртвый ключ из пяти — не
        # повод считать провайдера сломанным.
        if (
            error.marks_config_faulty
            and effective.config_id
            and len(key_failures) >= len(keys)
        ):
            self._faulty[effective.config_id] = error.code
            log.warning(
                "конфигурация «%s» помечена неисправной: все %s ключа отвергнуты (%s)",
                effective.name, len(keys), error.code,
            )
        return error

    def _usable_keys(self, config: SttResolvedConfig) -> list[SttKey]:
        """Ключи, которые имеет смысл пробовать сейчас.

        Исчерпанный ключ пропускается до конца cooldown: суточный лимит
        сбросится сам, а долбиться в него каждым сообщением бессмысленно.
        Отвергнутый по учётным данным не вернётся, пока администратор не
        обновит снимок.
        """
        now = time.time()
        usable = [
            key for key in config.keys
            if self._key_state.get(key.key_id, ("", 0.0))[1] <= now
        ]
        if usable:
            return usable
        # Все под cooldown — пробуем всё равно: отказ провайдера честнее
        # отказа «ключи кончились», когда лимит мог уже сброситься.
        return list(config.keys)

    def _mark_key(self, key: SttKey, code: str) -> None:
        # Неверный ключ сам не починится — пропускаем до нового снимка.
        # Исчерпанный вернётся, когда провайдер сбросит счётчик.
        until = (
            float("inf") if code == STT_AUTH_FAILED
            else time.time() + RATE_LIMIT_COOLDOWN_SECONDS
        )
        self._key_state[key.key_id] = (code, until)

