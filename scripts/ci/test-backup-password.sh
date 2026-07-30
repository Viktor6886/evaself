#!/usr/bin/env bash
# Проверка выбора пароля для шифрования архива и обоих поколений архивов.
#
# Ошибка здесь необратима несимметрично. Если backup.sh возьмёт не тот
# ключ, архив всё равно создастся, проверится и ляжет в хранилище — а
# выяснится это при восстановлении, когда исходной установки уже нет.
# Поэтому здесь не проверяется «функция вернула строку»: архивы реально
# шифруются openssl и реально расшифровываются обратно.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
. "$SCRIPT_DIR/../lib.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
failures=0

check() {
	local label="$1" expected="$2" actual="$3"
	if [ "$expected" = "$actual" ]; then
		printf '  ok    %-46s -> %s\n' "$label" "$actual"
	else
		printf '  FAIL  %-46s -> ожидалось "%s", получено "%s"\n' "$label" "$expected" "$actual"
		failures=$((failures + 1))
	fi
}

REPO="$WORK/repo"
mkdir -p "$REPO/secrets"
MASTER="$WORK/master-key"
PASSWORD_FILE="$REPO/secrets/backup-archive-password"

# Какой источник выбран: пароль архива, мастер-ключ или ничего.
source_kind() {
	local out
	if ! out="$(EVA_BACKUP_MASTER_KEY_FILE="$MASTER" backup_pass_source "$REPO" 2>/dev/null)"; then
		echo none
		return
	fi
	case "$out" in
		*backup-archive-password) echo password ;;
		*master-key) echo master ;;
		*) echo "неизвестный:$out" ;;
	esac
}

# ---------------------------------------------------------------------
# 1. выбор источника
# ---------------------------------------------------------------------
echo "выбор источника пароля"

check "нет ни пароля, ни мастер-ключа" none "$(source_kind)"

printf 'master-key-value' > "$MASTER"
check "только мастер-ключ" master "$(source_kind)"

printf 'a-very-long-archive-password' > "$PASSWORD_FILE"
check "пароль важнее мастер-ключа" password "$(source_kind)"

# Пустой файл — это «не задан», а не «пустой пароль»: иначе очистка поля
# в панели молча зашифровала бы архив пустой строкой.
: > "$PASSWORD_FILE"
check "пустой файл пароля не считается заданным" master "$(source_kind)"

rm -f "$PASSWORD_FILE"
check "удалённый пароль возвращает к мастер-ключу" master "$(source_kind)"

# ---------------------------------------------------------------------
# 2. настоящие архивы обоих поколений
# ---------------------------------------------------------------------
echo "шифрование и расшифровка"

if ! command -v openssl >/dev/null 2>&1; then
	echo "  openssl недоступен — часть проверок пропущена" >&2
	exit 1
fi

printf 'eva-backup-payload' > "$WORK/payload"
tar czf "$WORK/plain.tgz" -C "$WORK" payload

encrypt() {
	openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
		-pass "$1" -in "$WORK/plain.tgz" -out "$2"
}

# Старое поколение: архив зашифрован мастер-ключом.
encrypt "file:$MASTER" "$WORK/old.enc"
# Новое: отдельным паролем.
printf 'a-very-long-archive-password' > "$PASSWORD_FILE"
encrypt "file:$PASSWORD_FILE" "$WORK/new.enc"

# Порядок попыток из restore.sh: сначала пароль, затем мастер-ключ.
try_decrypt() {
	local archive="$1" out="$WORK/decrypted.tgz"
	local first
	first="$(EVA_BACKUP_MASTER_KEY_FILE="$MASTER" backup_pass_source "$REPO" 2>/dev/null || true)"
	for pass in "$first" "file:$MASTER"; do
		[ -n "$pass" ] || continue
		[ -s "${pass#file:}" ] || continue
		if openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
			-pass "$pass" -in "$archive" -out "$out" 2>/dev/null &&
			tar tzf "$out" >/dev/null 2>&1; then
			echo ok
			return
		fi
	done
	echo fail
}

check "архив на мастер-ключе восстанавливается" ok "$(try_decrypt "$WORK/old.enc")"
check "архив на пароле восстанавливается" ok "$(try_decrypt "$WORK/new.enc")"

# Снятие пароля не должно ломать старые архивы — и должно ломать новые.
# Второе не дефект, а цена отдельного пароля, и лучше узнать о ней здесь.
rm -f "$PASSWORD_FILE"
check "без пароля старый архив всё ещё открывается" ok "$(try_decrypt "$WORK/old.enc")"
check "без пароля новый архив не открывается" fail "$(try_decrypt "$WORK/new.enc")"

# Чужой пароль не должен подходить.
printf 'completely-different-password' > "$PASSWORD_FILE"
check "неверный пароль не открывает архив" fail "$(try_decrypt "$WORK/new.enc")"

# ---------------------------------------------------------------------
# 3. формат файла
# ---------------------------------------------------------------------
echo "формат файла пароля"

# openssl -pass file: берёт первую строку и отбрасывает её перевод. Отсюда
# два следствия, и оба стоит зафиксировать: хвостовой перевод безвреден, а
# перевод ВНУТРИ пароля отрезает всё после себя — архив зашифруется
# огрызком, а восстанавливать его будут полным паролем.
printf 'shared-secret-value' > "$WORK/no-newline"
printf 'shared-secret-value\n' > "$WORK/with-newline"
printf 'shared-secret-value\nignored-tail' > "$WORK/multiline"
printf 'shared-secret-value-ignored-tail' > "$WORK/full-value"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
	-pass "file:$WORK/no-newline" -in "$WORK/plain.tgz" -out "$WORK/nn.enc"

opens_with() {
	if openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
		-pass "file:$1" -in "$WORK/nn.enc" -out /dev/null 2>/dev/null; then
		echo yes
	else
		echo no
	fi
}

check "хвостовой перевод строки не меняет ключ" yes "$(opens_with "$WORK/with-newline")"
check "всё после перевода строки игнорируется" yes "$(opens_with "$WORK/multiline")"
# Именно поэтому admin-api отвергает пароль с переводом строки: иначе
# пароль и ключ архива разошлись бы молча.
check "пароль без перевода — это другой пароль" no "$(opens_with "$WORK/full-value")"

echo
if [ "$failures" -gt 0 ]; then
	echo "провалов: $failures" >&2
	exit 1
fi
echo "все проверки пароля архива пройдены"
