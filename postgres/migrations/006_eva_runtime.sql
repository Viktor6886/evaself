-- =====================================================================
-- Evaself — runtime Telegram, user tools and background jobs
-- ---------------------------------------------------------------------
-- Stores state for the code-based Telegram and background runtime.
-- PostgreSQL remains the source of truth; the TypeScript runtime is
-- deliberately stateless apart from short-lived SDK sessions.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS telegram_updates (
    update_id          bigint PRIMARY KEY,
    user_id            bigint REFERENCES users (id) ON DELETE SET NULL,
    telegram_user_id   bigint,
    chat_id            bigint,
    message_id         bigint,
    message_kind       text,
    status             text NOT NULL DEFAULT 'processing',
    billable           boolean NOT NULL DEFAULT false,
    usage_charged      boolean NOT NULL DEFAULT false,
    error_code         text,
    error_message      text,
    received_at        timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT telegram_updates_status_check
        CHECK (status IN ('processing', 'completed', 'failed', 'ignored'))
);

CREATE INDEX IF NOT EXISTS telegram_updates_user_idx
    ON telegram_updates (user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS telegram_updates_status_idx
    ON telegram_updates (status, updated_at);

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id          bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    response_mode    text NOT NULL DEFAULT 'text',
    voice            text,
    character        text,
    agent_mode       text NOT NULL DEFAULT 'companion',
    use_emoji        boolean NOT NULL DEFAULT true,
    heartbeat_enabled boolean NOT NULL DEFAULT true,
    heartbeat_min_silence interval NOT NULL DEFAULT interval '6 hours',
    heartbeat_min_interval interval NOT NULL DEFAULT interval '12 hours',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_preferences_response_mode_check
        CHECK (response_mode IN ('text', 'voice', 'both')),
    CONSTRAINT user_preferences_agent_mode_check
        CHECK (agent_mode IN ('companion', 'coach', 'quiet'))
);

CREATE TABLE IF NOT EXISTS eva_notes (
    id          bigserial PRIMARY KEY,
    user_id     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title       text NOT NULL,
    content     text NOT NULL,
    category    text,
    tags        text[] NOT NULL DEFAULT ARRAY[]::text[],
    pinned      boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eva_notes_user_idx
    ON eva_notes (user_id, pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS eva_notes_search_idx
    ON eva_notes USING gin ((title || ' ' || content) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS budget_entries (
    id              bigserial PRIMARY KEY,
    user_id         bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    occurred_on     date NOT NULL DEFAULT CURRENT_DATE,
    entry_type      text NOT NULL DEFAULT 'expense',
    amount_minor    bigint NOT NULL,
    currency        text NOT NULL DEFAULT 'RUB',
    category        text,
    store           text,
    description     text,
    payment_method  text,
    quantity        numeric(12,3),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT budget_entries_type_check
        CHECK (entry_type IN ('income', 'expense')),
    CONSTRAINT budget_entries_amount_check CHECK (amount_minor >= 0)
);

CREATE INDEX IF NOT EXISTS budget_entries_user_date_idx
    ON budget_entries (user_id, occurred_on DESC, id DESC);

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS cron_expression text,
    ADD COLUMN IF NOT EXISTS repeat_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS timezone text,
    ADD COLUMN IF NOT EXISTS last_run_at timestamptz,
    ADD COLUMN IF NOT EXISTS next_run_at timestamptz,
    ADD COLUMN IF NOT EXISTS locked_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_error text;

CREATE INDEX IF NOT EXISTS tasks_runtime_due_idx
    ON tasks (COALESCE(next_run_at, remind_at, due_at))
    WHERE status IN ('open', 'in_progress');

CREATE TABLE IF NOT EXISTS heartbeat_state (
    user_id              bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    last_user_message_at timestamptz,
    last_sent_at         timestamptz,
    last_message_hash    text,
    last_result          text,
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_intents (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider              text NOT NULL DEFAULT 'lava',
    provider_contract_id  text,
    provider_product_id   text,
    plan                  text NOT NULL,
    duration_days         integer NOT NULL,
    amount_minor          bigint NOT NULL,
    currency              text NOT NULL DEFAULT 'RUB',
    email                 text,
    payment_url           text,
    status                text NOT NULL DEFAULT 'pending',
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payment_intents_status_check
        CHECK (status IN ('pending', 'succeeded', 'failed', 'expired', 'canceled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_contract_uidx
    ON payment_intents (provider, provider_contract_id)
    WHERE provider_contract_id IS NOT NULL;

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'telegram_updates',
        'user_preferences',
        'eva_notes',
        'budget_entries',
        'heartbeat_state',
        'payment_intents'
    ] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS %I ON %I',
            'trg_' || table_name || '_updated_at',
            table_name
        );
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
            'trg_' || table_name || '_updated_at',
            table_name
        );
    END LOOP;
END
$$;

INSERT INTO schema_migrations (version) VALUES ('006_eva_runtime')
ON CONFLICT (version) DO NOTHING;

COMMIT;
