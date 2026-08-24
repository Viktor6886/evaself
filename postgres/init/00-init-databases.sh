#!/usr/bin/env bash
# =====================================================================
# Runs once, on the very first start of an empty PostgreSQL data
# directory (docker-entrypoint-initdb.d).
#
# Creates one role + one database per component so that a compromise of
# any single service cannot read another service's data:
#
#   eva      — Eva's business data
#   letta    — Letta agents, memory, messages (needs pgvector)
#
# The `eva` schema itself is created by applying postgres/migrations/*.sql.
# =====================================================================
set -euo pipefail

psql_super() {
	psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${1:-postgres}"
}

create_role_and_db() {
	local role="$1" password="$2" db="$3"

	echo "==> creating role '${role}' and database '${db}'"
	psql_super postgres <<-SQL
		DO \$\$
		BEGIN
		    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
		        CREATE ROLE ${role} LOGIN PASSWORD '${password}';
		    ELSE
		        ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}';
		    END IF;
		END
		\$\$;
	SQL

	if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" \
		--username "$POSTGRES_USER" --dbname postgres | grep -q 1; then
		psql_super postgres <<-SQL
			CREATE DATABASE ${db} OWNER ${role} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
		SQL
	fi

	psql_super "${db}" <<-SQL
		REVOKE ALL ON SCHEMA public FROM PUBLIC;
		GRANT ALL ON SCHEMA public TO ${role};
		GRANT ALL ON DATABASE ${db} TO ${role};
	SQL
}

create_role_and_db "$EVA_DB_USER"    "$EVA_DB_PASSWORD"    "$EVA_DB_NAME"
create_role_and_db "$LETTA_DB_USER"  "$LETTA_DB_PASSWORD"  "$LETTA_DB_NAME"

# ---------------------------------------------------------------------
# Extensions that only a superuser may install.
# Letta stores embeddings in pgvector columns and will fail to start if
# the extension is missing.
# ---------------------------------------------------------------------
echo "==> installing extensions"
psql_super "$LETTA_DB_NAME" <<-SQL
	CREATE EXTENSION IF NOT EXISTS vector;
	CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SQL

psql_super "$EVA_DB_NAME" <<-SQL
	CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
	CREATE EXTENSION IF NOT EXISTS pg_trgm;
	CREATE EXTENSION IF NOT EXISTS vector;
SQL

# ---------------------------------------------------------------------
# Read-only role for inspection and reporting: SELECT на схему `eva`
# без права записи. Прикладной код им не пользуется — он нужен человеку,
# который смотрит в базу, и внешним читателям отчётных представлений.
# ---------------------------------------------------------------------
echo "==> creating read-only reporting role"
psql_super postgres <<-SQL
	DO \$\$
	BEGIN
	    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${EVA_DB_READONLY_USER}') THEN
	        CREATE ROLE ${EVA_DB_READONLY_USER} LOGIN PASSWORD '${EVA_DB_READONLY_PASSWORD}';
	    END IF;
	END
	\$\$;
SQL
psql_super "$EVA_DB_NAME" <<-SQL
	GRANT CONNECT ON DATABASE ${EVA_DB_NAME} TO ${EVA_DB_READONLY_USER};
	GRANT USAGE ON SCHEMA public TO ${EVA_DB_READONLY_USER};
	ALTER DEFAULT PRIVILEGES FOR ROLE ${EVA_DB_USER} IN SCHEMA public
	    GRANT SELECT ON TABLES TO ${EVA_DB_READONLY_USER};
SQL

# ---------------------------------------------------------------------
# Apply Eva's schema migrations (mounted read-only at /migrations).
# ---------------------------------------------------------------------
if [ -d /migrations ]; then
	echo "==> applying Eva schema migrations"
	# Чистая установка не строит подсистемы, которые тут же удаляет
	# миграция 053. Список — /migrations/fresh-install-skip.txt;
	# пропущенная миграция сразу отмечается применённой, иначе следующий
	# `make update` попытался бы создать её заново.
	SKIP_LIST=/migrations/fresh-install-skip.txt
	for f in $(ls -1 /migrations/*.sql 2>/dev/null | sort); do
		name="$(basename "$f")"
		if [ -f "$SKIP_LIST" ] && grep -qx "$name" "$SKIP_LIST"; then
			echo "    - $name — пропущена на чистой установке"
			PGPASSWORD="$EVA_DB_PASSWORD" psql -v ON_ERROR_STOP=1 -q \
				--username "$EVA_DB_USER" --dbname "$EVA_DB_NAME" \
				-c "INSERT INTO schema_migrations (version) VALUES ('${name%.sql}')
				    ON CONFLICT (version) DO NOTHING"
			continue
		fi
		echo "    - $name"
		PGPASSWORD="$EVA_DB_PASSWORD" psql -v ON_ERROR_STOP=1 \
			--username "$EVA_DB_USER" --dbname "$EVA_DB_NAME" \
			--file "$f"
	done
fi

echo "==> database initialisation complete"
