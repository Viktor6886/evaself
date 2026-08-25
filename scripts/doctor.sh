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
STICKER_CATALOG="$(get_env EVA_TELEGRAM_STICKER_CATALOG_JSON || true)"
if [ -z "$STICKER_CATALOG" ] || [ "$STICKER_CATALOG" = "{}" ]; then
	if [ -f "eva-agent-service/assets/stickers/support.webp" ]; then
		ok "Telegram stickers: using_local_assets (file_id появятся в bot-scoped cache после первой отправки)"
	else
		critical "Telegram stickers: asset_missing"
	fi
else
	info "Telegram stickers: legacy file_id overrides configured; local assets remain fallback"
fi
[ -n "$(get_env MEDIA_SERVICE_TOKEN || true)" ] || soft "MEDIA_SERVICE_TOKEN пуст — media-service принимает запросы без аутентификации"
[ -n "$(get_env MEDIA_ASR_BASE_URL || true)" ] || info "ASR not configured yet (voice messages will be refused politely)"

# =====================================================================
step "Containers"
# =====================================================================
EXPECTED=(caddy postgres valkey eva-agent-service llm-router admin-api admin-ui letta-app-server letta-ui webapp searxng crawl4ai media-service backup-service)
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
if compose_no_stdin exec -T postgres pg_isready -q -U "$POSTGRES_SUPER_USER" 2>/dev/null; then
	ok "PostgreSQL accepting connections"
	for db in "$EVA_DB_NAME" "$LETTA_DB_NAME"; do
		if compose_no_stdin exec -T postgres psql -tAq -U "$POSTGRES_SUPER_USER" -d postgres \
			-c "SELECT 1 FROM pg_database WHERE datname='$db'" 2>/dev/null | grep -q 1; then
			ok "database $db exists"
		else
			critical "database $db is missing"
		fi
	done

	TABLES="$(compose_no_stdin exec -T -e PGPASSWORD="$EVA_DB_PASSWORD" postgres \
		psql -tAq -U "$EVA_DB_USER" -d "$EVA_DB_NAME" \
		-c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" 2>/dev/null | tr -dc '0-9')"
	if [ "${TABLES:-0}" -ge 21 ]; then
		ok "eva schema present (${TABLES} tables)"
	else
		critical "eva schema incomplete (${TABLES:-0} tables) — run scripts/db-migrate.sh"
	fi

	USERS="$(compose_no_stdin exec -T -e PGPASSWORD="$EVA_DB_PASSWORD" postgres \
		psql -tAq -U "$EVA_DB_USER" -d "$EVA_DB_NAME" -c "SELECT count(*) FROM users" 2>/dev/null | tr -dc '0-9')"
	AGENTS="$(compose_no_stdin exec -T -e PGPASSWORD="$EVA_DB_PASSWORD" postgres \
		psql -tAq -U "$EVA_DB_USER" -d "$EVA_DB_NAME" -c "SELECT count(*) FROM agent_links WHERE status='active'" 2>/dev/null | tr -dc '0-9')"
	CONVS="$(compose_no_stdin exec -T -e PGPASSWORD="$EVA_DB_PASSWORD" postgres \
		psql -tAq -U "$EVA_DB_USER" -d "$EVA_DB_NAME" \
		-c "SELECT count(*) FROM agent_links WHERE status='active' AND conversation_id IS NOT NULL" 2>/dev/null | tr -dc '0-9')"
	info "users: ${USERS:-0}   agents: ${AGENTS:-0}   with a conversation: ${CONVS:-0}"
	if [ "${AGENTS:-0}" -gt "${CONVS:-0}" ]; then
		soft "$(( AGENTS - CONVS )) agent(s) have no conversation — they get one on the next message"
	fi
else
	critical "PostgreSQL is not accepting connections"
fi

if compose_no_stdin exec -T valkey sh -c 'valkey-cli -a "$VALKEY_PASSWORD" ping' 2>/dev/null | grep -q PONG; then
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
	code="$(compose_no_stdin exec -T "$svc" sh -c "wget -qO- -S '$url' 2>&1 | awk '/HTTP\\//{print \$2; exit}'" 2>/dev/null | tr -dc '0-9')"
	if [ -z "$code" ]; then
		# containers without wget: try curl
		code="$(compose_no_stdin exec -T "$svc" sh -c "curl -s -o /dev/null -w '%{http_code}' '$url'" 2>/dev/null | tr -dc '0-9')"
	fi
	if [ -z "$code" ]; then
		# The Node service image deliberately contains neither wget nor curl.
		code="$(compose_no_stdin exec -T "$svc" node -e \
			"fetch(process.argv[1]).then(r=>console.log(r.status)).catch(()=>process.exit(1))" \
			"$url" 2>/dev/null | tr -dc '0-9')"
	fi
	if [ -z "$code" ]; then
		# The Python media image uses urllib in its Docker healthcheck.
		code="$(compose_no_stdin exec -T "$svc" python -c \
			"import sys,urllib.request; print(urllib.request.urlopen(sys.argv[1],timeout=5).status)" \
			"$url" 2>/dev/null | tr -dc '0-9')"
	fi
	if [ "$code" = "$expect" ]; then ok "$name ($code)"; else critical "$name returned '${code:-no answer}', expected $expect"; fi
}

