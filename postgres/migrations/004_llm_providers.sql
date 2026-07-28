-- =====================================================================
-- Централизованные конфигурации OpenAI-compatible LLM.
--
-- API-ключ хранится только в зашифрованном виде. В каждый момент активна
-- не более чем одна конфигурация; переключение выполняет eva-agent-service
-- после проверки провайдера и обновления существующих объектов Letta.
-- Миграция полностью идемпотентна.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS llm_providers (
    id                     uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                   text        NOT NULL,
    protocol               text        NOT NULL DEFAULT 'openai-compatible',
    base_url               text        NOT NULL,
    model                  text        NOT NULL,
    context_window         integer     NOT NULL,
    additional_parameters  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    api_key_encrypted      text        NOT NULL,
    is_active              boolean     NOT NULL DEFAULT false,
    last_checked_at        timestamptz,
    last_check_ok          boolean,
    last_check_message     text,
    last_models            jsonb,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT llm_providers_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT llm_providers_base_url_not_blank CHECK (btrim(base_url) <> ''),
    CONSTRAINT llm_providers_model_not_blank CHECK (btrim(model) <> ''),
    CONSTRAINT llm_providers_protocol_check CHECK (protocol IN ('openai-compatible')),
    CONSTRAINT llm_providers_context_window_check CHECK (context_window >= 1024),
    CONSTRAINT llm_providers_parameters_object_check
        CHECK (jsonb_typeof(additional_parameters) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS llm_providers_name_uidx
    ON llm_providers (lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS llm_providers_one_active_uidx
    ON llm_providers ((is_active))
    WHERE is_active;

DROP TRIGGER IF EXISTS trg_llm_providers_updated_at ON llm_providers;
CREATE TRIGGER trg_llm_providers_updated_at
    BEFORE UPDATE ON llm_providers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Существующие установки уже имеют активный conversation в agent_links.
-- Добавляем его в историю, чтобы смена модели обновила не только новые связи.
INSERT INTO agent_conversations (user_id, agent_id, conversation_id)
SELECT user_id, agent_id, conversation_id
  FROM agent_links
 WHERE conversation_id IS NOT NULL
ON CONFLICT (conversation_id) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('004_llm_providers')
ON CONFLICT (version) DO NOTHING;

COMMIT;
