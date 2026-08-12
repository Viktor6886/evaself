-- ---------------------------------------------------------------------
-- Шаг 17. Memory Doctor: диагностика памяти без права записи.
--
-- Здесь только две таблицы, и обе — журнальные. Диагностика ничего не
-- исправляет: она складывает найденное в отчёт, а каждое предложение
-- ждёт явного действия человека. Поэтому предложение хранится отдельно
-- от отчёта — у него собственный жизненный цикл и собственный снимок
-- для отката, а отчёт остаётся неизменяемым свидетельством того, что
-- было видно на момент прогона.
-- ---------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS memory_doctor_reports (
    id             bigserial PRIMARY KEY,
    user_id        bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Ключ идемпотентности прогона: повторная доставка задания не
    -- порождает второго отчёта о том же состоянии.
    report_key     text NOT NULL,
    trigger_reason text NOT NULL,
    status         text NOT NULL DEFAULT 'pending',
    -- Версия набора проверок. Отчёт, снятый старым набором, нельзя
    -- сравнивать с новым молча.
    checks_version integer NOT NULL DEFAULT 1,
    -- Разделы отчёта: по одному на тип проблемы, включая пустые и
    -- невыполнимые. Отсутствующий раздел и раздел «ничего не найдено» —
    -- разные утверждения.
    sections       jsonb NOT NULL DEFAULT '[]'::jsonb,
    findings       jsonb NOT NULL DEFAULT '[]'::jsonb,
    budget         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    completed_at   timestamptz,
    CONSTRAINT memory_doctor_reports_trigger_check CHECK (trigger_reason IN (
        'admin', 'user', 'memory_growth', 'conflict_detected',
        'schema_version_changed', 'scheduled', 'before_export', 'after_backfill'
    )),
    CONSTRAINT memory_doctor_reports_status_check CHECK (status IN (
        'pending', 'succeeded', 'partial', 'failed'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_doctor_reports_key_uidx
    ON memory_doctor_reports (user_id, report_key);
CREATE INDEX IF NOT EXISTS memory_doctor_reports_recent_idx
    ON memory_doctor_reports (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_doctor_actions (
    id            bigserial PRIMARY KEY,
    user_id       bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    report_id     bigint NOT NULL REFERENCES memory_doctor_reports (id) ON DELETE CASCADE,
    finding_id    text NOT NULL,
    check_id      text NOT NULL,
    action_type   text NOT NULL,
    node_id       bigint,
    proposal      jsonb NOT NULL DEFAULT '{}'::jsonb,
    status        text NOT NULL DEFAULT 'proposed',
    -- Снимок до применения. Откат без него — угадывание прежнего
    -- состояния, а угадывать состояние памяти нельзя.
    snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
    actor_type    text,
    actor_id      text,
    applied_at    timestamptz,
    rolled_back_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_doctor_actions_type_check CHECK (action_type IN (
        'merge_duplicate', 'request_confirmation', 'mark_forgotten',
        'raise_privacy', 'archive_edge', 'resync_block'
    )),
    CONSTRAINT memory_doctor_actions_status_check CHECK (status IN (
        'proposed', 'applied', 'rejected', 'rolled_back'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_doctor_actions_finding_uidx
    ON memory_doctor_actions (user_id, report_id, finding_id);
CREATE INDEX IF NOT EXISTS memory_doctor_actions_open_idx
    ON memory_doctor_actions (user_id, created_at DESC) WHERE status = 'proposed';

-- Плановый низкоприоритетный запуск. Выключен, как и остальные
-- расписания: включает его человек вместе с флагом EVA_MEMORY_DOCTOR.
-- Обход сам выбирает повод по состоянию памяти — противоречие, рост
-- объёма, смена версии набора проверок или просто плановый черёд.
INSERT INTO job_schedules (code, queue, job_type, schema_version, cron, timezone, enabled, dedup_mode, payload)
VALUES ('memory_doctor_sweep', 'memory', 'memory_doctor_sweep', 1,
        '15 4 * * *', 'Europe/Moscow', false, 'keep_last_if_active', '{}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('045_memory_doctor')
ON CONFLICT (version) DO NOTHING;

COMMIT;
