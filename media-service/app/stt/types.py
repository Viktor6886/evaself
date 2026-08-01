"""Общий контракт адаптеров распознавания.

Постановка приводит контракт на TypeScript, но распознаванием по правилу 3
занимается media-service, а он на Python. Контракт перенесён по смыслу,
а не по синтаксису: те же поля, те же гарантии, идиоматика языка, в
котором он живёт.

Главное свойство SttResult — он одинаков для всех четырёх провайдеров.
Ответ Deepgram не похож на ответ OpenAI ничем, кроме наличия текста
где-то внутри; нормализация здесь и заканчивается, дальше по системе
идёт только эта структура.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

SttProviderCode = str  # 'deepgram' | 'openai' | 'google' | 'openrouter'
SttMode = str  # 'batch' | 'streaming'


# ---------------------------------------------------------------------
# Возможности
# ---------------------------------------------------------------------
@dataclass(frozen=True)
class SttCapabilities:
    """Что адаптер действительно умеет.

    Панель строит форму по этим флагам: параметр, которого адаптер не
    поддерживает, в интерфейсе не появляется. Поэтому здесь не должно
    быть желаемого — только подтверждённое официальной документацией
    провайдера на дату, записанную в docs/stt.md.
    """

    batch: bool
    streaming: bool
    interim_results: bool
    endpointing: bool
    word_timestamps: bool
    segment_timestamps: bool
    diarization: bool
    language_detection: bool
    multiple_languages: bool
    custom_vocabulary: bool
    transcript_normalization: bool
    confidence: bool
    supported_audio_formats: tuple[str, ...]

    def as_dict(self) -> dict:
        return {
            "batch": self.batch,
            "streaming": self.streaming,
            "interim_results": self.interim_results,
            "endpointing": self.endpointing,
            "word_timestamps": self.word_timestamps,
            "segment_timestamps": self.segment_timestamps,
            "diarization": self.diarization,
            "language_detection": self.language_detection,
            "multiple_languages": self.multiple_languages,
            "custom_vocabulary": self.custom_vocabulary,
            "transcript_normalization": self.transcript_normalization,
            "confidence": self.confidence,
            "supported_audio_formats": list(self.supported_audio_formats),
        }


# ---------------------------------------------------------------------
# Вход и выход
# ---------------------------------------------------------------------
@dataclass
class SttAudioInput:
    """Аудио на диске плюс то, что о нём уже известно.

    Файл, а не байты: аудио может быть большим, и держать его в памяти
    ради передачи между слоями незачем — ffprobe и httpx одинаково
    хорошо работают с путём.
    """

    path: Path
    duration_seconds: float = 0.0
    mime_type: str = "audio/wav"
    filename: str = "audio.wav"


@dataclass
class SttKey:
    """Один ключ провайдера.

    Ключей у конфигурации может быть несколько: у бесплатных тарифов
    лимиты суточные, и один ключ упирается в них регулярно. Перебор
    между ключами — внутреннее дело запроса, пользователь его не
    замечает.
    """

    key_id: str
    label: str
    secret: str

    def __repr__(self) -> str:  # pragma: no cover - защита от случайного лога
        return f"SttKey(label={self.label!r}, secret=<скрыт>)"


@dataclass
class SttResolvedConfig:
    """Конфигурация с уже подставленным секретом.

    Собирается только в памяти media-service, из снимка, который
    присылает admin-api. Ни в лог, ни в ответ API целиком не попадает:
    поле secret скрыто в repr (см. __repr__).
    """

    config_id: str | None
    name: str
    provider: SttProviderCode
    mode: SttMode
    base_url: str
    model: str
    params: dict
    secret: str = ""
    # Google отдаёт service account JSON целиком, остальным хватает
    # строки. Разделять типы ради этого не стоит — адаптер знает, что
    # разбирать.
    #
    # keys — весь список для перебора; secret — тот ключ, которым сейчас
    # работает адаптер. Адаптеры про список не знают вовсе: подстановкой
    # занимается маршрутизация, там же, где решается и вопрос о резервном
    # провайдере.
    keys: list[SttKey] = field(default_factory=list)
    timeout_ms: int = 120000

    def __repr__(self) -> str:  # pragma: no cover - защита от случайного лога
        return (
            f"SttResolvedConfig(name={self.name!r}, provider={self.provider!r}, "
            f"model={self.model!r}, secret=<{'set' if self.secret else 'missing'}>)"
        )


@dataclass
class SttWord:
    text: str
    start_ms: int | None = None
    end_ms: int | None = None
    confidence: float | None = None

    def as_dict(self) -> dict:
        out: dict = {"text": self.text}
        if self.start_ms is not None:
            out["start_ms"] = self.start_ms
        if self.end_ms is not None:
            out["end_ms"] = self.end_ms
        if self.confidence is not None:
            out["confidence"] = self.confidence
        return out


@dataclass
class SttSegment:
    text: str
    start_ms: int | None = None
    end_ms: int | None = None
    speaker: str | None = None

    def as_dict(self) -> dict:
        out: dict = {"text": self.text}
        if self.start_ms is not None:
            out["start_ms"] = self.start_ms
        if self.end_ms is not None:
            out["end_ms"] = self.end_ms
        if self.speaker is not None:
            out["speaker"] = self.speaker
        return out


@dataclass
class SttResult:
    """Нормализованный результат. Одинаков для всех провайдеров."""

    text: str
    provider: SttProviderCode
    model: str
    latency_ms: int
    language: str | None = None
    duration_ms: int | None = None
    # confidence отсутствует, если провайдер его не вернул. Подставить
    # сюда 1.0 «чтобы поле было» значило бы соврать: оператор примет
    # выдуманное число за измеренное.
    confidence: float | None = None
    words: list[SttWord] = field(default_factory=list)
    segments: list[SttSegment] = field(default_factory=list)
    provider_request_id: str | None = None
    # Фактически отработавший провайдер, если он отличается от
    # запрошенного (OpenRouter выбирает upstream сам).
    upstream_provider: str | None = None
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        out: dict = {
            "text": self.text,
            "provider": self.provider,
            "model": self.model,
            "latency_ms": self.latency_ms,
            "warnings": list(self.warnings),
        }
        if self.language is not None:
            out["language"] = self.language
        if self.duration_ms is not None:
            out["duration_ms"] = self.duration_ms
        if self.confidence is not None:
            out["confidence"] = self.confidence
        if self.words:
            out["words"] = [word.as_dict() for word in self.words]
        if self.segments:
            out["segments"] = [segment.as_dict() for segment in self.segments]
        if self.provider_request_id is not None:
            out["provider_request_id"] = self.provider_request_id
        if self.upstream_provider is not None:
            out["upstream_provider"] = self.upstream_provider
        return out


@dataclass
class ValidationResult:
    ok: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"ok": self.ok, "errors": list(self.errors), "warnings": list(self.warnings)}


# ---------------------------------------------------------------------
# Контракт адаптера
# ---------------------------------------------------------------------
@runtime_checkable
class SttProviderAdapter(Protocol):
    """Всё, что реестр требует от адаптера.

    openStream из постановки намеренно необязателен: streaming сегодня
    подтверждён документацией только у Deepgram и Google, и объявлять
    метод обязательным значило бы вынудить остальные адаптеры отвечать
    заглушкой на то, чего они не умеют.
    """

    provider: SttProviderCode

    def capabilities(self) -> SttCapabilities: ...

    def validate(self, config: SttResolvedConfig) -> ValidationResult: ...

    async def test(
        self, config: SttResolvedConfig, audio: SttAudioInput | None = None
    ) -> SttResult: ...

    async def transcribe(
        self, config: SttResolvedConfig, audio: SttAudioInput, options: dict
    ) -> SttResult: ...
