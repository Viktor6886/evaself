#!/usr/bin/env bash
# =====================================================================
# Health report for a running installation.
#
# Exits non-zero if anything CRITICAL is wrong, so it can be used in
# scripts (make update runs it and rolls back on failure).
# =====================================================================
set -uo pipefail   # deliberately not -e: doctor reports, it does not abort

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env

PROBLEMS=0
WARNINGS=0
critical() { fail "$*"; PROBLEMS=$((PROBLEMS + 1)); }
soft()     { warn "$*"; WARNINGS=$((WARNINGS + 1)); }

# =====================================================================
step "Host"
# =====================================================================
info "uptime:$(uptime -p 2>/dev/null | sed 's/^up//')"
MEM_FREE="$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)"
DISK_PCT="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
DISK_FREE="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
info "memory available: ${MEM_FREE} MB   root disk used: ${DISK_PCT}% (${DISK_FREE} GB free)"
[ "$DISK_PCT" -lt 90 ] || critical "root filesystem is ${DISK_PCT}% full — run 'make disk-cleanup'"
[ "$MEM_FREE" -gt 300 ] || soft "less than 300 MB of memory available"

# =====================================================================
step "Configuration"
# =====================================================================
PERM="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '???')"
if [ "$PERM" = "600" ]; then ok ".env mode 600"; else critical ".env mode is $PERM, expected 600"; fi

for key in DOMAIN EVA_TELEGRAM_WEBHOOK_SECRET EVA_AGENT_API_KEY LETTA_APP_SERVER_TOKEN; do
	if [ -z "$(get_env "$key" || true)" ]; then critical "$key is empty in .env"; fi
done
[ -n "$(get_env ACME_EMAIL || true)" ] || soft "ACME_EMAIL не задан — укажите его перед публичным HTTPS"
[ -n "$(get_env EVA_TELEGRAM_BOT_TOKEN || true)" ] || soft "Telegram Bot Token не задан — бот пока отключён"
[ -n "$(get_env OWNER_TELEGRAM_ID || true)" ] || soft "Telegram ID владельца не задан"
[ -n "$(get_env EVA_LLM_API_KEY || true)" ] || soft "EVA_LLM_API_KEY is empty — Eva cannot answer"
[ -n "$(get_env MEDIA_ASR_BASE_URL || true)" ] || info "ASR not configured yet (voice messages will be refused politely)"

# =====================================================================
step "Containers"
# =====================================================================
EXPECTED=(caddy postgres valkey eva-agent-service letta-app-server letta-ui nocodb webapp searxng media-service backup-service)
for svc in "${EXPECTED[@]}"; do
	cid="$(compose ps -q "$svc" 2>/dev/null)"
	if [ -z "$cid" ]; then
		critical "$svc is not running"
		continue
	fi
	state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)"
	health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$cid" 2>/dev/null)"
	restarts="$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null)"
	case "$state:$health" in
		running:healthy) ok "$svc running, healthy" ;;
		running:n/a)     ok "$svc running" ;;
		running:starting) soft "$svc still starting" ;;
		running:unhealthy) critical "$svc is running but UNHEALTHY" ;;
		*) critical "$svc state=$state health=$health" ;;
	esac
	[ "${restarts:-0}" -lt 5 ] || soft "$svc has restarted ${restarts} times"
done

