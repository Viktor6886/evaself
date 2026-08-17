BEGIN;

-- Letta становится единственным cognitive runtime.
--
-- Настройки, которыми Evaself подменял штатный harness и сужал набор
-- инструментов сессии, больше не существуют: системный промпт задаёт
-- Letta, набор клиентских инструментов — тоже она, а источники навыков
-- берутся из умолчания CLI (bundled, global, agent, project).
--
-- `base_tools` остаётся: это серверные инструменты, объявляемые при
-- создании агента, и NULL в нём означает «умолчание harness».
ALTER TABLE sdk_settings
  DROP COLUMN IF EXISTS system_prompt,
  DROP COLUMN IF EXISTS allowed_tools,
  DROP COLUMN IF EXISTS disallowed_tools,
  DROP COLUMN IF EXISTS skill_sources,
  DROP COLUMN IF EXISTS system_info_reminder;

-- Рефлексия Letta включается на событии сжатия контекста. Строка одна:
-- `sdk_settings` — таблица из одной строки с id = 1.
UPDATE sdk_settings
   SET dreaming = jsonb_build_object('trigger', 'compaction-event')
 WHERE dreaming->>'trigger' IS DISTINCT FROM 'compaction-event';

INSERT INTO schema_migrations (version) VALUES ('054_letta_native_runtime')
ON CONFLICT (version) DO NOTHING;

COMMIT;
