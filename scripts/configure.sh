#!/usr/bin/env bash
# =====================================================================
# Interactive configuration.
#
# Asks for everything that cannot be guessed, generates every secret, and
# writes .env with mode 600. Re-runnable: existing values become the
# defaults, so `make configure` can change one domain without touching
# passwords.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

TEMPLATE="$ROOT_DIR/.env.example"
[ -f "$TEMPLATE" ] || die ".env.example is missing"

# ---------------------------------------------------------------------
# start from the template, or from the current .env when reconfiguring
# ---------------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
	step "Existing .env found — current values are offered as defaults"
	cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
	info "previous file kept as $(basename "$ENV_FILE").bak.*"
else
	cp "$TEMPLATE" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

current() { get_env "$1" || true; }

# =====================================================================
# 1. domains
# =====================================================================
step "Domains"
say "  Evaself has no hard-coded domain. Enter your main domain; each"
say "  service name is then proposed and can be changed individually."
echo

DOMAIN_DEFAULT="$(current DOMAIN)"
while :; do
	ask DOMAIN "Main domain (e.g. evaself.online)" "$DOMAIN_DEFAULT"
	is_domain "$DOMAIN" && break
	warn "that does not look like a domain name"
done

# Each sub-domain is PROPOSED (prefix + main domain, or whatever is
# already configured) and can be overridden individually by typing over
# the suggestion.
proposed() {
	local key="$1" prefix="$2" existing
	existing="$(current "$key" || true)"
	printf '%s' "${existing:-${prefix}.${DOMAIN}}"
}

ask DOMAIN_APP    "WebApp domain"   "$(proposed DOMAIN_APP app)"
ask DOMAIN_API    "API domain"      "$(proposed DOMAIN_API api)"
ask DOMAIN_N8N    "n8n domain"      "$(proposed DOMAIN_N8N n8n)"
ask DOMAIN_NOCODB "NocoDB domain"   "$(proposed DOMAIN_NOCODB admin)"
ask DOMAIN_LETTA  "Letta UI domain" "$(proposed DOMAIN_LETTA letta)"
ask DOMAIN_STATUS "Status domain"   "$(proposed DOMAIN_STATUS status)"

while :; do
	ask ACME_EMAIL "E-mail for Let's Encrypt" "$(current ACME_EMAIL || true)"
	is_email "$ACME_EMAIL" && break
	warn "that does not look like an e-mail address"
done

echo
info "HTTPS will be issued for:"
for host in "$DOMAIN" "$DOMAIN_APP" "$DOMAIN_API" "$DOMAIN_N8N" "$DOMAIN_NOCODB" "$DOMAIN_LETTA" "$DOMAIN_STATUS"; do
	info "  https://$host"
done
info "All of them must already point at this server's IP address."

# =====================================================================
# 2. Telegram
# =====================================================================
step "Telegram"
say "  Eva and Hermes use two separate bots. Create both with @BotFather."
echo

while :; do
	ask EVA_TELEGRAM_BOT_TOKEN "Eva bot token" "$(current EVA_TELEGRAM_BOT_TOKEN || true)"
	is_telegram_token "$EVA_TELEGRAM_BOT_TOKEN" && break
	warn "a bot token looks like 123456789:AAE...; try again"
done

while :; do
	ask HERMES_TELEGRAM_BOT_TOKEN "Hermes bot token (server agent)" "$(current HERMES_TELEGRAM_BOT_TOKEN || true)"
	is_telegram_token "$HERMES_TELEGRAM_BOT_TOKEN" && break
	warn "a bot token looks like 123456789:AAE...; try again"
done

say "  Your numeric Telegram ID — ask @userinfobot if you do not know it."
say "  Hermes will accept commands from this ID and from nobody else."
while :; do
	ask OWNER_TELEGRAM_ID "Owner Telegram ID" "$(current OWNER_TELEGRAM_ID || true)"
	is_number "$OWNER_TELEGRAM_ID" && break
	warn "the Telegram ID is a number"
done

# =====================================================================
# 3. LLM for Eva
# =====================================================================
step "LLM for Eva"
say "  Any OpenAI-compatible endpoint. Used by Letta for Eva's agents."
echo
ask EVA_LLM_BASE_URL "LLM base URL (…/v1)" "$(current EVA_LLM_BASE_URL || true)"
if [ -n "$(current EVA_LLM_API_KEY || true)" ]; then
	ask EVA_LLM_API_KEY "LLM API key (empty = keep current)" "$(current EVA_LLM_API_KEY)"
else
	ask_secret EVA_LLM_API_KEY "LLM API key"
fi
ask EVA_LLM_MODEL "Model" "$(current EVA_LLM_MODEL || echo 'mimo-v2.5-pro')"
ask EVA_LLM_CONTEXT_WINDOW "Context window" "$(current EVA_LLM_CONTEXT_WINDOW || echo 131072)"

