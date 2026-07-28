# n8n

n8n is where Eva's business logic lives. Eva Core only does the parts that
are unsafe or unreliable to express as nodes (see `eva-core/README.md`).

## Topology

| Process | Container | Role |
|---|---|---|
| main | `evaself-n8n` | editor, webhooks, scheduler; internal task runner |
| worker | `evaself-n8n-worker` | executes queued workflows |
| task runner | `evaself-n8n-runner` | external runner for the worker's Code nodes |

Queue mode uses Valkey (`EXECUTIONS_MODE=queue`). Both n8n processes run
the locally built `evaself/n8n` image, which adds ffmpeg and curl.

### Why the runner shares the worker's network namespace

n8n's task broker binds `127.0.0.1` and ignores
`N8N_RUNNERS_BROKER_LISTEN_ADDRESS` in queue mode
([n8n-io/n8n#29742](https://github.com/n8n-io/n8n/issues/29742)). Putting
the runner in `network_mode: service:n8n-worker` makes `127.0.0.1:5679`
mean the same socket in both containers, which is robust regardless of how
that bug is eventually fixed.

`N8N_RUNNERS_IMAGE`/`N8N_RUNNERS_VERSION` must match `N8N_VERSION` — the
launcher and broker speak a versioned protocol. `versions.env` keeps them
in lockstep and `scripts/update.sh` refuses to break the pairing.

## Configuration without credentials

Internal service addresses and secrets reach the workflows as environment
variables and are read with `$env.…`:

```
EVA_CORE_URL, EVA_CORE_API_KEY, LETTA_URL, LETTA_SERVER_PASSWORD,
MEDIA_SERVICE_URL, SEARXNG_URL, CRAWL4AI_URL, CRAWL4AI_API_TOKEN,
EVA_TELEGRAM_BOT_TOKEN, EVA_TELEGRAM_WEBHOOK_SECRET, OWNER_TELEGRAM_ID
```

Only PostgreSQL needs a real n8n credential. `scripts/n8n-import.sh`
generates it from `.env` into a temporary file, imports it under the fixed
id `evaself-postgres`, and deletes the file. **No secret is ever committed
to this repository.**

## Shipped workflows

| File | What it does |
|---|---|
| `01-eva-telegram-main.json` | webhook → secret check → normalise → ensure user+agent → quota → voice/text → Eva Core → reply |
| `02-eva-notifications.json` | every 5 min, claims due `notifications` with `FOR UPDATE SKIP LOCKED` and sends them |
| `03-eva-web-search.json` | sub-workflow: SearXNG search, optionally cleaned through Crawl4AI |
| `04-eva-daily-maintenance.json` | nightly: expire subscriptions, housekeeping, health check, digest to the owner |
| `05-eva-crisis-check.json` | sub-workflow: keyword safety screen, records `crisis_events`, alerts the owner |

They are imported **inactive**. Open the editor, check the two Telegram
workflows, and activate them yourself — activating a Telegram webhook is a
decision, not an installation side effect.

## Telegram webhook

```bash
scripts/telegram-webhook.sh set      # registers the webhook + secret_token
scripts/telegram-webhook.sh status   # what Telegram thinks the webhook is
scripts/telegram-webhook.sh delete
```

The webhook URL is `https://{DOMAIN_N8N}/webhook/eva-telegram` and carries
`X-Telegram-Bot-Api-Secret-Token`, which the first node of the main
workflow verifies against `EVA_TELEGRAM_WEBHOOK_SECRET`.

## Import / export

```bash
make import-n8n    # repo -> running n8n (workflows + the postgres credential)
make export-n8n    # running n8n -> repo, so edits made in the UI are committable
```

`make backup` also exports workflows and credentials into the archive, and
stores `N8N_ENCRYPTION_KEY` — without that key the credentials in a backup
cannot be decrypted on a new server.
