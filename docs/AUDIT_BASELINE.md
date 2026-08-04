# AUDIT_BASELINE — фактическое состояние репозитория Evaself

Документ фиксирует **факты**, снятые с кода на контрольной точке. Ничего
из документации репозитория и из текста заданий сюда не переносилось без
проверки по коду. Каждый факт снабжён ссылкой `файл:строка` или фактическим
выводом команды.

- **Дата снятия:** 2026-08-03
- **Ветка:** `step/00-bootstrap`
- **Базовый commit:** `3bd9811419020a489fd183489874ac6b74cbfc7e`
  (`Merge pull request #101 from Viktor6886/claude/evaself-audit-consolidate-ft8qjf`)
- **Незакоммиченных изменений на момент снятия:** нет (`git status --porcelain` пуст)
- **Шаг:** 00 «Аудит репозитория и фиксация baseline»

---

## 1. Окружение снятия baseline

Часть замеров снята не в целевом окружении. Это отмечено явно у каждого
пункта, где имеет значение.

| Компонент | В окружении аудита | В production (`versions.env`) |
|---|---|---|
| Node.js | v22.22.2 | образ `node:22.22-bookworm-slim` (`versions.env:54`) |
| npm | 10.9.7 | — |
| PostgreSQL | 16.13 (Ubuntu, локальный кластер) | `pgvector/pgvector:0.8.6-pg17`, major 17 (`versions.env:17-19`) |
| pgvector | 0.6.0 | 0.8.6 |
| Python | 3.11.15 | `python:3.12-slim-bookworm` (`versions.env:51`) |
| Docker | 29.3.1, демон запущен вручную | — |
| Реестр образов | **недоступен** (см. §9) | Docker Hub |

---

## 2. Сервисы `compose.yaml`

`docker compose config --services` даёт **18 сервисов по умолчанию**;
`uptime-kuma` включается профилем `monitoring` (`compose.yaml:718`).

```
admin-api admin-bootstrap admin-ui backup-service caddy crawl4ai
eva-agent-service eva-updater health-worker letta-app-server letta-ui
llm-router media-service nocodb postgres searxng valkey webapp
```

### 2.1 Роли процессов

Одному образу `evaself/eva-agent-service:0.3.0` соответствует **пять
процессов-ролей**, различающихся только `command`. Отдельный образ —
только у `eva-updater`.

| Роль | Сервис | Точка входа | Строка |
|---|---|---|---|
| Основной рантайм Евы | `eva-agent-service` | `dist/index.js` (по умолчанию) | `compose.yaml:229` |
| Bootstrap администратора | `admin-bootstrap` | `dist/admin/bootstrap-index.js` | `compose.yaml:352` |
| Административный API | `admin-api` | `dist/admin/index.js` | `compose.yaml:396` |
| Обновление стека | `eva-updater` | `dist/admin/updater-index.js` (образ `evaself/eva-updater:0.1.0`) | `compose.yaml:435` |
| Health-worker | `health-worker` | `dist/admin/health-worker-index.js` | `compose.yaml:474` |
| LLM Router | `llm-router` | `dist/router/index.js` | `compose.yaml:523` |

Переменной вида `EVA_ROLE` в `compose.yaml` нет: роль задаётся командой.

### 2.2 Тома

`compose.yaml:760-785`: `postgres_data`, `valkey_data`, `caddy_data`,
`caddy_config`, `letta_app_server_data`, `letta_provider_config`,
`letta_llm_control`, `admin_updater_socket`, `nocodb_data`,
`searxng_cache`, `eva_media_shared`, `backup_work`, `uptime_kuma_data`.

Сети: `edge`, `data`, `agent`, `tools` (`compose.yaml:745-757`).

---

## 3. PostgreSQL: фактическая схема

Схема снята **применением всех миграций к пустой базе** и опросом
`information_schema` — не чтением SQL глазами.

- Миграций в `postgres/migrations/`: **28** (`001_init` … `028_managed_llm_routing_and_task_events`).
- Все 28 применились без ошибок; `select count(*) from schema_migrations` → **28**.
- Базовых таблиц в схеме `public`: **71**.
- Представлений: **6** — `v_agent_runtime`, `v_crisis_open`,
  `v_llm_provider_health`, `v_quota_status`, `v_revenue_monthly`,
  `v_user_overview`.
