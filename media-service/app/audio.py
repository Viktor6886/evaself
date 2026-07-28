"""ffmpeg wrappers.

Telegram voice notes arrive as OGG/Opus, which most ASR endpoints do not
accept directly. Everything here converts to a 16 kHz mono WAV (the format
every Whisper-compatible endpoint takes) or back to OGG/Opus for replies.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from pathlib import Path

log = logging.getLogger("media.audio")

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

# ASR sample rate that every Whisper-style endpoint accepts.
ASR_SAMPLE_RATE = 16000


class MediaError(Exception):
    def __init__(self, message: str, *, details: str | None = None):
        super().__init__(message)
        self.message = message
        self.details = details


async def _run(*args: str, timeout: float = 300.0) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        proc.kill()
        raise MediaError("ffmpeg timed out") from exc
    return proc.returncode or 0, stdout, stderr


async def probe(path: Path) -> dict:
    """Return duration/format/stream information for a media file."""
    code, stdout, stderr = await _run(
        FFPROBE,
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(path),
        timeout=60,
    )
    if code != 0:
        raise MediaError("cannot probe media file", details=stderr.decode()[:500])

    data = json.loads(stdout or b"{}")
    fmt = data.get("format", {})
    audio_streams = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
    first = audio_streams[0] if audio_streams else {}

    try:
        duration = float(fmt.get("duration", 0.0))
    except (TypeError, ValueError):
        duration = 0.0

    return {
        "duration_seconds": round(duration, 3),
        "format_name": fmt.get("format_name"),
        "size_bytes": int(fmt.get("size", 0) or 0),
        "bit_rate": fmt.get("bit_rate"),
        "audio_codec": first.get("codec_name"),
        "sample_rate": first.get("sample_rate"),
        "channels": first.get("channels"),
        "has_audio": bool(audio_streams),
    }


async def to_asr_wav(source: Path, destination: Path) -> Path:
    """Convert anything (OGG/Opus, MP3, MP4, M4A, video…) into ASR-ready WAV."""
    code, _stdout, stderr = await _run(
        FFMPEG,
        "-hide_banner", "-loglevel", "error",
        "-y",
        "-i", str(source),
        "-vn",                     # drop any video track
        "-ac", "1",                # mono
        "-ar", str(ASR_SAMPLE_RATE),
        "-c:a", "pcm_s16le",
        str(destination),
    )
    if code != 0:
        raise MediaError("audio conversion failed", details=stderr.decode()[:500])
    return destination


async def to_telegram_voice(source: Path, destination: Path) -> Path:
    """Encode to OGG/Opus so Telegram shows it as a real voice message."""
    code, _stdout, stderr = await _run(
        FFMPEG,
        "-hide_banner", "-loglevel", "error",
        "-y",
        "-i", str(source),
        "-vn",
        "-ac", "1",
        "-ar", "48000",
        "-c:a", "libopus",
        "-b:a", "32k",
        "-application", "voip",
        str(destination),
    )
    if code != 0:
        raise MediaError("voice encoding failed", details=stderr.decode()[:500])
    return destination


async def convert(source: Path, destination: Path, *, codec: str | None = None) -> Path:
    """Generic conversion; the container format comes from the extension."""
    args = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source)]
    if codec:
        args += ["-c:a", codec]
    args.append(str(destination))

    code, _stdout, stderr = await _run(*args)
    if code != 0:
        raise MediaError("conversion failed", details=stderr.decode()[:500])
    return destination