# =====================================================================
step "Databases"
# =====================================================================
if compose exec -T postgres pg_isready -q -U "$POSTGRES_SUPER_USER" 2>/dev/null; then
	ok "PostgreSQL accepting connections"
	for db in "$EVA_DB_NAME" "$NOCODB_DB_NAME" "$LETTA_DB_NAME"; do
		if compose exec -T postgres psql -tAq -U "$POSTGRES_SUPER_USER" -d postgres \
			-c "SELECT 1 FROM pg_database WHERE datname='$db'" 2>/dev/null | grep -q 1; then
			ok "database $db exists"
		else
			critical "database $db is missing"
		fi
	done

	TABLES="$(compose exec -T -e PGPASSWORD="$EVA_DB_PASSWORD" postgres \
		psql -tAq -U "$EVA_DB_USER" -d "$EVA_DB_NAME" \
		-c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" 2>/dev/null | tr -dc '0-9')"
	if [ "${TABLES:-0}" -ge 21 ]; then
		ok "eva schema present (${TABLES} tables)"
	else
		critical "eva schema incomplete (${TABLES:-0} tables) — run scripts/db-migrate.sh"
	fi

	USERS="$(compose exec -T -e PGPASSWORD="$EVA_DB_PASSWORD" postgres \
		psql -tAq -U "$EVA_DB_USER" -d "$EVA_DB_NAME" -c "SELECT count(*) FROM users" 2>/dev/null | tr -dc '0-9')"
	AGENTS="$(compose exec -T -e PGPASSWORD="$EVA_DB_PASSWORD" postgres \
		psql -tAq -U "$EVA_DB_USER" -d "$EVA_DB_NAME" -c "SELECT count(*) FROM agent_links WHERE status='active'" 2>/dev/null | tr -dc '0-9')"
	CONVS="$(compose exec -T -e PGPASSWORD="$EVA_DB_PASSWORD" postgres \
		psql -tAq -U "$EVA_DB_USER" -d "$EVA_DB_NAME" \
		-c "SELECT count(*) FROM agent_links WHERE status='active' AND conversation_id IS NOT NULL" 2>/dev/null | tr -dc '0-9')"
	info "users: ${USERS:-0}   agents: ${AGENTS:-0}   with a conversation: ${CONVS:-0}"
	if [ "${AGENTS:-0}" -gt "${CONVS:-0}" ]; then
		soft "$(( AGENTS - CONVS )) agent(s) have no conversation — they get one on the next message"
	fi
else
	critical "PostgreSQL is not accepting connections"
fi

if compose exec -T valkey sh -c 'valkey-cli -a "$VALKEY_PASSWORD" ping' 2>/dev/null | grep -q PONG; then
	ok "Valkey responding"
else
	critical "Valkey is not responding"
fi

# =====================================================================
step "Internal endpoints"
# =====================================================================
probe() {
	local name="$1" svc="$2" url="$3" expect="${4:-200}"
	local code
	code="$(compose exec -T "$svc" sh -c "wget -qO- -S '$url' 2>&1 | awk '/HTTP\\//{print \$2; exit}'" 2>/dev/null | tr -dc '0-9')"
	if [ -z "$code" ]; then
		# containers without wget: try curl
		code="$(compose exec -T "$svc" sh -c "curl -s -o /dev/null -w '%{http_code}' '$url'" 2>/dev/null | tr -dc '0-9')"
	fi
	if [ -z "$code" ]; then
		# The Node service image deliberately contains neither wget nor curl.
		code="$(compose exec -T "$svc" node -e \
			"fetch(process.argv[1]).then(r=>console.log(r.status)).catch(()=>process.exit(1))" \
			"$url" 2>/dev/null | tr -dc '0-9')"
	fi
	if [ -z "$code" ]; then
		# The Python media image uses urllib in its Docker healthcheck.
		code="$(compose exec -T "$svc" python -c \
			"import sys,urllib.request; print(urllib.request.urlopen(sys.argv[1],timeout=5).status)" \
			"$url" 2>/dev/null | tr -dc '0-9')"
	fi
	if [ "$code" = "$expect" ]; then ok "$name ($code)"; else critical "$name returned '${code:-no answer}', expected $expect"; fi
}

probe "agent service /health" eva-agent-service "http://127.0.0.1:${EVA_AGENT_PORT}/health"
probe "searxng /healthz"  searxng       "http://127.0.0.1:8080/healthz"
probe "media /health"     media-service "http://127.0.0.1:8090/health"
probe "webapp /healthz"   webapp        "http://127.0.0.1:8082/healthz"
probe "letta-ui /healthz" letta-ui      "http://127.0.0.1:8081/healthz"

