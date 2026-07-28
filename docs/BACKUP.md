# Backup and restore

```bash
make backup
make restore BACKUP=/var/backups/evaself/evaself-backup-2026-07-28-03-40.tar.gz
```

## What is in an archive

```
evaself-backup-YYYY-MM-DD-HH-MM.tar.gz
├── MANIFEST                 versions, git commit, host, domain, timestamp
├── CHECKSUMS                sha256 of every file, verified on restore
├── postgres/
│   ├── globals.sql          roles and their passwords
│   ├── eva.dump             users, subscriptions, payments, quotas, tasks…
│   ├── n8n.dump             workflows, executions, encrypted credentials
│   ├── nocodb.dump          NocoDB metadata, views, bases
│   ├── letta.dump           agents, memory, messages, tools
│   └── server-version.txt
├── volumes/
│   ├── letta_data.tar.gz    Letta's on-disk state
│   ├── n8n_data.tar.gz      ~/.n8n, including the settings file
│   ├── nocodb_data.tar.gz
│   └── caddy_data.tar.gz    issued certificates (saves a re-issue)
├── letta/
│   ├── agents.json          the agent inventory
│   └── agent-<telegram_id>.json   one portable export per agent
├── n8n/
│   ├── workflows/*.json
│   ├── credentials.json     encrypted
│   └── encryption-key.env   N8N_ENCRYPTION_KEY — without it the above is useless
├── config/
│   ├── .env                 every secret of the installation
│   ├── Caddyfile
│   ├── versions.env
│   ├── compose.yaml
│   ├── hermes.tar.gz        ~/.hermes (token, allowlist, config, state)
│   └── evaself-hermes.service
└── content/
    ├── skills.tar.gz
    ├── library.tar.gz       persona, prompts, test definitions
    └── webapp.tar.gz
```

Two independent copies of the agent state are kept on purpose: the raw
`letta.dump` + volume (exact, but tied to this Letta version) and the
per-agent JSON exports (portable, and restorable one agent at a time).

## Not encrypted — and what that means

As specified, the archive is not encrypted. It contains `.env`, so it
contains every password, the LLM API key, both bot tokens and
`N8N_ENCRYPTION_KEY`.

* Written to `/var/backups/evaself` with mode 600 inside a 700 directory.
* Never commit it, never put it in object storage without encrypting it
  first, never attach it to a support ticket.
* To copy it somewhere else, encrypt in transit and at rest:

  ```bash
  gpg --symmetric --cipher-algo AES256 evaself-backup-….tar.gz
  scp evaself-backup-….tar.gz.gpg elsewhere:/secure/
  ```

## Automatic daily backups

`evaself-backup.timer` fires at 03:40 local time with up to 10 minutes of
jitter, 25 minutes after the n8n nightly maintenance workflow, so the dump
captures a tidied database. `Persistent=true` means a server that was off
at 03:40 backs up shortly after boot instead of skipping the day.

```bash
systemctl list-timers evaself-backup.timer
systemctl start evaself-backup.service     # on demand
journalctl -u evaself-backup -n 50
```

Retention is `BACKUP_RETENTION_DAYS` (default 14). Rotation only runs
after the new archive has been verified with `tar tzf`.

## What a restore guarantees

After `make restore` on a fresh server these are all intact:

| | restored from |
|---|---|
| users, subscriptions, payments, quotas | `eva.dump` |
| tasks, tests, onboarding answers, referrals | `eva.dump` |
| crisis events and their handling state | `eva.dump` |
| Letta agents, memory blocks, archival, messages | `letta.dump` + volume |
| the user → agent mapping | `eva.dump` (`agent_links`) |
| n8n workflows | `n8n.dump` + the export |
| n8n credentials | `n8n.dump` + `N8N_ENCRYPTION_KEY` |
| NocoDB bases, views, users | `nocodb.dump` + volume |
| domains, secrets, model settings | `config/.env` |
| Eva's persona, skills, tests | `content/*` |
| Hermes token, allowlist, configuration | `config/hermes.tar.gz` |
| HTTPS certificates | `caddy_data.tar.gz` |

What is **not** in a backup, because it is not data: the Docker images
(re-pulled from `versions.env`), and the Hermes binary (`make
update-hermes` reinstalls it).

## How a restore proceeds

1. Verifies the archive and its checksums.
2. Takes a safety backup of the current state (unless there is nothing to
   save), so a mistaken restore is itself reversible.
3. Restores `.env`, `versions.env`, `Caddyfile` — keeping the previous
   `.env` as `.env.before-restore`.
4. Restores `skills/`, `library/`, `webapp/`.
5. Stops the application containers, leaving PostgreSQL up.
6. Wipes and refills each Docker volume.
7. Restores globals and all four databases through the version-matched
   helper container.
8. Starts everything, applies migrations.
9. Imports n8n credentials and workflows.
10. Restores `~/.hermes` and the Hermes unit, without starting it.
11. Runs `make doctor`.

## Testing a restore

Test it before you need it. On a scratch server:

```bash
git clone https://github.com/viktor6886/evaself.git && cd evaself
sudo make install          # any domain; certificates will fail, that's fine
make restore BACKUP=/tmp/evaself-backup-….tar.gz
make doctor
```

Then check that user and agent counts match the source:

```bash
make shell-db
select count(*) from users;
select count(*) from agent_links where status='active';
```

## Restoring one agent

The per-agent exports are plain JSON and can be pushed back individually:

```bash
jq . agent-555000111.json | head
curl -sX POST "http://localhost:8283/v1/agents/import" \
  -H "Authorization: Bearer $LETTA_SERVER_PASSWORD" \
  -H 'Content-Type: application/json' \
  --data-binary @agent-555000111.json
```

Afterwards update `agent_links.agent_id` for that user, because the import
creates a new agent id.
