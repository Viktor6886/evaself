#!/usr/bin/env bash
# Внутренний клиент административного LLM API. JSON-тело читает из stdin,
# поэтому LLM API key никогда не передаётся через аргументы процесса.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env
service_running eva-agent-service || die "eva-agent-service не запущен (выполните make start)"

METHOD="${1:-GET}"
PATHNAME="${2:-/v1/llm/providers}"

compose exec -T eva-agent-service node -e '
const [method, pathname] = process.argv.slice(1);
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", async () => {
  const base = "http://127.0.0.1:" + (process.env.EVA_AGENT_PORT || "8070");
  try {
    const response = await fetch(base + pathname, {
      method,
      headers: {
        "X-API-Key": process.env.EVA_AGENT_API_KEY,
        ...(body.trim() ? { "Content-Type": "application/json" } : {}),
      },
      ...(body.trim() ? { body } : {}),
    });
    const text = await response.text();
    if (text) process.stdout.write(text + "\n");
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Не удалось обратиться к административному API: ${error.message}\n`);
    process.exitCode = 1;
  }
});
' "$METHOD" "$PATHNAME"
