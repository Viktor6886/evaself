BEGIN;

DELETE FROM llm_providers
 WHERE protocol IN ('openai-responses', 'gemini-compatible');
ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_providers_protocol_check;
ALTER TABLE llm_providers ADD CONSTRAINT llm_providers_protocol_check
  CHECK (protocol IN ('openai-compatible', 'anthropic-compatible'));

COMMIT;
