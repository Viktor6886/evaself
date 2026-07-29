-- =====================================================================
-- Evaself — safety indexes and removal of never-written schema
-- ---------------------------------------------------------------------
-- Two unrelated but small changes:
--
--   1. crisis_events is now actually written by the runtime, so it gets
--      the per-user index the operator views need.
--   2. Four tables have never been read or written by any component.
--      They are dropped, but ONLY when empty — an installation upgraded
--      from an older version that did put rows there keeps its data and
--      simply skips the drop.
--
-- Idempotent, like every other migration here.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. crisis_events is a live table now
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS crisis_events_user_idx
    ON crisis_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crisis_events_severity_idx
    ON crisis_events (severity, created_at DESC) WHERE handled = false;

-- ---------------------------------------------------------------------
-- 2. drop dead schema, but never data
-- ---------------------------------------------------------------------
DO $$
DECLARE
    candidate text;
    row_count bigint;
BEGIN
    FOREACH candidate IN ARRAY ARRAY[
        'test_results',
        'referrals',
        'partner_analysis_links',
        'notifications'
    ] LOOP
        IF to_regclass('public.' || candidate) IS NULL THEN
            CONTINUE;
        END IF;
        EXECUTE format('SELECT count(*) FROM %I', candidate) INTO row_count;
        IF row_count = 0 THEN
            EXECUTE format('DROP TABLE %I CASCADE', candidate);
            RAISE NOTICE 'dropped unused empty table %', candidate;
        ELSE
            RAISE WARNING
                'table % still holds % row(s) and was kept; remove it manually once the data is exported',
                candidate, row_count;
        END IF;
    END LOOP;
END
$$;

-- The `tests` quota metric belonged to test_results. Nothing increments it,
-- so it is removed from the plan matrix rather than shown to users as a
-- limit that never moves.
DELETE FROM quotas WHERE metric = 'tests';
DELETE FROM usage_counters WHERE metric = 'tests';

INSERT INTO schema_migrations (version) VALUES ('016_cleanup_and_safety')
ON CONFLICT (version) DO NOTHING;

COMMIT;
