#!/usr/bin/env bash
# =====================================================================
# Full backup.
#
#   /var/backups/evaself/evaself-backup-YYYY-MM-DD-HH-MM.tar.gz
#
# Deliberately NOT encrypted, as specified. The archive contains .env and
# therefore every secret of the installation — it is created with mode
# 600 inside a 700 directory, and it must never be uploaded anywhere
# public.
#
# Contents:
#   postgres/     dumps of eva, nocodb, letta + roles/globals
#   volumes/      app-server state, nocodb, caddy data volumes
#   letta/        the agent/conversation inventory as the App Server and
#                 PostgreSQL each see it
#   config/       .env, Caddyfile, versions.env
#   content/      skills/, library/, webapp/
#   MANIFEST      versions, git commit, checksums
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env

BACKUP_DIR="${BACKUP_DIR:-/var/backups/evaself}"
STAMP="$(date +%Y-%m-%d-%H-%M)"
NAME="evaself-backup-${STAMP}"
ARCHIVE="${BACKUP_DIR}/${NAME}.tar.gz"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
WORK="$STAGE/$NAME"
mkdir -p "$WORK"/{postgres,volumes,letta,config,content}

step "Создание backup Evaself"
info "архив: $ARCHIVE"

# ---------------------------------------------------------------------
# 1. PostgreSQL — through the version-matched helper container
# ---------------------------------------------------------------------
step "PostgreSQL"
if service_running backup-service; then
	compose exec -T backup-service /usr/local/bin/backup-service dump-all /work/dump >/dev/null
	CID="$(compose ps -q backup-service)"
	docker cp "$CID:/work/dump/." "$WORK/postgres/" >/dev/null
	compose exec -T backup-service sh -c 'rm -rf /work/dump'
	ok "сохранено баз: $(find "$WORK/postgres" -name '*.dump' | wc -l), включая globals"
else
	die "backup-service не запущен — сначала запустите стек"
fi

# ---------------------------------------------------------------------
# 2. Docker volumes
# ---------------------------------------------------------------------
step "Docker volumes"
# shellcheck disable=SC1090
. "$VERSIONS_FILE"
HELPER="evaself/backup-service:0.1.0"

dump_volume() {
	local volume="$1" out="$2"
	if ! docker volume inspect "$volume" >/dev/null 2>&1; then
		info "volume $volume отсутствует, пропуск"
		return 0
	fi
	docker run --rm \
		-v "${volume}:/src:ro" \
		-v "${WORK}/volumes:/dst" \
		--entrypoint sh "$HELPER" \
		-c "tar czf /dst/${out} -C /src ." >/dev/null
	ok "$volume -> volumes/${out} ($(du -h "${WORK}/volumes/${out}" | cut -f1))"
}

dump_volume evaself_letta_app_server_data letta_app_server_data.tar.gz
dump_volume evaself_letta_provider_config letta_provider_config.tar.gz
dump_volume evaself_nocodb_data nocodb_data.tar.gz
dump_volume evaself_caddy_data  caddy_data.tar.gz

# ---------------------------------------------------------------------
# 3. Agent / conversation inventory
# ---------------------------------------------------------------------
# The App Server keeps agents, conversations and the memory filesystem on
# disk, so volumes/letta_app_server_data.tar.gz IS the agent state. What is
# captured here in addition is the inventory from both sides, so a restore
# can be checked: PostgreSQL's user -> agent -> conversation mapping, and
# the agent list the App Server itself reports.
# ---------------------------------------------------------------------
step "Agents и conversations"
if service_running eva-agent-service; then
	if compose exec -T eva-agent-service node -e "
const key = process.env.EVA_AGENT_API_KEY;
const base = 'http://127.0.0.1:' + (process.env.EVA_AGENT_PORT || 8070);
const get = (p) => fetch(base + p, { headers: { 'X-API-Key': key } }).then((r) => r.json());
Promise.all([get('/v1/agents'), get('/v1/agents/live').catch(() => ({ agents: [] }))])
  .then(([db, live]) => console.log(JSON.stringify({ database: db.agents, app_server: live.agents }, null, 2)))
  .catch((e) => { console.error(e.message); process.exit(1); });
