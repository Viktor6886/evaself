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

LISTEN_URL="${LETTA_APP_SERVER_LISTEN:-ws://0.0.0.0:4500}"
STATE_DIR="${LETTA_HOME:-/data/letta}"
TOKEN_FILE="${STATE_DIR}/ws-token"
BACKEND="${LETTA_APP_SERVER_BACKEND:-local}"

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

exec letta "$@"
