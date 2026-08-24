#!/usr/bin/env bash
# =====================================================================
# Interactive configuration.
#
# Asks for everything that cannot be guessed, generates every secret, and
# writes .env with mode 600. Re-runnable: existing values become the
# defaults, so `make configure` can change one domain without touching
# passwords.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

TEMPLATE="$ROOT_DIR/.env.example"
[ -f "$TEMPLATE" ] || die ".env.example отсутствует"
ADVANCED=0
[ "${1:-}" = "--advanced" ] && ADVANCED=1
INCOMPLETE=()

mark_incomplete() {
	INCOMPLETE+=("$1")
}

# ---------------------------------------------------------------------
# start from the template, or from the current .env when reconfiguring
# ---------------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
	step "Найден существующий .env — текущие значения предложены по умолчанию"
	cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
	info "предыдущий файл сохранён как $(basename "$ENV_FILE").bak.*"
else
	cp "$TEMPLATE" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

current() { get_env "$1" || true; }

# =====================================================================
# 1. domains
# =====================================================================
step "Домены"
say "  Достаточно одного корневого домена: поддомены сервисов создаются автоматически."
say "  Enter без значения включает локальный режим; домен можно указать позже."
echo

DOMAIN_DEFAULT="$(current DOMAIN)"
while :; do
	ask_optional DOMAIN_INPUT "Основной домен (например evaself.online; Enter = пока пропустить)" "$DOMAIN_DEFAULT"
	if [ -z "$DOMAIN_INPUT" ]; then
		DOMAIN="evaself.localhost"
		mark_incomplete "основной домен"
		break
	fi
	DOMAIN="${DOMAIN_INPUT#http://}"
	DOMAIN="${DOMAIN#https://}"
	DOMAIN="${DOMAIN%%/*}"
	is_domain "$DOMAIN" && break
	warn "значение не похоже на доменное имя"
done

DOMAIN_APP="app.${DOMAIN}"
DOMAIN_API="api.${DOMAIN}"
DOMAIN_LETTA="letta.${DOMAIN}"
DOMAIN_STATUS="status.${DOMAIN}"

if [ "$ADVANCED" -eq 1 ]; then
	say "  Расширенный режим: Enter оставляет автоматически рассчитанное значение."
	ask_optional DOMAIN_APP    "Домен WebApp"   "$DOMAIN_APP"
	ask_optional DOMAIN_API    "Домен API"      "$DOMAIN_API"
	ask_optional DOMAIN_LETTA  "Домен Letta UI" "$DOMAIN_LETTA"
	ask_optional DOMAIN_STATUS "Домен статуса"  "$DOMAIN_STATUS"
fi

while :; do
	ask_optional ACME_EMAIL "E-mail для Let's Encrypt (Enter = указать позже)" "$(current ACME_EMAIL || true)"
	[ -z "$ACME_EMAIL" ] && {
		ACME_EMAIL="admin@${DOMAIN}"
		mark_incomplete "e-mail Let's Encrypt"
		break
	}
	is_email "$ACME_EMAIL" && break
	warn "e-mail содержит недопустимые символы или неполный домен"
done

echo
ACME_STAGING="$(current ACME_STAGING || echo 0)"
if [ "$ADVANCED" -eq 1 ]; then
	say ""
	say "  Staging CA Let's Encrypt выдаёт недоверенные сертификаты, но не"
	say "  расходует строгий rate limit — удобно, пока проверяются DNS и порты."
	if confirm "Использовать staging CA Let's Encrypt?" n; then ACME_STAGING=1; else ACME_STAGING=0; fi
fi
if [ "$ACME_STAGING" = "1" ]; then
	ACME_CA="https://acme-staging-v02.api.letsencrypt.org/directory"
	warn "включён staging CA: браузеры будут считать сертификаты недоверенными"
else
	ACME_CA="https://acme-v02.api.letsencrypt.org/directory"
fi

info "HTTPS будет выпущен для:"
for host in "$DOMAIN" "$DOMAIN_APP" "$DOMAIN_API" "$DOMAIN_LETTA" "$DOMAIN_STATUS"; do
	info "  https://$host"
done
info "Все домены уже должны указывать на IP этого сервера."

# =====================================================================
# 2. Telegram
# =====================================================================
step "Telegram"
say "  Создайте Telegram bot Евы через @BotFather."
say "  Оба значения можно пропустить и заполнить через make configure."
echo

