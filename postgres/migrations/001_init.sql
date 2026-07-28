-- =====================================================================
-- Evaself — core schema for the `eva` database
-- ---------------------------------------------------------------------
-- Applied on first boot by postgres/init/00-init-databases.sh and, on
-- every later start, by scripts/db-migrate.sh. Every statement is
-- idempotent, so re-running an installation never destroys data.
--
-- PostgreSQL is the single source of truth. NocoDB is only a GUI on
-- top of these tables.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- shared helper: keep updated_at honest
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- 1. users
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
    id              bigserial PRIMARY KEY,
    telegram_id     bigint      NOT NULL UNIQUE,
    username        text,
    first_name      text,
    last_name       text,
    language_code   text        NOT NULL DEFAULT 'ru',
    timezone        text        NOT NULL DEFAULT 'UTC',
    -- onboarding -> active -> paused -> blocked
    state           text        NOT NULL DEFAULT 'onboarding',
    is_blocked      boolean     NOT NULL DEFAULT false,
    is_admin        boolean     NOT NULL DEFAULT false,
    consent_at      timestamptz,
    notes           text,
    meta            jsonb       NOT NULL DEFAULT '{}'::jsonb,
    last_seen_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_state_check
        CHECK (state IN ('onboarding', 'active', 'paused', 'blocked'))
);

