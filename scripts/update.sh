#!/usr/bin/env bash
# =====================================================================
# Update the installation.
#
#   scripts/update.sh --preview   show what would change, touch nothing
#   scripts/update.sh             back up, update, verify, roll back on
#                                 failure
#   scripts/update.sh --force     run the whole cycle even when there is
#                                 nothing new to fetch
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
FORCE=0
case "${1:-}" in
	--preview) PREVIEW=1 ;;
	--force) FORCE=1 ;;
esac

load_env

ROLLBACK_DIR="$ROOT_DIR/.rollback"
DEPLOYED_MARKER="$ROLLBACK_DIR/deployed"
STASHED=0
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
GIT_AHEAD=0
DEFAULT_BRANCH="$(git -C "$ROOT_DIR" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

if git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
	# ---------------------------------------------------------------
	# 1. clear the working tree first — nothing below can check out a
	#    branch while local modifications are in the way.
	# ---------------------------------------------------------------
	DIRTY="$(git -C "$ROOT_DIR" status --porcelain | wc -l)"
	if [ "$DIRTY" -gt 0 ]; then
		# A dirty tree used to silently downgrade the update to "images
		# only". Stashing keeps `make update` a single command without
		# throwing anything away: `git stash pop` restores every change.
		warn "$DIRTY локальн(ых) изменени(й) в репозитории — они будут убраны в git stash"
		git -C "$ROOT_DIR" status --porcelain | sed 's/^/      /'
		if git -C "$ROOT_DIR" stash push --include-untracked \
			--message "evaself update $(date -Iseconds)" >/dev/null 2>&1; then
			STASHED=1
			ok "изменения сохранены в stash — вернуть: git -C $ROOT_DIR stash pop"
			DIRTY=0
		else
			warn "не удалось создать stash — обновление кода будет пропущено"
		fi
	fi

	# ---------------------------------------------------------------
	# 2. get back onto the branch releases actually land on.
	#
	#    An installation parked on a feature branch — or on the detached
	#    HEAD `make rollback` leaves behind — keeps reporting successful
	#    updates while quietly receiving nothing. Switching is automatic
	#    only when the current position holds nothing of its own, so the
	#    move cannot lose work.
	# ---------------------------------------------------------------
	if [ "$DIRTY" -eq 0 ]; then
		GIT_BRANCH="$(reconcile_release_branch "$ROOT_DIR" "$DEFAULT_BRANCH")"
		GIT_LOCAL="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo '-')"
	fi

	# ---------------------------------------------------------------
	# 3. how far behind the branch we are actually on
	# ---------------------------------------------------------------
	if [ "$GIT_BRANCH" != "HEAD" ] && [ "$GIT_BRANCH" != "-" ]; then
		git -C "$ROOT_DIR" fetch --quiet origin "$GIT_BRANCH" 2>/dev/null ||
			warn "could not reach the git remote"
		read -r GIT_BEHIND GIT_AHEAD < <(git_ahead_behind "$ROOT_DIR" "$GIT_BRANCH")
		info "branch $GIT_BRANCH at ${GIT_LOCAL:0:8}, ${GIT_BEHIND} commit(s) behind origin"

		[ "$GIT_AHEAD" -gt 0 ] &&
			info "и $GIT_AHEAD собственный(х) коммит(ов), которых нет на origin"

		# Ahead AND behind at once means the branch has diverged, and
		# `pull --ff-only` refuses. That used to be a warning in the middle
		# of a long run: the images were rebuilt from the old checkout and
		# the script still finished with a success message, so an update
		# could be run again and again and change nothing. Stop here
		# instead, before anything has been touched.
		#
		# Only ahead is fine — there is nothing to pull, so nothing breaks.
		if [ "$GIT_AHEAD" -gt 0 ] && [ "$GIT_BEHIND" -gt 0 ] &&
			[ "${EVASELF_ALLOW_DIVERGED:-0}" != "1" ]; then
			warn "ветка $GIT_BRANCH разошлась с origin: $GIT_AHEAD собственный(х) коммит(ов) здесь,"
			warn "$GIT_BEHIND на origin. Обновление кода в таком состоянии невозможно."
			say ""
			say "  Посмотреть, что именно локальное:"
			say "    git -C $ROOT_DIR log --oneline origin/${GIT_BRANCH}..HEAD"
			say ""
			say "  Сохранить локальные коммиты поверх origin:"
			say "    git -C $ROOT_DIR rebase origin/${GIT_BRANCH}"
			say ""
			say "  Или отказаться от них (сначала сделав резервную ветку):"
			say "    git -C $ROOT_DIR branch local-backup-\$(date +%F)"
			say "    git -C $ROOT_DIR reset --hard origin/${GIT_BRANCH}"
			say ""
			say "  Обновить только образы, оставив код как есть:"
			say "    EVASELF_ALLOW_DIVERGED=1 make update"
			die "обновление остановлено — ничего не изменено"
		fi
	else
		warn "репозиторий в detached HEAD и переключиться не удалось — обновятся только образы"
		GIT_BRANCH="-"
	fi
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

