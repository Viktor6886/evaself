-- =====================================================================
-- Распознавание речи: конфигурации провайдеров, маршруты, телеметрия.
--
-- До этой миграции путь распознавания был ровно один и жил в окружении:
-- MEDIA_ASR_BASE_URL, MEDIA_ASR_API_KEY, MEDIA_ASR_MODEL,
-- MEDIA_ASR_LANGUAGE. Сменить провайдера означало отредактировать .env и
-- пересоздать контейнер, а резерва на случай отказа не было вовсе:
-- 429 от провайдера превращался в «не получилось распознать» для
-- пользователя.
--
-- Структура повторяет уже работающий реестр LLM-провайдеров (017–019):
-- конфигурации отдельно, маршруты отдельно, телеметрия отдельно. Это
-- сознательное копирование — оператор уже умеет читать тот раздел, и
-- второй непохожий механизм в той же панели был бы хуже.
--
-- Три решения, которые стоит объяснить:
--
--   1. secret_ref — text, а не UUID. secret_records.secret_ref объявлен
--      как text PRIMARY KEY с ограничением ^sec_[a-z0-9_]+$, и Secret
--      Store не примет ссылку другого вида. Конвенция — sec_stt_<hex>.
--
--   2. Ключ не хранится здесь ни в каком виде, даже как хеш. Хеш
--      необратим и не может быть предъявлен провайдеру, то есть был бы
--      бесполезен и одновременно создавал бы ложное ощущение, что
--      секрет «где-то тут». Всё значение живёт только в Secret Store
--      под AES-256-GCM.
--
--   3. config_version растёт при каждой правке. По нему media-service
--      понимает, что его снимок устарел, а откат к предыдущей рабочей
--      версии становится обычной операцией, а не восстановлением из
--      бэкапа.
--
-- Все объекты создаются идемпотентно: миграция переживает повторный
-- прогон на уже обновлённой базе.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Конфигурации провайдеров
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stt_provider_configs (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name              text        NOT NULL,
    provider          text        NOT NULL,
    mode              text        NOT NULL DEFAULT 'batch',
    base_url          text        NOT NULL,
    model             text        NOT NULL,

    -- Только несекретные параметры. Что сюда класть нельзя, стережёт
    -- ограничение stt_configs_public_config_clean ниже.
    public_config     jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- Ссылка в Secret Store. NULL означает «ключ ещё не задан», и такая
    -- конфигурация не может быть активирована.
    secret_ref        text        NULL REFERENCES secret_records (secret_ref)
                                  ON DELETE RESTRICT,

    status            text        NOT NULL DEFAULT 'draft',
    config_version    integer     NOT NULL DEFAULT 1,

    -- Результат последней проверки. Держим здесь, а не только в
    -- телеметрии: список конфигураций должен открываться одним запросом.
    last_tested_at    timestamptz NULL,
    last_test_ok      boolean     NULL,
    last_latency_ms   integer     NULL,
    last_error_code   text        NULL,
    last_error_message text       NULL,

    archived_at       timestamptz NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid        NULL REFERENCES admin_users (id) ON DELETE SET NULL,

    CONSTRAINT stt_configs_provider_check
        CHECK (provider IN ('deepgram', 'openai', 'google', 'openrouter')),
    CONSTRAINT stt_configs_mode_check
        CHECK (mode IN ('batch', 'streaming')),
    CONSTRAINT stt_configs_status_check
        CHECK (status IN ('draft', 'healthy', 'unhealthy', 'disabled', 'archived')),
    CONSTRAINT stt_configs_name_check
        CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT stt_configs_model_check
        CHECK (length(btrim(model)) BETWEEN 1 AND 200),
    CONSTRAINT stt_configs_version_check
        CHECK (config_version >= 1),

    -- Схема https:// проверяется и в приложении (там же, где защита от
    -- SSRF), но запрет на http:// и file:// в базе означает, что даже
    -- прямая правка psql не создаст конфигурацию, уводящую аудио на
    -- незашифрованный или локальный адрес.
    CONSTRAINT stt_configs_base_url_check
        CHECK (base_url ~* '^https://[a-z0-9]'),

    -- Секретам в public_config не место. Проверка перечисляет ровно те
    -- имена, которые провайдеры используют для учётных данных.
    CONSTRAINT stt_configs_public_config_clean
        CHECK (
            NOT (public_config ?| ARRAY[
                'api_key', 'apiKey', 'secret', 'secret_key', 'secretKey',
                'private_key', 'privateKey', 'authorization', 'Authorization',
                'access_token', 'accessToken', 'refresh_token', 'refreshToken',
                'credentials', 'service_account', 'serviceAccount',
                'client_secret', 'clientSecret'
            ])
        )
);

