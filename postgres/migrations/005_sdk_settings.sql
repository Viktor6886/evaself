-- =====================================================================
-- Настройки официального Letta Agent SDK для административной консоли.
--
-- URL и capability token App Server намеренно остаются инфраструктурными
-- переменными окружения. Рабочие параметры SDK и шаблоны новых агентов
-- хранятся централизованно в PostgreSQL и применяются без переустановки.
-- Миграция полностью идемпотентна.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS sdk_settings (
    id                         smallint    PRIMARY KEY DEFAULT 1,
    agent_name_prefix          text        NOT NULL DEFAULT 'eva',
    default_description        text        NOT NULL DEFAULT 'Агент Evaself',
    default_persona            text        NOT NULL DEFAULT '',
    default_human_template     text        NOT NULL DEFAULT E'Имя: {{display_name}}\nTelegram ID: {{telegram_id}}',
    default_tags               text[]      NOT NULL DEFAULT ARRAY['evaself']::text[],
    permission_mode            text        NOT NULL DEFAULT 'unrestricted',
    memfs_enabled              boolean     NOT NULL DEFAULT true,
    system_prompt              text,
    base_tools                 text[],
    allowed_tools              text[],
    disallowed_tools           text[]      NOT NULL DEFAULT ARRAY[]::text[],
    skill_sources              text[]      NOT NULL DEFAULT ARRAY['bundled', 'global', 'agent', 'project']::text[],
    system_info_reminder       boolean     NOT NULL DEFAULT false,
    dreaming                   jsonb       NOT NULL DEFAULT '{"trigger":"off"}'::jsonb,
    model_settings             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    default_context_window     integer,
    conversation_summary       text        NOT NULL DEFAULT 'Новый диалог',
    conversation_description   text        NOT NULL DEFAULT '',
    conversation_hidden        boolean     NOT NULL DEFAULT false,
    create_conversation        boolean     NOT NULL DEFAULT true,
    session_pool_size          integer     NOT NULL DEFAULT 25,
    session_idle_ms            integer     NOT NULL DEFAULT 600000,
    turn_timeout_ms            integer     NOT NULL DEFAULT 240000,
    app_server_request_timeout_ms integer   NOT NULL DEFAULT 180000,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sdk_settings_singleton_check CHECK (id = 1),
    CONSTRAINT sdk_settings_permission_check
        CHECK (permission_mode IN ('standard', 'acceptEdits', 'unrestricted')),
    CONSTRAINT sdk_settings_context_check
        CHECK (default_context_window IS NULL OR default_context_window >= 1024),
    CONSTRAINT sdk_settings_pool_check CHECK (session_pool_size BETWEEN 1 AND 500),
    CONSTRAINT sdk_settings_idle_check CHECK (session_idle_ms BETWEEN 1000 AND 86400000),
    CONSTRAINT sdk_settings_turn_check CHECK (turn_timeout_ms BETWEEN 1000 AND 3600000),
    CONSTRAINT sdk_settings_request_check
        CHECK (app_server_request_timeout_ms BETWEEN 1000 AND 3600000)
);

INSERT INTO sdk_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_sdk_settings_updated_at ON sdk_settings;
CREATE TRIGGER trg_sdk_settings_updated_at
    BEFORE UPDATE ON sdk_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_migrations (version) VALUES ('005_sdk_settings')
ON CONFLICT (version) DO NOTHING;

COMMIT;
