#!/usr/bin/env bash
# =====================================================================
# Аудит зависимостей: падает на high и critical.
#
# Уязвимость в зависимости не видна в обычных тестах — они зелёные ровно
# до инцидента. Поэтому аудит выделен в отдельную проверку.
#
# Исключения перечислены поимённо, с причиной и с тем, кто их снимет.
# Это не то же самое, что понизить порог до critical: новая уязвимость
# high, которой нет в списке, валит сборку. Список намеренно неудобный —
# он должен уменьшаться.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

# Пакеты, чьи предупреждения high приняты осознанно.
#
#   sharp, @letta-ai/letta-code, @letta-ai/letta-agent-sdk
#     sharp приходит транзитивно: letta-agent-sdk 0.5.5 -> letta-code
#     0.29.9 -> sharp 0.34.5. npm сообщает fixAvailable: false —
#     починить можно только обновлением SDK, а его версия согласована с
#     LETTA_CODE_VERSION в versions.env и меняется шагом 11 «Обновление
#     Agent SDK до 0.6.0». Менять её здесь значит тихо развести версии
#     образа и пакета.
ALLOWED_PACKAGES="
sharp
@letta-ai/letta-code
@letta-ai/letta-agent-sdk
"

failures=0

audit_npm() {
	local dir="$1"
	echo "== npm audit: $dir"
	local report
	report="$(cd "$REPO_ROOT/$dir" && npm audit --omit=dev --json 2>/dev/null || true)"
	[ -n "$report" ] || { echo "  пустой отчёт npm audit" >&2; failures=$((failures + 1)); return; }

	local unexpected
	unexpected="$(printf '%s' "$report" | ALLOWED="$ALLOWED_PACKAGES" python3 -c '
import json, os, sys

allowed = {line.strip() for line in os.environ["ALLOWED"].splitlines() if line.strip()}
data = json.load(sys.stdin)
problems = []
for name, item in (data.get("vulnerabilities") or {}).items():
    if item.get("severity") not in ("high", "critical"):
        continue
    if name in allowed:
        sys.stderr.write("  принято по списку исключений: %s (%s)\n" % (name, item.get("severity")))
        continue
    problems.append("%s severity=%s fixAvailable=%s" % (name, item.get("severity"), item.get("fixAvailable")))
for line in problems:
    print(line)
')"

	if [ -n "$unexpected" ]; then
		echo "$unexpected" | sed 's/^/  НЕ В СПИСКЕ: /'
		echo "::error::новые уязвимости high/critical в $dir"
		failures=$((failures + 1))
	else
		echo "  новых уязвимостей high/critical нет"
	fi
}

audit_npm eva-agent-service
audit_npm admin-ui

echo "== pip-audit: media-service"
if python3 -m pip_audit --strict --requirement "$REPO_ROOT/media-service/requirements.txt"; then
	echo "  уязвимостей нет"
else
	echo "::error::pip-audit нашёл уязвимости в media-service"
	failures=$((failures + 1))
fi

echo
if [ "$failures" -gt 0 ]; then
	echo "провалов аудита: $failures" >&2
	exit 1
fi
echo "аудит зависимостей пройден"
