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
