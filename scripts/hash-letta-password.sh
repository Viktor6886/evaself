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

[ -n "$PASSWORD" ] || die "LETTA_UI_PASSWORD не задан в .env"

if [ -n "$EXISTING" ] && [ "$FORCE" != "--force" ]; then
	ok "пароль консоли Letta уже хеширован"
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
	fail "не удалось создать bcrypt-хеш"
	say "  Caddy не установлен на хосте и его образ пока недоступен."
	say "  До исправления вход на https://$(get_env DOMAIN_LETTA)"
	say "  работать не будет. После загрузки образов повторите:"
	say "    scripts/hash-letta-password.sh"
	exit 1
fi

# Single quotes make Compose treat every "$" in bcrypt literally.
set_env LETTA_UI_PASSWORD_HASH "'$HASH'"
chmod 600 "$ENV_FILE"
ok "пароль консоли Letta хеширован (bcrypt)"
