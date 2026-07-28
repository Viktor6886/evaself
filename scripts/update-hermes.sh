#!/usr/bin/env bash
# =====================================================================
# Update the Hermes binary in place.
#
# The configuration in $HERMES_HOME is never touched — the official
# installer is idempotent and upgrades an existing installation.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_root
load_env

HERMES_HOME="${HERMES_HOME:-/root/.hermes}"

step "Updating Hermes"

WAS_ACTIVE=0
if systemctl is-active --quiet evaself-hermes.service 2>/dev/null; then
	WAS_ACTIVE=1
	systemctl stop evaself-hermes.service
	ok "service stopped"
fi

# Back up the configuration before running someone else's installer.
STAMP="$(date +%Y%m%d%H%M%S)"
if [ -d "$HERMES_HOME" ]; then
	tar czf "/var/backups/evaself/hermes-config-${STAMP}.tar.gz" \
		-C "$(dirname "$HERMES_HOME")" "$(basename "$HERMES_HOME")" 2>/dev/null \
		&& ok "configuration saved to /var/backups/evaself/hermes-config-${STAMP}.tar.gz" \
		|| warn "could not back up the configuration"
fi

step "Running the official installer"
if curl -fsSL --max-time 120 "$HERMES_INSTALL_URL" -o /tmp/hermes-install.sh 2>/dev/null; then
	bash /tmp/hermes-install.sh </dev/null && ok "installer finished" || warn "installer exited non-zero"
	rm -f /tmp/hermes-install.sh
else
	die "could not download ${HERMES_INSTALL_URL}"
fi

BIN="$(command -v hermes 2>/dev/null || echo /root/.local/bin/hermes)"
[ -x "$BIN" ] && info "version now: $("$BIN" --version 2>/dev/null | head -1)"

if [ "$WAS_ACTIVE" -eq 1 ]; then
	systemctl start evaself-hermes.service
	sleep 3
	systemctl is-active --quiet evaself-hermes.service \
		&& ok "service restarted" \
		|| die "the service did not come back — journalctl -u evaself-hermes -n 50"
else
	info "the service was not running; start it with 'make start-hermes'"
fi

"$SCRIPT_DIR/hermes-status.sh"
