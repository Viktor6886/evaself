BEGIN;
-- Возврат прежних умолчаний и маршрута классификатора. Цепочку
-- провайдеров для него не восстанавливаем: она перенесена в `json`, и
-- копировать её обратно значило бы удвоить конфигурацию.
ALTER TABLE llm_routing_settings
  ALTER COLUMN auto_routing_enabled SET DEFAULT true,
  ALTER COLUMN llm_classifier_enabled SET DEFAULT true;

INSERT INTO llm_routes (
    code, title, description, requires_tools, requires_json, requires_vision,
    requires_streaming, min_context_window, max_quality_tier, allows_sensitive,
    rotation_enabled
) VALUES
    ('classifier', 'Классификатор', 'Классификация неоднозначных запросов',
     false, true, false, false, 4096, 5, true, true),
    ('safety', 'Безопасность', 'Кризисные и высокорисковые обращения',
     false, false, false, false, 8192, 2, true, true)
ON CONFLICT (code) DO NOTHING;

DELETE FROM schema_migrations WHERE version='056_router_without_semantic_routing';
COMMIT;
