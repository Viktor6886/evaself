# История изменений

## Не выпущено — управление SDK, agents, LLM и стабилизация CI

### Добавлено

- migration `004_llm_providers.sql` с централизованным реестром
  OpenAI-compatible провайдеров;
- шифрование API Key через AES-256-GCM;
- защищённые маршруты `/v1/llm/*` в `eva-agent-service`;
- раздел «Настройки LLM» в административной консоли;
- проверка `/models` и ручной ввод модели при отсутствии endpoint;
- команды `make configure-llm`, `make test-llm`, `make list-models`;
- автоматический импорт первой активной конфигурации из мастера установки;
- shared volumes для конфигурации официального Letta CLI и сигнала
  перезапуска App Server;
- unit-тесты шифрования, проверки провайдера, сокрытия ключа и rollback;
- smoke test двух провайдеров, переключения модели и сохранности ID после
  перезапуска;
- migration `005_sdk_settings.sql` с постоянными runtime-настройками SDK;
- защищённый `/v1/sdk/*` API управления settings, agents, conversations и
  сообщениями;
- создание, изменение и подтверждаемое удаление agents из WebUI;
- создание и архивирование conversations, просмотр истории и прямой чат;
- экран «Настройки SDK» для памяти, tools, skills, permissions, dreaming,
  model settings, пула сессий и таймаутов;
- unit- и stack smoke-тесты настроек SDK, административных операций и чата.
- migration `006_eva_runtime.sql` для Telegram updates, настроек пользователя,
  заметок, бюджета, heartbeat и платежных намерений;
- прямой Telegram webhook, команды, голос, изображения, документы, typing,
  квоты и обработка ошибок в TypeScript;
- безопасно перенесён шаблон эталонной Евы: персона, схема памяти и правила
  инструментов без истории сообщений, личных значений и секретов экспорта;
- динамическое приветствие через эфемерный Telegram draft;
- кодовый планировщик задач и heartbeat с часовыми поясами;
- внешние инструменты Agent SDK для заметок, бюджета, задач, поиска и реакций;
- защищённый и идемпотентный webhook Lava.

### Изменено

- смена модели обновляет существующие agents и conversations через
  `@letta-ai/letta-agent-sdk`, не удаляя память;
- Letta App Server действительно перезапускается после изменения локального
  provider store; при неудаче остаётся активной предыдущая конфигурация;
- backup/restore включает реестр LLM, ключ шифрования и provider volume;
- Node-образы переведены с Alpine на Debian Bookworm Slim для нативной
  сборки `node-pty`;
- migration 002 стала идемпотентной после изменения представления migration
  003; CI применяет весь набор миграций три раза;
- архитектурная проверка Agent SDK больше не принимает собственные маршруты
  Evaself за самописный Letta REST client;
- пользовательские и административные материалы переведены на русский;
- из стека удалены установка стороннего host-агента, его systemd unit,
  команды, вопросы установщика и интеграция с backup/restore/doctor.
- оркестратор автоматизации и его worker/runner полностью удалены; бизнес-
  логика выполняется кодом в `eva-agent-service`;
- исправлены чистая инициализация PostgreSQL через Unix socket, безопасная
  загрузка bcrypt из `.env`, JSON default мастера и вывод CLI LLM.

## 0.2.0 — Letta Agent SDK

- Python Eva Core и самописный Letta REST client заменены TypeScript-сервисом
  с официальным `@letta-ai/letta-agent-sdk`;
- добавлен self-hosted Letta App Server по WebSocket;
- для каждого пользователя сохраняются `agent_id` и `conversation_id`;
- добавлены перезапуск, backup/restore, минимальная E2E-проверка и
  административная консоль.

## 0.1.0 — первоначальный стек

Первый self-hosted стек с PostgreSQL, Valkey, Caddy, NocoDB, WebApp,
Media Service, SearXNG, backup, restore, update и rollback.
