#!/usr/bin/env bash
# Совместимость со старой командой. Новая точка входа — configure-llm.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
printf 'Команда переименована: используйте make configure-llm.\n' >&2
exec "$SCRIPT_DIR/configure-llm.sh" "$@"
