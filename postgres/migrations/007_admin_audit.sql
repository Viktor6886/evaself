-- =====================================================================
-- Evaself — аудит административной консоли
-- ---------------------------------------------------------------------
-- Не содержит API-ключей: сервер записывает только безопасные проекции
-- настроек агентов, диалогов и результат административного действия.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id           bigserial PRIMARY KEY,
    actor        text NOT NULL DEFAULT 'admin',
    action       text NOT NULL,
    target_type  text NOT NULL,
    target_id    text,
    status       text NOT NULL DEFAULT 'success',
    before_data  jsonb,
    after_data   jsonb,
    details      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT admin_audit_status_check
        CHECK (status IN ('success', 'failed', 'rolled_back'))
);

CREATE INDEX IF NOT EXISTS admin_audit_created_idx
    ON admin_audit_log (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_audit_target_idx
    ON admin_audit_log (target_type, target_id, created_at DESC);

-- Agent SDK 0.5.5 added the strict approval mode.
ALTER TABLE sdk_settings
    DROP CONSTRAINT IF EXISTS sdk_settings_permission_check;
ALTER TABLE sdk_settings
    DROP CONSTRAINT IF EXISTS sdk_settings_permission_mode_check;
ALTER TABLE sdk_settings
    ADD CONSTRAINT sdk_settings_permission_mode_check
        CHECK (permission_mode IN ('standard', 'acceptEdits', 'unrestricted', 'strict'));
ALTER TABLE sdk_settings
    ADD COLUMN IF NOT EXISTS reasoning_effort text NOT NULL DEFAULT 'none';
ALTER TABLE sdk_settings
    DROP CONSTRAINT IF EXISTS sdk_settings_reasoning_effort_check;
ALTER TABLE sdk_settings
    ADD CONSTRAINT sdk_settings_reasoning_effort_check
        CHECK (reasoning_effort IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh'));

INSERT INTO schema_migrations (version) VALUES ('007_admin_audit')
ON CONFLICT (version) DO NOTHING;

COMMIT;
