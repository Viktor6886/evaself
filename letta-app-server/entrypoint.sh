#!/bin/sh
# =====================================================================
# Start the Letta App Server.
#
#   letta server --listen ws://0.0.0.0:4500 [--ws-auth capability-token]
#
# Authentication: the App Server only enforces a token on non-loopback
# listeners, which is exactly our case (eva-agent-service connects from
# another container). LETTA_APP_SERVER_TOKEN is written to a file because
# the CLI takes the token by path, never on the command line where it
# would show up in `ps`.
# =====================================================================
set -eu

# Явная команда docker run/compose run используется для диагностики образа.
if [ "$#" -gt 0 ]; then
	case "$1" in
		sh|bash|node|letta)
			exec "$@"
			;;
	esac
fi

LISTEN_URL="${LETTA_APP_SERVER_LISTEN:-ws://0.0.0.0:4500}"
STATE_DIR="${LETTA_HOME:-/data/letta}"
TOKEN_FILE="${STATE_DIR}/ws-token"
BACKEND="${LETTA_APP_SERVER_BACKEND:-local}"
CONTROL_FILE="${LETTA_LLM_RESTART_FILE:-/data/llm-control/restart.request}"

mkdir -p "$STATE_DIR" "${LETTA_LOCAL_BACKEND_DIR:-$STATE_DIR/lc-local-backend}"

log() { printf '[letta-app-server] %s\n' "$*" >&2; }

set -- --backend "$BACKEND" server --listen "$LISTEN_URL"

if [ -n "${LETTA_APP_SERVER_TOKEN:-}" ]; then
	printf '%s' "$LETTA_APP_SERVER_TOKEN" > "$TOKEN_FILE"
	chmod 600 "$TOKEN_FILE"
	set -- "$@" --ws-auth capability-token --ws-token-file "$TOKEN_FILE"
	log "capability-token authentication enabled"
else
	log "WARNING: LETTA_APP_SERVER_TOKEN is empty — the listener is unauthenticated."
	log "         Only acceptable because the port is not published outside evaself-network."
fi

# Serve OpenAI-compatible routes as well when asked. Off by default: it is
# another surface, and Evaself does not need it.
if [ "${LETTA_APP_SERVER_OPENAI_API:-0}" = "1" ]; then
	set -- "$@" --openai-api
	log "OpenAI-compatible routes enabled"
fi

log "state directory: ${STATE_DIR}"
log "backend: ${BACKEND}"
log "listening on: ${LISTEN_URL}"

# Credentials провайдера записывает eva-agent-service официальным Letta CLI
# в shared volume. Letta Code кеширует каталог моделей, поэтому успешное
# переключение меняет CONTROL_FILE. Supervisor перезапускает только процесс
# App Server; Docker, agents и постоянные conversations остаются на месте.
mkdir -p "$(dirname "$CONTROL_FILE")"
LAST_MARKER="$(cat "$CONTROL_FILE" 2>/dev/null || true)"
CHILD_PID=""
STOPPING=0

stop_child() {
	[ -n "$CHILD_PID" ] || return 0
	kill -TERM "$CHILD_PID" 2>/dev/null || true
	wait "$CHILD_PID" 2>/dev/null || true
	CHILD_PID=""
}

shutdown() {
	STOPPING=1
	stop_child
}

trap shutdown INT TERM

while [ "$STOPPING" -eq 0 ]; do
	letta "$@" &
	CHILD_PID=$!
	log "process started (pid ${CHILD_PID})"

	while kill -0 "$CHILD_PID" 2>/dev/null; do
		sleep 1 || true
		MARKER="$(cat "$CONTROL_FILE" 2>/dev/null || true)"
		if [ "$MARKER" != "$LAST_MARKER" ]; then
			LAST_MARKER="$MARKER"
			log "конфигурация LLM изменилась; App Server перезапускается"
			stop_child
			break
		fi
	done

	[ "$STOPPING" -eq 0 ] || break
	if [ -n "$CHILD_PID" ]; then
		if wait "$CHILD_PID"; then STATUS=0; else STATUS=$?; fi
		CHILD_PID=""
		log "процесс неожиданно завершился (status ${STATUS})"
		exit "$STATUS"
	fi
done

exit 0
