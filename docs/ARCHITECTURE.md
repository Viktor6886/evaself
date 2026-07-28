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
            eva-agent-service                           (basic auth)

                    ═══ evaself-network (internal) ═══

   eva-agent-service ═SDK═► letta-app-server    n8n ──► Valkey (queue)
      │                          (WebSocket)     │
      └──► PostgreSQL ◄──────────────────────────┼─► n8n-worker ─► n8n-runner
                                                 ├─► eva-agent-service
   media-service   searxng   crawl4ai*         ├─► media-service
   backup-service  uptime-kuma*                └─► searxng

                              * optional compose profiles
```

Every container joins `evaself-network` and addresses the others by
container name, exactly as in `selfhost-ai`. PostgreSQL, Valkey, the Letta
App Server, eva-agent-service, SearXNG, the media service and the n8n
worker publish nothing.

## Message flow

```
Telegram update
  → n8n  webhook /webhook/eva-telegram
      1. verify X-Telegram-Bot-Api-Secret-Token
      2. normalise the update (text | voice, ids, language)
      3. POST eva-agent-service /v1/users/ensure
             → creates the user's Letta agent AND its conversation once
      4. SELECT … FROM v_quota_status       ── plan limits
      5. voice? → media-service /telegram/transcribe
      6. POST eva-agent-service /v1/messages
             → acquire Valkey lock for this Telegram ID
             → SDK: resumeSession(conversation_id)
             → SDK: session.send() + consume session.stream()
                   → App Server → LLM API
             → collapse assistant/reasoning/tool messages into one reply
             → release lock, bump usage counter
      7. build the reply (or a human sentence for a typed error)
      8. POST api.telegram.org/sendMessage
```

## Why the pieces are where they are

**Logic in n8n, not in code.** Quotas, subscriptions, onboarding,
reminders and routing change often and are better edited in a GUI than
deployed. n8n owns them.

**eva-agent-service exists because the SDK is a Node library.**
`@letta-ai/letta-agent-sdk` speaks a WebSocket protocol and needs
Node >= 22.19; n8n cannot import it and a browser cannot run it. On top of
that it does the four things n8n does badly: the read-check-create
sequence that must not produce two agents for one person; keeping sessions
alive between turns; an atomic per-user lock; and turning a dozen failure
modes into one shape.

**One Letta agent — and one conversation — per Telegram user.** Agents are
tagged `evaself`, `eva-companion` and `tg:<telegram_id>`, so a user's agent
can be found from the App Server alone even if the `eva` database is
rebuilt. The full mapping `user → agent → conversation` lives in
`agent_links`; the conversation id is what `resumeSession()` needs, and
without it a restart would silently start a new thread.

**The per-user lock is not optional.** Letta's own API documentation
states that concurrent requests to one agent produce undefined behaviour.
Telegram will happily deliver three messages in two seconds.
eva-agent-service takes `SET key token NX EX` in Valkey and releases it with a
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

**The App Server keeps its state on disk, not in PostgreSQL.** Agents,
conversations and the git-backed memory filesystem live in the
`evaself_letta_app_server_data` volume — that volume *is* the agent state,
and `make backup` captures it whole. pgvector is kept in the image because
the `eva` database uses it and an upgraded v0.1.0 installation still has a
`letta` database to dump.

## Data model

The `eva` database holds fourteen tables:

```
users                  one row per Telegram user
agent_links            user -> agent -> conversation (unique per kind)
agent_conversations    history of a user's conversations
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

plus five views NocoDB shows directly: `v_user_overview`,
`v_quota_status`, `v_revenue_monthly`, `v_crisis_open` and
`v_agent_runtime` (the agent/conversation mapping, worst-first for the ones
still missing a conversation).

Migrations are idempotent and record themselves in `schema_migrations`,
so `scripts/db-migrate.sh` is safe to run on every start.

## Authentication surfaces

| Surface | Who | How |
|---|---|---|
| `eva-agent-service /v1/*` | n8n, letta-ui | `X-API-Key: $EVA_AGENT_API_KEY`, 404'd at the edge |
| `letta-app-server:4500` | eva-agent-service only | capability token on the WebSocket upgrade |
| `letta.<domain>` | operator | Caddy basic auth (bcrypt hash in `.env`) |
| `admin.<domain>` | operator | NocoDB accounts, invite-only |
| `n8n.<domain>` | operator | n8n accounts, owner created on first visit |
| Hermes | owner only | single Telegram ID allowlist |

## Resource budget (4 vCPU / 8 GB)

| | idle | busy |
|---|---|---|
| PostgreSQL | ~250 MB | ~600 MB |
| n8n main + worker | ~500 MB | ~1.2 GB |
| Letta App Server | ~350 MB | ~900 MB |
| eva-agent-service / media / webapp / letta-ui | ~200 MB | ~400 MB |
| SearXNG | ~120 MB | ~250 MB |
| Caddy, Valkey, backup | ~120 MB | ~200 MB |
| **Crawl4AI (optional)** | ~200 MB | ~1.5 GB |

Which is why Crawl4AI is off by default, n8n is capped with
`--max-old-space-size=1024`, and the worker's concurrency defaults to 5.
