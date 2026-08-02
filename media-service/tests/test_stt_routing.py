"""Маршрутизация: выбор провайдера, один резерв, идемпотентность.

Здесь проверяются правила, которые стоят денег: сколько обращений к
провайдерам стоит одно голосовое сообщение и в каких случаях резерв
вообще запускается.
"""

from __future__ import annotations

import json
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
    [STT_AUDIO_INVALID, "stt_audio_too_large", "stt_audio_too_long"],
)
@pytest.mark.asyncio
async def test_no_rotation_on_hopeless_errors(tmp_path, audio, code):
    """Битое аудио следующий провайдер отвергнет так же.

    Ротация нужна там, где второй провайдер может справиться. Запись,
    которую не берёт никто, — не тот случай: перебор стоил бы как
    настоящее распознавание за каждую попытку.
    """
    alpha = FakeAdapter("alpha", [SttError(code, "не выйдет")])
    beta = FakeAdapter("beta", ["не должно быть вызвано"])
    router = build(tmp_path, {"alpha": alpha, "beta": beta})

    with pytest.raises(SttError) as caught:
        await router.transcribe("telegram_voice", audio)

    assert caught.value.code == code
    assert beta.calls == 0


def build_chain(tmp_path: Path, adapters: dict, providers: list[str], **route_overrides):
    """Маршрут из произвольного числа провайдеров в заданном порядке."""
    runtime = SttRuntime(tmp_path / "snap.json")
    configs = [
        {"id": f"c{i}", "name": f"Провайдер {i + 1}", "provider": name, "mode": "batch",
         "base_url": f"https://{name}.example", "model": "m", "params": {}, "secret": "k"}
        for i, name in enumerate(providers)
    ]
    route = {
        "use_case": "telegram_voice",
        "chain": [config["id"] for config in configs],
        "enabled": True,
        "timeout_ms": 30000,
    }
    route.update(route_overrides)
    applied = runtime.apply({"version": 1, "configs": configs, "routes": [route]})
    assert applied["applied"], applied
    return SttRoutingService(runtime, FakeRegistry(adapters), TranscriptCache())


@pytest.mark.asyncio
async def test_rotation_walks_the_whole_chain(tmp_path, audio):
    """Три провайдера подряд: перебор не останавливается на втором.

    Прежнее правило «не более одного резерва» экономило деньги, но
    оставляло пользователя без ответа, когда отказывали двое. Владелец
    выбрал ответ.
    """
    adapters = {
        "alpha": FakeAdapter("alpha", [SttError(STT_TIMEOUT, "первый лёг")]),
        "beta": FakeAdapter("beta", [SttError(STT_RATE_LIMITED, "у второго лимит")]),
        "gamma": FakeAdapter("gamma", ["третий справился"]),
    }
    router = build_chain(tmp_path, adapters, ["alpha", "beta", "gamma"])

    outcome = await router.transcribe("telegram_voice", audio)

    assert outcome.result.text == "третий справился"
    assert outcome.used_fallback is True
    assert outcome.attempt_count == 3
    # Первая попытка не резерв, две следующие — резерв.
    assert [a.is_fallback for a in outcome.attempts] == [False, True, True]
    assert all(adapter.calls == 1 for adapter in adapters.values())


@pytest.mark.asyncio
async def test_rotation_can_be_switched_off(tmp_path, audio):
    """Выключенная ротация оставляет в работе только первого.

    У провайдеров разная цена и разное качество: «лучше промолчать, чем
    ответить дешёвой моделью» — решение владельца, и панель обязана
    позволять его принять.
    """
    adapters = {
        "alpha": FakeAdapter("alpha", [SttError(STT_TIMEOUT, "лёг")]),
        "beta": FakeAdapter("beta", ["резерв справился бы"]),
    }
    router = build_chain(
        tmp_path, adapters, ["alpha", "beta"], rotation_enabled=False)

    with pytest.raises(SttError) as caught:
        await router.transcribe("telegram_voice", audio)

    assert caught.value.code == STT_TIMEOUT
    assert adapters["beta"].calls == 0, "ротация выключена — второго не трогаем"