say ""
say "  Embeddings power Letta's archival memory and recall search."
ask_optional EVA_EMBEDDING_BASE_URL "Embedding base URL (empty = same as LLM)" "$(current EVA_EMBEDDING_BASE_URL || true)"
ask EVA_EMBEDDING_MODEL "Embedding model" "$(current EVA_EMBEDDING_MODEL || echo 'text-embedding-3-small')"
ask EVA_EMBEDDING_DIM "Embedding dimensions" "$(current EVA_EMBEDDING_DIM || echo 1536)"
EVA_EMBEDDING_API_KEY="$(current EVA_EMBEDDING_API_KEY || true)"
EVA_EMBEDDING_API_KEY="${EVA_EMBEDDING_API_KEY:-$EVA_LLM_API_KEY}"

# =====================================================================
# 4. optional services
# =====================================================================
step "Optional services"
PROFILES="$(current COMPOSE_PROFILES || true)"

if confirm "Install Crawl4AI for reading and cleaning web pages?" n; then
	case ",$PROFILES," in *,crawl4ai,*) : ;; *) PROFILES="${PROFILES:+$PROFILES,}crawl4ai" ;; esac
	ok "Crawl4AI enabled (headless Chromium, ~1-1.5 GB RAM while crawling)"
else
	PROFILES="$(printf '%s' "$PROFILES" | sed 's/crawl4ai//; s/,,/,/g; s/^,//; s/,$//')"
	info "Crawl4AI skipped — enable it later by editing COMPOSE_PROFILES in .env"
fi

if confirm "Install Uptime Kuma for the status page?" n; then
	case ",$PROFILES," in *,monitoring,*) : ;; *) PROFILES="${PROFILES:+$PROFILES,}monitoring" ;; esac
	ok "status page enabled at https://$DOMAIN_STATUS"
else
	PROFILES="$(printf '%s' "$PROFILES" | sed 's/monitoring//; s/,,/,/g; s/^,//; s/,$//')"
fi

TZ_DEFAULT="$(current TZ || true)"
TZ_DEFAULT="${TZ_DEFAULT:-$(cat /etc/timezone 2>/dev/null || echo UTC)}"
ask TZ_VALUE "Server timezone" "$TZ_DEFAULT"

# =====================================================================
# 5. generated secrets — only when missing, so re-running is safe
# =====================================================================
step "Secrets"

keep_or_generate() {
	local key="$1" generator="${2:-gen_secret}" existing
	existing="$(current "$key" || true)"
	if [ -n "$existing" ]; then
		printf '%s' "$existing"
	else
		"$generator"
	fi
}

POSTGRES_SUPER_PASSWORD="$(keep_or_generate POSTGRES_SUPER_PASSWORD)"
EVA_DB_PASSWORD="$(keep_or_generate EVA_DB_PASSWORD)"
N8N_DB_PASSWORD="$(keep_or_generate N8N_DB_PASSWORD)"
NOCODB_DB_PASSWORD="$(keep_or_generate NOCODB_DB_PASSWORD)"
LETTA_DB_PASSWORD="$(keep_or_generate LETTA_DB_PASSWORD)"
EVA_DB_READONLY_PASSWORD="$(keep_or_generate EVA_DB_READONLY_PASSWORD)"
VALKEY_PASSWORD="$(keep_or_generate VALKEY_PASSWORD)"
EVA_AGENT_API_KEY="$(keep_or_generate EVA_AGENT_API_KEY)"
LETTA_APP_SERVER_TOKEN="$(keep_or_generate LETTA_APP_SERVER_TOKEN)"
SEARXNG_SECRET="$(keep_or_generate SEARXNG_SECRET)"
NC_AUTH_JWT_SECRET="$(keep_or_generate NC_AUTH_JWT_SECRET)"
CRAWL4AI_API_TOKEN="$(keep_or_generate CRAWL4AI_API_TOKEN)"
EVA_TELEGRAM_WEBHOOK_SECRET="$(keep_or_generate EVA_TELEGRAM_WEBHOOK_SECRET)"
N8N_RUNNERS_AUTH_TOKEN="$(keep_or_generate N8N_RUNNERS_AUTH_TOKEN)"

# The encryption key is generated ONCE. Regenerating it makes every stored
# n8n credential permanently undecryptable.
N8N_ENCRYPTION_KEY="$(keep_or_generate N8N_ENCRYPTION_KEY)"

# Admin passwords are shown to the operator at the end of the install.
NC_ADMIN_PASSWORD="$(keep_or_generate NC_ADMIN_PASSWORD gen_password)"
LETTA_UI_PASSWORD="$(keep_or_generate LETTA_UI_PASSWORD gen_password)"
N8N_OWNER_PASSWORD="$(keep_or_generate N8N_OWNER_PASSWORD gen_password)"

