-- Несколько ботов Евы, между которыми переключаются из панели.
--
-- Токен Telegram — это не взаимозаменяемый ключ, а личность бота: у
-- каждого свой @username, свои диалоги и свой вебхук. Держать их
-- несколько нужно затем, чтобы переезд на другого бота — тестового,
-- нового после утечки токена, запасного — делался из панели, а не
-- правкой .env с последующей ручной переустановкой вебхука.
--
-- Активный токен продолжает жить в secret_records под прежним
-- sec_eva_telegram_bot_token: его читают service-catalog, bootstrap и
-- форма интеграций, и ни одно из этих мест менять не пришлось. Здесь
-- лежит набор, из которого активный выбирают.
--
-- Конверт шифрования тот же, что у secret_records: мастер-ключ
-- установки, AES-256-GCM. В открытом виде токен не хранится и наружу не
-- отдаётся никогда — панель показывает только метку и @username.
--
-- Предел в пять держит сервис, а не схема: нарушение здесь — ошибка
-- человека, и ему нужен внятный текст, а не отказ по constraint.

BEGIN;

CREATE TABLE IF NOT EXISTS telegram_bot_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label        text NOT NULL,
    -- Из getMe: доказывает, что токен настоящий, и даёт человеку имя,
    -- по которому он узнает своего бота, не видя самого токена.
    bot_id       bigint NOT NULL,
    bot_username text NOT NULL,
    ciphertext   bytea NOT NULL,
    nonce        bytea NOT NULL,
    auth_tag     bytea NOT NULL,
    is_active    boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    activated_at timestamptz,
    created_by   uuid REFERENCES admin_users (id) ON DELETE SET NULL,
    CONSTRAINT telegram_bot_tokens_label_check CHECK (btrim(label) <> ''),
    CONSTRAINT telegram_bot_tokens_nonce_check CHECK (octet_length(nonce) = 12),
    CONSTRAINT telegram_bot_tokens_tag_check CHECK (octet_length(auth_tag) = 16)
);

-- Один и тот же бот не заводится дважды: две записи на один bot_id
-- означали бы два разных мнения о том, каким токеном к нему обращаться.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_bot_tokens_bot_uidx
    ON telegram_bot_tokens (bot_id);

-- Активный ровно один. Частичный индекс делает это правилом схемы, а не
-- договорённостью кода: гонка двух администраторов иначе оставила бы
-- Еву с двумя «активными» ботами и одним вебхуком.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_bot_tokens_active_uidx
    ON telegram_bot_tokens ((is_active)) WHERE is_active;

COMMENT ON TABLE telegram_bot_tokens IS
    'Токены ботов Евы. Активный дублируется в secret_records как sec_eva_telegram_bot_token.';

INSERT INTO schema_migrations (version)
VALUES ('070_telegram_bot_tokens')
ON CONFLICT DO NOTHING;

COMMIT;
