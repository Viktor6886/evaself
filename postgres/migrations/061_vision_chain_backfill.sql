-- =====================================================================
-- Цепочка маршрута зрения на уже настроенных установках.
--
-- Маршрут `vision` выбирается САМИМ содержимым хода: пришла фотография —
-- ход уходит туда. Но провайдер, добавленный через панель, попадает
-- только в ту цепочку, куда его поставили руками, и на установке, где
-- этого не сделали, каждая фотография упиралась в «для маршрута vision
-- не назначен ни один провайдер». PDF при этом читался: документ
-- превращается в текст и идёт обычным маршрутом.
--
-- Здесь цепочка достраивается данными, а не кодом: в пустой маршрут
-- зрения ставятся включённые провайдеры, которые заявляют
-- `supports_vision`. Порядок — по приоритету, как и везде.
--
-- Идемпотентно: если цепочка уже настроена, миграция не трогает её
-- вовсе. Провайдеров со зрением нет — тоже ничего не делает, и отказ
-- останется честным, про возможности модели.
-- =====================================================================
BEGIN;

INSERT INTO llm_route_providers (route_code, provider_id, position)
SELECT 'vision',
       provider.id,
       row_number() OVER (ORDER BY provider.priority, lower(provider.name)) - 1
  FROM llm_providers provider
 WHERE provider.enabled
   AND provider.supports_vision
   AND NOT EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = 'vision')
ON CONFLICT (route_code, provider_id) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('061_vision_chain_backfill')
ON CONFLICT DO NOTHING;

COMMIT;