NC_ADMIN_EMAIL="$(current NC_ADMIN_EMAIL || true)"
NC_ADMIN_EMAIL="${NC_ADMIN_EMAIL:-$ACME_EMAIL}"
N8N_OWNER_EMAIL="$(current N8N_OWNER_EMAIL || true)"
N8N_OWNER_EMAIL="${N8N_OWNER_EMAIL:-$ACME_EMAIL}"
LETTA_UI_USER="$(current LETTA_UI_USER || true)"
LETTA_UI_USER="${LETTA_UI_USER:-admin}"

ok "secrets ready (existing ones were preserved)"

# =====================================================================
# 6. write .env
# =====================================================================
step "Writing .env"

set_env DOMAIN         "$DOMAIN"
set_env DOMAIN_APP     "$DOMAIN_APP"
set_env DOMAIN_API     "$DOMAIN_API"
set_env DOMAIN_N8N     "$DOMAIN_N8N"
set_env DOMAIN_NOCODB  "$DOMAIN_NOCODB"
set_env DOMAIN_LETTA   "$DOMAIN_LETTA"
set_env DOMAIN_STATUS  "$DOMAIN_STATUS"
set_env ACME_EMAIL     "$ACME_EMAIL"

set_env EVA_TELEGRAM_BOT_TOKEN      "$EVA_TELEGRAM_BOT_TOKEN"
set_env HERMES_TELEGRAM_BOT_TOKEN   "$HERMES_TELEGRAM_BOT_TOKEN"
set_env OWNER_TELEGRAM_ID           "$OWNER_TELEGRAM_ID"
set_env EVA_TELEGRAM_WEBHOOK_SECRET "$EVA_TELEGRAM_WEBHOOK_SECRET"

set_env EVA_LLM_BASE_URL       "$EVA_LLM_BASE_URL"
set_env EVA_LLM_API_KEY        "$EVA_LLM_API_KEY"
set_env EVA_LLM_MODEL          "$EVA_LLM_MODEL"
set_env EVA_LLM_CONTEXT_WINDOW "$EVA_LLM_CONTEXT_WINDOW"
set_env EVA_EMBEDDING_BASE_URL "$EVA_EMBEDDING_BASE_URL"
set_env EVA_EMBEDDING_API_KEY  "$EVA_EMBEDDING_API_KEY"
set_env EVA_EMBEDDING_MODEL    "$EVA_EMBEDDING_MODEL"
set_env EVA_EMBEDDING_DIM      "$EVA_EMBEDDING_DIM"

set_env POSTGRES_SUPER_PASSWORD  "$POSTGRES_SUPER_PASSWORD"
set_env EVA_DB_PASSWORD          "$EVA_DB_PASSWORD"
set_env N8N_DB_PASSWORD          "$N8N_DB_PASSWORD"
set_env NOCODB_DB_PASSWORD       "$NOCODB_DB_PASSWORD"
set_env LETTA_DB_PASSWORD        "$LETTA_DB_PASSWORD"
set_env EVA_DB_READONLY_PASSWORD "$EVA_DB_READONLY_PASSWORD"
set_env VALKEY_PASSWORD          "$VALKEY_PASSWORD"

set_env N8N_ENCRYPTION_KEY     "$N8N_ENCRYPTION_KEY"
set_env N8N_RUNNERS_AUTH_TOKEN "$N8N_RUNNERS_AUTH_TOKEN"
set_env N8N_OWNER_EMAIL        "$N8N_OWNER_EMAIL"
set_env N8N_OWNER_PASSWORD     "$N8N_OWNER_PASSWORD"

set_env EVA_AGENT_API_KEY      "$EVA_AGENT_API_KEY"
set_env LETTA_APP_SERVER_TOKEN "$LETTA_APP_SERVER_TOKEN"
set_env LETTA_UI_USER         "$LETTA_UI_USER"
set_env LETTA_UI_PASSWORD     "$LETTA_UI_PASSWORD"

set_env NC_ADMIN_EMAIL     "$NC_ADMIN_EMAIL"
set_env NC_ADMIN_PASSWORD  "$NC_ADMIN_PASSWORD"
set_env NC_AUTH_JWT_SECRET "$NC_AUTH_JWT_SECRET"

set_env SEARXNG_SECRET     "$SEARXNG_SECRET"
set_env CRAWL4AI_API_TOKEN "$CRAWL4AI_API_TOKEN"
set_env COMPOSE_PROFILES   "$PROFILES"

set_env TZ              "$TZ_VALUE"
set_env GENERIC_TIMEZONE "$TZ_VALUE"
set_env EVASELF_INSTALL_DIR "$ROOT_DIR"
set_env EVASELF_INSTALLED_AT "$(date -Iseconds)"

chmod 600 "$ENV_FILE"
ok ".env written with mode 600"

# ---------------------------------------------------------------------
# bcrypt hash for the Letta console's basic auth
# ---------------------------------------------------------------------
# On a truly clean host the Caddy image is not pulled yet, so this can
# fail here; install.sh runs it again after the pull.
"$SCRIPT_DIR/hash-letta-password.sh" --force 2>/dev/null \
	|| warn "the Letta console password will be hashed after the images are pulled"

step "Configuration complete"
say "  Review it with: less .env"
