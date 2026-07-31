"""Маршрутизация: выбор провайдера, один резерв, идемпотентность.

Здесь проверяются правила, которые стоят денег: сколько обращений к
провайдерам стоит одно голосовое сообщение и в каких случаях резерв
вообще запускается.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.stt.errors import (
    STT_ALL_PROVIDERS_FAILED,
    STT_AUDIO_INVALID,
    STT_AUDIO_TOO_LONG,
    STT_AUTH_FAILED,
    STT_RATE_LIMITED,
    STT_ROUTE_NOT_CONFIGURED,
    STT_TIMEOUT,
    SttError,
)
from app.stt.routing import SttRoutingService, TranscriptCache
from app.stt.runtime import SttRuntime
from app.stt.types import (
    SttAudioInput,
    SttCapabilities,
    SttResolvedConfig,
    SttResult,
    ValidationResult,
)

CAPS = SttCapabilities(
    batch=True, streaming=False, interim_results=False, endpointing=False,
    word_timestamps=False, segment_timestamps=False, diarization=False,
    language_detection=False, multiple_languages=False, custom_vocabulary=False,
    transcript_normalization=False, confidence=False, supported_audio_formats=("wav",),
)


class FakeAdapter:
    """Адаптер со сценарием: что вернуть на каждый вызов."""

    def __init__(self, provider: str, script: list) -> None:
        self.provider = provider
        self._script = list(script)
        self.calls = 0

    def capabilities(self):
        return CAPS

    def validate(self, config):
        return ValidationResult(ok=True)

    async def transcribe(self, config, audio, options):
        self.calls += 1
        step = self._script.pop(0) if self._script else self._script_default()
        if isinstance(step, Exception):
            raise step
        return SttResult(
            text=step, provider=self.provider, model=config.model, latency_ms=7
        )

    async def test(self, config, audio=None):
        return await self.transcribe(config, audio, {})

    def _script_default(self):
        return f"ответ {self.provider}"


class FakeRegistry:
    def __init__(self, adapters: dict) -> None:
        self._adapters = adapters

    def get(self, provider):
        adapter = self._adapters.get(provider)
        if adapter is None:
            raise SttError("stt_config_invalid", f"нет адаптера {provider}")
        return adapter

    def has(self, provider):
        return provider in self._adapters


@pytest.fixture
def audio(tmp_path: Path) -> SttAudioInput:
    path = tmp_path / "a.wav"
    path.write_bytes(b"RIFF")
    return SttAudioInput(path=path, duration_seconds=5.0)


def build(tmp_path: Path, adapters: dict, *, fallback: bool = True, **route_overrides):
    runtime = SttRuntime(tmp_path / "snap.json")
    configs = [
        {"id": "primary", "name": "Основной", "provider": "alpha", "mode": "batch",
         "base_url": "https://alpha.example", "model": "m1", "params": {}, "secret": "k"},
    ]
    route = {
        "use_case": "telegram_voice",
        "primary_config_id": "primary",
        "enabled": True,
        "timeout_ms": 30000,
    }
    if fallback:
        configs.append(
            {"id": "backup", "name": "Резерв", "provider": "beta", "mode": "batch",
             "base_url": "https://beta.example", "model": "m2", "params": {}, "secret": "k"}
        )
        route["fallback_config_id"] = "backup"
    route.update(route_overrides)

    applied = runtime.apply({"version": 1, "configs": configs, "routes": [route]})
    assert applied["applied"], applied
    return SttRoutingService(runtime, FakeRegistry(adapters), TranscriptCache())


# =====================================================================
@pytest.mark.asyncio
async def test_primary_success_costs_one_attempt(tmp_path, audio):
    alpha = FakeAdapter("alpha", ["распознано основным"])
    beta = FakeAdapter("beta", [])
    router = build(tmp_path, {"alpha": alpha, "beta": beta})

    outcome = await router.transcribe("telegram_voice", audio)

    assert outcome.result.text == "распознано основным"
    assert outcome.used_fallback is False
    assert outcome.attempt_count == 1
    assert beta.calls == 0, "резерв не должен вызываться при успехе основного"


@pytest.mark.parametrize(
    "code", [STT_TIMEOUT, STT_RATE_LIMITED, "stt_provider_unavailable", "stt_transcription_failed"]
)
@pytest.mark.asyncio
async def test_fallback_runs_on_retryable_errors(tmp_path, audio, code):
    alpha = FakeAdapter("alpha", [SttError(code, "сбой")])
    beta = FakeAdapter("beta", ["распознано резервом"])
    router = build(tmp_path, {"alpha": alpha, "beta": beta})

    outcome = await router.transcribe("telegram_voice", audio)

    assert outcome.result.text == "распознано резервом"
    assert outcome.used_fallback is True
    # Одно пользовательское распознавание, две попытки провайдеров,
    # одно событие fallback — три разные величины.
    assert outcome.attempt_count == 2
    assert sum(1 for a in outcome.attempts if a.is_fallback) == 1


@pytest.mark.parametrize(
    "code",
    [STT_AUDIO_INVALID, "stt_audio_too_large", "stt_audio_too_long", "stt_config_invalid"],
)
@pytest.mark.asyncio
async def test_no_fallback_on_hopeless_errors(tmp_path, audio, code):
    """Битое аудио резерв отвергнет так же — платить дважды незачем."""
    alpha = FakeAdapter("alpha", [SttError(code, "не выйдет")])
    beta = FakeAdapter("beta", ["не должно быть вызвано"])
    router = build(tmp_path, {"alpha": alpha, "beta": beta})

    with pytest.raises(SttError) as caught:
        await router.transcribe("telegram_voice", audio)

    assert caught.value.code == code
    assert beta.calls == 0


@pytest.mark.asyncio
async def test_at_most_one_fallback(tmp_path, audio):
    alpha = FakeAdapter("alpha", [SttError(STT_TIMEOUT, "раз")])
    beta = FakeAdapter("beta", [SttError(STT_TIMEOUT, "два"), "третья попытка"])
    router = build(tmp_path, {"alpha": alpha, "beta": beta})

    with pytest.raises(SttError) as caught:
        await router.transcribe("telegram_voice", audio)

    assert caught.value.code == STT_ALL_PROVIDERS_FAILED
    assert alpha.calls == 1
    assert beta.calls == 1, "третьей попытки быть не должно"


@pytest.mark.asyncio
async def test_auth_failure_marks_config_faulty(tmp_path, audio):
    alpha = FakeAdapter("alpha", [SttError(STT_AUTH_FAILED, "ключ не принят")])
    beta = FakeAdapter("beta", ["резерв справился"])
    router = build(tmp_path, {"alpha": alpha, "beta": beta})

    with pytest.raises(SttError):
        await router.transcribe("telegram_voice", audio)

    # Ошибка авторизации не временная: резерв не запускается, а
    # конфигурация помечается, чтобы админ увидел предупреждение.
    assert router.faulty() == {"primary": STT_AUTH_FAILED}
    assert beta.calls == 0


@pytest.mark.asyncio
async def test_faulty_fallback_is_skipped(tmp_path, audio):
    alpha = FakeAdapter("alpha", [SttError(STT_TIMEOUT, "таймаут"),
                                  SttError(STT_TIMEOUT, "таймаут")])
    beta = FakeAdapter("beta", [SttError(STT_AUTH_FAILED, "ключ протух")])
    router = build(tmp_path, {"alpha": alpha, "beta": beta})

    with pytest.raises(SttError):
        await router.transcribe("telegram_voice", audio)
    assert beta.calls == 1

    # Второй раз резерв уже не пробуем — ключ там всё ещё плохой.
    with pytest.raises(SttError):
        await router.transcribe("telegram_voice", audio)
    assert beta.calls == 1


@pytest.mark.asyncio
async def test_success_clears_faulty_mark(tmp_path, audio):
    alpha = FakeAdapter("alpha", [SttError(STT_AUTH_FAILED, "ключ"), "починили"])
    router = build(tmp_path, {"alpha": alpha}, fallback=False)

    with pytest.raises(SttError):
        await router.transcribe("telegram_voice", audio)
    assert "primary" in router.faulty()

    outcome = await router.transcribe("telegram_voice", audio)
    assert outcome.result.text == "починили"
    assert router.faulty() == {}


@pytest.mark.asyncio
async def test_idempotency_key_prevents_second_charge(tmp_path, audio):
    alpha = FakeAdapter("alpha", ["распознано один раз"])
    router = build(tmp_path, {"alpha": alpha}, fallback=False)

    first = await router.transcribe("telegram_voice", audio, idempotency_key="uniq-1")
    second = await router.transcribe("telegram_voice", audio, idempotency_key="uniq-1")

    assert first.result.text == second.result.text
    assert first.from_cache is False
    assert second.from_cache is True
    assert alpha.calls == 1, "повторная доставка не должна оплачиваться"


@pytest.mark.asyncio
async def test_different_keys_are_transcribed_separately(tmp_path, audio):
    alpha = FakeAdapter("alpha", ["первое", "второе"])
    router = build(tmp_path, {"alpha": alpha}, fallback=False)

    await router.transcribe("telegram_voice", audio, idempotency_key="a")
    await router.transcribe("telegram_voice", audio, idempotency_key="b")
    assert alpha.calls == 2


@pytest.mark.asyncio
async def test_route_without_primary_is_refused(tmp_path, audio):
    runtime = SttRuntime(tmp_path / "s.json")
    runtime.apply({"version": 1, "configs": [], "routes": [
        {"use_case": "telegram_voice", "enabled": True, "timeout_ms": 30000},
    ]})
    router = SttRoutingService(runtime, FakeRegistry({}))

    with pytest.raises(SttError) as caught:
        await router.transcribe("telegram_voice", audio)
    assert caught.value.code == STT_ROUTE_NOT_CONFIGURED


@pytest.mark.asyncio
async def test_disabled_route_is_refused(tmp_path, audio):
    alpha = FakeAdapter("alpha", ["не должно"])
    router = build(tmp_path, {"alpha": alpha}, fallback=False, enabled=False)

    with pytest.raises(SttError) as caught:
        await router.transcribe("telegram_voice", audio)
    assert caught.value.code == STT_ROUTE_NOT_CONFIGURED
    assert alpha.calls == 0


@pytest.mark.asyncio
async def test_max_audio_seconds_checked_before_paying(tmp_path, audio):
    alpha = FakeAdapter("alpha", ["не должно"])
    router = build(tmp_path, {"alpha": alpha}, fallback=False, max_audio_seconds=3)
    audio.duration_seconds = 42.0

    with pytest.raises(SttError) as caught:
        await router.transcribe("telegram_voice", audio)
    assert caught.value.code == STT_AUDIO_TOO_LONG
    assert alpha.calls == 0, "лимит проверяется до обращения к провайдеру"


@pytest.mark.asyncio
async def test_route_timeout_caps_config_timeout(tmp_path, audio):
    """Сценарий знает, сколько пользователь готов ждать, конфигурация — нет."""
    seen: dict = {}

    class Recorder(FakeAdapter):
        async def transcribe(self, config, audio, options):
            seen["timeout_ms"] = config.timeout_ms
            return await super().transcribe(config, audio, options)

    router = build(
        tmp_path, {"alpha": Recorder("alpha", ["ок"])}, fallback=False, timeout_ms=9000
    )
    await router.transcribe("telegram_voice", audio)
    assert seen["timeout_ms"] == 9000


@pytest.mark.asyncio
async def test_adapter_crash_does_not_kill_the_service(tmp_path, audio):
    class Exploding(FakeAdapter):
        async def transcribe(self, config, audio, options):
            self.calls += 1
            raise RuntimeError("чужой ответ разобрался неожиданно")

    alpha = Exploding("alpha", [])
    beta = FakeAdapter("beta", ["резерв справился"])
    router = build(tmp_path, {"alpha": alpha, "beta": beta})

    outcome = await router.transcribe("telegram_voice", audio)
    assert outcome.result.text == "резерв справился"
    assert outcome.attempts[0].ok is False


# =====================================================================
# снимок конфигурации
# =====================================================================
def test_snapshot_survives_restart(tmp_path):
    path = tmp_path / "snap.json"
    first = SttRuntime(path)
    first.apply({
        "version": 7,
        "configs": [{"id": "c1", "name": "Deepgram", "provider": "deepgram",
                     "mode": "batch", "base_url": "https://api.deepgram.com/v1/listen",
                     "model": "nova-3", "params": {"language": "ru"}, "secret": "dg"}],
        "routes": [{"use_case": "telegram_voice", "primary_config_id": "c1",
                    "enabled": True, "timeout_ms": 60000}],
    })

    # Новый объект = перезапуск контейнера.
    second = SttRuntime(path)
    route = second.route("telegram_voice")
    assert route is not None
    assert route.primary.model == "nova-3"
    assert route.primary.secret == "dg"
    assert second.describe()["version"] == 7


def test_snapshot_file_is_not_world_readable(tmp_path):
    path = tmp_path / "snap.json"
    runtime = SttRuntime(path)
    runtime.apply({
        "version": 1,
        "configs": [{"id": "c1", "name": "n", "provider": "openai", "mode": "batch",
                     "base_url": "https://api.openai.com/v1", "model": "whisper-1",
                     "params": {}, "secret": "sk-super-secret"}],
        "routes": [],
    })
    assert path.stat().st_mode & 0o077 == 0, "в файле лежат ключи провайдеров"


def test_describe_never_leaks_secrets(tmp_path):
    runtime = SttRuntime(tmp_path / "snap.json")
    runtime.apply({
        "version": 1,
        "configs": [{"id": "c1", "name": "n", "provider": "openai", "mode": "batch",
                     "base_url": "https://api.openai.com/v1", "model": "whisper-1",
                     "params": {}, "secret": "sk-super-secret"}],
        "routes": [],
    })
    import json as _json

    dumped = _json.dumps(runtime.describe())
    assert "sk-super-secret" not in dumped
    assert runtime.describe()["configs"][0]["secret_configured"] is True


def test_snapshot_rejects_fallback_equal_to_primary(tmp_path):
    runtime = SttRuntime(tmp_path / "snap.json")
    applied = runtime.apply({
        "version": 1,
        "configs": [{"id": "c1", "name": "n", "provider": "openai", "mode": "batch",
                     "base_url": "https://api.openai.com/v1", "model": "whisper-1",
                     "params": {}, "secret": "k"}],
        "routes": [{"use_case": "telegram_voice", "primary_config_id": "c1",
                    "fallback_config_id": "c1", "enabled": True, "timeout_ms": 30000}],
    })
    assert applied["applied"] is False
    assert any("резерв" in error for error in applied["errors"])


def test_snapshot_rejects_dangling_config_reference(tmp_path):
    runtime = SttRuntime(tmp_path / "snap.json")
    applied = runtime.apply({
        "version": 1,
        "configs": [],
        "routes": [{"use_case": "telegram_voice", "primary_config_id": "ghost",
                    "enabled": True, "timeout_ms": 30000}],
    })
    assert applied["applied"] is False


def test_snapshot_is_all_or_nothing(tmp_path):
    """Повреждённый снимок не должен затирать рабочий."""
    runtime = SttRuntime(tmp_path / "snap.json")
    runtime.apply({
        "version": 1,
        "configs": [{"id": "c1", "name": "рабочая", "provider": "openai", "mode": "batch",
                     "base_url": "https://api.openai.com/v1", "model": "whisper-1",
                     "params": {}, "secret": "k"}],
        "routes": [{"use_case": "telegram_voice", "primary_config_id": "c1",
                    "enabled": True, "timeout_ms": 30000}],
    })

    runtime.apply({"version": 2, "configs": [], "routes": [
        {"use_case": "выдуманный_сценарий", "enabled": True, "timeout_ms": 30000},
    ]})

    route = runtime.route("telegram_voice")
    assert route is not None and route.primary.name == "рабочая"
    assert runtime.describe()["version"] == 1
