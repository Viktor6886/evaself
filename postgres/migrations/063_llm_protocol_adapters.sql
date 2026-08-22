BEGIN;

ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_providers_protocol_check;
ALTER TABLE llm_providers ADD CONSTRAINT llm_providers_protocol_check
  CHECK (protocol IN (
    'openai-compatible',
    'openai-responses',
    'gemini-compatible',
    'anthropic-compatible'
  ));

INSERT INTO schema_migrations (version)
VALUES ('063_llm_protocol_adapters')
ON CONFLICT DO NOTHING;

COMMIT;