@pytest.mark.asyncio
async def test_rotation_order_follows_the_chain(tmp_path, audio):
    """Приоритет задаёт администратор, а не удача.

    Тот же набор провайдеров в обратном порядке должен дать другого
    исполнителя — иначе порядок в панели ничего не значит.
    """
    for order, expected in (
        (["alpha", "beta"], "ответ alpha"),
        (["beta", "alpha"], "ответ beta"),
    ):
        adapters = {"alpha": FakeAdapter("alpha", []), "beta": FakeAdapter("beta", [])}
        router = build_chain(tmp_path / order[0], adapters, order)
        outcome = await router.transcribe("telegram_voice", audio)
        assert outcome.result.text == expected
        assert outcome.used_fallback is False


@pytest.mark.asyncio
async def test_faulty_provider_is_skipped_not_chain_break(tmp_path, audio):
    """Помеченный неисправным пропускается, но за ним пробуют дальше."""
    adapters = {
        "alpha": FakeAdapter("alpha", [
            SttError(STT_TIMEOUT, "первый раз"), SttError(STT_TIMEOUT, "второй раз"),
        ]),
        "beta": FakeAdapter("beta", [SttError(STT_AUTH_FAILED, "ключи кончились")]),
        "gamma": FakeAdapter("gamma", ["третий справился", "и снова справился"]),
    }
    router = build_chain(tmp_path, adapters, ["alpha", "beta", "gamma"])

    await router.transcribe("telegram_voice", audio)
    assert "c1" in router.faulty(), "второй провайдер должен быть помечен"

    # Второй запрос: помеченного пропускаем, но до третьего доходим.
    outcome = await router.transcribe("telegram_voice", audio)
    assert outcome.result.text == "и снова справился"
    assert adapters["beta"].calls == 1, "помеченного второй раз не трогаем"
    assert adapters["gamma"].calls == 2


@pytest.mark.asyncio
async def test_chain_stops_when_it_runs_out(tmp_path, audio):
    """Перебор кончается на последнем провайдере, а не зацикливается."""
    alpha = FakeAdapter("alpha", [SttError(STT_TIMEOUT, "раз")])
    beta = FakeAdapter("beta", [SttError(STT_TIMEOUT, "два"), "третья попытка"])
    router = build(tmp_path, {"alpha": alpha, "beta": beta})

    with pytest.raises(SttError) as caught:
        await router.transcribe("telegram_voice", audio)

    assert caught.value.code == STT_ALL_PROVIDERS_FAILED
    # В сообщении обе причины: чинить, возможно, придётся обоих.
    assert "раз" in caught.value.message and "два" in caught.value.message
    assert alpha.calls == 1
    assert beta.calls == 1


@pytest.mark.asyncio
async def test_auth_failure_marks_config_faulty_but_rotates(tmp_path, audio):
    """Кончились ключи у первого — отвечает второй, а первый помечается.

    Так было не всегда: раньше ошибка авторизации обрывала цепочку, и
    голосовое оставалось без ответа до вмешательства администратора.
    Но конфигурация помечается неисправной, только когда мертвы все её
    ключи, — а это ровно тот случай, ради которого цепочка и заведена.
    """
    alpha = FakeAdapter("alpha", [SttError(STT_AUTH_FAILED, "ключ не принят")])
    beta = FakeAdapter("beta", ["резерв справился"])
    router = build(tmp_path, {"alpha": alpha, "beta": beta})

    outcome = await router.transcribe("telegram_voice", audio)

    assert outcome.result.text == "резерв справился"
    assert outcome.used_fallback is True
    assert beta.calls == 1
    # Пометка всё равно ставится: администратор должен увидеть, что у
    # первого провайдера кончились ключи, даже когда ответ пришёл.
    assert router.faulty() == {"primary": STT_AUTH_FAILED}


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


