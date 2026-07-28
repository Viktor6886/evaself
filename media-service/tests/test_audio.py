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

from app.audio import ASR_SAMPLE_RATE, MediaError, probe, to_asr_wav, to_telegram_voice

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
