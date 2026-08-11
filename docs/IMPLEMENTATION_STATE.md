# Состояние реализации — snapshot

Что уже построено и что из этого обязано быть переиспользовано. Читается на
открытии batch вместо ре-скана репозитория.

Правило: **новая таблица, очередь, сервис, модуль или реестр создаётся только
после проверки по этому файлу**, что эквивалента нет (инвариант 20). Результат
проверки — в отчёте batch.

Файл обновляется в конце batch, если появился новый компонент или изменился
контракт существующего. Устаревшая строка хуже отсутствующей.

Обозначения колонки «Переиспользование»: **обяз.** — обходить запрещено,
расширяй существующее; **расш.** — расширяется по назначению; **read** —
источник фактов, не точка расширения.

## Тенантность и доступ к данным

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| TenantScope | Обязательная область арендатора для любого запроса к пользовательской таблице | `eva-agent-service/src/tenancy/scope.ts` | `UserScope`, `AdminScope`, `SystemScope`; `withUserScope()` | обяз. |
| GuardedPool | Обёртка пула: запрос вне области не выполняется | `src/tenancy/guarded-pool.ts` | `guardPool()`, `guardQuery()` | обяз. |
| SQL-анализатор | Разбор запроса и поиск предиката владельца | `src/tenancy/sql.ts` | `analyzeSql()` → `SqlAnalysis` | обяз. |
| Реестр таблиц | Какие таблицы пользовательские и по какой колонке | `src/tenancy/tables.ts` | таблица → колонка владельца | расш. |
| Проверка в CI | Тот же разбор поверх исходников | `scripts/ci/assert-tenant-scope.py` | падает на запросе без арендатора | обяз. |

Известные ограничения границы — `docs/TENANT_ISOLATION.md`.

## Жизненный цикл хода

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| Состояния хода | Канонический список и валидация переходов | `src/turns/states.ts` | список из `CLAUDE.md`, синонимов нет | обяз. |
| TurnLifecycle | Durable запись хода, идемпотентность, переходы | `src/turns/turn-lifecycle.ts` | `TurnHandle`, `turnIdempotencyKey()`, флаг `EVA_TURN_LIFECYCLE` | обяз. |
| UserTurnLock | Renewable Valkey lock + per-user FIFO | `src/turns/user-turn-lock.ts` | `TurnLockClaim`, продление, барьер отмены | обяз. |
| Семафоры слотов | Разделение 128 слотов по классам | `src/turns/semaphores.ts` | раскладка из раздела «Бюджеты» | обяз. |
| EffectJournal | Побочное действие выполняется один раз | `src/turns/effect-journal.ts` | `effectKey()`, `EffectDecision` | обяз. |
| Recovery | Восстановление прерванного хода | `src/turns/recovery.ts` | `recovery_required` → `recovering` | расш. |
| Aggregator | Объединение быстрых сообщений в один ход | `src/turns/aggregator.ts` | окно агрегации | расш. |

Разбор — `docs/TURN_LIFECYCLE.md`, `docs/TURN_RECOVERY.md`.

## Ingress и delivery

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| Durable inbox | Приём Telegram-обновлений в PostgreSQL | `src/delivery/inbox.ts`, таблица `telegram_updates` | claim через `FOR UPDATE OF t SKIP LOCKED` | обяз. |
| ParallelInboxDispatcher | Параллельная обработка разных пользователей | `src/delivery/dispatcher.ts` | `TurnProcessor`, `DispatcherOptions` | обяз. |
| Durable outbox | Доставка ответов | `src/delivery/outbox.ts`, таблица `telegram_outbox` | `OutboxDelivery`, `OutboxTransport`, `OutboxEnvelope` | обяз. |
| Приоритет доставки | Класс приоритета без перестановки частей ответа | `src/delivery/priority.ts` | сравнение кортежей | расш. |
| Лимиты Telegram | Учёт `retry_after` и лимитов чата | `src/delivery/telegram-limits.ts`, `retry-after.ts` | `telegramRetryAfterMs()` | обяз. |

