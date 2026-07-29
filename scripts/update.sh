#!/usr/bin/env bash
# =====================================================================
# Update the installation.
#
#   scripts/update.sh --preview   show what would change, touch nothing
#   scripts/update.sh             back up, update, verify, roll back on
#                                 failure
#
# What an update does NOT do:
#   * cross a PostgreSQL major version (needs a dump/restore — see
#     docs/UPDATING.md);
#   * remove any data volume, ever.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

PREVIEW=0
[ "${1:-}" = "--preview" ] && PREVIEW=1

load_env

ROLLBACK_DIR="$ROOT_DIR/.rollback"
REPORT="$(mktemp)"
trap 'rm -f "$REPORT"' EXIT

# A transition from a version that predates the admin Secret Store can pull
# this script while the old copy is already running. In that case the first
# run may stop after git pull because the old process never created the key.
# Treat a missing key as pending update work so a safe re-run completes it.
ADMIN_KEY_FILE="${EVA_SECRETS_MASTER_KEY_FILE:-$ROOT_DIR/secrets/eva-secrets-master-key}"
if [[ "$ADMIN_KEY_FILE" != /* ]]; then
	ADMIN_KEY_FILE="$ROOT_DIR/${ADMIN_KEY_FILE#./}"
fi
ADMIN_BOOTSTRAP_NEEDED=0
[ -s "$ADMIN_KEY_FILE" ] || ADMIN_BOOTSTRAP_NEEDED=1

# =====================================================================
step "Checking upstream versions"
# =====================================================================
if ! python3 "$SCRIPT_DIR/latest-versions.py" "$VERSIONS_FILE" > "$REPORT" 2>/dev/null; then
	die "could not query the registries — check outbound network access"
fi

UPDATES=0
BLOCKED=0
printf '\n  %-26s %-22s %-22s %s\n' "SERVICE" "CURRENT" "AVAILABLE" "STATUS"
printf '  %s\n' "$(printf '%.0s-' {1..84})"
while IFS=$'\t' read -r key current latest status; do
	case "$status" in
		update)       printf '  %-26s %-22s %-22s %s%s%s\n' "$key" "$current" "$latest" "$C_GREEN" "UPDATE" "$C_RESET"; UPDATES=$((UPDATES + 1)) ;;
		pinned-major) printf '  %-26s %-22s %-22s %s%s%s\n' "$key" "$current" "$latest" "$C_YELLOW" "MAJOR — manual" "$C_RESET"; BLOCKED=$((BLOCKED + 1)) ;;
		unknown)      printf '  %-26s %-22s %-22s %s\n' "$key" "$current" "-" "unknown" ;;
		*)            printf '  %-26s %-22s %-22s %s\n' "$key" "$current" "$latest" "up to date" ;;
	esac
done < "$REPORT"
echo

# =====================================================================
step "Repository"
# =====================================================================
GIT_LOCAL="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo '-')"
GIT_BRANCH="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '-')"
GIT_BEHIND=0
if [ "$GIT_BRANCH" = "HEAD" ]; then
	# `make rollback` leaves a detached HEAD. Fetching "origin HEAD" would
	# fail confusingly, so say what happened and skip the repository step.
	warn "репозиторий в состоянии detached HEAD (обычно после make rollback)"
	info "вернитесь на ветку, чтобы снова получать обновления кода:"
	info "  git -C $ROOT_DIR checkout main"
	info "обновление образов продолжится"
	GIT_BRANCH="-"
elif git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
	git -C "$ROOT_DIR" fetch --quiet origin "$GIT_BRANCH" 2>/dev/null || warn "could not reach the git remote"
	GIT_BEHIND="$(git -C "$ROOT_DIR" rev-list --count "HEAD..origin/${GIT_BRANCH}" 2>/dev/null || echo 0)"
	info "branch $GIT_BRANCH at ${GIT_LOCAL:0:8}, ${GIT_BEHIND} commit(s) behind origin"
	DIRTY="$(git -C "$ROOT_DIR" status --porcelain | wc -l)"
	[ "$DIRTY" -eq 0 ] || warn "$DIRTY uncommitted change(s) — 'git pull' will be skipped to protect them"
fi

# =====================================================================
if [ "$PREVIEW" -eq 1 ]; then
	step "Preview only — nothing was changed"
	say "  $UPDATES image update(s) available, $BLOCKED requiring manual action,"
	say "  $GIT_BEHIND repository commit(s) to pull."
	say ""
	say "  Apply with: make update"
	exit 0
fi
# =====================================================================

if [ "$UPDATES" -eq 0 ] && [ "$GIT_BEHIND" -eq 0 ] &&
	[ "$ADMIN_BOOTSTRAP_NEEDED" -eq 0 ]; then
	step "Already up to date"
	exit 0
fi

if [ "$ADMIN_BOOTSTRAP_NEEDED" -eq 1 ]; then
	info "требуется завершить подготовку Secret Store административной панели"
fi

# =====================================================================
step "Backup before updating"
# =====================================================================
"$SCRIPT_DIR/backup.sh" >/dev/null || die "the pre-update backup failed — update aborted"
LATEST_BACKUP="$(find "${BACKUP_DIR:-/var/backups/evaself}" -maxdepth 1 \
	\( -name 'evaself-backup-*.tar.gz.enc' -o -name 'evaself-backup-*.tar.gz' \) \
	-printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
ok "backup created: $(basename "$LATEST_BACKUP")"

# =====================================================================
step "Recording the rollback point"
# =====================================================================
mkdir -p "$ROLLBACK_DIR"
cp "$VERSIONS_FILE" "$ROLLBACK_DIR/versions.env"
cp "$ENV_FILE" "$ROLLBACK_DIR/.env"
chmod 600 "$ROLLBACK_DIR/.env"
{
	echo "git_commit=$GIT_LOCAL"
	echo "git_branch=$GIT_BRANCH"
	echo "backup=$LATEST_BACKUP"
	echo "recorded_at=$(date -Iseconds)"
} > "$ROLLBACK_DIR/state"
ok "rollback point saved in .rollback/"

# =====================================================================
step "Applying new versions"
# =====================================================================
while IFS=$'\t' read -r key current latest status; do
	[ "$status" = "update" ] || continue
	set_env "$key" "$latest" "$VERSIONS_FILE"
	ok "$key: $current -> $latest"
done < "$REPORT"

# =====================================================================
step "Updating the repository"
# =====================================================================
if [ "$GIT_BEHIND" -gt 0 ] && [ "${DIRTY:-0}" -eq 0 ]; then
	# versions.env was just modified; stash it around the pull.
	cp "$VERSIONS_FILE" "$ROLLBACK_DIR/versions.env.new"
	git -C "$ROOT_DIR" checkout -- versions.env 2>/dev/null || true
	if git -C "$ROOT_DIR" pull --ff-only origin "$GIT_BRANCH" >/dev/null 2>&1; then
		ok "pulled $GIT_BEHIND commit(s)"
	else
		warn "git pull failed — continuing with image updates only"
	fi
	cp "$ROLLBACK_DIR/versions.env.new" "$VERSIONS_FILE"
else
	info "repository not changed"
fi

# =====================================================================
step "Pulling and rebuilding"
# =====================================================================
"$SCRIPT_DIR/ensure-admin-master-key.sh"
load_env
compose pull --ignore-buildable >/dev/null 2>&1 || warn "some images could not be pulled"
compose build --pull >/dev/null || die "image build failed — nothing was restarted"
ok "images ready"

# Совместимые миграции применяются до запуска нового кода, если PostgreSQL
# уже работает. Повтор после recreate покрывает обновление остановленного стека.
if service_running postgres; then
	"$SCRIPT_DIR/db-migrate.sh" || die "миграции завершились ошибкой — сервисы не перезапущены"
fi

# =====================================================================
step "Restarting services"
# =====================================================================
if [ "${EVA_UPDATER_INVOCATION:-0}" = "1" ]; then
	# updater завершает операцию и только после записи результата атомарно
	# заменяет собственный контейнер через Docker API.
	mapfile -t UPDATE_SERVICES < <(
		compose config --services | grep -Ev '^(admin-api|eva-updater)$'
	)
	compose up -d --remove-orphans "${UPDATE_SERVICES[@]}" >/dev/null
else
	compose up -d --remove-orphans >/dev/null
fi
ok "containers recreated"
recreate_caddy || die "Caddy не запустился с обновлённой конфигурацией"
ok "Caddy пересоздан с актуальной конфигурацией"

"$SCRIPT_DIR/db-migrate.sh" || die "миграции завершились ошибкой после перезапуска сервисов"
"$SCRIPT_DIR/admin-finalize-env.sh" ||
	warn "не удалось завершить bootstrap административной панели"
"$SCRIPT_DIR/nocodb-connect.sh" ||
	die "таблицы Eva не синхронизировались с NocoDB"

# =====================================================================
step "Verifying"
# =====================================================================
sleep 10
if "$SCRIPT_DIR/doctor.sh"; then
	step "Update complete"
	say "  Rollback point kept in .rollback/ — 'make rollback' returns to it."
	exit 0
fi

# =====================================================================
fail "post-update checks failed — rolling back automatically"
# =====================================================================
"$SCRIPT_DIR/rollback.sh" --automatic
die "the update was rolled back; the previous versions are running again"
