# Эксплуатация

## Ежедневные команды

```bash
make status
make doctor
make logs
make logs s=eva-agent-service
make logs s=letta-app-server
```

`make doctor` возвращает ненулевой код при критической ошибке, поэтому его
можно запускать из cron или systemd timer.

## LLM

```bash
make test-llm
make list-models
make configure-llm
```

Текущая конфигурация и результат последней проверки видны в
«Настройки LLM». При ошибке переключения смотрите оба сервиса:

```bash
make logs s=eva-agent-service
make logs s=letta-app-server
```

Не редактируйте `providers/auth.json` вручную. Конфигурацию записывает
официальный Letta CLI, а `eva-agent-service` координирует restart,
healthcheck и rollback.

## Agents, conversations и чат

В административной консоли:

1. откройте «Агенты» и создайте agent;
2. проверьте или измените его model, context window, tags и system prompt;
3. создайте conversation;
4. откройте «Чат» и отправьте проверочное сообщение;
5. ненужный диалог архивируйте, а agent удаляйте только после backup.

Раздел «Настройки SDK» задаёт defaults новых объектов, memory filesystem,
tools, skill sources, permission mode, dreaming и параметры пула сессий.

Для произвольных OpenAI-compatible endpoints App Server использует свой
динамический адаптер `lmstudio`: это внутреннее имя connector, а не требование
устанавливать LM Studio. Он получает фактические ID через `/models` и отправляет
chat-completions на указанный Base URL. После переключения Evaself ждёт появления
выбранной модели в каталоге App Server; простой WebSocket healthcheck успешной
активацией не считается.
Сохранение настроек закрывает активные сессии; следующий запрос безопасно
переподключает их к той же conversation.

## Feature flags

```dotenv
EVA_PROFILE_COMPLETION_ENABLED=true
EVA_VECTOR_GOALS_ENABLED=true
EVA_GRAPH_MEMORY_ENABLED=true
EVA_GRAPH_CONTEXT_TIMEOUT_MS=75
EVA_PROFILE_CACHE_TTL_SECONDS=60
EVA_CONVERSATION_MIRROR_ENABLED=false
EVA_OUTBOX_ENABLED=true
```

После изменения выполните `docker compose up -d eva-agent-service`.
`EVA_OUTBOX_ENABLED=false` допустим только для диагностики: при прямой
доставке теряется гарантия повтора только Telegram-отправки. Полное зеркало
conversation не реализовано в обычном режиме и должно оставаться выключено.

## Метрики turn

```bash
make logs s=eva-agent-service | grep 'Telegram turn обработан'
```

Строка содержит задержки runtime context, профиля, графа, Letta,
PostgreSQL outbox и Telegram, общее время и `db_query_count`. При тёплом
cache ориентируйтесь на сумму служебных этапов до `letta_turn_ms`; целевой
порядок — до 100 мс, но реальное значение зависит от VPS и измеряется только
на развернутом стеке.

## Пользовательский WebApp

Mini App открывается на `https://<домен>/app/` только из Telegram. Разделы
«Сегодня», «Цели», «Прогресс» и «Профиль» используют HMAC-защищённый
`/public/*` API. Если интерфейс пишет «Откройте приложение из Telegram»,
проверьте URL Mini App у BotFather и актуальность bot token.

## База и связь объектов

```bash
make shell-db
SELECT * FROM v_agent_runtime;
SELECT name, model, is_active, last_check_ok FROM llm_providers;
SELECT * FROM sdk_settings;
```

Если у пользователя нет conversation, следующий `users/ensure` создаст его,
не удаляя агента. Зависшую блокировку хода можно снять из WebUI или маршрутом
`POST /v1/locks/{telegramId}/release`.

## Диск

```bash
df -h
docker system df
make disk-cleanup
```

`make disk-cleanup` не удаляет именованные volumes. Перед любыми ручными
операциями с volumes выполните `make backup`.

## Аварийный порядок

1. `make doctor`;
2. проверить логи проблемного сервиса;
3. `make restart`;
4. если проблема появилась после update — `make rollback`;
5. если повреждены данные — restore только из проверенного backup.

## Напоминания и история задач

Планировщик генерирует текст напоминания через тот же агент Евы и LLM Router:
`scheduler` использует `fast` в adaptive-режиме и выбранного provider в
single-режиме. Отправка напоминания создаёт `reminder_generated` и
`reminder_sent` в `task_events`, но не меняет задачу на `done`. Одноразовый
запуск отмечается `last_run_at`, поэтому повтор воркера не дублирует доставку.

В `task_events` сохраняются точный отправленный текст, Telegram message ID,
conversation и прямой `llm_request_id`; provider не угадывается по времени.
Ответ на конкретное сообщение Telegram связывается с задачей через
`reply_to_message.message_id`. «Сделал» завершает связанную задачу, «Завтра»
переносит, «Отмени» отменяет. Ева получает не более пяти кратких недавних
событий в runtime context и может запросить подробности user-scoped tools.
