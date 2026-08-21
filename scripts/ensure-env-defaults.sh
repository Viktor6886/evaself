#!/usr/bin/env bash
# =====================================================================
# Add settings that appeared in .env.example since this installation was
# configured.
#
# An update that introduces a new variable used to require the operator to
# notice it and edit .env by hand — otherwise the setting silently stayed
# empty. `make update` runs this so a plain upgrade needs no manual step.
#
# Rules, in order:
#   * a key already present in .env is NEVER touched, even when empty —
#     an empty value there is a deliberate choice (an unused integration);
#   * a key listed in GENERATED_SECRETS gets a fresh random value;
#   * anything else is copied from .env.example verbatim, quoting included.
#
# Nothing is ever removed: a key dropped from .env.example stays in .env.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_env_file
EXAMPLE_FILE="${EXAMPLE_FILE:-$ROOT_DIR/.env.example}"
[ -f "$EXAMPLE_FILE" ] || die ".env.example не найден рядом с установкой"

# Secrets are generated rather than copied: the example ships them empty.
# Keep this list in sync with keep_or_generate in configure.sh.
GENERATED_SECRETS="
CRAWL4AI_API_TOKEN
EVA_AGENT_API_KEY
EVA_ROUTER_API_KEY
EVA_DB_PASSWORD
EVA_DB_READONLY_PASSWORD
EVA_TELEGRAM_WEBHOOK_SECRET
LAVA_WEBHOOK_PASSWORD
LETTA_APP_SERVER_TOKEN
LLM_CONFIG_ENCRYPTION_KEY
MEDIA_SERVICE_TOKEN
NC_AUTH_JWT_SECRET
NOCODB_DB_PASSWORD
POSTGRES_SUPER_PASSWORD
SEARXNG_SECRET
VALKEY_PASSWORD
"

# Deliberately NOT auto-generated even though configure.sh generates them:
# rotating a database password or an admin password on an existing
# installation would lock the stack out of its own data.
NEVER_GENERATE="
EVA_DB_PASSWORD
EVA_DB_READONLY_PASSWORD
LETTA_DB_PASSWORD
LETTA_UI_PASSWORD
NC_ADMIN_PASSWORD
NOCODB_DB_PASSWORD
POSTGRES_SUPER_PASSWORD
VALKEY_PASSWORD
"

contains() {
	# contains <newline-separated list> <needle>
	grep -qxF -- "$2" <<<"$1"
}

has_key() {
	grep -qE "^${1}=" "$ENV_FILE"
}

added=()
skipped_secret=()

while IFS= read -r line || [ -n "$line" ]; do
	line="${line%$'\r'}"
	[[ "$line" =~ ^[[:space:]]*# ]] && continue
	[[ "$line" == *=* ]] || continue
	key="${line%%=*}"
	[[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
	has_key "$key" && continue

	value="${line#*=}"
	if contains "$GENERATED_SECRETS" "$key"; then
		if contains "$NEVER_GENERATE" "$key"; then
			# Present in the example but missing here: an operator has to
			# decide, because inventing one would break a running service.
			skipped_secret+=("$key")
			continue
		fi
		value="$(gen_secret)"
	fi
	set_env "$key" "$value"
	added+=("$key")
done < "$EXAMPLE_FILE"

# ---------------------------------------------------------------------
# Исправление прежних умолчаний.
#
# Обычное правило — «уже заданный ключ не трогаем»: пустое значение там
# может быть осознанным выбором. Но значение, которое установка получила
# из прежнего умолчания примера и никогда не выбирала сама, — это не
# выбор, а наследство.
#
# Устаревшие EVA_LETTA_ADMIN_* могут оставаться в существующем .env, но
# runtime их больше не читает и не передаёт контейнеру.
# ---------------------------------------------------------------------
corrected=()

chmod 600 "$ENV_FILE"

if [ "${#added[@]}" -eq 0 ]; then
	ok ".env содержит все известные настройки"
else
	ok "добавлено новых настроек в .env: ${#added[@]}"
	for key in "${added[@]}"; do info "  $key"; done
fi

if [ "${#corrected[@]}" -gt 0 ]; then
	ok "исправлено прежних умолчаний: ${#corrected[@]}"
	for key in "${corrected[@]}"; do info "  $key"; done
fi

if [ "${#skipped_secret[@]}" -gt 0 ]; then
	warn "эти пароли отсутствуют и НЕ создаются автоматически:"
	for key in "${skipped_secret[@]}"; do warn "  $key"; done
	warn "задайте их вручную — генерация сломала бы доступ к существующим данным"
fi
