ARG PYTHON_BASE_IMAGE=python
ARG PYTHON_BASE_VERSION=3.12-slim-bookworm

# ---------------------------------------------------------------------
# osint-spiderfoot — пассивные модули SpiderFoot за HTTP-обёрткой.
#
# SpiderFoot закреплён по коммиту ветки master (MIT; релиз 4.0 выходил
# под GPL-2.0 и тянет cryptography<4). Зависимости — из своего lock-файла:
# пины upstream содержат версии с известными уязвимостями.
# ---------------------------------------------------------------------
FROM ${PYTHON_BASE_IMAGE}:${PYTHON_BASE_VERSION} AS source
ARG SPIDERFOOT_COMMIT=0f815a203afebf05c98b605dba5cf0475a0ee5fd
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --filter=blob:none https://github.com/smicallef/spiderfoot /src \
 && git -C /src checkout --quiet "${SPIDERFOOT_COMMIT}" \
 && test "$(git -C /src rev-parse HEAD)" = "${SPIDERFOOT_COMMIT}" \
 && rm -rf /src/.git /src/test /src/docs

FROM ${PYTHON_BASE_IMAGE}:${PYTHON_BASE_VERSION} AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SPIDERFOOT_HOME=/opt/spiderfoot \
    SPIDERFOOT_CACHE=/tmp/spiderfoot-cache
COPY requirements.lock /tmp/requirements.lock
RUN pip install -r /tmp/requirements.lock
COPY --from=source /src /opt/spiderfoot
WORKDIR /app
COPY app /app/app

FROM base AS test
RUN pip install pytest==9.1.1 ruff==0.16.9
COPY pyproject.toml pytest.ini /app/
COPY tests /app/tests
ENV EVA_ENV=test PYTHONPATH=/app
# Разрешённые модули и типы событий обязаны существовать в закреплённой
# версии: переименованный модуль молча выпал бы из сбора.
COPY tools /app/tools
RUN ruff check . && ruff format --check . && python -m pytest -q -p no:warnings \
 && python tools/check_allowlist.py /opt/spiderfoot

FROM base AS runtime
RUN useradd --system --uid 10005 --create-home spiderfoot && chown -R spiderfoot:spiderfoot /app
USER spiderfoot
# Корень только для чтения: временные каталоги сканов и кэш — в tmpfs.
ENV HOME=/tmp
EXPOSE 8097
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8097", "--no-access-log"]
