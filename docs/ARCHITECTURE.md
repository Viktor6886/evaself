# Архитектура

## Поток сообщения

```text
Telegram
  │ webhook
  ▼
PostgreSQL inbox → eva-agent-service worker
  │                  │ Telegram outbox → delivery worker
  │                  ▼
  │                Telegram Bot API
  │
  │ @letta-ai/letta-agent-sdk
  ▼
Letta App Server
  │ WebSocket
  ▼
OpenAI-compatible LLM
```

Webhook сохраняет исходный update в `telegram_updates` и сразу отвечает
Telegram. Worker забирает записи через `FOR UPDATE SKIP LOCKED`; после
временной ошибки он использует backoff, а после исчерпания попыток переводит
запись в `dead`. Ответы, уведомления, платежные сообщения и голос кладутся в
`telegram_outbox` до обращения к Bot API. Повтор доставки читает готовый
payload из outbox и не запускает ход LLM повторно.

Архитектурная граница жёсткая: только `eva-agent-service` знает URL и
capability token App Server. Telegram, WebApp и административная консоль
работают через его HTTP API.

## Состояние

- PostgreSQL: пользователи, связь `user → agent → conversation`, реестры LLM
  и настроек SDK, квоты и операционные данные.
- Letta App Server volume: agents, conversations и memory filesystem.
- Valkey: краткоживущие распределённые блокировки ходов.
- PostgreSQL: идемпотентность Telegram, пользовательские инструменты,
  расписание задач, heartbeat и платежные события.
- shared provider volume: локальный provider store официального Letta CLI.

`agent_id` и `conversation_id` сохраняются в `agent_links`; история
conversations — в `agent_conversations`. Перезапуск сервисов не создаёт
нового агента.

Перед содержательным ходом `RuntimeContextBuilder` одним агрегированным
запросом получает пользователя, agent/conversation и настройки общения.
Backend определяет язык только по содержательному сообщению (явный выбор имеет
приоритет), валидирует IANA timezone и добавляет компактный доверенный блок
`EVA_RUNTIME_CONTEXT`. Текст пользователя экранируется и помещается отдельно в
`USER_MESSAGE`; SDK 0.5.5 не имеет отдельного типа системного context message,
поэтому используется поддерживаемый SDK строковый `SendMessage`.

Синхронный путь ограничен: claim inbox, агрегированный runtime SQL,
необязательный ограниченный graph query, один Letta turn, outbox и
немедленная доставка. Извлечение важных фрагментов conversation запускается
после ответа асинхронно, читает недавнюю историю через
`LettaService.listMessages()` и не вызывает дополнительную LLM.

Локальные даты задач переводятся в UTC через Luxon с учётом IANA timezone и
DST. Неоднозначный город не угадывается: `TimezoneResolver` возвращает до трёх
кандидатов для подтверждения.

Профиль не дублируется в отдельном хранилище: значения находятся в расширенной
`onboarding_fields`, а разрешённые типы и правила — в
`profile_field_definitions`. Нечувствительный явно названный факт можно
подтвердить сразу; чувствительные сведения сохраняются только как `candidate`
до отдельного подтверждения. `ProfileCompletenessService` выбирает максимум
одну естественную подсказку, учитывает cooldown/отказ и полностью подавляет
дополнительные вопросы в кризисной или срочной теме.

## Цели и граф

Система «ВЕКТОР — Действие» хранится в `user_north`, `goals`,
`goal_results`, `goal_dependencies`, `work_blocks`, `goal_reviews`,
`goal_recommendations`, `user_strategies` и `learning_attempts`. Цель
остаётся черновиком до явного подтверждения. Основная запись и её узлы/связи
графа обновляются одной транзакцией application-layer сервисом.

`memory_nodes` и `memory_edges` изолированы по `user_id`. Первый выпуск
использует FTS, trigram и графовые связи; embeddings необязательны.
`GraphContextService` пропускает приветствия и простые команды, читает только
активные нечувствительные узлы, ограничивает глубину двумя переходами,
12 узлами, 18 связями и `statement_timeout`.

## Conversations и память Letta

`agent_conversations.purpose` разделяет `chat`, `scheduler`, `maintenance`,
`profile`, `goal_review`, `partner_analysis` и `research`. Служебные
conversations создаются лениво официальным SDK и имеют собственные политики
инструментов. Планировщик не пишет prompts в основной чат.

Новые agents получают блоки `persona`, `human`, `current_state`,
`goals_and_commitments`, `relationships_and_patterns`,
`progress_and_hypotheses`. Отдельного блока `tools` нет. Из-за отсутствия
CRUD memory blocks в SDK 0.5.5 существующие agents не пересоздаются:
актуальные данные приходят через runtime context.