# The agent service's own /health proves the Agent SDK can reach the App
# Server over WebSocket, which a TCP probe cannot.
APP_SERVER_STATE="$(compose exec -T eva-agent-service node -e "
fetch('http://127.0.0.1:'+(process.env.EVA_AGENT_PORT||8070)+'/health')
  .then(r=>r.json())
  .then(b=>{const a=b.checks&&b.checks.app_server||{};console.log(a.ok?('ok '+(a.models||0)+' models'):('FAIL '+(a.error||'unknown')))})
  .catch(e=>console.log('FAIL '+e.message))" 2>/dev/null | tr -d '\r')"
case "$APP_SERVER_STATE" in
	ok*) ok "Letta App Server reachable through the Agent SDK ($APP_SERVER_STATE)" ;;
	*)
		if [ -z "$(get_env EVA_LLM_API_KEY || true)" ]; then
			soft "Letta App Server ожидает настройку LLM: ${APP_SERVER_STATE:-нет ответа}"
		else
			critical "Letta App Server not reachable through the Agent SDK: ${APP_SERVER_STATE:-no answer}"
		fi
		;;
esac

# =====================================================================
step "Public HTTPS"
# =====================================================================
if [[ "$DOMAIN" == *.localhost ]]; then
	info "локальный режим: DNS и публичные сертификаты не проверяются"
else
	for pair in "site:$DOMAIN" "webapp:$DOMAIN_APP" "api:$DOMAIN_API/health" "nocodb:$DOMAIN_NOCODB" "letta:$DOMAIN_LETTA"; do
		label="${pair%%:*}"; host="${pair#*:}"
		code="$(http_status "https://$host" 12)"
		case "$code" in
			200|204|301|302) ok "$label https://$host ($code)" ;;
			401) ok "$label https://$host (401 — protected, as intended)" ;;
			000) critical "$label https://$host unreachable (DNS, firewall or certificate)" ;;
			*) soft "$label https://$host returned $code" ;;
		esac
	done
fi

if [ -n "${DOMAIN_STATUS:-}" ]; then
	case ",${COMPOSE_PROFILES:-}," in
		*,monitoring,*) code="$(http_status "https://$DOMAIN_STATUS" 12)"; info "status page: $code" ;;
		*) info "status page disabled (monitoring profile off)" ;;
	esac
fi

# =====================================================================
step "Security"
# =====================================================================
if ufw status 2>/dev/null | head -1 | grep -q active; then ok "UFW active"; else critical "UFW is not active"; fi
if systemctl is-active --quiet fail2ban 2>/dev/null; then ok "Fail2Ban running"; else soft "Fail2Ban is not running"; fi

if docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E 'postgres|valkey' | grep -q '0.0.0.0'; then
	critical "PostgreSQL or Valkey is published on the host — it must not be"
else
	ok "PostgreSQL and Valkey are not published"
fi

# =====================================================================
step "Backups"
# =====================================================================
BACKUP_DIR="${BACKUP_DIR:-/var/backups/evaself}"
if systemctl is-enabled --quiet evaself-backup.timer 2>/dev/null; then
	ok "daily backup timer enabled"
else
	soft "daily backup timer is not enabled"
fi

LATEST="$(find "$BACKUP_DIR" -maxdepth 1 -name 'evaself-backup-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
if [ -n "$LATEST" ]; then
	AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$LATEST") ) / 3600 ))
	SIZE="$(du -h "$LATEST" | cut -f1)"
	if [ "$AGE_H" -lt 48 ]; then ok "latest backup ${AGE_H}h old, ${SIZE} ($(basename "$LATEST"))"
	else soft "latest backup is ${AGE_H}h old"; fi
else
	soft "no backup found in $BACKUP_DIR — run 'make backup'"
fi

# =====================================================================
step "Result"
# =====================================================================
if [ "$PROBLEMS" -eq 0 ] && [ "$WARNINGS" -eq 0 ]; then
	ok "everything checks out"
elif [ "$PROBLEMS" -eq 0 ]; then
	warn "$WARNINGS warning(s), nothing critical"
else
	fail "$PROBLEMS critical problem(s), $WARNINGS warning(s)"
fi
exit $(( PROBLEMS > 0 ? 1 : 0 ))