probe "agent service /health" eva-agent-service "http://127.0.0.1:${EVA_AGENT_PORT}/health"
probe "admin-api /health" admin-api "http://127.0.0.1:8071/health"
probe "admin-ui /healthz" admin-ui "http://127.0.0.1:8083/healthz"
probe "searxng /healthz"  searxng       "http://127.0.0.1:8080/healthz"
probe "media /health"     media-service "http://127.0.0.1:8090/health"
probe "webapp /healthz"   webapp        "http://127.0.0.1:8082/healthz"
# Роутер — единственная точка выхода к языковым моделям: если он лёг,
# Ева молчит целиком, поэтому проверка обязательная, а не мягкая.
probe "llm-router /health" llm-router   "http://127.0.0.1:8073/health"
probe "letta-ui /healthz" letta-ui      "http://127.0.0.1:8081/healthz"

# Синхронизация персоны: канонический текст личности Евы у уже созданных
# агентов. Выключенная или сорвавшаяся не видна ни по одному коду ответа
# — агент просто продолжает говорить о себе прежним текстом, — поэтому
# состояние читается явно.
persona_state() {
	local body
	body="$(docker compose exec -T eva-agent-service node -e \
		"fetch('http://127.0.0.1:'+(process.env.EVA_AGENT_PORT||8070)+'/health').then(r=>r.text()).then(console.log).catch(()=>process.exit(1))" \
		2>/dev/null || true)"
	[ -n "$body" ] || { warn "persona sync: состояние недоступно (сервис не ответил)"; return; }
	local status
	status="$(printf '%s' "$body" | python3 -c 'import json,sys;print((json.load(sys.stdin).get("checks",{}).get("persona_sync") or {}).get("status","unknown"))' 2>/dev/null || echo unknown)"
	case "$status" in
		ok) ok "persona sync: канонический текст доставлен" ;;
		never) warn "persona sync: ещё не выполнялась" ;;
		unsupported) soft "persona sync: SDK не поддерживает часть maintenance-операций" ;;
		degraded|stale|failed) soft "persona sync: degraded, обычные ходы не блокируются" ;;
		*) warn "persona sync: состояние неизвестно" ;;
	esac
}
persona_state

# Память и навыки — по фактам рантайма, а не по самоотчёту Евы.
#
# `/ready` уже собирает и то и другое, поэтому здесь только пересказ: 4/4
# канонических блока, блоки прежней схемы, MemFS, источники навыков и
# сколько из двенадцати навыков проекта видно. Содержимого блоков и
# навыков не выводится — только метки и счётчики.
runtime_state() {
	local body
	body="$(docker compose exec -T eva-agent-service node -e \
		"fetch('http://127.0.0.1:'+(process.env.EVA_AGENT_PORT||8070)+'/ready').then(r=>r.text()).then(console.log).catch(()=>process.exit(1))" \
		2>/dev/null || true)"
	[ -n "$body" ] || { warn "рантайм: состояние недоступно (сервис не ответил)"; return; }
	local summary
	summary="$(printf '%s' "$body" | python3 -c '
import json, sys
d = json.load(sys.stdin)
memory = d.get("memory") or {}
skills = d.get("skills") or {}
project = skills.get("project") or []
missing = skills.get("missing") or []
collisions = skills.get("collisions") or []
sources = skills.get("sources")
native = skills.get("nativeSkillTool")
print("legacy=%d" % memory.get("legacyAgents", 0))
print("skills=%d/%d" % (len(project), skills.get("expected") or len(project)))
print("missing=%d" % len(missing))
print("collisions=%d" % len(collisions))
print("sources=%s" % (",".join(sources) if sources else "не сообщены"))
print("native=%s" % ("да" if native is True else "нет" if native is False else "не наблюдаем"))
' 2>/dev/null || true)"
	[ -n "$summary" ] || { warn "рантайм: ответ не разобран"; return; }
	local legacy skills_seen missing collisions sources native
	legacy="$(printf '%s\n' "$summary" | sed -n 's/^legacy=//p')"
	skills_seen="$(printf '%s\n' "$summary" | sed -n 's/^skills=//p')"
	missing="$(printf '%s\n' "$summary" | sed -n 's/^missing=//p')"
	collisions="$(printf '%s\n' "$summary" | sed -n 's/^collisions=//p')"
	sources="$(printf '%s\n' "$summary" | sed -n 's/^sources=//p')"
	native="$(printf '%s\n' "$summary" | sed -n 's/^native=//p')"

	[ "${legacy:-0}" = "0" ] \
		&& ok "память: агентов с блоками прежней схемы нет" \
		|| warn "память: у ${legacy} агентов блоки прежней схемы ждут переноса"
	[ "${missing:-0}" = "0" ] \
		&& ok "навыки проекта: ${skills_seen}" \
		|| critical "навыки проекта: ${skills_seen}, не найдено ${missing}"
	[ "${collisions:-0}" = "0" ] \
		|| critical "навыки: совпадающих имён — ${collisions}"
	ok "источники навыков: ${sources}; нативный Skill: ${native}"
}
runtime_state