Полная история хранится Letta. `conversation_highlights` содержит только
значимые решения, обязательства, артефакты, источники и наблюдения.
`EVA_CONVERSATION_MIRROR_ENABLED=false` фиксирует запрет полного зеркала по
умолчанию.

## Метрики

Каждый Telegram turn пишет один структурированный лог с
`runtime_context_ms`, `profile_check_ms`, `graph_query_ms`,
`letta_turn_ms`, `outbox_insert_ms`, `telegram_send_ms`, `total_turn_ms` и
`db_query_count`. Это позволяет отдельно увидеть служебную задержку, LLM и
доставку.

## Административное управление SDK

Браузер обращается к `/api/v1/sdk/*`; внутренний Caddy добавляет
`X-API-Key`. `eva-agent-service` выполняет list/retrieve/create/update/delete
agents и list/retrieve/create/update conversations через management API
официального SDK. Физическое удаление conversation в SDK 0.5.5 отсутствует,
поэтому WebUI архивирует его. Чат возобновляет выбранную conversation через
SDK-сессию.

Интерфейс управления Agent SDK доступен только на домене Letta. Его
маршрут `/api/*` защищён Basic Auth, добавляет внутренний `X-API-Key` и не
раскрывает его браузеру. Trace перед отдачей рекурсивно очищается от API
key, token, password, authorization, cookie и похожих полей.

Корневой `/admin/` обслуживается отдельным `admin-ui`, а
`/api/admin/v1/*` — отдельным процессом `admin-api`. Он не проксирует
Letta, не имеет Docker socket и работает только с общесистемной
конфигурацией, Secret Store, сессиями, RBAC, sudo и аудитом.

SDK 0.5.5 не содержит management-операций для изменения уже существующих
memory blocks, custom tools, MCP servers, skills и knowledge folders.
Evaself не обходит это ограничение прямыми REST-запросами: такие секции
read-only до появления соответствующих методов в официальном SDK.

Сериализуемые defaults новых agents/conversations и runtime-параметры
сессий хранятся в singleton-строке `sdk_settings`. URL и capability token
App Server остаются инфраструктурными: URL показывается только для
диагностики, token в браузер не возвращается.

## Переключение LLM

1. Кандидат проверяется прямым запросом к `/models`. Ответы 404/405/501
   означают, что модель нужно указать вручную, а не что провайдер недоступен.
2. Официальный Letta CLI с `--backend local connect openai` обновляет
   provider store. API Key вводится в скрытый интерактивный prompt через
   pseudo-terminal и не появляется в argv или логах.
3. App Server получает сигнал в shared volume и перезапускает свой процесс,
   чтобы сбросить model cache.
4. `eva-agent-service` закрывает активные SDK-сессии, выполняет healthcheck и
   обновляет model/context у всех agents и conversations через Agent SDK.
5. Только после успеха запись становится активной в PostgreSQL. При ошибке
   выполняется обратная последовательность с предыдущей конфигурацией.

## Сеть

Наружу опубликованы только 80/443 Caddy. PostgreSQL, Valkey, App Server,
`eva-agent-service`, Media Service, SearXNG и backup helper доступны
только в `evaself-network`.

## Компоненты

- Caddy — HTTPS и маршрутизация;
- `eva-agent-service` — Telegram runtime, фоновые задачи, Agent SDK, сессии,
  настройки SDK, реестр LLM и административный API;
- Letta App Server — self-hosted runtime агентов;
- PostgreSQL/Valkey — постоянное состояние и блокировки;
- NocoDB — административный просмотр данных;
- Letta UI — Dashboard, agents, conversations, чат/trace, массовые операции,
  импорт/экспорт, audit, настройки SDK и LLM;
- Media Service — ASR/TTS и ffmpeg;
- SearXNG/Crawl4AI — поиск и чтение страниц;
- backup-service — согласованные backup/restore.

## Замена старых workflow

- главный Telegram workflow → `EvaWorkflow`;
- создание персонального агента → `ensureUserAndAgent` через Agent SDK;
- обработка ошибок → единый error handler, журнал и уведомление владельца;
- typing → короткоживущий timer на время agent turn;
- текстовые ответы «по словам» → пустой эфемерный Telegram
  `sendMessageDraft`, накопление только целых слов и обязательная финальная
  отправка полного сообщения через durable outbox;
- задачи и heartbeat → `BackgroundRuntime` с блокировками PostgreSQL;
- заметки, бюджет, задачи, поиск и реакции → внешние инструменты Agent SDK;
- Lava → публичный webhook с HTTP Basic Auth, проверкой суммы и
  идемпотентной транзакцией.
- старые n8n workflows → durable TypeScript inbox/outbox, `EvaWorkflow`,
  `BackgroundRuntime`, сервисы профиля, целей и памяти; n8n в стек не входит.
