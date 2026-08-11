-- =====================================================================
-- Шаг 16. Детектор эпизодов, Memory Curator и пользовательский контроль.
--
-- Эпизод — вход Curator, а не второй механизм извлечения. Существующие
-- `conversation_highlights` остаются тем, чем были: компактным индексом
-- значимых фрагментов. Эпизод ссылается на них и на исходные сообщения,
-- не копируя переписку в PostgreSQL (полное зеркало запрещено).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS memory_episodes (
    id              bigserial PRIMARY KEY,
    user_id         bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    conversation_id text NOT NULL,
    -- Ключ идемпотентности: одна и та же граница не открывает второй
    -- эпизод, сколько бы раз детектор ни сработал.
    episode_key     text NOT NULL,
    purpose         text NOT NULL DEFAULT 'chat',
    status          text NOT NULL DEFAULT 'open',
    boundary_reason text NOT NULL,
    summary         text,
    -- Ссылки на исходные сообщения, а не их содержимое.
    message_ids     text[] NOT NULL DEFAULT '{}'::text[],
    highlight_ids   bigint[] NOT NULL DEFAULT '{}'::bigint[],
    privacy_mode    text NOT NULL DEFAULT 'normal',
    message_count   integer NOT NULL DEFAULT 0,
    started_at      timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz,
    curated_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_episodes_status_check CHECK (status IN (
        'open', 'closed', 'curating', 'curated', 'skipped', 'failed'
    )),
    CONSTRAINT memory_episodes_boundary_check CHECK (boundary_reason IN (
        'topic_shift', 'turn_completed', 'inactivity',
        'explicit_important', 'before_compaction', 'manual'
    )),
    CONSTRAINT memory_episodes_privacy_check
        CHECK (privacy_mode IN ('normal', 'sensitive', 'private'))
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_episodes_key_uidx
    ON memory_episodes (user_id, episode_key);
CREATE INDEX IF NOT EXISTS memory_episodes_pending_idx
    ON memory_episodes (user_id, ended_at) WHERE status = 'closed';
CREATE INDEX IF NOT EXISTS memory_episodes_conversation_idx
    ON memory_episodes (user_id, conversation_id, started_at DESC);

-- Прогон Curator. Предпросмотр записывается сюда же и отличается только
-- режимом: иначе «показали и не записали» невозможно ни проверить, ни
-- разобрать по жалобе.
CREATE TABLE IF NOT EXISTS memory_curator_runs (
    id           bigserial PRIMARY KEY,
    user_id      bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    episode_id   bigint NOT NULL REFERENCES memory_episodes (id) ON DELETE CASCADE,
    run_id       text NOT NULL,
    mode         text NOT NULL DEFAULT 'apply',
    status       text NOT NULL DEFAULT 'pending',
    proposal     jsonb NOT NULL DEFAULT '{}'::jsonb,
    applied      jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_code   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_curator_runs_mode_check CHECK (mode IN ('apply', 'preview')),
    CONSTRAINT memory_curator_runs_status_check CHECK (status IN (
        'pending', 'succeeded', 'empty', 'invalid_result', 'failed'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_curator_runs_run_uidx
    ON memory_curator_runs (user_id, run_id);
CREATE INDEX IF NOT EXISTS memory_curator_runs_episode_idx
    ON memory_curator_runs (user_id, episode_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_memory_episodes_updated_at ON memory_episodes;
CREATE TRIGGER trg_memory_episodes_updated_at
    BEFORE UPDATE ON memory_episodes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_memory_curator_runs_updated_at ON memory_curator_runs;
CREATE TRIGGER trg_memory_curator_runs_updated_at
    BEFORE UPDATE ON memory_curator_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_migrations (version) VALUES ('043_memory_curator')
ON CONFLICT (version) DO NOTHING;

COMMIT;
