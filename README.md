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

В состав также входят PostgreSQL, Valkey, Caddy, WebApp,
Media Service, SearXNG и механизмы backup, restore, update и
rollback. Telegram webhook, идемпотентность, команды, квоты, фоновые задачи,
heartbeat и webhook Lava реализованы кодом внутри TypeScript runtime.

Основной пользовательский поток устойчив к перезапускам: webhook сначала
фиксирует update в PostgreSQL inbox, а готовый ответ — в Telegram outbox.
Ошибка доставки повторяет только отправку и не запускает второй LLM-turn.
На время генерации Telegram показывает пустой эфемерный черновик, а готовый
ответ раскрывается целыми словами без разрывов внутри слов.
Основной чат и служебные `scheduler`, `profile`, `goal_review`, `research`
conversations разделены и создаются лениво.

Пользовательские инструменты заметок, бюджета, задач, реакций и поиска
регистрируются как внешние инструменты официального Agent SDK. Они
выполняются локально и обращаются к PostgreSQL/SearXNG, поэтому секреты
интеграций не попадают в память агента.

## Цели, профиль и память

Evaself постепенно дополняет профиль без анкеты: не более одной уместной
подсказки за turn, с cooldown и уважением отказа. Прямые обычные факты можно
сохранить сразу; чувствительные гипотезы требуют подтверждения. Город
преобразуется в IANA timezone, а локальное время задач — в UTC с учётом DST.

Система «ВЕКТОР — Действие» хранит направления, подтверждённые цели,
результаты, зависимости, рабочие блоки, артефакты и обзоры. Это продуктовые
данные: цели и задачи живут в PostgreSQL и доступны Еве через продуктовые
инструменты.

Память Евы принадлежит Letta. Четыре memory block — `persona`, `human`,
`current_state`, `therapeutic_framework` — всегда в контексте; подробности
Ева ведёт сама в MemFS нативными инструментами памяти. PostgreSQL хранит
связь `user → agent → conversation`, но переписку не зеркалирует и памятью
агента не управляет. Граница ответственности — [docs/letta-native.md](docs/letta-native.md).

## Telegram WebApp

Mini App на `/app/` содержит четыре раздела: «Сегодня», «Цели», «Прогресс»
и «Профиль». Он показывает ближайший шаг, позволяет начать и завершить
рабочий блок, создать или приостановить цель, подтвердить сведения профиля.
Интерфейс поддерживает Telegram light/dark theme, skeleton loading,
автосохранение и optimistic UI.

Каждый `/public/*` запрос подписан Telegram `initData`; backend проверяет
HMAC, срок `auth_date` и сам определяет пользователя. Переданный браузером
`user_id` не используется.

## Агенты и Letta Agent SDK

Отдельная консоль Letta на `https://letta.<домен>/` показывает все реальные agents из self-hosted
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

Административная панель поддерживает два режима: `adaptive` выбирает
независимые цепочки `fast/chat/deep` и специализированные
маршруты, а `single` направляет все обращения одному выбранному provider.
Переключение не пересоздаёт агента и не стирает цепочки. Напоминания также
проходят через Letta и LLM; факт отправки хранится отдельно от выполнения
задачи и доступен Еве в последующем диалоге.

В общей административной панели откройте **«Искусственный интеллект»**. Там можно:

- добавить или изменить OpenAI-compatible провайдера;
- проверить подключение и получить модели через `/models`;
- ввести модель вручную, если `/models` не поддерживается;
- назначить provider основным или резервным для конкретного маршрута;
- переключить adaptive/single без перезапуска;
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

## Общесистемная административная панель

`https://<домен>/admin/` — отдельное приложение, не копия и не прокси
Letta UI. Оно предоставляет вход с server-side сессией, RBAC,
sudo-подтверждение, системные настройки, write-only Secret Store, обзор,
фоновые статусы, общий LLM-реестр, backup, обновления и журнал действий.
Значения, маски, длина и хеш секретов не возвращаются браузеру.

Перезапуск выполняет отдельный `eva-updater` с узким списком разрешённых
операций; `admin-api` не имеет доступа к Docker socket.

Управление agents, conversations, памятью и чатом остаётся только на
`https://letta.<домен>/`. Контракты описаны в
[каркасе безопасности](docs/ADMIN_PHASE1_CONTRACT.md) и
[эксплуатационных фазах](docs/ADMIN_PHASES_2_6_CONTRACT.md).

## Основные команды

```bash
sudo make install
make configure
make configure-advanced
make status
make doctor
make logs s=eva-agent-service

make backup
make restore BACKUP=/path/to/evaself-backup.tar.gz.enc
make update-preview
make update
make rollback

make validate
make test
```

Функции можно включать поэтапно через переменные
`EVA_PROFILE_COMPLETION_ENABLED`, `EVA_VECTOR_GOALS_ENABLED`,
`EVA_OUTBOX_ENABLED`. Переписка в PostgreSQL не зеркалируется: история
диалога принадлежит Letta.

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
- [Как запускать доработку](docs/HOW_TO_RUN.md)
- [Состояние реализации — snapshot](docs/IMPLEMENTATION_STATE.md)

Ева — инструмент поддержки и саморефлексии, а не врач или психотерапевт;
она не ставит диагнозы.

Лицензия: MIT, см. [LICENSE](LICENSE).
