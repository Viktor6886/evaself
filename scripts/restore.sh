#!/usr/bin/env bash
# =====================================================================
# Restore an installation from a backup archive.
#
#   make restore BACKUP=/path/to/evaself-backup-....tar.gz.enc
#
# Works both on the original server and on a brand new one. On a new
# server the sequence is:
#
#   git clone <repo> && cd evaself
#   sudo make install          # answer the prompts; any values are fine
#   make restore BACKUP=...    # overwrites them with the backed-up state
#
# A safety backup of the current state is taken first, unless the current
# installation has no database at all.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_root

ARCHIVE="${1:?usage: restore.sh /path/to/evaself-backup-....tar.gz.enc}"
[ -f "$ARCHIVE" ] || die "файл не найден: $ARCHIVE"

step "Восстановление из $(basename "$ARCHIVE")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
TAR_ARCHIVE="$ARCHIVE"
if [[ "$ARCHIVE" == *.enc ]]; then
	MASTER_KEY_FILE="${EVA_BACKUP_MASTER_KEY_FILE:-${EVA_SECRETS_MASTER_KEY_FILE:-/etc/evaself/secrets-master-key}}"
	if [[ "$MASTER_KEY_FILE" != /* ]]; then
		MASTER_KEY_FILE="$ROOT_DIR/${MASTER_KEY_FILE#./}"
	fi
	[ -s "$MASTER_KEY_FILE" ] ||
		die "без мастер-ключа восстановление невозможно: $MASTER_KEY_FILE"
	command -v openssl >/dev/null 2>&1 ||
		die "для расшифровки backup требуется openssl"
	TAR_ARCHIVE="$STAGE/decrypted.tar.gz"
	if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
		-pass "file:$MASTER_KEY_FILE" \
		-in "$ARCHIVE" -out "$TAR_ARCHIVE" 2>/dev/null; then
		die "не удалось расшифровать backup: проверьте мастер-ключ"
	fi
fi
tar tzf "$TAR_ARCHIVE" >/dev/null 2>&1 ||
	die "архив не является читаемым backup Evaself"
tar xzf "$TAR_ARCHIVE" -C "$STAGE"
SRC="$(find "$STAGE" -maxdepth 1 -type d -name 'evaself-backup-*' | head -1)"
[ -n "$SRC" ] || die "архив не похож на backup Evaself"

# ---------------------------------------------------------------------
# show what we are about to restore
# ---------------------------------------------------------------------
if [ -f "$SRC/MANIFEST" ]; then
	step "Содержимое backup"
	grep -E '^(created_at|hostname|domain|git_commit)=' "$SRC/MANIFEST" | while IFS='=' read -r k v; do
		info "$(printf '%-12s %s' "$k" "$v")"
	done
	info "базы: $(find "$SRC/postgres" -name '*.dump' -printf '%f ' 2>/dev/null)"
	if [ -f "$SRC/letta/inventory.json" ]; then
		info "agents: $(python3 -c "import json;print(len(json.load(open('$SRC/letta/inventory.json')).get('database') or []))" 2>/dev/null || echo '?')"
	fi
fi

if [ -f "$SRC/CHECKSUMS" ]; then
	if ( cd "$SRC" && sha256sum --quiet -c CHECKSUMS 2>/dev/null ); then
		ok "checksums проверены"
	else
		warn "checksum не совпадает — архив может быть повреждён"
		confirm "Continue anyway?" n || exit 1
	fi
fi

echo
warn "Будут заменены базы, volumes и конфигурация ЭТОЙ установки."
confirm "Proceed with the restore?" n || { say "  aborted"; exit 0; }

# ---------------------------------------------------------------------
# safety backup of the current state
# ---------------------------------------------------------------------
if [ -f "$ENV_FILE" ] && docker volume inspect evaself_postgres_data >/dev/null 2>&1; then
	step "Страховочный backup текущего состояния"
	if "$SCRIPT_DIR/backup.sh" >/dev/null 2>&1; then
		ok "текущее состояние сохранено в ${BACKUP_DIR:-/var/backups/evaself}"
	else
		warn "страховочный backup не удался"
		confirm "Continue without one?" n || exit 1
	fi
fi

# ---------------------------------------------------------------------
# 1. configuration first — everything else depends on it
# ---------------------------------------------------------------------
step "Конфигурация"
if [ -f "$SRC/config/.env" ]; then
	[ -f "$ENV_FILE" ] && cp "$ENV_FILE" "${ENV_FILE}.before-restore"
	cp "$SRC/config/.env" "$ENV_FILE"
	chmod 600 "$ENV_FILE"
	ok ".env restored (previous kept as .env.before-restore)"
fi
[ -f "$SRC/config/versions.env" ] && cp "$SRC/config/versions.env" "$VERSIONS_FILE" && ok "versions.env восстановлен"
[ -f "$SRC/config/Caddyfile" ] && cp "$SRC/config/Caddyfile" "$ROOT_DIR/Caddyfile" && ok "Caddyfile восстановлен"

load_env

# ---------------------------------------------------------------------
# 2. content
# ---------------------------------------------------------------------
step "Контент"
for pair in "skills.tar.gz:skills" "library.tar.gz:library" "webapp.tar.gz:webapp"; do
	file="${pair%%:*}"; dir="${pair#*:}"
	if [ -f "$SRC/content/$file" ]; then
		rm -rf "${ROOT_DIR:?}/${dir}.restore-old"
		[ -d "$ROOT_DIR/$dir" ] && mv "$ROOT_DIR/$dir" "$ROOT_DIR/${dir}.restore-old"
		tar xzf "$SRC/content/$file" -C "$ROOT_DIR"
		rm -rf "${ROOT_DIR:?}/${dir}.restore-old"
		ok "$dir restored"
	fi
done

# ---------------------------------------------------------------------
# 3. stop everything that touches the data
# ---------------------------------------------------------------------
step "Остановка сервисов"
compose stop eva-agent-service letta-app-server letta-ui nocodb webapp caddy >/dev/null 2>&1 || true
ok "контейнеры приложений остановлены; PostgreSQL оставлен для restore"

# ---------------------------------------------------------------------
# 4. volumes
# ---------------------------------------------------------------------
step "Volumes"
HELPER="evaself/backup-service:0.1.0"
docker image inspect "$HELPER" >/dev/null 2>&1 || compose build backup-service >/dev/null

restore_volume() {
	local file="$1" volume="$2"
	[ -f "$SRC/volumes/$file" ] || { info "$file отсутствует, пропуск"; return 0; }
	docker volume create "$volume" >/dev/null
	docker run --rm \
		-v "${volume}:/dst" \
		-v "$SRC/volumes:/src:ro" \
		--entrypoint sh "$HELPER" \
		-c "rm -rf /dst/* /dst/.[!.]* 2>/dev/null; tar xzf /src/${file} -C /dst" >/dev/null
	ok "$volume восстановлен из $file"
}

restore_volume letta_app_server_data.tar.gz evaself_letta_app_server_data
restore_volume letta_provider_config.tar.gz evaself_letta_provider_config
restore_volume nocodb_data.tar.gz evaself_nocodb_data
restore_volume caddy_data.tar.gz  evaself_caddy_data

# ---------------------------------------------------------------------
# 5. databases
# ---------------------------------------------------------------------
step "Базы данных"
compose up -d postgres backup-service >/dev/null
wait_for_health postgres 180 || die "PostgreSQL не запустился"

CID="$(compose ps -q backup-service)"
[ -n "$CID" ] || die "backup-service не запущен"
compose_no_stdin exec -T backup-service sh -c 'rm -rf /work/restore && mkdir -p /work/restore'
docker cp "$SRC/postgres/." "$CID:/work/restore/" >/dev/null
compose_no_stdin exec -T backup-service /usr/local/bin/backup-service restore-all /work/restore
compose_no_stdin exec -T backup-service sh -c 'rm -rf /work/restore'
ok "базы восстановлены"

# ---------------------------------------------------------------------
# 6. bring everything back up
# ---------------------------------------------------------------------
step "Запуск сервисов"
compose up -d --remove-orphans >/dev/null
recreate_caddy || warn "Caddy не запустился с восстановленной конфигурацией"
for svc in letta-app-server eva-agent-service; do
	wait_for_health "$svc" 300 && ok "$svc up" || warn "$svc is still starting"
done

"$SCRIPT_DIR/db-migrate.sh" || warn "миграции сообщили об ошибке"

# ---------------------------------------------------------------------
# 7. verify
# ---------------------------------------------------------------------
"$SCRIPT_DIR/doctor.sh" || warn "post-restore checks reported problems"

step "Restore complete"
say ""
say "  If this is a NEW server, finish the migration:"
say "    1. Point DNS for ${DOMAIN} and its sub-domains at this server."
say "    2. Wait for Caddy to issue certificates (make logs s=caddy)."
say "    3. Re-register the Telegram webhook: scripts/telegram-webhook.sh set"
say "    4. Send a test message to the Telegram bot."
say ""
say "  See docs/MIGRATION.md for the full procedure."
