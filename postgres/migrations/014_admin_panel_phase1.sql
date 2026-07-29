-- =====================================================================
-- Evaself Admin — фаза 1: доступ, конфигурация, секреты и аудит
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_users (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    username            text NOT NULL,
    password_hash       text NOT NULL,
    role                text NOT NULL,
    status              text NOT NULL DEFAULT 'active',
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_login_at       timestamptz,
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    failed_attempts     integer NOT NULL DEFAULT 0,
    locked_until        timestamptz,
    CONSTRAINT admin_users_role_check
        CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
    CONSTRAINT admin_users_status_check
        CHECK (status IN ('active', 'disabled')),
    CONSTRAINT admin_users_failed_attempts_check CHECK (failed_attempts >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username_uidx
    ON admin_users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_single_owner_uidx
    ON admin_users (role) WHERE role = 'owner';

CREATE TABLE IF NOT EXISTS admin_sessions (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    token_hash  bytea NOT NULL UNIQUE,
    csrf_hash   bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    ip          inet,
    user_agent  text,
    revoked_at  timestamptz,
    CONSTRAINT admin_sessions_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS admin_sessions_user_active_idx
    ON admin_sessions (user_id, expires_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx
    ON admin_sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS sudo_grants (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id  uuid NOT NULL REFERENCES admin_sessions (id) ON DELETE CASCADE,
    granted_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    scope       text NOT NULL,
    revoked_at  timestamptz,
    CONSTRAINT sudo_grants_scope_check
        CHECK (scope ~ '^[a-z][a-z0-9_-]*:[a-z*][a-z0-9_*-]*$'),
    CONSTRAINT sudo_grants_expiry_check CHECK (expires_at > granted_at)
);

CREATE INDEX IF NOT EXISTS sudo_grants_session_scope_idx
    ON sudo_grants (session_id, scope, expires_at DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS system_settings (
    key          text PRIMARY KEY,
    value_json   jsonb NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   uuid REFERENCES admin_users (id) ON DELETE SET NULL,
    version      bigint NOT NULL DEFAULT 1,
    CONSTRAINT system_settings_key_check
        CHECK (key ~ '^[a-z][a-z0-9_.-]*$'),
    CONSTRAINT system_settings_version_check CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS config_versions (
    id             bigserial PRIMARY KEY,
    scope          text NOT NULL,
    key            text NOT NULL,
    old_value_json jsonb,
    new_value_json jsonb,
    changed_at     timestamptz NOT NULL DEFAULT now(),
    changed_by     uuid REFERENCES admin_users (id) ON DELETE SET NULL,
    CONSTRAINT config_versions_scope_check
        CHECK (scope ~ '^[a-z][a-z0-9_.-]*$')
);

CREATE INDEX IF NOT EXISTS config_versions_key_idx
    ON config_versions (scope, key, changed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS secret_records (
    secret_ref      text PRIMARY KEY,
    ciphertext      bytea NOT NULL,
    nonce           bytea NOT NULL,
    auth_tag        bytea NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_rotated_at timestamptz NOT NULL DEFAULT now(),
    rotated_by      uuid REFERENCES admin_users (id) ON DELETE SET NULL,
    used_by_json    jsonb NOT NULL DEFAULT '[]'::jsonb,
    status          text NOT NULL DEFAULT 'active',
    CONSTRAINT secret_records_ref_check
        CHECK (secret_ref ~ '^sec_[a-z0-9_]+$'),
    CONSTRAINT secret_records_nonce_check CHECK (octet_length(nonce) = 12),
    CONSTRAINT secret_records_tag_check CHECK (octet_length(auth_tag) = 16),
    CONSTRAINT secret_records_used_by_check CHECK (jsonb_typeof(used_by_json) = 'array'),
    CONSTRAINT secret_records_status_check
        CHECK (status IN ('active', 'disabled'))
);

CREATE INDEX IF NOT EXISTS secret_records_status_idx
    ON secret_records (status, secret_ref);

CREATE TABLE IF NOT EXISTS audit_log (
    id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    at                   timestamptz NOT NULL DEFAULT now(),
    completed_at         timestamptz,
    actor_user_id        uuid REFERENCES admin_users (id) ON DELETE SET NULL,
    actor                text NOT NULL DEFAULT 'anonymous',
    role                 text,
    ip                   inet,
    operation            text NOT NULL,
    target               text,
    params_redacted_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    result               text NOT NULL DEFAULT 'pending',
    request_id           text NOT NULL,
    duration_ms          integer,
    message              text,
    CONSTRAINT audit_log_result_check
        CHECK (result IN ('pending', 'success', 'failure')),
    CONSTRAINT audit_log_duration_check
        CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX IF NOT EXISTS audit_log_request_operation_idx
    ON audit_log (request_id, operation);
CREATE INDEX IF NOT EXISTS audit_log_at_idx
    ON audit_log (at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx
    ON audit_log (actor_user_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_target_idx
    ON audit_log (target, at DESC);

INSERT INTO schema_migrations (version) VALUES ('014_admin_panel_phase1')
ON CONFLICT (version) DO NOTHING;

COMMIT;