while :; do
	ask_secret_optional EVA_TELEGRAM_BOT_TOKEN "Token bot Евы" "$(current EVA_TELEGRAM_BOT_TOKEN || true)"
	if [ -z "$EVA_TELEGRAM_BOT_TOKEN" ]; then
		mark_incomplete "Telegram Bot Token"
		break
	fi
	is_telegram_token "$EVA_TELEGRAM_BOT_TOKEN" && break
	warn "token выглядит как 123456789:AAE...; повторите ввод или нажмите Enter, чтобы пропустить"
done

say "  Числовой Telegram ID можно узнать у @userinfobot."
while :; do
	ask_optional OWNER_TELEGRAM_ID "Telegram ID владельца (Enter = пока пропустить)" "$(current OWNER_TELEGRAM_ID || true)"
	if [ -z "$OWNER_TELEGRAM_ID" ]; then
		mark_incomplete "Telegram ID владельца"
		break
	fi
	is_number "$OWNER_TELEGRAM_ID" && break
	warn "Telegram ID должен быть числом"
done

# =====================================================================
# 3. LLM для Евы
# =====================================================================
step "LLM для Евы"
say "  Укажите первую OpenAI-compatible конфигурацию. После установки"
say "  её можно менять без переустановки через WebUI или make configure-llm."
say "  Base URL, API Key и модель можно оставить пустыми: стек запустится в режиме настройки."
echo
CURRENT_PROVIDER_NAME="$(current EVA_LLM_PROVIDER_NAME || true)"
CURRENT_PROVIDER_NAME="${CURRENT_PROVIDER_NAME#\'}"; CURRENT_PROVIDER_NAME="${CURRENT_PROVIDER_NAME%\'}"
ask_optional EVA_LLM_PROVIDER_NAME "Название конфигурации" "${CURRENT_PROVIDER_NAME:-Основной провайдер}"
EVA_LLM_PROVIDER_NAME="${EVA_LLM_PROVIDER_NAME:-Основной провайдер}"
EVA_LLM_PROTOCOL="openai-compatible"
ask_optional EVA_LLM_BASE_URL "Base URL (обычно …/v1; Enter = пока пропустить)" "$(current EVA_LLM_BASE_URL || true)"
EXISTING_LLM_KEY="$(current EVA_LLM_API_KEY || true)"
ask_secret_optional EVA_LLM_API_KEY "API Key" "$EXISTING_LLM_KEY"
ask_optional EVA_LLM_MODEL "Название модели (Enter = пока пропустить)" "$(current EVA_LLM_MODEL || true)"
if [ -z "$EVA_LLM_BASE_URL" ] || [ -z "$EVA_LLM_API_KEY" ] || [ -z "$EVA_LLM_MODEL" ]; then
	mark_incomplete "LLM-провайдер"
fi
while :; do
	ask_optional EVA_LLM_CONTEXT_WINDOW "Context window" "$(current EVA_LLM_CONTEXT_WINDOW || echo 32768)"
	EVA_LLM_CONTEXT_WINDOW="${EVA_LLM_CONTEXT_WINDOW:-32768}"
	is_number "$EVA_LLM_CONTEXT_WINDOW" && [ "$EVA_LLM_CONTEXT_WINDOW" -ge 1024 ] && break
	warn "context window должен быть целым числом не меньше 1024"
done
CURRENT_LLM_PARAMS="$(current EVA_LLM_ADDITIONAL_PARAMETERS || true)"
CURRENT_LLM_PARAMS="${CURRENT_LLM_PARAMS#\'}"; CURRENT_LLM_PARAMS="${CURRENT_LLM_PARAMS%\'}"
DEFAULT_LLM_PARAMS='{"request_timeout_ms":180000}'
EVA_LLM_ADDITIONAL_PARAMETERS="${CURRENT_LLM_PARAMS:-$DEFAULT_LLM_PARAMS}"
if [ "$ADVANCED" -eq 1 ]; then
	ask_optional EVA_LLM_ADDITIONAL_PARAMETERS \
		"Дополнительные параметры JSON" \
		"$EVA_LLM_ADDITIONAL_PARAMETERS"
fi
python3 - "$EVA_LLM_ADDITIONAL_PARAMETERS" <<'PY' || die "дополнительные параметры должны быть JSON-объектом"
import json, sys
value = json.loads(sys.argv[1])
assert isinstance(value, dict)
PY

