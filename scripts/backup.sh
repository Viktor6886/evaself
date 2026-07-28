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
#   postgres/     dumps of eva, n8n, nocodb, letta + roles/globals
#   volumes/      app-server state, n8n, nocodb, caddy data volumes
#   letta/        the agent/conversation inventory as the App Server and
#                 PostgreSQL each see it
#   n8n/          workflow + credential exports, and N8N_ENCRYPTION_KEY
#   config/       .env, Caddyfile, versions.env, hermes config
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
mkdir -p "$WORK"/{postgres,volumes,letta,n8n,config,content}

step "Backing up Evaself"
info "target: $ARCHIVE"

# ---------------------------------------------------------------------
# 1. PostgreSQL — through the version-matched helper container
# ---------------------------------------------------------------------
step "PostgreSQL"
if service_running backup-service; then
	compose exec -T backup-service /usr/local/bin/backup-service dump-all /work/dump >/dev/null
	CID="$(compose ps -q backup-service)"
	docker cp "$CID:/work/dump/." "$WORK/postgres/" >/dev/null
	compose exec -T backup-service sh -c 'rm -rf /work/dump'
	ok "dumped $(find "$WORK/postgres" -name '*.dump' | wc -l) database(s) + globals"
else
	die "backup-service is not running — start the stack first"
fi

# ---------------------------------------------------------------------
# 2. Docker volumes
# ---------------------------------------------------------------------
step "Volumes"
# shellcheck disable=SC1090
. "$VERSIONS_FILE"
HELPER="evaself/backup-service:0.1.0"

dump_volume() {
	local volume="$1" out="$2"
	if ! docker volume inspect "$volume" >/dev/null 2>&1; then
		info "volume $volume does not exist, skipping"
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
dump_volume evaself_n8n_data    n8n_data.tar.gz
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
step "Agents and conversations"
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
		ok "inventory captured (${COUNT} mapped agent(s))"
	else
		rm -f "$WORK/letta/inventory.json"
		warn "could not read the agent inventory — the App Server state volume is still backed up"
	fi
else
	warn "eva-agent-service is not running — inventory skipped (state volume still captured)"
fi

# ---------------------------------------------------------------------
# 4. n8n
# ---------------------------------------------------------------------
step "n8n"
if service_running n8n; then
	compose exec -T n8n sh -c 'rm -rf /tmp/bk && mkdir -p /tmp/bk/workflows'
	compose exec -T n8n n8n export:workflow --all --separate --pretty --output=/tmp/bk/workflows >/dev/null 2>&1 || true
	# Credentials stay ENCRYPTED; N8N_ENCRYPTION_KEY is stored beside them.
	compose exec -T n8n n8n export:credentials --all --output=/tmp/bk/credentials.json >/dev/null 2>&1 || true
	CID="$(compose ps -q n8n)"
	docker cp "$CID:/tmp/bk/." "$WORK/n8n/" >/dev/null 2>&1 || true
	compose exec -T n8n sh -c 'rm -rf /tmp/bk'
	ok "exported $(find "$WORK/n8n/workflows" -name '*.json' 2>/dev/null | wc -l) workflow(s) and the credential store"
else
	warn "n8n is not running — using the repository copies of the workflows"
	cp -r "$ROOT_DIR/n8n/workflows" "$WORK/n8n/" 2>/dev/null || true
fi

# Without this key the credentials above cannot be decrypted anywhere.
printf 'N8N_ENCRYPTION_KEY=%s\n' "$N8N_ENCRYPTION_KEY" > "$WORK/n8n/encryption-key.env"
chmod 600 "$WORK/n8n/encryption-key.env"

# ---------------------------------------------------------------------
# 5. configuration and content
# ---------------------------------------------------------------------
step "Configuration and content"
cp "$ENV_FILE"                 "$WORK/config/.env"
cp "$ROOT_DIR/Caddyfile"       "$WORK/config/Caddyfile"
cp "$VERSIONS_FILE"            "$WORK/config/versions.env"
cp "$ROOT_DIR/compose.yaml"    "$WORK/config/compose.yaml"
chmod 600 "$WORK/config/.env"

HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
if [ -d "$HERMES_HOME" ]; then
	tar czf "$WORK/config/hermes.tar.gz" -C "$(dirname "$HERMES_HOME")" "$(basename "$HERMES_HOME")" 2>/dev/null || true
	ok "Hermes configuration saved"
else
	info "no Hermes configuration at $HERMES_HOME"
fi
[ -f /etc/systemd/system/evaself-hermes.service ] && \
	cp /etc/systemd/system/evaself-hermes.service "$WORK/config/" 2>/dev/null || true

tar czf "$WORK/content/skills.tar.gz"  -C "$ROOT_DIR" skills
tar czf "$WORK/content/library.tar.gz" -C "$ROOT_DIR" library
tar czf "$WORK/content/webapp.tar.gz"  -C "$ROOT_DIR" webapp
ok "skills, library and webapp saved"

# ---------------------------------------------------------------------
# 6. manifest
# ---------------------------------------------------------------------
step "Manifest"
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
ok "manifest and checksums written"

# ---------------------------------------------------------------------
# 7. pack
# ---------------------------------------------------------------------
step "Packing"
tar czf "$ARCHIVE" -C "$STAGE" "$NAME"
chmod 600 "$ARCHIVE"
ok "$(du -h "$ARCHIVE" | cut -f1)  $ARCHIVE"

# verify the archive is readable before deleting anything
if tar tzf "$ARCHIVE" >/dev/null 2>&1; then
	ok "archive verified"
else
	die "the archive is corrupt — nothing was rotated"
fi

# ---------------------------------------------------------------------
# 8. rotation
# ---------------------------------------------------------------------
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
step "Rotation (keeping ${RETENTION} days)"
removed=0
while IFS= read -r old; do
	rm -f "$old"; removed=$((removed + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'evaself-backup-*.tar.gz' -mtime "+${RETENTION}" 2>/dev/null)
[ "$removed" -eq 0 ] && info "nothing to remove" || ok "removed ${removed} old backup(s)"

REMAINING="$(find "$BACKUP_DIR" -maxdepth 1 -name 'evaself-backup-*.tar.gz' | wc -l)"
step "Done — ${REMAINING} backup(s) in ${BACKUP_DIR}"
say "  Restore with: make restore BACKUP=${ARCHIVE}"
