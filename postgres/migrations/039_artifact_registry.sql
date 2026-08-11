-- 039. Единый реестр артефактов: prompts, flows, skills, policies и шаблоны
-- memory block.
--
-- Проверка по инварианту 20 выполнена, эквивалента нет. Ближайший
-- существующий механизм — `config_versions` из миграции 014, но это журнал
-- изменений «старое значение → новое значение по ключу»: он отвечает на
-- вопрос «кто и когда поменял настройку», а не «какая именно версия
-- артефакта работала в этом ходе». У него нет неизменяемой публикации, нет
-- указателя раскатки, нет отката одним действием и нет контрольной суммы
-- содержимого. Расширять его до реестра значило бы сломать его собственное
-- назначение — журнал обязан хранить и старое, и новое значение, а версия
-- артефакта обязана быть неизменяемой.
--
-- Четыре почти одинаковые системы версий не создаются: тип артефакта —
-- колонка, а не таблица. Prompt и flow остаются независимыми типами и
-- версионируются отдельно, но общей моделью.
--
-- Три уровня, и они разные по смыслу:
--   artifacts             — стабильное определение: что это за артефакт;
--   artifact_versions     — неизменяемое содержимое конкретной версии;
--   artifact_publications — указатель «что действует» в окружении.
-- Откат меняет указатель и не переписывает историю.

BEGIN;

CREATE TABLE IF NOT EXISTS artifacts (
    id            bigserial   PRIMARY KEY,

    -- Тип закрыт списком: новый тип — это осознанное изменение схемы, а не
    -- случайная строка. Шаблон memory block здесь наравне с остальными;
    -- отдельного реестра шаблонов не существует.
    kind          text        NOT NULL
                              CHECK (kind IN (
                                  'prompt', 'flow', 'skill', 'policy',
                                  'memory_block_template'
                              )),

    -- Стабильный идентификатор внутри типа. Именно он переживает все версии
    -- и на него ссылается публикация.
    slug          text        NOT NULL
                              CHECK (slug ~ '^[a-z][a-z0-9_.-]{0,126}[a-z0-9]$'),

    title         text        NOT NULL CHECK (length(btrim(title)) > 0),
    description   text        NOT NULL DEFAULT '',

    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid        REFERENCES admin_users (id) ON DELETE SET NULL,

    -- Архивация вместо удаления: на версии ссылаются прогоны, и удаление
    -- определения означало бы потерю возможности объяснить прошлый ход.
    archived_at   timestamptz,

    CONSTRAINT artifacts_kind_slug_key UNIQUE (kind, slug)
);

CREATE TABLE IF NOT EXISTS artifact_versions (
    id             bigserial   PRIMARY KEY,
    artifact_id    bigint      NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,

    -- Номер версии в пределах артефакта. Растёт и не переиспользуется.
    version        integer     NOT NULL CHECK (version >= 1),

    -- Содержимое версии. Форма зависит от типа и проверяется кодом: схема
    -- не может знать, что считается валидным flow.
    body           jsonb       NOT NULL,

    -- Контрольная сумма содержимого. Нужна, чтобы отличить «то же самое под
    -- другим номером» от настоящего изменения, и чтобы публикация могла
    -- сослаться на содержимое, а не только на номер.
    checksum       text        NOT NULL CHECK (checksum ~ '^[0-9a-f]{16,64}$'),

    -- Родительская версия: от чего эта версия произошла. NULL только у
    -- первой. Нужна семантическому diff и разбору истории.
    parent_id      bigint      REFERENCES artifact_versions (id) ON DELETE SET NULL,

    -- Жизненный цикл версии. `draft` можно дорабатывать, всё остальное —
    -- нет: неизменяемость держит триггер ниже, а не соглашение.
    status         text        NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft', 'candidate', 'approved', 'archived')),

    -- Результат валидации и тестов. Публиковать версию без пройденной
    -- валидации запрещает код; здесь хранится сам факт и его подробности.
    validation     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    test_result    jsonb,

    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid        REFERENCES admin_users (id) ON DELETE SET NULL,
    approved_at    timestamptz,
    approved_by    uuid        REFERENCES admin_users (id) ON DELETE SET NULL,

    -- Пары «кто и когда» здесь намеренно НЕ требуется. Учётную запись
    -- администратора могут удалить, и тогда `approved_by` станет NULL по
    -- `ON DELETE SET NULL` — а это UPDATE, который такой CHECK отверг бы,
    -- заодно запретив удаление самой учётной записи. Факт «утверждено
    -- тогда-то» переживает удаление автора; имя — нет, и это нормально.
    CONSTRAINT artifact_versions_number_key UNIQUE (artifact_id, version)
);

CREATE INDEX IF NOT EXISTS artifact_versions_artifact_idx
    ON artifact_versions (artifact_id, version DESC);

CREATE INDEX IF NOT EXISTS artifact_versions_checksum_idx
    ON artifact_versions (artifact_id, checksum);

