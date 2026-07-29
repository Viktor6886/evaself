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

compose_no_stdin exec -T nocodb node /opt/evaself/nocodb-init-eva.mjs
ok "NocoDB готова: https://${DOMAIN_NOCODB}"
