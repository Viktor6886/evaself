#!/usr/bin/env bash
# Состояние канонического контекста, по которому update и rollback решают,
# объявлять успех или degraded.
#
# Раньше это решение принималось по факту «контейнеры поднялись»: два
# файла library/ доводятся до существующих агентов фоновым проходом, и
# update заканчивался раньше него. Полный успех при половине агентов на
# старом тексте — худший из отказов: расхождение всплывало только в
# разговоре. Разбор состояния вынесен в функцию и проверяется здесь.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
. "$SCRIPT_DIR/../lib.sh"

failures=0

check() {
	local label="$1" expected="$2" actual="$3"
	if [ "$expected" = "$actual" ]; then
		printf '  ok    %s -> %s\n' "$label" "$actual"
	else
		printf '  FAIL  %s -> ожидалось %s, получено %s\n' "$label" "$expected" "$actual"
		failures=$((failures + 1))
	fi
}

verdict_field() {
	local body="$1" field="$2" status version total up_to_date stale failed deferred
	# shellcheck disable=SC2086
	eval "$(printf '%s' "$body" | canonical_context_verdict)"
	printf '%s' "${!field}"
}

# 1. Все агенты на текущей версии — успех.
OK_BODY='{"checks":{"persona_sync":{"status":"ok","version":"abc123","agents":{"total":3,"upToDate":3,"stale":0,"failed":0,"deferred":0}}}}'
check "все агенты сведены: status" ok "$(verdict_field "$OK_BODY" status)"
check "все агенты сведены: version" abc123 "$(verdict_field "$OK_BODY" version)"
check "все агенты сведены: up_to_date" 3 "$(verdict_field "$OK_BODY" up_to_date)"

# 2. Часть агентов на старой версии — degraded, а не успех.
STALE_BODY='{"checks":{"persona_sync":{"status":"degraded","version":"abc123","agents":{"total":4,"upToDate":2,"stale":2,"failed":1,"deferred":1}}}}'
check "остались stale: status" degraded "$(verdict_field "$STALE_BODY" status)"
check "остались stale: stale" 2 "$(verdict_field "$STALE_BODY" stale)"
check "остались stale: failed" 1 "$(verdict_field "$STALE_BODY" failed)"
check "остались stale: deferred" 1 "$(verdict_field "$STALE_BODY" deferred)"

# 3. Сервис ответил не тем — состояние неизвестно, а не «в порядке».
check "не JSON: status" unknown "$(verdict_field 'internal server error' status)"
check "пустой ответ: status" unknown "$(verdict_field '' status)"

# 4. Ответ без сводки по агентам (старый сервис за новым скриптом):
#    статус читается, счётчики не выдумываются.
LEGACY_BODY='{"checks":{"persona_sync":{"status":"never","version":"","staleAgents":0}}}'
check "старый формат: status" never "$(verdict_field "$LEGACY_BODY" status)"
check "старый формат: total" 0 "$(verdict_field "$LEGACY_BODY" total)"

# 5. Версия после rollback — та, что в репозитории сейчас, и решение
#    принимается по ней: агент, оставшийся на версии новее, — stale.
ROLLED_BACK='{"checks":{"persona_sync":{"status":"degraded","version":"old111","agents":{"total":2,"upToDate":1,"stale":1,"failed":0,"deferred":0}}}}'
check "после rollback: version" old111 "$(verdict_field "$ROLLED_BACK" version)"
check "после rollback: status" degraded "$(verdict_field "$ROLLED_BACK" status)"

# 6. canonical_context_settled ждёт именно `ok` и не считает истёкшее окно
#    успехом. Источник состояния подменяется, docker здесь не нужен.
canonical_context_state() { printf 'status=degraded version=abc123 total=2 up_to_date=1 stale=1 failed=0 deferred=0\n'; }
if canonical_context_settled 0; then
	printf '  FAIL  истёкшее окно объявлено успехом\n'
	failures=$((failures + 1))
else
	printf '  ok    истёкшее окно с stale-агентами -> не успех\n'
fi

canonical_context_state() { printf 'status=ok version=abc123 total=2 up_to_date=2 stale=0 failed=0 deferred=0\n'; }
if canonical_context_settled 0; then
	printf '  ok    все агенты сведены -> успех\n'
else
	printf '  FAIL  сведённое состояние не признано успехом\n'
	failures=$((failures + 1))
fi

# Неподдержанная maintenance-операция не станет поддержанной от ожидания.
canonical_context_state() { printf 'status=unsupported version=abc123 total=1 up_to_date=0 stale=1 failed=0 deferred=0\n'; }
if canonical_context_settled 30; then
	printf '  FAIL  unsupported объявлено успехом\n'
	failures=$((failures + 1))
else
	printf '  ok    unsupported -> не успех и без ожидания\n'
fi

# Сервис не отвечает вовсе: это не успех.
canonical_context_state() { return 1; }
if canonical_context_settled 0; then
	printf '  FAIL  недоступное состояние объявлено успехом\n'
	failures=$((failures + 1))
else
	printf '  ok    недоступное состояние -> не успех\n'
fi

[ "$failures" -eq 0 ] || exit 1
printf 'canonical context verdict: все проверки пройдены\n'
