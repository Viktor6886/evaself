#!/usr/bin/env bash
# =====================================================================
# Register / inspect / remove Eva's Telegram webhook.
#
#   scripts/telegram-webhook.sh set
#   scripts/telegram-webhook.sh status
#   scripts/telegram-webhook.sh delete
#
# The webhook points at n8n and carries a secret_token that the first node
# of the main workflow verifies, so a stranger who guesses the URL cannot
# inject updates.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env
API="https://api.telegram.org/bot${EVA_TELEGRAM_BOT_TOKEN}"
URL="https://${DOMAIN_N8N}/webhook/eva-telegram"

case "${1:-status}" in
	set)
		step "Registering the Telegram webhook"
		info "$URL"
		response="$(curl -fsS -X POST "$API/setWebhook" \
			--data-urlencode "url=${URL}" \
			--data-urlencode "secret_token=${EVA_TELEGRAM_WEBHOOK_SECRET}" \
			--data-urlencode 'allowed_updates=["message","edited_message","callback_query"]' \
			--data-urlencode 'drop_pending_updates=true')"
		if printf '%s' "$response" | jq -e '.ok' >/dev/null 2>&1; then
			ok "webhook registered"
		else
			fail "Telegram refused the webhook:"
			printf '%s\n' "$response" | jq . 2>/dev/null || printf '%s\n' "$response"
			exit 1
		fi
		say ""
		say "  Now activate 'Eva — Telegram main' in the n8n editor;"
		say "  until it is active n8n answers 404 and Telegram will retry."
		;;

	status)
		step "Telegram webhook status"
		curl -fsS "$API/getWebhookInfo" | jq . 2>/dev/null || \
			die "could not reach the Telegram API"
		;;

	delete)
		step "Removing the Telegram webhook"
		curl -fsS -X POST "$API/deleteWebhook" --data-urlencode 'drop_pending_updates=false' \
			| jq . 2>/dev/null
		ok "webhook removed — Eva will stop receiving messages"
		;;

	*)
		die "usage: $(basename "$0") {set|status|delete}"
		;;
esac