- Расширений в базе `eva`: `pg_trgm 1.6`, `plpgsql 1.0`, `uuid-ossp 1.1`,
  `vector 0.6.0` (в production — `vector 0.8.6`). Устанавливаются в `postgres/init/00-init-databases.sh:66-70`.

### 3.1 Три базы, три роли

`postgres/init/00-init-databases.sh:51-53` создаёт по роли и базе на
компонент: `eva`, `nocodb`, `letta`. Плюс read-only роль для отчётных
представлений (`00-init-databases.sh:75-88`).

### 3.2 Таблицы, объявленные в миграциях, но отсутствующие в схеме

`001_init.sql` создаёт `test_results` (строка 197), `referrals` (239),
`partner_analysis_links` (260) и `notifications`. Миграция
`016_cleanup_and_safety.sql:29-54` удаляет их **только если они пусты**,
и оставляет с предупреждением, если строки есть. На чистой установке
этих таблиц нет.

Побочный эффект зафиксирован там же: `016_cleanup_and_safety.sql:59-60`
удаляет метрику `tests` из `quotas` и `usage_counters`.

Значение для будущих шагов: блок P8 (шаги 45–48, психометрия) не может
рассчитывать на существующую `test_results` — её нет.

### 3.3 Ключевые ограничения, задающие инварианты

| Инвариант | Реализация | Ссылка |
|---|---|---|
| Один активный агент на пользователя и вид | `agent_links_user_kind_uidx` UNIQUE `(user_id, kind) WHERE status='active'` | `003_agent_sdk.sql` |
| Одна активная conversation на назначение | `agent_conversations_active_purpose_uidx` UNIQUE `(agent_id, purpose) WHERE status='active'` | `013_conversation_purposes.sql` |
| Идемпотентность доставки | `telegram_outbox_idempotency_key_key` UNIQUE | `008_telegram_delivery.sql` |
| Одна активная подписка | `subscriptions_active_uidx` UNIQUE `(user_id) WHERE status IN ('trialing','active','past_due')` | `001_init.sql` |
| Однократная доставка напоминания | `task_events_delivery_once_idx` UNIQUE `(task_id, event_type, scheduled_at)` для `reminder_generated`/`reminder_sent` | `028_...sql` |

Допустимые назначения conversation (CHECK `agent_conversations_purpose_check`):
`chat`, `scheduler`, `maintenance`, `profile`, `goal_review`,
`partner_analysis`, `research`.

---

## 4. Очереди и фоновая работа

**BullMQ в репозитории отсутствует.** Поиск по `*.ts`, `*.json`, `*.yaml`
не даёт ни одного вхождения `bullmq`. Фоновая работа сейчас — это
таймеры внутри процесса и durable-таблицы PostgreSQL:

| Механизм | Что делает | Ссылка |
|---|---|---|
| `UserQueue` | Valkey-lock по Telegram ID + in-process FIFO на пользователя, с продлением аренды | `eva-agent-service/src/queue.ts:51-80` |
| Планировщик задач | `setInterval`, минимум 10 с | `src/background.ts:69-72` |
| Heartbeat | `setInterval`, минимум 60 с, `unref()` | `src/background.ts:73-78` |
| Telegram inbox | `setInterval`, опрос `telegram_updates` | `src/delivery/inbox.ts:200` |
| Telegram outbox | `setInterval`, опрос `telegram_outbox` | `src/delivery/outbox.ts:54` |

Valkey используется через `ioredis` только для блокировок; скрипты
release и renew — compare-and-delete / compare-and-expire
(`src/queue.ts:20-38`), то есть чужая аренда не снимается.

---

## 5. Feature flags

Флаги живут как переменные окружения и как записи реестра настроек
(`src/admin/settings-registry.ts`). Значения по умолчанию — из
`.env.example`:

| Флаг | Значение по умолчанию | Ссылка |
|---|---|---|
| `EVA_PROFILE_COMPLETION_ENABLED` | `true` | `.env.example:112` |
| `EVA_VECTOR_GOALS_ENABLED` | `true` | `.env.example:113` |
| `EVA_GRAPH_MEMORY_ENABLED` | `true` | `.env.example:114` |
| `EVA_CONVERSATION_MIRROR_ENABLED` | `false` | `.env.example:117`, `src/config.ts:185` |
| `EVA_OUTBOX_ENABLED` | `true` | `.env.example:118` |

