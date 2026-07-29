#!/usr/bin/env bash
# Create the admin Secret Store master key outside Docker volumes/backups.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env
key_file="${EVA_SECRETS_MASTER_KEY_FILE:-$ROOT_DIR/secrets/eva-secrets-master-key}"
if [[ "$key_file" != /* ]]; then
	key_file="$ROOT_DIR/${key_file#./}"
fi

install -d -m 0700 "$(dirname "$key_file")"
if [ ! -s "$key_file" ]; then
	umask 077
	openssl rand -base64 32 > "$key_file"
	ok "создан мастер-ключ Secret Store"
fi
chmod 600 "$key_file"
set_env EVA_SECRETS_MASTER_KEY_FILE "$key_file"
