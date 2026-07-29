-- =====================================================================
-- VECTOR-Action: направления, цели, результаты, действия и обзоры
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_north (
    user_id             bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    desired_direction   text,
    why_it_matters      text,
    values              jsonb NOT NULL DEFAULT '[]'::jsonb,
    acceptable_cost     text,
    unacceptable_cost   text,
    conflicts           jsonb NOT NULL DEFAULT '[]'::jsonb,
    reduce_list         jsonb NOT NULL DEFAULT '[]'::jsonb,
    user_confirmed      boolean NOT NULL DEFAULT false,
    confirmed_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS goals (
    id                  bigserial PRIMARY KEY,
    user_id             bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    parent_goal_id      bigint REFERENCES goals (id) ON DELETE SET NULL,
    life_area           text,
    horizon             text,
    title               text NOT NULL,
    why_it_matters      text,
    result_artifact     text,
    target_date         date,
    success_criteria    jsonb NOT NULL DEFAULT '[]'::jsonb,
    minimum_version     text,
    target_version      text,
    constraints         jsonb NOT NULL DEFAULT '[]'::jsonb,
    learning_goal       text,
    review_condition    text,
    stop_condition      text,
    priority            integer NOT NULL DEFAULT 3,
    status              text NOT NULL DEFAULT 'draft',
    vector_stage        text NOT NULL DEFAULT 'north',
    user_confirmed      boolean NOT NULL DEFAULT false,
    confirmed_at        timestamptz,
    last_progress_at    timestamptz,
    next_review_at      timestamptz,
    completed_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT goals_status_check
        CHECK (status IN ('draft', 'active', 'paused', 'completed', 'abandoned')),
    CONSTRAINT goals_vector_stage_check
        CHECK (vector_stage IN ('north', 'result', 'map', 'action', 'feedback', 'review')),
    CONSTRAINT goals_priority_check CHECK (priority BETWEEN 1 AND 5),
    CONSTRAINT goals_activation_check CHECK (status <> 'active' OR user_confirmed)
);

CREATE INDEX IF NOT EXISTS goals_user_status_idx
    ON goals (user_id, status, priority, updated_at DESC);
CREATE INDEX IF NOT EXISTS goals_review_idx
    ON goals (next_review_at)
    WHERE status = 'active';

CREATE TABLE IF NOT EXISTS goal_results (
    id                    bigserial PRIMARY KEY,
    user_id               bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    goal_id               bigint NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
    parent_result_id      bigint REFERENCES goal_results (id) ON DELETE SET NULL,
    title                 text NOT NULL,
    result_artifact       text,
    success_criteria      jsonb NOT NULL DEFAULT '[]'::jsonb,
    minimum_version       text,
    target_date           date,
    sort_order            integer NOT NULL DEFAULT 100,
    status                text NOT NULL DEFAULT 'draft',
    is_checkpoint         boolean NOT NULL DEFAULT false,
    is_external           boolean NOT NULL DEFAULT false,
    external_dependency   text,
    is_critical_path      boolean NOT NULL DEFAULT false,
    fallback_plan         text,
    first_action          text,
    progress_percent      integer NOT NULL DEFAULT 0,
    completed_at          timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT goal_results_status_check
        CHECK (status IN ('draft', 'ready', 'in_progress', 'completed', 'blocked', 'skipped')),
    CONSTRAINT goal_results_progress_check CHECK (progress_percent BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS goal_results_goal_idx
    ON goal_results (goal_id, status, sort_order, id);
CREATE INDEX IF NOT EXISTS goal_results_user_idx
    ON goal_results (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS goal_dependencies (
    id                    bigserial PRIMARY KEY,
    user_id               bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    goal_id               bigint NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
    result_id             bigint NOT NULL REFERENCES goal_results (id) ON DELETE CASCADE,
    depends_on_result_id  bigint REFERENCES goal_results (id) ON DELETE CASCADE,
    external_dependency   text,
    dependency_type       text NOT NULL DEFAULT 'finish_to_start',
    is_blocking           boolean NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT goal_dependencies_target_check
        CHECK (depends_on_result_id IS NOT NULL OR external_dependency IS NOT NULL),
    CONSTRAINT goal_dependencies_not_self_check
        CHECK (depends_on_result_id IS NULL OR depends_on_result_id <> result_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS goal_dependencies_result_uidx
    ON goal_dependencies (result_id, depends_on_result_id)
    WHERE depends_on_result_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS goal_dependencies_goal_idx
    ON goal_dependencies (goal_id, result_id);

CREATE TABLE IF NOT EXISTS work_blocks (
    id                    bigserial PRIMARY KEY,
    user_id               bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    goal_id               bigint NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
    goal_result_id        bigint REFERENCES goal_results (id) ON DELETE SET NULL,
    intention             text NOT NULL,
    first_physical_step   text,
    planned_start_at      timestamptz,
    planned_minutes       integer,
    if_then_rule          text,
    completion_criterion  text,
    status                text NOT NULL DEFAULT 'planned',
    started_at            timestamptz,
    completed_at          timestamptz,
    actual_minutes        integer,
    actual_result         text,
    artifact              text,
    obstacle              text,
    helpful_factor        text,
    next_step             text,
    energy_before         integer,
    energy_after          integer,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT work_blocks_status_check
        CHECK (status IN ('planned', 'active', 'completed', 'canceled')),
    CONSTRAINT work_blocks_minutes_check
        CHECK (
            (planned_minutes IS NULL OR planned_minutes BETWEEN 1 AND 1440)
            AND (actual_minutes IS NULL OR actual_minutes BETWEEN 0 AND 10080)
        ),
    CONSTRAINT work_blocks_energy_check
        CHECK (
            (energy_before IS NULL OR energy_before BETWEEN 1 AND 5)
            AND (energy_after IS NULL OR energy_after BETWEEN 1 AND 5)
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS work_blocks_one_active_per_user_uidx
    ON work_blocks (user_id)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS work_blocks_user_status_idx
    ON work_blocks (user_id, status, planned_start_at, id);
CREATE INDEX IF NOT EXISTS work_blocks_goal_idx
    ON work_blocks (goal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goal_reviews (
    id                  bigserial PRIMARY KEY,
    user_id             bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    goal_id             bigint NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
    work_block_id       bigint REFERENCES work_blocks (id) ON DELETE SET NULL,
    review_type         text NOT NULL DEFAULT 'deviation',
    fact                text NOT NULL,
    system_signal       text,
    changed_element     text,
    next_small_step     text,
    plan_snapshot       jsonb NOT NULL DEFAULT '{}'::jsonb,
    fact_snapshot       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT goal_reviews_type_check
        CHECK (review_type IN ('feedback', 'deviation', 'checkpoint', 'weekly', 'completion'))
);

CREATE INDEX IF NOT EXISTS goal_reviews_goal_idx
    ON goal_reviews (goal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goal_recommendations (
    id                  bigserial PRIMARY KEY,
    user_id             bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    goal_id             bigint NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
    review_id           bigint REFERENCES goal_reviews (id) ON DELETE CASCADE,
    recommendation      text NOT NULL,
    changed_element     text,
    next_small_step     text,
    status              text NOT NULL DEFAULT 'proposed',
    accepted_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT goal_recommendations_status_check
        CHECK (status IN ('proposed', 'accepted', 'declined', 'superseded'))
);

CREATE INDEX IF NOT EXISTS goal_recommendations_user_idx
    ON goal_recommendations (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS user_strategies (
    id                  bigserial PRIMARY KEY,
    user_id             bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    goal_id             bigint REFERENCES goals (id) ON DELETE CASCADE,
    title               text NOT NULL,
    description         text NOT NULL,
    evidence            jsonb NOT NULL DEFAULT '[]'::jsonb,
    status              text NOT NULL DEFAULT 'candidate',
    uses_count          integer NOT NULL DEFAULT 0,
    last_used_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_strategies_status_check
        CHECK (status IN ('candidate', 'confirmed', 'retired'))
);

CREATE INDEX IF NOT EXISTS user_strategies_user_idx
    ON user_strategies (user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS learning_attempts (
    id                  bigserial PRIMARY KEY,
    user_id             bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    goal_id             bigint REFERENCES goals (id) ON DELETE CASCADE,
    goal_result_id      bigint REFERENCES goal_results (id) ON DELETE SET NULL,
    work_block_id       bigint REFERENCES work_blocks (id) ON DELETE SET NULL,
    hypothesis          text NOT NULL,
    action_taken        text,
    outcome             text,
    lesson              text,
    next_experiment     text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS learning_attempts_user_idx
    ON learning_attempts (user_id, created_at DESC);

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS goal_id bigint REFERENCES goals (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS goal_result_id bigint REFERENCES goal_results (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS work_block_id bigint REFERENCES work_blocks (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS estimated_minutes integer,
    ADD COLUMN IF NOT EXISTS energy_required integer;

ALTER TABLE tasks
    DROP CONSTRAINT IF EXISTS tasks_estimated_minutes_check;
ALTER TABLE tasks
    ADD CONSTRAINT tasks_estimated_minutes_check
        CHECK (estimated_minutes IS NULL OR estimated_minutes BETWEEN 1 AND 1440);
ALTER TABLE tasks
    DROP CONSTRAINT IF EXISTS tasks_energy_required_check;
ALTER TABLE tasks
    ADD CONSTRAINT tasks_energy_required_check
        CHECK (energy_required IS NULL OR energy_required BETWEEN 1 AND 5);

CREATE INDEX IF NOT EXISTS tasks_goal_idx
    ON tasks (goal_id, goal_result_id, status);
CREATE INDEX IF NOT EXISTS tasks_work_block_idx
    ON tasks (work_block_id)
    WHERE work_block_id IS NOT NULL;

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'user_north',
        'goals',
        'goal_results',
        'work_blocks',
        'goal_recommendations',
        'user_strategies',
        'learning_attempts'
    ] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS %I ON %I',
            'trg_' || table_name || '_updated_at',
            table_name
        );
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
            'trg_' || table_name || '_updated_at',
            table_name
        );
    END LOOP;
END
$$;

INSERT INTO schema_migrations (version) VALUES ('011_vector_action')
ON CONFLICT (version) DO NOTHING;

COMMIT;
