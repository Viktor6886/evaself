# Backup и restore

```bash
make backup
make restore BACKUP=/var/backups/evaself/evaself-backup-YYYY-MM-DD-HH-MM.tar.gz.enc
```

## Что входит в архив

- дампы PostgreSQL: `eva`, legacy `letta` и роли;
- `letta_app_server_data`: agents, conversations и memory filesystem;
- `letta_provider_config`: активная локальная конфигурация Letta provider;
- volume Caddy;
- `.env`, `versions.env`, Compose и Caddyfile;
- `skills/`, `library/`, WebApp и инвентарь agents/conversations.

Таблица `llm_providers` попадает в дамп базы, API Key в ней зашифрован.
Таблица `sdk_settings` также попадает в дамп, поэтому шаблоны агентов и
runtime-настройки восстанавливаются вместе с PostgreSQL.
Таблицы Telegram runtime, заметок, бюджета, задач, heartbeat и платежей
входят в дамп `eva`. `LLM_CONFIG_ENCRYPTION_KEY` находится в `.env`.
Provider volume содержит
рабочие credentials Letta, поэтому весь архив является секретом.

## Защита архива

Новый архив автоматически шифруется `AES-256-CBC + PBKDF2`, получает
mode 600 и хранится в каталоге mode 700. Мастер-ключ
`EVA_SECRETS_MASTER_KEY` в архив не включается — храните его отдельно от
VPS. Старые незашифрованные `.tar.gz` по-прежнему поддерживаются только для
совместимости restore и помечаются в WebUI как `legacy`.

## Автоматический backup

`evaself-backup.timer` запускается ежедневно. Срок хранения задаёт
`BACKUP_RETENTION_DAYS` (по умолчанию 14 дней). Ротация начинается только
после пробной расшифровки и проверки tar-потока.

```bash
systemctl list-timers evaself-backup.timer
systemctl start evaself-backup.service
journalctl -u evaself-backup -n 50
```

## Порядок restore

Restore проверяет checksum, останавливает сервисы, восстанавливает volumes
и базы, возвращает конфигурацию/контент, исправляет владельцев объектов,
запускает стек и выполняет healthcheck.

После восстановления проверьте:

```bash
make doctor
make test-llm
make shell-db
SELECT telegram_id, agent_id, conversation_id FROM v_agent_runtime;
SELECT name, model, is_active FROM llm_providers;
```

Все строки runtime должны иметь прежние `agent_id` и `conversation_id`.
Проверять restore безопаснее на отдельном тестовом VPS.
