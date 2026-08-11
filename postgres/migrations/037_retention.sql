-- =====================================================================
-- Шаг 10: применение политик хранения.
--
-- Проверка отсутствия эквивалента (инвариант 20): сами ПОЛИТИКИ новых
-- таблиц не требуют — Config Service уже хранит типизированные значения
-- с версией, аудитом и откатом (`system_settings`, `config_versions`),
-- и сроки хранения заведены там же, отдельной группой настроек.
-- Здесь появляются только две вещи, которых в схеме нет:
--
--   * задержка удаления (legal hold) — у неё автор, причина и срок;
--   * журнал прогонов удаления — что и сколько удалено, чтобы удаление
--     было возобновляемым и проверяемым.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Задержка удаления.
--
-- Юридическая или инцидентная задержка — это исключение из общего
-- правила, и оно обязано быть именным: кто поставил, почему и до какого
-- срока (требование 4 шага 10). Задержка без автора и срока превращается
-- в бессрочное «данные не удаляем» — то есть в отмену политики.
--
-- `user_id IS NULL` означает задержку по всему классу данных, а не по
-- одному человеку: инцидент обычно шире одного пользователя.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS retention_holds (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    data_class  text        NOT NULL,
    user_id     bigint      REFERENCES users (id) ON DELETE CASCADE,
    -- Кто поставил. Оператор административной панели, не пользователь.
    author      text        NOT NULL,
    reason      text        NOT NULL,
    -- До какого момента задержка действует. NULL запрещён намеренно:
    -- бессрочная задержка — это отмена политики, а не её исключение.
    expires_at  timestamptz NOT NULL,
    released_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT retention_holds_reason_check CHECK (length(btrim(reason)) >= 8)
);

CREATE INDEX IF NOT EXISTS retention_holds_active_idx
    ON retention_holds (data_class, expires_at)
    WHERE released_at IS NULL;

-- ---------------------------------------------------------------------
-- Журнал прогонов удаления.
--
-- Удаление идёт небольшими пакетами и обязано быть возобновляемым: если
-- процесс упал на середине, следующий заход должен продолжить, а не
-- начать заново и не пропустить остаток. Журнал отвечает на вопросы
-- «докуда дошли» и «сколько удалили», а заодно делает предпросмотр
-- сравнимым с фактом.
--
-- `dry_run` отличает предпросмотр от удаления. Строка предпросмотра
-- сохраняется намеренно: отчёт, которого нет в журнале, невозможно
-- предъявить.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS retention_runs (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    data_class  text        NOT NULL,
    dry_run     boolean     NOT NULL DEFAULT true,
    -- Сколько строк подпадает под политику и сколько реально затронуто.
    examined    integer     NOT NULL DEFAULT 0,
    affected    integer     NOT NULL DEFAULT 0,
    -- Задержки, из-за которых часть строк осталась на месте.
    held        integer     NOT NULL DEFAULT 0,
    status      text        NOT NULL DEFAULT 'succeeded',
    error_code  text,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    CONSTRAINT retention_runs_status_check
        CHECK (status IN ('succeeded', 'partial', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS retention_runs_class_idx
    ON retention_runs (data_class, started_at DESC);

-- ---------------------------------------------------------------------
-- Расписание применения политик.
--
-- Каноническая копия расписания — в PostgreSQL (инвариант 9), очередь
-- его только исполняет. Строка выключена: включает человек, увидев
-- предпросмотр. Раз в сутки ночью — удаление не срочная работа, а
-- пакеты маленькие.
-- ---------------------------------------------------------------------
INSERT INTO job_schedules (code, queue, job_type, schema_version, cron, timezone, enabled, dedup_mode, payload)
VALUES ('retention_enforce', 'maintenance', 'retention_enforce', 1,
        '30 3 * * *', 'Europe/Moscow', false, 'keep_last_if_active', '{}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('037_retention')
ON CONFLICT (version) DO NOTHING;

COMMIT;
