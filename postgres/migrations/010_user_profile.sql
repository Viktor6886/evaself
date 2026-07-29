-- =====================================================================
-- Постепенно заполняемый профиль пользователя
-- =====================================================================

BEGIN;

ALTER TABLE onboarding_fields
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'missing',
    ADD COLUMN IF NOT EXISTS confidence numeric(4,3),
    ADD COLUMN IF NOT EXISTS source_type text,
    ADD COLUMN IF NOT EXISTS source_id text,
    ADD COLUMN IF NOT EXISTS source_quote text,
    ADD COLUMN IF NOT EXISTS last_asked_at timestamptz,
    ADD COLUMN IF NOT EXISTS ask_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS declined_at timestamptz,
    ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
    ADD COLUMN IF NOT EXISTS sensitivity text NOT NULL DEFAULT 'normal',
    ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE onboarding_fields
   SET status = 'confirmed',
       confidence = COALESCE(confidence, 1),
       source_type = COALESCE(source_type, 'legacy'),
       confirmed_at = COALESCE(confirmed_at, answered_at)
 WHERE status = 'missing'
   AND (field_value IS NOT NULL OR field_json IS NOT NULL);

ALTER TABLE onboarding_fields
    DROP CONSTRAINT IF EXISTS onboarding_fields_status_check;
ALTER TABLE onboarding_fields
    ADD CONSTRAINT onboarding_fields_status_check
        CHECK (status IN (
            'missing', 'candidate', 'confirmed', 'declined',
            'not_applicable', 'superseded'
        ));
ALTER TABLE onboarding_fields
    DROP CONSTRAINT IF EXISTS onboarding_fields_confidence_check;
ALTER TABLE onboarding_fields
    ADD CONSTRAINT onboarding_fields_confidence_check
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
ALTER TABLE onboarding_fields
    DROP CONSTRAINT IF EXISTS onboarding_fields_sensitivity_check;
ALTER TABLE onboarding_fields
    ADD CONSTRAINT onboarding_fields_sensitivity_check
        CHECK (sensitivity IN ('normal', 'sensitive', 'high'));

CREATE TABLE IF NOT EXISTS profile_field_definitions (
    field_key              text PRIMARY KEY,
    title                  text NOT NULL,
    value_type             text NOT NULL,
    priority               integer NOT NULL DEFAULT 100,
    required_level         text NOT NULL DEFAULT 'optional',
    sensitivity            text NOT NULL DEFAULT 'normal',
    prompt_hint            text NOT NULL,
    confirmation_required  boolean NOT NULL DEFAULT false,
    cooldown_days          integer NOT NULL DEFAULT 14,
    max_ask_count          integer NOT NULL DEFAULT 3,
    enabled                boolean NOT NULL DEFAULT true,
    sort_order             integer NOT NULL DEFAULT 100,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT profile_definition_value_type_check
        CHECK (value_type IN ('string', 'string_array', 'object')),
    CONSTRAINT profile_definition_required_check
        CHECK (required_level IN ('essential', 'useful', 'optional')),
    CONSTRAINT profile_definition_sensitivity_check
        CHECK (sensitivity IN ('normal', 'sensitive', 'high')),
    CONSTRAINT profile_definition_cooldown_check
        CHECK (cooldown_days >= 0 AND max_ask_count >= 0)
);

INSERT INTO profile_field_definitions
    (field_key, title, value_type, priority, required_level, sensitivity,
     prompt_hint, confirmation_required, cooldown_days, max_ask_count, sort_order)
VALUES
    ('preferred_name', 'Как обращаться', 'string', 10, 'essential', 'normal',
     'Если это естественно связано с беседой, уточни, как лучше обращаться. Не превращай разговор в анкету.', false, 7, 3, 10),
    ('city', 'Город', 'string', 20, 'useful', 'normal',
     'Если место проживания важно для текущей темы, аккуратно уточни город или часовой пояс.', false, 14, 3, 20),
    ('timezone', 'Часовой пояс', 'string', 21, 'essential', 'normal',
     'Если время важно, уточни город или IANA timezone. Не угадывай неоднозначный город.', true, 7, 3, 21),
    ('interests', 'Интересы', 'string_array', 30, 'useful', 'normal',
     'Если интересы естественно проявились в теме, можно кратко уточнить их. Не задавай отдельный вопрос без связи с беседой.', false, 21, 2, 30),
    ('important_life_areas', 'Важные области жизни', 'string_array', 40, 'useful', 'normal',
     'Можно уточнить одну важную область жизни, только если это помогает текущему разговору.', false, 21, 2, 40),
    ('current_goals', 'Текущие цели', 'string_array', 50, 'useful', 'normal',
     'Если пользователь говорит о желаемых изменениях, уточни одну текущую цель и предложи сохранить её.', false, 14, 3, 50),
    ('work_schedule', 'Рабочий график', 'string', 60, 'optional', 'normal',
     'Уточняй график только когда он нужен для планирования.', false, 30, 2, 60),
    ('communication_style', 'Стиль общения', 'string', 70, 'useful', 'normal',
     'Если стиль ответа явно не подходит, уточни предпочтение одним коротким вопросом.', false, 30, 2, 70),
    ('quiet_hours', 'Тихие часы', 'object', 80, 'useful', 'normal',
     'Уточняй тихие часы только при настройке напоминаний или инициативных сообщений.', true, 30, 2, 80),
    ('recovery_methods', 'Способы восстановления', 'string_array', 90, 'optional', 'sensitive',
     'Не спрашивай об этом в тяжёлой теме. Сохраняй только после явного подтверждения пользователя.', true, 60, 1, 90),
    ('typical_obstacles', 'Типичные препятствия', 'string_array', 100, 'optional', 'sensitive',
     'Не навешивай ярлыки. Сохраняй повторяющееся препятствие только после подтверждения пользователя.', true, 60, 1, 100)
ON CONFLICT (field_key) DO UPDATE SET
    title = EXCLUDED.title,
    value_type = EXCLUDED.value_type,
    priority = EXCLUDED.priority,
    required_level = EXCLUDED.required_level,
    sensitivity = EXCLUDED.sensitivity,
    prompt_hint = EXCLUDED.prompt_hint,
    confirmation_required = EXCLUDED.confirmation_required,
    cooldown_days = EXCLUDED.cooldown_days,
    max_ask_count = EXCLUDED.max_ask_count,
    sort_order = EXCLUDED.sort_order;

CREATE INDEX IF NOT EXISTS onboarding_fields_profile_idx
    ON onboarding_fields (user_id, status, field_key);
CREATE INDEX IF NOT EXISTS profile_field_definitions_order_idx
    ON profile_field_definitions (enabled, priority, sort_order);

DROP TRIGGER IF EXISTS trg_onboarding_fields_updated_at ON onboarding_fields;
CREATE TRIGGER trg_onboarding_fields_updated_at
    BEFORE UPDATE ON onboarding_fields
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_profile_field_definitions_updated_at ON profile_field_definitions;
CREATE TRIGGER trg_profile_field_definitions_updated_at
    BEFORE UPDATE ON profile_field_definitions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_migrations (version) VALUES ('010_user_profile')
ON CONFLICT (version) DO NOTHING;

COMMIT;
