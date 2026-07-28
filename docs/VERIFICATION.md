# Verification status

What has actually been executed, and what has not. Read this before
trusting anything in this repository on a server that matters.

## The constraint

Evaself v0.1.0 was built in an environment whose egress policy blocks
container-registry blob storage — `production.cloudfront.docker.com`,
`pkg-containers.githubusercontent.com` and `quay.io` all answer 403 to the
proxy. Image manifests resolve; layers cannot be downloaded.

So **no Docker image was ever pulled, and the assembled stack has never
been started as a whole.** Everything below is either something that was
genuinely run, or something that was not — stated as such.

## Verified by execution

### PostgreSQL schema — real server

`postgres/init/00-init-databases.sh` and both migrations were run against
a real PostgreSQL 16 server with pgvector.

* four roles and four databases created; `vector`, `pg_trgm` and
  `uuid-ossp` installed;
* all 13 specified tables plus `schema_migrations` created, and the four
  reporting views;
* migrations re-applied a second time with `ON_ERROR_STOP=1`: no errors,
  no duplicated seed rows (`quotas` stayed at 12);
* seeded a test user and checked the views return correct data —
  `v_quota_status` reported `plus / messages / limit 200 / used 17 /
  remaining 183`, `v_revenue_monthly` aggregated a payment to 499.00 RUB,
  `v_crisis_open` surfaced the open event;
* the `updated_at` trigger fires on UPDATE.

### Backup and restore — real dumps

`backup-service/backup-service` was run directly against that server.

* `dump-all` produced `globals.sql` and dumps for `eva`, `n8n`, `nocodb`
  and `letta`;
* every row was deleted from `users`;
* `restore-all` brought back 5 users, 5 agent links and 12 quota rows.

The *container* the helper normally runs in was never built, so the
version-matched `pg_dump` claim rests on the Dockerfile deriving from the
same base image as the database, not on an observed run.

### Eva Core — run for real

Started against real PostgreSQL, real Valkey (redis protocol) and a
stand-in Letta built from the response schemas of the released
`letta 0.16.8` package.

* `/health` reported all three dependencies healthy;
* missing and wrong `X-API-Key` → 401, both surfaces;
* `POST /v1/users/ensure` created a user row and a Letta agent; a second
  call returned `agent_created: false` and the same agent id;
* two different Telegram ids produced two distinct agents;
* `POST /v1/messages` returned the assistant text with reasoning and
  usage separated, and incremented `usage_counters`;
* with a lock held in Valkey, the next message returned
  `409 user_busy` with `retry_after_seconds`; `POST
  /v1/locks/{id}/release` cleared it and messaging resumed;
* memory blocks read back as `persona` and `human`, and a `PATCH`
  persisted;
* `GET /v1/quota/{id}/messages` → `used 2, limit 30, remaining 28`;
* a valid Mini App `initData` authenticated; a tampered one and a missing
  header both returned 401;
* `/public/bot` degrades to `{"username": null}` when Telegram is
  unreachable, instead of failing the landing page.

23 unit tests pass (initData signing/expiry/forgery, response
normalisation, model-handle qualification, lock semantics including
foreign-token release and release-on-exception).

### Media service — real ffmpeg

11 tests pass, generating actual audio rather than mocking:

* a 3-second OGG/Opus file (what Telegram sends) is probed correctly —
  codec `opus`, 1 channel, duration within tolerance;
* converted to WAV: `pcm_s16le`, 16 kHz, mono, duration preserved;
* re-encoded to a Telegram voice note: `opus`, mono, duration preserved;
* non-media files raise on both probe and convert;
* the API returns `503 asr_not_configured` / `503 tts_not_configured`
  rather than failing obscurely, and leaves no workspace behind.

### Letta 0.16.8 API surface — read from the released package

Not guessed. Extracted from the installed distribution:

* `CheckPasswordMiddleware` accepts `Authorization: Bearer <password>` or
  `X-BARE-PASSWORD`, and exempts `/v1/health/`;
* route paths and shapes for agents, messages, core memory, archival,
  export/import, tools and providers;
* `CreateAgent` fields (`memory_blocks`, `tags`, `model` as
  `provider/model`, `context_window_limit`);
* `LettaResponse` = `messages[] + stop_reason + usage`, with content
  either a string or a list of parts;
* the send-message docstring's own warning that concurrent requests to one
  agent are undefined — which is why the lock exists.

**And the finding that mattered:** `letta/server/rest_api/static_files.py`
contains exactly one route, redirecting `/` to `/docs`, and the server
prints `View using ADE at: https://app.letta.com/…`. Letta 0.16.x ships no
self-hosted GUI, so Evaself ships its own.

### Letta console and WebApp — served and driven in a browser

