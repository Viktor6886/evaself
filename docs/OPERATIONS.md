# Operations

## Daily

```bash
make status      # containers
make doctor      # everything: health, DBs, HTTPS, firewall, backups
make logs s=n8n  # follow one service
```

`make doctor` exits non-zero when something is critical, so it works in a
cron job or as a Hermes command.

## Reading the logs

```bash
make logs                         # everything, last 200 lines, follow
make logs s=eva-agent-service
make logs s=letta
docker compose --env-file versions.env --env-file .env logs --since 30m n8n-worker
```

Useful greps:

```bash
make logs s=eva-agent-service | grep -i 'user_busy\|app_server_'
make logs s=caddy    | grep -i 'certificate\|error'
make logs s=n8n      | grep -i 'workflow\|error'
```

## Common situations

### Eva does not answer

```bash
make doctor
```

Then, in order:

1. **Webhook** — `scripts/telegram-webhook.sh status`. If
   `last_error_message` is set, Telegram is telling you exactly what is
   wrong. `pending_update_count` climbing means n8n is not accepting.
2. **Workflow inactive** — the most common cause after an install or
   restore. Open `https://n8n.<domain>` and activate
   *Eva — Telegram main*.
3. **LLM** — `make logs s=letta | grep -i 'api\|auth\|rate'`. An expired
   key or a hit rate limit shows up here first.
4. **Stuck lock** — if one user is stuck and everyone else is fine:

   ```bash
   curl -sX POST "http://localhost:8080/v1/locks/<telegram_id>/release" \
     -H "X-API-Key: $EVA_CORE_API_KEY"
   ```

### "Секунду — я ещё отвечаю на предыдущее сообщение"

Working as designed: a second message arrived while the first turn was
running. If it happens constantly, turns are too slow — check the LLM's
latency and consider lowering `max_steps` in the main workflow.

### Voice messages are refused politely

`MEDIA_ASR_BASE_URL` / `MEDIA_ASR_API_KEY` are empty. Fill them in `.env`
and `make restart`. Verify:

```bash
docker compose --env-file versions.env --env-file .env exec media-service \
  python -c "import urllib.request,json;print(json.load(urllib.request.urlopen('http://127.0.0.1:8090/health')))"
```

`asr_configured` must be `true`.

### n8n executions stay queued

The worker or the queue is down.

```bash
make logs s=n8n-worker
docker compose --env-file versions.env --env-file .env exec valkey \
  sh -c 'valkey-cli -a "$VALKEY_PASSWORD" ping'
```

### Code nodes fail with a task-runner error

The runner and n8n have drifted apart. They must be the same version:

```bash
grep -E 'N8N_VERSION|N8N_RUNNERS_VERSION' versions.env
```

`make update` keeps them in lockstep; if you edited `versions.env` by
hand, fix both and `make restart`.

### Certificates not renewing

```bash
make logs s=caddy | grep -i 'certificate\|acme\|error'
```

Port 80 must stay reachable — renewal uses it. Check the cloud firewall,
not only UFW.

### Disk filling up

```bash
make disk-cleanup
docker system df
du -sh /var/backups/evaself
```

`disk-cleanup` removes dangling images, the build cache, stopped
containers, oversized container logs, out-of-retention backups and the apt
cache. It never touches a data volume.

If executions are the problem, lower `EXECUTIONS_DATA_MAX_AGE` (hours) and
`EXECUTIONS_DATA_PRUNE_MAX_COUNT` in `.env`, then `make restart`.

### High memory

```bash
docker stats --no-stream
```

Usual suspects: Crawl4AI's Chromium (disable the profile), n8n worker
concurrency (`N8N_WORKER_CONCURRENCY`, default 5), and PostgreSQL's
`shared_buffers` if you tuned it up.

## Editing Eva

### Her persona

`library/persona/eva.md` is seeded into an agent's memory **at creation**.
Editing it does not rewrite existing agents — their memory is theirs.
To roll it out deliberately, see `library/README.md`.

### Her workflows

Edit in the n8n editor, then bring the change back into git:

```bash
make export-n8n
git diff n8n/workflows/
git add n8n/workflows && git commit -m "…"
```

### Her quotas

Quotas are rows, not code:

```bash
make shell-db
UPDATE quotas SET limit_value = 100 WHERE plan='free' AND metric='messages';
```

Or edit them in NocoDB. They take effect on the next message.

### Her skills

`skills/<name>/SKILL.md`, versioned in git, mounted read-only into Letta.
See `skills/README.md`.

## Users

```bash
make shell-db

-- overview
SELECT telegram_id, username, plan, subscription_status, message_count, last_seen_at
  FROM v_user_overview ORDER BY last_seen_at DESC NULLS LAST LIMIT 20;

-- today's consumption
SELECT * FROM v_quota_status WHERE telegram_id = 555000111;

-- block someone
UPDATE users SET is_blocked = true WHERE telegram_id = 555000111;

-- unhandled safety events
SELECT * FROM v_crisis_open;
```

The same data is editable in NocoDB, which is what it is there for.

## Restarting individual services

```bash
COMPOSE="docker compose --env-file versions.env --env-file .env"
$COMPOSE restart letta
$COMPOSE up -d --force-recreate eva-agent-service
```

Order matters only for PostgreSQL and Valkey; everything else reconnects.

## When something is badly wrong

```bash
make backup                 # first, always
make doctor                 # then read it properly
make logs s=<the suspect>
```

If a recent update is the suspect: `make rollback`. If the data is the
suspect: `make restore BACKUP=…`. Both paths are documented in
[UPDATING.md](UPDATING.md) and [BACKUP.md](BACKUP.md).
