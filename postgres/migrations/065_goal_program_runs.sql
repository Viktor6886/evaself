-- =====================================================================
-- Курсор длинной guided-программы: где человек находится внутри методики
-- =====================================================================
--
-- Психологическая непрерывность живёт в Letta: current_state, MemFS,
-- recall и сжатие контекста. Сюда она не переносится и переноситься не
-- должна.
--
-- Здесь лежит другое: длинная структурированная программа (planning-30d
-- и подобные) обязана пережить перезапуск, новый conversation, сжатие
-- истории, смену модели и несколько дней между этапами. Ни один из этих
-- рубежей память агента не гарантирует, а «на каком шаге методики мы
-- остановились» — продуктовый факт, а не воспоминание.
--
-- Таблица намеренно остаётся курсором. Что человек делает на самом деле
-- — цели, результаты, рабочие блоки, обзоры — уже описано VECTOR-Action
-- (миграция 011), и дублировать это здесь запрещено. Поэтому длина
-- подсказки ограничена схемой: стенограмме, рассуждению и тексту навыка
-- в курсоре места нет.
BEGIN;

CREATE TABLE IF NOT EXISTS goal_program_runs (
    id                      bigserial PRIMARY KEY,
    user_id                 bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Ключ и версия методики. Версия нужна, чтобы запущенная программа
    -- не поехала под ногами человека при правке методички.
    program_key             text NOT NULL,
    program_version         integer NOT NULL DEFAULT 1,
    -- Необязательная связь с целью VECTOR. Обычная цель не обязана
    -- становиться guided-программой, а программа может идти раньше, чем
    -- цель подтверждена.
    primary_goal_id         bigint REFERENCES goals (id) ON DELETE SET NULL,
    status                  text NOT NULL DEFAULT 'active',
    phase_key               text,
    step_key                text,
    last_completed_step_key text,
    next_step_key           text,
    next_action_hint        text,
    -- Как возвращаться к программе: по контексту разговора, только по
    -- явной просьбе или по уже существующему напоминанию. Своего
    -- планировщика у курсора нет.
    resume_policy           text NOT NULL DEFAULT 'contextual',
    revision                integer NOT NULL DEFAULT 1,
    started_at              timestamptz NOT NULL DEFAULT now(),
    last_progress_at        timestamptz NOT NULL DEFAULT now(),
    completed_at            timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT goal_program_runs_status_check
        CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
    CONSTRAINT goal_program_runs_resume_check
        CHECK (resume_policy IN ('contextual', 'on_request', 'scheduled')),
    CONSTRAINT goal_program_runs_completed_check
        CHECK (completed_at IS NULL OR status IN ('completed', 'cancelled')),
    CONSTRAINT goal_program_runs_version_check CHECK (program_version >= 1),
    CONSTRAINT goal_program_runs_revision_check CHECK (revision >= 1),
    -- Курсор, а не журнал: длину ограничивает схема, а не только код.
    CONSTRAINT goal_program_runs_key_length_check
        CHECK (char_length(program_key) BETWEEN 1 AND 100),
    CONSTRAINT goal_program_runs_cursor_length_check
        CHECK (
            COALESCE(char_length(phase_key), 0) <= 100
            AND COALESCE(char_length(step_key), 0) <= 100
            AND COALESCE(char_length(last_completed_step_key), 0) <= 100
            AND COALESCE(char_length(next_step_key), 0) <= 100
            AND COALESCE(char_length(next_action_hint), 0) <= 300
        )
);

-- Одна открытая программа на человека и ключ методики. Это и есть
-- защита от «начать процедуру заново»: второй запуск той же программы
-- поверх незакрытой невозможен на уровне схемы, а не только в коде.
CREATE UNIQUE INDEX IF NOT EXISTS goal_program_runs_open_uidx
    ON goal_program_runs (user_id, program_key)
    WHERE status IN ('active', 'paused');

CREATE INDEX IF NOT EXISTS goal_program_runs_user_status_idx
    ON goal_program_runs (user_id, status, last_progress_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('065_goal_program_runs')
ON CONFLICT DO NOTHING;

COMMIT;
