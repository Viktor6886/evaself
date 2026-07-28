# История изменений

## Не выпущено — управление LLM и стабилизация CI

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
  перезапуска.

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
- пользовательские и административные материалы переведены на русский.

## 0.2.0 — Letta Agent SDK

- Python Eva Core и самописный Letta REST client заменены TypeScript-сервисом
  с официальным `@letta-ai/letta-agent-sdk`;
- добавлен self-hosted Letta App Server по WebSocket;
- для каждого пользователя сохраняются `agent_id` и `conversation_id`;
- добавлены перезапуск, backup/restore, минимальный n8n E2E workflow и
  административная консоль.

## 0.1.0 — первоначальный стек

Первый self-hosted стек с PostgreSQL, Valkey, Caddy, n8n, NocoDB, WebApp,
Media Service, SearXNG, Hermes, backup, restore, update и rollback.
