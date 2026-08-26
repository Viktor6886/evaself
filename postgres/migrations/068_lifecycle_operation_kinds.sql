-- Кнопки «Запустить» и «Остановить» перестают падать на ограничении.
--
-- Панель показывает три действия над сервисом: запустить, остановить,
-- перезапустить. Работало одно.
--
-- `OperationService.lifecycle()` пишет действие в `admin_operations.kind`,
-- а CHECK этой колонки знает только `restart`. Нажатие «Запустить»
-- отклонялось базой ещё до обращения к updater: оператор получал
-- «внутренняя ошибка», в журнале лежало нарушение ограничения, и связать
-- одно с другим было нечем. Ни один тест этого не ловил: поддельная база
-- в тестах ограничений схемы не проверяет.
--
-- Расширяется список, а не переписывается смысл: `start` и `stop` — такие
-- же операции жизненного цикла, как `restart`, с той же бухгалтерией и
-- тем же журналом. Существующие строки под новый список подходят все,
-- поэтому пересоздание ограничения ничего не отвергнет.

BEGIN;

ALTER TABLE admin_operations
    DROP CONSTRAINT IF EXISTS admin_operations_kind_check;

ALTER TABLE admin_operations
    ADD CONSTRAINT admin_operations_kind_check
    CHECK (kind IN ('restart', 'start', 'stop', 'backup', 'restore',
                    'update-check', 'update', 'rollback', 'migration'));

INSERT INTO schema_migrations (version) VALUES ('068_lifecycle_operation_kinds')
    ON CONFLICT DO NOTHING;

COMMIT;
