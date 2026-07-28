#!/usr/bin/env bash
# =====================================================================
# Give Hermes an LLM and turn on autostart.
#
# Deliberately separate from `make install`: the installer leaves Hermes
# in "awaiting-configuration" so nothing with root access on the server
# starts talking to a model before the owner has decided which one.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_root
load_env

HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
CRED_FILE="$HERMES_HOME/.env"
STATE_FILE="$HERMES_HOME/evaself-state"

HERMES_BIN="$(command -v hermes 2>/dev/null || true)"
[ -n "$HERMES_BIN" ] || for c in /root/.local/bin/hermes /usr/local/bin/hermes "$HERMES_HOME/bin/hermes"; do
	[ -x "$c" ] && HERMES_BIN="$c" && break
done
[ -n "$HERMES_BIN" ] || die "the Hermes binary is not installed — run scripts/install-hermes.sh first"

step "Configuring Hermes"
info "binary: $HERMES_BIN"
info "home:   $HERMES_HOME"

say ""
say "  Choose how Hermes reaches a model:"
say "    1) Nous Portal            (hermes setup --portal)"
say "    2) OpenRouter / OpenAI /  (hermes model — interactive picker)"
say "       any custom endpoint"
say "    3) Reuse Eva's endpoint   (${EVA_LLM_BASE_URL:-not set})"
say "    4) Skip — I will configure it by hand"
say ""
ask CHOICE "Option" "2"

case "$CHOICE" in
	1)
		step "Nous Portal"
		HERMES_HOME="$HERMES_HOME" "$HERMES_BIN" setup --portal || warn "setup exited non-zero"
		;;
	2)
		step "Interactive model picker"
		HERMES_HOME="$HERMES_HOME" "$HERMES_BIN" model || warn "model selection exited non-zero"
		;;
	3)
		[ -n "${EVA_LLM_BASE_URL:-}" ] || die "EVA_LLM_BASE_URL is empty in .env"
		step "Reusing Eva's endpoint"
		ask HERMES_MODEL "Model to use with that endpoint" "${EVA_LLM_MODEL:-}"
		set_env OPENAI_BASE_URL "$EVA_LLM_BASE_URL" "$CRED_FILE"
		set_env OPENAI_API_KEY  "$EVA_LLM_API_KEY"  "$CRED_FILE"
		set_env HERMES_MODEL    "$HERMES_MODEL"     "$CRED_FILE"
		chmod 600 "$CRED_FILE"
		ok "endpoint written to $CRED_FILE"
		warn "Hermes and Eva now share an API key — revoke it in one place and both stop"
		;;
	4)
		info "skipped; edit $HERMES_HOME/config.yaml or run 'hermes model' yourself"
		;;
	*)
		die "unknown option: $CHOICE"
		;;
esac

# ---------------------------------------------------------------------
step "Telegram gateway"
# ---------------------------------------------------------------------
info "bot token and the allowlist for ID ${OWNER_TELEGRAM_ID} are already in $CRED_FILE"
if confirm "Run the official 'hermes gateway setup' to finish the gateway?" y; then
	HERMES_HOME="$HERMES_HOME" "$HERMES_BIN" gateway setup || warn "gateway setup exited non-zero"
fi

# ---------------------------------------------------------------------
step "Autostart"
# ---------------------------------------------------------------------
say "  Hermes has root on this server and no sandbox. Enabling autostart"
say "  means it comes back automatically after a reboot."
if confirm "Enable autostart and start Hermes now?" y; then
	systemctl enable --now evaself-hermes.service
	sleep 3
	if systemctl is-active --quiet evaself-hermes.service; then
		printf 'state=configured\nstarted_at=%s\n' "$(date -Iseconds)" > "$STATE_FILE"
		chmod 600 "$STATE_FILE"
		ok "Hermes is running and enabled at boot"
		say ""
		say "  Send a message to your Hermes bot from Telegram ID ${OWNER_TELEGRAM_ID}."
		say "  Anyone else is ignored."
	else
		fail "the service did not start"
		say "  journalctl -u evaself-hermes -n 50 --no-pager"
		exit 1
	fi
else
	printf 'state=configured-not-started\nwritten_at=%s\n' "$(date -Iseconds)" > "$STATE_FILE"
	info "start it later with: make start-hermes"
fi
