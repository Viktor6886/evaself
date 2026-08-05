-- =====================================================================
-- Журнал побочных эффектов инструментов и журнал попыток восстановления.
--
-- Оба нужны ради одного свойства: повтор хода после сбоя не должен
-- повторять то, что уже случилось. Ход можно переиграть — отправленное
-- сообщение, созданную задачу и списанную квоту переиграть нельзя.
--
-- `tool_effects` отвечает на вопрос «этот вызов инструмента уже
-- выполнялся?». Ключ детерминированный: ход, идентификатор вызова и имя
-- инструмента. Повтор с тем же ключом возвращает прежний результат, а
-- не выполняет действие второй раз.
--
-- `turn_recovery_attempts` отвечает на вопрос «почему восстановление
-- решило именно так?». Без него разбор инцидента упирается в догадки:
-- запись хода показывает итог, но не показывает, что было найдено и на
-- каком основании принято решение.
--
-- Чего здесь нет: аргументов инструментов, сырых результатов
-- пользовательского содержания, промптов и ответов модели. Результат
-- хранится либо безопасным значением, либо хэшем (инвариант 19).
--
-- Миграция только добавляет: существующие таблицы не меняются.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS tool_effects (
    -- Ключ исполнения. Выводится из run_id, идентификатора вызова
    -- инструмента и его имени — то есть из того, что при повторе хода
    -- не меняется.
    effect_key      text        PRIMARY KEY,

    run_id          uuid        NOT NULL,
    user_id         bigint      REFERENCES users (id) ON DELETE CASCADE,
    tool_name       text        NOT NULL,
    tool_call_id    text        NOT NULL,

    -- running — вызов начат и не закончен; повтор в это время не
    -- выполняется, а ждёт или отказывается.
    status          text        NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running', 'succeeded', 'failed')),
    attempt         integer     NOT NULL DEFAULT 1 CHECK (attempt >= 1),

    -- Результат: либо безопасное значение целиком, либо его хэш, если
    -- значение может содержать пользовательский текст.
    result          jsonb,
    result_hash     text,

    -- Только код. Текст провайдера сюда не попадает.
    error_code      text,
    -- Можно ли повторять этот отказ. Индивидуальная политика вызова.
    retryable       boolean     NOT NULL DEFAULT true,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz
);

COMMENT ON TABLE tool_effects IS
    'Журнал побочных эффектов инструментов. Один ключ — один эффект.';
COMMENT ON COLUMN tool_effects.effect_key IS
    'run_id + идентификатор вызова + имя инструмента: при повторе хода не меняется.';
COMMENT ON COLUMN tool_effects.result IS
    'Безопасный результат. Пользовательское содержание хранится хэшем в result_hash.';

CREATE TABLE IF NOT EXISTS turn_recovery_attempts (
    id            bigserial   PRIMARY KEY,
    run_id        uuid        NOT NULL,
    user_id       bigint      REFERENCES users (id) ON DELETE CASCADE,

    -- Почему ход попал в восстановление.
    reason        text        NOT NULL,
    -- Что нашли: состояние хода, наличие outbox, факт отправки.
    found_state   text,
    -- Что решили и что из этого вышло.
    decision      text        NOT NULL,
    outcome       text,
    -- Только флаги и счётчики: пользовательского текста здесь нет.
    detail        jsonb       NOT NULL DEFAULT '{}'::jsonb,

    at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE turn_recovery_attempts IS
    'Каждая попытка восстановления хода: причина, найденное, решение, итог.';

-- Индексы создаются обычным способом: обе таблицы заводятся этой же
-- миграцией и пусты, построение мгновенно, а CONCURRENTLY внутри
-- транзакции невозможен. Правило про CONCURRENTLY относится к индексам
-- на таблицах с данными.
CREATE INDEX IF NOT EXISTS tool_effects_run_idx
    ON tool_effects (run_id, created_at);
CREATE INDEX IF NOT EXISTS tool_effects_stale_idx
    ON tool_effects (updated_at)
    WHERE status = 'running';
CREATE INDEX IF NOT EXISTS turn_recovery_attempts_run_idx
    ON turn_recovery_attempts (run_id, at DESC);

INSERT INTO schema_migrations (version)
VALUES ('031_turn_recovery')
ON CONFLICT (version) DO NOTHING;

COMMIT;
