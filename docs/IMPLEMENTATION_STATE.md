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
| Отметки окна | Время каждого сообщения окна и промежутки между ними | `src/turns/message-timeline.ts` | `messageBatchTiming()`, `timelineLines()`, `timelineDetail()`; отметки берутся у Telegram, в журнал уходят метаданные без текста | обяз. |
| Останов | Прерывание идущего хода по просьбе человека | `TurnLifecycle.cancelActiveForUser()`, команда `/stop` | идёт мимо очереди пользователя; новые сообщения ход не прерывают | обяз. |

Разбор — `docs/TURN_LIFECYCLE.md`, `docs/TURN_RECOVERY.md`.

## Ingress и delivery

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| Durable inbox | Приём Telegram-обновлений в PostgreSQL | `src/delivery/inbox.ts`, таблица `telegram_updates` | claim через `FOR UPDATE OF t SKIP LOCKED` | обяз. |
| ParallelInboxDispatcher | Параллельная обработка разных пользователей | `src/delivery/dispatcher.ts` | `TurnProcessor`, `DispatcherOptions` | обяз. |
| Durable outbox | Доставка ответов | `src/delivery/outbox.ts`, таблица `telegram_outbox` | `OutboxDelivery`, `OutboxTransport`, `OutboxEnvelope` | обяз. |
| Приоритет доставки | Класс приоритета без перестановки частей ответа | `src/delivery/priority.ts` | сравнение кортежей | расш. |
| Лимиты Telegram | Учёт `retry_after` и лимитов чата | `src/delivery/telegram-limits.ts`, `retry-after.ts` | `telegramRetryAfterMs()` | обяз. |
| Кнопки выбора | Варианты под ответом Евы | `src/telegram/inline-choices.ts`, `present_inline_choices`, таблица `telegram_callback_tokens` | `callback_data` — непрозрачный серверный токен; клавиатура встаёт на последнее сообщение ответа; выбор возвращается значением из записи | обяз. |
| Опросы | Нативный опрос Telegram | `src/telegram/polls.ts`, `send_poll`, `TelegramClient.sendPoll()`, таблицы `telegram_polls`, `telegram_poll_answers` | неанонимный по умолчанию; запись заводится до отправки по `tool_call_id`; `poll_answer` разбирается по серверному соответствию и становится обычным ходом | обяз. |
| Растущее сообщение | Показ ответа по мере генерации | `TelegramClient.startLiveMessage()` | первый срез — `sendMessage`, дальше `editMessageText` того же сообщения не чаще 800 мс; итог доводится durable-правкой через outbox; `sendMessageDraft` не используется — он занимает поле ввода | обяз. |

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
| Сверки обслуживания | Шесть сверок «что застряло»; ничего не чинит | `src/jobs/maintenance.ts` | `ReconcileService.run()`, статусы `checked`/`failed` | расш. |
| Зеркало переноса | Сравнение выборок старого и нового механизмов | `src/jobs/mirror.ts`, таблица `job_mirror_samples` | `compareSelections()`, `readyToCutOver()` | обяз. |
| Проактивность | Напоминания, heartbeat, check-in на очередях | `src/jobs/proactive/`, таблицы `proactive_messages`, `checkin_episodes` | слот на местную дату, доставка только через outbox | обяз. |
| Ступень переноса | Кто владеет задачей: интервал или очередь | `src/jobs/proactive/cutover.ts` | `legacy` · `mirror` · `queue`; на `queue` интервалы не стартуют | обяз. |
| Cron в зоне пользователя | Разбор и вычисление cron | `src/time/cron.ts` | `nextCronDate()`, `assertCronExpression()`, `isQuietHours()`; реэкспорт из `background.ts` | расш. |

