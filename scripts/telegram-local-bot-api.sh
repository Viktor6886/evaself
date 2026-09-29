#!/usr/bin/env bash
# =====================================================================
# Свой сервер Telegram Bot API: аудиофайлы больше 20 МБ
# (docs/telegram-bot-api.md).
#
#   scripts/telegram-local-bot-api.sh status
#   scripts/telegram-local-bot-api.sh prepare   # только поднять сервер и проверить бота
#   scripts/telegram-local-bot-api.sh enable
#   scripts/telegram-local-bot-api.sh disable
#
# То же делает кнопка в панели («Распознавание речи → Файлы из Telegram»):
# сервис операций запускает этот скрипт с EVA_UPDATER_INVOCATION=1 —
# сначала prepare, затем, после выхода бота из облака, enable.
#
# Порядок переезда выбран так, чтобы отказ на любом шаге не оставлял бота
# без связи: сначала свой сервер поднимается и принимает бота (бот ещё в
# облаке и работает, .env режима не тронут), потом бот выходит из облака,
# и только потом адрес и профиль попадают в .env и клиенты пересоздаются.
#
# Облачный Bot API отдаёт ботам файлы только до 20 МБ. Свой сервер в
# локальном режиме отдаёт файлы любого размера, но переезд бота на него —
# это смена сервера, через который идут все его сообщения. Поэтому он не
# включается сам: скрипт запускает человек, ключи API — его, с
# https://my.telegram.org.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env

LOCAL_URL="http://telegram-bot-api:8081"
CLOUD_URL="https://api.telegram.org"
PROFILE="bot-api"
# Всё, что обращается к Bot API: агент, панель (смена бота) и media-service
# (скачивание аудио). Все трое должны смотреть на один и тот же сервер.
CLIENTS=(eva-agent-service admin-api media-service)

# Запуск из панели. Подтверждение человек уже дал в окне панели, из
# облака бота выводит admin-api между prepare и enable (у сервиса операций
# нет выхода к Telegram), а admin-api ждёт ответа этой операции — его
# пересоздаёт сервис операций после ответа (подкоманда recreate-admin).
FROM_PANEL=0
if [ "${EVA_UPDATER_INVOCATION:-0}" = "1" ]; then
	FROM_PANEL=1
	CLIENTS=(eva-agent-service media-service)
fi

profiles_with() {
	local current="${COMPOSE_PROFILES:-}"
	case ",$current," in
		*",$PROFILE,"*) printf '%s' "$current" ;;
		",,") printf '%s' "$PROFILE" ;;
		*) printf '%s,%s' "$current" "$PROFILE" ;;
	esac
}

profiles_without() {
	printf '%s' "${COMPOSE_PROFILES:-}" \
		| tr ',' '\n' | grep -vx "$PROFILE" | grep -v '^$' | paste -sd, - || true
}

require_bot_token() {
	[ -n "${EVA_TELEGRAM_BOT_TOKEN:-}" ] || die "EVA_TELEGRAM_BOT_TOKEN не задан: сначала make configure"
}

# Команды к самому серверу — с его профилем, даже пока в .env профиля ещё
# (или уже) нет: иначе compose не видит сервис, и ни prepare, ни уборка
# после неполного переезда не нашли бы контейнер.
compose_bot_api() {
	COMPOSE_PROFILES="$(profiles_with)" compose "$@"
}

bot_api_running() {
	compose_bot_api ps --status running --services 2>/dev/null | grep -qx telegram-bot-api
}

# Агент ставит webhook один раз, при старте. Если свой сервер к этому
# моменту ещё не принял бота, вебхук не встанет, а из облака бот уже
# вышел — Ева замолчит. Поэтому бот выходит из облака и клиенты
# пересоздаются только после того, как свой сервер ответил на getMe этим
# самым ботом.
wait_for_local_bot() {
	for _ in $(seq 1 45); do
		if compose_bot_api exec -T telegram-bot-api \
			wget -qO- "http://127.0.0.1:8081/bot${EVA_TELEGRAM_BOT_TOKEN}/getMe" 2>/dev/null \
			| grep -q '"ok":true'; then
			return 0
		fi
		sleep 2
	done
	return 1
}

# Поднять свой сервер и дождаться, пока он примет бота. Режим в .env не
# меняется: бот ещё в облаке и отвечает, и отказ здесь ничего не ломает.
prepare_local_server() {
	[ -n "${TELEGRAM_API_ID:-}" ] && [ -n "${TELEGRAM_API_HASH:-}" ] \
		|| die "задайте TELEGRAM_API_ID и TELEGRAM_API_HASH в .env (https://my.telegram.org → API development tools)"
	# Сборка без вывода: из панели скрипт запускает сервис операций, и
	# журнал сборки переполнил бы его буфер. Отказ всё равно виден кодом.
	compose_bot_api build --quiet telegram-bot-api
	compose_bot_api up -d telegram-bot-api
	if ! wait_for_local_bot; then
		# Хвост журнала — сразу в отказ: из панели на сервер не зайти.
		compose_bot_api logs --no-color --tail 15 telegram-bot-api >&2 || true
		die "свой сервер Bot API не принял бота за полторы минуты — бот остался на прежнем сервере; проверьте API ID и API Hash"
	fi
	ok "свой сервер Bot API принял бота"
}

