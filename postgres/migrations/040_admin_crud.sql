-- 040. Массовое применение шаблона memory block из административной панели.
--
-- Проверка по инварианту 20 выполнена, эквивалента нет.
--
-- Что уже есть и переиспользуется вместо новых сущностей:
--   * версии и публикации шаблонов — `artifacts`, `artifact_versions`,
--     `artifact_publications` из миграции 039. Второй реестр шаблонов не
--     создаётся: шаблон memory block — это тип артефакта, а не своя система
--     версий;
--   * намерение записать блок конкретному агенту — `letta_memory_block_sync`
--     из миграции 038. Применение шаблона не пишет в Letta напрямую и не
--     заводит второй путь записи: оно кладёт намерение в ту же таблицу,
--     откуда его забирает существующая синхронизация.
--
-- Чего нигде нет и ради чего заводятся эти две таблицы: факт «шаблон такой-то
-- версии применён к такому-то набору агентов, с такими исключениями, с таким
-- исходом по каждому». Без него массовое применение нельзя ни показать, ни
-- откатить: `letta_memory_block_sync` хранит текущее намерение по агенту и
-- метке и о том, откуда оно взялось, ничего не знает.
--
-- Откат устроен указателем, а не хранением прежних значений: откат применяет
-- РОДИТЕЛЬСКУЮ версию шаблона к тому же набору агентов и записывается новым
-- прогоном. Поэтому здесь нет ни одной колонки с текстом памяти — только
-- отпечатки. Копировать содержимое блоков в таблицу истории значило бы
-- размножить персональные данные ради возможности, которую даёт версия
-- шаблона.

BEGIN;

CREATE TABLE IF NOT EXISTS memory_template_applications (
    id             bigserial   PRIMARY KEY,

    artifact_id    bigint      NOT NULL REFERENCES artifacts (id) ON DELETE RESTRICT,
    -- Какая именно версия шаблона применялась. RESTRICT, а не CASCADE:
    -- удаление версии стёрло бы объяснение уже случившегося применения.
    version_id     bigint      NOT NULL REFERENCES artifact_versions (id) ON DELETE RESTRICT,

    -- К кому применяли. `group` — перечисленный набор агентов, `all` — все
    -- агенты установки. Шаблона новых агентов здесь нет намеренно: он
    -- задаётся публикацией версии и существующих агентов не трогает.
    scope          text        NOT NULL CHECK (scope IN ('agent', 'group', 'all')),

    -- Кого выбрали и кого исключили. Массивы идентификаторов агентов Letta,
    -- а не пользователей: исключение задаётся тем же, чем и выбор.
    targets        text[]      NOT NULL DEFAULT ARRAY[]::text[],
    excluded       text[]      NOT NULL DEFAULT ARRAY[]::text[],

    -- Предпросмотр остаётся в истории наравне с применением: «что
    -- предлагали и не сделали» — такой же факт, как «что сделали».
    dry_run        boolean     NOT NULL DEFAULT true,
    status         text        NOT NULL DEFAULT 'previewed'
                               CHECK (status IN ('previewed', 'applied', 'failed')),

    -- Счётчики исходов. Только числа: ни одной строки памяти.
    counts         jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- Прогон, который этот прогон откатывает. Откат — это ещё одно
    -- применение, а не удаление предыдущего: история не переписывается.
    reverts_id     bigint      REFERENCES memory_template_applications (id) ON DELETE SET NULL,

    reason         text        NOT NULL DEFAULT '',
    requested_by   uuid        REFERENCES admin_users (id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_template_applications_recent_idx
    ON memory_template_applications (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS memory_template_applications_version_idx
    ON memory_template_applications (version_id);

/*
 * Построчный исход применения: агент, метка, что было и что стало.
 *
 * Значений блоков здесь нет — только отпечатки. Их достаточно, чтобы
 * показать, что именно разошлось, и недостаточно, чтобы прочитать чужую
 * память из журнала применений.
 */
CREATE TABLE IF NOT EXISTS memory_template_application_items (
    id                 bigserial PRIMARY KEY,
    application_id     bigint    NOT NULL
                                 REFERENCES memory_template_applications (id) ON DELETE CASCADE,

    -- Владелец агента. Строка принадлежит пользователю Евы, поэтому
    -- таблица объявлена пользовательской в `src/tenancy/tables.ts`.
    user_id            bigint    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    agent_id           text      NOT NULL,

    label              text      NOT NULL
                                 CHECK (label IN (
                                     'persona', 'human', 'current_state',
                                     'goals_and_commitments',
                                     'relationships_and_patterns',
                                     'progress_and_hypotheses'
                                 )),

    previous_checksum  text,
    next_checksum      text      NOT NULL,

    -- `excluded` — агент исключён человеком; `unchanged` — значение уже
    -- такое же; `recorded` — намерение записано в letta_memory_block_sync
    -- (в предпросмотре — «будет записано»); `skipped` — агент не в рабочем
    -- состоянии; `failed` — запись отказала.
    outcome            text      NOT NULL
                                 CHECK (outcome IN (
                                     'excluded', 'unchanged', 'recorded',
                                     'skipped', 'failed'
                                 )),
    detail             text      NOT NULL DEFAULT '',
    created_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT memory_template_items_unique UNIQUE (application_id, agent_id, label)
);

CREATE INDEX IF NOT EXISTS memory_template_items_agent_idx
    ON memory_template_application_items (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS memory_template_items_user_idx
    ON memory_template_application_items (user_id, created_at DESC);

COMMENT ON TABLE memory_template_applications IS
    'Прогоны применения шаблона memory block: предпросмотр, применение, откат.';
COMMENT ON TABLE memory_template_application_items IS
    'Построчный исход применения шаблона. Значений блоков не содержит, только отпечатки.';

INSERT INTO schema_migrations (version)
VALUES ('040_admin_crud')
ON CONFLICT (version) DO NOTHING;

COMMIT;
