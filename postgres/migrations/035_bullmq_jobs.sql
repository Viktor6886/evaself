-- =====================================================================
-- Единый слой фоновых заданий: job outbox, журнал запусков, расписания
-- и «мёртвые» задания.
--
-- Почему таблицы новые, а не переиспользованы существующие. Проверено по
-- docs/IMPLEMENTATION_STATE.md и схеме: `telegram_outbox` — доставка
-- сообщений в один канал с методами Telegram и chat_id, `turn_runs` —
-- жизненный цикл интерактивного хода, `tasks`/`task_events` —
-- продуктовые напоминания пользователя. Ни одна из них не описывает
-- фоновое задание с очередью, расписанием и арендой исполнения, и
-- расширение любой из них смешало бы два разных жизненных цикла в одной
-- строке.
--
-- Разделение с Valkey (инварианты 1, 2): здесь лежит всё, что нельзя
-- потерять — намерение поставить задание, факт запуска, расписание.
-- В Valkey живёт только сама очередь BullMQ, и её потеря означает
-- повторную публикацию из этого outbox, а не потерю задания.
--
-- Пользовательский текст, память, транскрипции и медиа сюда не попадают:
-- в `envelope` разрешены только идентификаторы и ссылки, что проверяет
-- рантайм (`src/jobs/envelope.ts`) и тест приватности payload.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Транзакционный job outbox.
--
-- Событие пишется в той же транзакции, что и бизнес-намерение: либо
-- есть и намерение, и запись о задании, либо нет ни того, ни другого.
-- Публикатор переносит запись в BullMQ отдельно и идемпотентно, поэтому
-- падение между COMMIT и публикацией задание не теряет.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_outbox (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Ключ идемпотентности одновременно служит идентификатором задания в
    -- BullMQ: повторная публикация той же строки второго задания не
    -- создаёт, и второй бизнес-эффект не наступает.
    idempotency_key text        NOT NULL UNIQUE,
    queue           text        NOT NULL,
    job_type        text        NOT NULL,
    schema_version  integer     NOT NULL,
    user_id         bigint      REFERENCES users (id) ON DELETE CASCADE,
    -- Конверт целиком: версия схемы, трассы, ссылки и безопасный payload.
    envelope        jsonb       NOT NULL,
    -- Режим дедупликации уже разрешён в ключ на стороне кода; здесь он
    -- хранится для наблюдения и для сверки расписаний.
    dedup_key       text,
    trace_id        text,
    status          text        NOT NULL DEFAULT 'pending',
    attempts        smallint    NOT NULL DEFAULT 0,
    available_at    timestamptz NOT NULL DEFAULT now(),
    -- Аренда публикатора: строка, взятая упавшим процессом, освобождается
    -- по истечении срока, а не остаётся занятой навсегда.
    lease_until     timestamptz,
    lease_owner     text,
    published_at    timestamptz,
    error_code      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT job_outbox_status_check
        CHECK (status IN ('pending', 'publishing', 'published', 'dead'))
);

DROP TRIGGER IF EXISTS trg_job_outbox_updated_at ON job_outbox;
CREATE TRIGGER trg_job_outbox_updated_at
    BEFORE UPDATE ON job_outbox
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Порядок публикации: сначала то, что готово раньше. Частичный индекс
-- держит в себе только неопубликованное — опубликованных строк со
-- временем становится на порядки больше, и полный индекс по ним читался
-- бы впустую.
CREATE INDEX IF NOT EXISTS job_outbox_pending_idx
    ON job_outbox (available_at, id)
    WHERE status IN ('pending', 'publishing');

CREATE INDEX IF NOT EXISTS job_outbox_dedup_idx
    ON job_outbox (dedup_key)
    WHERE dedup_key IS NOT NULL AND status IN ('pending', 'publishing');

