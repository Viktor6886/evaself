#!/usr/bin/env bash
# Mark legacy values as managed and remove the one-time owner password.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env
set_env EVA_ADMIN_BOOTSTRAP_PASSWORD ""

marker="# managed by Evaself admin panel — do not edit"
tmp_file="$(mktemp "${ENV_FILE}.admin.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

awk -v marker="$marker" '
  function managed(name) {
    return name ~ /^(EVA_(TELEGRAM|LLM|EMBEDDING|AGENT|SCHEDULER|HEARTBEAT|PROFILE|VECTOR|GRAPH|CONVERSATION|OUTBOX)_|LETTA_|NC_|TODOIST_|CRAWL4AI_|SEARXNG_SECRET|LAVA_WEBHOOK_|POSTGRES_SUPER_PASSWORD|EVA_DB_PASSWORD|EVA_DB_READONLY_PASSWORD|NOCODB_DB_PASSWORD|LETTA_DB_PASSWORD|VALKEY_PASSWORD)/
  }
  {
    split($0, parts, "=")
    name = parts[1]
    if (managed(name) && previous != marker) print marker
    print
    previous = $0
  }
' "$ENV_FILE" > "$tmp_file"
chmod 600 "$tmp_file"
mv "$tmp_file" "$ENV_FILE"
trap - EXIT
ok "bootstrap-пароль удалён, перенесённые параметры помечены"
