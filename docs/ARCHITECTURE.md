# Architecture

## The shape of it

```
                          internet
                              │
                       ┌──────┴──────┐
                       │    Caddy    │  80 / 443 (tcp+udp)
                       │  auto HTTPS │  the only published ports
                       └──────┬──────┘
      ┌──────────┬────────────┼─────────────┬────────────┐
      │          │            │             │            │
  <domain>   app.<domain>  n8n.<domain>  admin.<domain> letta.<domain>
   webapp      webapp +       n8n          nocodb        letta-ui
              eva-core                                  (basic auth)
              /public

                    ═══ evaself-network (internal) ═══

   eva-core ──► letta ──► PostgreSQL          n8n ──► Valkey (queue)
      │           │            ▲               │
      └───────────┴────────────┘               ├─► n8n-worker ─► n8n-runner
                                               ├─► eva-core
   media-service   searxng   crawl4ai*         ├─► media-service
   backup-service  uptime-kuma*                └─► searxng

                              * optional compose profiles
```

Every container joins `evaself-network` and addresses the others by
container name, exactly as in `selfhost-ai`. PostgreSQL, Valkey, Letta,
Eva Core, SearXNG, the media service and the n8n worker publish nothing.

## Message flow

```
Telegram update
  → n8n  webhook /webhook/eva-telegram
      1. verify X-Telegram-Bot-Api-Secret-Token
      2. normalise the update (text | voice, ids, language)
      3. POST eva-core /v1/users/ensure     ── creates user + agent once
      4. SELECT … FROM v_quota_status       ── plan limits
      5. voice? → media-service /telegram/transcribe
      6. POST eva-core /v1/messages
             → acquire Valkey lock for this Telegram ID
             → POST letta /v1/agents/{id}/messages
                   → LLM API
             → normalise reasoning/tool/assistant messages
             → release lock, bump usage counter
      7. build the reply (or a human sentence for a typed error)
      8. POST api.telegram.org/sendMessage
```

## Why the pieces are where they are

**Logic in n8n, not in code.** Quotas, subscriptions, onboarding,
reminders and routing change often and are better edited in a GUI than
deployed. n8n owns them.

**Eva Core exists for four things n8n does badly.** Talking to a moving
API surface; the read-check-create sequence that must not produce two
agents for one person; a lock that must be atomic; and turning a dozen
failure modes into one shape. Everything else was deliberately left out.

**One Letta agent per Telegram user.** Agents are tagged `evaself`,
`eva-companion` and `tg:<telegram_id>`, so a user's agent can be found
from Letta alone even if the `eva` database is rebuilt from scratch. The
mapping is also stored in `agent_links` for fast lookups and reporting.

**The per-user lock is not optional.** Letta's own API documentation
states that concurrent requests to one agent produce undefined behaviour.
Telegram will happily deliver three messages in two seconds. Eva Core
takes `SET key token NX EX` in Valkey and releases it with a
compare-and-delete script, so an expired lock re-taken by another worker
is never deleted by the previous owner. The second message gets
`409 user_busy` with a retry hint.

**n8n in queue mode with a sidecar runner.** One main, one worker, one
external task runner. The runner shares the worker's network namespace
because n8n's task broker binds `127.0.0.1` and ignores
`N8N_RUNNERS_BROKER_LISTEN_ADDRESS` in queue mode
([n8n-io/n8n#29742](https://github.com/n8n-io/n8n/issues/29742)). Sharing
the namespace makes `127.0.0.1:5679` the same socket in both containers,
which works regardless of how that bug is resolved.

**Four databases, four roles.** `eva`, `n8n`, `nocodb`, `letta`. A
compromise of one service cannot read another's data, and each can be
dumped and restored independently.

**pgvector, not plain PostgreSQL.** Letta stores embeddings in `vector`
columns and will not start without the extension.

## Data model

The `eva` database holds thirteen tables:

```
users                  one row per Telegram user
agent_links            user  ->  Letta agent (unique per kind, active)
subscriptions          plan and period; one active per user
payments               minor units, provider-idempotent
quotas                 limits per plan/metric/period  (-1 = unlimited)
usage_counters         consumption per user/metric/period
onboarding_fields      answers collected while getting to know someone
test_results           self-discovery questionnaire outcomes
tasks                  what the user agreed to try
referrals              invitation chain and rewards
partner_analysis_links joint-analysis invitations
notifications          outbound queue, claimed with SKIP LOCKED
crisis_events          safety net, worst-first via v_crisis_open
```

plus four views NocoDB shows directly: `v_user_overview`,
`v_quota_status`, `v_revenue_monthly`, `v_crisis_open`.

Migrations are idempotent and record themselves in `schema_migrations`,
so `scripts/db-migrate.sh` is safe to run on every start.

## Authentication surfaces

| Surface | Who | How |
|---|---|---|
| `eva-core /v1/*` | n8n only | `X-API-Key: $EVA_CORE_API_KEY`, 404'd at the edge |
| `eva-core /public/*` | Mini App | Telegram `initData` HMAC, max 24 h old |
| `letta:8283` | eva-core, letta-ui | `Authorization: Bearer $LETTA_SERVER_PASSWORD` |
| `letta.<domain>` | operator | Caddy basic auth (bcrypt hash in `.env`) |
| `admin.<domain>` | operator | NocoDB accounts, invite-only |
| `n8n.<domain>` | operator | n8n accounts, owner created on first visit |
| Hermes | owner only | single Telegram ID allowlist |

## Resource budget (4 vCPU / 8 GB)

| | idle | busy |
|---|---|---|
| PostgreSQL | ~250 MB | ~600 MB |
| n8n main + worker | ~500 MB | ~1.2 GB |
| Letta | ~400 MB | ~900 MB |
| Eva Core / media / webapp / letta-ui | ~180 MB | ~350 MB |
| SearXNG | ~120 MB | ~250 MB |
| Caddy, Valkey, backup | ~120 MB | ~200 MB |
| **Crawl4AI (optional)** | ~200 MB | ~1.5 GB |

Which is why Crawl4AI is off by default, n8n is capped with
`--max-old-space-size=1024`, and the worker's concurrency defaults to 5.
