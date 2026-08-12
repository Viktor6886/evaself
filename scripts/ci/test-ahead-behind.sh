#!/usr/bin/env bash
# Exercise git_ahead_behind() against real throwaway repositories.
#
# `make update` decides whether it can pull from these two numbers, and the
# two ranges are trivially easy to write the wrong way round — swapped, a
# diverged checkout reads as merely behind, `pull --ff-only` fails, and the
# run used to carry on and rebuild the stale code while reporting success.
# That is exactly how a production server sat two commits behind across
# several updates without saying anything.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
. "$SCRIPT_DIR/../lib.sh"

WORK="$(mktemp -d)"
# Уборка не решает исход проверки. `git` мог оставить в `.git` фоновую
# работу (`gc --auto`), и тогда `rm -rf` спотыкается о «Directory not
# empty» уже ПОСЛЕ того, как все сценарии прошли, — упавший каталог
# превращался в упавший CI на ровном месте.
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT
failures=0

check() {
	local label="$1" expected="$2" actual="$3"
	if [ "$expected" = "$actual" ]; then
		printf '  ok    %-22s -> behind/ahead = %s\n' "$label" "$actual"
	else
		printf '  FAIL  %-22s -> ожидалось "%s", получено "%s"\n' "$label" "$expected" "$actual"
		failures=$((failures + 1))
	fi
}

git init -q --bare "$WORK/origin.git"
# A real remote has HEAD -> main; without it every clone lands branchless.
git -C "$WORK/origin.git" symbolic-ref HEAD refs/heads/main

git clone -q "$WORK/origin.git" "$WORK/seed" 2>/dev/null
git -C "$WORK/seed" config user.email ci@example.test
git -C "$WORK/seed" config user.name CI
echo one > "$WORK/seed/f"
git -C "$WORK/seed" add -A
git -C "$WORK/seed" commit -qm one
git -C "$WORK/seed" branch -M main
git -C "$WORK/seed" push -q origin main

fresh_server() {
	rm -rf "$WORK/server"
	git clone -q "$WORK/origin.git" "$WORK/server"
	git -C "$WORK/server" config user.email server@example.test
	git -C "$WORK/server" config user.name Server
}

upstream_commit() {
	echo "$1" >> "$WORK/seed/f"
	git -C "$WORK/seed" commit -qam "$1"
	git -C "$WORK/seed" push -q origin main
}

server_commit() {
	echo "$1" > "$WORK/server/$1"
	git -C "$WORK/server" add -A
	git -C "$WORK/server" commit -qm "$1"
}

state() {
	git -C "$WORK/server" fetch -q origin main
	git_ahead_behind "$WORK/server" main
}

# 1. in sync
fresh_server
check "актуален" "0 0" "$(state)"

# 2. only behind — the ordinary update
fresh_server
upstream_commit upstream-a
upstream_commit upstream-b
check "позади origin" "2 0" "$(state)"
git -C "$WORK/server" pull -q --ff-only origin main
check "после pull" "0 0" "$(state)"

# 3. only ahead — nothing to pull, an update must not be blocked
fresh_server
server_commit local-only
check "впереди origin" "0 1" "$(state)"

# 4. diverged — this is the state that broke the production update
fresh_server
server_commit local-landing-page
upstream_commit upstream-c
upstream_commit upstream-d
check "разошлась" "2 1" "$(state)"
if git -C "$WORK/server" pull --ff-only origin main >/dev/null 2>&1; then
	printf '  FAIL  pull --ff-only прошёл на разошедшейся ветке\n'
	failures=$((failures + 1))
else
	printf '  ok    pull --ff-only отказывается, как и ожидалось\n'
fi

# 5. rebase is the recovery path the message suggests — it must leave the
#    branch pullable and keep the local commit.
git -C "$WORK/server" rebase -q origin/main
check "после rebase" "0 1" "$(state)"
if ! git -C "$WORK/server" log --oneline -1 | grep -q local-landing-page; then
	printf '  FAIL  локальный коммит потерян при rebase\n'
	failures=$((failures + 1))
fi

[ "$failures" -eq 0 ] || { printf '::error::git_ahead_behind: %s провал(ов)\n' "$failures"; exit 1; }
printf 'git_ahead_behind: все сценарии прошли\n'
