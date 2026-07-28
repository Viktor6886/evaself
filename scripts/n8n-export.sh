#!/usr/bin/env bash
# =====================================================================
# Export the live workflows back into n8n/workflows so edits made in the
# editor can be committed.
#
# Credentials are NOT exported here: they contain secrets and belong in
# backups, not in git. `make backup` exports them separately.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env
step "Exporting n8n workflows"

service_running n8n || die "n8n is not running (make start)"

TARGET="$ROOT_DIR/n8n/workflows"
mkdir -p "$TARGET"

compose exec -T n8n sh -c 'rm -rf /tmp/wf-export && mkdir -p /tmp/wf-export'
compose exec -T n8n n8n export:workflow --all --separate --pretty --output=/tmp/wf-export >/dev/null

CONTAINER="$(compose ps -q n8n)"
[ -n "$CONTAINER" ] || die "cannot find the n8n container"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
docker cp "$CONTAINER:/tmp/wf-export/." "$TMP/" >/dev/null
compose exec -T n8n sh -c 'rm -rf /tmp/wf-export'

count=0
for file in "$TMP"/*.json; do
	[ -e "$file" ] || continue
	cp "$file" "$TARGET/"
	ok "$(basename "$file")"
	count=$((count + 1))
done

step "Exported $count workflow(s) into n8n/workflows"
say "  Review with 'git diff' before committing — exports include node"
say "  positions and ids, so the diff is usually larger than the change."
