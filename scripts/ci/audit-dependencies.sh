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
#     sharp приходит транзитивно: letta-agent-sdk -> letta-code ->
#     sharp. npm сообщает fixAvailable: false — починить можно только
#     обновлением SDK. Его версия связана с LETTA_CODE_VERSION в
#     versions.env, и правит их обе разом
#     scripts/ci/sync-letta-versions.py; менять что-то одно здесь значит
#     тихо развести версии образа и пакета.
ALLOWED_PACKAGES="
sharp
@letta-ai/letta-code
@letta-ai/letta-agent-sdk
"

failures=0

# Сетевой шаг может зависнуть на чужой стороне: реестр пакетов отвечает
# байт в минуту, и job висит до таймаута, ничего не сообщая. Ждём
# ограниченное время и повторяем — но только когда время вышло. Настоящий
# отказ аудита возвращает свой код и повторами не размывается.
with_retry() {
	local limit="$1"; shift
	local attempt code
	for attempt in 1 2 3; do
		# Код берётся прямо у команды: после `if ... fi` в $? лежит
		# результат самой инструкции if, а не упавшей команды, и
		# зависание не отличить от успеха.
		code=0
		timeout "$limit" "$@" || code=$?
		[ "$code" -eq 0 ] && return 0
		[ "$code" -eq 124 ] || return "$code"
		echo "  попытка $attempt: нет ответа за ${limit} с, повтор" >&2
		sleep 10
	done
	return 124
}

audit_npm() {
	local dir="$1"
	echo "== npm audit: $dir"
	local report
	report="$(cd "$REPO_ROOT/$dir" && with_retry 300 npm audit --omit=dev --json 2>/dev/null || true)"
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
if with_retry 600 python3 -m pip_audit --strict --requirement "$REPO_ROOT/media-service/requirements.txt"; then
	echo "  уязвимостей нет"
elif [ $? -eq 124 ]; then
	echo "::error::pip-audit не ответил за три попытки — аудит не выполнен"
	failures=$((failures + 1))
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
