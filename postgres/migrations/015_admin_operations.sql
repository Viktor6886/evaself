-- =====================================================================
-- Административная панель: обзор, интеграции, AI и эксплуатация.
--
-- Снимки состояния отделены от HTTP-запроса Обзора. Секретные значения
-- по-прежнему хранятся только в secret_records; JSON-конфигурации могут
-- содержать лишь ссылки secret_ref.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS integration_configs (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    type        text NOT NULL,
    name        text NOT NULL,
    enabled     boolean NOT NULL DEFAULT false,
    config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    version     bigint NOT NULL DEFAULT 1,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid REFERENCES admin_users (id) ON DELETE SET NULL,
    CONSTRAINT integration_configs_type_check
        CHECK (type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
    CONSTRAINT integration_configs_name_check CHECK (btrim(name) <> ''),
    CONSTRAINT integration_configs_json_check CHECK (jsonb_typeof(config_json) = 'object'),
    CONSTRAINT integration_configs_version_check CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_configs_type_name_uidx
    ON integration_configs (type, lower(name));

CREATE TABLE IF NOT EXISTS provider_configs (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind               text NOT NULL,
    name               text NOT NULL,
    protocol           text NOT NULL,
    base_url           text NOT NULL,
    model_default      text,
    secret_ref         text REFERENCES secret_records (secret_ref),
    params_json        jsonb NOT NULL DEFAULT '{}'::jsonb,
    capabilities_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active          boolean NOT NULL DEFAULT false,
    enabled            boolean NOT NULL DEFAULT true,
    priority           integer NOT NULL DEFAULT 100,
    version            bigint NOT NULL DEFAULT 1,
    last_check_at      timestamptz,
    last_check_result_json jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    updated_by         uuid REFERENCES admin_users (id) ON DELETE SET NULL,
    CONSTRAINT provider_configs_kind_check
        CHECK (kind IN ('llm', 'embeddings', 'asr', 'tts', 'vision', 'image')),
    CONSTRAINT provider_configs_name_check CHECK (btrim(name) <> ''),
    CONSTRAINT provider_configs_protocol_check CHECK (btrim(protocol) <> ''),
    CONSTRAINT provider_configs_base_url_check CHECK (btrim(base_url) <> ''),
    CONSTRAINT provider_configs_params_check CHECK (jsonb_typeof(params_json) = 'object'),
    CONSTRAINT provider_configs_capabilities_check
        CHECK (jsonb_typeof(capabilities_json) = 'object'),
    CONSTRAINT provider_configs_priority_check CHECK (priority BETWEEN 0 AND 10000),
    CONSTRAINT provider_configs_version_check CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_configs_kind_name_uidx
    ON provider_configs (kind, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS provider_configs_one_active_kind_uidx
    ON provider_configs (kind)
    WHERE is_active;

CREATE TABLE IF NOT EXISTS provider_models (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id       uuid NOT NULL REFERENCES provider_configs (id) ON DELETE CASCADE,
    model_id          text NOT NULL,
    display_name      text NOT NULL,
    context_window    integer,
    capabilities_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    allowed_for_letta boolean NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT provider_models_id_check CHECK (btrim(model_id) <> ''),
    CONSTRAINT provider_models_name_check CHECK (btrim(display_name) <> ''),
    CONSTRAINT provider_models_context_check
        CHECK (context_window IS NULL OR context_window >= 1024),
    CONSTRAINT provider_models_capabilities_check
        CHECK (jsonb_typeof(capabilities_json) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_models_provider_model_uidx
    ON provider_models (provider_id, model_id);

CREATE TABLE IF NOT EXISTS provider_key_pools (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id uuid NOT NULL REFERENCES provider_configs (id) ON DELETE CASCADE,
    name        text NOT NULL,
    strategy    text NOT NULL DEFAULT 'priority',
    project_id  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT provider_key_pools_name_check CHECK (btrim(name) <> ''),
    CONSTRAINT provider_key_pools_strategy_check
        CHECK (strategy IN ('priority', 'round-robin'))
);

CREATE TABLE IF NOT EXISTS provider_keys (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    pool_id            uuid NOT NULL REFERENCES provider_key_pools (id) ON DELETE CASCADE,
    secret_ref         text NOT NULL REFERENCES secret_records (secret_ref),
    label              text NOT NULL,
    priority           integer NOT NULL DEFAULT 100,
    project_id         text,
    status             text NOT NULL DEFAULT 'active',
    added_at           timestamptz NOT NULL DEFAULT now(),
    last_success_at    timestamptz,
    last_error_at      timestamptz,
    success_count      bigint NOT NULL DEFAULT 0,
    consecutive_errors integer NOT NULL DEFAULT 0,
    cooldown_until     timestamptz,
    disabled_reason    text,
    CONSTRAINT provider_keys_label_check CHECK (btrim(label) <> ''),
    CONSTRAINT provider_keys_status_check
        CHECK (status IN ('active', 'cooldown', 'disabled')),
    CONSTRAINT provider_keys_priority_check CHECK (priority BETWEEN 0 AND 10000),
    CONSTRAINT provider_keys_counters_check
        CHECK (success_count >= 0 AND consecutive_errors >= 0)
);

CREATE TABLE IF NOT EXISTS health_checks (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    target_type         text NOT NULL,
    target_id           text NOT NULL,
    status              text NOT NULL DEFAULT 'pending',
    requested_by        uuid REFERENCES admin_users (id) ON DELETE SET NULL,
    requested_at        timestamptz NOT NULL DEFAULT now(),
    started_at          timestamptz,
    finished_at         timestamptz,
    ok                  boolean,
    duration_ms         integer,
    error_code          text,
    error_message_short text,
    detail_json         jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT health_checks_target_type_check
        CHECK (target_type IN ('service', 'integration', 'provider', 'infrastructure')),
    CONSTRAINT health_checks_status_check
        CHECK (status IN ('pending', 'checking', 'success', 'failure')),
    CONSTRAINT health_checks_duration_check
        CHECK (duration_ms IS NULL OR duration_ms >= 0),
    CONSTRAINT health_checks_detail_check CHECK (jsonb_typeof(detail_json) = 'object')
);

CREATE INDEX IF NOT EXISTS health_checks_pending_idx
    ON health_checks (status, requested_at);
CREATE INDEX IF NOT EXISTS health_checks_target_idx
    ON health_checks (target_type, target_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS service_statuses (
    target_id     text PRIMARY KEY,
    target_type   text NOT NULL,
    enabled       boolean NOT NULL DEFAULT true,
    configured    boolean NOT NULL DEFAULT true,
    state         text NOT NULL DEFAULT 'unknown',
    color         text NOT NULL DEFAULT 'yellow',
    operation     text,
    last_ok_at    timestamptz,
    last_check_at timestamptz,
    duration_ms   integer,
    detail_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT service_statuses_target_type_check
        CHECK (target_type IN ('service', 'integration', 'provider', 'infrastructure')),
    CONSTRAINT service_statuses_state_check
        CHECK (state IN ('unknown', 'checking', 'running', 'healthy', 'degraded',
                         'failed', 'stopped', 'disabled')),
    CONSTRAINT service_statuses_color_check
        CHECK (color IN ('gray', 'blue', 'red', 'yellow', 'green')),
    CONSTRAINT service_statuses_detail_check CHECK (jsonb_typeof(detail_json) = 'object')
);

CREATE INDEX IF NOT EXISTS service_statuses_type_idx
    ON service_statuses (target_type, target_id);

CREATE TABLE IF NOT EXISTS admin_operations (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind            text NOT NULL,
    status          text NOT NULL DEFAULT 'pending',
    target          text,
    requested_by    uuid REFERENCES admin_users (id) ON DELETE SET NULL,
    idempotency_key text,
    requested_at    timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    finished_at     timestamptz,
    result_json     jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_code      text,
    error_message   text,
    CONSTRAINT admin_operations_kind_check
        CHECK (kind IN ('restart', 'backup', 'restore', 'update-check',
                        'update', 'rollback', 'migration')),
    CONSTRAINT admin_operations_status_check
        CHECK (status IN ('pending', 'running', 'success', 'failure', 'rolled_back')),
    CONSTRAINT admin_operations_result_check CHECK (jsonb_typeof(result_json) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_operations_idempotency_uidx
    ON admin_operations (kind, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS admin_operations_status_idx
    ON admin_operations (status, requested_at);

CREATE TABLE IF NOT EXISTS backups (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    archive_id      text NOT NULL UNIQUE,
    path            text NOT NULL,
    size            bigint,
    created_at      timestamptz NOT NULL DEFAULT now(),
    verified_at     timestamptz,
    status          text NOT NULL DEFAULT 'creating',
    checksum        text,
    encrypted       boolean NOT NULL DEFAULT true,
    retention_until timestamptz,
    CONSTRAINT backups_status_check
        CHECK (status IN ('creating', 'ready', 'failed', 'restoring', 'deleted')),
    CONSTRAINT backups_size_check CHECK (size IS NULL OR size >= 0)
);

CREATE INDEX IF NOT EXISTS backups_created_idx ON backups (created_at DESC);

CREATE TABLE IF NOT EXISTS update_history (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    component    text NOT NULL,
    from_version text,
    to_version   text,
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    status       text NOT NULL DEFAULT 'running',
    rolled_back  boolean NOT NULL DEFAULT false,
    operation_id uuid REFERENCES admin_operations (id) ON DELETE SET NULL,
    CONSTRAINT update_history_status_check
        CHECK (status IN ('running', 'success', 'failure', 'rolled_back'))
);

INSERT INTO schema_migrations (version) VALUES ('015_admin_operations')
ON CONFLICT (version) DO NOTHING;

COMMIT;