# "Nothing to fetch" is not the same as "what is running matches the
# checkout". Switching branches, or a checkout that was never applied,
# leaves new files on disk while the containers and the database stay on
# the old code — and the old check happily reported success.
DEPLOYED_COMMIT="$(cat "$DEPLOYED_MARKER" 2>/dev/null || true)"
CHECKOUT_APPLIED=0
[ -n "$DEPLOYED_COMMIT" ] && [ "$DEPLOYED_COMMIT" = "$GIT_LOCAL" ] && CHECKOUT_APPLIED=1

if [ "$UPDATES" -eq 0 ] && [ "$GIT_BEHIND" -eq 0 ] &&
	[ "$ADMIN_BOOTSTRAP_NEEDED" -eq 0 ] &&
	[ "$FORCE" -eq 0 ] && [ "$CHECKOUT_APPLIED" -eq 1 ]; then
	step "Already up to date"
	exit 0
fi

if [ "$CHECKOUT_APPLIED" -eq 0 ] && [ "$GIT_BEHIND" -eq 0 ] && [ "$UPDATES" -eq 0 ]; then
	if [ -n "$DEPLOYED_COMMIT" ]; then
		info "развёрнут ${DEPLOYED_COMMIT:0:8}, в рабочем дереве ${GIT_LOCAL:0:8} — применяю"
	else
		info "неизвестно, что именно развёрнуто — применяю текущее состояние целиком"
	fi
fi

if [ "$ADMIN_BOOTSTRAP_NEEDED" -eq 1 ]; then
	info "требуется завершить подготовку Secret Store административной панели"
fi

# =====================================================================
step "Backup before updating"
# =====================================================================
# The key has to exist BEFORE the backup: archives are encrypted with it,
# and backup.sh refuses to run without one. Creating it later meant the
# very first update of an installation that predates the Secret Store
# aborted on "the pre-update backup failed".
"$SCRIPT_DIR/ensure-admin-master-key.sh"
load_env
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
	echo "stashed_local_changes=$STASHED"
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
if [ "$GIT_AHEAD" -gt 0 ] && [ "$GIT_BEHIND" -gt 0 ]; then
	# Only reachable with EVASELF_ALLOW_DIVERGED=1 — the check above stops
	# the run otherwise. Say plainly that the code stays where it is.
	warn "ветка разошлась с origin: код оставлен на ${GIT_LOCAL:0:8}, обновляются только образы"
