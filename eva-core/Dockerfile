ARG PYTHON_BASE_VERSION=3.12-slim-bookworm
FROM python:${PYTHON_BASE_VERSION}

# ---------------------------------------------------------------------
# Eva Core — the small internal service between n8n and Letta.
# Dependencies are baked into the image; nothing is installed at runtime.
# ---------------------------------------------------------------------
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app

# Run unprivileged.
RUN useradd --system --uid 10001 --create-home eva && chown -R eva:eva /app
USER eva

EXPOSE 8080

# EVA_CORE_PORT is honoured so the port stays configurable from .env.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${EVA_CORE_PORT:-8080} --no-access-log"]
