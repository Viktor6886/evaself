-- Несколько ключей у одного провайдера.
--
-- Бесплатные и льготные тарифы считают лимит на ключ, а не на аккаунт:
-- у Google Gemini один ключ упирается в квоту за минуты, и провайдер
-- целиком выпадает из маршрутов, хотя рядом лежат ещё девять рабочих
-- ключей того же владельца. Отдельный провайдер на каждый ключ этого не
-- решает: у них разошлись бы цепочки, бюджеты и circuit breaker, а
-- «сменить ключ» — это не «сменить модель».
--
-- Колонка добавляется рядом с api_key_encrypted, а не вместо неё. Старый
-- код читает api_key_encrypted и работает без изменений; новый держит в
-- нём первый ключ пула, поэтому значения всегда согласованы. Пустой
-- массив означает «пул не заводили» — так выглядят все существующие
-- строки сразу после наката, и ключ у них ровно один, прежний.
--
-- Ключи здесь зашифрованы тем же ключом установки, что и api_key_encrypted:
-- в открытом виде они не хранятся и наружу не отдаются.

BEGIN;

ALTER TABLE llm_providers
    ADD COLUMN IF NOT EXISTS api_keys_encrypted text[] NOT NULL DEFAULT '{}';

ALTER TABLE llm_providers
    DROP CONSTRAINT IF EXISTS llm_providers_api_keys_limit_check;

-- Десять — предел, о котором просили, и он же защита от случайной вставки
-- всего буфера обмена в поле ключей.
ALTER TABLE llm_providers
    ADD CONSTRAINT llm_providers_api_keys_limit_check
    CHECK (array_length(api_keys_encrypted, 1) IS NULL
           OR array_length(api_keys_encrypted, 1) <= 10);

COMMENT ON COLUMN llm_providers.api_keys_encrypted IS
    'Пул ключей провайдера, зашифрованных ключом установки. Первый совпадает с api_key_encrypted. Пустой массив — пул не заводили.';

INSERT INTO schema_migrations (version)
VALUES ('069_llm_provider_key_pool')
ON CONFLICT DO NOTHING;

COMMIT;
