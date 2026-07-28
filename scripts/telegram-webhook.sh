#!/usr/bin/env bash
# =====================================================================
# Register / inspect / remove Eva's Telegram webhook.
#
#   scripts/telegram-webhook.sh set
#   scripts/telegram-webhook.sh status
#   scripts/telegram-webhook.sh delete
#
# The webhook points directly at eva-agent-service and carries Telegram's
# secret_token header, so a stranger who guesses the URL cannot inject updates.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env
API="https://api.telegram.org/bot${EVA_TELEGRAM_BOT_TOKEN}"
URL="https://${DOMAIN_API}/telegram/webhook"

case "${1:-status}" in
	set)
		step "Регистрация Telegram webhook"
		info "$URL"
		response="$(curl -fsS -X POST "$API/setWebhook" \
			--data-urlencode "url=${URL}" \
			--data-urlencode "secret_token=${EVA_TELEGRAM_WEBHOOK_SECRET}" \
			--data-urlencode 'allowed_updates=["message","edited_message","callback_query"]' \
			--data-urlencode 'drop_pending_updates=true')"
		if printf '%s' "$response" | jq -e '.ok' >/dev/null 2>&1; then
			ok "webhook зарегистрирован"
		else
			fail "Telegram отклонил webhook:"
			printf '%s\n' "$response" | jq . 2>/dev/null || printf '%s\n' "$response"
			exit 1
		fi
		say ""
		say "  Встроенный TypeScript runtime принимает сообщения сразу."
		;;

	status)
		step "Состояние Telegram webhook"
		curl -fsS "$API/getWebhookInfo" | jq . 2>/dev/null || \
			die "не удалось обратиться к Telegram API"
		;;

	delete)
		step "Удаление Telegram webhook"
		curl -fsS -X POST "$API/deleteWebhook" --data-urlencode 'drop_pending_updates=false' \
			| jq . 2>/dev/null
		ok "webhook удалён — Ева перестанет получать сообщения"
		;;

	*)
		die "использование: $(basename "$0") {set|status|delete}"
		;;
esac
