"""Конфигурация ASR и TTS, изменяемая во время работы.

Раньше адреса, ключи и модели читались из окружения при импорте модуля.
Смена провайдера означала правку .env на сервере и пересоздание
контейнера — то есть «править workflow», чего требования как раз
запрещают.

Здесь поверх окружения лежит слой переопределений, который админ-панель
записывает через PUT /config/media. Он хранится в файле на том же томе,
что и рабочая директория, поэтому переживает перезапуск контейнера, и
читается на каждый запрос — без кэша, потому что запись редкая, а
задержка от одного чтения маленького JSON пренебрежима рядом с сетевым
вызовом к провайдеру.

Ключи в файле лежат в открытом виде: том принадлежит только этому
сервису, и он всё равно получает их через окружение. Файл создаётся с
правами 0600.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

# Поля, которые можно переопределить. Всё остальное игнорируется, чтобы
# запрос не мог подменить, например, рабочую директорию.
ASR_FIELDS = ("base_url", "api_key", "model", "language")
# `voice_prompt` — описание манеры речи. У OpenAI-совместимых моделей оно
# уходит в поле `instructions`, у Gemini TTS через OpenRouter — туда же:
# провайдерские поля endpoint пропускает без изменений.
TTS_FIELDS = ("base_url", "api_key", "model", "voice", "voice_prompt", "response_format")

_LOCK = threading.Lock()


class RuntimeConfig:
    def __init__(self, path: Path, env_defaults: dict[str, dict[str, str]]) -> None:
        self._path = path
        self._defaults = env_defaults

    # -----------------------------------------------------------------
    # чтение
    # -----------------------------------------------------------------
    def _overrides(self) -> dict[str, dict[str, str]]:
        try:
            raw = json.loads(self._path.read_text("utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(raw, dict):
            return {}
        return {
            section: {
                key: str(value)
                for key, value in values.items()
                if isinstance(values, dict) and isinstance(value, (str, int, float))
            }
            for section, values in raw.items()
            if isinstance(values, dict)
        }

    def section(self, name: str) -> dict[str, str]:
        """Окружение как основа, переопределения поверх него.

        Пустая строка в переопределении означает «вернуться к значению из
        окружения», а не «пусто»: иначе очистить поле в панели было бы
        невозможно отличить от «не задавал».
        """
        merged = dict(self._defaults.get(name, {}))
        for key, value in self._overrides().get(name, {}).items():
            if key in merged and value != "":
                merged[key] = value
        if "base_url" in merged:
            merged["base_url"] = merged["base_url"].rstrip("/")
        return merged

    def asr(self) -> dict[str, str]:
        return self.section("asr")

    def tts(self) -> dict[str, str]:
        return self.section("tts")

    # -----------------------------------------------------------------
    # запись
    # -----------------------------------------------------------------
    def update(self, payload: dict) -> dict[str, list[str]]:
        """Сохраняет только известные поля. Возвращает, что изменилось."""
        allowed = {"asr": ASR_FIELDS, "tts": TTS_FIELDS}
        applied: dict[str, list[str]] = {}

        with _LOCK:
            current = self._overrides()
            for section, fields in allowed.items():
                incoming = payload.get(section)
                if not isinstance(incoming, dict):
                    continue
                bucket = dict(current.get(section, {}))
                changed: list[str] = []
                for field in fields:
                    if field not in incoming:
                        continue
                    value = incoming[field]
                    if value is None:
                        value = ""
                    if not isinstance(value, str):
                        continue
                    bucket[field] = value.strip()
                    changed.append(field)
                if changed:
                    current[section] = bucket
                    applied[section] = changed

            if applied:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self._path.with_suffix(".tmp")
                tmp.write_text(json.dumps(current, ensure_ascii=False), "utf-8")
                os.chmod(tmp, 0o600)
                # Замена одним os.replace: наполовину записанный файл
                # никогда не окажется прочитанным параллельным запросом.
                os.replace(tmp, self._path)
        return applied

    def describe(self) -> dict:
        """Состояние без единого значения ключа."""
        out = {}
        for name in ("asr", "tts"):
            values = self.section(name)
            out[name] = {
                key: ("configured" if values.get(key) else "")
                if key == "api_key"
                else values.get(key, "")
                for key in values
            }
        return out