Интерактивный ingress и agent runs в BullMQ не переносятся (инвариант 7).
Разбор — `docs/PARALLEL_INBOX.md`, `docs/PARALLEL_OUTBOX_DISTRIBUTED_LIMITS.md`.

## Фоновые задания

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| QueueRegistry | Единственное место создания очередей | `src/jobs/queue-registry.ts` | шесть классов; `telegram-ingress`, `agent-runs` запрещены; префикс `evaself:bullmq` | обяз. |
| Драйвер BullMQ | Единственное место импорта `bullmq` | `src/jobs/bullmq-driver.ts` | `JobQueueDriver`; тесты подставляют свой | обяз. |
| Конверт задания | Версия схемы, трассы, безопасный payload | `src/jobs/envelope.ts` | `buildJobEnvelope()`, `assertSafePayload()`, незнакомая версия — неповторяемый отказ | обяз. |
| Job outbox | Намерение в той же транзакции, идемпотентная публикация | `src/jobs/job-outbox.ts`, таблица `job_outbox` | `record(client, intent)`, `publishPending()`; `jobId = idempotency_key` | обяз. |
| Журнал запусков | Канонический факт запуска, аренда, отмена | `src/jobs/job-runs.ts`, таблица `job_runs` | `open/renew/succeed/fail/requestCancel/sweepLost` | обяз. |
| Расписания | Каноническая копия в PostgreSQL + сверка с очередью | `src/jobs/schedules.ts`, таблица `job_schedules` | `reconcile()` при старте | обяз. |
| Правила заданий | Классы отказов, сроки, дедупликация | `src/jobs/policy.ts` | `classifyJobError()`, `timingFor()`, `dedupKey()` | обяз. |
| Исполнение | Сроки, AbortController, DLQ, graceful shutdown | `src/jobs/runtime.ts`, таблица `job_dead_letters` | `register(type, handler, timing?)`, `execute()`, `stop()` без `process.exit` | обяз. |
| Вынос CPU | Тяжёлая работа вне основного event loop | `src/jobs/cpu-offload.ts` | `runCpuTask(modulePath, payload, {signal, timeoutMs})` | расш. |
| Agent job | Единственный механизм фонового хода агента: рефлексия, отчёты, исследования | `src/jobs/agent-job.ts`, таблица `agent_job_results` | `AgentJobRunner.run()`, бюджет и структурированное предложение; памяти не пишет | обяз. |
| Сверки обслуживания | Семь сверок «что застряло»; ничего не чинит | `src/jobs/maintenance.ts` | `ReconcileService.run()`, статусы `checked`/`failed`/`not_applicable` | расш. |
| Зеркало переноса | Сравнение выборок старого и нового механизмов | `src/jobs/mirror.ts`, таблица `job_mirror_samples` | `compareSelections()`, `readyToCutOver()` | обяз. |
| Проактивность | Напоминания, heartbeat, check-in на очередях | `src/jobs/proactive/`, таблицы `proactive_messages`, `checkin_episodes` | слот на местную дату, доставка только через outbox | обяз. |
| Ступень переноса | Кто владеет задачей: интервал или очередь | `src/jobs/proactive/cutover.ts` | `legacy` · `mirror` · `queue`; на `queue` интервалы не стартуют | обяз. |
| Cron в зоне пользователя | Разбор и вычисление cron | `src/time/cron.ts` | `nextCronDate()`, `assertCronExpression()`, `isQuietHours()`; реэкспорт из `background.ts` | расш. |

Флаги: `EVA_BULLMQ_JOBS`, `EVA_BULLMQ_MAINTENANCE`, `EVA_BULLMQ_PROACTIVE`,
`EVA_AGENT_JOBS` — выключены; `EVA_JOBS_MIRROR` — включён. Пока зеркало не
снято, напоминания и heartbeat по-прежнему ведёт `BackgroundRuntime`, а
очередь только сравнивает выборки. Разбор — `docs/BACKGROUND_JOBS.md`.

