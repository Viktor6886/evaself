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
| Letta-интеграция | Единственный conversational runtime | `src/letta.ts` | `@letta-ai/letta-agent-sdk`; ровно шесть memory blocks | обяз. |
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

Матрица возможностей SDK — `docs/IMPLEMENTATION_STATUS.md`.
Контракты API — `docs/ADMIN_PHASE1_CONTRACT.md`, `docs/ADMIN_PHASES_2_6_CONTRACT.md`.

## Инфраструктура

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| Метрики | Prometheus-экспорт | `src/metrics.ts` | `MetricsCollector`, `MetricsSources` | расш. |
| Rate limit | Публичные поверхности | `src/public/rate-limit.ts` | `ValkeyRateLimiter`, `clientAddress()` | обяз. |
| Mini App auth | Проверка подписи Telegram initData | `src/public/telegram-webapp-auth.ts`, `webapp-session.ts` | окно 300–600 с, защита от повтора | обяз. |
| Миграции | Схема PostgreSQL | `postgres/migrations/`, `down/` | идемпотентны, у каждой есть down | обяз. |
| Фикстуры | Данные для локальной проверки | `postgres/fixtures/` | `load.sh` безопасен при повторе | расш. |
| Backup / restore | Зашифрованный архив | `scripts/backup.sh`, `restore.sh`, `backup-service/` | мастер-ключ хранится отдельно | обяз. |

## Чего в репозитории нет

Проверено; не считать существующим:

- **BullMQ** — нет ни зависимости, ни очередей. Фоновая работа — `setInterval`
  в процессе плюс durable-таблицы. Вводится шагами 07–08.
- **Колонка `tenant_id`** — изоляция держится на `user_id` и области арендатора.
- **Второй RAG, Qdrant, LightRAG, LangGraph runtime, LangSmith** — запрещены.
- **Полное зеркало переписки** — механизм есть, выключен
  (`EVA_CONVERSATION_MIRROR_ENABLED=false`).