-- ---------------------------------------------------------------------
-- Канонический журнал запусков.
--
-- Состояние очереди в Valkey восстановимо, а ответ на вопрос «выполнялось
-- ли это задание и чем кончилось» — нет. Поэтому запуск живёт здесь.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_runs (
    run_id           uuid        PRIMARY KEY,
    -- Идентификатор задания в очереди. Одно задание может дать несколько
    -- запусков (повтор после временного отказа), поэтому не уникален.
    job_id           text        NOT NULL,
    queue            text        NOT NULL,
    job_type         text        NOT NULL,
    schema_version   integer     NOT NULL,
    user_id          bigint      REFERENCES users (id) ON DELETE CASCADE,
    -- Контрольная сумма payload, а не сам payload: повтор должен узнать
    -- «пришло то же самое», не храня содержание второй раз.
    payload_checksum text        NOT NULL,
    status           text        NOT NULL DEFAULT 'running',
    attempt          smallint    NOT NULL DEFAULT 1,
    lease_until      timestamptz,
    lease_owner      text,
    -- Токен отмены: отменяющая сторона записывает его, исполнитель видит
    -- при продлении аренды и прекращает работу.
    cancel_token     text,
    cancel_requested boolean     NOT NULL DEFAULT false,
    schedule_code    text,
    timezone         text,
    dedup_key        text,
    trace_id         text,
    parent_trace_id  text,
    -- Только безопасный код отказа. Текст ошибки внешнего сервиса может
    -- содержать переданные ему данные и сюда не попадает.
    error_code       text,
    failure_class    text,
    started_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT job_runs_status_check
        CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'lost')),
    CONSTRAINT job_runs_failure_class_check
        CHECK (failure_class IS NULL
               OR failure_class IN ('transient', 'permanent', 'indeterminate'))
);

DROP TRIGGER IF EXISTS trg_job_runs_updated_at ON job_runs;
CREATE TRIGGER trg_job_runs_updated_at
    BEFORE UPDATE ON job_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Поиск запусков с истёкшей арендой: их подбирает восстановление.
CREATE INDEX IF NOT EXISTS job_runs_lease_idx
    ON job_runs (lease_until)
    WHERE status = 'running';

CREATE INDEX IF NOT EXISTS job_runs_job_idx ON job_runs (job_id, started_at DESC);

-- ---------------------------------------------------------------------
-- Расписания.
--
-- Инвариант 9: на одно назначение — один планировщик. Каноническая копия
-- расписания лежит здесь, в BullMQ она только отражается, и при старте
-- сверяется (`JobScheduleRegistry.reconcile`). Состояние очереди
-- единственной копией расписания не является.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_schedules (
    code            text        PRIMARY KEY,
    queue           text        NOT NULL,
    job_type        text        NOT NULL,
    schema_version  integer     NOT NULL,
    cron            text        NOT NULL,
    timezone        text        NOT NULL DEFAULT 'Europe/Moscow',
    enabled         boolean     NOT NULL DEFAULT false,
    dedup_mode      text        NOT NULL DEFAULT 'simple',
    -- Только ссылка на payload и безопасные идентификаторы.
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    payload_ref     text,
    last_synced_at  timestamptz,
    last_enqueued_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT job_schedules_dedup_mode_check
        CHECK (dedup_mode IN ('simple', 'throttle', 'debounce', 'keep_last_if_active'))
);

DROP TRIGGER IF EXISTS trg_job_schedules_updated_at ON job_schedules;
CREATE TRIGGER trg_job_schedules_updated_at
    BEFORE UPDATE ON job_schedules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Мёртвые задания.
--
-- Только безопасные метаданные: очередь, тип, код отказа, счётчик
-- попыток и трасса. Payload сюда не копируется — разбирать отказ по
-- содержанию пользовательских данных запрещено, а по коду и трассе
-- можно.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_dead_letters (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id         text        NOT NULL,
    run_id         uuid,
    queue          text        NOT NULL,
    job_type       text        NOT NULL,
    schema_version integer,
    user_id        bigint      REFERENCES users (id) ON DELETE CASCADE,
    error_code     text        NOT NULL,
    failure_class  text,
    attempts       smallint    NOT NULL DEFAULT 0,
    trace_id       text,
    payload_checksum text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT job_dead_letters_failure_class_check
        CHECK (failure_class IS NULL
               OR failure_class IN ('transient', 'permanent', 'indeterminate'))
);

CREATE INDEX IF NOT EXISTS job_dead_letters_queue_idx
    ON job_dead_letters (queue, created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('035_bullmq_jobs')
ON CONFLICT (version) DO NOTHING;

COMMIT;
