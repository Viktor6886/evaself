# eva-agent-service

Единственный компонент Evaself, который обращается к Letta. Он написан на
TypeScript и использует официальный `@letta-ai/letta-agent-sdk` против
self-hosted Letta App Server по WebSocket.

```text
Telegram webhook ─┐
Background runtime├→ eva-agent-service → Agent SDK → Letta App Server
Admin WebUI ──────┘
```

Сервис:

- создаёт отдельный agent и conversation для Telegram-пользователя;
- возобновляет conversation после restart;
- держит ограниченный пул SDK-сессий и сериализует ходы одного пользователя;
- хранит mapping в PostgreSQL;
- управляет зашифрованным реестром OpenAI-compatible LLM;
- обновляет models agents/conversations через SDK с rollback;
- хранит и применяет runtime-настройки SDK из PostgreSQL;
- управляет agents/conversations и обслуживает WebUI-чат через SDK;
- принимает защищённый Telegram webhook;
- выполняет задачи, heartbeat и пользовательские инструменты;
- публикует защищённый `/v1/*` API для административной консоли.

Прямого Letta REST/WebSocket client в проекте нет. Скрипт
`scripts/verify-agent-sdk.mjs` проверяет эту границу в CI.

## Разработка

```bash
npm ci
npm run typecheck
npm run build
npm test
```

Node должен быть не ниже 22.19. Docker build использует Debian Bookworm
Slim и toolchain для нативной зависимости `node-pty`.

## LLM API

- `GET/POST /v1/llm/providers`
- `PATCH/DELETE /v1/llm/providers/:id`
- `POST /v1/llm/providers/:id/test`
- `GET /v1/llm/providers/:id/models`
- `POST /v1/llm/providers/:id/activate`
- `POST /v1/llm/import-env`

Ответы содержат только `api_key_configured`; plaintext и ciphertext API Key
не возвращаются.

## SDK API

- `GET/PATCH /v1/sdk/settings`
- `POST /v1/sdk/test`
- `GET/POST /v1/sdk/agents`
- `GET/PATCH/DELETE /v1/sdk/agents/:agentId`
- `GET/POST /v1/sdk/agents/:agentId/conversations`
- `GET/PATCH /v1/sdk/conversations/:conversationId`
- `GET/POST /v1/sdk/conversations/:conversationId/messages`

Удаление agent требует `?confirm=<agentId>`. SDK 0.5.2 не предоставляет
удаление conversation, поэтому `PATCH` меняет её признак `archived`.

## Webhook API

- `POST /telegram/webhook` — проверяет
  `X-Telegram-Bot-Api-Secret-Token`;
- `POST /payments/lava` — проверяет HTTP Basic Auth, продукт, сумму,
  валюту и идемпотентно активирует подписку.
