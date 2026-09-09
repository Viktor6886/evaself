-- Единая административная панель: ручные подписки и канонические
-- источники личности Евы как артефакты.
--
-- Две вещи, которых не хватало, чтобы вся административная работа
-- выполнялась из одной панели.
--
-- 1. Подписки. Таблица `subscriptions` не различала, откуда взялось право
--    доступа: строка от вебхука Lava и строка, назначенная администратором
--    руками, выглядели одинаково. Из-за этого нельзя было ни показать
--    оператору «это ручное назначение, а не оплата», ни выполнить
--    приоритет доступа инварианта 27, ни снять ручное решение, не задев
--    оплаченный период. Колонка `source` называет происхождение, `actor_*`
--    — кто именно назначил, `note` — зачем.
--
--    Заполнение существующих строк выводится из `provider`: строка с
--    провайдером — оплата, строка без провайдера — то, что завёл код
--    (триал или бесплатная выдача). Ни одна строка не переписывается по
--    смыслу: меняются только новые колонки, которых до этого не было.
--
-- 2. Персона и системный промпт. До сих пор они читались только из файлов
--    `library/persona/eva.md` и `library/system/letta_local_memfs.md`,
--    смонтированных read-only. Редактировать их из панели было нечем, а
--    заводить для этого отдельное хранилище значило бы создать вторую
--    копию конфигурации. Реестр артефактов (миграция 039) уже умеет
--    версии, утверждение, публикацию и откат — здесь заводятся два
--    артефакта в нём, и файлы остаются значением по умолчанию.
--
-- Совместимость с прежним кодом. Forward-миграция ничего не ломает:
-- старый код не знает о новых колонках и продолжает читать `plan`,
-- `status` и `current_period_end`; артефактов без версий не существует
-- для читателя, который их не спрашивает.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Происхождение подписки
-- ---------------------------------------------------------------------
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'payment';

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS actor_id uuid;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS actor_name text;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS note text;

-- Ручное решение администратора может действовать бессрочно: оператор
-- выдаёт доступ «пока не отменю». NULL в `current_period_end` уже
-- означает «без срока», отдельной колонки для этого не нужно.

ALTER TABLE subscriptions
    DROP CONSTRAINT IF EXISTS subscriptions_source_check;

ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_source_check
    CHECK (source IN ('payment', 'manual', 'promo', 'trial'));

-- Существующие строки: провайдер назван — это оплата; провайдера нет —
-- это то, что выдал код при регистрации. Условие по `source = 'payment'`
-- ограничивает обновление строками, которые получили значение по
-- умолчанию, поэтому повторный накат ничего не переписывает.
UPDATE subscriptions
   SET source = CASE
         WHEN provider IS NOT NULL AND provider <> '' THEN 'payment'
         WHEN status = 'trialing' THEN 'trial'
         ELSE 'promo'
       END
 WHERE source = 'payment'
   AND NOT (provider IS NOT NULL AND provider <> '');

CREATE INDEX IF NOT EXISTS subscriptions_source_idx
    ON subscriptions (source, status);

-- ---------------------------------------------------------------------
-- 1a. v_user_overview перестаёт зависеть от `SELECT *`
-- ---------------------------------------------------------------------
-- Представление собиралось боковыми выборками `SELECT * FROM subscriptions`
-- и `SELECT * FROM agent_links`. PostgreSQL раскрывает `*` в момент
-- создания представления и запоминает получившийся список колонок как
-- зависимость.
--
-- Само по себе это ничего не ломало, пока состав колонок не менялся. Но
-- `db-migrate.sh` прогоняет все миграции заново при каждом `make update`,
-- и миграция 003 пересоздаёт представление — уже после того, как эта
-- добавила `source`, `actor_id`, `actor_name` и `note`. С этого момента
-- представление зависит от них, и откат отвечает:
--
--   cannot drop column source of table subscriptions because other
--   objects depend on it
--
-- То есть миграция, у которой есть down-файл, переставала откатываться —
-- молча и не сразу, а со второго прогона. Заодно выдача представления
-- тихо прирастала четырьмя служебными колонками.
--
-- Список колонок в боковых выборках теперь явный. Выдача представления не
-- меняется ни на одну колонку: те же поля, в том же порядке, — меняется
-- только то, от чего оно зависит. Следующая колонка в `subscriptions` или
-- `agent_links` этой ловушки уже не расставит.
DROP VIEW IF EXISTS v_user_overview;
CREATE VIEW v_user_overview AS
SELECT
    u.id,
    u.telegram_id,
    u.username,
    u.first_name,
    u.state,
    u.is_blocked,
    u.language_code,
    u.timezone,
    COALESCE(s.plan, 'free')            AS plan,
    COALESCE(s.status, 'none')          AS subscription_status,
    s.current_period_end,
    a.agent_id                          AS letta_agent_id,
    a.conversation_id                   AS letta_conversation_id,
    a.runtime                           AS agent_runtime,
    a.message_count,
    a.last_message_at,
    u.created_at,
    u.last_seen_at
FROM users u
LEFT JOIN LATERAL (
    SELECT plan, status, current_period_end, created_at
      FROM subscriptions
     WHERE user_id = u.id AND status IN ('trialing', 'active', 'past_due')
     ORDER BY created_at DESC LIMIT 1
) s ON true
LEFT JOIN LATERAL (
    SELECT agent_id, conversation_id, runtime, message_count,
           last_message_at, created_at
      FROM agent_links
     WHERE user_id = u.id AND kind = 'eva' AND status = 'active'
     ORDER BY created_at DESC LIMIT 1
) a ON true;

-- ---------------------------------------------------------------------
-- 2. Журнал ручных решений по подпискам
-- ---------------------------------------------------------------------
-- Отдельная таблица, а не только audit_log: в аудите лежит факт вызова
-- маршрута, а здесь — доменная история доступа («назначен plus до 1 июня»,
-- «продлён на 30 дней», «ручное решение снято»). Она нужна карточке
-- пользователя, и разбирать ради неё JSON аудита было бы гаданием.
CREATE TABLE IF NOT EXISTS subscription_admin_events (
    id              bigserial PRIMARY KEY,
    user_id         bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    subscription_id bigint      REFERENCES subscriptions (id) ON DELETE SET NULL,
    action          text        NOT NULL,
    plan            text,
    status          text,
    period_end      timestamptz,
    actor_id        uuid,
    actor_name      text        NOT NULL DEFAULT 'unknown',
    reason          text        NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT subscription_admin_events_action_check
        CHECK (action IN ('assign', 'change_plan', 'extend', 'cancel', 'clear_manual'))
);

CREATE INDEX IF NOT EXISTS subscription_admin_events_user_idx
    ON subscription_admin_events (user_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 3. Канонические источники личности как артефакты
-- ---------------------------------------------------------------------
-- Тип `prompt` уже есть в реестре (миграция 039) и проверяется
-- `validateArtifactBody`: тело версии — объект с непустой строкой `text`.
-- Версий здесь не создаётся: пока их нет, runtime читает файлы, как и
-- читал. Первая версия появляется при первом сохранении из панели.
INSERT INTO artifacts (kind, slug, title, description)
VALUES
    ('prompt', 'eva-persona', 'Персона Евы',
     'Канонический текст персоны. Значение по умолчанию — library/persona/eva.md'),
    ('prompt', 'eva-system-prompt', 'Системный промпт Евы',
     'Канонический system prompt агента. Значение по умолчанию — library/system/letta_local_memfs.md')
ON CONFLICT (kind, slug) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('067_admin_panel_unification')
    ON CONFLICT DO NOTHING;

COMMIT;