-- Имя — то, по чему оператор различает конфигурации в выпадающем списке
-- маршрута. Два «Deepgram production» сделали бы этот список бесполезным.
-- Ограничение частичное: архивные имена освобождаются для повторного
-- использования.
CREATE UNIQUE INDEX IF NOT EXISTS stt_configs_name_uidx
    ON stt_provider_configs (lower(btrim(name)))
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS stt_configs_active_idx
    ON stt_provider_configs (provider, status)
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS stt_configs_secret_idx
    ON stt_provider_configs (secret_ref)
    WHERE secret_ref IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. Маршруты по сценариям
-- ---------------------------------------------------------------------
-- use_case — первичный ключ: на один сценарий ровно один маршрут.
-- Сценарии заводятся миграцией, а не панелью: появление нового означает
-- новый код обработки, а не новую строку в таблице.
CREATE TABLE IF NOT EXISTS stt_routes (
    use_case            text        PRIMARY KEY,
    primary_config_id   uuid        NULL REFERENCES stt_provider_configs (id)
                                    ON DELETE RESTRICT,
    fallback_config_id  uuid        NULL REFERENCES stt_provider_configs (id)
                                    ON DELETE RESTRICT,
    enabled             boolean     NOT NULL DEFAULT true,
    timeout_ms          integer     NOT NULL DEFAULT 120000,
    max_audio_seconds   integer     NULL,
    config_version      integer     NOT NULL DEFAULT 1,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid        NULL REFERENCES admin_users (id) ON DELETE SET NULL,

    CONSTRAINT stt_routes_use_case_check
        CHECK (use_case IN ('telegram_voice', 'webapp_voice_message', 'webapp_live')),
    CONSTRAINT stt_routes_timeout_check
        CHECK (timeout_ms BETWEEN 5000 AND 600000),
    CONSTRAINT stt_routes_max_audio_check
        CHECK (max_audio_seconds IS NULL OR max_audio_seconds BETWEEN 1 AND 7200),
    -- Резерв, совпадающий с основным, — не резерв: при отказе провайдера
    -- вторая попытка ушла бы туда же и стоила бы вторых денег впустую.
    CONSTRAINT stt_routes_distinct_check
        CHECK (fallback_config_id IS NULL OR fallback_config_id IS DISTINCT FROM primary_config_id)
);

-- Три сценария из постановки. webapp_live заведён выключенным: режим
-- живой Евы ещё не написан, но маршрут для него должен существовать
-- заранее, иначе появление режима потребует новой миграции.
INSERT INTO stt_routes (use_case, enabled, timeout_ms, max_audio_seconds)
VALUES
    ('telegram_voice',       true,  120000, 1800),
    ('webapp_voice_message', true,   90000,  600),
    ('webapp_live',          false,  30000,   60)