Отдельной таблицы feature flags в PostgreSQL нет.

---

## 6. Внешние интеграции

| Интеграция | Как подключена | Ссылка |
|---|---|---|
| Telegram Bot API | `EVA_TELEGRAM_*`, webhook + durable inbox/outbox | `.env.example`, `src/telegram.ts` |
| Telegram Mini App | проверка подписи `HMAC-SHA256("WebAppData", token)` | `src/public/telegram-webapp-auth.ts:28-55` |
| LLM-провайдеры | только через LLM Router; прямой вызов `/chat/completions` запрещён проверкой CI | `src/router/`, `.github/workflows/ci.yml` («The LLM Router is the only way out to a model») |
| Адаптеры провайдеров | `openai.ts`, `anthropic.ts` | `src/router/adapters/` |
| Embeddings | `EVA_EMBEDDING_*` | `.env.example` |
| Letta App Server | `@letta-ai/letta-agent-sdk` 0.5.5 | `eva-agent-service/package.json` |
| SearXNG | `SEARXNG_BASE_URL`, инструмент `web_search` | `src/tools/core-tools.ts` |
| Todoist | `TODOIST_API_TOKEN`, отдельный набор инструментов | `src/tools/todoist-tools.ts` |
| NocoDB | GUI поверх базы `eva` | `compose.yaml:538` |
| media-service (ASR/TTS) | `MEDIA_*` | `media-service/` |
| Lava (платежи) | `LAVA_WEBHOOK_*`, `LAVA_PLANS_JSON` | `.env.example`, `src/payments.ts` |
| crawl4ai | `CRAWL4AI_API_TOKEN` | `compose.yaml:695` |
| Uptime Kuma | профиль `monitoring` | `compose.yaml:716-718` |

---

## 7. Зависимости

`eva-agent-service/package.json`:

```
"@letta-ai/letta-agent-sdk": "0.5.5"
"argon2": "^0.44.0"
"fastify": "5.10.0"
"ioredis": "5.11.1"
"luxon": "3.7.2"
"node-pty": "1.1.0"
"pg": "8.22.0"
```

Фактически установленные версии семейства Letta (`package-lock.json`):

```
@letta-ai/letta-agent-sdk 0.5.5
@letta-ai/letta-client    1.12.1   ← транзитивная, прямых импортов нет
@letta-ai/letta-code      0.29.9
@letta-ai/trajectory      0.2.0
```

`admin-ui/package.json` — только `playwright 1.56.1` в devDependencies.
`media-service/requirements.txt`: fastapi 0.140.7, uvicorn 0.41.0,
httpx 0.28.1, python-multipart 0.0.20, pydantic 2.12.4, PyJWT 2.10.1.

**LangChain, LangGraph, LangSmith, Qdrant, LightRAG, n8n, AgentOS,
OpenClaw в зависимостях и в коде отсутствуют.** Единственные вхождения
строки `LIGHTRAG` — имена инструментов-псевдонимов, см. §10.

---

## 8. Тесты: фактический результат

### 8.1 eva-agent-service — зелёный

```
$ npm run test          # npm run build && node --test --experimental-strip-types test/*.test.ts
# tests 333
# suites 15
# pass 333
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4852.66088

real	0m9.568s
```

### 8.2 eslint — зелёный

```
$ npm run lint
> eslint src test
(без замечаний, код возврата 0)
```

### 8.3 nocodb — зелёный

```
$ node --test nocodb/init-eva.test.mjs
# tests 3
# pass 3
# fail 0
```

### 8.4 media-service — одно падение, причина внешняя

```
$ MEDIA_WORK_DIR=/tmp/media python -m pytest
FAILED tests/test_api.py::test_probe_endpoint_rejects_a_non_media_upload
    FileNotFoundError: [Errno 2] No such file or directory: 'ffprobe'
1 failed, 123 passed, 6 skipped, 1 warning in 11.80s
```

Тест требует `ffprobe`. В production он есть в образе media-service;
в окружении аудита ffmpeg не установлен. Штатный запуск
(`scripts/run-tests.sh:20-45`) выполняет эти тесты **внутри образа**,
где зависимость присутствует. Дефектом кода это падение не является,
но и подтверждения «зелёный на чистом окружении» у нас нет.

