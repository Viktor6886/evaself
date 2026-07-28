#!/usr/bin/env bash
# =====================================================================
# Import the workflows shipped in n8n/workflows, plus the one credential
# they need (PostgreSQL), which is generated from .env at import time.
#
# The credential file exists only inside the container, only for the
# duration of the import, and is deleted afterwards. No secret is ever
# written to the repository.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env
step "Importing n8n workflows"

service_running n8n || die "n8n is not running (make start)"

# ---------------------------------------------------------------------
# credential
# ---------------------------------------------------------------------
CRED_JSON="$(python3 - <<'PY'
import json, os
print(json.dumps([{
    "id": "evaself-postgres",
    "name": "Evaself PostgreSQL",
    "type": "postgres",
    "data": {
        "host": os.environ["POSTGRES_HOST"],
        "port": int(os.environ["POSTGRES_PORT"]),
        "database": os.environ["EVA_DB_NAME"],
        "user": os.environ["EVA_DB_USER"],
        "password": os.environ["EVA_DB_PASSWORD"],
        "ssl": "disable",
        "allowUnauthorizedCerts": False,
    },
}]))
PY
)"

printf '%s' "$CRED_JSON" | compose exec -T n8n sh -c 'cat > /tmp/evaself-credentials.json'
if compose exec -T n8n n8n import:credentials --input=/tmp/evaself-credentials.json >/dev/null 2>&1; then
	ok "PostgreSQL credential imported"
else
	warn "credential import reported an error — check 'make logs s=n8n'"
fi
compose exec -T n8n sh -c 'rm -f /tmp/evaself-credentials.json'
info "temporary credential file removed from the container"

# ---------------------------------------------------------------------
# workflows (mounted read-only at /workflows)
# ---------------------------------------------------------------------
count=0
for file in "$ROOT_DIR"/n8n/workflows/*.json; do
	[ -e "$file" ] || continue
	name="$(basename "$file")"
	if compose exec -T n8n n8n import:workflow --input="/workflows/$name" >/dev/null 2>&1; then
		ok "imported $name"
		count=$((count + 1))
	else
		fail "could not import $name"
	fi
done

step "Imported $count workflow(s)"
say "  They are imported INACTIVE on purpose."
say "  Open https://${DOMAIN_N8N} and activate the Telegram workflows yourself."
