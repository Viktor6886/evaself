-- =====================================================================
-- Evaself — baseline-фикстура (шаг 00)
-- ---------------------------------------------------------------------
-- Непустое, воспроизводимое состояние базы `eva` для проверок, которые
-- нельзя выполнить на пустой схеме: изоляция арендаторов, жизненный цикл
-- хода, backup/restore, миграции.
--
-- Что создаётся:
--   • два пользователя с разными планами, состояниями и языками;
--   • по агенту на пользователя и четыре conversation разного назначения;
--   • профиль (user_preferences, onboarding_fields, user_north);
--   • цели и результат цели;
--   • задачи, включая одно ожидающее напоминание;
--   • записи inbox (telegram_updates) и outbox (telegram_outbox);
--   • подписка, квотный счётчик потребления;
--   • побочный эффект инструмента: заметка от save_note и событие
--     task_events от save_task.
--
-- Свойства:
--   • только синтетические данные, ни одного реального секрета или PII;
--   • идемпотентна: повторный запуск даёт тот же результат;
--   • не трогает строки, созданные не ею (все ключи — из диапазона
--     telegram_id 900000001/900000002 и префикса 'fixture-').
--
-- Применение:
--   postgres/fixtures/load.sh
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Пользователи
-- ---------------------------------------------------------------------
INSERT INTO users (
    telegram_id, username, first_name, last_name,
    language_code, timezone, state, is_admin, consent_at, meta
) VALUES
    (900000001, 'fixture_anna', 'Анна', 'Тестова',
     'ru', 'Europe/Moscow', 'active', false, now() - interval '90 days',
     '{"fixture":"baseline"}'::jsonb),
    (900000002, 'fixture_boris', 'Борис', 'Пробный',
     'en', 'Asia/Tbilisi', 'onboarding', false, now() - interval '3 days',
     '{"fixture":"baseline"}'::jsonb)
ON CONFLICT (telegram_id) DO UPDATE SET
    username      = EXCLUDED.username,
    first_name    = EXCLUDED.first_name,
    last_name     = EXCLUDED.last_name,
    language_code = EXCLUDED.language_code,
    timezone      = EXCLUDED.timezone,
    state         = EXCLUDED.state,
    meta          = EXCLUDED.meta;

-- ---------------------------------------------------------------------
-- 2. Агенты: один активный агент Евы на пользователя
-- ---------------------------------------------------------------------
INSERT INTO agent_links (user_id, kind, agent_id, agent_name, status, conversation_id, runtime)
SELECT u.id, 'eva', 'fixture-agent-' || u.telegram_id, 'Ева · ' || u.first_name,
       'active', 'fixture-conv-chat-' || u.telegram_id, 'letta-app-server'
FROM users u
WHERE u.telegram_id IN (900000001, 900000002)
ON CONFLICT (agent_id) DO UPDATE SET
    agent_name      = EXCLUDED.agent_name,
    status          = EXCLUDED.status,
    conversation_id = EXCLUDED.conversation_id;

-- ---------------------------------------------------------------------
-- 3. Conversations разного назначения
-- ---------------------------------------------------------------------
INSERT INTO agent_conversations (user_id, agent_id, conversation_id, title, status, purpose, message_count)
SELECT u.id,
       'fixture-agent-' || u.telegram_id,
       'fixture-conv-' || c.purpose || '-' || u.telegram_id,
       c.title,
       'active',
       c.purpose,
       c.message_count
FROM users u
CROSS JOIN (VALUES
    ('chat',      'Основной диалог', 42),
    ('scheduler', 'Напоминания',      7)
) AS c(purpose, title, message_count)
WHERE u.telegram_id IN (900000001, 900000002)
ON CONFLICT (conversation_id) DO UPDATE SET
    title         = EXCLUDED.title,
    status        = EXCLUDED.status,
    message_count = EXCLUDED.message_count;

-- ---------------------------------------------------------------------
-- 4. Профиль
-- ---------------------------------------------------------------------
INSERT INTO user_preferences (user_id, response_mode, agent_mode, use_emoji, llm_quality_mode)
SELECT u.id,
       CASE WHEN u.telegram_id = 900000001 THEN 'both' ELSE 'text' END,
       CASE WHEN u.telegram_id = 900000001 THEN 'coach' ELSE 'companion' END,
       u.telegram_id = 900000001,
       'auto'
FROM users u
WHERE u.telegram_id IN (900000001, 900000002)
ON CONFLICT (user_id) DO UPDATE SET
    response_mode = EXCLUDED.response_mode,
    agent_mode    = EXCLUDED.agent_mode,
    use_emoji     = EXCLUDED.use_emoji;

