#!/usr/bin/env bash
# =====================================================================
# Apply postgres/migrations/*.sql to the eva database.
#
# The init script runs them on a brand new data directory; this runs them
# on every install and update, so an existing installation picks up new
# migrations. Every migration is written to be idempotent and records
# itself in the schema_migrations table.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env
step "Применение миграций PostgreSQL"

MIGRATIONS_DIR="$ROOT_DIR/postgres/migrations"
[ -d "$MIGRATIONS_DIR" ] || { warn "каталог миграций отсутствует"; exit 0; }

applied=0
for file in $(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | sort); do
	name="$(basename "$file")"
	version="${name%.sql}"

	# Skip if this version is already recorded (the table may not exist yet).
	already="$(compose exec -T -e PGPASSWORD="$EVA_DB_PASSWORD" postgres \
		psql -tAq -U "$EVA_DB_USER" -d "$EVA_DB_NAME" \
		-c "SELECT 1 FROM schema_migrations WHERE version = '$version'" 2>/dev/null || true)"

	if [ "$already" = "1" ]; then
		info "$name уже применена"
		continue
	fi

	if compose exec -T -e PGPASSWORD="$EVA_DB_PASSWORD" postgres \
		psql -v ON_ERROR_STOP=1 -q -U "$EVA_DB_USER" -d "$EVA_DB_NAME" < "$file" >/dev/null; then
		ok "применена $name"
		applied=$((applied + 1))
	else
		die "миграция $name завершилась ошибкой"
	fi
done

[ "$applied" -gt 0 ] || ok "схема уже актуальна"
