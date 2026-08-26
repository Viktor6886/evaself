-- Откат единой административной панели.
--
-- Снимаются только те колонки и таблицы, которых до миграции не было.
-- Ни одна исходная строка не уничтожается: `subscriptions` теряет
-- сведения о происхождении, но сами подписки — план, статус и срок —
-- остаются ровно такими, какими были. Старый код их и читает.
--
-- Артефакты `eva-persona` и `eva-system-prompt` удаляются только пока у
-- них нет ни одной версии. Если из панели уже сохраняли текст, артефакт
-- остаётся: удаление унесло бы историю изменений персоны, а откат схемы
-- этого не требует — runtime без нового кода просто читает файлы.

BEGIN;

DROP TABLE IF EXISTS subscription_admin_events;

ALTER TABLE subscriptions
    DROP CONSTRAINT IF EXISTS subscriptions_source_check;

DROP INDEX IF EXISTS subscriptions_source_idx;

-- Представление сюда не возвращается к `SELECT *` намеренно: его выдача
-- одинакова в обе стороны, а зависимость от каждой колонки `subscriptions`
-- — это и есть то, из-за чего откат однажды не сработал. Старый код читает
-- из него те же поля.
ALTER TABLE subscriptions DROP COLUMN IF EXISTS source;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS actor_id;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS actor_name;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS note;

DELETE FROM artifacts a
 WHERE a.kind = 'prompt'
   AND a.slug IN ('eva-persona', 'eva-system-prompt')
   AND NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.artifact_id = a.id);

DELETE FROM schema_migrations WHERE version = '067_admin_panel_unification';

COMMIT;
