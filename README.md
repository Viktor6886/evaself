# Evaself

Evaself — self-hosted платформа для Евы: Telegram-ассистента для
саморефлексии, который работает на вашем сервере и хранит отдельную память
каждого пользователя.

```bash
git clone https://github.com/Viktor6886/evaself.git
cd evaself
sudo make install
```

Установщик рассчитан на чистую Ubuntu 24.04. В обычном режиме достаточно
указать один корневой домен: адреса сервисов создаются автоматически.
Telegram и первая OpenAI-compatible LLM-конфигурация необязательны — их
можно добавить позже. Все дополнительные вопросы доступны через
`make configure-advanced`.

## Архитектура

```text
Telegram
  → eva-agent-service (TypeScript)
  → @letta-ai/letta-agent-sdk
  → self-hosted Letta App Server (WebSocket)
  → OpenAI-compatible LLM
```

`eva-agent-service` — единственный компонент, который обращается к Letta.
Он использует официальный Agent SDK, создаёт отдельные agent и conversation
для каждого Telegram-пользователя и хранит их идентификаторы в PostgreSQL.
Telegram и браузер не подключаются к App Server напрямую.

В состав также входят PostgreSQL, Valkey, Caddy, NocoDB, WebApp,
Media Service, SearXNG и механизмы backup, restore, update и
rollback. Telegram webhook, идемпотентность, команды, квоты, фоновые задачи,
heartbeat и webhook Lava реализованы кодом внутри TypeScript runtime.

Пользовательские инструменты заметок, бюджета, задач, реакций и поиска
регистрируются как внешние инструменты официального Agent SDK. Они
выполняются локально и обращаются к PostgreSQL/SearXNG, поэтому секреты
интеграций не попадают в память агента.

## Агенты и Letta Agent SDK

Административная консоль показывает все реальные agents из self-hosted
Letta App Server. В ней можно:

- создавать, изменять и удалять agents;
- создавать и архивировать conversations;
- выбирать conversation, читать историю, стримить ответ и прерывать ход;
- видеть доступный SDK trace, tool events, идентификаторы и расход токенов;
- задавать при создании Persona/Human, memory, system prompt, tools, skills,
  dreaming, embedding, model settings и context window;
- менять runtime defaults: tools, skills, permissions, dreaming,
  reasoning effort, пул сессий и таймауты;
- массово менять поддерживаемые поля с предварительным просмотром и
  автоматическим откатом, экспортировать и импортировать JSON;
- просматривать журнал административных действий;
- проверить WebSocket-подключение SDK к App Server.

Все операции идут через защищённый API `eva-agent-service` и официальный
`@letta-ai/letta-agent-sdk`. Capability token App Server не передаётся
браузеру. Удаление агента необратимо и требует ввода его точного `agent_id`;
conversation можно архивировать без удаления истории и памяти.

Текущая версия официального Agent SDK не предоставляет CRUD существующих
memory blocks, custom tools, MCP, skills и knowledge folders. Консоль
показывает доступное состояние таких объектов без самописного Letta REST
клиента. Точная матрица возможностей приведена в
[статусе реализации](docs/IMPLEMENTATION_STATUS.md).

## Управление LLM

Evaself не привязана к одному провайдеру. Конфигурации хранятся в
PostgreSQL, API Key зашифрован AES-256-GCM и никогда не возвращается в
WebUI. Первая конфигурация импортируется из значений мастера установки.

В административной консоли откройте **«Настройки LLM»**. Там можно:

- добавить или изменить OpenAI-compatible провайдера;
- проверить подключение и получить модели через `/models`;
- ввести модель вручную, если `/models` не поддерживается;
- активировать другую модель без переустановки;
- удалить неактивную конфигурацию.

При переключении существующие agents, conversations и память не удаляются.
App Server переконфигурируется официальным Letta CLI, перезапускается
внутри своего контейнера, а модели объектов обновляются официальным Agent
SDK. При ошибке предыдущая конфигурация восстанавливается.

```bash
make configure-llm       # добавить, проверить и активировать конфигурацию
make test-llm            # проверить активный провайдер
make list-models         # запросить /models активного провайдера
```

## Основные команды

```bash
sudo make install
make configure
make configure-advanced
make status
make doctor
make logs s=eva-agent-service

make backup
make restore BACKUP=/path/to/evaself-backup.tar.gz
make update-preview
make update
make rollback

make validate
make test
```

Команды, удаляющей volumes, намеренно нет: ошибочная команда не должна
стереть память, conversations или настройки.

## Требования

- Ubuntu 24.04 x86_64;
- root/sudo;
- DNS-записи автоматически сформированных поддоменов на IP сервера
  (для локального режима без домена HTTPS не выпускается);
- открытые 80/tcp, 443/tcp и 443/udp;
- минимум 4 ГБ RAM, рекомендуется 8 ГБ;
- доступ к Docker Hub, GitHub, npm и выбранному LLM-провайдеру.

## Документация

- [Установка](docs/INSTALL.md)
- [Архитектура](docs/ARCHITECTURE.md)
- [Эксплуатация](docs/OPERATIONS.md)
- [Backup и restore](docs/BACKUP.md)
- [Обновление и rollback](docs/UPDATING.md)
- [Перенос на другой сервер](docs/MIGRATION.md)
- [Безопасность](docs/SECURITY.md)
- [Проверки](docs/VERIFICATION.md)
- [Статус реализации WebUI](docs/IMPLEMENTATION_STATUS.md)

Ева — инструмент поддержки и саморефлексии, а не врач или психотерапевт;
она не ставит диагнозы.

Лицензия: MIT, см. [LICENSE](LICENSE).
