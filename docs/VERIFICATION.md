# Verification status

What has actually been executed, and what has not. Read this before
trusting anything in this repository on a server that matters.

## The constraint

This work was done in an environment whose egress policy blocks
container-registry blob storage — `production.cloudfront.docker.com`,
`pkg-containers.githubusercontent.com` and `quay.io` all answer 403 to the
proxy. Image manifests resolve; layers cannot be downloaded.
`hermes-agent.nousresearch.com` and `docs.letta.com` are blocked as well.

So **no Docker image was pulled or built, and the assembled stack has
never been started with `docker compose`.** What *was* possible, and what
was done, is to run the same components natively: the Letta App Server
from its npm package, `eva-agent-service` from its own source, against a
real PostgreSQL and a real Valkey-protocol server.

Everything below is either something genuinely run, or something that was
not — stated as such.

## Verified by execution

### The Agent SDK really drives a real App Server

This is the core claim of this milestone, and it was tested end to end
against live processes, not mocks.

* `@letta-ai/letta-agent-sdk@0.5.2` was installed from npm (published
  2026-07-28; it depends on `@letta-ai/letta-code@0.29.8`, requires
  Node >= 22.19).
* A real App Server was started:
  `letta --backend local server --listen ws://127.0.0.1:4500`, which
  printed `Listening on ws://127.0.0.1:4500` and accepted TCP connections.
* `eva-agent-service` was run against it with
  `new LettaAgentClient({ backend: "remote", url, authToken })` and
  reported healthy:

  ```json
  {"service":"eva-agent-service","version":"0.2.0","status":"ok",
   "runtime":"letta-agent-sdk",
   "checks":{"app_server":{"ok":true,"models":314},
             "postgres":{"ok":true},"valkey":{"ok":true}}}
  ```

  314 models listed through `client.models.list()` — the WebSocket
  protocol works, not just the socket.

### Per-user agents and conversations

* `POST /v1/users/ensure` created a real agent and a real conversation
  through the SDK:
  `agent-local-aad65b96-…` / `local-conv-2`.
* Called again for the same user: `agent_created: false`,
  `conversation_created: false`, same ids — idempotent.
* A second user got a **different** agent and conversation
  (`agent-local-c298077f-…` / `local-conv-4`).
* The mapping is in PostgreSQL, readable through the new view:

  ```
  700001 -> agent-local-aad65b96-… -> local-conv-5 [letta-app-server]
  700002 -> agent-local-c298077f-… -> local-conv-4 [letta-app-server]
  ```

* `POST /v1/conversations/{id}` opened a new conversation and made it
  active; `GET /v1/conversations/{id}` then listed all three of that
  agent's conversations with the active one marked.

### Recovery after a restart

Both the App Server and `eva-agent-service` were killed and started again
from scratch. Afterwards:

* the existing user resolved to the **same agent and the same
  conversation** (`agent_created: false`, `conversation_created: false`) —
  which is the whole point of storing `conversation_id`;
* a new user created after the restart got a fresh agent and conversation;
* `GET /v1/agents/live` reported 3 agents from the App Server, matching
  what the SDK had created before the restart.

### Locking and error mapping

* A lock held in Valkey produced
  `409 {"code":"user_busy","retryable":true,"details":{"retry_after_seconds":40}}`.
* `POST /v1/locks/{id}/release` cleared it and messaging resumed.
* An unknown user produced `404 not_found` with a message naming the fix.
* Missing and wrong `X-API-Key` both produced `401 unauthorized`.
* A turn attempted with no model provider configured surfaced as
  `turn_failed` (non-retryable) carrying the App Server's own
  `llm_error` — the mapping behaved exactly as designed on a real failure.

### Unit tests

