-- =====================================================================
-- LLM Router, часть 2 из 3: маршруты.
--
-- Маршрут — это тип запроса, а не модель: «разговор», «глубокий анализ»,
-- «работа с инструментами», «строгий JSON». Letta и сервисы просят
-- маршрут (model: "eva/chat"), роутер разворачивает его в цепочку.
--
-- Требования маршрута к провайдеру хранятся здесь же, поэтому проверка
-- совместимости резерва не зашита в код: маршрут json требует
-- supports_json, маршрут tools — supports_tools, и слабая модель не
-- получит запрос только потому, что оказалась доступна.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS llm_routes (
    code                 text        PRIMARY KEY,
    title                text        NOT NULL,
    description          text        NOT NULL DEFAULT '',
    requires_tools       boolean     NOT NULL DEFAULT false,
    requires_json        boolean     NOT NULL DEFAULT false,
    requires_vision      boolean     NOT NULL DEFAULT false,
    requires_streaming   boolean     NOT NULL DEFAULT false,
    min_context_window   integer     NOT NULL DEFAULT 8192,
    -- Худшее качество, которое ещё допустимо подставить как резерв.
    max_quality_tier     smallint    NOT NULL DEFAULT 5,
    allows_sensitive     boolean     NOT NULL DEFAULT false,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT llm_routes_code_check CHECK (code ~ '^[a-z][a-z0-9_-]{1,30}$'),
    CONSTRAINT llm_routes_title_not_blank CHECK (btrim(title) <> ''),
    CONSTRAINT llm_routes_quality_check CHECK (max_quality_tier BETWEEN 1 AND 5),
    CONSTRAINT llm_routes_context_check CHECK (min_context_window >= 1024)
);

DROP TRIGGER IF EXISTS trg_llm_routes_updated_at ON llm_routes;
CREATE TRIGGER trg_llm_routes_updated_at
    BEFORE UPDATE ON llm_routes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Цепочка маршрута. position 0 — основной, дальше резервы по порядку.
-- До пяти резервов, то есть шесть позиций всего.
CREATE TABLE IF NOT EXISTS llm_route_providers (
    route_code   text        NOT NULL REFERENCES llm_routes (code) ON DELETE CASCADE,
    provider_id  uuid        NOT NULL REFERENCES llm_providers (id) ON DELETE CASCADE,
    position     smallint    NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (route_code, provider_id),
    CONSTRAINT llm_route_providers_position_check CHECK (position BETWEEN 0 AND 5)
);

-- Две записи не могут занимать одну позицию в одной цепочке.
CREATE UNIQUE INDEX IF NOT EXISTS llm_route_providers_position_uidx
    ON llm_route_providers (route_code, position);

CREATE INDEX IF NOT EXISTS llm_route_providers_provider_idx
    ON llm_route_providers (provider_id);

-- Четыре маршрута из требований. Заполняются один раз; правки маршрутов
-- администратором эта миграция не затирает.
INSERT INTO llm_routes
    (code, title, description, requires_tools, requires_json, requires_streaming,
     min_context_window, max_quality_tier)
VALUES
    ('chat',  'Разговор',
     'Обычный диалог Евы. Нужен потоковый ответ и живой стиль.',
     false, false, true,  16384, 3),
    ('deep',  'Глубокий анализ',
     'Отчёты, разборы, длинный контекст. Скорость менее важна, чем качество.',
     false, false, false, 32768, 2),
    ('tools', 'Работа с инструментами',
     'Запись в NocoDB и Todoist, поиск, изменение памяти. Без tool calling запрещён.',
     true,  false, false, 16384, 3),
    ('json',  'Строгий JSON',
     'Структурированный вывод для фоновых задач. Ответ обязан разбираться как JSON.',
     false, true,  false, 8192,  4)
ON CONFLICT (code) DO NOTHING;

-- Действующая конфигурация становится головой всех четырёх цепочек:
-- сразу после миграции роутер ведёт себя ровно как прежняя схема с одним
-- провайдером, и только потом администратор добавляет резервы.
INSERT INTO llm_route_providers (route_code, provider_id, position)
SELECT r.code, p.id, 0
  FROM llm_routes r
 CROSS JOIN (SELECT id FROM llm_providers WHERE is_active LIMIT 1) p
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('018_llm_router_routes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