ON CONFLICT (use_case) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. Версии конфигураций — для отката
-- ---------------------------------------------------------------------
-- Требование «быстро вернуть предыдущую рабочую конфигурацию» нельзя
-- закрыть одним last_* полем: к моменту отката текущее состояние уже
-- перезаписано. Поэтому каждая правка кладёт сюда снимок ДО изменения.
--
-- Снимок несекретный: ключ остаётся в Secret Store, здесь только
-- secret_ref. Откат возвращает параметры, а не ключ.
CREATE TABLE IF NOT EXISTS stt_config_versions (
    id             bigserial   PRIMARY KEY,
    config_id      uuid        NOT NULL REFERENCES stt_provider_configs (id) ON DELETE CASCADE,
    config_version integer     NOT NULL,
    snapshot_json  jsonb       NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid        NULL REFERENCES admin_users (id) ON DELETE SET NULL,

    CONSTRAINT stt_config_versions_snapshot_clean
        CHECK (
            NOT (snapshot_json ?| ARRAY[
                'api_key', 'apiKey', 'secret_key', 'secretKey',
                'private_key', 'privateKey', 'credentials'
            ])
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS stt_config_versions_uidx
    ON stt_config_versions (config_id, config_version);

CREATE INDEX IF NOT EXISTS stt_config_versions_recent_idx
    ON stt_config_versions (config_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 4. Телеметрия распознавания
-- ---------------------------------------------------------------------
-- usage_counters остаётся источником правды по пользовательским квотам
-- (метрика voice_minutes и дальше считается там) — эта таблица его не
-- заменяет и не дублирует. Здесь то, чего в счётчиках нет и быть не
-- должно: разрез по провайдеру и модели, задержки для перцентилей,
-- попытки и события fallback.
--
-- Постановка требует не смешивать три разные величины, поэтому они
-- лежат в разных столбцах:
--   requests  — сколько распознаваний запросил пользователь;
--   attempts  — сколько обращений к провайдерам это стоило;
--   fallbacks — сколько раз пришлось уйти на резерв.
-- Одно голосовое с одним fallback: requests = 1, attempts = 2,
-- fallbacks = 1.
CREATE TABLE IF NOT EXISTS stt_usage_events (
    id                  bigserial   PRIMARY KEY,
    at                  timestamptz NOT NULL DEFAULT now(),
    use_case            text        NOT NULL,
    config_id           uuid        NULL REFERENCES stt_provider_configs (id) ON DELETE SET NULL,
    provider            text        NOT NULL,
    model               text        NOT NULL,

    outcome             text        NOT NULL,
    attempt_index       smallint    NOT NULL DEFAULT 1,
    is_fallback         boolean     NOT NULL DEFAULT false,

    audio_seconds       numeric(10, 3) NOT NULL DEFAULT 0,
    latency_ms          integer     NOT NULL DEFAULT 0,
    error_code          text        NULL,

    -- Стоимость пишется только когда её можно посчитать достоверно:
    -- по опубликованному тарифу за минуту. Догадки хуже пустого поля —
    -- по ним оператор примет решение, думая, что видит факт.
    estimated_cost_minor bigint     NULL,
    currency             text       NULL,

    -- Ключ идемпотентности: Telegram file_unique_id или внутренний
    -- media ID. По нему повторная доставка того же апдейта не
    -- оплачивается вторично.
    idempotency_key      text       NULL,

    CONSTRAINT stt_usage_outcome_check
        CHECK (outcome IN ('success', 'failure')),
    CONSTRAINT stt_usage_attempt_check
        CHECK (attempt_index BETWEEN 1 AND 2),
    CONSTRAINT stt_usage_currency_check
        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);

CREATE INDEX IF NOT EXISTS stt_usage_recent_idx
    ON stt_usage_events (at DESC);

CREATE INDEX IF NOT EXISTS stt_usage_provider_idx
    ON stt_usage_events (provider, at DESC);

CREATE INDEX IF NOT EXISTS stt_usage_use_case_idx
    ON stt_usage_events (use_case, at DESC);

CREATE INDEX IF NOT EXISTS stt_usage_failures_idx
    ON stt_usage_events (at DESC)
    WHERE outcome = 'failure';

-- ---------------------------------------------------------------------
-- 5. Результаты распознавания для идемпотентности
-- ---------------------------------------------------------------------
-- «Не оплачивать повторное распознавание уже успешно обработанного
-- аудио» невозможно выполнить без памяти о том, что уже распознано.
--
-- Хранится только текст и метаданные, само аудио — нет. Записи живут
-- сутки: Telegram повторяет доставку апдейта минутами, а не днями, и
-- держать расшифровки личных сообщений дольше необходимого незачем.
CREATE TABLE IF NOT EXISTS stt_transcript_cache (
    idempotency_key text        PRIMARY KEY,
    use_case        text        NOT NULL,
    transcript      text        NOT NULL,
    language        text        NULL,
    provider        text        NOT NULL,
    model           text        NOT NULL,
    audio_seconds   numeric(10, 3) NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);

CREATE INDEX IF NOT EXISTS stt_transcript_cache_expiry_idx
    ON stt_transcript_cache (expires_at);

-- ---------------------------------------------------------------------
-- 6. Обновление updated_at
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stt_touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stt_configs_touch ON stt_provider_configs;
CREATE TRIGGER stt_configs_touch
    BEFORE UPDATE ON stt_provider_configs
    FOR EACH ROW EXECUTE FUNCTION stt_touch_updated_at();

DROP TRIGGER IF EXISTS stt_routes_touch ON stt_routes;
CREATE TRIGGER stt_routes_touch
    BEFORE UPDATE ON stt_routes
    FOR EACH ROW EXECUTE FUNCTION stt_touch_updated_at();

COMMIT;