say ""
say "  Embeddings используются архивной памятью и recall search Letta."
ask_optional EVA_EMBEDDING_BASE_URL "Base URL embeddings (пусто = как у LLM)" "$(current EVA_EMBEDDING_BASE_URL || true)"
ask_optional EVA_EMBEDDING_MODEL "Модель embeddings" "$(current EVA_EMBEDDING_MODEL || echo 'text-embedding-3-small')"
EVA_EMBEDDING_MODEL="${EVA_EMBEDDING_MODEL:-text-embedding-3-small}"
ask_optional EVA_EMBEDDING_DIM "Размерность embeddings" "$(current EVA_EMBEDDING_DIM || echo 1536)"
EVA_EMBEDDING_DIM="${EVA_EMBEDDING_DIM:-1536}"
EVA_EMBEDDING_API_KEY="$(current EVA_EMBEDDING_API_KEY || true)"
EVA_EMBEDDING_API_KEY="${EVA_EMBEDDING_API_KEY:-$EVA_LLM_API_KEY}"

# =====================================================================
# 4. optional services
# =====================================================================
step "Дополнительные сервисы"
PROFILES="$(current COMPOSE_PROFILES || true)"

# Crawl4AI больше не за профилем: он нужен инструментам Евы для чтения
# веб-страниц и ставится наравне с остальными сервисами. Оставшееся от
# прежних установок значение вычищаем, иначе compose ругается на профиль,
# которого больше нет ни у одного сервиса.
PROFILES="$(printf '%s' "$PROFILES" | sed 's/crawl4ai//; s/,,/,/g; s/^,//; s/,$//')"
info "Crawl4AI устанавливается всегда (до 1–1,5 ГБ RAM во время обработки)"

if confirm "Установить Uptime Kuma для страницы статуса?" n; then
	case ",$PROFILES," in *,monitoring,*) : ;; *) PROFILES="${PROFILES:+$PROFILES,}monitoring" ;; esac
	ok "страница статуса включена: https://$DOMAIN_STATUS"
else
	PROFILES="$(printf '%s' "$PROFILES" | sed 's/monitoring//; s/,,/,/g; s/^,//; s/,$//')"
fi

TZ_DEFAULT="$(current TZ || true)"
TZ_DEFAULT="${TZ_DEFAULT:-$(cat /etc/timezone 2>/dev/null || echo UTC)}"
choose_timezone TZ_VALUE "$TZ_DEFAULT"

# =====================================================================
# 5. generated secrets — only when missing, so re-running is safe
# =====================================================================
step "Секреты"

keep_or_generate() {
	local key="$1" generator="${2:-gen_secret}" existing
	existing="$(current "$key" || true)"
	if [ -n "$existing" ]; then
		printf '%s' "$existing"
	else
		"$generator"
	fi
}

POSTGRES_SUPER_PASSWORD="$(keep_or_generate POSTGRES_SUPER_PASSWORD)"
EVA_DB_PASSWORD="$(keep_or_generate EVA_DB_PASSWORD)"
LETTA_DB_PASSWORD="$(keep_or_generate LETTA_DB_PASSWORD)"
EVA_DB_READONLY_PASSWORD="$(keep_or_generate EVA_DB_READONLY_PASSWORD)"
VALKEY_PASSWORD="$(keep_or_generate VALKEY_PASSWORD)"
EVA_AGENT_API_KEY="$(keep_or_generate EVA_AGENT_API_KEY)"
# Ключ LLM Router: сеть agent общая, роутер без него не стартует.
EVA_ROUTER_API_KEY="$(keep_or_generate EVA_ROUTER_API_KEY)"
LETTA_APP_SERVER_TOKEN="$(keep_or_generate LETTA_APP_SERVER_TOKEN)"
SEARXNG_SECRET="$(keep_or_generate SEARXNG_SECRET)"
CRAWL4AI_API_TOKEN="$(keep_or_generate CRAWL4AI_API_TOKEN)"
EVA_TELEGRAM_WEBHOOK_SECRET="$(keep_or_generate EVA_TELEGRAM_WEBHOOK_SECRET)"
MEDIA_SERVICE_TOKEN="$(keep_or_generate MEDIA_SERVICE_TOKEN)"
# Ключ шифрования API key в таблице llm_providers также постоянный:
# его потеря сделает сохранённые ключи нечитаемыми.
LLM_CONFIG_ENCRYPTION_KEY="$(keep_or_generate LLM_CONFIG_ENCRYPTION_KEY)"

