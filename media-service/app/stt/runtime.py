"""Действующий снимок конфигураций и маршрутов STT.

Откуда он берётся. Правда живёт в PostgreSQL, но к базе ходит admin-api,
а не media-service: у media-service нет ни доступа к базе, ни мастер-ключа
Secret Store, и давать их ему — значит расширять поверхность сервиса,
который принимает файлы извне. Поэтому admin-api собирает снимок
(конфигурации + расшифрованные секреты + маршруты) и присылает его
сюда PUT /stt/runtime — ровно тем же способом, каким уже отправляет
настройки ASR/TTS в PUT /config/media.

Снимок пишется на диск и переживает перезапуск контейнера. Это не кэш
ради скорости, а то, что позволяет media-service подняться и начать
работать, пока admin-api ещё стартует.

Горячее применение получается само собой: новый снимок — новые значения
для следующего запроса. Уже выполняющийся запрос дорабатывает со своей
копией конфигурации, потому что она передана ему по значению.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .types import SttKey, SttResolvedConfig

log = logging.getLogger("media.stt")

USE_CASES = ("telegram_voice", "webapp_voice_message", "webapp_live")


@dataclass
class SttRoute:
    use_case: str
    # Цепочка провайдеров в порядке перебора: первый основной, дальше
    # резервы. Список, а не пара «основной + резерв»: когда у провайдера
    # кончились все ключи, второй — не роскошь, а единственный способ
    # ответить пользователю, и если не смог он, есть смысл в третьем.
    chain: list[SttResolvedConfig]
    enabled: bool
    # Выключенная ротация оставляет в работе только первого провайдера.
    # Это не теоретическая настройка: у провайдеров разная цена и разное
    # качество, и «лучше промолчать, чем ответить дешёвой моделью» —
    # законное решение владельца.
    rotation_enabled: bool
    timeout_ms: int
    max_audio_seconds: int | None
    config_version: int

    @property
    def primary(self) -> SttResolvedConfig | None:
        return self.chain[0] if self.chain else None

    @property
    def usable_chain(self) -> list[SttResolvedConfig]:
        """Провайдеры, которых разрешено пробовать в этом запросе."""
        return list(self.chain) if self.rotation_enabled else self.chain[:1]


class SttRuntime:
    """Потокобезопасное хранилище снимка."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._configs: dict[str, SttResolvedConfig] = {}
        self._routes: dict[str, SttRoute] = {}
        self._version = 0
        self._updated_at = 0.0
        self._load()

    # -----------------------------------------------------------------
    # чтение
    # -----------------------------------------------------------------
    def route(self, use_case: str) -> SttRoute | None:
        with self._lock:
            return self._routes.get(use_case)

    def config(self, config_id: str) -> SttResolvedConfig | None:
        with self._lock:
            return self._configs.get(config_id)

    def describe(self) -> dict:
        """Состояние без единого символа секретов.

        Именно это возвращает GET /stt/runtime и показывает раздел
        здоровья в панели.
        """
        with self._lock:
            return {
                "version": self._version,
                "updated_at": self._updated_at,
                "configs": [
                    {
                        "id": config.config_id,
                        "name": config.name,
                        "provider": config.provider,
                        "mode": config.mode,
                        "model": config.model,
                        "base_url": config.base_url,
                        "secret_configured": bool(config.secret),
                        # Только количество и подписи: значений здесь нет
                        # и быть не может.
                        "keys": [
                            {"id": key.key_id, "label": key.label}
                            for key in config.keys
                        ],
                    }
                    for config in self._configs.values()
                ],
                "routes": [
                    {
                        "use_case": route.use_case,
                        "enabled": route.enabled,
                        "timeout_ms": route.timeout_ms,
                        "max_audio_seconds": route.max_audio_seconds,
                        "config_version": route.config_version,
                        "rotation_enabled": route.rotation_enabled,
                        # Цепочка именами, в порядке перебора: раздел
                        # здоровья в панели показывает именно её.
                        "chain": [config.name for config in route.chain],
                        "primary": route.primary.name if route.primary else None,
                    }
                    for route in self._routes.values()
                ],
            }

    def is_configured(self) -> bool:
        with self._lock:
            return any(
                route.enabled and route.primary is not None
                for route in self._routes.values()
            )

    # -----------------------------------------------------------------
    # запись
    # -----------------------------------------------------------------
    def apply(self, payload: dict) -> dict:
        """Принимает снимок от admin-api.

        Снимок применяется целиком или не применяется вовсе: частично
        обновлённый маршрут (новый primary, старый fallback) отправил бы
        аудио туда, куда администратор не назначал.
        """
        configs, routes, errors = _parse_snapshot(payload)
        if errors:
            return {"applied": False, "errors": errors}

        version = int(payload.get("version") or 0)
        with self._lock:
            self._configs = configs
            self._routes = routes
            self._version = version
            self._updated_at = time.time()
            self._persist_locked()

        log.info(
            "снимок STT применён: версия=%s конфигураций=%s маршрутов=%s",
            version, len(configs), len(routes),
        )
        return {
            "applied": True,
            "version": version,
            "configs": len(configs),
            "routes": len(routes),
        }

    def clear(self) -> None:
        with self._lock:
            self._configs = {}
            self._routes = {}
            self._version = 0
            self._updated_at = time.time()
            self._persist_locked()

    # -----------------------------------------------------------------
    # диск
    # -----------------------------------------------------------------
    def _persist_locked(self) -> None:
        """Файл создаётся с правами 0600 — в нём лежат ключи провайдеров.

        Том принадлежит только этому сервису, но 0644 на файле с ключами
        Deepgram и service account JSON — не то, что стоит оставлять на
        усмотрение umask.
        """
        snapshot = {
            "version": self._version,
            "updated_at": self._updated_at,
            "configs": [
                {
                    "id": config.config_id,
                    "name": config.name,
                    "provider": config.provider,
                    "mode": config.mode,
                    "base_url": config.base_url,
                    "model": config.model,
                    "params": config.params,
                    "secret": config.secret,
                    "keys": [
                        {"id": key.key_id, "label": key.label, "secret": key.secret}
                        for key in config.keys
                    ],
                    "timeout_ms": config.timeout_ms,
                }
                for config in self._configs.values()
            ],
            "routes": [
                {
                    "use_case": route.use_case,
                    "chain": [config.config_id for config in route.chain],
                    "enabled": route.enabled,
                    "rotation_enabled": route.rotation_enabled,
                    "timeout_ms": route.timeout_ms,
                    "max_audio_seconds": route.max_audio_seconds,
                    "config_version": route.config_version,
                }
                for route in self._routes.values()
            ],
        }
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            # Права выставляются до записи содержимого, иначе секунда
            # между write и chmod оставляет ключи читаемыми всем.
            handle = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(handle, "w", encoding="utf-8") as file:
                json.dump(snapshot, file, ensure_ascii=False)
            os.replace(tmp, self._path)
        except OSError as exc:
            # Не смертельно: снимок остаётся в памяти и работает до
            # перезапуска, а admin-api пришлёт его снова при старте.
            log.warning("не удалось сохранить снимок STT: %s", exc)

    def _load(self) -> None:
        try:
            raw = json.loads(self._path.read_text("utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(raw, dict):
            return
        configs, routes, errors = _parse_snapshot(raw)
        if errors:
            log.warning("сохранённый снимок STT повреждён: %s", "; ".join(errors[:3]))
            return
        self._configs = configs
        self._routes = routes
        self._version = int(raw.get("version") or 0)
        self._updated_at = float(raw.get("updated_at") or 0.0)
        log.info("снимок STT загружен с диска: версия=%s", self._version)


# ---------------------------------------------------------------------
def _parse_snapshot(
    payload: dict,
) -> tuple[dict[str, SttResolvedConfig], dict[str, SttRoute], list[str]]:
    errors: list[str] = []
    configs: dict[str, SttResolvedConfig] = {}

    for item in payload.get("configs") or []:
        if not isinstance(item, dict):
            errors.append("элемент configs не является объектом")
            continue
        config_id = str(item.get("id") or "").strip()
        if not config_id:
            errors.append("у конфигурации нет id")
            continue
        params = item.get("params")
        # Ключей может быть несколько. Для установок, где admin-api ещё
        # старый и присылает одиночный secret, он становится первым и
        # единственным ключом — иначе обновление одного контейнера
        # выключило бы распознавание.
        keys: list[SttKey] = []
        for raw_key in item.get("keys") or []:
            if not isinstance(raw_key, dict):
                continue
            value = str(raw_key.get("secret") or "")
            if not value:
                continue
            keys.append(SttKey(
                key_id=str(raw_key.get("id") or f"{config_id}:{len(keys)}"),
                label=str(raw_key.get("label") or f"ключ {len(keys) + 1}"),
                secret=value,
            ))
        legacy = str(item.get("secret") or "")
        if not keys and legacy:
            keys.append(SttKey(key_id=f"{config_id}:0", label="Основной", secret=legacy))

        configs[config_id] = SttResolvedConfig(
            config_id=config_id,
            name=str(item.get("name") or config_id),
            provider=str(item.get("provider") or ""),
            mode=str(item.get("mode") or "batch"),
            base_url=str(item.get("base_url") or ""),
            model=str(item.get("model") or ""),
            params=params if isinstance(params, dict) else {},
            # secret — первый ключ: адаптеры работают с одним значением,
            # подстановку остальных делает маршрутизация.
            secret=keys[0].secret if keys else "",
            keys=keys,
            timeout_ms=_int_or(item.get("timeout_ms"), 120000),
        )

    routes: dict[str, SttRoute] = {}
    for item in payload.get("routes") or []:
        if not isinstance(item, dict):
            errors.append("элемент routes не является объектом")
            continue
        use_case = str(item.get("use_case") or "").strip()
        if use_case not in USE_CASES:
            errors.append(f"неизвестный сценарий «{use_case}»")
            continue

        # Цепочка приходит списком идентификаторов в порядке перебора.
        # Пара primary/fallback принимается тоже: снимок от admin-api
        # прошлой версии не должен обнулять маршрут при обновлении
        # одного контейнера из двух.
        raw_chain = item.get("chain")
        if not isinstance(raw_chain, list):
            raw_chain = [
                value for value in
                (item.get("primary_config_id"), item.get("fallback_config_id"))
                if value
            ]

        chain: list[SttResolvedConfig] = []
        broken = False
        seen: set[str] = set()
        for raw_id in raw_chain:
            config_id = str(raw_id)
            config = configs.get(config_id)
            if config is None:
                errors.append(
                    f"маршрут {use_case}: конфигурация {config_id} не пришла в снимке")
                broken = True
                break
            # Один провайдер дважды в цепочке — это не резерв, а второй
            # такой же отказ за вторые деньги.
            if config_id in seen:
                errors.append(f"маршрут {use_case}: конфигурация {config_id} указана дважды")
                broken = True
                break
            seen.add(config_id)
            chain.append(config)
        if broken:
            continue

        timeout_ms = _int_or(item.get("timeout_ms"), 120000)
        routes[use_case] = SttRoute(
            use_case=use_case,
            chain=chain,
            enabled=bool(item.get("enabled", True)),
            rotation_enabled=bool(item.get("rotation_enabled", True)),
            timeout_ms=timeout_ms,
            max_audio_seconds=(
                _int_or(item.get("max_audio_seconds"), 0) or None
            ),
            config_version=_int_or(item.get("config_version"), 1),
        )

    return configs, routes, errors


def _int_or(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
