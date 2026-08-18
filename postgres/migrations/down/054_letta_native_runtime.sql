BEGIN;
-- Возврат колонок подмены harness: значения в них не восстанавливаются —
-- их и не было, кроме умолчаний, а прежний системный промпт Evaself
-- заменял штатный harness Letta и возвращать его содержимое некуда.
ALTER TABLE sdk_settings
  ADD COLUMN IF NOT EXISTS system_prompt text,
  ADD COLUMN IF NOT EXISTS allowed_tools text[],
  ADD COLUMN IF NOT EXISTS disallowed_tools text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS skill_sources text[] NOT NULL DEFAULT ARRAY['project'],
  ADD COLUMN IF NOT EXISTS system_info_reminder boolean NOT NULL DEFAULT false;
DELETE FROM schema_migrations WHERE version='054_letta_native_runtime';
COMMIT;
