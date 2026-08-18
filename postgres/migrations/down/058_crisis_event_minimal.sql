BEGIN;
-- Возврат представления к виду из миграции 002: с колонкой самого
-- сообщения. Данные при этом не появляются — runtime их не пишет, — но
-- форма представления восстанавливается ровно прежняя.
DROP VIEW IF EXISTS v_crisis_open;
CREATE VIEW v_crisis_open AS
SELECT
    e.id, e.created_at, e.severity, e.detected_by,
    u.telegram_id, u.username, e.trigger_text, e.notes
FROM crisis_events e
JOIN users u ON u.id = e.user_id
WHERE e.handled = false
ORDER BY
    CASE e.severity
        WHEN 'critical' THEN 0 WHEN 'high' THEN 1
        WHEN 'medium'   THEN 2 ELSE 3
    END,
    e.created_at DESC;

DELETE FROM schema_migrations WHERE version='058_crisis_event_minimal';
COMMIT;
