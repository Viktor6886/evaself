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

# Diagnostic and maintenance commands must not consume the caller's stdin.
# This keeps `make doctor && ...` and remote/CI pipelines deterministic.
compose_no_stdin() {
	compose "$@" </dev/null
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
	if [ "${EVASELF_NONINTERACTIVE:-0}" = "1" ]; then
		[ -n "$__default" ] || die "$__prompt: нет значения для non-interactive режима"
		printf -v "$__var" '%s' "$__default"
		return
	fi
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
	if [ "${EVASELF_NONINTERACTIVE:-0}" = "1" ]; then
		printf -v "$__var" '%s' "$__default"
		return
	fi
	if [ -n "$__default" ]; then
		read -r -p "  $__prompt [$__default]: " __answer </dev/tty || true
		__answer="${__answer:-$__default}"
	else
		read -r -p "  $__prompt: " __answer </dev/tty || true
	fi
	[[ "${__answer,,}" == "skip" ]] && __answer="$__default"
	printf -v "$__var" '%s' "$__answer"
}

# ask_secret VAR "prompt" — no echo
ask_secret() {
	local __var="$1" __prompt="$2" __answer=""
	if [ "${EVASELF_NONINTERACTIVE:-0}" = "1" ]; then
		die "$__prompt: секрет нельзя запросить в non-interactive режиме"
	fi
	while [ -z "$__answer" ]; do
		read -r -s -p "  $__prompt: " __answer </dev/tty || true
		echo
		[ -n "$__answer" ] || warn "значение обязательно"
	done
	printf -v "$__var" '%s' "$__answer"
}

# ask_secret_optional VAR "prompt" ["default"] — hidden input; Enter keeps
# the existing value or deliberately leaves the setting incomplete.
ask_secret_optional() {
	local __var="$1" __prompt="$2" __default="${3:-}" __answer=""
	if [ "${EVASELF_NONINTERACTIVE:-0}" = "1" ]; then
		printf -v "$__var" '%s' "$__default"
		return
	fi
	local __hint=""
	[ -n "$__default" ] && __hint=" (Enter = оставить сохранённое)"
	read -r -s -p "  $__prompt$__hint: " __answer </dev/tty || true
	echo
	__answer="${__answer:-$__default}"
	[[ "${__answer,,}" == "skip" ]] && __answer="$__default"
	printf -v "$__var" '%s' "$__answer"
}

# confirm "question" [default_yes]
confirm() {
	local prompt="$1" default="${2:-n}" answer=""
	if [ "${EVASELF_NONINTERACTIVE:-0}" = "1" ]; then
		[[ "$default" = "y" ]]
		return
	fi
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
is_email()  {
	local value="${1#"${1%%[![:space:]]*}"}"
	value="${value%"${value##*[![:space:]]}"}"
	local pattern='^[A-Za-z0-9._%+~-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
	[[ "$value" =~ $pattern ]]
}
is_number() { [[ "$1" =~ ^[0-9]+$ ]]; }
is_telegram_token() { [[ "$1" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]]; }

# Searchable timezone chooser. On a clean Ubuntu host install.sh supplies fzf;
# non-interactive runs and minimal hosts safely keep the proposed value.
choose_timezone() {
	local __var="$1" __default="${2:-UTC}" __selected=""
	if [ -t 0 ] && [ -t 1 ] && command -v timedatectl >/dev/null 2>&1 \
		&& command -v fzf >/dev/null 2>&1; then
		say "  Часовой пояс: начните печатать для поиска, ↑/↓ — выбор, Enter — подтвердить."
		__selected="$(
			{ printf '%s\n' "$__default"; timedatectl list-timezones 2>/dev/null; } \
				| awk 'NF && !seen[$0]++' \
				| fzf --height=45% --layout=reverse --border \
					--prompt='  Часовой пояс › ' --query="$__default"
		)" || true
	fi
	if [ -z "$__selected" ]; then
		ask_optional __selected "Часовой пояс сервера" "$__default"
	fi
	printf -v "$__var" '%s' "${__selected:-$__default}"
}

# Run a noisy command with a compact spinner while preserving its complete
# output in the installation log. In CI the spinner is suppressed.
run_with_progress() {
	local label="$1"; shift
	local log_file="${EVASELF_INSTALL_LOG:-/var/log/evaself-install.log}"
	mkdir -p "$(dirname "$log_file")"
	touch "$log_file"
	printf '\n[%s] %s\n' "$(date -Iseconds)" "$label" >>"$log_file"

	if [ ! -t 1 ]; then
		"$@" >>"$log_file" 2>&1
		return
	fi

	"$@" >>"$log_file" 2>&1 &
	local pid=$! frame=0
	local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
	while kill -0 "$pid" 2>/dev/null; do
		printf '\r  %s %s' "${frames[$frame]}" "$label"
		frame=$(((frame + 1) % ${#frames[@]}))
		sleep 0.15
	done
	local status=0
	wait "$pid" || status=$?
	if [ "$status" -eq 0 ]; then
		printf '\r  %s✔%s %s\n' "$C_GREEN" "$C_RESET" "$label"
		return 0
	fi
	printf '\r  %s✖%s %s\n' "$C_RED" "$C_RESET" "$label"
	tail -n 40 "$log_file" >&2 || true
	return "$status"
}

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
