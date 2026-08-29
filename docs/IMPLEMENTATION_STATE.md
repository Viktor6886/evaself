# Карта реализации

Краткая карта компонентов, реально присутствующих в `main`. Подробные контракты находятся в документах подсистем и исходных файлах.

## Letta-native runtime

| Компонент | Назначение | Путь |
|---|---|---|
| Letta session | Единственный conversational и cognitive runtime | `eva-agent-service/src/letta.ts` |
| Runtime facts/readiness | Фактические возможности и готовность Letta | `src/letta/readiness.ts`, `src/letta/capabilities.ts` |
| Memory blocks | Четыре нативных блока агента | `src/letta/memory-blocks.ts` |
| Canonical context | SDK/WebSocket system update и MemFS reconciliation, fail-open | `src/letta.ts`, `src/letta/persona-sync.ts` |
| Canonical context store | Действующие персона и системный промпт: файл репозитория либо опубликованная версия реестра артефактов | `src/runtime/canonical-context.ts`, `src/runtime/canonical-routes.ts` |
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
| Женский род | Детерминированная правка речи Евы о себе на выходе; правило персоны перестаёт быть вероятностью | `src/i18n/eva-gender.ts` |
| Оплата звёздами | Счёт, проверка до и после списания, один незавершённый checkout, запрет повтора/понижения, суммирование срока и взвешивание квот при повышении, идемпотентная выдача доступа с durable retry, восстановление неприменённых платежей и возврат — в тех же `payments`, `payment_intents`, `subscriptions` | `src/payments/stars.ts`, `src/payments/grant.ts`, `src/delivery/inbox.ts` |
| Подписка в Mini App | Тарифы и оплата внутри приложения: тот же прайс и тот же счёт, что в чате | `src/public/routes.ts`, `webapp/public/app/app.js` |
| Доставка настроек в media-service | `PUT /config/media` одним путём для формы интеграций и для переезда на другого бота | `src/admin/media-runtime.ts` |
| Боты Евы | До пяти сохранённых токенов, активен один; переезд переставляет вебхук и меняет бота в рантайме без перезапуска | `src/admin/telegram-token-service.ts`, `POST /v1/telegram/token` |
| Виды апдейтов | Один список для рантайма, панели и установщика; рантайм сверяет вебхук при старте | `src/telegram/allowed-updates.ts` |

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
| Capability probe | Проверка возможностей модели до активации. Четыре исхода: `ok`, `limited`, `config_error`, `unavailable`. Обязательны только ответ, вызов инструмента и приём его результата; поток, изображения и строгий JSON — необязательные и закрывают лишь соответствующие маршруты. Выясненное сохраняется в `supports_*` и решает отбор в `router/chain.ts` | `src/llm/capability-probe.ts` |
| Vision check | Проверка маршрута изображения | `src/llm/vision-check.ts` |
| Состояние роутера для панели | Единый view-model провайдера для `/admin/ai`: конфигурация, возможности, членство в маршрутах (`code`, `title`, `position`), breaker, расход и один операционный статус `providerStatus()`. Секреты и API key через него не проходят. Клиент ничего не досчитывает и второго запроса за провайдерами не делает | `src/admin/llm-router-service.ts` |
| Безопасные поля провайдера | Общий фильтр секретов в `additional_parameters` для `/providers` и `/llm/state`: два представления одной записи не могут разойтись в том, что считается безопасным | `src/admin/provider-safe.ts` |
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
| Статус подписки | Read-only инструмент текущего пользователя: тариф, срок, дни, расход и бесплатные сообщения; изменение моделью отсутствует; rollout под `EVA_SUBSCRIPTION_LIFECYCLE` | `src/subscriptions/status-service.ts`, `src/subscriptions/subscription-tools.ts` |
| Окончание подписки | Детерминированное предупреждение за 24 часа через durable outbox, без LLM и с идемпотентностью по подписке и сроку; выключается тем же lifecycle-флагом | `src/subscriptions/expiry-notifier.ts` |
| Кризисный контур | Детерминированное обнаружение риска | `src/crisis.ts` |
| Дневник | Записи, люди и недельный обзор | `src/public/journal/` |
| Каналы | Связь внешнего сообщения с внутренним пользователем | `src/channels/channel-links.ts` |

## Администрирование и инфраструктура

| Компонент | Назначение | Путь |
|---|---|---|
| Admin API | RBAC, sudo, audit и системные операции | `src/admin/` |
| Единая панель | Разделы агентов, подписок, персоны, Letta и мониторинга под одной сессией | `src/admin/panel-routes.ts`, `admin-ui/public/` |
| Агенты (админ) | Список, карточка, создание, изменение и удаление через production-путь Letta Agent SDK | `src/admin/agent-admin-service.ts` |
| Подписки (админ) | Ручное назначение, тариф, продление, отмена и снятие ручного решения; оплата и решение администратора различимы | `src/admin/subscription-service.ts` |
| Тарифы и оплата (админ) | Лимиты, пробные, цены в звёздах, расход, журнал платежей и возврат под sudo | `src/admin/tariff-service.ts`, `admin-ui/public/ui-tariffs.js` |
| Персона (админ) | Правка и применение канонических текстов | `src/admin/persona-admin-service.ts` |
| Letta (админ) | Runtime, диалоги, контекст и журнал Letta без открытого прокси | `src/admin/letta-console-service.ts` |
| Мониторинг | Состояние сервисов, история проверок и ошибки за окно | `src/admin/health-service.ts`, `src/admin/health-worker.ts` |
| Secret Store | Зашифрованные write-only секреты | `src/admin/secret-store.ts` |
| Outbound gateway | SSRF-защита внешних Base URL | `src/admin/outbound-gateway.ts` |
| Updater | Ограниченные операции обновления/перезапуска; цели берутся из каталога служб | `src/admin/updater-index.ts`, `src/admin/service-catalog.ts` |
| Observability | Метрики, трассировка и privacy boundary | `src/observability/`, `src/metrics.ts` |
| Retention | Политики и применение сроков хранения | `src/retention/` |
| Backup/restore | Зашифрованный архив и восстановление | `scripts/backup.sh`, `scripts/restore.sh`, `backup-service/` |
| Migrations | Идемпотентная схема и down-файлы | `postgres/migrations/`, `postgres/migrations/down/` |
