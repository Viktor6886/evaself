#!/usr/bin/env bash
# Exercise reconcile_release_branch() against real throwaway repositories.
#
# The function moves a production checkout between branches, so the case
# that matters most is the one where it must NOT move: a branch carrying
# commits of its own.
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
		printf '  ok    %s -> %s\n' "$label" "$actual"
	else
		printf '  FAIL  %s -> ожидалось %s, получено %s\n' "$label" "$expected" "$actual"
		failures=$((failures + 1))
	fi
}

# origin with main ahead of a stale feature branch
git init -q --bare "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/seed" 2>/dev/null
git -C "$WORK/seed" config user.email ci@example.test
git -C "$WORK/seed" config user.name CI
echo one > "$WORK/seed/f"
git -C "$WORK/seed" add -A
git -C "$WORK/seed" commit -qm one
git -C "$WORK/seed" branch -M main
git -C "$WORK/seed" push -q origin main
# A real remote has HEAD -> main; without it every clone lands branchless.
git -C "$WORK/origin.git" symbolic-ref HEAD refs/heads/main
git -C "$WORK/seed" checkout -q -b stale
git -C "$WORK/seed" push -q origin stale
git -C "$WORK/seed" checkout -q main
echo two > "$WORK/seed/g"
git -C "$WORK/seed" add -A
git -C "$WORK/seed" commit -qm two
git -C "$WORK/seed" push -q origin main

fresh_clone() {
	rm -rf "$WORK/server"
	git clone -q "$WORK/origin.git" "$WORK/server"
	git -C "$WORK/server" config user.email ci@example.test
	git -C "$WORK/server" config user.name CI
}

# 1. already on the release branch — no-op
fresh_clone
check "уже на main" main "$(reconcile_release_branch "$WORK/server" main 2>/dev/null)"

# 2. parked on a stale branch that holds nothing of its own — switch
fresh_clone
git -C "$WORK/server" checkout -q stale
check "мёртвая ветка" main "$(reconcile_release_branch "$WORK/server" main 2>/dev/null)"

# 3. detached HEAD, as `make rollback` leaves it — switch
fresh_clone
git -C "$WORK/server" checkout -q --detach "origin/stale"
check "detached HEAD" main "$(reconcile_release_branch "$WORK/server" main 2>/dev/null)"

# 4. a branch with a commit of its own — must be left alone
fresh_clone
git -C "$WORK/server" checkout -q -b local-work
echo local > "$WORK/server/local.txt"
git -C "$WORK/server" add -A
git -C "$WORK/server" commit -qm "local change"
check "своя работа" local-work "$(reconcile_release_branch "$WORK/server" main 2>/dev/null)"
if ! git -C "$WORK/server" log --oneline -1 | grep -q "local change"; then
	printf '  FAIL  локальный коммит потерян\n'
	failures=$((failures + 1))
fi

[ "$failures" -eq 0 ] || { printf '::error::reconcile_release_branch: %s провал(ов)\n' "$failures"; exit 1; }
printf 'reconcile_release_branch: все сценарии прошли\n'
