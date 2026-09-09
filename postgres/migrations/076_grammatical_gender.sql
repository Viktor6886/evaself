BEGIN;

-- Это не вывод пола из имени и не медицинское сведение. Поле хранит
-- только выбранное человеком грамматическое согласование обращения.
INSERT INTO profile_field_definitions
    (field_key, title, value_type, priority, required_level, sensitivity,
     prompt_hint, confirmation_required, cooldown_days, max_ask_count, sort_order)
VALUES
    ('grammatical_gender', 'Грамматический род обращения', 'string', 15,
     'optional', 'normal',
     'Если это естественно для разговора, уточни, обращаться ли в мужском или женском роде. Не делай вывод по имени, фото или голосу.',
     false, 30, 1, 15)
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
    enabled = true,
    sort_order = EXCLUDED.sort_order;

INSERT INTO schema_migrations (version)
VALUES ('076_grammatical_gender')
ON CONFLICT DO NOTHING;

COMMIT;
