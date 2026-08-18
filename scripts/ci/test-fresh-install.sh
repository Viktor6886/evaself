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

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# pg_dump обязан быть не старше сервера: клиент 16 против сервера 17
# отказывается работать вовсе. Раньше это было незаметно — дамп шёл
# через process substitution, где `set -e` отказа не видит, и два
# несостоявшихся дампа сравнивались как две одинаковые пустые схемы.
select_pg_dump() {
	local server_major client_major candidate
	server_major="$(psql -tAq -d postgres -c 'SHOW server_version_num')"
	server_major=$((server_major / 10000))
	candidate="/usr/lib/postgresql/$server_major/bin/pg_dump"
	if [ -x "$candidate" ]; then
		PG_DUMP="$candidate"
	else
		PG_DUMP="pg_dump"
	fi
	client_major="$("$PG_DUMP" --version | sed -E 's/.* ([0-9]+).*/\1/')"
	if [ "$client_major" -lt "$server_major" ]; then
		echo "::error::pg_dump $client_major старше сервера $server_major: дамп схемы недостоверен"
		exit 1
	fi
	echo "==> pg_dump $client_major, сервер $server_major"
}

# `\restrict` несёт случайный токен в каждом дампе: он к схеме не относится.
# Дамп пишется в файл, а не в поток: неудача обязана валить проверку, а
# не превращаться в пустую «одинаковую» схему.
dump_schema() {
	local db="$1" out="$2" raw="$WORK_DIR/$2.raw"
	if ! "$PG_DUMP" -d "$db" --schema-only --no-owner --no-acl > "$raw"; then
		echo "::error::pg_dump базы $db завершился с ошибкой"
		exit 1
	fi
	if [ ! -s "$raw" ]; then
		echo "::error::pg_dump базы $db вернул пустой дамп"
		exit 1
	fi
	if ! grep -q '^CREATE TABLE' "$raw"; then
		echo "::error::в дампе базы $db нет ни одной таблицы"
		exit 1
	fi
	grep -vE '^(--|\\restrict|\\unrestrict|$)' "$raw" | sort > "$WORK_DIR/$out"
}

select_pg_dump

echo "==> полная цепочка → $FULL_DB"
prepare "$FULL_DB"
apply_chain "$FULL_DB" no

echo "==> чистая установка → $FRESH_DB"
prepare "$FRESH_DB"
apply_chain "$FRESH_DB" yes

echo "==> сравнение схем"
dump_schema "$FULL_DB" full.sql
dump_schema "$FRESH_DB" fresh.sql
if ! diff -u "$WORK_DIR/full.sql" "$WORK_DIR/fresh.sql" > /tmp/fresh-install-schema.diff; then
	echo "::error::схема чистой установки отличается от схемы полной цепочки"
	head -40 /tmp/fresh-install-schema.diff
	exit 1
fi

echo "==> сравнение списка применённых миграций"
list_migrations() {
	if ! psql -v ON_ERROR_STOP=1 -tAq -d "$1" \
		-c "SELECT version FROM schema_migrations ORDER BY version" > "$WORK_DIR/$2"; then
		echo "::error::не удалось прочитать schema_migrations базы $1"
		exit 1
	fi
	[ -s "$WORK_DIR/$2" ] || { echo "::error::schema_migrations базы $1 пуста"; exit 1; }
}
list_migrations "$FULL_DB" full-versions.txt
list_migrations "$FRESH_DB" fresh-versions.txt
diff -u "$WORK_DIR/full-versions.txt" "$WORK_DIR/fresh-versions.txt" \
	|| { echo "::error::пропущенные миграции не отмечены применёнными"; exit 1; }

# Пропуск обязан быть выигрышем, а не украшением: если он ничего не
# экономит, список неверен.
skipped="$(grep -cvE '^#|^$' "$SKIP_LIST")"
echo "==> чистая установка пропускает миграций: $skipped"
[ "$skipped" -gt 0 ] || { echo "::error::список пропуска пуст"; exit 1; }

echo "чистая установка и полная цепочка дают одну схему"
