BEGIN;

-- Кризисное событие — метаданные, а не прямая речь.
--
-- `crisis_events.trigger_text` хранил до четырёх тысяч знаков самого
-- сообщения: это самая чувствительная фраза, какую человек пишет Еве.
-- Разбору она не нужна — маркеры и тяжесть говорят, что сработало, — а
-- представление `v_crisis_open` показывало её любому, кто открыл базу
-- табличным интерфейсом.
--
-- Runtime новые строки этой колонкой больше не заполняет. Здесь
-- закрывается второй путь: представление её не отдаёт.
--
-- Уже записанные строки не трогаются: их удаление необратимо, и решение
-- об этом принимает владелец установки, а не миграция.
DROP VIEW IF EXISTS v_crisis_open;
CREATE VIEW v_crisis_open AS
SELECT
    e.id, e.created_at, e.severity, e.detected_by,
    u.telegram_id, u.username, e.notes,
    e.meta ->> 'markers' AS markers
FROM crisis_events e
JOIN users u ON u.id = e.user_id
WHERE e.handled = false
ORDER BY
    CASE e.severity
        WHEN 'critical' THEN 0 WHEN 'high' THEN 1
        WHEN 'medium'   THEN 2 ELSE 3
    END,
    e.created_at DESC;

INSERT INTO schema_migrations (version) VALUES ('058_crisis_event_minimal')
ON CONFLICT (version) DO NOTHING;

COMMIT;