Флаги в `.env.example`, то есть на новой установке: `EVA_BULLMQ_JOBS` и
`EVA_BULLMQ_MAINTENANCE` — включены, `EVA_BULLMQ_PROACTIVE` — выключен,
`EVA_JOBS_MIRROR` — включён. Пока зеркало не снято, напоминания и
heartbeat по-прежнему ведёт `BackgroundRuntime`, а очередь только сравнивает
выборки. На уже настроенной установке значения берутся из её `.env` и
обновлением не меняются. Разбор — `docs/BACKGROUND_JOBS.md`.

## Модели и роутинг

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| LlmRouter | Единственный выход к модели | `src/router/router.ts` | `LlmRouter`, `NoProviderAvailable`; проверяется в CI | обяз. |
| Цепочки failover | Независимые цепочки по маршруту | `src/router/chain.ts`, таблицы `llm_routes`, `llm_route_providers` | смена без рестарта | расш. |
| Лимиты роутера | RPM, TPM, inflight | `src/router/limits.ts` | `ValkeyRouterLimits` (распределённые), `LocalRouterLimits` | обяз. |
| Адаптеры | OpenAI-совместимый и Anthropic | `src/router/adapters/` | общий нормализатор в `shared.ts` | расш. |
| Выбор маршрута | Техническая цепочка провайдеров | `src/router/routes.ts`, `routing-marker.ts` | детерминированно: режим, явный запрос, изображение/JSON, назначение conversation, выбор человека; содержание сообщения не разбирается | обяз. |
| Проверка совместимости модели | Технический probe перед активацией | `src/llm/capability-probe.ts` | `probeModelCapabilities()`: ответ, streaming, вызов инструмента, JSON-аргументы, приём результата (assistant-сообщение с `reasoning_details` возвращается провайдеру без изменений), строгий JSON и Structured Outputs — отдельными неблокирующими проверками; отдельно проверяется цикл в форме LLM Router (без служебных полей), потому что роутер их сегодня не переносит; идёт с `additional_parameters` провайдера без секретов и маршрутизации; единственное разрешённое обращение к `/chat/completions` мимо роутера | обяз. |
| Мультимодальный формат | Изображение и непрозрачное состояние провайдера во внутреннем формате роутера | `src/router/content.ts`, `types.ts` | `parseContent()`, `containsImage()`, `pickProviderState()`; `LlmMessage.parts` и `provider_state` переносятся провайдеру без чтения и без журнала | обяз. |
| Проверка распознавания медиа | Настоящее изображение через production Router | `src/llm/vision-check.ts` | `runVisionCheck()`: указатель `eva/chat`, маршрут выбирает роутер; сверяется `x_eva_router.route === "vision"` и названный цвет; маршрут `POST /v1/llm/vision-check` | обяз. |
| Учёт | Запросы и расход | таблицы `llm_requests`, `llm_spend_ledger`, `llm_breaker_state` | — | read |

Своя fallback-цепочка в обход роутера запрещена (инвариант 16).
Разбор — `docs/llm-router.md`.

## Агент, контекст и память