# Admin passwords are stored only in the protected .env file.
LETTA_UI_PASSWORD="$(keep_or_generate LETTA_UI_PASSWORD gen_password)"
LAVA_WEBHOOK_PASSWORD="$(keep_or_generate LAVA_WEBHOOK_PASSWORD)"

LAVA_WEBHOOK_USER="$(current LAVA_WEBHOOK_USER || true)"
LAVA_WEBHOOK_USER="${LAVA_WEBHOOK_USER:-eva}"
LETTA_UI_USER="$(current LETTA_UI_USER || true)"
LETTA_UI_USER="${LETTA_UI_USER:-admin}"
EVA_ADMIN_USERNAME="$(current EVA_ADMIN_USERNAME || true)"
EVA_ADMIN_USERNAME="${EVA_ADMIN_USERNAME:-$LETTA_UI_USER}"
EVA_ADMIN_BOOTSTRAP_PASSWORD="$(current EVA_ADMIN_BOOTSTRAP_PASSWORD || true)"
EVA_ADMIN_BOOTSTRAP_PASSWORD="${EVA_ADMIN_BOOTSTRAP_PASSWORD:-$LETTA_UI_PASSWORD}"

ok "секреты готовы; существующие значения сохранены"

# =====================================================================
# 6. write .env
# =====================================================================
step "Запись .env"

set_env DOMAIN         "$DOMAIN"
set_env DOMAIN_APP     "$DOMAIN_APP"
set_env DOMAIN_API     "$DOMAIN_API"
set_env DOMAIN_LETTA   "$DOMAIN_LETTA"
set_env DOMAIN_STATUS  "$DOMAIN_STATUS"
set_env ACME_EMAIL     "$ACME_EMAIL"
set_env ACME_STAGING   "$ACME_STAGING"
set_env ACME_CA        "$ACME_CA"

set_env EVA_TELEGRAM_BOT_TOKEN      "$EVA_TELEGRAM_BOT_TOKEN"
set_env OWNER_TELEGRAM_ID           "$OWNER_TELEGRAM_ID"
set_env EVA_TELEGRAM_WEBHOOK_SECRET "$EVA_TELEGRAM_WEBHOOK_SECRET"
STICKER_CATALOG="$(current EVA_TELEGRAM_STICKER_CATALOG_JSON || true)"
set_env EVA_TELEGRAM_STICKER_CATALOG_JSON "${STICKER_CATALOG:-{}}"

EVA_LLM_PROVIDER_NAME="${EVA_LLM_PROVIDER_NAME//\'/}"
set_env EVA_LLM_PROVIDER_NAME  "'$EVA_LLM_PROVIDER_NAME'"
set_env EVA_LLM_PROTOCOL       "$EVA_LLM_PROTOCOL"
set_env EVA_LLM_BASE_URL       "$EVA_LLM_BASE_URL"
set_env EVA_LLM_API_KEY        "$EVA_LLM_API_KEY"
set_env EVA_LLM_MODEL          "$EVA_LLM_MODEL"
set_env EVA_LLM_CONTEXT_WINDOW "$EVA_LLM_CONTEXT_WINDOW"
set_env EVA_LLM_ADDITIONAL_PARAMETERS "'$EVA_LLM_ADDITIONAL_PARAMETERS'"
set_env LLM_CONFIG_ENCRYPTION_KEY "$LLM_CONFIG_ENCRYPTION_KEY"
set_env EVA_EMBEDDING_BASE_URL "$EVA_EMBEDDING_BASE_URL"
set_env EVA_EMBEDDING_API_KEY  "$EVA_EMBEDDING_API_KEY"
set_env EVA_EMBEDDING_MODEL    "$EVA_EMBEDDING_MODEL"
set_env EVA_EMBEDDING_DIM      "$EVA_EMBEDDING_DIM"

set_env POSTGRES_SUPER_PASSWORD  "$POSTGRES_SUPER_PASSWORD"
set_env EVA_DB_PASSWORD          "$EVA_DB_PASSWORD"
set_env LETTA_DB_PASSWORD        "$LETTA_DB_PASSWORD"
set_env EVA_DB_READONLY_PASSWORD "$EVA_DB_READONLY_PASSWORD"
set_env VALKEY_PASSWORD          "$VALKEY_PASSWORD"