## Модели и роутинг

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| LlmRouter | Единственный выход к модели | `src/router/router.ts` | `LlmRouter`, `NoProviderAvailable`; проверяется в CI | обяз. |
| Цепочки failover | Независимые цепочки по маршруту | `src/router/chain.ts`, таблицы `llm_routes`, `llm_route_providers` | смена без рестарта | расш. |
| Лимиты роутера | RPM, TPM, inflight | `src/router/limits.ts` | `ValkeyRouterLimits` (распределённые), `LocalRouterLimits` | обяз. |
| Адаптеры | OpenAI-совместимый и Anthropic | `src/router/adapters/` | общий нормализатор в `shared.ts` | расш. |
| Классификатор | Чувствительность запроса | `src/router/classifier.ts`, `routing-marker.ts` | по умолчанию — чувствительный | расш. |
| Учёт | Запросы и расход | таблицы `llm_requests`, `llm_spend_ledger`, `llm_breaker_state` | — | read |

Своя fallback-цепочка в обход роутера запрещена (инвариант 16).
Разбор — `docs/llm-router.md`.

## Агент, контекст и память

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| Letta-интеграция | Единственный conversational runtime | `src/letta.ts` | `@letta-ai/letta-agent-sdk` 0.6.2; ровно шесть memory blocks | обяз. |
| Реестр возможностей Letta | Операция → кем поддержана → в какой версии | `src/letta/capabilities.ts` | `assertSupported()`, `missingCapabilities()`; неподдержанная — `unsupported_operation` | обяз. |
| Состав memory blocks | Шесть блоков, их границы и порядок | `src/letta/memory-blocks.ts` | `evaMemoryBlocks()`; реэкспорт из `letta.ts` | обяз. |
| Административный control plane | `@letta-ai/letta-client` 1.12.1 только как управляющий путь | `src/letta/admin-client.ts` | `LettaAdminPlane`; методов отправки сообщения нет | обяз. |
| Синхронизация блоков | Честный исход записи в memory block | `src/letta/memory-block-sync.ts`, таблица `letta_memory_block_sync` | `pending` · `synced` · `runtime_override` · `failed`; предпросмотр отпечатками | обяз. |
| Страж удаления | Запрет удаления при незакончившемся ходе | `src/letta/delete-guard.ts` | выборка по `turn_runs`, код `deletion_blocked` | обяз. |
| RuntimeContextBuilder | Единственный финальный сборщик контекста | `src/runtime/runtime-context.ts` | `RuntimeContext`, бюджеты из `CLAUDE.md` | обяз. |
| ConversationPurposeService | Назначения conversation и политика инструментов | `src/conversations/purpose-service.ts` | `purposePolicy()`, `toolAllowedForPurpose()` | обяз. |
| Граф памяти | Узлы, связи, поиск через FTS | `src/memory/graph-repository.ts`, `graph-context.ts`, таблицы `memory_nodes`, `memory_edges` | `websearch_to_tsquery`, глубина ≤ 3 | расш. |
| Highlights | Компактные выжимки диалога | `src/memory/conversation-highlights.ts`, таблица `conversation_highlights` | не смешивается с памятью и KB | расш. |
| Заметки | Хранилище заметок в PostgreSQL | таблица `eva_notes`, `src/tools/core-tools.ts` | инструменты названы `LIGHTRAG_*` — псевдонимы совместимости, LightRAG нет | расш. |
| Каталог инструментов | Сборка tool-схем | `src/tools/tool-kit.ts`, `core-tools.ts`, `task-tools.ts` | `ToolBuilder`, `objectSchema()` | обяз. |

## Продуктовые сервисы

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| CrisisMonitor | Детерминированный кризисный контур | `src/crisis.ts` | `detectCrisis()`, `safetyDirective()`; приоритетный, неблокирующий | обяз. |
| UserProfileService | Профиль и подтверждение полей | `src/profile/profile-service.ts` | таблицы `onboarding_fields`, `profile_field_definitions` | расш. |
| GoalService | Цели, результаты, рабочие блоки | `src/goals/goal-service.ts` | таблицы `goals`, `goal_results`, `work_blocks` | расш. |
| Задачи и события | Напоминания и их история | `src/tasks/task-event-service.ts`, таблицы `tasks`, `task_events` | `reminder_sent` отделён от `done` | расш. |
| Платежи | Провайдеры и намерения | `src/payments.ts`, таблицы `payments`, `payment_intents`, `subscriptions` | платёж ≠ право доступа (инвариант 27) | расш. |
| Квоты | Лимиты бесплатного доступа | таблицы `quotas`, `usage_counters` | 9 сеяных строк, проверяется в CI | расш. |

