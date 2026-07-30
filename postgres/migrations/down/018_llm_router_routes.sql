-- Откат 018: маршруты и цепочки.
BEGIN;
DROP TRIGGER IF EXISTS trg_llm_routes_updated_at ON llm_routes;
DROP TABLE IF EXISTS llm_route_providers;
DROP TABLE IF EXISTS llm_routes;
DELETE FROM schema_migrations WHERE version = '018_llm_router_routes';
COMMIT;