### 8.5 scripts/validate.sh — зелёный после установки Caddy

Первый прогон, до установки Caddy, дал четыре падения:

```
$ bash scripts/validate.sh    # код возврата 1
==> Caddy configuration
  ✖ Caddyfile (edge) does not validate
  ✖ webapp/Caddyfile does not validate
  ✖ letta-ui/Caddyfile does not validate
  ✖ admin-ui/Caddyfile does not validate
==> Result
  ✖ 4 check(s) failed
```

Причина оказалась внешней: `validate.sh:70-86` при отсутствии бинарного
`caddy` уходит на `docker run caddy:2.11.4-alpine`, а реестр образов
недоступен (§9). После установки Caddy 2.11.4 из GitHub-релиза
(тот же способ, что в `.github/workflows/ci.yml`) проверка проходит
целиком:

```
$ bash scripts/validate.sh    # код возврата 0
==> Shell scripts
==> Docker Compose
==> Caddy configuration
==> GitHub workflows
==> TypeScript
==> SQL migrations
==> Secrets
==> Result
  ✔ all static checks passed
```

То есть все четыре Caddyfile валидны; падения были следствием
недоступного реестра, а не конфигурации.

`shellcheck` в окружении отсутствует, поэтому глубокая проверка shell
(`validate.sh:31`) пропущена — она выполняется в CI.

### 8.6 Сборка

```
$ rm -rf dist && npx tsc -p tsconfig.json
real	0m5.607s
```

---

## 9. Что в этом окружении выполнить нельзя

Egress-политика сессии **запрещает выкачивание слоёв образов**. Хост
блобов Docker Hub отвечает 403:

```
$ docker compose ... build backup-service
failed to solve: pgvector/pgvector:0.8.6-pg17: failed to resolve source metadata
for docker.io/pgvector/pgvector:0.8.6-pg17: failed to copy: httpReadSeeker:
failed open: failed to do request:
Get "https://production.cloudfront.docker.com/registry-v2/.../data...": Forbidden
```

```
$ curl -sS "$HTTPS_PROXY/__agentproxy/status"
"recentRelayFailures": [
  { "kind": "connect_rejected",
    "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
    "host": "production.cloudfront.docker.com:443" } ]
```

Следствия — ни один из этих замеров снять нельзя:

- полный `scripts/backup.sh` и `scripts/restore.sh` (нужны
  контейнер `backup-service`, docker-тома, `eva-agent-service` для
  инвентаря агентов — `backup.sh:56-62`, `backup.sh:72-95`, `backup.sh:104-120`);
- задержки сквозного хода и наблюдаемое поведение сессий Letta;
- фактические размеры пулов подключений под нагрузкой;
- проверка Caddyfile через образ Caddy — обойдена установкой бинарного
  Caddy 2.11.4 из GitHub-релиза, после чего `validate.sh` зелёный (§8.5).

Ubuntu-архив и GitHub Releases доступны; PPA и `apt.postgresql.org`
заблокированы тем же 403.

---

## 10. Расхождения кода с CLAUDE.md

Перечень продублирован в конце `CLAUDE.md` разделом «Расхождения,
зафиксированные аудитом шага 00». Код не менялся.

