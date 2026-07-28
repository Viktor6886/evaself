#!/usr/bin/env bash
# Guard used by Makefile targets that need a configured installation.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
require_env_file
[ -n "$(get_env DOMAIN || true)" ] || die ".env has no DOMAIN — run 'make configure'"