# The active LLM lives in the `llm_providers` registry, not in .env: a key
# rotated through the WebUI never touches the file.
LLM_STATE="$(compose exec -T eva-agent-service node -e "
const key = process.env.EVA_AGENT_API_KEY;
fetch('http://127.0.0.1:'+(process.env.EVA_AGENT_PORT||8070)+'/v1/llm/providers',{headers:{'X-API-Key':key}})
  .then(r=>r.json())
  .then(b=>{const a=(b.providers||[]).find(p=>p.is_active);
            console.log(a?('ok '+a.model_handle):'NONE')})
  .catch(e=>console.log('FAIL '+e.message))" 2>/dev/null | tr -d '\r')"
case "$LLM_STATE" in
	ok\ *) ok "активный LLM: ${LLM_STATE#ok }" ;;
	NONE)  soft "активная LLM-конфигурация не выбрана — Ева не сможет отвечать (make configure-llm)" ;;
	*)     soft "не удалось прочитать реестр LLM: ${LLM_STATE:-нет ответа}" ;;
esac

# The agent service's own /health proves the Agent SDK can reach the App
# Server over WebSocket, which a TCP probe cannot.
APP_SERVER_STATE="$(compose_no_stdin exec -T eva-agent-service node -e "
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
	PUBLIC=("site:$DOMAIN" "admin:$DOMAIN/admin/" "webapp:$DOMAIN_APP" "api:$DOMAIN_API/health" "letta:$DOMAIN_LETTA")
	for pair in "${PUBLIC[@]}"; do
		label="${pair%%:*}"; host="${pair#*:}"
		code="$(http_status "https://$host" 12)"
		if [ "$label" = "admin" ]; then
			case "$code" in
				200|204) ok "$label https://$host ($code)" ;;
				401) critical "$label https://$host использует устаревшую Basic Auth — перезагрузите Caddy" ;;
				000) critical "$label https://$host недоступна" ;;
				*) critical "$label https://$host вернула $code" ;;
			esac
			continue
		fi
		if [ "$label" = "letta" ]; then
			case "$code" in
				401) ok "$label https://$host (401 — защищена, как и задумано)" ;;
				000) critical "$label https://$host недоступна" ;;
				*) critical "$label https://$host не защищена ожидаемой Basic Auth (код $code)" ;;
			esac
			continue
		fi
		case "$code" in
			200|204|301|302) ok "$label https://$host ($code)" ;;
			401) ok "$label https://$host (401 — protected, as intended)" ;;
			000) critical "$label https://$host unreachable (DNS, firewall or certificate)" ;;
			*) soft "$label https://$host returned $code" ;;
		esac
	done

	# 200 on the Mini App's HTML is not enough. When its assets do not
	# resolve, the static server answers them with index.html — status 200,
	# type text/html — and the browser, told not to sniff, throws away the
	# stylesheet and the script. The page then opens bare and nothing in the
	# logs looks wrong. So check what actually comes back, not the code.
	for pair in "app.css:text/css" "app.js:text/javascript"; do
		asset="${pair%%:*}"; want="${pair#*:}"
		got="$(http_content_type "https://$DOMAIN_APP/app/$asset" 12)"
		case "$got" in
			"$want") ok "Mini App /app/$asset отдаётся как $got" ;;
			text/html)
				critical "Mini App /app/$asset вернул HTML вместо $want — браузер его отбросит, экран откроется без стилей и скриптов" ;;
			"") critical "Mini App /app/$asset недоступен" ;;
			*) soft "Mini App /app/$asset отдаётся как $got, ожидалось $want" ;;
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

LATEST="$(find "$BACKUP_DIR" -maxdepth 1 \
	\( -name 'evaself-backup-*.tar.gz.enc' -o -name 'evaself-backup-*.tar.gz' \) \
	-printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
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
