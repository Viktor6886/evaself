ARG PYTHON_BASE_IMAGE=python
ARG PYTHON_BASE_VERSION=3.12-slim-bookworm
FROM ${PYTHON_BASE_IMAGE}:${PYTHON_BASE_VERSION}

# ---------------------------------------------------------------------
# Media service — ffmpeg + ASR/TTS glue for Eva.
# ffmpeg and every Python dependency are installed at BUILD time; the
# container never installs anything when it starts.
# ---------------------------------------------------------------------
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app

RUN useradd --system --uid 10002 --create-home media \
 && mkdir -p /data/media && chown -R media:media /app /data/media
USER media

EXPOSE 8090

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090", "--no-access-log"]
