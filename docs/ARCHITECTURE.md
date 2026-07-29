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

## Административное управление SDK

Браузер обращается к `/api/v1/sdk/*`; внутренний Caddy добавляет
`X-API-Key`. `eva-agent-service` выполняет list/retrieve/create/update/delete
agents и list/retrieve/create/update conversations через management API
официального SDK. Физическое удаление conversation в SDK 0.5.5 отсутствует,
поэтому WebUI архивирует его. Чат возобновляет выбранную conversation через
SDK-сессию.

Административный интерфейс доступен на корневом домене по `/admin/`.
Маршрут `/admin-api/*` защищён той же Basic Auth, добавляет внутренний
`X-API-Key` и не раскрывает его браузеру. Trace перед отдачей рекурсивно
очищается от API key, token, password, authorization, cookie и похожих
полей.

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
- приветствие «по словам» → эфемерный Telegram `sendMessageDraft` с
  обязательной финальной отправкой полного сообщения;
- задачи и heartbeat → `BackgroundRuntime` с блокировками PostgreSQL;
- заметки, бюджет, задачи, поиск и реакции → внешние инструменты Agent SDK;
- Lava → публичный webhook с HTTP Basic Auth, проверкой суммы и
  идемпотентной транзакцией.
