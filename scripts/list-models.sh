#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ID="${1:-}"
if [ -z "$ID" ]; then
	PROVIDERS="$(printf '' | "$SCRIPT_DIR/llm-api.sh" GET /v1/llm/providers)"
	ID="$(printf '%s' "$PROVIDERS" | python3 -c '
import json,sys
items=json.load(sys.stdin)["providers"]
active=next((x for x in items if x["is_active"]), None)
if not active: raise SystemExit("активная LLM-конфигурация не найдена")
print(active["id"])
')"
fi

step "Модели провайдера $ID"
printf '' | "$SCRIPT_DIR/llm-api.sh" GET "/v1/llm/providers/${ID}/models" \
	| python3 -c '
import json,sys
r=json.load(sys.stdin)["result"]
print("  " + r["message"])
if not r["models_supported"]:
    print("  Укажите название модели вручную в WebUI или make configure-llm.")
for model in r["models"]:
    print("  " + model["id"])
raise SystemExit(0 if r["ok"] else 1)
'
