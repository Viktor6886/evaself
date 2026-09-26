ARG PYTHON_BASE_IMAGE=python
ARG PYTHON_BASE_VERSION=3.12-slim-bookworm

# ---------------------------------------------------------------------
# osint-harvester — theHarvester (GPL-2.0-only) за HTTP-обёрткой.
# GPL-компонент живёт в отдельном контейнере; Evaself обращается к нему
# только по HTTP (docs/OSINT.md).
#
# Код theHarvester закреплён по коммиту тега 4.11.1 и сверяется после
# клонирования: новая версия — осознанная правка этого файла.
# ---------------------------------------------------------------------
FROM ${PYTHON_BASE_IMAGE}:${PYTHON_BASE_VERSION} AS source
ARG THEHARVESTER_COMMIT=fd832dee7936458a4f6e2029bf37ba6797228676
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --filter=blob:none https://github.com/laramies/theHarvester /src \
 && git -C /src checkout --quiet "${THEHARVESTER_COMMIT}" \
 && test "$(git -C /src rev-parse HEAD)" = "${THEHARVESTER_COMMIT}" \
 && rm -rf /src/.git

FROM ${PYTHON_BASE_IMAGE}:${PYTHON_BASE_VERSION} AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
# Зависимости — из своего lock-файла: в пинах upstream есть версии с
# известными уязвимостями. theHarvester ставится поверх без зависимостей.
COPY requirements.lock /tmp/requirements.lock
RUN pip install -r /tmp/requirements.lock
COPY --from=source /src /opt/theHarvester
RUN pip install --no-deps /opt/theHarvester && rm -rf /opt/theHarvester
WORKDIR /app
COPY app /app/app

FROM base AS test
RUN pip install pytest==9.1.1 ruff==0.16.9
COPY pyproject.toml pytest.ini /app/
COPY tests /app/tests
ENV EVA_ENV=test
# Разрешённые источники обязаны существовать в закреплённой версии:
# переименованный источник молча выпал бы из сбора.
RUN ruff check . && ruff format --check . && python -m pytest -q -p no:warnings \
 && python -c "from theHarvester.lib.core import Core; from app.main import ALLOWED_SOURCES as a; \
missing = set(a) - set(Core.get_supportedengines()); assert not missing, missing"

# theHarvester при импорте пишет proxies.yaml в домашний каталог, а кэш —
# в ~/.local/share: корень контейнера только для чтения, HOME — tmpfs.
FROM base AS runtime
ENV HOME=/tmp
RUN useradd --system --uid 10004 --create-home harvester && chown -R harvester:harvester /app
USER harvester
EXPOSE 8096
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8096", "--no-access-log"]