case "${1:-status}" in
	status)
		step "Сервер Telegram Bot API"
		info "EVA_TELEGRAM_API_BASE_URL=${EVA_TELEGRAM_API_BASE_URL:-$CLOUD_URL}"
		case ",${COMPOSE_PROFILES:-}," in
			*",$PROFILE,"*) ok "профиль $PROFILE включён" ;;
			*) info "профиль $PROFILE выключен — работает облачный Bot API, файлы до 20 МБ" ;;
		esac
		if bot_api_running; then
			ok "контейнер telegram-bot-api запущен"
		else
			info "контейнер telegram-bot-api не запущен"
		fi
		;;

	prepare)
		require_bot_token
		step "Подготовка своего сервера Bot API"
		prepare_local_server
		;;

	enable)
		require_bot_token
		step "Переезд бота на свой сервер Bot API"
		if [ "$FROM_PANEL" = "0" ]; then
			warn "бот выйдет из облачного Bot API; вернуться в облако Telegram позволит не раньше чем через 10 минут"
			confirm "Продолжить?" || exit 0
		fi
		# Из панели сервер уже подготовлен отдельным шагом; повтор дешёвый —
		# образ собран, контейнер поднят, getMe отвечает сразу.
		prepare_local_server

		if [ "$FROM_PANEL" = "0" ] && [ "${EVA_TELEGRAM_API_BASE_URL:-$CLOUD_URL}" = "$CLOUD_URL" ]; then
			# Без logOut Telegram не гарантирует, что обновления пойдут на свой
			# сервер. Повторный вызов отвечает ошибкой — это значит, бот уже вышел.
			response="$(curl -sS -X POST "$CLOUD_URL/bot${EVA_TELEGRAM_BOT_TOKEN}/logOut" || true)"
			if printf '%s' "$response" | jq -e '.ok' >/dev/null 2>&1; then
				ok "бот вышел из облачного Bot API"
			else
				warn "облачный Bot API ответил: $(printf '%s' "$response" | jq -r '.description // .' 2>/dev/null)"
				info "если бот уже выходил из облака раньше, это ожидаемо"
			fi
		fi

		# Режим попадает в .env только теперь, когда сервер доказал, что
		# работает: отказ выше оставил бы .env указывать на нерабочий адрес,
		# и следующий же перезапуск увёл бы туда агента.
		set_env COMPOSE_PROFILES "$(profiles_with)"
		set_env EVA_TELEGRAM_API_BASE_URL "$LOCAL_URL"
		load_env
		# Агент при старте сам ставит webhook — уже через свой сервер.
		compose up -d "${CLIENTS[@]}"
		ok "свой сервер Bot API включён: аудиофайлы до ${EVA_AUDIO_FILE_MAX_MB:-350} МБ"
		info "проверить: scripts/telegram-local-bot-api.sh status"
		;;

	disable)
		require_bot_token
		step "Возврат бота в облачный Bot API"
		if [ "$FROM_PANEL" = "0" ]; then
			confirm "Вернуть бота в облако? Файлы больше 20 МБ снова перестанут приниматься." || exit 0
		fi
		if bot_api_running; then
			# close освобождает бота на своём сервере, иначе облако может не
			# принять его ещё какое-то время.
			compose_bot_api exec -T telegram-bot-api \
				wget -qO- --post-data='' "http://127.0.0.1:8081/bot${EVA_TELEGRAM_BOT_TOKEN}/close" >/dev/null 2>&1 \
				|| warn "свой сервер не ответил на close — продолжаю"
		fi
		# Контейнер удаляется, а не только останавливается: остановленный
		# панель показывала бы красным «не запущен», хотя он выключен
		# намеренно. Том с данными сервера остаётся.
		compose_bot_api rm -s -f telegram-bot-api >/dev/null 2>&1 || true
		set_env COMPOSE_PROFILES "$(profiles_without)"
		set_env EVA_TELEGRAM_API_BASE_URL "$CLOUD_URL"
		load_env
		compose up -d "${CLIENTS[@]}"
		ok "бот снова работает через облачный Bot API"
		info "том evaself_telegram_bot_api_data остаётся; удалить его — решение человека"
		;;

	recreate-admin)
		# Только из панели: admin-api перечитывает адрес Bot API из .env
		# лишь при пересоздании, а сам себя пересоздать посреди запроса не может.
		compose up -d --no-deps admin-api >/dev/null
		ok "admin-api пересоздан"
		;;

	*)
		die "использование: $0 {status|prepare|enable|disable}"
		;;
esac
