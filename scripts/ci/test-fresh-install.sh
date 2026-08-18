#!/usr/bin/env bash
# =====================================================================
# Чистая установка обязана давать ту же схему, что и полная цепочка.
#
# Новая установка пропускает миграции из
# `postgres/migrations/fresh-install-skip.txt` — те, что создают
# подсистемы, удаляемые миграцией 053. Пропуск допустим ровно в одном
# случае: когда результат пропущенной миграции полностью отменён
# позже. Проверяется это единственным честным способом — обе схемы
# строятся по-настоящему и сравниваются.
#
#   PGHOST=... PGPORT=... PGUSER=... PGPASSWORD=... scripts/ci/test-fresh-install.sh
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS="$ROOT_DIR/postgres/migrations"
SKIP_LIST="$MIGRATIONS/fresh-install-skip.txt"
FULL_DB="${FULL_DB:-eva_chain}"
FRESH_DB="${FRESH_DB:-eva_fresh}"

psql_run() { psql -v ON_ERROR_STOP=1 -q "$@"; }

prepare() {
	psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" >/dev/null
	psql -q -d postgres -c "CREATE DATABASE $1" >/dev/null
	psql_run -d "$1" -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
	                     CREATE EXTENSION IF NOT EXISTS pg_trgm;
	                     CREATE EXTENSION IF NOT EXISTS vector;' >/dev/null
}

apply_chain() {
	local db="$1" honour_skip="$2" name version
	for file in "$MIGRATIONS"/*.sql; do
		name="$(basename "$file")"
		version="${name%.sql}"
		if [ "$honour_skip" = "yes" ] && grep -qx "$name" "$SKIP_LIST"; then
			psql_run -d "$db" -c "INSERT INTO schema_migrations (version) VALUES ('$version')
			                      ON CONFLICT (version) DO NOTHING" >/dev/null
			continue
		fi
		psql_run -d "$db" -f "$file" >/dev/null
	done
}

# `\restrict` несёт случайный токен в каждом дампе: он к схеме не относится.
dump_schema() {
	pg_dump -d "$1" --schema-only --no-owner --no-acl \
		| grep -vE '^(--|\\restrict|\\unrestrict|$)' | sort
}

echo "==> полная цепочка → $FULL_DB"
prepare "$FULL_DB"
apply_chain "$FULL_DB" no

echo "==> чистая установка → $FRESH_DB"
prepare "$FRESH_DB"
apply_chain "$FRESH_DB" yes

echo "==> сравнение схем"
if ! diff <(dump_schema "$FULL_DB") <(dump_schema "$FRESH_DB") > /tmp/fresh-install-schema.diff; then
	echo "::error::схема чистой установки отличается от схемы полной цепочки"
	head -40 /tmp/fresh-install-schema.diff
	exit 1
fi

echo "==> сравнение списка применённых миграций"
diff \
	<(psql -tAq -d "$FULL_DB" -c "SELECT version FROM schema_migrations ORDER BY version") \
	<(psql -tAq -d "$FRESH_DB" -c "SELECT version FROM schema_migrations ORDER BY version") \
	|| { echo "::error::пропущенные миграции не отмечены применёнными"; exit 1; }

# Пропуск обязан быть выигрышем, а не украшением: если он ничего не
# экономит, список неверен.
skipped="$(grep -cvE '^#|^$' "$SKIP_LIST")"
echo "==> чистая установка пропускает миграций: $skipped"
[ "$skipped" -gt 0 ] || { echo "::error::список пропуска пуст"; exit 1; }

echo "чистая установка и полная цепочка дают одну схему"