CREATE INDEX IF NOT EXISTS users_state_idx      ON users (state);
CREATE INDEX IF NOT EXISTS users_last_seen_idx  ON users (last_seen_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS users_username_trgm  ON users USING gin (username gin_trgm_ops);

-- =====================================================================
-- 2. agent_links — one Letta agent per user (per kind)
-- =====================================================================
CREATE TABLE IF NOT EXISTS agent_links (
    id               bigserial PRIMARY KEY,
    user_id          bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- 'eva' is the companion agent; other kinds may be added later
    -- (e.g. 'partner_analysis') without touching this schema.
    kind             text        NOT NULL DEFAULT 'eva',
    agent_id         text        NOT NULL,
    agent_name       text,
    model            text,
    embedding_model  text,
    status           text        NOT NULL DEFAULT 'active',
    last_message_at  timestamptz,
    message_count    bigint      NOT NULL DEFAULT 0,
    meta             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_links_status_check
        CHECK (status IN ('active', 'archived', 'error'))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_links_user_kind_uidx
    ON agent_links (user_id, kind) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS agent_links_agent_id_uidx
    ON agent_links (agent_id);

-- =====================================================================
-- 3. subscriptions
-- =====================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
    id                      bigserial PRIMARY KEY,
    user_id                 bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    plan                    text        NOT NULL DEFAULT 'free',
    status                  text        NOT NULL DEFAULT 'active',
    provider                text,
    provider_subscription_id text,
    started_at              timestamptz NOT NULL DEFAULT now(),
    current_period_start    timestamptz NOT NULL DEFAULT now(),
    current_period_end      timestamptz,
    cancel_at               timestamptz,
    canceled_at             timestamptz,
    meta                    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT subscriptions_status_check
        CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'expired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_uidx
    ON subscriptions (user_id) WHERE status IN ('trialing', 'active', 'past_due');
CREATE INDEX IF NOT EXISTS subscriptions_period_end_idx
    ON subscriptions (current_period_end);

-- =====================================================================
-- 4. payments
-- =====================================================================
CREATE TABLE IF NOT EXISTS payments (
    id                  bigserial PRIMARY KEY,
    user_id             bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    subscription_id     bigint      REFERENCES subscriptions (id) ON DELETE SET NULL,
    provider            text        NOT NULL,
    provider_payment_id text,
    -- stored in minor units (kopeks/cents) to avoid float rounding
    amount_minor        bigint      NOT NULL,
    currency            text        NOT NULL DEFAULT 'RUB',
    status              text        NOT NULL DEFAULT 'pending',
    description         text,
    paid_at             timestamptz,
    raw                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payments_status_check
        CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'canceled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_id_uidx
    ON payments (provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_user_idx ON payments (user_id, created_at DESC);

-- =====================================================================
-- 5. quotas — limits per plan
-- =====================================================================
CREATE TABLE IF NOT EXISTS quotas (
    id           bigserial PRIMARY KEY,
    plan         text        NOT NULL,
    metric       text        NOT NULL,
    period       text        NOT NULL DEFAULT 'day',
    limit_value  bigint      NOT NULL,
    description  text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT quotas_period_check CHECK (period IN ('day', 'week', 'month', 'total')),
    CONSTRAINT quotas_limit_check  CHECK (limit_value >= -1)   -- -1 = unlimited
);

CREATE UNIQUE INDEX IF NOT EXISTS quotas_plan_metric_period_uidx
    ON quotas (plan, metric, period);

-- =====================================================================
-- 6. usage_counters — consumption per user and period
-- =====================================================================
CREATE TABLE IF NOT EXISTS usage_counters (
    id            bigserial PRIMARY KEY,
    user_id       bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    metric        text        NOT NULL,
    period        text        NOT NULL DEFAULT 'day',
    period_start  date        NOT NULL,
    used          bigint      NOT NULL DEFAULT 0,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT usage_counters_period_check CHECK (period IN ('day', 'week', 'month', 'total'))
);

CREATE UNIQUE INDEX IF NOT EXISTS usage_counters_uidx
    ON usage_counters (user_id, metric, period, period_start);

-- =====================================================================
-- 7. onboarding_fields — answers collected while getting to know a user
-- =====================================================================
CREATE TABLE IF NOT EXISTS onboarding_fields (
    id           bigserial PRIMARY KEY,
    user_id      bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    field_key    text        NOT NULL,
    field_value  text,
    field_json   jsonb,
    step         integer,
    answered_at  timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS onboarding_fields_uidx
    ON onboarding_fields (user_id, field_key);

-- =====================================================================
-- 8. test_results — psychological / self-discovery test outcomes
-- =====================================================================
CREATE TABLE IF NOT EXISTS test_results (
    id            bigserial PRIMARY KEY,
    user_id       bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    test_key      text        NOT NULL,
    test_version  text        NOT NULL DEFAULT '1',
    scores        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    raw_answers   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    summary       text,
    started_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS test_results_user_idx ON test_results (user_id, test_key, completed_at DESC);

-- =====================================================================
-- 9. tasks — user tasks and practices Eva tracks
-- =====================================================================
CREATE TABLE IF NOT EXISTS tasks (
    id            bigserial PRIMARY KEY,
    user_id       bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title         text        NOT NULL,
    description   text,
    status        text        NOT NULL DEFAULT 'open',
    priority      integer     NOT NULL DEFAULT 3,
    due_at        timestamptz,
    remind_at     timestamptz,
    completed_at  timestamptz,
    source        text        NOT NULL DEFAULT 'eva',
    meta          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tasks_status_check CHECK (status IN ('open', 'in_progress', 'done', 'canceled')),
    CONSTRAINT tasks_priority_check CHECK (priority BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS tasks_user_status_idx ON tasks (user_id, status, due_at);
CREATE INDEX IF NOT EXISTS tasks_remind_idx      ON tasks (remind_at) WHERE status <> 'done';

-- =====================================================================
-- 10. referrals
-- =====================================================================
CREATE TABLE IF NOT EXISTS referrals (
    id                bigserial PRIMARY KEY,
    referrer_user_id  bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    referred_user_id  bigint      REFERENCES users (id) ON DELETE SET NULL,
    code              text        NOT NULL,
    status            text        NOT NULL DEFAULT 'pending',
    reward_metric     text,
    reward_value      bigint,
    reward_granted_at timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT referrals_status_check CHECK (status IN ('pending', 'joined', 'rewarded', 'rejected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS referrals_code_uidx     ON referrals (code);
CREATE UNIQUE INDEX IF NOT EXISTS referrals_referred_uidx ON referrals (referred_user_id)
    WHERE referred_user_id IS NOT NULL;

-- =====================================================================
-- 11. partner_analysis_links — invite a partner into a joint analysis
-- =====================================================================
CREATE TABLE IF NOT EXISTS partner_analysis_links (
    id              bigserial PRIMARY KEY,
    owner_user_id   bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    partner_user_id bigint      REFERENCES users (id) ON DELETE SET NULL,
    token           text        NOT NULL,
    status          text        NOT NULL DEFAULT 'pending',
    result          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    expires_at      timestamptz,
    accepted_at     timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT partner_links_status_check
        CHECK (status IN ('pending', 'accepted', 'completed', 'expired', 'revoked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_analysis_links_token_uidx ON partner_analysis_links (token);
CREATE INDEX IF NOT EXISTS partner_analysis_links_owner_idx        ON partner_analysis_links (owner_user_id, status);

-- =====================================================================
-- 12. notifications — outbound messages scheduled by the TypeScript runtime
-- =====================================================================
CREATE TABLE IF NOT EXISTS notifications (
    id            bigserial PRIMARY KEY,
    user_id       bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind          text        NOT NULL,
    channel       text        NOT NULL DEFAULT 'telegram',
    payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    status        text        NOT NULL DEFAULT 'scheduled',
    scheduled_at  timestamptz NOT NULL DEFAULT now(),
    sent_at       timestamptz,
    attempts      integer     NOT NULL DEFAULT 0,
    error         text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notifications_status_check
        CHECK (status IN ('scheduled', 'sent', 'failed', 'canceled'))
);

CREATE INDEX IF NOT EXISTS notifications_due_idx
    ON notifications (scheduled_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

-- =====================================================================
-- 13. crisis_events — safety net for messages needing human attention
-- =====================================================================
CREATE TABLE IF NOT EXISTS crisis_events (
    id            bigserial PRIMARY KEY,
    user_id       bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    severity      text        NOT NULL DEFAULT 'low',
    detected_by   text        NOT NULL DEFAULT 'eva',
    trigger_text  text,
    response_text text,
    handled       boolean     NOT NULL DEFAULT false,
    handled_by    text,
    handled_at    timestamptz,
    notes         text,
    meta          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT crisis_events_severity_check CHECK (severity IN ('low', 'medium', 'high', 'critical'))
);

CREATE INDEX IF NOT EXISTS crisis_events_open_idx
    ON crisis_events (created_at DESC) WHERE handled = false;

-- =====================================================================
-- updated_at triggers
-- =====================================================================
DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'users', 'agent_links', 'subscriptions', 'payments', 'quotas',
        'onboarding_fields', 'tasks', 'referrals',
        'partner_analysis_links', 'notifications', 'crisis_events'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || t || '_updated_at', t);
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
            'trg_' || t || '_updated_at', t);
    END LOOP;
END
$$;

INSERT INTO schema_migrations (version) VALUES ('001_init')
ON CONFLICT (version) DO NOTHING;

COMMIT;
