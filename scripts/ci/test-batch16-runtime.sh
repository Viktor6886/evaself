#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
name="evaself-batch16-pg-$$"
tmp="$(mktemp -d /tmp/evaself-batch16-XXXXXX)"
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT

port="${BATCH16_PG_PORT:-55432}"
docker run -d --name "$name" -e POSTGRES_PASSWORD=batch16 -e POSTGRES_DB=batch16 -p "127.0.0.1:${port}:5432" pgvector/pgvector:0.8.6-pg17 >/dev/null
ready=false
for _ in $(seq 1 60); do
  if docker exec "$name" psql -U postgres -d batch16 -Atqc 'SELECT 1' 2>/dev/null | grep -qx 1; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ]
url="postgresql://postgres:batch16@127.0.0.1:${port}/batch16"
cat >"$tmp/psql" <<EOF
#!/usr/bin/env bash
exec docker exec -i "$name" psql -U postgres -d batch16 "\${@:2}"
EOF
chmod +x "$tmp/psql"

cd "$ROOT/eva-agent-service"
npm run build
PATH="$tmp:$PATH" PSQL="$tmp/psql" BATCH16_DATABASE_URL="$url" node --test --experimental-strip-types test/knowledge-research-production.test.ts
node --test --experimental-strip-types test/knowledge-research.test.ts

# Production image evidence: scanner exists and distinguishes clean from EICAR.
image="evaself/eva-agent-service:batch16-test"
docker build -t "$image" .
# Refresh belongs to image maintenance/evidence, never service startup.
docker run --rm --entrypoint sh "$image" -c "freshclam >/dev/null 2>&1 || test -n '\$(find /var/lib/clamav -type f -name \"*.cvd\" -print -quit)'; printf clean >/tmp/clean; clamscan --no-summary /tmp/clean"
docker run --rm --entrypoint sh "$image" -c "freshclam >/dev/null 2>&1 || test -n '\$(find /var/lib/clamav -type f -name \"*.cvd\" -print -quit)'; printf 'X5O!P%%@AP[4\\PZX54(P^)7CC)7}\$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H+H*' >/tmp/eicar; clamscan --no-summary /tmp/eicar >/dev/null 2>&1; test \$? -eq 1"

# Live contracts are optional locally but required when CI explicitly enables them.
if [ "${BATCH16_REQUIRE_LIVE_ADAPTERS:-false}" = true ]; then
  : "${SEARXNG_BASE_URL:?SEARXNG_BASE_URL required}"
  : "${CRAWL4AI_BASE_URL:?CRAWL4AI_BASE_URL required}"
  curl -fsS "${SEARXNG_BASE_URL%/}/search?q=evaself&format=json" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const x=JSON.parse(s);if(!Array.isArray(x.results))process.exit(1)})'
  curl -fsS -H 'content-type: application/json' -d '{"urls":["https://example.com"]}' "${CRAWL4AI_BASE_URL%/}/crawl" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const x=JSON.parse(s);if(!Array.isArray(x.results))process.exit(1)})'
fi