Both internal Caddy configurations were run for real, and the console was
driven in headless Chromium against the Letta stand-in.

* `/healthz` returns `ok`; static assets and the SPA fallback serve;
* `/api/*` proxying works and **injects the server password** — the same
  request straight to Letta without it returns 401;
* the console rendered the server version, health state and the agent
  list; clicking an agent opened the overview; the memory tab rendered
  both blocks as editable textareas; the messages tab rendered a
  conversation. **No JavaScript errors** in any of those.
* The landing page and the Mini App render; outside Telegram the Mini App
  shows its "open this from Telegram" message instead of breaking.

### Update machinery — against live registries

`scripts/latest-versions.py` and `make update-preview` were run against
Docker Hub.

* all ten pinned versions confirmed current as of 2026-07-28;
* with deliberately stale pins, `2.31.7 → 2.33.0` and `0.16.5 → 0.16.8`
  were detected;
* the PostgreSQL major guard was exercised in both tag styles:
  `0.8.5-pg17 → 0.8.5-pg18` and `17.9-trixie → 18.4-trixie` are reported
  as `pinned-major` and never applied.

### Configuration wizard — driven through a pty

`scripts/configure.sh` was run end to end.

* sub-domains are proposed from the main domain and accepted with Enter;
* domain, e-mail and bot-token formats are validated, with re-prompting;
* 14 secrets generated (48 hex chars each, admin passwords 20);
* `.env` written mode 600; the only empty values left are the ones that
  are meant to be empty (`EVA_EMBEDDING_BASE_URL`, `MEDIA_ASR_*`,
  `MEDIA_TTS_*`);
* re-running preserves existing secrets rather than rotating them.

### Static validation — all green

`make validate`:

* `bash -n` on all 21 scripts and the backup helper;
* `shellcheck -S error` on all 21 scripts;
* `docker compose config` renders 14 default services;
* `caddy validate` on all three Caddyfiles with the real Caddy 2.11.4;
* all five workflows: valid JSON, no duplicate node names or ids, no
  dangling connections, no unreachable nodes, a trigger present;
* both migrations transactional and self-recording;
* `.env` untracked, no bot tokens or private keys in tracked files.

## NOT verified

These are written and reviewed, but never executed:

| | Why | Risk |
|---|---|---|
| `sudo make install` end to end | needs a clean Ubuntu host and image pulls | medium — the steps are individually standard, the sequence is not proven |
| The full stack running together | registries blocked | medium |
| Caddy issuing real certificates | needs public DNS and port 80 | low — config validates, the pattern is ordinary |
| n8n queue mode with the sidecar runner | needs images | **medium-high** — see below |
| Importing the workflows into a live n8n | needs a running n8n | medium — JSON is structurally valid, node `typeVersion`s are not confirmed against 2.33.0 |
| Letta with external PostgreSQL + pgvector | needs the image | low-medium — `LETTA_PG_URI` is the documented variable |
| NocoDB against its own metadata DB | needs the image | low |
| SearXNG returning JSON | needs the image | low |
| Hermes installation | `hermes-agent.nousresearch.com` is blocked here | **medium-high** — see below |
| A real Telegram round trip | needs a bot token and a public URL | medium |
| `make update` / `make rollback` applying changes | needs images | medium — preview and version logic are proven |
| `make restore` on a fresh server | needs a second host | medium — its dump/restore core is proven |

### The two to watch

**The n8n task runner.** The runner shares the worker's network namespace
to work around [n8n-io/n8n#29742](https://github.com/n8n-io/n8n/issues/29742),
where the task broker ignores `N8N_RUNNERS_BROKER_LISTEN_ADDRESS` and
binds `127.0.0.1`. That is a sound workaround, but it is untested here.
If Code nodes fail on first boot, check `make logs s=n8n-runner` first.

**Hermes configuration keys.** The installer host is blocked from this
environment, so `scripts/install-hermes.sh` writes the token and allowlist
into both `~/.hermes/.env` and `~/.hermes/config.yaml`, and additionally
tries `hermes config set`. The environment-variable names come from the
community documentation for v0.2.0, not from a running binary. **Verify
with `make hermes-status` and by messaging the bot from a second Telegram
account — it must be ignored** before you trust the allowlist.

## What to do on a real server

```bash
sudo make install
make doctor                       # must be clean
scripts/telegram-webhook.sh set
# activate the Telegram workflows in the n8n editor
# then, from Telegram:
#   send a text message      -> Eva answers
#   send it again immediately-> "секунду, я ещё отвечаю"
#   send a voice message     -> transcribed, or politely refused
make backup
make restore BACKUP=…             # on a scratch server, not this one
make update-preview
make hermes-status                # confirm the allowlist
```

If any of that behaves differently from what this document claims, the
document is wrong and should be corrected — that is what it is for.
