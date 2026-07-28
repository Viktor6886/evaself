# eva-agent-service

The only component in Evaself that talks to Letta, and it does so through
the official **`@letta-ai/letta-agent-sdk`** against a self-hosted **Letta
App Server**.

```
n8n ──HTTP + X-API-Key──> eva-agent-service ──@letta-ai/letta-agent-sdk──> ws://letta-app-server:4500/ws
```

n8n never reaches the App Server. Neither does the browser. That is the
point of this service.

## Why a service at all

The Agent SDK is a **Node** library (`engines: node >= 22.19`) that speaks
a WebSocket protocol. n8n cannot import it, and a browser cannot run it.
Something has to own it, keep sessions alive between turns, and expose a
plain HTTP surface — that is this.

It stays deliberately small. Quotas, subscriptions, onboarding, reminders
and routing all belong in n8n workflows.

## What it does with the SDK

| Requirement | SDK surface used |
|---|---|
| one agent per user | `client.createAgent({ name, persona, human, tags, model })` |
| find a user's agent again | `client.agents.list({ tags, matchAllTags })` |
| conversations / sessions | `client.createSession(agentId)`, `client.resumeSession(conversationId)` |
| memory | `persona` / `human` memory blocks + `memfs: true` (the App Server's git-backed memory filesystem) |
| skills | `skillSources` on the agent; `skills/` is mounted into the App Server |
| tools | `baseTools` / `allowedTools` on the agent |
| streaming | `session.stream()`, forwarded as SSE by `POST /v1/messages/stream` |
| message queues | `UserQueue` (Valkey lock + in-process FIFO) in front of every turn |
| recovery after a restart | `session.bootstrapState()` + `session.recoverPendingApprovals()` on the first turn after a resume |

## The mapping that matters

```
users.id  ->  agent_links.agent_id  ->  agent_links.conversation_id
```

Stored in PostgreSQL (`postgres/migrations/003_agent_sdk.sql`). Without the
conversation id, a restart would open a new thread and the person would
meet a stranger. With it, `resumeSession(conversationId)` picks the
conversation back up — after a restart, a restore, or a migration to
another VPS.

Agents are additionally tagged `evaself`, `eva-companion` and
`tg:<telegram_id>`, so `/v1/users/ensure` can find an existing agent in the
App Server even when the database was rebuilt — and will not create a
duplicate.

## Endpoints

```
GET    /health                                   service + App Server + DB + Valkey

POST   /v1/users/ensure                          user + agent + conversation, idempotent
GET    /v1/users/{telegramId}                    profile, plan, quotas
GET    /v1/agents                                the mapping, from PostgreSQL
GET    /v1/agents/live                           agents as the App Server sees them
GET    /v1/agents/{telegramId}
GET    /v1/conversations/{telegramId}            every conversation of that agent
POST   /v1/conversations/{telegramId}            start a new one, make it active
GET    /v1/conversations/{telegramId}/messages   history
POST   /v1/messages                              run a turn (locked per user)
POST   /v1/messages/stream                       same, as server-sent events
POST   /v1/locks/{telegramId}/release            clear a stuck turn lock
GET    /v1/models                                what the App Server offers
GET    /v1/stats                                 counters + open sessions
GET    /v1/quota/{telegramId}
```

Everything under `/v1` needs `X-API-Key: $EVA_AGENT_API_KEY`, compared in
constant time. Caddy 404s `/v1/*` on the public API host.

## Errors

```json
{"error": {"code": "app_server_unavailable", "message": "…", "retryable": true}}
```

| code | HTTP | retryable |
|---|---|---|
| `unauthorized` / `bad_request` / `not_found` | 401 / 400 / 404 | no |
| `user_busy` | 409 | yes (`details.retry_after_seconds`) |
| `app_server_unavailable` | 503 | yes |
| `database_unavailable` | 503 | yes |
| `turn_timeout` | 504 | yes |
| `turn_failed` | 502 | no |

Connection-shaped SDK failures (`ECONNREFUSED`, `websocket`, `socket hang
up`, …) become `app_server_unavailable`; timeouts become `turn_timeout`;
everything else is a non-retryable `turn_failed`.

## Serialising a user's messages

Letta runs one turn per conversation at a time; Telegram delivers bursts.
Two layers:

1. a Valkey lock keyed by Telegram ID (`SET NX EX`, released with a
   compare-and-delete script) so two service instances cannot run turns for
   the same person concurrently;
2. an in-process FIFO per user, so a burst that lands on one instance is
   processed **in order** rather than rejected — up to `maxQueueDepth`,
   after which the caller gets a retryable `409 user_busy`.

## Development

```bash
npm install
npm run typecheck
npm test          # builds, then runs the unit tests
npm run dev
```

The Docker build runs the typecheck and the tests in its build stage, so an
image that exists is an image whose tests passed.
