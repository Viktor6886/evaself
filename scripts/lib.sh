#!/usr/bin/env bash
# =====================================================================
# Shared helpers for every Evaself script.
# Sourced, never executed directly.
# =====================================================================

# shellcheck disable=SC2034
EVASELF_LIB_LOADED=1

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${ROOT_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
VERSIONS_FILE="${VERSIONS:-$ROOT_DIR/versions.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/compose.yaml}"

# ---------------------------------------------------------------------
# output
# ---------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
	C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
	C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

say()   { printf '%s\n' "$*"; }
step()  { printf '\n%s==> %s%s\n' "$C_BOLD$C_BLUE" "$*" "$C_RESET"; }
ok()    { printf '  %s✔%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail()  { printf '  %s✖%s %s\n' "$C_RED" "$C_RESET" "$*"; }
info()  { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
die()   { fail "$*"; exit 1; }

# ---------------------------------------------------------------------
# preconditions
# ---------------------------------------------------------------------
require_root() {
	[ "$(id -u)" -eq 0 ] || die "команду нужно запускать от root (используйте sudo)"
}

require_env_file() {
	[ -f "$ENV_FILE" ] || die ".env не найден — сначала выполните 'sudo make install'"
}

load_env() {
	require_env_file
	set -a
	# shellcheck disable=SC1090
	. "$VERSIONS_FILE"
	# Do not source .env as shell code. A valid bcrypt hash starts with
	# "$2", which under `set -u` used to expand as an unset positional
	# parameter and abort clean installations.
	while IFS= read -r line || [ -n "$line" ]; do
		line="${line%$'\r'}"
		[[ "$line" =~ ^[[:space:]]*# ]] && continue
		[ -z "${line//[[:space:]]/}" ] && continue
		[[ "$line" == *=* ]] || continue
		key="${line%%=*}"
		value="${line#*=}"
		[[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
		if [[ "$value" == \'*\' && "$value" == *\' ]]; then
			value="${value:1:${#value}-2}"
		elif [[ "$value" == \"*\" && "$value" == *\" ]]; then
			value="${value:1:${#value}-2}"
		fi
		printf -v "$key" '%s' "$value"
		export "$key"
	done < "$ENV_FILE"
	set +a
}

compose() {
	docker compose --env-file "$VERSIONS_FILE" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# ---------------------------------------------------------------------
# secrets & prompts
# ---------------------------------------------------------------------

# URL/shell-safe secret: hex only, so it never needs quoting in a DSN.
gen_secret() { openssl rand -hex "${1:-24}"; }

# Human-typable admin password.
gen_password() { openssl rand -base64 18 | tr -d '/+=' | cut -c1-20; }

# ask VAR "prompt" ["default"]  -> sets the named variable
ask() {
	local __var="$1" __prompt="$2" __default="${3:-}" __answer=""
	if [ -n "$__default" ]; then
		read -r -p "  $__prompt [$__default]: " __answer </dev/tty || true
		__answer="${__answer:-$__default}"
	else
		while [ -z "$__answer" ]; do
			read -r -p "  $__prompt: " __answer </dev/tty || true
			[ -n "$__answer" ] || warn "значение обязательно"
		done
	fi
	printf -v "$__var" '%s' "$__answer"
}

# ask_optional VAR "prompt" ["default"] — an empty answer is accepted
ask_optional() {
	local __var="$1" __prompt="$2" __default="${3:-}" __answer=""
	if [ -n "$__default" ]; then
		read -r -p "  $__prompt [$__default]: " __answer </dev/tty || true
		__answer="${__answer:-$__default}"
	else
		read -r -p "  $__prompt: " __answer </dev/tty || true
	fi
	printf -v "$__var" '%s' "$__answer"
}

# ask_secret VAR "prompt" — no echo
ask_secret() {
	local __var="$1" __prompt="$2" __answer=""
	while [ -z "$__answer" ]; do
		read -r -s -p "  $__prompt: " __answer </dev/tty || true
		echo
		[ -n "$__answer" ] || warn "значение обязательно"
	done
	printf -v "$__var" '%s' "$__answer"
}

# confirm "question" [default_yes]
confirm() {
	local prompt="$1" default="${2:-n}" answer=""
	local hint="[y/N]"; [ "$default" = "y" ] && hint="[Y/n]"
	read -r -p "  $prompt $hint: " answer </dev/tty || true
	answer="${answer:-$default}"
	[[ "$answer" =~ ^[Yy] ]]
}

# ---------------------------------------------------------------------
# .env editing
# ---------------------------------------------------------------------

# set_env KEY VALUE — replaces or appends, preserving the rest of the file
set_env() {
	local key="$1" value="$2" file="${3:-$ENV_FILE}"
	touch "$file"
	if grep -qE "^${key}=" "$file"; then
		# python does the substitution so any character in the value is safe
		python3 - "$file" "$key" "$value" <<-'PY'
			import sys
			path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
			with open(path, encoding="utf-8") as fh:
			    lines = fh.readlines()
			out = []
			for line in lines:
			    if line.split("=", 1)[0].strip() == key:
			        out.append(f"{key}={value}\n")
			    else:
			        out.append(line)
			with open(path, "w", encoding="utf-8") as fh:
			    fh.writelines(out)
		PY
	else
		printf '%s=%s\n' "$key" "$value" >> "$file"
	fi
}

get_env() {
	local key="$1" file="${2:-$ENV_FILE}"
	[ -f "$file" ] || return 1
	sed -n "s/^${key}=//p" "$file" | head -n1
}

# ---------------------------------------------------------------------
# validation helpers
# ---------------------------------------------------------------------
is_domain() { [[ "$1" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]]; }
is_email()  { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-zA-Z]{2,}$ ]]; }
is_number() { [[ "$1" =~ ^[0-9]+$ ]]; }
is_telegram_token() { [[ "$1" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]]; }

# ---------------------------------------------------------------------
# service helpers
# ---------------------------------------------------------------------
service_running() {
	compose ps --status running --services 2>/dev/null | grep -qx "$1"
}

wait_for_health() {
	local service="$1" timeout="${2:-180}" waited=0 status=""
	local cid
	while [ "$waited" -lt "$timeout" ]; do
		cid="$(compose ps -q "$service" 2>/dev/null || true)"
		if [ -n "$cid" ]; then
			status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
			case "$status" in
				healthy|running) return 0 ;;
				unhealthy) : ;;
			esac
		fi
		sleep 5
		waited=$((waited + 5))
	done
	return 1
}

http_status() {
	curl -sS -o /dev/null -w '%{http_code}' --max-time "${2:-10}" "$1" 2>/dev/null || echo "000"
}