def test_snapshot_rejects_duplicate_in_chain(tmp_path):
    """Один провайдер дважды в цепочке — второй такой же отказ за вторые деньги."""
    runtime = SttRuntime(tmp_path / "snap.json")
    applied = runtime.apply({
        "version": 1,
        "configs": [{"id": "c1", "name": "n", "provider": "openai", "mode": "batch",
                     "base_url": "https://api.openai.com/v1", "model": "whisper-1",
                     "params": {}, "secret": "k"}],
        "routes": [{"use_case": "telegram_voice", "chain": ["c1", "c1"],
                    "enabled": True, "timeout_ms": 30000}],
    })
    assert applied["applied"] is False
    assert any("дважды" in error for error in applied["errors"])


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


# =====================================================================
# перебор ключей внутри одного провайдера
# =====================================================================
# Смена ключа и смена провайдера — разные вещи. Первая бесплатна (тот же
# провайдер, та же цена) и незаметна пользователю; вторая стоит вторых
# денег и потому ограничена одной попыткой на аудио.
class KeyAwareAdapter(FakeAdapter):
    """Адаптер, отвечающий по-разному в зависимости от ключа."""

    def __init__(self, provider: str, by_key: dict) -> None:
        super().__init__(provider, [])
        self._by_key = by_key
        self.seen_keys: list[str] = []

    async def transcribe(self, config, audio, options):
        self.calls += 1
        self.seen_keys.append(config.secret)
        outcome = self._by_key.get(config.secret, f"ответ по ключу {config.secret}")
        if isinstance(outcome, Exception):
            raise outcome
        return SttResult(
            text=outcome, provider=self.provider, model=config.model, latency_ms=5
        )


def build_with_keys(tmp_path, adapters, keys, **route_overrides):
    runtime = SttRuntime(tmp_path / "keys.json")
    route = {
        "use_case": "telegram_voice",
        "primary_config_id": "primary",
        "enabled": True,
        "timeout_ms": 30000,
    }
    route.update(route_overrides)
    applied = runtime.apply({
        "version": 1,
        "configs": [{
            "id": "primary", "name": "Основной", "provider": "alpha", "mode": "batch",
            "base_url": "https://alpha.example", "model": "m1", "params": {},
            "keys": keys,
        }],
        "routes": [route],
    })
    assert applied["applied"], applied
    return SttRoutingService(runtime, FakeRegistry(adapters), TranscriptCache())


KEYS = [
    {"id": "k1", "label": "Ключ 1", "secret": "key-one"},
    {"id": "k2", "label": "Ключ 2", "secret": "key-two"},
    {"id": "k3", "label": "Ключ 3", "secret": "key-three"},
]


@pytest.mark.asyncio
async def test_first_working_key_wins(tmp_path, audio):
    alpha = KeyAwareAdapter("alpha", {"key-one": "распознано первым ключом"})
    router = build_with_keys(tmp_path, {"alpha": alpha}, KEYS)

    outcome = await router.transcribe("telegram_voice", audio)

    assert outcome.result.text == "распознано первым ключом"
    assert alpha.seen_keys == ["key-one"], "лишние ключи трогать незачем"
    assert outcome.attempts[0].keys_tried == 1
    assert outcome.attempts[0].key_label == "Ключ 1"


