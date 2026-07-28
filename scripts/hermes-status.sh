#!/usr/bin/env bash
# Hermes state, configuration summary and access allowlist.
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env
HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
CRED_FILE="$HERMES_HOME/.env"

step "Hermes Agent"

BIN="$(command -v hermes 2>/dev/null || true)"
[ -n "$BIN" ] || for c in /root/.local/bin/hermes /usr/local/bin/hermes "$HERMES_HOME/bin/hermes"; do
	[ -x "$c" ] && BIN="$c" && break
done

if [ -n "$BIN" ]; then
	ok "binary: $BIN"
	VERSION="$("$BIN" --version 2>/dev/null | head -1 || true)"
	[ -n "$VERSION" ] && info "version: $VERSION"
else
	fail "binary not found — run scripts/install-hermes.sh"
fi

info "home: $HERMES_HOME"
[ -f "$HERMES_HOME/config.yaml" ] && ok "config.yaml present ($(stat -c '%a' "$HERMES_HOME/config.yaml"))" || warn "config.yaml missing"

if [ -f "$HERMES_HOME/evaself-state" ]; then
	STATE="$(sed -n 's/^state=//p' "$HERMES_HOME/evaself-state")"
	case "$STATE" in
		configured) ok "state: configured" ;;
		awaiting-configuration) warn "state: awaiting-configuration — run 'make configure-hermes'" ;;
		*) info "state: ${STATE:-unknown}" ;;
	esac
fi

# ---------------------------------------------------------------------
step "Access control"
# ---------------------------------------------------------------------
if [ -f "$CRED_FILE" ]; then
	PERM="$(stat -c '%a' "$CRED_FILE")"
	[ "$PERM" = "600" ] && ok "credentials file mode 600" || fail "credentials file mode is $PERM"

	ALLOWED="$(sed -n 's/^TELEGRAM_ALLOWED_USER_IDS=//p' "$CRED_FILE")"
	if [ -n "$ALLOWED" ]; then
		ok "Telegram allowlist: $ALLOWED"
		[ "$ALLOWED" = "${OWNER_TELEGRAM_ID:-}" ] || warn "the allowlist differs from OWNER_TELEGRAM_ID (${OWNER_TELEGRAM_ID:-unset})"
	else
		fail "no Telegram allowlist set — anyone who finds the bot could reach a root agent"
	fi

	if grep -q '^TELEGRAM_BOT_TOKEN=.\+' "$CRED_FILE"; then
		TOKEN="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$CRED_FILE")"
		ok "bot token present (${TOKEN%%:*}:••••••)"
	else
		fail "no Hermes bot token stored"
	fi
else
	fail "$CRED_FILE does not exist"
fi

# also check the declarative allowlist
if [ -f "$HERMES_HOME/config.yaml" ] && grep -q 'allowed_user_ids' "$HERMES_HOME/config.yaml"; then
	ok "config.yaml carries an allowed_user_ids list"
fi

# ---------------------------------------------------------------------
step "Service"
# ---------------------------------------------------------------------
if systemctl list-unit-files 2>/dev/null | grep -q '^evaself-hermes.service'; then
	printf '  active:  %s\n' "$(systemctl is-active evaself-hermes.service 2>/dev/null)"
	printf '  enabled: %s\n' "$(systemctl is-enabled evaself-hermes.service 2>/dev/null)"
	echo
	systemctl status evaself-hermes.service --no-pager --lines=8 2>/dev/null | sed 's/^/  /' || true
else
	warn "evaself-hermes.service is not installed"
fi

# ---------------------------------------------------------------------
step "Capabilities"
# ---------------------------------------------------------------------
say "  Hermes runs as root with no sandbox, by design. It can:"
say "    shell commands · docker · systemd · project files · logs"
say "    package installs · make backup / restore / update / rollback"
say "    server resource inspection"
say ""
say "  Recent commands:  journalctl -u evaself-hermes -n 100 --no-pager"
