-- Виды операций, которые панель действительно записывает.
--
-- Кнопки «Запустить» и «Остановить» падали на CHECK: `lifecycle()` пишет
-- действие в `admin_operations.kind`, а список знал только `restart`.
-- Оператор получал «внутренняя ошибка», в журнале лежало нарушение
-- ограничения, и связать одно с другим было нечем.
--
-- Поддельная база в TypeScript-тестах ограничений схемы не проверяет —
-- поэтому проверка живёт здесь, на настоящем PostgreSQL. Список видов
-- берётся не из головы: это ровно те строки, которые передаёт
-- `OperationService` (`restart`/`start`/`stop` из lifecycle() и четыре
-- вида из operation()).

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    kind text;
    kinds text[] := ARRAY['restart', 'start', 'stop', 'backup', 'update-check', 'update'];
BEGIN
    FOREACH kind IN ARRAY kinds LOOP
        BEGIN
            INSERT INTO admin_operations (id, kind, status, target)
            VALUES (uuid_generate_v4(), kind, 'pending', 'searxng');
        EXCEPTION WHEN check_violation THEN
            RAISE EXCEPTION
                'панель записывает операцию вида «%», а схема её отвергает: кнопка не работает',
                kind;
        END;
    END LOOP;
END $$;

ROLLBACK;

\echo 'виды операций панели принимаются схемой'
