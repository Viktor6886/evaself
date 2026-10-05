#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
name="evaself-batch16-pg-$$"
av_volume="evaself-batch16-clamav-$$"
tmp="$(mktemp -d /tmp/evaself-batch16-XXXXXX)"
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$av_volume" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
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

# Production image evidence: the normal entrypoint drops privileges and the
# actual scanner works offline, before any freshclam download or preparation.
image="evaself/eva-agent-service:batch16-test"
docker build -t "$image" .
docker run --rm -i --network none -v "$av_volume:/var/lib/clamav" "$image" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { DocumentIngestor, scanKnowledgeDocument } from './dist/knowledge/ingestion.js';
assert.equal(process.getuid(), 1000);
await writeFile('/var/lib/clamav/ci-cache-marker', 'writable cache');
const chunks = [];
const ingestor = new DocumentIngestor({ tempRoot: '/tmp', scan: scanKnowledgeDocument,
  legacyEmbeddings: false, embed: async () => { throw new Error('unexpected embedding'); },
  persist: async (items) => chunks.push(...items) });
await ingestor.ingest({ userId: 1, name: 'offline.txt', mime: 'text/plain', bytes: Buffer.from('Knowledge ingestion works offline.') });
assert.ok(chunks.length);
const content = 'BT /F1 12 Tf 72 720 Td (Actual PDF indexing works offline.) Tj ET';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
];
let pdf = '%PDF-1.4\n';
const offsets = objects.map((object, i) => { const offset = Buffer.byteLength(pdf); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await ingestor.ingest({ userId: 1, name: 'offline.pdf', mime: 'application/pdf', bytes: Buffer.from(pdf) });
assert.ok(chunks.some((chunk) => chunk.content.includes('Actual PDF indexing works offline.')));
const cleanChunks = chunks.length;
const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
await writeFile('/tmp/eicar', eicar);
assert.equal(await scanKnowledgeDocument('/tmp/eicar'), 'infected');
await assert.rejects(ingestor.ingest({ userId: 1, name: 'eicar.txt', mime: 'text/plain', bytes: eicar }), /document_antivirus_infected/);
assert.equal(chunks.length, cleanChunks, 'infected content must not be persisted');
await rm('/tmp/eicar');
const controller = new AbortController(); controller.abort(new Error('cancelled'));
await assert.rejects(scanKnowledgeDocument('/tmp/missing', controller.signal), /cancelled/);
console.log('ClamAV offline TXT/PDF ingestion, EICAR and cancellation: PASS');
JS
docker run --rm -i --network none -v "$av_volume:/var/lib/clamav" "$image" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
assert.equal(await readFile('/var/lib/clamav/ci-cache-marker', 'utf8'), 'writable cache');
console.log('ClamAV cache survives container recreation: PASS');
JS
# A missing cache is an ingestion failure, never a bypass of the antivirus.
docker run --rm -i --network none --tmpfs /var/lib/clamav "$image" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { scanKnowledgeDocument } from './dist/knowledge/ingestion.js';
await writeFile('/tmp/clean', 'clean');
assert.equal(await scanKnowledgeDocument('/tmp/clean'), 'unavailable');
console.log('ClamAV missing signatures fail closed: PASS');
JS

# Live contracts are optional locally but required when CI explicitly enables them.
if [ "${BATCH16_REQUIRE_LIVE_ADAPTERS:-false}" = true ]; then
  : "${SEARXNG_BASE_URL:?SEARXNG_BASE_URL required}"
  : "${CRAWL4AI_BASE_URL:?CRAWL4AI_BASE_URL required}"
  curl -fsS "${SEARXNG_BASE_URL%/}/search?q=evaself&format=json" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const x=JSON.parse(s);if(!Array.isArray(x.results))process.exit(1)})'
  curl -fsS -H 'content-type: application/json' -d '{"urls":["https://example.com"]}' "${CRAWL4AI_BASE_URL%/}/crawl" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const x=JSON.parse(s);if(!Array.isArray(x.results))process.exit(1)})'
fi
