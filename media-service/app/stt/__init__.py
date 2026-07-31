"""Распознавание речи: реестр провайдеров, маршрутизация, адаптеры."""

from .errors import USER_FACING_MESSAGE, SttError
from .registry import PROVIDER_CODES, SttProviderRegistry
from .routing import SttRoutingService, TranscriptCache, TranscriptionOutcome
from .runtime import USE_CASES, SttRuntime
from .types import SttAudioInput, SttResolvedConfig, SttResult

__all__ = [
    "PROVIDER_CODES",
    "USER_FACING_MESSAGE",
    "USE_CASES",
    "SttAudioInput",
    "SttError",
    "SttProviderRegistry",
    "SttResolvedConfig",
    "SttResult",
    "SttRoutingService",
    "SttRuntime",
    "TranscriptCache",
    "TranscriptionOutcome",
]
