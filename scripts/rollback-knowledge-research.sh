#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
root="${EVA_KNOWLEDGE_UPLOAD_ROOT:-/data/knowledge-uploads}"
db="${DATABASE_URL:?DATABASE_URL is required}"
psql_cmd="${PSQL:-psql}"

# Database safety is established before any filesystem mutation. A live row
# may still be owned by a worker even when its file happens to look removable.
nonterminal="$($psql_cmd "$db" -Atq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM knowledge_uploads WHERE status IN ('queued','processing')")"
if [ "$nonterminal" != "0" ]; then
  echo "nonterminal knowledge uploads remain; refusing rollback" >&2
  exit 1
fi

# Down migration is DB-first. Files are cleaned only after PostgreSQL commits;
# a failed down therefore preserves every upload byte for recovery.
$psql_cmd "$db" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/postgres/migrations/down/051_knowledge_research.sql"
EVA_KNOWLEDGE_UPLOAD_ROOT="$root" "$ROOT_DIR/scripts/cleanup-knowledge-uploads.sh" --confirm