24 tests pass (`node --test`), covering the SDK stream collapse
(assistant / reasoning / tool-call separation, multi-part content,
result-only fallback, empty stream), the error mapping (connection-shaped
→ retryable `app_server_unavailable`, timeouts → `turn_timeout`, anything
else → `turn_failed`), and the queue: FIFO ordering within one user,
independence across users, depth limit → `user_busy`, lock released on
throw, foreign-token release is a no-op.

TypeScript compiles clean (`tsc --noEmit`) against the SDK's own type
definitions — which is itself a check that the SDK is being used correctly
rather than via `any`.

### PostgreSQL migration 003

Applied against a real PostgreSQL 16 + pgvector:

* `agent_links` gained `conversation_id`, `runtime`, `app_server_url`;
* `agent_conversations` created; `v_agent_runtime` created;
  `v_user_overview` rebuilt with the conversation columns;
* applied twice with `ON_ERROR_STOP=1` — idempotent;
* one real bug was caught and fixed this way: `CREATE OR REPLACE VIEW`
  cannot insert a column into the middle of an existing view, so the view
  is now dropped and rebuilt.

### A real backup bug, found and fixed

Restoring with `pg_restore --no-owner` leaves every object owned by the
restoring superuser, and the service role then gets
`permission denied for table users`. This was hit for real during testing.
`backup-service` now reassigns ownership to the per-database service role
after every restore (`fix-ownership`), and exposes it as a command.

### Static checks

`make validate` is green: `bash -n` and `shellcheck -S error` on all 22
scripts plus the backup helper; `docker compose config` renders 15 default
services; `caddy validate` passes on all three Caddyfiles with the real
Caddy 2.11.4; the workflow JSON is structurally valid; all three
migrations are transactional and self-recording; `.env` is untracked and
no bot token or private key appears in a tracked file.

## NOT verified

| | Why | Risk |
|---|---|---|
| `docker compose up` — the stack as a whole | registry blobs blocked | **high**: every image here is unbuilt |
| Any image build (`eva-agent-service`, `letta-app-server`, …) | same | **high** |
| The App Server *in a container* (it ran natively) | same | medium |
| n8n calling `eva-agent-service` | needs the n8n image | medium |
| Importing the minimal workflow into a live n8n | same | medium — the JSON is structurally valid, node `typeVersion`s are unconfirmed against 2.33.0 |
| A completed turn through a model | needs a MiMo key; `letta connect` validates against `api.letta.com`, which is blocked here | **high** — see below |
| Telegram → … → Telegram | needs a bot token and a public URL | high |
| `make backup` / `restore` on the new topology | needs the running stack | medium — the dump/restore core and the ownership fix were exercised directly |
| `make update` / `rollback` | needs images | medium |
| Hermes on a real install | its installer host is blocked | medium-high |
| Making the repository private | no tool available in this session (the GitHub MCP surface here is read/PR only) | — |

### The one to be clearest about

**No turn has ever completed through a model.** The path
`eva-agent-service → SDK → App Server` is proven; the leg
`App Server → MiMo` is not, because it needs a real MiMo key *and*
`letta connect openai-compatible` performs its validation against
`api.letta.com`, which this environment blocks. On a server with normal
egress this is one command (`make configure-letta`), and the failure mode
if it does not work is loud and specific: turns return `turn_failed` while
agents, conversations and memory keep working.

## What to run on a real server

```bash
sudo make install
make configure-letta            # register MiMo; must print models
make doctor                     # must be clean, incl. the SDK->App Server check
scripts/telegram-webhook.sh set
# activate "Eva — architecture E2E test" in the n8n editor, then from Telegram:
#   send a message            -> Eva answers
#   send another immediately  -> "секунду, я ещё отвечаю"
make shell-db -c 'SELECT * FROM v_agent_runtime'   # every row has a conversation
make backup
make restore BACKUP=…           # on a scratch server, not this one
make update-preview
make hermes-status              # confirm the allowlist, then message from a
                                # second Telegram account and be ignored
```

If any of that behaves differently from what this document claims, the
document is wrong and should be corrected — that is what it is for.
