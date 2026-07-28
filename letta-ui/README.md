# Административная консоль Evaself

Статический desktop-first интерфейс для Dashboard, agents, conversations,
чата, SDK- и LLM-настроек. Есть светлая и тёмная темы.
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

Политика `allowedTools`, permission mode, skill sources и dreaming применяется
при открытии SDK-сессии, как требует App Server. Не поддерживаемые текущим
официальным SDK параметры `disallowedTools`, `systemInfoReminder` и
`dreaming.behavior` не имитируются: консоль сообщает об ограничении, а API
отклоняет попытку их включить.

В «Агентах» доступны создание, изменение и подтверждаемое удаление agent,
создание/архивирование conversations, история, стриминговый чат, остановка
хода, очищенный raw trace и расход контекста. Список поддерживает поиск,
фильтры, множественный выбор, bulk update с preview/rollback, JSON
экспорт/импорт. В разделе «Аудит» хранится журнал административных операций.

CRUD существующих memory blocks, custom tools, MCP, skills и knowledge
folders отсутствует в management API Agent SDK 0.5.5. Интерфейс явно
показывает эти ограничения и не подменяет SDK самописным REST-клиентом.

Интерфейс защищён Caddy Basic Auth и доступен как на Letta-поддомене, так и
на `/admin/` корневого домена. Файлы находятся в `public/`, build step не
требуется.
