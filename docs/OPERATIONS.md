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
можно запускать из cron или Hermes.

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

## База и связь объектов

```bash
make shell-db
SELECT * FROM v_agent_runtime;
SELECT name, model, is_active, last_check_ok FROM llm_providers;
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
