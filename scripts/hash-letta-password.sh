#!/usr/bin/env bash
# =====================================================================
# Store a bcrypt hash of LETTA_UI_PASSWORD in .env.
#
# Caddy's basic_auth needs the hash, never the plaintext. `caddy
# hash-password` produces it, so this runs either the host binary (if
# Caddy happens to be installed) or the pinned Caddy image.
#
# Called twice during an installation: once by configure.sh, and again by
# install.sh after the images are pulled — because on a truly clean host
# the image does not exist yet the first time.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_env_file
# shellcheck disable=SC1090
. "$VERSIONS_FILE"

PASSWORD="$(get_env LETTA_UI_PASSWORD)"
EXISTING="$(get_env LETTA_UI_PASSWORD_HASH || true)"
FORCE="${1:-}"

[ -n "$PASSWORD" ] || die "LETTA_UI_PASSWORD is empty in .env"

if [ -n "$EXISTING" ] && [ "$FORCE" != "--force" ]; then
	ok "the Letta console password is already hashed"
	exit 0
fi

HASH=""
if command -v caddy >/dev/null 2>&1; then
	HASH="$(caddy hash-password --plaintext "$PASSWORD" 2>/dev/null || true)"
fi

if [ -z "$HASH" ] && command -v docker >/dev/null 2>&1; then
	HASH="$(docker run --rm "${CADDY_IMAGE}:${CADDY_VERSION}" \
		caddy hash-password --plaintext "$PASSWORD" 2>/dev/null || true)"
fi

if [ -z "$HASH" ]; then
	fail "could not produce a bcrypt hash"
	say "  Caddy is neither installed on the host nor available as an image."
	say "  Until this is fixed, https://$(get_env DOMAIN_LETTA) will refuse"
	say "  every login. Re-run after the images are pulled:"
	say "    scripts/hash-letta-password.sh"
	exit 1
fi

set_env LETTA_UI_PASSWORD_HASH "$HASH"
chmod 600 "$ENV_FILE"
ok "Letta console password hashed (bcrypt)"