Память и мышление принадлежат Letta. Здесь только то, чем Evaself владеет на
своей стороне границы; сама граница — `docs/letta-native.md`.

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| Letta-интеграция | Единственный когнитивный runtime | `src/letta.ts` | `@letta-ai/letta-agent-sdk` 0.7.1; сессия без `systemPrompt`, `skillSources` и внешнего сужения инструментов | обяз. |
| Факты runtime | Что подтвердил сам runtime: MemFS, источники навыков, состав инструментов, dreaming | `src/letta.ts`, `LettaRuntimeFacts` | снимок из `init`-сообщения SDK; виден в `/health` как `letta_runtime` | обяз. |
| Реестр возможностей Letta | Операция → кем поддержана → в какой версии | `src/letta/capabilities.ts` | `assertSupported()`, `missingCapabilities()`; неподдержанная — `unsupported_operation` | обяз. |
| Состав memory blocks | Четыре блока и их границы | `src/letta/memory-blocks.ts` | `evaMemoryBlocks()`: `persona`, `human`, `current_state`, `therapeutic_framework` | обяз. |
| Административный control plane | `@letta-ai/letta-client` 1.12.1 только как управляющий путь | `src/letta/admin-client.ts` | `LettaAdminPlane`; методов отправки сообщения нет | обяз. |
| Синхронизация персоны | Канонический текст персоны существующим агентам | `src/letta/persona-sync.ts` | `PersonaSync.sync()` при старте и `syncAgent()` с ограничением по времени перед ходом устаревшего агента; одно направление файл → агент; control plane включён по умолчанию; состояние видно в `/health` (`checks.persona_sync`) и в `doctor`; в PostgreSQL остаётся отметка версии, не значение блока | расш. |
| Страж удаления | Запрет удаления при незакончившемся ходе | `src/letta/delete-guard.ts` | выборка по `turn_runs`, код `deletion_blocked` | обяз. |
| Готовность | Может ли Ева работать | `src/letta/readiness.ts` | `evaluateReadiness()`: `state` — `ready`/`degraded`/`not_ready`, срок годности снимка фактов, `observed_at`; маршрут `/ready` | обяз. |
| RuntimeContextBuilder | Сборщик продуктового контекста | `src/runtime/runtime-context.ts` | `RuntimeContext`: местное и UTC время, день недели, месяц, год, часовой пояс, промежуток с прошлого сообщения, окно быстрых сообщений, профиль, подписка, состояние целей; системный промпт не подменяет; потолок 2000 знаков, размер виден в `/metrics` | обяз. |
| ConversationPurposeService | Назначения conversation | `src/conversations/purpose-service.ts` | `purposePolicy()`, `toolAllowedForPurpose()` — область продуктовых инструментов по назначению, не выбор навыка | обяз. |
| Заметки | Хранилище заметок в PostgreSQL | таблица `eva_notes` | продуктовые данные; когнитивной памятью не является | расш. |
| Каталог инструментов | Сборка tool-схем продуктовых инструментов | `src/tools/tool-kit.ts`, `core-tools.ts`, `task-tools.ts` | `ToolBuilder`, `objectSchema()` | обяз. |
| Чтение страниц | `web_read` через локальный Crawl4AI | `src/tools/web-read.ts` | `Crawl4aiReader`: заголовок `Authorization`, защита от SSRF, лимит размера, конверт недоверенного содержимого | обяз. |
| Навыки | Двенадцать навыков в `skills/<name>/SKILL.md` | каталог `skills/`, монтируется как `/data/letta/.skills` | открывает Letta по `description`; роутера навыков нет | обяз. |

## Продуктовые сервисы

