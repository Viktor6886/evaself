-- =====================================================================
-- Токены inline-кнопок Telegram.
--
-- `callback_data` — это 64 байта, которые вернутся серверу от кого
-- угодно, кто видит сообщение. Класть туда команду, идентификатор или
-- текст нельзя: нажатие кнопки стало бы способом передать серверу
-- произвольную строку. Поэтому в Telegram уходит непрозрачный случайный
-- токен, а смысл выбора, владелец, срок и сообщение живут здесь.
--
-- Владелец записан явно и проверяется при нажатии: кнопку видит тот, кому
-- пришло сообщение, но прислать её токен может любой клиент.
--
-- Значение выбора — короткая подпись варианта, которую назвала сама Ева.
-- Текста человека и содержимого разговора в таблице нет.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS telegram_callback_tokens (
    token           text        PRIMARY KEY,
    user_id         bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    chat_id         bigint      NOT NULL,
    conversation_id text        NOT NULL,
    -- Сообщение, под которым стоит клавиатура. Нужно, чтобы снять её
    -- после выбора и чтобы отличить кнопку прошлого ответа от текущей.
    message_id      bigint,
    choice_label    text        NOT NULL,
    choice_value    text        NOT NULL,
    one_shot        boolean     NOT NULL DEFAULT true,
    expires_at      timestamptz NOT NULL,
    -- Первое нажатие проставляет отметку; второе по той же кнопке видит
    -- её и не заводит второй ход.
    used_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_callback_tokens_user_idx
    ON telegram_callback_tokens (user_id, created_at DESC);
-- Просроченные снимает уборка по сроку, а не по одному токену.
CREATE INDEX IF NOT EXISTS telegram_callback_tokens_expiry_idx
    ON telegram_callback_tokens (expires_at);
-- Клавиатуру одного сообщения снимают целиком: все его токены разом.
CREATE INDEX IF NOT EXISTS telegram_callback_tokens_message_idx
    ON telegram_callback_tokens (chat_id, message_id);

INSERT INTO schema_migrations (version)
VALUES ('060_telegram_callback_tokens')
ON CONFLICT DO NOTHING;

COMMIT;
