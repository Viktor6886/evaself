BEGIN;

-- Безопасный режим разрешений по умолчанию.
--
-- `unrestricted` в harness Letta означает «разрешить любой вызов не
-- спрашивая»: проверка разрешений возвращает allow до того, как её
-- увидит `canUseTool`. То есть подтверждения действий человеком в этом
-- режиме не спрашиваются вовсе, а инструменты выполнения — оболочка и
-- запись в файловую систему — работают без единой преграды.
--
-- `standard` не сужает набор инструментов: он лишь возвращает штатный
-- поток разрешений, в котором Evaself и спрашивает подтверждение.
-- Память, MemFS, навыки, субагенты и обращение к истории остаются
-- доступны.
--
-- Forward-миграция работает со старым кодом: значение `standard`
-- допускалось схемой и раньше (см. 007), и прежний код его понимает.
ALTER TABLE sdk_settings
  ALTER COLUMN permission_mode SET DEFAULT 'standard';

-- `sdk_settings` — таблица из одной строки с id = 1. Переключается
-- только неограниченный режим: осознанно выбранные `acceptEdits` и
-- `strict` остаются как есть.
UPDATE sdk_settings
   SET permission_mode = 'standard'
 WHERE permission_mode = 'unrestricted';

INSERT INTO schema_migrations (version) VALUES ('055_safe_permission_mode')
ON CONFLICT (version) DO NOTHING;

COMMIT;