## Административный слой

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| admin-api | Административные маршруты, RBAC, sudo, аудит | `src/admin/server.ts`, `auth-service.ts`, `audit-service.ts` | роли owner/admin/operator/viewer; каждый маршрут объявляет доступ | обяз. |
| SecretStore | Шифрованные секреты, мастер-ключ отдельно | `src/admin/secret-store.ts` | `parseMasterKey()`, таблица `secret_records` | обяз. |
| SettingsRegistry | Реестр системных настроек и версий | `src/admin/settings-registry.ts`, таблицы `system_settings`, `config_versions` | ETag + If-Match | обяз. |
| OutboundGateway | SSRF-защита административных Base URL | `src/admin/outbound-gateway.ts` | единственный выход наружу для админки | обяз. |
| health-worker | Фоновые снимки состояния без внешних запросов из UI | `src/admin/health-worker.ts`, таблицы `health_checks`, `service_statuses` | — | расш. |
| eva-updater | Ограниченный перезапуск контейнеров | `src/admin/updater-index.ts` | сокет 0660, группа `evaself-updater`; admin-api без Docker socket | обяз. |
| SecurityAudit | Проверка конфигурации установки | `src/admin/security-audit.ts` | — | расш. |
| Реестр артефактов | Единый реестр версий: prompt, flow, skill, policy, шаблон memory block | `src/artifacts/registry.ts`, `validation.ts`, таблицы `artifacts`, `artifact_versions`, `artifact_publications`, `artifact_usages` | `createVersion()`, `publish()`, `rollback()`, `resolve()` с процентной раскаткой, `recordUsage()`; неизменяемость версии держит триггер схемы | обяз. |
| Маршруты реестра | Административная поверхность реестра | `src/admin/artifact-routes.ts` | публикация требует `confirm`, откат — причины | расш. |
| Каталог агентов | Агенты, conversations, архив, экспорт, предпросмотр удаления | `src/admin/agent-directory.ts` | читает PostgreSQL, в Letta не ходит; удаление только предпросмотром | расш. |
| Применение шаблонов памяти | Предпросмотр, массовое применение, откат шаблона memory block | `src/admin/memory-template-service.ts`, таблицы `memory_template_applications`, `memory_template_application_items` | пишет намерения только через `MemoryBlockSync`; откат — родительская версия шаблона | обяз. |
| Инструменты и approvals | Честный read-only обзор до шага 14 | `src/admin/tool-approvals.ts` | политика назначения, вызовы из `tool_effects`, ходы в `approval_pending` | read |
| Операции над ходами | Ходы, эффекты, сверка, отмена, безопасный повтор доставки | `src/admin/turn-operations.ts` | отмена ставит барьер, повтор только `dead`/`retry` без `sent_at` | расш. |
| Статусы подсистем | Навыки, исследования, evals, расширения — чего ещё нет | `src/admin/subsystem-status.ts` | статус, номер шага, пустые коллекции названы своими именами | read |
| Маршруты CRUD | Регистрация разделов шага 12 | `src/admin/crud-routes.ts` | флаг `EVA_ADMIN_CRUD`, подтверждение — идентификатор цели | расш. |
| Tool Gateway | Манифесты, live-видимость, risk policy, kill switch и tool breaker | `src/tools/gateway.ts`, `src/agent-tools.ts` | `ToolManifestRegistry`, purpose/allowedTools intersection; `EVA_TOOL_GATEWAY` | обяз. |
| Durable approvals | Подтверждение опасных tool calls по SDK request id | `src/tools/approvals.ts`, таблица `tool_approvals` | `canUseTool`, PostgreSQL outbox, Mini App decision route, recovery по request id; `EVA_TOOL_APPROVALS` | обяз. |
| MCP policy | Только admin-added HTTP/SSE с SSRF, allowlist, Secret Store и аудитом | `src/tools/gateway.ts`, таблица `mcp_server_policies` | `McpHttpInvoker`; stdio, команды, `npx -y`, wildcard запрещены | обяз. |

