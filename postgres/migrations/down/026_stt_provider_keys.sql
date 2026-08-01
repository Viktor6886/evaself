-- Откат 026: вернуться к одному ключу на конфигурацию.
--
-- Первый по порядку ключ переносится обратно в stt_provider_configs,
-- чтобы распознавание после отката продолжило работать. Остальные
-- ссылки теряются, но сами секреты остаются в Secret Store — удалять
-- чужие ключи при откате схемы нельзя.

BEGIN;

UPDATE stt_provider_configs c
   SET secret_ref = first_key.secret_ref
  FROM (
      SELECT DISTINCT ON (config_id) config_id, secret_ref
        FROM stt_provider_keys
       WHERE enabled AND status = 'active'
       ORDER BY config_id, position, created_at
  ) AS first_key
 WHERE c.id = first_key.config_id
   AND c.secret_ref IS DISTINCT FROM first_key.secret_ref;

DROP TABLE IF EXISTS stt_provider_keys;

DELETE FROM schema_migrations WHERE version = '026_stt_provider_keys';

COMMIT;
