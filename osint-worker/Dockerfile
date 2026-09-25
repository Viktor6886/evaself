ARG PYTHON_BASE_IMAGE=python
ARG PYTHON_BASE_VERSION=3.12-slim-bookworm

# ---------------------------------------------------------------------
# osint-worker — детерминированные сборщики OSINT (Maigret, WhatsMyName,
# Sherlock) и сравнение сущностей nomenklatura.
#
# normality (зависимость FollowTheMoney) требует PyICU, а PyICU
# собирается из исходников против libicu. Компилятор и заголовки живут
# только в стадии build; в итоговый образ идут готовые wheels и
# рантайм-библиотека ICU.
# ---------------------------------------------------------------------
FROM ${PYTHON_BASE_IMAGE}:${PYTHON_BASE_VERSION} AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libicu-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt requirements.lock /tmp/
RUN pip wheel --wheel-dir /wheels -r /tmp/requirements.txt -c /tmp/requirements.lock

# Наборы правил закреплены по коммиту и sha256 (tools/fetch_datasets.py).
FROM ${PYTHON_BASE_IMAGE}:${PYTHON_BASE_VERSION} AS datasets
COPY tools/fetch_datasets.py /tmp/fetch_datasets.py
RUN python /tmp/fetch_datasets.py /datasets

FROM ${PYTHON_BASE_IMAGE}:${PYTHON_BASE_VERSION} AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    OSINT_DATASETS_DIR=/app/datasets
RUN apt-get update \
 && apt-get install -y --no-install-recommends libicu72 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /wheels /wheels
COPY requirements.txt requirements.lock /app/
RUN pip install --no-index --find-links /wheels -r /app/requirements.txt -c /app/requirements.lock \
 && rm -rf /wheels
COPY --from=datasets /datasets /app/datasets
COPY app /app/app

# Линт и тесты — в той же среде, что и рантайм: PyICU на раннере CI
# пришлось бы собирать заново. `docker build --target test .`
FROM base AS test
RUN pip install pytest==9.1.1 pytest-asyncio==1.4.0 ruff==0.16.9
COPY pyproject.toml pytest.ini /app/
COPY tools /app/tools
COPY tests /app/tests
ENV EVA_ENV=test
RUN ruff check . && ruff format --check . && python -m pytest -q -p no:warnings

FROM base AS runtime
RUN useradd --system --uid 10003 --create-home osint \
 && chown -R osint:osint /app
USER osint
EXPOSE 8095
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8095", "--no-access-log"]
