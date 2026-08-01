"""Реестр адаптеров: единственное место, где провайдер превращается в код.

Схемы форм и матрица возможностей отдаются отсюда же, где живут
адаптеры. Держать их в admin-api значило бы иметь две копии правды:
адаптер научился новому параметру, а панель об этом не знает — или,
хуже, панель показывает поле, которого адаптер не понимает.
"""

from __future__ import annotations

import httpx

from .adapters.deepgram import DeepgramAdapter
from .adapters.google import GoogleSttAdapter
from .adapters.google_ai_studio import GoogleAiStudioAdapter
from .adapters.openai_compatible import (
    OPENAI_SCHEMA,
    OPENROUTER_SCHEMA,
    OpenAiCompatibleAdapter,
)
from .errors import STT_CONFIG_INVALID, SttError
from .types import SttProviderAdapter, SttResolvedConfig, ValidationResult

PROVIDER_CODES = ("deepgram", "google_ai_studio", "openai", "google", "openrouter")


class SttProviderRegistry:
    def __init__(self, client: httpx.AsyncClient) -> None:
        # OpenAI и OpenRouter — два экземпляра одного класса с разными
        # схемами. В интерфейсе это разные провайдеры с разными
        # адресами и каталогами моделей, в коде — один транспорт.
        self._adapters: dict[str, SttProviderAdapter] = {
            "deepgram": DeepgramAdapter(client),
            "openai": OpenAiCompatibleAdapter(client, "openai", OPENAI_SCHEMA),
            "openrouter": OpenAiCompatibleAdapter(client, "openrouter", OPENROUTER_SCHEMA),
            "google": GoogleSttAdapter(client),
            # Gemini через AI Studio: ключ за минуту, без облачного проекта.
            "google_ai_studio": GoogleAiStudioAdapter(client),
        }

    def get(self, provider: str) -> SttProviderAdapter:
        adapter = self._adapters.get(provider)
        if adapter is None:
            raise SttError(
                STT_CONFIG_INVALID,
                f"провайдер «{provider}» не поддерживается; "
                f"доступны: {', '.join(PROVIDER_CODES)}",
            )
        return adapter

    def has(self, provider: str) -> bool:
        return provider in self._adapters

    def capabilities(self, provider: str) -> dict:
        return self.get(provider).capabilities().as_dict()

    def validate(self, config: SttResolvedConfig) -> ValidationResult:
        return self.get(config.provider).validate(config)

    def schemas(self) -> list[dict]:
        """Описание всех провайдеров для панели.

        Порядок фиксирован PROVIDER_CODES, а не порядком словаря: список
        в интерфейсе не должен переставляться от запуска к запуску.
        """
        out: list[dict] = []
        for code in PROVIDER_CODES:
            adapter = self._adapters[code]
            out.append(adapter.schema().as_dict(adapter.capabilities().as_dict()))
        return out
