# Eva Core

The small internal service that sits between n8n and Letta. It is
deliberately thin: **business logic belongs in n8n**, and Eva Core only
does the things that are unreliable or awkward to express as workflow
nodes.

## What it does

| Responsibility | Why it is here and not in n8n |
|---|---|
| Speaks the current Letta REST API | One file to change on a Letta upgrade instead of dozens of HTTP nodes |
| Creates one Letta agent per Telegram user | Needs an atomic "look in Postgres → look in Letta → create → save link" sequence |
| Finds a user's agent | Same lookup, cached behind one call |
| Sends messages and normalises the reply | Letta returns reasoning / tool-call / assistant messages mixed together |
| Serialises messages per user | Letta explicitly warns that concurrent requests to one agent are undefined |
| Uniform error shape | Every failure becomes `{"error":{"code","message","retryable"}}` |
| `/health` | Reports Letta, PostgreSQL and Valkey in one probe |
| Telegram Mini App API | initData signature verification cannot be done safely in a workflow |

Everything else — subscriptions, payments, onboarding, reminders,
crisis routing, quotas enforcement — lives in n8n workflows.

## Authentication

Two separate surfaces:

* `/v1/*` — internal. Requires `X-API-Key: $EVA_CORE_API_KEY`. Only n8n
  calls these, and Caddy explicitly 404s `/v1/*` on the public API host.
* `/public/*` — used by the Telegram Mini App. Requires
  `X-Telegram-Init-Data` containing a launch payload signed by the Eva bot
  token. Signatures older than 24 h are rejected.
* `/health` — unauthenticated, used by Docker and `make doctor`.

## Endpoints

```
GET    /health

POST   /v1/users/ensure                  create/refresh user + their agent
GET    /v1/users/{telegram_id}           profile, plan and quota status
GET    /v1/agents/by-telegram/{id}       agent lookup
GET    /v1/agents                        inventory (used by make backup)
POST   /v1/messages                      one turn, under a per-user lock
GET    /v1/agents/{id}/memory            core memory blocks
PATCH  /v1/agents/{id}/memory            update one memory block
POST   /v1/agents/{id}/archival          append to archival memory
GET    /v1/agents/{id}/export            Letta agent export (backup)
GET    /v1/quota/{id}/{metric}           quota check for one metric
POST   /v1/locks/{id}/release            clear a stuck lock
GET    /v1/stats                         installation counters

POST   /public/session                   Mini App bootstrap
GET    /public/tasks                     the user's tasks
GET    /public/usage                     the user's quota status
```

## Errors

```json
{"error": {"code": "letta_timeout", "message": "…", "retryable": true}}
```

`retryable` tells the workflow whether a retry can help:

| code | HTTP | retryable |
|---|---|---|
| `unauthorized` | 401 | no |
| `bad_request` | 400 | no |
| `not_found` | 404 | no |
| `user_busy` | 409 | yes (`details.retry_after_seconds`) |
| `letta_bad_response` | 502 | no |
| `letta_unavailable` | 503 | yes |
| `database_unavailable` | 503 | yes |
| `letta_timeout` | 504 | yes |

## Per-user lock

`POST /v1/messages` takes a Valkey lock keyed by Telegram ID
(`SET key token NX EX <EVA_CORE_LOCK_TTL>`) and releases it with a
compare-and-delete Lua script, so a lock that has already expired and been
re-acquired by another worker is never deleted by the previous owner. A
second message that arrives while the first is in flight gets
`409 user_busy` with a retry hint rather than corrupting the agent's
message history.

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest        # unit tests, no services required
```

From the repository root, `make test` runs these together with the media
service tests.
