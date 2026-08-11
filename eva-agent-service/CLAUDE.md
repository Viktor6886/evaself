# eva-agent-service — правила подсистемы

Инварианты, безопасность и batch-протокол — в корневом `CLAUDE.md`. Здесь
только то, что нужно при работе внутри этого сервиса.

## Команды

```
npm ci --no-audit --no-fund     # один раз за сессию
npm run build                   # обязателен перед любым тестом
node --test --experimental-strip-types test/<файл>.test.ts   # targeted
npm run lint                    # eslint src test
npm run typecheck               # tsc --noEmit
node --test --experimental-strip-types test/*.test.ts        # full regression
```

Тесты импортируют собранный код из `dist/`, поэтому **без `npm run build`
любой targeted-прогон падает с `ERR_MODULE_NOT_FOUND`** — это не поломка теста.
Пересобирай после каждой правки в `src/`.

Внешние сервисы для тестов не нужны: PostgreSQL и Valkey подменены фейками.
Полный прогон занимает около десяти секунд.

## Targeted tests: модуль → тест

Изменил слева — запусти справа. В конце batch — весь набор.

| Изменение в | Тесты |
|---|---|
| `src/tenancy/` | `tenant-isolation.test.ts` |
| `src/turns/turn-lifecycle.ts`, `states.ts` | `turn-lifecycle.test.ts` |
| `src/turns/semaphores.ts` | `turn-semaphores.test.ts` |
| `src/turns/user-turn-lock.ts` | `user-turn-lock.test.ts` |
| `src/turns/recovery.ts`, `effect-journal.ts` | `session-recovery.test.ts` |
| `src/delivery/inbox.ts`, `dispatcher.ts`, `aggregator.ts` | `parallel-inbox.test.ts`, `delivery.test.ts` |
| `src/delivery/outbox.ts`, `priority.ts`, `telegram-limits.ts`, `retry-after.ts` | `parallel-outbox.test.ts`, `step06-distributed-delivery.test.ts` |
| `src/jobs/` (слой) | `jobs-foundation.test.ts` |
| `src/jobs/proactive/`, `agent-job.ts`, `maintenance.ts`, `mirror.ts` | `jobs-proactive.test.ts` |
| `src/background.ts`, `src/time/cron.ts` | `runtime.test.ts`, `conversations.test.ts` |
| `src/router/` | `llm-router.test.ts`, `managed-routing.test.ts`, `llm.test.ts`, `llm-reasoning.test.ts` |
| `src/letta.ts` | `letta.test.ts` |
| `src/runtime/runtime-context.ts` | `runtime.test.ts` |
| `src/conversations/purpose-service.ts` | `conversations.test.ts` |
| `src/memory/graph-*.ts` | `graph.test.ts` |
| `src/memory/conversation-highlights.ts` | `highlights.test.ts` |
| `src/tools/`, `src/agent-tools.ts` | `agent-tools.test.ts` |
| `src/crisis.ts` | `crisis.test.ts` |
| `src/payments.ts` | `payments.test.ts` |
| `src/profile/` | `profile.test.ts` |
| `src/goals/` | `goals.test.ts` |
| `src/public/rate-limit.ts` | `rate-limit.test.ts` |
| `src/public/webapp-session.ts`, `telegram-webapp-auth.ts` | `webapp-session.test.ts` |
| `src/public/routes.ts`, `webapp-core.ts` | `public-api.test.ts` |
| `src/admin/` | `admin-operations.test.ts`, `admin-security.test.ts`, `security-audit.test.ts`, `user-service.test.ts`, `settings-presets.test.ts`, `stt-admin.test.ts` |
| `src/metrics.ts` | `metrics.test.ts` |
| `src/config.ts` | `config-warnings.test.ts` |
| `src/server.ts` | `server.test.ts` |
| `src/telegram-format.ts`, `telegram.ts` | `telegram-format.test.ts`, `telegram-layout.test.ts` |
| `src/i18n/` | `locale.test.ts` |
| `src/sdk-settings.ts` | `sdk-settings.test.ts` |
| `src/errors.ts` | `errors.test.ts` |

Меняешь публичный контракт модуля — прогоняй и тесты его потребителей, а не
только его собственный.

## Что нельзя проверить локально

Эти проверки требуют настоящих PostgreSQL и Valkey и выполняются только в CI.
Не выдавай их за пройденные:

- `scripts/ci/test-inbox-claim.sql`, `test-outbox-claim.sql`,
  `test-effect-journal.sql` — семантика `SKIP LOCKED`, `ON CONFLICT`,
  сравнение кортежей;
- `scripts/ci/test-distributed-limits.mjs` — атомарность лимитов на Valkey;
- прогон миграций и цикл down/up;
- smoke-стенд всего набора сервисов.

Их зеркала на фейках в TypeScript-тестах повторяют правила выборки, но не
проверяют сам SQL.

## Правила кода

- Каждый запрос к пользовательской таблице выполняется в области арендатора
  (`src/tenancy/`). Забытый `WHERE user_id` даёт зелёные тесты и утечку;
  ловит `scripts/ci/assert-tenant-scope.py`.
- Каждый административный маршрут объявляет роли. Проверка в `server.ts`
  начинается с `access.roles &&`, поэтому маршрут без объявления доступен всем
  вошедшим; ловит `scripts/ci/assert-admin-route-access.py`.
- Любой выход к модели — через `src/router/`. Прямой `chat/completions`
  вне `src/router/` валит CI.
- Новая переменная окружения добавляется одновременно в `.env.example`,
  `compose.yaml` и установщик; ловит `scripts/ci/assert-env-plumbing.py`.
- Секреты, PII и сырой пользовательский текст не попадают в логи и в Valkey.
- Состояния хода берутся из `src/turns/states.ts`. Синоним состояния —
  нарушение инварианта, а не удобство.

## Размер файла

Шесть файлов сервиса перешагнули 900 строк и стоят десятков тысяч токенов при
каждом полном чтении:

| Файл | Строк |
|---|---|
| `src/admin/stt-service.ts` | 1879 |
| `src/server.ts` | 1428 |
| `src/letta.ts` | 1395 |
| `src/db.ts` | 1159 |
| `src/admin/server.ts` | 1092 |
| `src/public/webapp-core.ts` | 1070 |
| `src/eva-workflow.ts` | 973 |
| `src/router/router.ts` | 928 |

Шаг, который такой файл и так переписывает, оставляет после себя модули
поменьше. Отдельным рефакторингом — нельзя.

Целиком читается только тот модуль, который шаг меняет. Из соседнего берётся
нужный участок поиском, а не файл целиком.

## Комментарии

Комментарий объясняет, почему решение именно такое и какой отказ оно
предотвращает, а не пересказывает код. Так написан существующий код — держи
ту же плотность.
