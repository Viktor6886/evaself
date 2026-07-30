"""Смена провайдера ASR/TTS должна работать без правки .env и рестарта.

Раньше значения читались из окружения при импорте модуля, поэтому
переключить провайдера из панели было нельзя в принципе. Здесь проверен
слой переопределений: что он применяется, что не теряется при
перезапуске и что ключи из него не утекают наружу.
"""

import json
import os

import pytest

from app.runtime_config import RuntimeConfig

ENV = {
    "asr": {"base_url": "https://env.test/v1", "api_key": "env-key", "model": "whisper-1", "language": ""},
    "tts": {"base_url": "https://env.test/v1", "api_key": "env-key", "model": "tts-1", "voice": "nova"},
}


@pytest.fixture()
def config(tmp_path):
    return RuntimeConfig(tmp_path / "runtime-config.json", ENV)


def test_without_a_file_the_environment_wins(config):
    assert config.asr()["base_url"] == "https://env.test/v1"
    assert config.tts()["voice"] == "nova"


def test_an_override_takes_effect_immediately(config):
    applied = config.update({"asr": {"base_url": "https://api.deepgram.com/v1/", "model": "nova-2"}})
    assert applied == {"asr": ["base_url", "model"]}
    # Тот же экземпляр, без перезапуска.
    assert config.asr()["model"] == "nova-2"
    # Хвостовой слэш снимается, иначе получится //audio/transcriptions.
    assert config.asr()["base_url"] == "https://api.deepgram.com/v1"
    # Незаданное поле остаётся из окружения.
    assert config.asr()["api_key"] == "env-key"


def test_an_empty_value_returns_to_the_environment(config):
    config.update({"tts": {"voice": "onyx"}})
    assert config.tts()["voice"] == "onyx"
    config.update({"tts": {"voice": ""}})
    assert config.tts()["voice"] == "nova"


def test_unknown_fields_cannot_be_injected(config):
    assert config.update({"asr": {"work_dir": "/etc", "nope": "x"}}) == {}
    assert "work_dir" not in config.asr()
    assert config.update({"junk": {"a": "b"}}) == {}


def test_overrides_survive_a_restart(tmp_path):
    path = tmp_path / "runtime-config.json"
    RuntimeConfig(path, ENV).update({"asr": {"model": "nova-2", "api_key": "panel-key"}})
    # Новый экземпляр — то же, что новый процесс после перезапуска.
    fresh = RuntimeConfig(path, ENV)
    assert fresh.asr()["model"] == "nova-2"
    assert fresh.asr()["api_key"] == "panel-key"


def test_the_file_is_not_world_readable(tmp_path):
    path = tmp_path / "runtime-config.json"
    RuntimeConfig(path, ENV).update({"asr": {"api_key": "panel-key"}})
    assert os.stat(path).st_mode & 0o077 == 0


def test_keys_never_appear_in_the_description(config):
    config.update({"asr": {"api_key": "sk-should-not-leak"}})
    dumped = json.dumps(config.describe(), ensure_ascii=False)
    assert "sk-should-not-leak" not in dumped
    assert config.describe()["asr"]["api_key"] == "configured"


def test_a_corrupt_file_falls_back_instead_of_crashing(tmp_path):
    path = tmp_path / "runtime-config.json"
    path.write_text("{ это не json")
    assert RuntimeConfig(path, ENV).asr()["model"] == "whisper-1"
