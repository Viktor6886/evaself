#!/usr/bin/env bash
# =====================================================================
# Reclaim disk space.
#
# What this NEVER touches:
#   * any named volume (postgres, valkey, letta, caddy…)
#   * .env, backups inside the retention window, workflows, skills
#
# It removes dangling images, the build cache, stopped containers that
# belong to no service, over-age backups and truncated container logs.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_root
load_env

BEFORE="$(df -BM --output=avail / | tail -1 | tr -dc '0-9')"
step "Disk usage before"
df -h / | sed 's/^/  /'
echo
docker system df 2>/dev/null | sed 's/^/  /' || true

# ---------------------------------------------------------------------
step "Dangling images and build cache"
# ---------------------------------------------------------------------
# -a is deliberately NOT used: it would delete the pinned images of any
# service that happens to be stopped.
docker image prune -f >/dev/null 2>&1 && ok "dangling images removed"
docker builder prune -f >/dev/null 2>&1 && ok "build cache pruned"

# ---------------------------------------------------------------------
step "Stopped containers"
# ---------------------------------------------------------------------
ORPHANS="$(docker ps -aq --filter status=exited --filter status=created 2>/dev/null | wc -l)"
if [ "$ORPHANS" -gt 0 ]; then
	docker container prune -f >/dev/null 2>&1
	ok "removed $ORPHANS stopped container(s)"
else
	info "no stopped containers"
fi

# ---------------------------------------------------------------------
step "Container logs"
# ---------------------------------------------------------------------
TRUNCATED=0
while IFS= read -r logfile; do
	SIZE_MB=$(( $(stat -c %s "$logfile") / 1024 / 1024 ))
	if [ "$SIZE_MB" -gt 50 ]; then
		: > "$logfile"
		TRUNCATED=$((TRUNCATED + 1))
	fi
done < <(find /var/lib/docker/containers -name '*-json.log' 2>/dev/null)
[ "$TRUNCATED" -gt 0 ] && ok "truncated $TRUNCATED oversized log file(s)" || info "no oversized container logs"

# ---------------------------------------------------------------------
step "Old backups"
# ---------------------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-/var/backups/evaself}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
KEEP="$(find "$BACKUP_DIR" -maxdepth 1 \
	\( -name 'evaself-backup-*.tar.gz.enc' -o -name 'evaself-backup-*.tar.gz' \) \
	2>/dev/null | wc -l)"

if [ "$KEEP" -le 1 ]; then
	info "only $KEEP backup(s) present — keeping all of them"
else
	REMOVED=0
	while IFS= read -r old; do
		rm -f "$old"; REMOVED=$((REMOVED + 1))
	done < <(find "$BACKUP_DIR" -maxdepth 1 \
		\( -name 'evaself-backup-*.tar.gz.enc' -o -name 'evaself-backup-*.tar.gz' \) \
		-mtime "+${RETENTION}" 2>/dev/null)
	[ "$REMOVED" -gt 0 ] && ok "removed $REMOVED backup(s) older than ${RETENTION} days" || info "all backups are within retention"
fi

# ---------------------------------------------------------------------
step "APT cache"
# ---------------------------------------------------------------------
apt-get clean >/dev/null 2>&1 && ok "apt cache cleared"
journalctl --vacuum-time=14d >/dev/null 2>&1 && ok "journal trimmed to 14 days"

# ---------------------------------------------------------------------
AFTER="$(df -BM --output=avail / | tail -1 | tr -dc '0-9')"
step "Result"
df -h / | sed 's/^/  /'
FREED=$(( AFTER - BEFORE ))
if [ "$FREED" -gt 0 ]; then
	ok "freed ${FREED} MB"
else
	info "nothing significant to reclaim"
fi
say ""
say "  Data volumes were not touched. To remove one you must do it"
say "  explicitly with 'docker volume rm' — there is no make target for it."