-- Подтверждённые и кандидатные поля профиля. Ключи взяты из
-- profile_field_definitions, которую заполняет миграция 010.
INSERT INTO onboarding_fields (user_id, field_key, field_value, status, confidence, source_type, sensitivity)
SELECT u.id, f.field_key, f.field_value, f.status, f.confidence, 'fixture', 'normal'
FROM users u
CROSS JOIN (VALUES
    ('preferred_name',      'Аня',                'confirmed', 1.000),
    ('city',                'Доброград',          'confirmed', 0.900),
    ('communication_style', 'коротко и по делу',  'candidate', 0.600)
) AS f(field_key, field_value, status, confidence)
WHERE u.telegram_id = 900000001
ON CONFLICT (user_id, field_key) DO UPDATE SET
    field_value = EXCLUDED.field_value,
    status      = EXCLUDED.status,
    confidence  = EXCLUDED.confidence;

INSERT INTO user_north (user_id, desired_direction, why_it_matters, values, user_confirmed, confirmed_at)
SELECT u.id,
       'Больше времени на глубокую работу',
       'Ощущение осмысленности вместо дробления дня',
       '["ясность","самостоятельность"]'::jsonb,
       true,
       now() - interval '30 days'
FROM users u
WHERE u.telegram_id = 900000001
ON CONFLICT (user_id) DO UPDATE SET
    desired_direction = EXCLUDED.desired_direction,
    user_confirmed    = EXCLUDED.user_confirmed;

-- ---------------------------------------------------------------------
-- 5. Цели
-- ---------------------------------------------------------------------
INSERT INTO goals (user_id, life_area, horizon, title, why_it_matters, target_date,
                   priority, status, vector_stage, user_confirmed, confirmed_at)
SELECT u.id, g.life_area, g.horizon, g.title, g.why_it_matters,
       (current_date + g.days_ahead)::date, g.priority, g.status, g.vector_stage,
       g.user_confirmed,
       CASE WHEN g.user_confirmed THEN now() - interval '20 days' END
FROM users u
CROSS JOIN (VALUES
    ('career', 'quarter', 'Фикстура: защитить рабочий блок утром',
     'Без утреннего блока день рассыпается', 60, 2, 'active', 'action', true),
    ('health', 'year',    'Фикстура: вернуть регулярные прогулки',
     'Сон и настроение зависят от движения', 200, 3, 'draft', 'north', false)
) AS g(life_area, horizon, title, why_it_matters, days_ahead, priority, status, vector_stage, user_confirmed)
WHERE u.telegram_id = 900000001
  AND NOT EXISTS (SELECT 1 FROM goals x WHERE x.user_id = u.id AND x.title = g.title);

INSERT INTO goals (user_id, life_area, horizon, title, priority, status, vector_stage, user_confirmed)
SELECT u.id, 'learning', 'quarter', 'Фикстура: разобраться, чего я хочу', 3, 'draft', 'north', false
FROM users u
WHERE u.telegram_id = 900000002
  AND NOT EXISTS (
      SELECT 1 FROM goals x
      WHERE x.user_id = u.id AND x.title = 'Фикстура: разобраться, чего я хочу'
  );

-- ---------------------------------------------------------------------
-- 6. Задачи, включая ожидающее напоминание
-- ---------------------------------------------------------------------
-- Задача с remind_at в будущем и status='open' — это ровно то, что
-- отбирает индекс tasks_remind_idx: ожидающее напоминание.
INSERT INTO tasks (user_id, title, description, status, priority,
                   due_at, remind_at, source, goal_id, meta)
SELECT u.id,
       'Фикстура: утренний блок 90 минут',
       'Ожидающее напоминание: remind_at в будущем, статус open',
       'open', 2,
       now() + interval '2 days',
       now() + interval '1 day',
       'eva',
       (SELECT id FROM goals WHERE user_id = u.id AND title = 'Фикстура: защитить рабочий блок утром'),
       '{"fixture":"pending_reminder"}'::jsonb
FROM users u
WHERE u.telegram_id = 900000001
  AND NOT EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.user_id = u.id AND t.title = 'Фикстура: утренний блок 90 минут'
  );

INSERT INTO tasks (user_id, title, status, priority, completed_at, source, meta)
SELECT u.id, 'Фикстура: закрытая задача', 'done', 3, now() - interval '2 days', 'user',
       '{"fixture":"closed"}'::jsonb
FROM users u
WHERE u.telegram_id = 900000002
  AND NOT EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.user_id = u.id AND t.title = 'Фикстура: закрытая задача'
  );

-- ---------------------------------------------------------------------
-- 7. Побочный эффект инструмента
-- ---------------------------------------------------------------------
-- save_note (eva-agent-service/src/tools/core-tools.ts) пишет eva_notes.
INSERT INTO eva_notes (user_id, title, content, category, tags, entry_type)
SELECT u.id,
       'Фикстура: заметка, созданная инструментом save_note',
       'Строка-результат вызова инструмента. Содержимое синтетическое.',
       'observation',
       ARRAY['fixture', 'tool-effect'],
       'note'
FROM users u
WHERE u.telegram_id = 900000001
  AND NOT EXISTS (
      SELECT 1 FROM eva_notes n
      WHERE n.user_id = u.id
        AND n.title = 'Фикстура: заметка, созданная инструментом save_note'
  );

