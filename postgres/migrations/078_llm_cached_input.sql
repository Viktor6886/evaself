BEGIN;

-- Кэшированный вход провайдера.
--
-- Счёт за ход нечем было объяснить: журнал показывал «сорок тысяч
-- входных токенов», а провайдер брал за них как за четыре — потому что
-- почти весь запрос пришёл из его кэша промпта. Стоимость считалась по
-- одной ставке на весь вход, то есть завышала дешёвые ходы и прятала
-- разницу между холодным и тёплым обращением.
--
-- `cached_tokens_in` — ЧАСТЬ `tokens_in`, а не добавка к ней.
ALTER TABLE llm_requests
    ADD COLUMN IF NOT EXISTS cached_tokens_in integer NOT NULL DEFAULT 0;

ALTER TABLE llm_spend_ledger
    ADD COLUMN IF NOT EXISTS cached_tokens_in bigint NOT NULL DEFAULT 0;

-- Ставка за кэшированный вход. NULL означает «не задана»: такой вход
-- считается по обычной цене. Ноль — законное значение (у части
-- провайдеров чтение кэша бесплатно), и отличить его от «не знаем»
-- умолчанием 0 было бы нельзя.
ALTER TABLE llm_providers
    ADD COLUMN IF NOT EXISTS price_cached_in_micro integer;

ALTER TABLE llm_providers
    DROP CONSTRAINT IF EXISTS llm_providers_price_cached_in_check;
ALTER TABLE llm_providers
    ADD CONSTRAINT llm_providers_price_cached_in_check
    CHECK (price_cached_in_micro IS NULL OR price_cached_in_micro >= 0);

COMMENT ON COLUMN llm_requests.cached_tokens_in IS
    'Часть tokens_in, отданная провайдером из кэша промпта';
COMMENT ON COLUMN llm_providers.price_cached_in_micro IS
    'Цена миллиона кэшированных входных токенов; NULL — считать по обычной';

INSERT INTO schema_migrations (version)
VALUES ('078_llm_cached_input')
ON CONFLICT DO NOTHING;

COMMIT;