| № инварианта | Формулировка | Факт | Ссылка |
|---|---|---|---|
| 1 | PostgreSQL — источник истины в том числе для **tenancy** | Колонки `tenant_id` (или эквивалента) нет ни в одной из 71 таблицы. Изоляция арендаторов пока держится только на `user_id` и внешних ключах. | поиск `tenant` по `eva-agent-service/src` и `postgres/` — 0 совпадений |
| 8 | BullMQ — единственный слой фоновых задач | BullMQ отсутствует целиком. Фон — `setInterval` + durable-таблицы. | §4 |
| 11 | UserTurnLock | Класс называется `UserQueue`; renewable Valkey lock и per-user FIFO есть, отдельного `UserTurnLock` нет. | `src/queue.ts:50` |
| 14 | PostgreSQL FTS + pg_trgm + pgvector — единственный гибридный поиск | `pg_trgm` используется (`users_username_trgm`, `eva_notes_search_idx`). `to_tsvector` встречается **один раз** (`012_graph_memory.sql:53`). Колонок типа `vector(N)` в базе `eva` **нет вовсе** — расширение `vector` в `eva` установлено, но не используется; эмбеддинги живут в базе `letta`. Инструмент `LIGHTRAG_QUERY` ищет через `ILIKE`, а не через FTS/trgm. | `core-tools.ts:451-476` |
| 17 | Модели нельзя передавать весь каталог инструментов | Для назначения `chat` политика возвращает `allowedTools: null`, а `toolAllowedForPurpose` трактует `null` как «разрешено всё». То есть в основном диалоге модель получает весь каталог. Для остальных шести назначений список явный и узкий. | `src/conversations/purpose-service.ts:161-162, 197-203` |
| «Запрещено»: LightRAG | LightRAG запрещён | Самого LightRAG нет, но в каталоге инструментов есть имена `LIGHTRAG_INSERT` и `LIGHTRAG_QUERY` — это псевдонимы совместимости, реализованные поверх таблицы `eva_notes` в PostgreSQL. Имя вводит в заблуждение; поведение инвариант не нарушает. | `src/tools/core-tools.ts:416-476` |
| «Запрещено»: полное зеркало переписки в PostgreSQL | запрещено | Механизм зеркалирования в коде существует, но выключен по умолчанию (`false`). | `.env.example:117`, `src/config.ts:185` |
| Протокол, «Обязательные гарантии перед первым мержем» | требуется включённая защита ветки `main` | Состояние защиты ветки на GitHub из окружения аудита не подтверждено. | см. отчёт шага |
| 12 | Шесть memory blocks | **Соответствует.** `persona`, `human`, `current_state`, `goals_and_commitments`, `relationships_and_patterns`, `progress_and_hypotheses`. | `src/letta.ts:1045-1075` |
| 3, 4 | Единственный conversational runtime — Agent SDK; letta-client только как control plane | **Соответствует.** Прямых импортов `@letta-ai/letta-client` в `src` нет, пакет присутствует только транзитивно. | §7 |
| 15 | RuntimeContextBuilder — единственный сборщик контекста | **Соответствует.** | `src/runtime/runtime-context.ts:67` |
| 16 | Все обращения к моделям через LLM Router | **Соответствует**, подкреплено проверкой в CI. | `.github/workflows/ci.yml` |
| 6 | Связывание Telegram и Mini App по проверенной подписи | **Соответствует.** | `src/public/telegram-webapp-auth.ts:28-55` |
| 7 | Durable ingress и delivery в PostgreSQL | **Соответствует.** | `src/delivery/inbox.ts`, `src/delivery/outbox.ts` |

Расхождения 1, 8, 11, 14, 17 — это не дефекты, а разница между текущим
состоянием и целевым, которое строят шаги 02, 04, 07, 14, 18, 19–20.
Здесь они зафиксированы, чтобы последующие шаги не принимали целевые
формулировки CLAUDE.md за описание уже существующего кода.

---

## 11. Baseline-фикстура

Файлы: `postgres/fixtures/baseline.sql`, `postgres/fixtures/verify.sql`,
`postgres/fixtures/load.sh`.

Содержимое — только синтетическое (`telegram_id` 900000001/900000002,
префикс `fixture-`), секретов и реального PII нет.

Покрытие требований шага:

| Требование шага 00 | Что создаётся |
|---|---|
| минимум два пользователя | 2 пользователя: разные план, состояние, язык, часовой пояс |
| разные conversations | 4 conversation, назначения `chat` и `scheduler` |
| профиль | `user_preferences` ×2, `onboarding_fields` ×3, `user_north` ×1 |
| цели | `goals` ×3 (активная, черновик, черновик второго пользователя) |
| задачи | `tasks` ×2 |
| записи inbox и outbox | `telegram_updates` ×3, `telegram_outbox` ×3 |
| квота или подписка | `subscriptions` ×2, `usage_counters` ×3 |
| один побочный эффект инструмента | `eva_notes` от `save_note` + `task_events(created)` от `save_task` |
| одно ожидающее напоминание | задача `status='open'`, `remind_at` в будущем |

### 11.1 Воспроизводимость — фактический вывод

Чистая база → 28 миграций → фикстура → проверка:

```
### чистая база -> миграции -> фикстура -> проверка
миграций применено: 28
               item               | actual | expected_min | ok
----------------------------------+--------+--------------+----
 conversations разного назначения |      2 |            2 | t
 агентов                          |      2 |            2 | t
 задач                            |      2 |            2 | t
 записей inbox                    |      3 |            3 | t
 записей outbox                   |      3 |            3 | t
 настроек профиля                 |      2 |            2 | t
 ожидающих напоминаний            |      1 |            1 | t
 побочных эффектов инструмента    |      2 |            2 | t
 подписок                         |      2 |            2 | t
 полей профиля                    |      3 |            3 | t
 пользователей                    |      2 |            2 | t
 счётчиков потребления            |      3 |            3 | t
 целей                            |      3 |            3 | t
(13 rows)

NOTICE:  baseline-фикстура на месте
```

Идемпотентность — повторный прогон `baseline.sql` не меняет ни одной
таблицы:

```
$ diff before.txt after.txt && echo "IDEMPOTENT: identical counts"
IDEMPOTENT: identical counts
goals|3
inbox|3
notes|1
outbox|3
subs|2
task_events|1
tasks|2
users|2
```

### 11.2 Ограничение

Фикстура проверена на PostgreSQL 16.13 + pgvector 0.6.0, а не на
целевых 17 + 0.8.6 (§1). Ни одна конструкция фикстуры и ни одна из 28
миграций не использует возможностей, появившихся в PostgreSQL 17,
но подтверждения на целевой версии у baseline нет.

---

## 12. Backup и restore

Полная процедура (`scripts/backup.sh` → `scripts/restore.sh`) в этом
окружении не выполнялась: она требует запущенного стека (§9). Выполнена
**частичная проверка того же механизма на уровне данных** — тем же
способом, каким это делает `backup-service`:

- дамп: `pg_dump --format=custom --compress=6` — как `backup-service/backup-service:43`;
- восстановление: `pg_restore --clean --if-exists --no-owner --no-privileges`
  — как `backup-service/backup-service:112`.

```
dump создан: 282K
ошибок pg_restore: 0
--- проверка фикстуры в восстановленной базе ---
 (13 строк, все ok = t)
NOTICE:  baseline-фикстура на месте
```

Что осталось **непроверенным** и должно быть проверено на стенде с
доступным реестром образов: дамп трёх баз и globals, архивация
docker-томов, инвентарь агентов App Server, шифрование архива и
MANIFEST, полный цикл `restore.sh` на чистой машине.

---

## 13. Известные проблемы, найденные в коде

Только зафиксированы; в этом шаге ничего не исправлялось.

1. **`scripts/validate.sh` возвращает 1 без бинарного `caddy` и без
   реестра образов**, хотя сами Caddyfile валидны (§8.5). Проверка молча
   зависит от сети, тогда как остальные проверки офлайн, и отличить
   «конфигурация сломана» от «образ не скачался» по выводу нельзя.
   `validate.sh:70-86`.
2. **`test_results`, `referrals`, `partner_analysis_links` есть в
   `001_init.sql`, но удаляются `016_cleanup_and_safety.sql`.** Читая
   только `001_init.sql`, легко решить, что таблицы существуют. §3.2.
3. **Каталог инструментов целиком уходит модели в назначении `chat`**
   (`allowedTools: null`). §10, инвариант 17.
4. **Имена `LIGHTRAG_INSERT` / `LIGHTRAG_QUERY`** в каталоге инструментов
   называют компонент, который CLAUDE.md запрещает, хотя за ними стоит
   PostgreSQL. Риск: следующий агент примет их за интеграцию с LightRAG.
   `src/tools/core-tools.ts:416-476`.
5. **`LIGHTRAG_QUERY` ищет через `ILIKE '%...%'`** по `eva_notes` —
   ни FTS, ни `pg_trgm`, при том что подходящий GIN-индекс
   (`eva_notes_search_idx`) на таблице есть и не используется.
   `src/tools/core-tools.ts:459-476`.
6. **Планировщик и heartbeat живут в процессе** через `setInterval`
   без внешней координации: при нескольких репликах
   `eva-agent-service` они выполнятся в каждой. `src/background.ts:69-78`.
7. **`media-service` требует `ffprobe`**, но это нигде не объявлено
   как требование к окружению тестов вне образа. §8.4.
