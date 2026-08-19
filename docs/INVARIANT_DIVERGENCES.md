# Расхождения инвариантов с фактическим кодом

Инварианты в `CLAUDE.md` — цель. Этот файл фиксирует, чем фактический код от
неё отличается, чтобы агент не принял целевую формулировку за описание кода.

Сверено на `main` после перехода на Letta-native архитектуру (PR #188).

**Читать при работе над шагом, который затрагивает перечисленную подсистему.**
Закрытое расхождение удаляется отсюда шагом, который его закрыл.

## Открытые

1. **Инвариант 1, tenancy.** Отдельной колонки `tenant_id` в схеме нет:
   изоляция держится на `user_id`, внешних ключах и обязательной области
   арендатора в коде (`eva-agent-service/src/tenancy/`, проверка
   `scripts/ci/assert-tenant-scope.py`). Известные ограничения границы —
   `docs/TENANT_ISOLATION.md`.
2. **Шаг 13, фиксация версий артефактов.** Механизм есть целиком: таблица
   `artifact_usages`, `ArtifactRegistry.recordUsage()`, разрешение
   действующей версии с процентной раскаткой и административный маршрут
   `GET /api/admin/v1/artifacts/usages/:runKind/:runId`. Потребителя во
   время выполнения нет: системный промпт теперь штатный и собирается
   Letta, шаблон memory block для новых агентов удалён вместе с
   `memory_template_*`. Ход по-прежнему фиксирует отпечаток промпта
   (`turn_runs.prompt_version`) и версию сценария, а `artifact_usages`
   остаётся пустой.
3. **Шаг 12, административный интерфейс.** Разделы CRUD доступны через
   admin-api за флагом `EVA_ADMIN_CRUD`; экранов в `admin-ui` для них
   по-прежнему нет. Препятствие размера снято: `admin-ui/public/ui.js`
   разрезан по разделам (`ui-core.js`, `ui-overview.js`, `ui-services.js`,
   `ui-ai.js`, `ui-ai-providers.js`, `ui-operations.js`, `ui-users.js`,
   `ui-media.js`, `ui-stt*.js`, `ui.js`), самый крупный файл — 617 строк.

## Закрытые

- **Инвариант 14, продуктовый поиск по базе знаний** — закрыт вместе с
  мультимодальностью. `knowledge_chunks` теперь читается: инструмент
  `knowledge_search` (`src/knowledge/search.ts`) ищет гибридно — FTS
  `websearch_to_tsquery` и pgvector `<=>`, слитые Reciprocal Rank Fusion, —
  в границах арендатора. Второго RAG-контура не появилось: когда искать,
  решает Letta, а не Evaself.
- **Инвариант 16, служебные поля размышления в Router** — закрыт вместе с
  мультимодальностью. `LlmMessage` несёт `provider_state`
  (`src/router/content.ts`), `fromOpenAi()` его читает, адаптеры OpenAI и
  Anthropic возвращают провайдеру как есть, `toOpenAi()` отдаёт обратно
  Letta. Поля непрозрачны: они не читаются как reasoning, не пишутся в
  журнал и не смешиваются с видимым текстом (инвариант 19). Регрессия —
  `test/router-multimodal.test.ts`, через настоящую поверхность роутера.

- **Инвариант 8, BullMQ** — закрыт batch 6. Пакет `bullmq` 6.0.10 в
  зависимостях, слой заданий — `src/jobs/` (`bullmq-driver.ts`, `policy.ts`,
  `job-outbox.ts`), durable ingress и delivery остались в PostgreSQL.
- **Инвариант 11, UserTurnLock** — закрыт шагом 04. `UserQueue`
  переименован и расширен до `UserTurnLock` (`src/turns/user-turn-lock.ts`),
  тесты — `test/user-turn-lock.test.ts`.
- **Запрет LightRAG** — закрыт PR #188. Инструменты `LIGHTRAG_INSERT` и
  `LIGHTRAG_QUERY` удалены вместе с остальным cognitive middleware; имён,
  вводящих в заблуждение, в каталоге инструментов не осталось.
- **Запрет полного зеркала переписки** — закрыт PR #188. Механизм
  зеркалирования удалён; `job_mirror_samples` относится к переносу
  фоновых заданий на BullMQ и переписки не касается.
- **Защита `main`** — подтверждена практикой: `main` принимает изменения
  только через pull request с зелёными обязательными проверками, прямой
  push и удаление ветки закрыты.
- **Дефекты `configure.sh` и `restore.sh`**, найденные шагом 00 — закрыты
  шагом 01. Регрессии держат `scripts/ci/test-env-compose-parse.sh` и
  `scripts/ci/test-restore-master-key.sh`.

## Проверено соответствующим

- **Инварианты 3 и 4** — единственный conversational и когнитивный runtime;
  `@letta-ai/letta-client` не создаёт второго пути диалога. Подтверждает
  `scripts/verify-agent-sdk.mjs` и проверка в CI «The SDK is the official
  one, and it is actually used».
- **Инвариант 5** — уникальные индексы на агента и на conversation по
  назначению; conversation — ветка сообщений, агент от неё не зависит.
- **Инварианты 6 и 7** — проверка подписи Mini App, durable ingress и
  delivery.
- **Инвариант 12** — ровно четыре memory block: `persona`, `human`,
  `current_state`, `therapeutic_framework`
  (`src/letta/memory-blocks.ts`). Теневых значений в PostgreSQL нет:
  `letta_memory_block_sync` удалена миграцией 053.
- **Инвариант 13** — MemFS включён, стартовая раскладка описана в персоне и
  навыке `memory-hygiene`. Фактическое состояние runtime видно в `/health`
  (`letta_runtime`): MemFS, источники навыков, состав инструментов, dreaming.
- **Инвариант 15** — `RuntimeContextBuilder` собирает продуктовый контекст и
  системный промпт не подменяет (`src/runtime/runtime-context.ts`).
- **Инвариант 16** — все вызовы моделей через LLM Router, подкреплено
  проверкой в CI «The LLM Router is the only way out to a model».
- **Инвариант 17** — обычный ход не передаёт в сессию ни `allowedTools`, ни
  `disallowedTools`; сужение остаётся только для явной политики хода.