Матрица возможностей SDK — `docs/IMPLEMENTATION_STATUS.md`.
Контракты API — `docs/ADMIN_PHASE1_CONTRACT.md`, `docs/ADMIN_PHASES_2_6_CONTRACT.md`.

## Инфраструктура

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| Метрики | Prometheus-экспорт | `src/metrics.ts`, `src/metrics-queries.ts` | `MetricsCollector`, `MetricsSources`; метки только из закрытых словарей | расш. |
| Наблюдаемость | Единственный выход телеметрии наружу | `src/observability/gateway.ts` | `ObservabilityGateway`: Noop, Recording, Langfuse; буфер ограничен | обяз. |
| Приватность телеметрии | Что разрешено вынести наружу | `src/observability/privacy.ts` | `PrivacyProcessor`: закрытый список ключей, HMAC-псевдоним | обяз. |
| Трассировка | OTel-контекст и сквозной correlation id | `src/observability/tracing.ts` | `initTracing()` до инструментируемых модулей, `traceHeaders()`, `withSpan()` | обяз. |
| Политики хранения | Классы данных, сроки и границы | `src/retention/policy.ts` | `RETENTION_CLASSES`, `effectivePolicies()`; хранятся в Config Service | обяз. |
| Применение политик | Предпросмотр и пакетное удаление | `src/retention/service.ts`, таблицы `retention_holds`, `retention_runs` | `preview()`, `enforce()`; задержка останавливает класс целиком | обяз. |
| Rate limit | Публичные поверхности | `src/public/rate-limit.ts` | `ValkeyRateLimiter`, `clientAddress()` | обяз. |
| Mini App auth | Проверка подписи Telegram initData | `src/public/telegram-webapp-auth.ts`, `webapp-session.ts` | окно 300–600 с, защита от повтора | обяз. |
| Миграции | Схема PostgreSQL | `postgres/migrations/`, `down/` | идемпотентны, у каждой есть down | обяз. |
| Фикстуры | Данные для локальной проверки | `postgres/fixtures/` | `load.sh` безопасен при повторе | расш. |
| Backup / restore | Зашифрованный архив | `scripts/backup.sh`, `restore.sh`, `backup-service/` | мастер-ключ хранится отдельно | обяз. |

## Чего в репозитории нет

Проверено; не считать существующим:

- **Продуктовая проактивность на очередях в production** — код есть (шаг 08),
  но по умолчанию работает режим зеркала: отправляют по-прежнему интервалы
  `BackgroundRuntime`. Снятие зеркала — решение человека после сверки.
- **Рефлексия, отчёты и исследования** — механизм agent job есть, конкретных
  заданий на нём нет: они относятся к шагам 21 и 24.
- **Ежедневный инсайт и недельный обзор** — виды объявлены, источников данных
  ещё нет (шаги 27 и 54), выборка пуста.
- **Потребитель реестра артефактов во время выполнения** — реестр, публикация,
  раскатка и фиксация версий есть; ни один промпт, flow, навык или policy через
  него пока не разрешается. `artifact_usages` останется пустой, пока первый
  артефакт не начнёт браться из реестра.
- **Реестр инструментов, уровни риска и durable approvals** — шаг 14. Разделы
  административного API существуют и честно read-only.
- **Экраны новых разделов в `admin-ui`** — их нет: шаг 12 остановился на
  контракте admin-api.
- **Колонка `tenant_id`** — изоляция держится на `user_id` и области арендатора.
- **Второй RAG, Qdrant, LightRAG, LangGraph runtime, LangSmith** — запрещены.
- **Экспорт трасс в OTLP** — провайдер трасс есть, экспортёра нет намеренно:
  наружу телеметрия уходит только через `ObservabilityGateway`, чтобы
  граница приватности была одна.
- **Удаление логов и временных медиафайлов кодом сервиса** — политика для них
  объявлена и показывается, но исполняется вне PostgreSQL (драйвер логов
  Docker и media-service).
- **Полное зеркало переписки** — механизм есть, выключен
  (`EVA_CONVERSATION_MIRROR_ENABLED=false`).