/*
 * Неизменяемость на уровне схемы.
 *
 * Требование шага: «Опубликованную версию нельзя изменить: запрет
 * реализуется на уровне схемы, а не соглашением». В PostgreSQL это триггер —
 * `CHECK` не видит прежнюю строку и потому не может запретить изменение.
 *
 * Запрет шире, чем «опубликованную»: содержимое версии неизменяемо всегда,
 * с момента выхода из черновика. Иначе воспроизводимость держалась бы на
 * том, что никто не отредактировал кандидата, на который уже сослался
 * прогон. Меняться после черновика вправе только жизненный цикл: статус,
 * утверждение и результат тестов.
 */
CREATE OR REPLACE FUNCTION artifact_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION
                'версия % артефакта % не черновик и не удаляется: на неё могли сослаться прогоны',
                OLD.version, OLD.artifact_id
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status <> 'draft' THEN
        IF NEW.body IS DISTINCT FROM OLD.body
           OR NEW.checksum IS DISTINCT FROM OLD.checksum
           OR NEW.version IS DISTINCT FROM OLD.version
           OR NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
           OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
            RAISE EXCEPTION
                'содержимое версии % артефакта % неизменяемо: заведите новую версию',
                OLD.version, OLD.artifact_id
                USING ERRCODE = 'restrict_violation';
        END IF;
        -- Возврат в черновик — это тихая правка задним числом.
        IF NEW.status = 'draft' THEN
            RAISE EXCEPTION 'версия % артефакта % не возвращается в черновик',
                OLD.version, OLD.artifact_id
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS artifact_versions_immutable_trg ON artifact_versions;
CREATE TRIGGER artifact_versions_immutable_trg
    BEFORE UPDATE OR DELETE ON artifact_versions
    FOR EACH ROW EXECUTE FUNCTION artifact_versions_immutable();

CREATE TABLE IF NOT EXISTS artifact_publications (
    id                bigserial   PRIMARY KEY,
    artifact_id       bigint      NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,

    -- Окружение или метка раскатки. Один артефакт может действовать
    -- по-разному в canary и production.
    environment       text        NOT NULL
                                  CHECK (environment ~ '^[a-z][a-z0-9_-]{0,31}$'),

    version_id        bigint      NOT NULL REFERENCES artifact_versions (id) ON DELETE RESTRICT,

    -- Процент раскатки. 0 означает «объявлено, но никому не выдаётся».
    rollout_percent   integer     NOT NULL DEFAULT 100
                                  CHECK (rollout_percent BETWEEN 0 AND 100),

    -- На что откатываться одним действием. Заполняется публикацией
    -- автоматически: без этого откат требовал бы разбора истории руками.
    previous_version_id bigint    REFERENCES artifact_versions (id) ON DELETE SET NULL,

    published_at      timestamptz NOT NULL DEFAULT now(),
    published_by      uuid        REFERENCES admin_users (id) ON DELETE SET NULL,
    -- Причина, обязательная для отката: «почему откатили» теряется первым.
    reason            text        NOT NULL DEFAULT '',

    -- Снятая публикация остаётся строкой истории. Действует ровно одна.
    retired_at        timestamptz
);

-- Один действующий указатель на артефакт в окружении. Ограничение частичное:
-- снятые публикации не мешают опубликовать следующую.
CREATE UNIQUE INDEX IF NOT EXISTS artifact_publications_active_uidx
    ON artifact_publications (artifact_id, environment)
    WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS artifact_publications_history_idx
    ON artifact_publications (artifact_id, environment, published_at DESC);

/*
 * Какие версии артефактов участвовали в прогоне.
 *
 * Общая таблица, а не колонка в каждой таблице прогонов: ход, задание,
 * вызов инструмента, инсайт, исследование и прогон evals — разные сущности
 * с разными сроками хранения, но вопрос к ним один и тот же. Внешнего ключа
 * на прогон нет намеренно: прогоны живут своими сроками хранения, и запись
 * о версии не должна мешать их очистке.
 */
CREATE TABLE IF NOT EXISTS artifact_usages (
    id            bigserial   PRIMARY KEY,

    run_kind      text        NOT NULL
                              CHECK (run_kind IN (
                                  'turn', 'job', 'tool_call', 'insight',
                                  'research', 'eval'
                              )),
    run_id        text        NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128),

    version_id    bigint      NOT NULL REFERENCES artifact_versions (id) ON DELETE RESTRICT,

    recorded_at   timestamptz NOT NULL DEFAULT now(),

    -- Один прогон фиксирует одну версию артефакта один раз.
    CONSTRAINT artifact_usages_run_version_key UNIQUE (run_kind, run_id, version_id)
);

CREATE INDEX IF NOT EXISTS artifact_usages_run_idx
    ON artifact_usages (run_kind, run_id);

CREATE INDEX IF NOT EXISTS artifact_usages_version_idx
    ON artifact_usages (version_id);

INSERT INTO schema_migrations (version)
VALUES ('039_artifact_registry')
ON CONFLICT (version) DO NOTHING;

COMMIT;