elif [ "$GIT_BEHIND" -gt 0 ] && [ "${DIRTY:-0}" -eq 0 ]; then
	# versions.env was just modified; stash it around the pull.
	cp "$VERSIONS_FILE" "$ROLLBACK_DIR/versions.env.new"
	git -C "$ROOT_DIR" checkout -- versions.env 2>/dev/null || true
	if git -C "$ROOT_DIR" pull --ff-only origin "$GIT_BRANCH" >/dev/null 2>&1; then
		ok "pulled $GIT_BEHIND commit(s)"
	else
		# Divergence is handled earlier, the remote answered during fetch,
		# and the tree was cleaned above — so whatever is left here is not
		# something to shrug at and build over. The old code would have
		# rebuilt the stale checkout and still reported success.
		cp "$ROLLBACK_DIR/versions.env.new" "$VERSIONS_FILE"
		git -C "$ROOT_DIR" status --short | head -20
		die "git pull не удался — обновление остановлено, ничего не пересобрано"
	fi
	cp "$ROLLBACK_DIR/versions.env.new" "$VERSIONS_FILE"
elif [ "$GIT_BEHIND" -eq 0 ]; then
	info "репозиторий уже актуален"
else
	warn "обновление кода пропущено: рабочее дерево не удалось очистить"
	warn "разберите изменения вручную и повторите make update"
fi

# =====================================================================
step "Pulling and rebuilding"
# =====================================================================
# Settings introduced by the commits just pulled — added before the
# containers are rebuilt so nothing starts with a missing value.
"$SCRIPT_DIR/ensure-env-defaults.sh"
load_env
# Crawl4AI перестал быть опциональным: профиля "crawl4ai" больше нет ни у
# одного сервиса, и оставшееся в .env значение только вводит в
# заблуждение. Убираем его до сборки, чтобы contain up -d поднял сервис
# в этом же запуске, а не в следующем.
CURRENT_PROFILES="$(get_env COMPOSE_PROFILES || true)"
case ",$CURRENT_PROFILES," in
	*,crawl4ai,*)
		CLEANED="$(printf '%s' "$CURRENT_PROFILES" | sed 's/crawl4ai//; s/,,/,/g; s/^,//; s/,$//')"
		set_env COMPOSE_PROFILES "$CLEANED"
		load_env
		ok "Crawl4AI больше не за профилем — устанавливается всегда"
		;;
esac

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
	# library/ is bind-mounted and not part of the service image. Recreate even
	# when only eva.md or letta_local_memfs.md changed, so the process rereads it.
	compose up -d --remove-orphans --force-recreate "${UPDATE_SERVICES[@]}" >/dev/null
else
	# See above: prompt/persona-only commits must restart the long-lived reader.
	compose up -d --remove-orphans --force-recreate >/dev/null
fi
ok "containers recreated"

# The single flat bridge was replaced by segmented networks; once every
# container has moved off it, the empty leftover is just clutter.
if docker network inspect evaself-network >/dev/null 2>&1; then
	if docker network rm evaself-network >/dev/null 2>&1; then
		ok "устаревшая сеть evaself-network удалена"
	else
		info "сеть evaself-network ещё используется — будет удалена позже"
	fi
fi

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
	mkdir -p "$ROLLBACK_DIR"
	git -C "$ROOT_DIR" rev-parse HEAD > "$DEPLOYED_MARKER" 2>/dev/null || true
	# Канонический набор — два файла в library/ — доводится до уже
	# созданных агентов фоновым проходом, а не рестартом. Раньше update
	# заканчивался до его окончания и сообщал полный успех, тогда как
	# часть агентов оставалась со старым текстом: расхождение всплывало
	# только в разговоре.
	if canonical_context_settled 120; then
		step "Update complete"
		say "  Rollback point kept in .rollback/ — 'make rollback' returns to it."
		exit 0
	fi
	step "Update finished, but the canonical context is not fully applied"
	say ""
	say "  Обычные ходы при этом идут: каждый устаревший агент получает"
	say "  канонический набор в своём же ходе. Состояние — 'make doctor'."
	say ""
	say "  Rollback point kept in .rollback/ — 'make rollback' returns to it."
	exit 1
fi

# =====================================================================
fail "post-update checks failed — rolling back automatically"
# =====================================================================
"$SCRIPT_DIR/rollback.sh" --automatic
die "the update was rolled back; the previous versions are running again"
