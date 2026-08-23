-- Bot-scoped Telegram sticker upload cache and operator-visible upload state.
BEGIN;

CREATE TABLE IF NOT EXISTS telegram_sticker_cache (
    bot_identity  text        NOT NULL,
    intent        text        NOT NULL,
    file_id       text,
    last_status   text        NOT NULL,
    last_error    text,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (bot_identity, intent),
    CONSTRAINT telegram_sticker_cache_status_check
      CHECK (last_status IN ('using_cached_file_ids', 'telegram_upload_failed'))
);

INSERT INTO schema_migrations (version)
VALUES ('064_telegram_sticker_cache')
ON CONFLICT DO NOTHING;

COMMIT;
