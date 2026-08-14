#!/usr/bin/env bash
# =====================================================================
# Идемпотентно подключает базу eva к NocoDB и синхронизирует метаданные.
# PostgreSQL остаётся источником истины; NocoDB не получает права менять
# структуру таблиц, но администратор может редактировать их данные.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env

step "Подключение таблиц Eva к NocoDB"

service_running nocodb ||
	die "NocoDB не запущена — выполните 'make start' и повторите команду"

# «Запущена» и «работает» — разное: контейнер в цикле перезапуска виден
# как running ровно между падениями. Раньше синхронизация в этом случае
# молчала, и причина оставалась в логе, куда никто не смотрел, — самая
# частая из них в том, что образ NocoDB старше её собственной базы
# метаданных, и knex отказывается стартовать.
if ! wait_for_health nocodb 60; then
	warn "NocoDB не сообщила о готовности за 60 с — последние строки её журнала:"
	compose_no_stdin logs --tail=15 nocodb >&2 || true
	die "NocoDB не работает: синхронизация метаданных невозможна"
fi

compose_no_stdin exec -T nocodb node /opt/evaself/nocodb-init-eva.mjs
ok "NocoDB готова: https://${DOMAIN_NOCODB}"
