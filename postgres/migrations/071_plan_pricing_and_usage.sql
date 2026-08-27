-- Тарификация: пробные внутри платного тарифа, цены в звёздах, учёт расхода.
--
-- Считать заново ничего не пришлось: quotas и usage_counters из миграции
-- 001 уже описывают ровно нужное — лимит на тариф × метрику × период и
-- расход на пользователя. Здесь добавлено только то, чего в этой модели
-- не было.
--
-- 1. free_value — пробные сообщения внутри платного тарифа. Столько
--    единиц метрики доступно на тарифе без оплаченной подписки: человек
--    успевает попробовать Plus до того, как заплатит, а после окончания
--    оплаченного срока не проваливается в полное молчание. Ноль означает
--    «только по подписке» — так ведут себя все существующие строки сразу
--    после наката, то есть поведение установки не меняется.
--
-- 2. plan_prices — единственная новая таблица. Цена тарифа в звёздах
--    Telegram за срок подписки; ничего похожего в схеме не было.
--
-- 3. pro переименован в max. Тарифов теперь два платных: plus и max.
--    Переименование, а не удаление: у кого подписка на pro, тот
--    остаётся с рабочей подпиской, только под новым именем.

BEGIN;

ALTER TABLE quotas
    ADD COLUMN IF NOT EXISTS free_value bigint NOT NULL DEFAULT 0;

ALTER TABLE quotas
    DROP CONSTRAINT IF EXISTS quotas_free_check;
ALTER TABLE quotas
    ADD CONSTRAINT quotas_free_check CHECK (free_value >= 0);

COMMENT ON COLUMN quotas.free_value IS
    'Сколько единиц метрики доступно на тарифе без оплаченной подписки. 0 — только по подписке.';

-- pro → max. Порядок важен: сначала подписки, потом квоты, иначе между
-- двумя UPDATE нашёлся бы момент, когда у подписки на pro нет квот.
UPDATE subscriptions SET plan = 'max' WHERE plan = 'pro';
UPDATE quotas       SET plan = 'max' WHERE plan = 'pro';

-- Цена тарифа в звёздах Telegram.
--
-- Цена принадлежит тарифу и сроку, а не человеку: владелец меняет её в
-- одном месте, и она применяется ко всем. Уникальность пары это правило
-- и закрепляет.
CREATE TABLE IF NOT EXISTS plan_prices (
    id         bigserial PRIMARY KEY,
    plan       text        NOT NULL,
    period     text        NOT NULL,
    stars      integer     NOT NULL,
    enabled    boolean     NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid,
    CONSTRAINT plan_prices_period_check CHECK (period IN ('week', 'month', 'quarter')),
    -- Ноль звёзд — это не «бесплатно», а «цена не задана»: продавать за
    -- ноль Telegram всё равно не даст, а тариф с такой ценой не должен
    -- попадать в продажу молча.
    CONSTRAINT plan_prices_stars_check CHECK (stars > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS plan_prices_plan_period_uidx
    ON plan_prices (plan, period);

COMMENT ON TABLE plan_prices IS
    'Цена тарифа в звёздах Telegram за срок подписки. Одна на всех: владелец правит её в панели.';

-- Учитываемые расходники. Метрика messages остаётся как была — она
-- считает входящие сообщения человека и на неё смотрит гейт хода; её
-- переименование сломало бы и гейт, и накопленные счётчики.
--
-- Новые метрики заведены только для учёта: ничего не ограничивают, пока
-- владелец не проставит им лимит в панели. Поэтому лимит здесь -1
-- (безлимит), а не выдуманное число.
INSERT INTO quotas (plan, metric, period, limit_value, free_value, description) VALUES
    ('free', 'messages_out', 'day', -1, 0, 'Ответы Евы'),
    ('free', 'voice_in',     'day', -1, 0, 'Принятые голосовые'),
    ('free', 'voice_out',    'day', -1, 0, 'Озвученные ответы'),
    ('free', 'documents',    'day', -1, 0, 'Обработанные документы'),
    ('free', 'images',       'day', -1, 0, 'Обработанные изображения'),
    ('plus', 'messages_out', 'day', -1, 0, 'Ответы Евы'),
    ('plus', 'voice_in',     'day', -1, 0, 'Принятые голосовые'),
    ('plus', 'voice_out',    'day', -1, 0, 'Озвученные ответы'),
    ('plus', 'documents',    'day', -1, 0, 'Обработанные документы'),
    ('plus', 'images',       'day', -1, 0, 'Обработанные изображения'),
    ('max',  'messages',      'day', -1, 0, 'Сообщения человека'),
    ('max',  'messages_out', 'day', -1, 0, 'Ответы Евы'),
    ('max',  'voice_minutes','day', -1, 0, 'Минуты распознавания'),
    ('max',  'voice_in',     'day', -1, 0, 'Принятые голосовые'),
    ('max',  'voice_out',    'day', -1, 0, 'Озвученные ответы'),
    ('max',  'documents',    'day', -1, 0, 'Обработанные документы'),
    ('max',  'images',       'day', -1, 0, 'Обработанные изображения'),
    ('max',  'web_search',   'day', -1, 0, 'Поиск в интернете')
ON CONFLICT (plan, metric, period) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('071_plan_pricing_and_usage')
ON CONFLICT DO NOTHING;

COMMIT;
