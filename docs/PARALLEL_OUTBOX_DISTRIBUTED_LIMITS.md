# Parallel outbox and distributed provider limits

Step 06 removes two process-local bottlenecks without introducing another queue,
provider registry, or breaker authority. Both new execution paths are disabled by
default and can be rolled back independently.

## Reused components

- `telegram_outbox` remains the only durable delivery queue. The migration adds a
  priority column and a claim index; it does not add a second queue.
- Valkey, already required by the application, holds short-lived Telegram token
  buckets and Router reservations. These are operational data and contain no
  message text, prompts, answers, Telegram tokens, or personal profile data.
- PostgreSQL `llm_route_providers` remains the ordered provider-chain registry for
  `fast`, `chat`, `deep`, `json`, and `research`. A chain can contain a
  primary and one or more fallbacks; no provider or credential is invented by the
  migration.
- PostgreSQL remains the canonical shared circuit breaker. Migration 034 adds
  model-scoped `llm_breaker_model_state`; the original provider-only
  `llm_breaker_state` remains a trigger-synchronized compatibility projection so
  old and new Router replicas may overlap during rolling deployment. Atomic
  half-open probes, automatic recovery, model switches, and `pinned_out` manual
  disable remain consistent in both directions.

## Telegram delivery

With `EVA_PARALLEL_OUTBOX=true`, workers claim a bounded batch with
`FOR UPDATE SKIP LOCKED` and deliver up to `EVA_OUTBOX_CONCURRENCY` records in
parallel. Claim order is stable by priority, availability time, and id:

1. crisis;
2. ready user answer;
3. command or payment;
4. reminder;
5. typing or service message.

An atomic Valkey script reserves both a global Telegram token and a per-chat token.
Telegram `retry_after` is accepted in seconds and HTTP-date form. A 429 establishes
a shared cooldown and defers the outbox record without rerunning the LLM or
consuming a delivery attempt.

## Router limits and failover

With `EVA_DISTRIBUTED_LIMITS=true`, a single Lua reservation checks inflight, RPM,
and TPM at provider, provider/model, and route dimensions. Provider/model caps
come from the provider profile; stable route-wide caps come from
`EVA_ROUTER_ROUTE_MAX_CONCURRENCY`, `EVA_ROUTER_ROUTE_MAX_RPM`, and
`EVA_ROUTER_ROUTE_MAX_TPM`, so a primary provider's cap cannot leak into a
fallback. A reservation has a TTL,
so a crashed process cannot hold capacity forever. Completion atomically settles
the token estimate to actual usage; pre-provider failure releases it.

Provider `Retry-After` is parsed as seconds or HTTP-date. A short delay is honored
with bounded jitter. If it exceeds `EVA_ROUTER_MAX_RETRY_AFTER_MS`, the Router moves
to the next configured provider and records a sanitized failover reason. The
existing breaker is updated only after a provider was actually called.

Failover requires at least two enabled, compatible entries in the route's existing
`llm_route_providers` chain. Operators must configure real provider credentials in
the admin API; this change deliberately does not create placeholder providers.

## Rollout

1. Apply migration 034 while both feature flags remain `false`.
2. Configure at least two providers for routes that require fallback and verify
   their credentials.
3. Enable `EVA_DISTRIBUTED_LIMITS=true` on all Router replicas and watch limiter,
   breaker, latency, and failover telemetry.
4. Enable `EVA_PARALLEL_OUTBOX=true` on a canary replica, start with concurrency 8,
   then expand only while Telegram 429 rate and outbox age remain healthy.

Important defaults are documented in `.env.example`: outbox batch/concurrency,
Telegram global and per-chat buckets, reservation TTL, maximum Retry-After wait,
and jitter.

## Rollback

Set `EVA_PARALLEL_OUTBOX=false` and `EVA_DISTRIBUTED_LIMITS=false`, then restart
`eva-agent-service` and `llm-router`. This immediately restores the sequential
outbox worker and process-local Router limits. Durable outbox rows and canonical
breaker/route state remain compatible.

Schema rollback is optional. Down migration 034 removes the concurrent claim
indexes, priority constraint, and schema-version marker. It intentionally retains
the additive `priority` column and the breaker compatibility layer: deleting
either would lose delivery/health state or break a still-running new Router
replica. Old Router versions continue to use the unchanged provider-only table.

## Verification

- Unit tests cover bounded concurrency, priority ordering, per-chat/global buckets,
  shared Router capacity, reservation expiry, both Retry-After formats, and
  short-wait versus fallback behavior.
- CI runs the real outbox claim against PostgreSQL and the real Lua scripts against
  Valkey, including cross-client contention and crash-TTL recovery.
- Both legacy paths remain covered because the feature flags default to `false`.
