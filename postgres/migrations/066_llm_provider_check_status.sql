-- Состояние последней проверки провайдера.
--
-- Раньше итог был булевым: провайдер либо «прошёл проверку», либо нет. Из-за
-- этого лимит запросов, отклонённый ключ и отсутствие изображений выглядели
-- в панели одинаково — красной точкой и текстом про несовместимость модели,
-- хотя действия оператора в этих случаях разные: ждать, чинить настройку или
-- просто знать про ограничение.
--
-- Колонка добавляется рядом с last_check_ok, а не вместо неё: старый код
-- продолжает читать булево значение и работает без изменений, а новый
-- показывает состояние. Значения совпадают с ProbeStatus в
-- eva-agent-service/src/llm/capability-probe.ts.
--
-- NULL означает «проверки этой версией ещё не было» — так выглядят все
-- существующие строки сразу после наката.

BEGIN;

ALTER TABLE llm_providers
    ADD COLUMN IF NOT EXISTS last_check_status text;

ALTER TABLE llm_providers
    DROP CONSTRAINT IF EXISTS llm_providers_last_check_status_check;

ALTER TABLE llm_providers
    ADD CONSTRAINT llm_providers_last_check_status_check
    CHECK (last_check_status IS NULL OR last_check_status IN (
        'ok', 'limited', 'config_error', 'unavailable'
    ));

COMMENT ON COLUMN llm_providers.last_check_status IS
    'Итог последней пробы: ok, limited, config_error, unavailable. NULL — проверки ещё не было.';

INSERT INTO schema_migrations (version)
VALUES ('066_llm_provider_check_status')
ON CONFLICT DO NOTHING;

COMMIT;
