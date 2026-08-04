#!/usr/bin/env bash
# =====================================================================
# .env, созданный configure.sh, должен читаться ОБОИМИ разборщиками.
#
# Регрессия, ради которой написан тест: EVASELF_INCOMPLETE_SETTINGS
# записывался в одинарных кавычках, а в значение попадала строка
# "e-mail Let's Encrypt". Апостроф закрывал кавычку раньше времени, и
# docker compose переставал разбирать .env ЦЕЛИКОМ — падали make start,
# make status, make backup, то есть вся работа с недонастроенной
# установкой.
#
# Прежняя проверка в CI этого не ловила: load_env читает .env построчно
# и снимает только парные кавычки, поэтому для bash файл оставался
# корректным. Расхождение двух разборщиков и есть предмет теста.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
failures=0

check() {
	local label="$1" expected="$2" actual="$3"
	if [ "$expected" = "$actual" ]; then
		printf '  ok    %-52s -> %s\n' "$label" "$actual"
	else
		printf '  FAIL  %-52s -> ожидалось "%s", получено "%s"\n' "$label" "$expected" "$actual"
		failures=$((failures + 1))
	fi
}

ENV_OUT="$WORK/evaself.env"

# Установка без домена, e-mail, токена и LLM — именно тот случай, когда
# список незавершённых настроек непуст и содержит апостроф.
ENV_FILE="$ENV_OUT" \
EVASELF_NONINTERACTIVE=1 \
EVASELF_SKIP_PASSWORD_HASH=1 \
	"$REPO_ROOT/scripts/configure.sh" >/dev/null 2>&1

[ -s "$ENV_OUT" ] || { echo "configure.sh не создал .env" >&2; exit 1; }

echo ".env после configure.sh"

# Предусловие: список незавершённых настроек действительно непуст и
# действительно содержит запись про Let's Encrypt. Без этого тест
# проверял бы пустую строку и всегда был бы зелёным.
incomplete_line="$(grep '^EVASELF_INCOMPLETE_SETTINGS=' "$ENV_OUT" || true)"
if printf '%s' "$incomplete_line" | grep -q "Encrypt"; then
	printf '  ok    %-52s -> %s\n' "список незавершённых настроек непуст" "есть запись Let's Encrypt"
else
	printf '  FAIL  %-52s -> %s\n' "список незавершённых настроек непуст" "$incomplete_line"
	failures=$((failures + 1))
fi

# 1. docker compose разбирает файл.
compose_verdict() {
	if docker compose --env-file "$REPO_ROOT/versions.env" --env-file "$ENV_OUT" \
		-f "$REPO_ROOT/compose.yaml" config --services >/dev/null 2>"$WORK/compose.err"; then
		echo parsed
	elif grep -q "failed to read" "$WORK/compose.err"; then
		echo unreadable
	else
		# Другая ошибка compose — не предмет этого теста, но и не успех.
		echo "other:$(head -1 "$WORK/compose.err")"
	fi
}

if command -v docker >/dev/null 2>&1; then
	check "docker compose читает .env" parsed "$(compose_verdict)"
else
	echo "  docker недоступен — проверка compose пропущена" >&2
	exit 1
fi

# 2. load_env разбирает тот же файл и значение доходит целиком.
load_verdict() {
	ENV_FILE="$ENV_OUT" VERSIONS="$REPO_ROOT/versions.env" \
		bash -euo pipefail -c '
			. '"$REPO_ROOT"'/scripts/lib.sh
			load_env
			printf "%s" "${EVASELF_INCOMPLETE_SETTINGS:-}"
		' 2>/dev/null || echo "__load_env_failed__"
}

loaded="$(load_verdict)"
if [ "$loaded" = "__load_env_failed__" ]; then
	check "load_env читает .env" ok failed
else
	printf '  ok    %-52s -> %s\n' "load_env читает .env" "ok"
fi

# Значение не должно быть обрезано апострофом: обе крайние записи на месте.
for expected in "Encrypt" "LLM"; do
	if printf '%s' "$loaded" | grep -q "$expected"; then
		printf '  ok    %-52s -> %s\n' "значение не обрезано: $expected" "есть"
	else
		printf '  FAIL  %-52s -> %s\n' "значение не обрезано: $expected" "нет в «$loaded»"
		failures=$((failures + 1))
	fi
done

# Кавычки в значении не появляются: именно они и ломали compose.
if printf '%s' "$incomplete_line" | grep -q "'"; then
	printf '  FAIL  %-52s -> %s\n' "в значении нет одинарных кавычек" "$incomplete_line"
	failures=$((failures + 1))
else
	printf '  ok    %-52s -> %s\n' "в значении нет одинарных кавычек" "чисто"
fi

echo
if [ "$failures" -gt 0 ]; then
	echo "провалов: $failures" >&2
	exit 1
fi
echo "все проверки .env пройдены"