-- save_task (eva-agent-service/src/tools/task-tools.ts) пишет tasks
-- и событие 'created' в task_events.
INSERT INTO task_events (user_id, task_id, event_type, conversation_id, metadata)
SELECT t.user_id, t.id, 'created',
       'fixture-conv-chat-900000001',
       '{"fixture":"tool_effect","tool":"save_task"}'::jsonb
FROM tasks t
JOIN users u ON u.id = t.user_id
WHERE u.telegram_id = 900000001
  AND t.title = 'Фикстура: утренний блок 90 минут'
  AND NOT EXISTS (
      SELECT 1 FROM task_events e
      WHERE e.task_id = t.id AND e.event_type = 'created'
  );

-- ---------------------------------------------------------------------
-- 8. Telegram inbox и outbox
-- ---------------------------------------------------------------------
-- update_id задан явно: это первичный ключ, а не sequence.
INSERT INTO telegram_updates (update_id, user_id, telegram_user_id, chat_id, message_id,
                              message_kind, status, billable, payload)
SELECT v.update_id, u.id, u.telegram_id, u.telegram_id, v.message_id,
       'text', v.status, true,
       jsonb_build_object('fixture', true, 'update_id', v.update_id)
FROM users u
JOIN (VALUES
    (990000001::bigint, 900000001::bigint, 5001::bigint, 'completed'),
    (990000002::bigint, 900000001::bigint, 5002::bigint, 'queued'),
    (990000003::bigint, 900000002::bigint, 5003::bigint, 'queued')
) AS v(update_id, telegram_id, message_id, status) ON v.telegram_id = u.telegram_id
ON CONFLICT (update_id) DO UPDATE SET
    status  = EXCLUDED.status,
    payload = EXCLUDED.payload;

INSERT INTO telegram_outbox (idempotency_key, user_id, chat_id, telegram_method, payload,
                             status, telegram_message_ids, sent_at)
SELECT v.idempotency_key, u.id, u.telegram_id, 'sendMessage',
       jsonb_build_object('chat_id', u.telegram_id, 'text', v.text),
       v.status,
       CASE WHEN v.status = 'sent' THEN ARRAY[6001::bigint] ELSE ARRAY[]::bigint[] END,
       CASE WHEN v.status = 'sent' THEN now() - interval '1 hour' END
FROM users u
JOIN (VALUES
    ('fixture-outbox-sent-1',    900000001::bigint, 'Доставленный ответ фикстуры', 'sent'),
    ('fixture-outbox-pending-1', 900000001::bigint, 'Ответ фикстуры в очереди',    'pending'),
    ('fixture-outbox-pending-2', 900000002::bigint, 'Приветствие фикстуры',        'pending')
) AS v(idempotency_key, telegram_id, text, status) ON v.telegram_id = u.telegram_id
ON CONFLICT (idempotency_key) DO UPDATE SET
    status  = EXCLUDED.status,
    payload = EXCLUDED.payload;

-- ---------------------------------------------------------------------
-- 9. Подписка и потребление
-- ---------------------------------------------------------------------
-- Частичный уникальный индекс subscriptions_active_uidx допускает одну
-- активную подписку на пользователя, поэтому вставка защищена NOT EXISTS.
INSERT INTO subscriptions (user_id, plan, status, provider, current_period_start, current_period_end, meta)
SELECT u.id, 'plus', 'active', 'fixture',
       date_trunc('month', now()),
       date_trunc('month', now()) + interval '1 month',
       '{"fixture":"baseline"}'::jsonb
FROM users u
WHERE u.telegram_id = 900000001
  AND NOT EXISTS (
      SELECT 1 FROM subscriptions s
      WHERE s.user_id = u.id
        AND s.status IN ('trialing', 'active', 'past_due')
  );

INSERT INTO subscriptions (user_id, plan, status, current_period_start, meta)
SELECT u.id, 'free', 'trialing', now() - interval '3 days', '{"fixture":"baseline"}'::jsonb
FROM users u
WHERE u.telegram_id = 900000002
  AND NOT EXISTS (
      SELECT 1 FROM subscriptions s
      WHERE s.user_id = u.id
        AND s.status IN ('trialing', 'active', 'past_due')
  );

-- Счётчик потребления против квоты plan='plus', metric='messages'.
INSERT INTO usage_counters (user_id, metric, period, period_start, used)
SELECT u.id, v.metric, 'day', current_date, v.used
FROM users u
JOIN (VALUES
    (900000001::bigint, 'messages',    17::bigint),
    (900000001::bigint, 'web_search',   3::bigint),
    (900000002::bigint, 'messages',     2::bigint)
) AS v(telegram_id, metric, used) ON v.telegram_id = u.telegram_id
ON CONFLICT (user_id, metric, period, period_start) DO UPDATE SET
    used = EXCLUDED.used;

COMMIT;
