# Административная консоль Evaself

Статический интерфейс для agents, conversations, чата, SDK- и LLM-настроек.
Браузер не подключается к App Server: Caddy проксирует `/api/*` в
`eva-agent-service` и добавляет внутренний `X-API-Key`.

Раздел «Настройки LLM» позволяет добавлять, изменять, проверять и
активировать OpenAI-compatible конфигурации. Сохранённый API Key:

- не заполняется в форме редактирования;
- не приходит в JSON;
- заменяется только при явном вводе нового значения.

Раздел «Настройки SDK» управляет сериализуемыми defaults и runtime:
Persona/Human, tools, skill sources, permission mode, memfs, dreaming,
model settings, context window, пулом сессий и таймаутами. Capability token
App Server никогда не приходит в JSON.

В «Агентах» доступны создание, изменение и подтверждаемое удаление agent,
создание/архивирование conversations, история сообщений и прямой чат.

Интерфейс защищён Caddy Basic Auth. Файлы находятся в `public/`, build step
не требуется.
