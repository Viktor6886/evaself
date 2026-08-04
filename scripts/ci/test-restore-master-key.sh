#!/usr/bin/env bash
# =====================================================================
# restore.sh должен находить мастер-ключ ТЕКУЩЕЙ установки.
#
# Регрессия, ради которой написан тест: путь к ключу вычислялся из
# EVA_SECRETS_MASTER_KEY_FILE, но load_env вызывался почти на сто строк
# ниже расшифровки. К моменту openssl переменная была пуста, путь падал
# на умолчание /etc/evaself/secrets-master-key, которого штатная
# установка не создаёт, — и restore не открывал архив, только что
# созданный backup.sh.
#
# Ошибка проявляется только в момент восстановления, когда исходной
# установки уже нет, поэтому здесь не проверяется «переменная
# выставилась»: архив реально шифруется и реально открывается через
# настоящий restore.sh.
#
# restore.sh требует root, но с EVASELF_NONINTERACTIVE=1 останавливается
# на подтверждении сразу после показа манифеста — то есть доходит до
# конца расшифровки и ничего не меняет.
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

command -v openssl >/dev/null 2>&1 || { echo "openssl недоступен" >&2; exit 1; }

# ---------------------------------------------------------------------
# Установка: свой каталог, свой .env, свой мастер-ключ не по умолчанию.
# ---------------------------------------------------------------------
INSTALL="$WORK/install"
mkdir -p "$INSTALL/secrets"
MASTER="$INSTALL/secrets/eva-secrets-master-key"
openssl rand -base64 32 > "$MASTER"

cat > "$INSTALL/.env" <<EOF
EVA_SECRETS_MASTER_KEY_FILE=$MASTER
BACKUP_DIR=$WORK/backups
EOF
chmod 600 "$INSTALL/.env"

# ---------------------------------------------------------------------
# Архив того же вида, что делает backup.sh: каталог evaself-backup-*
# с MANIFEST, упакованный tar.gz и зашифрованный мастер-ключом.
# ---------------------------------------------------------------------
STAGE="$WORK/stage"
NAME="evaself-backup-2026-01-01-00-00"
mkdir -p "$STAGE/$NAME/postgres"
cat > "$STAGE/$NAME/MANIFEST" <<EOF
created_at=2026-01-01T00:00:00+00:00
hostname=test
domain=evaself.localhost
git_commit=0000000000000000000000000000000000000000
EOF
printf 'not-a-real-dump' > "$STAGE/$NAME/postgres/eva.dump"
tar czf "$WORK/plain.tar.gz" -C "$STAGE" "$NAME"

ARCHIVE="$WORK/$NAME.tar.gz.enc"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
	-pass "file:$MASTER" -in "$WORK/plain.tar.gz" -out "$ARCHIVE"

# ---------------------------------------------------------------------
# Прогон настоящего restore.sh.
# ---------------------------------------------------------------------
run_restore() {
	local env_file="$1" out
	local -a cmd=(
		env
		"ROOT_DIR=$INSTALL"
		"ENV_FILE=$env_file"
		"VERSIONS=$REPO_ROOT/versions.env"
		"COMPOSE_FILE=$REPO_ROOT/compose.yaml"
		EVASELF_NONINTERACTIVE=1
		NO_COLOR=1
		"$REPO_ROOT/scripts/restore.sh" "$ARCHIVE"
	)
	if [ "$(id -u)" -ne 0 ]; then
		cmd=(sudo -n "${cmd[@]}")
	fi
	out="$("${cmd[@]}" 2>&1 || true)"
	printf '%s' "$out"
}

decryption_verdict() {
	local out="$1"
	if printf '%s' "$out" | grep -q "не удалось расшифровать"; then
		echo failed
	elif printf '%s' "$out" | grep -q "Содержимое backup"; then
		echo decrypted
	else
		echo unknown
	fi
}

echo "restore.sh и мастер-ключ установки"

OUT_OK="$(run_restore "$INSTALL/.env")"
check "ключ из .env найден, архив расшифрован" decrypted "$(decryption_verdict "$OUT_OK")"

# Восстановление не должно было начаться: подтверждения не было.
if printf '%s' "$OUT_OK" | grep -q "aborted"; then
	printf '  ok    %-52s -> %s\n' "без подтверждения restore не выполняется" "aborted"
else
	printf '  FAIL  %-52s -> %s\n' "без подтверждения restore не выполняется" "нет строки aborted"
	failures=$((failures + 1))
fi

# ---------------------------------------------------------------------
# Отрицательный контроль: без записи в .env путь уходит на умолчание
# /etc/evaself/secrets-master-key. Так вёл себя старый restore.sh при
# любой установке. Если и этот прогон «расшифровал», значит тест ничего
# не проверяет — например, ключ случайно лежит по умолчанию.
# ---------------------------------------------------------------------
cat > "$INSTALL/.env-without-key" <<EOF
BACKUP_DIR=$WORK/backups
EOF
chmod 600 "$INSTALL/.env-without-key"

if [ -s /etc/evaself/secrets-master-key ]; then
	echo "  пропуск отрицательного контроля: /etc/evaself/secrets-master-key существует"
else
	OUT_BAD="$(run_restore "$INSTALL/.env-without-key")"
	check "без пути в .env архив не открывается" failed "$(decryption_verdict "$OUT_BAD")"
fi

echo
if [ "$failures" -gt 0 ]; then
	echo "провалов: $failures" >&2
	exit 1
fi
echo "все проверки восстановления пройдены"
