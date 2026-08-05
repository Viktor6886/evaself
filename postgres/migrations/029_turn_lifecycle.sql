-- =====================================================================
-- Durable жизненный цикл хода (shadow-режим).
--
-- До этой миграции ход пользователя нигде не был единой записью. Его
-- следы разбросаны: `telegram_updates` знает про приём и про попытки,
-- `telegram_outbox` — про доставку, `llm_requests` — про модель,
-- `usage_counters` — про списание. Связать их между собой можно только
-- вручную и только по времени, поэтому вопрос «что произошло с этим
-- ходом» не имеет ответа ни в панели, ни в логах.
--
-- Здесь появляется одна запись на ход (`turn_runs`) и журнал его
-- переходов (`turn_transitions`). Обе таблицы только пишутся и только
-- при включённом EVA_TURN_LIFECYCLE: текущий путь обработки сообщения
-- не меняется, ответы пользователю не зависят от этих записей.
--
-- Чего здесь намеренно НЕТ: сырых промптов, ответов модели, аргументов
-- инструментов и reasoning. Хранится структура хода, а не его
-- содержание (инвариант 19 и раздел «Запрещено» в CLAUDE.md).
--
-- Миграция только добавляет. Старый код продолжает работать: ни одна
-- существующая таблица не меняется.
-- =====================================================================

BEGIN;

-- Канонический список состояний из CLAUDE.md. Синонимы не заводятся:
-- ограничение ниже — это тот же список, а не его копия «по смыслу».
CREATE TABLE IF NOT EXISTS turn_runs (
    run_id              uuid        PRIMARY KEY,

    -- Ключ идемпотентности хода: канал + идентификатор входящего
    -- события + conversation. При повторной доставке того же апдейта
    -- он не меняется, поэтому вторая успешная запись невозможна.
    idempotency_key     text        NOT NULL UNIQUE,
    channel             text        NOT NULL DEFAULT 'telegram'
                                    CHECK (channel IN ('telegram', 'webapp', 'scheduler', 'internal')),

    user_id             bigint      REFERENCES users (id) ON DELETE CASCADE,
    telegram_user_id    bigint,
    update_id           bigint      REFERENCES telegram_updates (update_id) ON DELETE SET NULL,
    agent_id            text,
    conversation_id     text,
    purpose             text,

    state               text        NOT NULL DEFAULT 'accepted'
                                    CHECK (state IN (
                                        'accepted', 'aggregating', 'queued', 'claimed',
                                        'context_building', 'context_built', 'sent_to_letta',
                                        'letta_processing', 'tools_pending', 'approval_pending',
                                        'result_received', 'outbox_committed', 'delivering',
                                        'delivered', 'completed', 'cancelling', 'cancelled',
                                        'failed_retryable', 'recovery_required', 'recovering',
                                        'failed_terminal'
                                    )),

    -- Аренда исполнителя: кто ведёт ход и до какого момента. Нужна
    -- восстановлению после перезапуска, а не параллельности — её этот
    -- шаг не вводит.
    attempt             integer     NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    lease_owner         text,
    lease_expires_at    timestamptz,

    -- Барьер отмены: ход, помеченный к отмене, не продолжается.
    cancel_requested_at timestamptz,
    cancel_reason       text,

    -- Связи с уже существующими записями. Внешних ключей на них нет
    -- намеренно: outbox и llm_requests живут своими сроками хранения,
    -- и ход не должен мешать их очистке.
    quota_metric        text,
    quota_charged       boolean     NOT NULL DEFAULT false,
    outbox_id           bigint,
    llm_request_id      text,
    letta_session_id    text,
    trace_id            text,
    prompt_version      text,
    flow_version        text,

    -- Только безопасный код ошибки. Текста провайдера и пользователя
    -- здесь нет по построению.
    error_code          text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    started_at          timestamptz,
    finished_at         timestamptz,

    -- Длительности считает код, а не разность времён при чтении:
    -- ход может пережить перезапуск, и «сейчас» тогда не сравнимо.
    wait_ms             integer,
    duration_ms         integer
);

COMMENT ON TABLE turn_runs IS
    'Один ход пользователя как одна запись. Содержания разговора не хранит.';
COMMENT ON COLUMN turn_runs.idempotency_key IS
    'Канал + идентификатор входящего события + conversation. Повтор апдейта даёт тот же ключ.';
COMMENT ON COLUMN turn_runs.error_code IS
    'Безопасный код ошибки, без текста провайдера и пользователя.';

CREATE TABLE IF NOT EXISTS turn_transitions (
    id            bigserial   PRIMARY KEY,
    run_id        uuid        NOT NULL REFERENCES turn_runs (run_id) ON DELETE CASCADE,
    from_state    text,
    to_state      text        NOT NULL,
    attempt       integer     NOT NULL DEFAULT 1,
    error_code    text,
    -- Техническая пометка перехода: имя воркера, причина отмены,
    -- длительность шага. Пользовательского текста здесь нет.
    detail        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE turn_transitions IS
    'Журнал переходов состояний хода. Пользовательского текста не содержит.';

-- Индексы создаются обычным способом, а не CONCURRENTLY: обе таблицы
-- заводятся этой же миграцией и пусты, построение мгновенно, а
-- CONCURRENTLY внутри транзакции невозможно. Правило про CONCURRENTLY
-- относится к индексам на таблицах с данными.
CREATE INDEX IF NOT EXISTS turn_runs_user_recent_idx
    ON turn_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS turn_runs_active_idx
    ON turn_runs (state, updated_at)
    WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS turn_runs_update_idx
    ON turn_runs (update_id)
    WHERE update_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS turn_transitions_run_idx
    ON turn_transitions (run_id, at);

INSERT INTO schema_migrations (version)
VALUES ('029_turn_lifecycle')
ON CONFLICT (version) DO NOTHING;

COMMIT;
