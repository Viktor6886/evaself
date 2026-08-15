"""Real ffmpeg round-trips — no mocks.

A short tone is generated with ffmpeg itself, encoded exactly the way
Telegram encodes a voice note (OGG/Opus, 48 kHz mono), and then pushed
through the same conversion functions the service uses in production.
"""

import asyncio
import shutil
import subprocess
from pathlib import Path

import pytest

from app.audio import (
    ASR_SAMPLE_RATE,
    MediaError,
    convert,
    probe,
    to_asr_wav,
    to_telegram_voice,
)

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg is not installed"
)


@pytest.fixture(scope="module")
def telegram_voice(tmp_path_factory) -> Path:
    """A 3-second OGG/Opus file, i.e. what Telegram sends for a voice note."""
    out = tmp_path_factory.mktemp("media") / "voice.ogg"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k",
            str(out),
        ],
        check=True,
    )
    return out


def test_probe_reports_duration_and_codec(telegram_voice):
    info = asyncio.run(probe(telegram_voice))
    assert info["has_audio"] is True
    assert info["audio_codec"] == "opus"
    assert 2.5 < info["duration_seconds"] < 3.5
    assert info["channels"] == 1


def test_opus_is_converted_to_asr_ready_wav(telegram_voice, tmp_path):
    wav = asyncio.run(to_asr_wav(telegram_voice, tmp_path / "asr.wav"))
    assert wav.exists() and wav.stat().st_size > 1000

    info = asyncio.run(probe(wav))
    assert info["audio_codec"] == "pcm_s16le"
    assert int(info["sample_rate"]) == ASR_SAMPLE_RATE
    assert info["channels"] == 1
    assert 2.5 < info["duration_seconds"] < 3.5


def test_wav_is_re_encoded_as_a_telegram_voice_note(telegram_voice, tmp_path):
    wav = asyncio.run(to_asr_wav(telegram_voice, tmp_path / "asr.wav"))
    ogg = asyncio.run(to_telegram_voice(wav, tmp_path / "reply.ogg"))

    info = asyncio.run(probe(ogg))
    assert info["audio_codec"] == "opus"
    assert info["channels"] == 1
    assert 2.5 < info["duration_seconds"] < 3.5


def test_probing_a_non_media_file_raises(tmp_path):
    junk = tmp_path / "notes.txt"
    junk.write_text("this is not audio")
    with pytest.raises(MediaError):
        asyncio.run(probe(junk))


def test_converting_a_non_media_file_raises(tmp_path):
    junk = tmp_path / "notes.txt"
    junk.write_text("this is not audio")
    with pytest.raises(MediaError):
        asyncio.run(to_asr_wav(junk, tmp_path / "out.wav"))


@pytest.fixture(scope="module")
def raw_pcm(tmp_path_factory) -> Path:
    """Две секунды сырого PCM ровно в том виде, в каком его отдаёт Gemini TTS.

    Ни контейнера, ни заголовка: 24 кГц, моно, signed 16-bit LE.
    """
    out = tmp_path_factory.mktemp("media") / "speech.pcm"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-ac", "1", "-ar", "24000", "-f", "s16le",
            str(out),
        ],
        check=True,
    )
    return out


def test_raw_pcm_keeps_its_real_duration(raw_pcm, tmp_path):
    """Аргументы сырого PCM должны описывать поток, а не что-то похожее.

    У потока без контейнера ffmpeg не может узнать ни частоту, ни
    разрядность, ни число каналов — он берёт свои умолчания. Ошибка в
    любом из трёх параметров не даёт отказа: получается воспроизводимый
    файл неверной длительности и высоты тона, то есть «Ева говорит
    ускоренно или шумом». Поэтому проверяется длительность результата.
    """
    voice = tmp_path / "voice.ogg"
    asyncio.run(to_telegram_voice(raw_pcm, voice, raw_pcm=True))
    info = asyncio.run(probe(voice))
    assert info["has_audio"] is True
    assert abs(info["duration_seconds"] - 2.0) < 0.25, info

    mp3 = tmp_path / "speech.mp3"
    asyncio.run(convert(raw_pcm, mp3, raw_pcm=True))
    assert abs(asyncio.run(probe(mp3))["duration_seconds"] - 2.0) < 0.25


def test_raw_pcm_read_as_a_container_is_refused(raw_pcm, tmp_path):
    """Без признака сырого потока тот же файл не годится.

    Это и есть цена ошибки: ffmpeg ищет в PCM заголовок, не находит и
    отказывается — либо, что хуже, угадывает формат. Проверка сторожит,
    что признак действительно что-то меняет.
    """
    with pytest.raises(MediaError):
        asyncio.run(to_telegram_voice(raw_pcm, tmp_path / "voice.ogg"))
