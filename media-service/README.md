# Media Service

Внутренний FastAPI + ffmpeg сервис для ASR/TTS.

```text
GET  /health
POST /probe
POST /transcribe
POST /telegram/transcribe
POST /tts
```

Telegram OGG/Opus нормализуется в WAV 16 kHz mono перед ASR. Результат TTS
может быть перекодирован в OGG/Opus для голосового сообщения Telegram.
Сервис возвращает фактическую длительность для квоты `voice_minutes`.

Сервис доступен только в сегменте `evaself-tools` и требует заголовок
`X-Media-Key`. Тесты выполняют реальные
ffmpeg round-trip:

```bash
pip install -r requirements.txt pytest
python -m pytest -q
```