| Компонент | Назначение | Путь | Контракт | Переисп. |
|---|---|---|---|---|
| CrisisMonitor | Детерминированный кризисный контур | `src/crisis.ts` | `detectCrisis()`, `safetyDirective()`; приоритетный, неблокирующий; событие пишется метаданными, сам текст не хранится | обяз. |
| UserProfileService | Профиль и подтверждение полей | `src/profile/profile-service.ts` | таблицы `onboarding_fields`, `profile_field_definitions` | расш. |
| GoalService | Цели, результаты, рабочие блоки | `src/goals/goal-service.ts` | таблицы `goals`, `goal_results`, `work_blocks` | расш. |
| Задачи и события | Напоминания и их история | `src/tasks/task-event-service.ts`, таблицы `tasks`, `task_events` | `reminder_sent` отделён от `done` | расш. |
| Платежи | Провайдеры и намерения | `src/payments.ts`, таблицы `payments`, `payment_intents`, `subscriptions` | платёж ≠ право доступа (инвариант 27) | расш. |
| Квоты | Лимиты бесплатного доступа | таблицы `quotas`, `usage_counters` | 9 сеяных строк, проверяется в CI | расш. |
| Разбор документов | Текст из PDF, DOCX, TXT, MD, JSON, CSV, YAML, HTML | `src/knowledge/document-text.ts` | `documentMimeOf()`, `extractDocumentText()`; общий и для приёма в базу знаний, и для вложений Telegram — второго разбора нет | обяз. |
| Вложения Telegram | Классификация и безопасная загрузка вложения хода | `src/attachments/telegram-attachments.ts` | `telegramMediaKind()`, `TelegramAttachmentReader`: предел байтов, сверка настоящего типа, конверт недоверенного содержимого; картинка едет картинкой, голос и аудио-документ — тем же STT | обяз. |
| Поиск по базе знаний | Гибридный поиск по загруженным документам | `src/knowledge/search.ts` | `KnowledgeSearch.search()`: FTS `websearch_to_tsquery` и pgvector `<=>`, слияние Reciprocal Rank Fusion; граница арендатора; инструмент `knowledge_search` — когда искать, решает Letta | обяз. |

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
| Реестр артефактов | Единый реестр версий: prompt, flow, skill, policy | `src/artifacts/registry.ts`, `validation.ts`, таблицы `artifacts`, `artifact_versions`, `artifact_publications`, `artifact_usages` | `createVersion()`, `publish()`, `rollback()`, `resolve()` с процентной раскаткой, `recordUsage()`; неизменяемость версии держит триггер схемы | обяз. |
| Маршруты реестра | Административная поверхность реестра | `src/admin/artifact-routes.ts` | публикация требует `confirm`, откат — причины | расш. |
| Каталог агентов | Агенты, conversations, архив, экспорт, предпросмотр удаления | `src/admin/agent-directory.ts` | читает PostgreSQL, в Letta не ходит; удаление только предпросмотром | расш. |
| Инструменты и approvals | Обзор политики и вызовов | `src/admin/tool-approvals.ts` | политика назначения, вызовы из `tool_effects`, ходы в `approval_pending` | read |
| Операции над ходами | Ходы, эффекты, сверка, отмена, безопасный повтор доставки | `src/admin/turn-operations.ts` | отмена ставит барьер, повтор только `dead`/`retry` без `sent_at` | расш. |
| Статусы подсистем | Навыки, исследования, evals, расширения — чего ещё нет | `src/admin/subsystem-status.ts` | статус, номер шага, пустые коллекции названы своими именами | read |
| Маршруты CRUD | Регистрация разделов шага 12 | `src/admin/crud-routes.ts` | флаг `EVA_ADMIN_CRUD`, подтверждение — идентификатор цели | расш. |
| Durable approvals | Подтверждение опасных tool calls по SDK request id | `src/tools/approvals.ts`, таблица `tool_approvals` | `canUseTool`, PostgreSQL outbox, Mini App decision route, recovery по request id; `reconcileStaleApprovals()` перед восстановлением снимает незакрытое разрешение и незавершённое ожидание старше срока (отказ человека не трогает); `EVA_TOOL_APPROVALS` | обяз. |
| MCP policy | Только admin-added HTTP/SSE с SSRF, allowlist, Secret Store и аудитом | `src/tools/mcp.ts`, таблица `mcp_server_policies` | `McpHttpInvoker`; stdio, команды, `npx -y`, wildcard запрещены | обяз. |
| Панель по разделам | Статика админки: раздел — файл | `admin-ui/public/ui-core.js` и `ui-<раздел>.js`, точка входа `ui.js` | обычные скрипты с общей глобальной областью, порядок подключения задан в `index.html`; `ui-core.js` первым, `ui.js` последним | расш. |
| Раздел «Распознавание медиа» | Цепочка `vision` и проверка тракта | `admin-ui/public/ui-media.js`, `POST /api/admin/v1/llm/vision/check` | своего реестра провайдеров нет: тот же `/llm/state` и те же обработчики цепочки, что у раздела моделей | расш. |

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
| Дневник Mini App | Запись дня, люди, голосовая заметка; сохранение без ИИ | `src/public/journal/service.ts`, таблицы `journal_entries`, `journal_entry_links`, `journal_people`, `journal_entry_people`, `journal_voice_notes` | создание и правка не обращаются к модели; удаление снимает связи, упоминания, заметку и осиротевшую карточку человека; `EVA_MINIAPP_JOURNAL_V2` | обяз. |
| Недельный обзор | Детерминированный обзор по дневнику, отметкам, задачам и целям | `src/public/journal/weekly-review.ts` | считает код, не модель; меньше 5 наблюдений — вывода нет | обяз. |
| Обсуждение записи | Директива и правило одного вопроса | `src/public/journal/discussion.ts` | `buildDiscussionRequest()` вызывает `detectCrisis` до выбора модели; `limitQuestions()` срезает лишние вопросы детерминированно | обяз. |
| Разделение источников | «Спросить Еву»: память, записи, внешние источники, вывод модели | `src/public/journal/ask.ts` | у каждого пункта доказательство; уверенность считает код, вывод модели ≤ 0.7; выключенная подсистема объявляется выключенной | обяз. |
| Связь каналов | Одно сообщение канала — один ход и одна conversation | `src/channels/channel-links.ts`, таблица `channel_message_links` | ключ объединения только внутренний `user_id`; имя и username ключом не являются | обяз. |
| Миграции | Схема PostgreSQL | `postgres/migrations/`, `down/` | идемпотентны, у каждой есть down | обяз. |
| Фикстуры | Данные для локальной проверки | `postgres/fixtures/` | `load.sh` безопасен при повторе | расш. |
| Backup / restore | Зашифрованный архив | `scripts/backup.sh`, `restore.sh`, `backup-service/` | мастер-ключ хранится отдельно | обяз. |