@pytest.mark.asyncio
async def test_rotation_on_exhausted_limit(tmp_path, audio):
    alpha = KeyAwareAdapter("alpha", {
        "key-one": SttError(STT_RATE_LIMITED, "лимит исчерпан"),
        "key-two": "распознано вторым ключом",
    })
    router = build_with_keys(tmp_path, {"alpha": alpha}, KEYS)

    outcome = await router.transcribe("telegram_voice", audio)

    assert outcome.result.text == "распознано вторым ключом"
    assert alpha.seen_keys == ["key-one", "key-two"]
    # Для пользователя это одно распознавание, а не два: провайдер и
    # цена те же, поэтому событием резерва смена ключа не считается.
    assert outcome.used_fallback is False
    assert outcome.attempt_count == 1
    assert outcome.attempts[0].keys_tried == 2
    assert outcome.attempts[0].key_label == "Ключ 2"
    assert outcome.attempts[0].key_failures[0]["error_code"] == STT_RATE_LIMITED


@pytest.mark.asyncio
async def test_rotation_on_invalid_key(tmp_path, audio):
    alpha = KeyAwareAdapter("alpha", {
        "key-one": SttError(STT_AUTH_FAILED, "ключ отозван"),
        "key-two": SttError(STT_AUTH_FAILED, "и этот тоже"),
        "key-three": "третий сработал",
    })
    router = build_with_keys(tmp_path, {"alpha": alpha}, KEYS)

    outcome = await router.transcribe("telegram_voice", audio)

    assert outcome.result.text == "третий сработал"
    assert alpha.seen_keys == ["key-one", "key-two", "key-three"]


@pytest.mark.asyncio
async def test_all_keys_tried_before_giving_up(tmp_path, audio):
    alpha = KeyAwareAdapter("alpha", {
        key["secret"]: SttError(STT_RATE_LIMITED, "лимит") for key in KEYS
    })
    beta = FakeAdapter("beta", ["резерв справился"])
    router = build_with_keys(tmp_path, {"alpha": alpha, "beta": beta}, KEYS,
                             fallback_config_id=None)

    with pytest.raises(SttError):
        await router.transcribe("telegram_voice", audio)

    assert alpha.seen_keys == ["key-one", "key-two", "key-three"], "перебрать надо все"


@pytest.mark.asyncio
async def test_no_rotation_on_errors_a_key_cannot_fix(tmp_path, audio):
    # Битое аудио и таймаут от ключа не зависят: другой ключ получит тот
    # же отказ, а запрос будет стоить вдвое дороже.
    for code in (STT_AUDIO_INVALID, STT_TIMEOUT, "stt_provider_unavailable"):
        alpha = KeyAwareAdapter("alpha", {key["secret"]: SttError(code, "не выйдет") for key in KEYS})
        router = build_with_keys(tmp_path, {"alpha": alpha}, KEYS)

        with pytest.raises(SttError):
            await router.transcribe("telegram_voice", audio)
        assert alpha.seen_keys == ["key-one"], f"{code}: перебор ключей бессмысленен"


@pytest.mark.asyncio
async def test_exhausted_key_is_skipped_next_time(tmp_path, audio):
    alpha = KeyAwareAdapter("alpha", {
        "key-one": SttError(STT_RATE_LIMITED, "лимит"),
        "key-two": "второй работает",
    })
    router = build_with_keys(tmp_path, {"alpha": alpha}, KEYS)

    await router.transcribe("telegram_voice", audio)
    alpha.seen_keys.clear()
    await router.transcribe("telegram_voice", audio)

    # Долбиться в исчерпанный ключ каждым сообщением бессмысленно.
    assert alpha.seen_keys == ["key-two"]
    assert router.key_state()["k1"]["error_code"] == STT_RATE_LIMITED


@pytest.mark.asyncio
async def test_key_state_survives_json_encoding(tmp_path, audio):
    """Отвергнутый ключ не возвращается никогда — но JSON про это не знает.

    json.dumps пишет бесконечность литералом Infinity, которого в
    спецификации JSON нет: JSON.parse в браузере на нём падает, и раздел
    здоровья в панели остаётся пустым вместо того, чтобы показать
    мёртвый ключ.
    """
    alpha = KeyAwareAdapter("alpha", {
        "key-one": SttError(STT_AUTH_FAILED, "мёртв"),
        "key-two": "второй работает",
    })
    router = build_with_keys(tmp_path, {"alpha": alpha}, KEYS)
    await router.transcribe("telegram_voice", audio)

    state = router.key_state()
    assert state["k1"]["skipped_until"] is None
    assert state["k1"]["active"] is False
    encoded = json.dumps(state, allow_nan=False)
    assert "Infinity" not in encoded


