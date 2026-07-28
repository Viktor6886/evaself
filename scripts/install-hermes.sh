#!/usr/bin/env bash
# =====================================================================
# Install the Hermes Agent directly into Ubuntu — NOT into Docker.
#
# Hermes is the operator's agent for this server. It is deliberately
# unsandboxed and runs as root: it manages Docker, systemd, packages,
# backups, updates and the project files. That is the whole point of it,
# and it is why access is restricted to a single Telegram ID.
#
# This script:
#   1. installs Hermes with the official installer;
#   2. writes the Hermes bot token and the owner's Telegram allowlist
#      that `make install` already collected;
#   3. installs a systemd unit that is NOT started, because Hermes has no
#      LLM yet — the service stays "awaiting-configuration" until the
#      owner runs `make configure-hermes`.
#
# The LLM is deliberately NOT configured here, as specified.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_root
load_env

HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
HERMES_BIN=""
STATE_FILE="$HERMES_HOME/evaself-state"

step "Installing Hermes Agent"

[ -n "${HERMES_TELEGRAM_BOT_TOKEN:-}" ] || die "HERMES_TELEGRAM_BOT_TOKEN is missing from .env"
[ -n "${OWNER_TELEGRAM_ID:-}" ] || die "OWNER_TELEGRAM_ID is missing from .env"

# ---------------------------------------------------------------------
# 1. the binary
# ---------------------------------------------------------------------
find_hermes() {
	command -v hermes 2>/dev/null && return 0
	for candidate in /root/.local/bin/hermes /usr/local/bin/hermes "$HERMES_HOME/bin/hermes"; do
		[ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
	done
	return 1
}

if HERMES_BIN="$(find_hermes)"; then
	ok "Hermes already installed at $HERMES_BIN"
else
	info "running the official installer: ${HERMES_INSTALL_URL}"
	if curl -fsSL --max-time 120 "$HERMES_INSTALL_URL" -o /tmp/hermes-install.sh 2>/dev/null; then
		# The installer needs a login-shell environment for its PATH edits.
		if bash /tmp/hermes-install.sh </dev/null; then
			ok "installer finished"
		else
			warn "the installer exited with an error"
		fi
		rm -f /tmp/hermes-install.sh
		# shellcheck disable=SC1091
		[ -f /root/.bashrc ] && . /root/.bashrc 2>/dev/null || true
		HERMES_BIN="$(find_hermes || true)"
	else
		warn "could not download the Hermes installer from ${HERMES_INSTALL_URL}"
		warn "(no outbound access, or the host is blocked by a network policy)"
	fi
fi

# ---------------------------------------------------------------------
# 2. configuration — written whether or not the binary is present yet,
#    so a later manual install picks it up unchanged
# ---------------------------------------------------------------------
step "Writing the Hermes configuration"
mkdir -p "$HERMES_HOME"
chmod 700 "$HERMES_HOME"

# Credentials live in $HERMES_HOME/.env, which Hermes loads even when
# config.yaml is bypassed.
CRED_FILE="$HERMES_HOME/.env"
touch "$CRED_FILE"
chmod 600 "$CRED_FILE"
set_env TELEGRAM_BOT_TOKEN        "$HERMES_TELEGRAM_BOT_TOKEN" "$CRED_FILE"
set_env TELEGRAM_ALLOWED_USER_IDS "$OWNER_TELEGRAM_ID"         "$CRED_FILE"
set_env HERMES_ALLOW_PRIVATE_URLS "1"                          "$CRED_FILE"
ok "bot token and allowlist written to $CRED_FILE (mode 600)"

# config.yaml carries the same allowlist declaratively.
CONFIG_FILE="$HERMES_HOME/config.yaml"
if [ ! -f "$CONFIG_FILE" ]; then
	cat > "$CONFIG_FILE" <<-YAML
		# Hermes Agent — Evaself server operator
		#
		# Written by scripts/install-hermes.sh. Access is restricted to a
		# single Telegram ID: this agent has root on the server.

		gateway:
		  telegram:
		    enabled: true
		    allowed_user_ids:
		      - ${OWNER_TELEGRAM_ID}

		security:
		  redact_secrets: true

		privacy:
		  redact_pii: false
	YAML
	chmod 600 "$CONFIG_FILE"
	ok "config.yaml created with the owner allowlist"
else
	info "config.yaml already exists — left untouched"
fi

# Belt and braces: if the CLI is present, set the same values through it,
# so whichever mechanism this Hermes version prefers is populated.
if [ -n "${HERMES_BIN:-}" ]; then
	HERMES_HOME="$HERMES_HOME" "$HERMES_BIN" config set gateway.telegram.allowed_user_ids "$OWNER_TELEGRAM_ID" >/dev/null 2>&1 \
		&& ok "allowlist confirmed through the Hermes CLI" \
		|| info "the CLI did not accept 'config set' non-interactively; the files above are authoritative"
fi

# ---------------------------------------------------------------------
# 3. systemd unit — installed, enabled for later, NOT started
# ---------------------------------------------------------------------
step "Installing the systemd unit"
install -m 0644 "$ROOT_DIR/systemd/evaself-hermes.service" /etc/systemd/system/
mkdir -p /etc/systemd/system/evaself-hermes.service.d
cat > /etc/systemd/system/evaself-hermes.service.d/override.conf <<-CONF
	[Service]
	Environment=HERMES_HOME=${HERMES_HOME}
	Environment=EVASELF_DIR=${ROOT_DIR}
	WorkingDirectory=${ROOT_DIR}
CONF
systemctl daemon-reload
ok "evaself-hermes.service installed"

printf 'state=awaiting-configuration\nreason=llm-not-configured\nwritten_at=%s\n' "$(date -Iseconds)" > "$STATE_FILE"
chmod 600 "$STATE_FILE"

step "Hermes is installed but NOT running"
say "  State: awaiting-configuration — it has no LLM yet, as intended."
say ""
say "  When you are ready:"
say "    make configure-hermes    choose the model provider, then autostart"
say ""
say "  Telegram access is limited to ID ${OWNER_TELEGRAM_ID}. Nobody else can"
say "  talk to this bot, which matters: Hermes runs as root without a sandbox."

if [ -z "${HERMES_BIN:-}" ]; then
	echo
	warn "the Hermes binary is not installed yet"
	say "    Install it later with:"
	say "      curl -fsSL ${HERMES_INSTALL_URL} | bash"
	say "    then run: make configure-hermes"
	say "    Your token and allowlist are already in ${CRED_FILE}."
fi
