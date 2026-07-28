# Архитектура

## Поток сообщения

```text
Telegram
  │ webhook
  ▼
n8n ──HTTP + X-API-Key──► eva-agent-service
                              │
                              │ @letta-ai/letta-agent-sdk
                              ▼
                         Letta App Server
                              │ WebSocket
                              ▼
                     OpenAI-compatible LLM
```

Архитектурная граница жёсткая: только `eva-agent-service` знает URL и
capability token App Server. n8n, WebApp и административная консоль
работают через его HTTP API.

## Состояние

- PostgreSQL: пользователи, связь `user → agent → conversation`, реестры LLM
  и настроек SDK, квоты и операционные данные.
- Letta App Server volume: agents, conversations и memory filesystem.
- Valkey: очередь n8n и краткоживущие блокировки ходов.
- n8n volume и PostgreSQL: workflows, executions и credentials.
- shared provider volume: локальный provider store официального Letta CLI.

`agent_id` и `conversation_id` сохраняются в `agent_links`; история
conversations — в `agent_conversations`. Перезапуск сервисов не создаёт
нового агента.

## Административное управление SDK

Браузер обращается к `/api/v1/sdk/*`; внутренний Caddy добавляет
`X-API-Key`. `eva-agent-service` выполняет list/retrieve/create/update/delete
agents и list/retrieve/create/update conversations через management API
официального SDK. Физическое удаление conversation в SDK 0.5.2 отсутствует,
поэтому WebUI архивирует его. Чат возобновляет выбранную conversation через
SDK-сессию.

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
`eva-agent-service`, Media Service, SearXNG, workers и backup helper доступны
только в `evaself-network`.

## Компоненты

- Caddy — HTTPS и маршрутизация;
- n8n — workflows и бизнес-логика;
- `eva-agent-service` — Agent SDK, сессии, настройки SDK, реестр LLM и
  административный API;
- Letta App Server — self-hosted runtime агентов;
- PostgreSQL/Valkey — постоянное состояние и очередь;
- NocoDB — административный просмотр данных;
- Letta UI — agents, conversations, чат, настройки SDK и LLM;
- Media Service — ASR/TTS и ffmpeg;
- SearXNG/Crawl4AI — поиск и чтение страниц;
- backup-service — согласованные backup/restore.
