# Обновление и rollback

```bash
make update-preview
make update
make rollback
```

Все версии зафиксированы в `versions.env`; плавающие `latest`/`stable` не
используются.

`make update`:

1. создаёт полный backup;
2. сохраняет текущий commit и `versions.env`;
3. получает новые версии и собирает образы;
4. применяет идемпотентные migrations;
5. запускает стек и `make doctor`;
6. автоматически выполняет rollback при неуспешной проверке.

Migration 004 добавляет реестр LLM и не удаляет старые данные. Для
существующей установки отдельный `LLM_CONFIG_ENCRYPTION_KEY` желательно
создать через `make configure`; до этого сервис безопасно использует
существующий `EVA_AGENT_API_KEY` как совместимый fallback.

Migrations `008`–`013` совместимо добавляют Telegram inbox/outbox, локаль,
профиль, цели, граф и purpose conversations. Не откатывайте их ручным
удалением таблиц: старый код игнорирует новые сущности, а `make rollback`
возвращает только код и версии образов.

После обновления:

```bash
make doctor
make test-llm
make shell-db
SELECT version FROM schema_migrations ORDER BY version;
```

Rollback возвращает код и версии образов, но не обращает назад уже
применённые совместимые migrations. Поэтому backup перед update обязателен.
