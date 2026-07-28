# Media service

FastAPI + ffmpeg. Reachable only from inside `evaself-network` — Caddy
never routes it.

## Endpoints

```
GET  /health                 ffmpeg presence, ASR/TTS configuration
POST /probe                  duration, codec, channels of an upload
POST /transcribe             upload -> WAV 16 kHz mono -> ASR -> text
POST /telegram/transcribe    {"file_id": …} -> download -> transcribe
POST /tts                    text -> speech; format=voice returns OGG/Opus
```

`/transcribe` returns `duration_minutes` so n8n can charge the
`voice_minutes` quota with the real length of the recording.

## Why the conversions

Telegram voice notes are OGG/Opus, which most Whisper-compatible
endpoints reject. Everything is normalised to 16 kHz mono PCM WAV before
upload. Replies go the other way: the TTS MP3 is re-encoded to
48 kHz mono Opus with `-application voip`, which is what Telegram needs to
render a real voice message rather than a file attachment.

## Temporary files

Every request works inside `/data/media/job-<uuid>/`, removed in a
`finally` block (and, for streamed responses, in a Starlette background
task). A sweeper additionally deletes any workspace older than
`MEDIA_TMP_TTL_SECONDS`, so a crashed request cannot leak disk.

Limits: `MEDIA_MAX_UPLOAD_MB` (streamed, enforced while writing) and
`MEDIA_MAX_AUDIO_SECONDS` (checked after probing).

## Configuration

`MEDIA_ASR_*` and `MEDIA_TTS_*` are intentionally left **empty** by the
installer — the owner fills them in later. Until then the endpoints answer
`503 asr_not_configured` / `503 tts_not_configured` instead of failing in
some obscure way.

Any OpenAI-compatible endpoint works: the service calls
`POST {BASE_URL}/audio/transcriptions` and `POST {BASE_URL}/audio/speech`.

## Dependencies

ffmpeg and every Python package are installed **at image build time**
(`Dockerfile`), never at container start.

## Tests

```bash
python -m pytest      # generates real Opus audio with ffmpeg
```