## Чего в репозитории нет

Проверено; не считать существующим:

- **Продуктовая проактивность на очередях в production** — код есть (шаг 08),
  но по умолчанию работает режим зеркала: отправляют по-прежнему интервалы
  `BackgroundRuntime`. Снятие зеркала — решение человека после сверки.
- **Ежедневный инсайт и недельный обзор** — виды объявлены, источников данных
  ещё нет, выборка пуста.
- **Потребитель реестра артефактов во время выполнения** — реестр, публикация,
  раскатка и фиксация версий есть; ни один артефакт через него не разрешается.
  Системный промпт теперь штатный и собирается Letta, шаблоны memory block
  удалены. `artifact_usages` останется пустой, пока первый артефакт не начнёт
  браться из реестра.
- **Экраны новых разделов в `admin-ui`** — их нет: шаг 12 остановился на
  контракте admin-api.
- **Колонка `tenant_id`** — изоляция держится на `user_id` и области арендатора.
- **Поиск по базе знаний** — `knowledge_chunks` заполняется приёмом
  документов, читающего пути нет: по базе знаний сегодня никто не ищет.
- **Самописный cognitive middleware** — удалён целиком (PR #188): ToolGateway,
  SkillRouter, Memory Curator, Memory Doctor, графовая и temporal память,
  Hybrid Retrieval, Deep Recall, выжимки разговора, MemoryBlockSync,
  субагенты Evaself, своя ротация conversation. Восстанавливать нельзя —
  инвариант 3.
- **Второй RAG, Qdrant, LightRAG, LangGraph runtime, LangSmith** — запрещены.
- **Экспорт трасс в OTLP** — провайдер трасс есть, экспортёра нет намеренно:
  наружу телеметрия уходит только через `ObservabilityGateway`, чтобы
  граница приватности была одна.
- **Удаление логов и временных медиафайлов кодом сервиса** — политика для них
  объявлена и показывается, но исполняется вне PostgreSQL (драйвер логов
  Docker и media-service).
- **Автоматическая сверка срока голосовых заметок дневника** — срок
  ставится при записи (`journal_voice_notes.expires_at`), сверка
  `expireVoiceNotes()` реализована и вызывается маршрутом
  `POST /public/v2/journal/voice/expire`, но периодически её никто не
  запускает: у класса хранения в `RETENTION_CLASSES` срок задаётся
  настройкой, а здесь он живёт в самой строке, и подгонять модель
  шага 10 под этот случай внутри шага 25 нельзя. Пока сверку запускает
  человек. Удаление самого файла, как и для `media_temp`, исполняется в
  media-service, а не этим кодом.


## Навыки

Двенадцать навыков в стандартном `skills/<name>/SKILL.md`, каталог
монтируется в App Server как `/data/letta/.skills`. Открывает их Letta по
`description`. Роутера навыков, скоринга триггеров, sticky-состояния,
индекса навыков в PostgreSQL и отдельного LLM-вызова для выбора навыка нет
и быть не должно.

## Evals

`evals/` — изолированный от production runtime воспроизводимый framework,
synthetic datasets, раздельные lane reports, internal API и Telegram
simulator targets; fast release gate в CI.

## Batch 16 — knowledge and research production wiring

Authenticated Mini App ingress derives identity only from verified Telegram
initData. Upload storage precedes the outbox transaction and compensates
failures; the registered knowledge worker uses fail-closed ClamAV and
canonical LLM Router embeddings. Research uses OutboundGateway and the
canonical router, with tenant-scoped status/cancel/report.

### Разбор темы после правки пути в интернет

Поиск и чтение переживают отказ отдельного источника: пачки выполняются
через `Promise.allSettled`, число отказов уходит в отчёт (`ResearchIssues`).
Источники канонизируются и дедуплицируются до `maxSources`, а не после, и
ранжируются по совпадению с запросом. Схема фактов одна на запрос и на
разбор — `src/research/schema.ts`; несошедшаяся схема отказывает вслух
(`structuredStrict`), а не превращается в успешные ноль фактов.

## Batch 17 — Mini App: дневник и адаптация под смартфоны

Дневник живёт отдельно от `eva_notes`: заметка — рабочая информация, у
неё нет ни настроения, ни даты события, ни голосовой версии, ни
разделения «сохранено без ИИ» и «отдано Еве». Маршруты дневника
регистрируются внутри уже защищённой группы `/public/v2` и при
выключенном `EVA_MINIAPP_JOURNAL_V2` отсутствуют целиком: пустой список
означал бы «дневник есть, но он пуст».

**Дублирующая версия публичного API не удалена.** `/public/tasks` и
`/public/v2/tasks` сосуществуют: пункт 13 шага 25 разрешает удаление
только после перевода всех потребителей, паритета телеметрии, периода
совместимости и проверенного отката. Mini App пока читает оба (`app.js`
падает на `/public/today` и `/public/tasks`, когда `/public/v2/dashboard`
недоступен), паритет телеметрии не измерялся. Удаление — отдельная
работа, не часть этого batch.

Вёрстка Mini App и Admin UI проверяется восемью разрешениями из шага 26
в настоящем браузере: `webapp/test/mobile.test.mjs`,
`admin-ui/test/mobile.test.mjs`. Область нажатия задана одной
переменной `--tap` (44px); таблицы Admin UI ниже 720 пикселей
раскладываются карточками — подписи столбцов проставляет
`labelTableCells()` наблюдателем, а не тридцать мест сборки таблиц.

# Batch 16 operational rollback

Before applying `postgres/migrations/down/051_knowledge_research.sql`, run
`DATABASE_URL=... EVA_KNOWLEDGE_UPLOAD_ROOT=/data/knowledge-uploads scripts/rollback-knowledge-research.sh`.
The wrapper deletes owned uploads, verifies the root is empty, and only then
executes the down migration; any remaining file or cleanup failure aborts rollback.