set_env EVA_AGENT_API_KEY      "$EVA_AGENT_API_KEY"
set_env EVA_ROUTER_API_KEY     "$EVA_ROUTER_API_KEY"
set_env LETTA_APP_SERVER_TOKEN "$LETTA_APP_SERVER_TOKEN"
set_env LETTA_UI_USER         "$LETTA_UI_USER"
set_env LETTA_UI_PASSWORD     "$LETTA_UI_PASSWORD"
set_env EVA_ADMIN_USERNAME    "$EVA_ADMIN_USERNAME"
set_env EVA_ADMIN_BOOTSTRAP_PASSWORD "$EVA_ADMIN_BOOTSTRAP_PASSWORD"
set_env EVA_ADMIN_BIND        "0.0.0.0"
set_env EVA_ENV               "production"
set_env EVA_HEALTH_INTERVAL_SECONDS "60"
set_env EVA_HEALTH_TIMEOUT_MS "10000"


set_env SEARXNG_SECRET      "$SEARXNG_SECRET"
set_env MEDIA_SERVICE_TOKEN "$MEDIA_SERVICE_TOKEN"
set_env CRAWL4AI_API_TOKEN "$CRAWL4AI_API_TOKEN"
set_env COMPOSE_PROFILES   "$PROFILES"
set_env LAVA_WEBHOOK_USER     "$LAVA_WEBHOOK_USER"
set_env LAVA_WEBHOOK_PASSWORD "$LAVA_WEBHOOK_PASSWORD"

set_env TZ              "$TZ_VALUE"
set_env EVASELF_INSTALL_DIR "$ROOT_DIR"
set_env EVASELF_INSTALLED_AT "$(date -Iseconds)"

# Recalculate instead of carrying stale markers from an earlier run.
INCOMPLETE=()
[[ "$DOMAIN" == *.localhost ]] && mark_incomplete "основной домен"
[ "$ACME_EMAIL" = "admin@${DOMAIN}" ] && mark_incomplete "e-mail Let's Encrypt"
[ -z "$EVA_TELEGRAM_BOT_TOKEN" ] && mark_incomplete "Telegram Bot Token"
[ -z "$OWNER_TELEGRAM_ID" ] && mark_incomplete "Telegram ID владельца"
if [ -z "$EVA_LLM_BASE_URL" ] || [ -z "$EVA_LLM_API_KEY" ] || [ -z "$EVA_LLM_MODEL" ]; then
	mark_incomplete "LLM-провайдер"
fi
INCOMPLETE_CSV="$(IFS=,; printf '%s' "${INCOMPLETE[*]}")"
# Значение пишется БЕЗ кавычек. Раньше оно оборачивалось в одинарные, и
# апостроф из "e-mail Let's Encrypt" закрывал кавычку раньше времени:
# docker compose переставал разбирать .env целиком и падала любая команда
# compose на недонастроенной установке. load_env этого не замечал, потому
# что читает .env построчно, а не через `source`.
#
# Кавычки здесь не нужны: compose берёт значение до конца строки, а
# load_env снимает только парные кавычки. Символы, способные сломать
# любой из двух разборщиков, убираются.
INCOMPLETE_CSV="${INCOMPLETE_CSV//[\'\"#]/}"
set_env EVASELF_INCOMPLETE_SETTINGS "$INCOMPLETE_CSV"

chmod 600 "$ENV_FILE"
ok ".env записан с mode 600"

# ---------------------------------------------------------------------
# bcrypt hash for the Letta console's basic auth
# ---------------------------------------------------------------------
# On a truly clean host the Caddy image is not pulled yet, so this can
# fail here; install.sh runs it again after the pull.
if [ "${EVASELF_SKIP_PASSWORD_HASH:-0}" != "1" ]; then
	"$SCRIPT_DIR/hash-letta-password.sh" --force 2>/dev/null \
		|| warn "пароль Letta UI будет хеширован после загрузки образов"
fi

step "Настройка завершена"
say "  Проверить файл: less .env"
if [ "${#INCOMPLETE[@]}" -gt 0 ]; then
	warn "не завершены: $INCOMPLETE_CSV"
	info "стек установится в режиме настройки; заполните значения через make configure"
else
	ok "обязательные настройки заполнены"
fi
