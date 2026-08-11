-- 038. Состояние синхронизации memory blocks с Letta.
--
-- Набор блоков не расширяется и здесь не меняется (инвариант 28): таблица
-- хранит не сами блоки, а факт их записи в Letta и её исход. Нужна она
-- потому, что запись в блок идёт через административный клиент, а он может
-- быть выключен, недоступен или отвергнуть операцию — и тогда система
-- обязана честно показать, что канонического значения в Letta нет, вместо
-- того чтобы считать запись состоявшейся.
--
-- Прямой связи внешним ключом с Letta нет и быть не может: агент живёт в
-- App Server, а не в этой базе. `agent_id` — текстовый идентификатор
-- оттуда, и его отсутствие в Letta не должно ломать строку здесь.

CREATE TABLE IF NOT EXISTS letta_memory_block_sync (
    id                bigserial   PRIMARY KEY,

    -- Владелец. Блоки персональны, и запрос без арендатора к этой таблице
    -- запрещён границей `src/tenancy/`.
    user_id           bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    agent_id          text        NOT NULL,

    -- Метка одного из шести блоков. Список закрыт: строка с чужой меткой
    -- означала бы расширение набора в обход инварианта 28.
    label             text        NOT NULL
                                  CHECK (label IN (
                                      'persona', 'human', 'current_state',
                                      'goals_and_commitments',
                                      'relationships_and_patterns',
                                      'progress_and_hypotheses'
                                  )),

    -- Что мы хотим видеть в блоке. Хранится целиком, а не отпечатком:
    -- повтор синхронизации после появления официальной возможности
    -- обязан знать, что именно записывать, и восстановить это из
    -- отпечатка нельзя.
    desired_value     text        NOT NULL,

    -- Отпечаток значения, которое подтверждено записанным. NULL означает,
    -- что подтверждения не было ни разу.
    synced_checksum   text,

    -- Честный статус, без синонимов:
    --   pending          — намерение записано, попытки ещё не было;
    --   synced           — записано официальным путём и подтверждено;
    --   runtime_override — официально записать не удалось, значение
    --                      применяется только в runtime-контексте и это
    --                      видно, а не спрятано;
    --   failed           — попытка закончилась отказом.
    status            text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN (
                                      'pending', 'synced', 'runtime_override', 'failed'
                                  )),

    attempts          integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),

    -- Код последнего отказа. Только код и краткое сообщение операции —
    -- ни значения блока, ни ответа модели здесь быть не должно.
    last_error        text,

    last_attempt_at   timestamptz,
    synced_at         timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- Одна строка на блок агента: намерение — это состояние, а не журнал.
    CONSTRAINT letta_memory_block_sync_agent_label_key UNIQUE (agent_id, label)
);

CREATE INDEX IF NOT EXISTS letta_memory_block_sync_user_idx
    ON letta_memory_block_sync (user_id);

-- Выборка повтора: всё, что не подтверждено, в порядке давности попытки.
-- Частичный индекс — потому что подтверждённых строк со временем
-- большинство, и просматривать их повтору незачем.
CREATE INDEX IF NOT EXISTS letta_memory_block_sync_retry_idx
    ON letta_memory_block_sync (last_attempt_at NULLS FIRST)
    WHERE status <> 'synced';
