# Карта реализации

Краткая карта компонентов, реально присутствующих в `main`. Подробные контракты находятся в документах подсистем и исходных файлах.

## Letta-native runtime

| Компонент | Назначение | Путь |
|---|---|---|
| Letta session | Единственный conversational и cognitive runtime | `eva-agent-service/src/letta.ts` |
| Runtime facts/readiness | Фактические возможности и готовность Letta | `src/letta/readiness.ts`, `src/letta/capabilities.ts` |
| Memory blocks | Четыре нативных блока агента | `src/letta/memory-blocks.ts` |
| Canonical context | SDK/WebSocket system update и MemFS reconciliation, fail-open | `src/letta.ts`, `src/letta/persona-sync.ts` |
| Persona sync | Односторонняя синхронизация канонической персоны | `src/letta/persona-sync.ts`, `library/persona/eva.md` |
| Runtime context | Время, профиль, подписка, цели, курсор программы и ближайшие задачи текущего хода | `src/runtime/runtime-context.ts` |
| Непрерывность работы | ACTIVE OBJECTIVE/TURN OBJECTIVE и чекпойнт ACTIVE WORK в `current_state` | `src/letta/memory-blocks.ts`, `library/persona/eva.md` |

Граница ответственности: [letta-native.md](letta-native.md).

## Tenancy и жизненный цикл хода

| Компонент | Назначение | Путь |
|---|---|---|
| Tenant scope | Обязательная область пользователя для запросов | `src/tenancy/` |
| Turn lifecycle | Durable состояние и переходы хода | `src/turns/turn-lifecycle.ts`, `src/turns/states.ts` |
| User turn lock | FIFO и renewable lock на пользователя | `src/turns/user-turn-lock.ts` |
| Effect journal | Идемпотентность побочных действий | `src/turns/effect-journal.ts` |
| Recovery | Возобновление прерванных ходов | `src/turns/recovery.ts` |
| Approvals | Подтверждение опасных tool calls | `src/tools/approvals.ts` |

## Telegram ingress и delivery

| Компонент | Назначение | Путь |
|---|---|---|
| Durable inbox | Приём и claim Telegram updates | `src/delivery/inbox.ts`, `src/delivery/dispatcher.ts` |
| Durable outbox | Доставка без повторного LLM-turn | `src/delivery/outbox.ts` |
| Telegram limits | `retry_after` и распределённые лимиты | `src/delivery/telegram-limits.ts` |
| Интерактивные элементы | Кнопки и опросы | `src/telegram/inline-choices.ts`, `src/telegram/polls.ts` |
| Live message | Показ streaming-ответа одним редактируемым сообщением | Telegram client runtime |

## Фоновые задания

| Компонент | Назначение | Путь |
|---|---|---|
| Queue registry/driver | Единая точка BullMQ | `src/jobs/queue-registry.ts`, `src/jobs/bullmq-driver.ts` |
| Job outbox/runs | Транзакционная публикация и журнал запусков | `src/jobs/job-outbox.ts`, `src/jobs/job-runs.ts` |
| Runtime/policy | Таймауты, отмена, retry, DLQ | `src/jobs/runtime.ts`, `src/jobs/policy.ts` |
| Schedules | Канонические расписания в PostgreSQL | `src/jobs/schedules.ts` |
| Proactive jobs | Напоминания, heartbeat и check-in | `src/jobs/proactive/` |
| Maintenance | Диагностические сверки без автоматического изменения данных | `src/jobs/maintenance.ts` |

BullMQ не обрабатывает интерактивный ход и не управляет памятью агента.

## LLM и медиа

| Компонент | Назначение | Путь |
|---|---|---|
| LLM Router | Единственный выход к моделям и failover chains | `src/router/` |
| Capability probe | Проверка streaming, tools и structured output до активации | `src/llm/capability-probe.ts` |
| Vision check | Проверка маршрута изображения | `src/llm/vision-check.ts` |
| Attachments | Безопасный приём Telegram-вложений | `src/attachments/telegram-attachments.ts` |
| Documents | Извлечение текста из поддерживаемых форматов | `src/knowledge/document-text.ts` |
| Knowledge search | Tenant-scoped FTS/pgvector поиск по документам | `src/knowledge/search.ts` |

## Продуктовые сервисы

| Компонент | Назначение | Путь |
|---|---|---|
| Профиль | Поля профиля и подтверждения | `src/profile/profile-service.ts` |
| Цели | Цели, результаты и рабочие блоки | `src/goals/goal-service.ts` |
| Курсор программ | Где человек внутри длинной guided-программы; не дублирует VECTOR-Action | `src/goals/goal-program-service.ts`, `src/goals/goal-program-tools.ts` |
| Задачи | Напоминания и события | `src/tasks/task-event-service.ts` |
| Платежи | Платежи, intents и подписки | `src/payments.ts` |
| Кризисный контур | Детерминированное обнаружение риска | `src/crisis.ts` |
| Дневник | Записи, люди и недельный обзор | `src/public/journal/` |
| Каналы | Связь внешнего сообщения с внутренним пользователем | `src/channels/channel-links.ts` |

## Администрирование и инфраструктура

| Компонент | Назначение | Путь |
|---|---|---|
| Admin API | RBAC, sudo, audit и системные операции | `src/admin/` |
| Secret Store | Зашифрованные write-only секреты | `src/admin/secret-store.ts` |
| Outbound gateway | SSRF-защита внешних Base URL | `src/admin/outbound-gateway.ts` |
| Updater | Ограниченные операции обновления/перезапуска | `src/admin/updater-index.ts` |
| Observability | Метрики, трассировка и privacy boundary | `src/observability/`, `src/metrics.ts` |
| Retention | Политики и применение сроков хранения | `src/retention/` |
| Backup/restore | Зашифрованный архив и восстановление | `scripts/backup.sh`, `scripts/restore.sh`, `backup-service/` |
| Migrations | Идемпотентная схема и down-файлы | `postgres/migrations/`, `postgres/migrations/down/` |
