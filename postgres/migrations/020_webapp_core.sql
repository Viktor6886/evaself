-- =====================================================================
-- Evaself WebApp v3: серверный check-in, главный результат дня, решения
-- и фокус-сессии.
--
-- Существующие tasks, eva_notes и budget_entries остаются единственным
-- источником правды и для инструментов Agent SDK, и для Mini App —
-- параллельного хранилища здесь не заводится.
--
-- Приведено к соглашениям репозитория: транзакция, отметка в
-- schema_migrations, триггеры updated_at и обратимый down.
-- =====================================================================

BEGIN;

-- Evaself WebApp v3: server-side check-in, daily focus, decisions and focus sessions.
-- Existing tasks, eva_notes and budget_entries remain the single source of truth
-- for both Agent SDK tools and the Telegram Mini App.

ALTER TABLE eva_notes
  ADD COLUMN IF NOT EXISTS entry_type text NOT NULL DEFAULT 'note';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'eva_notes_entry_type_check'
  ) THEN
    ALTER TABLE eva_notes
      ADD CONSTRAINT eva_notes_entry_type_check
      CHECK (entry_type IN ('note', 'journal', 'insight', 'decision'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS eva_notes_user_type_updated_idx
  ON eva_notes (user_id, entry_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_checkins (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  mood text NOT NULL CHECK (mood IN ('very_low', 'low', 'neutral', 'good', 'great')),
  energy smallint NOT NULL CHECK (energy BETWEEN 1 AND 10),
  tension smallint NOT NULL CHECK (tension BETWEEN 1 AND 10),
  note text,
  source text NOT NULL DEFAULT 'webapp' CHECK (source IN ('webapp', 'telegram', 'import')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_date)
);

CREATE INDEX IF NOT EXISTS user_checkins_user_date_idx
  ON user_checkins (user_id, local_date DESC);

CREATE TABLE IF NOT EXISTS daily_focus_selections (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  title text NOT NULL,
  source_type text NOT NULL DEFAULT 'manual',
  source_id text,
  source_label text NOT NULL DEFAULT 'Выбрано вручную',
  expected_result text,
  is_manual boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_date)
);

CREATE INDEX IF NOT EXISTS daily_focus_user_date_idx
  ON daily_focus_selections (user_id, local_date DESC);

CREATE TABLE IF NOT EXISTS eva_decisions (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_option text,
  confidence smallint CHECK (confidence BETWEEN 0 AND 100),
  reversible boolean,
  cheap_test text,
  review_at date,
  actual_result text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'review', 'completed', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eva_decisions_user_status_review_idx
  ON eva_decisions (user_id, status, review_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS eva_focus_sessions (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  planned_minutes integer NOT NULL DEFAULT 15 CHECK (planned_minutes BETWEEN 1 AND 480),
  actual_minutes integer CHECK (actual_minutes BETWEEN 0 AND 10080),
  actual_result text,
  source_type text,
  source_id text,
  work_block_id bigint REFERENCES work_blocks(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'canceled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eva_focus_sessions_user_started_idx
  ON eva_focus_sessions (user_id, started_at DESC);

COMMENT ON TABLE user_checkins IS
  'Daily non-medical mood, energy and tension check-in used by WebApp summaries.';
COMMENT ON TABLE daily_focus_selections IS
  'Optional user override for the automatically derived main result of the local day.';
COMMENT ON TABLE eva_decisions IS
  'Structured decision cards: alternatives, facts, assumptions, risks and later review.';
COMMENT ON TABLE eva_focus_sessions IS
  'Lightweight focus sessions; may reference an existing VECTOR work block.';

-- В остальных таблицах updated_at поддерживает общий триггер; без него
-- колонка навсегда осталась бы равной created_at.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_checkins', 'daily_focus_selections',
                           'eva_decisions', 'eva_focus_sessions']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

INSERT INTO schema_migrations (version) VALUES ('020_webapp_core')
ON CONFLICT (version) DO NOTHING;

COMMIT;
