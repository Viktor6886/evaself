-- Откат 073: вернуть засеянные тридцать сообщений в сутки.
--
-- Так же условно, как накат: если владелец поставил своё число, откат
-- его не трогает — он возвращает только то, что менял сам накат.

BEGIN;

UPDATE quotas
   SET limit_value = 30, updated_at = now()
 WHERE plan = 'free'
   AND metric = 'messages'
   AND period = 'day'
   AND limit_value = 10;

DELETE FROM schema_migrations WHERE version = '073_free_plan_daily_messages';

COMMIT;
