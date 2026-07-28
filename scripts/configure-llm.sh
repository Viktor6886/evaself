#!/usr/bin/env bash
# Создание и безопасная активация OpenAI-compatible конфигурации.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env

if [ "${1:-}" = "--from-env" ]; then
	step "Импорт первой LLM-конфигурации из .env"
	EXISTING="$(printf '' | "$SCRIPT_DIR/llm-api.sh" GET /v1/llm/providers)"
	COUNT="$(printf '%s' "$EXISTING" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["providers"]))')"
	if [ "$COUNT" -gt 0 ]; then
		info "реестр уже содержит ${COUNT} конфигураций; повторный импорт не нужен"
		exit 0
	fi
	if RESULT="$(printf '' | "$SCRIPT_DIR/llm-api.sh" POST /v1/llm/import-env)"; then
		printf '%s\n' "$RESULT" | python3 -c '
import json, sys
p = json.load(sys.stdin)["provider"]
print("  ✔ Активна конфигурация «{}», модель {}".format(p["name"], p["model_handle"]))
'
		exit 0
	fi
	die "не удалось импортировать и активировать LLM-конфигурацию"
fi

step "Новая LLM-конфигурация"
ask NAME "Название" "Новый провайдер"
ask BASE_URL "Base URL (обычно …/v1)"
ask_secret API_KEY "API Key"
ask MODEL "Название модели"
while :; do
	ask CONTEXT_WINDOW "Context window" "32768"
	is_number "$CONTEXT_WINDOW" && [ "$CONTEXT_WINDOW" -ge 1024 ] && break
	warn "context window должен быть целым числом не меньше 1024"
done
ask PARAMETERS "Дополнительные параметры JSON" '{"request_timeout_ms":180000}'

PAYLOAD="$(
	NAME="$NAME" BASE_URL="$BASE_URL" API_KEY="$API_KEY" MODEL="$MODEL" \
	CONTEXT_WINDOW="$CONTEXT_WINDOW" PARAMETERS="$PARAMETERS" \
	python3 - <<'PY'
import json, os
parameters = json.loads(os.environ["PARAMETERS"])
if not isinstance(parameters, dict):
    raise SystemExit("дополнительные параметры должны быть JSON-объектом")
print(json.dumps({
    "name": os.environ["NAME"],
    "protocol": "openai-compatible",
    "base_url": os.environ["BASE_URL"],
    "api_key": os.environ["API_KEY"],
    "model": os.environ["MODEL"],
    "context_window": int(os.environ["CONTEXT_WINDOW"]),
    "additional_parameters": parameters,
}, ensure_ascii=False))
PY
)" || die "не удалось сформировать конфигурацию"
unset API_KEY

RESULT="$(printf '%s' "$PAYLOAD" | "$SCRIPT_DIR/llm-api.sh" POST /v1/llm/providers)" \
	|| die "не удалось сохранить конфигурацию"
unset PAYLOAD
ID="$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["provider"]["id"])')"
ok "конфигурация сохранена: $ID"

step "Проверка подключения"
TEST_RESULT="$(printf '' | "$SCRIPT_DIR/llm-api.sh" POST "/v1/llm/providers/${ID}/test")" \
	|| die "проверка провайдера завершилась ошибкой"
printf '%s' "$TEST_RESULT" | python3 -c '
import json,sys
r=json.load(sys.stdin)["result"]
print("  " + r["message"])
if r["models_supported"] and r["models"]:
    print("  Первые модели: " + ", ".join(x["id"] for x in r["models"][:10]))
'

if confirm "Сделать эту конфигурацию активной?" y; then
	step "Безопасное переключение LLM"
	ACTIVE="$(printf '' | "$SCRIPT_DIR/llm-api.sh" POST "/v1/llm/providers/${ID}/activate")" \
		|| die "переключение не выполнено; предыдущая конфигурация осталась активной"
	printf '%s' "$ACTIVE" | python3 -c '
import json,sys
p=json.load(sys.stdin)["provider"]
print("  ✔ Активна «{}»: {}".format(p["name"], p["model_handle"]))
'
else
	info "конфигурация сохранена неактивной"
fi