" > "$WORK/letta/inventory.json" 2>/dev/null; then
		COUNT="$(python3 -c "import json;d=json.load(open('$WORK/letta/inventory.json'));print(len(d.get('database') or []))" 2>/dev/null || echo 0)"
		ok "инвентарь сохранён (agents: ${COUNT})"
	else
		rm -f "$WORK/letta/inventory.json"
		warn "не удалось получить инвентарь; volume App Server всё равно сохранён"
	fi
else
	warn "eva-agent-service не запущен; инвентарь пропущен, volume сохранён"
fi

# ---------------------------------------------------------------------
# 4. configuration and content
# ---------------------------------------------------------------------
step "Конфигурация и контент"
cp "$ENV_FILE"                 "$WORK/config/.env"
cp "$ROOT_DIR/Caddyfile"       "$WORK/config/Caddyfile"
cp "$VERSIONS_FILE"            "$WORK/config/versions.env"
cp "$ROOT_DIR/compose.yaml"    "$WORK/config/compose.yaml"
chmod 600 "$WORK/config/.env"

tar czf "$WORK/content/skills.tar.gz"  -C "$ROOT_DIR" skills
tar czf "$WORK/content/library.tar.gz" -C "$ROOT_DIR" library
tar czf "$WORK/content/webapp.tar.gz"  -C "$ROOT_DIR" webapp
ok "skills, library и WebApp сохранены"

# ---------------------------------------------------------------------
# 5. manifest
# ---------------------------------------------------------------------
step "Манифест"
GIT_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo 'not-a-git-checkout')"
GIT_BRANCH="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '-')"
GIT_DIRTY="$(git -C "$ROOT_DIR" status --porcelain 2>/dev/null | wc -l)"

{
	echo "# Evaself backup manifest"
	echo "created_at=$(date -Iseconds)"
	echo "hostname=$(hostname)"
	echo "domain=${DOMAIN}"
	echo "backup_format=1"
	echo ""
	echo "# installation"
	echo "git_commit=${GIT_COMMIT}"
	echo "git_branch=${GIT_BRANCH}"
	echo "git_uncommitted_files=${GIT_DIRTY}"
	echo "install_dir=${ROOT_DIR}"
	echo ""
	echo "# service versions"
	grep -E '^[A-Z0-9_]+=' "$VERSIONS_FILE"
	echo ""
	echo "# postgres server"
	cat "$WORK/postgres/server-version.txt" 2>/dev/null || true
	echo ""
	echo "# agent runtime"
	echo "agent_runtime=letta-app-server"
	echo "letta_code_version=${LETTA_CODE_VERSION:-unknown}"
	echo "letta_agent_sdk_version=${LETTA_AGENT_SDK_VERSION:-unknown}"
} > "$WORK/MANIFEST"

( cd "$WORK" && find . -type f ! -name CHECKSUMS -exec sha256sum {} + > CHECKSUMS )
ok "манифест и checksums записаны"

# ---------------------------------------------------------------------
# 6. pack
# ---------------------------------------------------------------------
step "Упаковка"
tar czf "$ARCHIVE" -C "$STAGE" "$NAME"
chmod 600 "$ARCHIVE"
ok "$(du -h "$ARCHIVE" | cut -f1)  $ARCHIVE"

# verify the archive is readable before deleting anything
if tar tzf "$ARCHIVE" >/dev/null 2>&1; then
	ok "архив проверен"
else
	die "архив повреждён — ротация не выполнялась"
fi

# ---------------------------------------------------------------------
# 7. rotation
# ---------------------------------------------------------------------
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
step "Ротация (хранение ${RETENTION} дней)"
removed=0
while IFS= read -r old; do
	rm -f "$old"; removed=$((removed + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'evaself-backup-*.tar.gz' -mtime "+${RETENTION}" 2>/dev/null)
[ "$removed" -eq 0 ] && info "удалять нечего" || ok "удалено старых backup: ${removed}"

REMAINING="$(find "$BACKUP_DIR" -maxdepth 1 -name 'evaself-backup-*.tar.gz' | wc -l)"
step "Готово — backup в ${BACKUP_DIR}: ${REMAINING}"
say "  Восстановление: make restore BACKUP=${ARCHIVE}"
