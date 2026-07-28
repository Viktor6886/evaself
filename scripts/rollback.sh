#!/usr/bin/env bash
# =====================================================================
# Return to the state recorded before the last `make update`.
#
# Restores versions.env, the git commit, and restarts the stack. Data is
# NOT touched: rolling an image back does not undo database migrations,
# so if a migration is the problem, restore the pre-update backup that
# .rollback/state points at.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

AUTOMATIC=0
[ "${1:-}" = "--automatic" ] && AUTOMATIC=1

load_env
ROLLBACK_DIR="$ROOT_DIR/.rollback"

[ -f "$ROLLBACK_DIR/state" ] || die "no rollback point recorded (.rollback/state is missing)"

# shellcheck disable=SC1091
. "$ROLLBACK_DIR/state"

step "Rollback point"
info "recorded:   ${recorded_at:-unknown}"
info "git commit: ${git_commit:-unknown}"
info "backup:     ${backup:-none}"

CURRENT_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo '-')"
echo
printf '  %-26s %-22s %s\n' "SERVICE" "NOW" "ROLLING BACK TO"
printf '  %s\n' "$(printf '%.0s-' {1..70})"
while IFS= read -r line; do
	key="${line%%=*}"
	old="${line#*=}"
	case "$key" in *_VERSION)
		now="$(get_env "$key" "$VERSIONS_FILE" || echo '-')"
		[ "$now" = "$old" ] || printf '  %-26s %-22s %s\n' "$key" "$now" "$old"
		;;
	esac
done < <(grep -E '^[A-Z0-9_]+_VERSION=' "$ROLLBACK_DIR/versions.env")
echo

if [ "$AUTOMATIC" -eq 0 ]; then
	confirm "Roll back to this point?" y || { say "  aborted"; exit 0; }
fi

# ---------------------------------------------------------------------
step "Restoring versions.env"
# ---------------------------------------------------------------------
cp "$VERSIONS_FILE" "$ROLLBACK_DIR/versions.env.failed"
cp "$ROLLBACK_DIR/versions.env" "$VERSIONS_FILE"
ok "pinned versions restored"

# ---------------------------------------------------------------------
step "Restoring the repository"
# ---------------------------------------------------------------------
if [ -n "${git_commit:-}" ] && [ "$git_commit" != "-" ] && [ "$git_commit" != "$CURRENT_COMMIT" ]; then
	if git -C "$ROOT_DIR" diff --quiet && git -C "$ROOT_DIR" diff --cached --quiet; then
		if git -C "$ROOT_DIR" checkout --quiet "$git_commit" 2>/dev/null; then
			ok "checked out ${git_commit:0:8} (detached HEAD)"
			info "return to the branch later with: git checkout ${git_branch:-main}"
		else
			warn "could not check out $git_commit"
		fi
	else
		warn "the working tree has local changes — the git checkout was skipped"
	fi
	# the checkout replaced versions.env with the committed copy
	cp "$ROLLBACK_DIR/versions.env" "$VERSIONS_FILE"
else
	info "repository already at the recorded commit"
fi

# ---------------------------------------------------------------------
step "Restarting with the previous versions"
# ---------------------------------------------------------------------
compose pull --ignore-buildable >/dev/null 2>&1 || true
compose build >/dev/null || warn "rebuild reported a problem"
compose up -d --remove-orphans >/dev/null
ok "containers recreated"

sleep 10
if "$SCRIPT_DIR/doctor.sh"; then
	step "Rollback complete"
else
	step "Rollback finished, but checks still fail"
	say ""
	say "  The images are back on the previous versions, so the problem is"
	say "  probably in the data rather than the code. Restore the pre-update"
	say "  backup:"
	say ""
	say "    make restore BACKUP=${backup:-<path>}"
	exit 1
fi
