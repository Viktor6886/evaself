# Updating

```bash
make update-preview     # what would change; nothing is touched
make update             # backup, apply, verify, auto-rollback on failure
make rollback           # go back to the previous versions
```

## Version pinning

Every image tag lives in `versions.env`. Nothing in the stack uses
`latest` or `stable`, so two installs from the same commit are identical
and a rollback is exact.

```
POSTGRES_VERSION=0.8.5-pg17
VALKEY_VERSION=9.1.1-alpine
CADDY_VERSION=2.11.4-alpine
N8N_VERSION=2.33.0
N8N_RUNNERS_VERSION=2.33.0
LETTA_VERSION=0.16.8
NOCODB_VERSION=2026.07.0
SEARXNG_VERSION=2026.7.26-b060c780d
CRAWL4AI_VERSION=0.9.2
UPTIME_KUMA_VERSION=2.4.0
```

## `make update-preview`

Queries the registries and prints a table. It never writes anything.

```
  SERVICE                CURRENT         AVAILABLE       STATUS
  ------------------------------------------------------------------
  POSTGRES_VERSION       0.8.5-pg17      0.8.5-pg17      up to date
  N8N_VERSION            2.31.7          2.33.0          UPDATE
  LETTA_VERSION          0.16.5          0.16.8          UPDATE
```

Only release-shaped tags are considered — anything containing
`latest`, `stable`, `next`, `beta`, `nightly`, `dev`, `rc`, `alpha`,
`pre` or an architecture suffix is ignored, and the tag's flavour is
preserved (`-alpine` stays `-alpine`, `pg17` stays `pg17`).

## `make update`

1. **Backup.** If it fails, the update stops before anything changes.
2. **Rollback point.** `versions.env`, `.env`, the git commit and the path
   of the backup are written to `.rollback/`.
3. **New versions** written into `versions.env`; the task runner is pinned
   to whatever n8n resolved to.
4. **`git pull --ff-only`**, skipped if the working tree is dirty so local
   edits are never discarded.
5. **Pull and rebuild** images. A build failure aborts before any restart.
6. **`docker compose up -d`.**
7. **Migrations** (idempotent).
8. **`make doctor`.** On failure `scripts/rollback.sh --automatic` runs
   and the previous versions come back by themselves.

## PostgreSQL majors are never crossed automatically

A major upgrade rewrites the on-disk format; starting PostgreSQL 18 on a
17 data directory simply refuses. `make update-preview` reports it as
`MAJOR — manual` and leaves the pin alone.

To do it deliberately:

```bash
make backup                                # do not skip this
docker compose --env-file versions.env --env-file .env stop
docker volume rm evaself_postgres_data     # the point of no return
sed -i 's/^POSTGRES_VERSION=.*/POSTGRES_VERSION=0.8.5-pg18/' versions.env
sed -i 's/^POSTGRES_MAJOR=.*/POSTGRES_MAJOR=18/' versions.env
make start                                 # creates an empty pg18 cluster
make restore BACKUP=/var/backups/evaself/evaself-backup-….tar.gz
make doctor
```

`pg_restore` reads dumps from older majors, which is why the backup is
taken as a custom-format dump rather than a file copy.

## `make rollback`

Restores `versions.env`, checks out the recorded commit (only when the
tree is clean), rebuilds and restarts, then runs `make doctor`.

Rollback moves **code**, not **data**. A migration that already ran stays
run. If doctor still fails after a rollback, the problem is in the data
and the answer is the pre-update backup:

```bash
make restore BACKUP=$(grep '^backup=' .rollback/state | cut -d= -f2)
```

## Updating on a schedule

Do not. An unattended `make update` can restart the stack while someone is
mid-conversation. Run it when you can watch the output. What *is*
automated is the daily backup, which is the part you would regret missing.

If you want a reminder rather than an action, the nightly maintenance
workflow already messages the owner; add an `update-preview` step to it
and let it report, not act.

## Updating Hermes

Hermes is not in Docker and has its own updater:

```bash
make update-hermes
```

It stops the service, snapshots `~/.hermes` into `/var/backups/evaself`,
re-runs the official installer, and starts the service again only if it
was running before.

## After any update

```bash
make doctor
make logs s=n8n
```

Send one real message through Telegram. Automated checks confirm processes
are alive; only a real turn confirms Eva still answers with memory intact.
