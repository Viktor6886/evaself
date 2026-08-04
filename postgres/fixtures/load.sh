#!/usr/bin/env bash
# =====================================================================
# Загрузка и проверка baseline-фикстуры (шаг 00).
#
#   postgres/fixtures/load.sh              # через docker compose
#   PSQL="psql -d eva" postgres/fixtures/load.sh
#                                          # против произвольной базы
#
# Фикстура идемпотентна: повторный запуск даёт то же состояние.
# Скрипт ничего не удаляет и не меняет схему.
# =====================================================================
set -euo pipefail

FIXTURE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

run_sql() {
	local file="$1"
	if [ -n "${PSQL:-}" ]; then
		# shellcheck disable=SC2086
		$PSQL -v ON_ERROR_STOP=1 -f "$file"
	else
		docker compose exec -T -e PGPASSWORD="${EVA_DB_PASSWORD:?EVA_DB_PASSWORD не задан}" \
			postgres psql -v ON_ERROR_STOP=1 \
			--username "${EVA_DB_USER:?EVA_DB_USER не задан}" \
			--dbname "${EVA_DB_NAME:?EVA_DB_NAME не задан}" < "$file"
	fi
}

echo "==> загрузка baseline-фикстуры"
run_sql "$FIXTURE_DIR/baseline.sql"

echo "==> проверка baseline-фикстуры"
run_sql "$FIXTURE_DIR/verify.sql"

echo "==> baseline-фикстура загружена и проверена"
