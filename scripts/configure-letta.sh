#!/usr/bin/env bash
# =====================================================================
# Connect Eva's model endpoint to the Letta App Server.
#
# The App Server resolves models through Letta Code's provider registry,
# so an OpenAI-compatible endpoint (MiMo, or anything else) is registered
# once with:
#
#   letta connect openai-compatible --base-url … --api-key … --name mimo
#
# run INSIDE the letta-app-server container so the credential lands in its
# persistent state volume and survives restarts and restores.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env

step "Connecting Eva's model to the Letta App Server"

service_running letta-app-server || die "letta-app-server is not running (make start)"

[ -n "${EVA_LLM_BASE_URL:-}" ] || die "EVA_LLM_BASE_URL is empty in .env — run 'make configure'"
[ -n "${EVA_LLM_API_KEY:-}" ] || die "EVA_LLM_API_KEY is empty in .env — run 'make configure'"

PROVIDER_NAME="${EVA_LLM_PROVIDER_NAME:-eva-llm}"
info "endpoint: ${EVA_LLM_BASE_URL}"
info "model:    ${EVA_LLM_MODEL:-(server default)}"
info "provider: ${PROVIDER_NAME}"

# ---------------------------------------------------------------------
# 1. register the provider
# ---------------------------------------------------------------------
if compose exec -T letta-app-server \
	letta connect openai-compatible \
		--base-url "$EVA_LLM_BASE_URL" \
		--api-key "$EVA_LLM_API_KEY" \
		--name "$PROVIDER_NAME"; then
	ok "provider '${PROVIDER_NAME}' registered"
else
	fail "the provider could not be registered"
	say ""
	say "  Letta Code validates a new provider against api.letta.com. If this"
	say "  server cannot reach that host, allow it in your egress policy and"
	say "  run this command again — the model endpoint itself does not need"
	say "  to be public, only the validation call."
	say ""
	say "  Everything else (agents, conversations, memory) keeps working; only"
	say "  turns that need the model will fail until this succeeds."
	exit 1
fi

# ---------------------------------------------------------------------
# 2. show what the App Server now offers
# ---------------------------------------------------------------------
step "Models visible to the App Server"
if service_running eva-agent-service; then
	compose exec -T eva-agent-service node -e "
const key = process.env.EVA_AGENT_API_KEY;
const base = 'http://127.0.0.1:' + (process.env.EVA_AGENT_PORT || 8070);
fetch(base + '/v1/models', { headers: { 'X-API-Key': key } })
  .then((r) => r.json())
  .then((b) => {
    const entries = (b.models && b.models.entries) || [];
    console.log('  ' + entries.length + ' model(s) available');
    for (const entry of entries.slice(0, 12)) console.log('    ' + entry.handle);
    if (entries.length > 12) console.log('    …');
  })
  .catch((e) => console.log('  could not list models: ' + e.message));
" || true
fi

step "Done"
say "  Set EVA_LLM_MODEL in .env to one of the handles above, then:"
say "    make restart"
say ""
say "  New agents are created with that model. Existing agents keep the"
say "  model they were created with."