@pytest.mark.asyncio
async def test_new_snapshot_revives_all_keys(tmp_path, audio):
    alpha = KeyAwareAdapter("alpha", {
        "key-one": SttError(STT_AUTH_FAILED, "мёртв"),
        "key-two": "второй работает",
    })
    router = build_with_keys(tmp_path, {"alpha": alpha}, KEYS)
    await router.transcribe("telegram_voice", audio)
    assert router.key_state()

    # Администратор что-то менял — возможно, как раз заменил мёртвый ключ.
    router.clear_faulty()
    assert router.key_state() == {}


@pytest.mark.asyncio
async def test_one_dead_key_does_not_condemn_the_provider(tmp_path, audio):
    alpha = KeyAwareAdapter("alpha", {
        "key-one": SttError(STT_AUTH_FAILED, "мёртв"),
        "key-two": "второй работает",
    })
    router = build_with_keys(tmp_path, {"alpha": alpha}, KEYS)

    await router.transcribe("telegram_voice", audio)

    # Один мёртвый ключ из трёх — не повод считать провайдера сломанным.
    assert router.faulty() == {}


@pytest.mark.asyncio
async def test_provider_is_condemned_only_when_every_key_is_rejected(tmp_path, audio):
    alpha = KeyAwareAdapter("alpha", {
        key["secret"]: SttError(STT_AUTH_FAILED, "отозван") for key in KEYS
    })
    router = build_with_keys(tmp_path, {"alpha": alpha}, KEYS)

    with pytest.raises(SttError):
        await router.transcribe("telegram_voice", audio)

    assert router.faulty() == {"primary": STT_AUTH_FAILED}


@pytest.mark.asyncio
async def test_fallback_provider_still_works_after_keys_run_out(tmp_path, audio):
    # Ключи кончились — это по-прежнему отказ провайдера, и решение о
    # резерве принимает маршрутизация, как и раньше.
    runtime = SttRuntime(tmp_path / "both.json")
    runtime.apply({
        "version": 1,
        "configs": [
            {"id": "primary", "name": "Основной", "provider": "alpha", "mode": "batch",
             "base_url": "https://alpha.example", "model": "m1", "params": {}, "keys": KEYS},
            {"id": "backup", "name": "Резерв", "provider": "beta", "mode": "batch",
             "base_url": "https://beta.example", "model": "m2", "params": {},
             "keys": [{"id": "b1", "label": "Ключ", "secret": "beta-key"}]},
        ],
        "routes": [{"use_case": "telegram_voice", "primary_config_id": "primary",
                    "fallback_config_id": "backup", "enabled": True, "timeout_ms": 30000}],
    })
    alpha = KeyAwareAdapter("alpha", {
        key["secret"]: SttError(STT_RATE_LIMITED, "лимит") for key in KEYS
    })
    beta = KeyAwareAdapter("beta", {"beta-key": "резерв справился"})
    router = SttRoutingService(runtime, FakeRegistry({"alpha": alpha, "beta": beta}), TranscriptCache())

    outcome = await router.transcribe("telegram_voice", audio)

    assert outcome.result.text == "резерв справился"
    assert outcome.used_fallback is True
    # Три ключа основного — всё ещё одна попытка провайдера.
    assert outcome.attempt_count == 2
    assert outcome.attempts[0].keys_tried == 3


def test_key_never_leaks_into_repr():
    from app.stt.types import SttKey

    dumped = repr(SttKey(key_id="k1", label="Основной", secret="sk-super-secret"))
    assert "sk-super-secret" not in dumped
