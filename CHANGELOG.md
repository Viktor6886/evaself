# Changelog

## Unreleased — Letta Agent SDK migration

Replaces the v0.1.0 agent layer. The old path was

    n8n -> Python Eva Core -> hand-written REST client -> letta/letta 0.16.8

and it is now

    n8n -> eva-agent-service (TypeScript) -> @letta-ai/letta-agent-sdk
        -> self-hosted Letta App Server -> MiMo

### Removed

* `eva-core/` — the whole Python service, including
  `eva-core/app/letta_client.py`, the hand-written REST client.
* `letta/` — notes for the `letta/letta` Python REST server, which the
  Agent SDK does not speak to.
* The five full Eva workflows. They are replaced by one minimal workflow
  that exercises the architecture; Eva's conversational logic, payments,
  subscriptions and the WebApp are the next milestone.

### Added

* **`eva-agent-service/`** — TypeScript, Node 22, Fastify. Owns
  `@letta-ai/letta-agent-sdk` and is the only component that talks to
  Letta. n8n and the browser both go through it.
* **`letta-app-server/`** — the self-hosted App Server as an internal
  Docker service (`letta server --listen ws://0.0.0.0:4500` with a
  capability token), state on a named volume.
* **Conversations.** `postgres/migrations/003_agent_sdk.sql` stores
  `user -> agent -> conversation`, adds `agent_conversations` and
  `v_agent_runtime`. Without the conversation id a restart would silently
  start a new thread.
* **Streaming**, `POST /v1/messages/stream` (SSE) on top of
  `session.stream()`.
* **Restart recovery** — `bootstrapState()` + `recoverPendingApprovals()`
  on the first turn after a session is resumed.
* **`make configure-letta`** — registers Eva's OpenAI-compatible endpoint
  with the App Server.
* **GitHub Actions CI** — static checks, TypeScript typecheck/tests, the
  migrations applied twice against a real PostgreSQL, media-service tests,
  every image built, and a stack smoke test that creates an agent through
  the SDK and asserts the mapping landed in PostgreSQL.

### Changed

* `letta-ui` is now an admin console for the App Server, reading through
  `eva-agent-service`. `letta-oss-ui` was checked and is not a published
  package; more fundamentally the App Server is WebSocket-only, so a
  browser cannot be its client.
* `make backup` captures the App Server state volume plus an
  agent/conversation inventory, instead of per-agent REST exports.
* **Fixed:** `pg_restore --no-owner` left restored objects owned by the
  superuser, so the service role got `permission denied for table users`.
  Ownership is now reassigned after every restore.

### Not done yet

No turn has completed through a model in this environment, and the stack
has never been started with `docker compose` — see
[docs/VERIFICATION.md](docs/VERIFICATION.md) for exactly what was run.

## v0.1.0 — 2026-07-28

First release. Everything below is new.

### Platform

* One-command install on clean Ubuntu 24.04:
  `git clone … && cd evaself && sudo make install`. Re-runnable: existing
  secrets are preserved, no volume is ever removed.
* 14 always-on services on the internal `evaself-network`, plus Crawl4AI
  and Uptime Kuma behind compose profiles. Only Caddy publishes ports.
* Seven host names, every one of them read from `.env`. No domain is
  hard-coded anywhere in the repository.
* All ten image tags pinned in `versions.env`; nothing uses `latest` or
  `stable`. Verified against upstream registries on 2026-07-28.

### Eva

* Telegram → n8n → Eva Core → Letta → LLM → back, with the business logic
  in n8n workflows and only the awkward parts in code.
* One Letta agent per Telegram user, tagged so it is recoverable from
  Letta alone if the database is ever rebuilt.
* Persistent memory: `persona` and `human` core blocks, pgvector archival
  memory, full message history — all surviving restarts and migrations.
* Per-user Valkey lock around each turn, because Letta documents that
  concurrent requests to one agent are undefined. A second in-flight
  message gets a retryable `409 user_busy`, not a corrupted history.
* One error shape for every failure, with a `retryable` flag the workflows
  act on.
* Voice: Telegram OGG/Opus → 16 kHz mono WAV → ASR, and TTS back as a real
  voice note. Charged against `voice_minutes` by measured duration.
* Telegram Mini App authenticated with signed `initData` (HMAC verified,
  24-hour expiry). The client never sends a user id the server trusts.

### Data

* Four databases with four roles: `eva`, `n8n`, `nocodb`, `letta`.
* The 13 specified tables plus four reporting views
  (`v_user_overview`, `v_quota_status`, `v_revenue_monthly`,
  `v_crisis_open`), and idempotent, self-recording migrations.
* NocoDB as a GUI over the `eva` database, with its own metadata database
  so a broken GUI cannot damage Eva's data.

### n8n

* Queue mode: one main, one worker, one external task runner sharing the
  worker's network namespace to work around
  [n8n-io/n8n#29742](https://github.com/n8n-io/n8n/issues/29742).
* Five importable workflows: Telegram main flow, notifications dispatcher
  (`FOR UPDATE SKIP LOCKED`), web search, nightly maintenance, crisis
  screen. Imported inactive on purpose.
* Custom n8n image with ffmpeg; the runner image is pinned to the same
  version and `make update` refuses to let them drift.

### Letta

* 0.16.8 against external PostgreSQL with pgvector, password-protected,
  never published.
* A **self-hosted console**, because Letta 0.16.x ships none: its server
  only redirects `/` to `/docs` and the official ADE is hosted at
  `app.letta.com`. Caddy injects the server password, so the API stays
  internal and the browser never holds a credential.

### Operations

* `make backup` — all four databases plus roles, four volumes, a portable
  JSON export per agent, n8n workflows and credentials with the encryption
  key, `.env`, Caddyfile, versions, skills, library, webapp, Hermes
  config, git commit, sha256 checksums. Daily via systemd timer.
* `make restore` — takes its own safety backup first, works on a brand-new
  server; `docs/MIGRATION.md` covers the DNS switch.
* `make update-preview` / `make update` / `make rollback` — backs up
  first, records a rollback point, verifies afterwards, rolls back by
  itself on failure. PostgreSQL majors are never crossed automatically.
* `make doctor` — containers, databases, schema, internal endpoints,
  public HTTPS, firewall, Fail2Ban, unpublished data ports, Hermes,
  backup age. Exits non-zero on anything critical.
* `make disk-cleanup` reclaims space and never touches a data volume.
  There is no target that can.

### Hermes

* Installed into Ubuntu, not Docker, as root with no sandbox — it manages
  Docker, systemd and packages, so hardening it would break it.
* The security boundary is a single-entry Telegram allowlist, written from
  `.env` during install, with a separate bot from Eva's.
* Left in `awaiting-configuration` with no LLM until
  `make configure-hermes`.

### Security

* UFW (keeping your existing SSH port), Fail2Ban, `.env` at mode 600,
  unpublished PostgreSQL and Valkey, invite-only admin panels, bcrypt
  basic auth on the Letta console, Telegram webhook `secret_token`.
* Backups are unencrypted by design and contain every secret;
  `docs/SECURITY.md` says so plainly, along with what is *not* solved.

### Known gaps

The stack was assembled in an environment where container registries are
blocked, so **it has never been started as a whole**. Every component was
verified by other means — see `docs/VERIFICATION.md`, which lists what was
executed, what was not, and the exact commands to close each gap on a real
server.
