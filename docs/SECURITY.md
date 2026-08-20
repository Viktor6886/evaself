# Модель безопасности

## Letta-native граница

Только `eva-agent-service` взаимодействует с Letta App Server. Agent SDK обслуживает диалог; `letta-client` используется только административным control plane. Браузер, Telegram и admin services не получают capability token App Server.

Нативные memory blocks, MemFS, conversations, skills и recall не зеркалируются в PostgreSQL. Продуктовые tools исполняются сервером Evaself с tenant scope, permissions, idempotency и durable approvals. Произвольное выполнение shell-кода и запись в host filesystem агенту недоступны.

## Сеть

Наружу публикуются Caddy 80/443. PostgreSQL, Valkey, Letta App Server, Docker API и внутренние service APIs не публикуются. Контейнерные сети разделяют edge, data, agent и tools. Caddy Admin API слушает localhost.

Недоверенный web/document content обрабатывается в tools-сегменте без доступа к базе, Valkey и App Server. Исходный контент считается данными, а не инструкциями.

## Пользовательская идентичность и tenancy

- Telegram webhook проверяет secret token.
- Mini App проверяет HMAC `initData`, возраст `auth_date` и replay window.
- Пользователь определяется только из подписанного payload; `user_id` из body/query не доверяется.
- Все запросы к пользовательским таблицам проходят `TenantScope`/`GuardedPool` и CI-проверку.
- Имя, username, email и телефон не объединяют пользователей.

## Admin API

Admin panel использует server-side sessions, Argon2id, `HttpOnly Secure SameSite=Strict`, CSRF, RBAC и короткие scoped sudo grants. Каждая административная операция имеет объявленный доступ и audit event.

Чтение переписки требует owner/admin и отдельного sudo scope. Сообщения читаются через `eva-agent-service` из Letta; копии в PostgreSQL нет. Текст не попадает в audit log.

## Секреты

Секреты принимаются write-only и хранятся в environment или Secret Store. API возвращает только факт настройки. Master keys не входят в backup и должны храниться отдельно. Секреты, tokens и provider credentials не пишутся в logs, traces, browser responses или Valkey.

## Privacy и telemetry

User text, model response, documents, tool arguments/results, memory и reasoning не экспортируются. Crisis events сохраняют severity и безопасные метаданные без исходной фразы.

## Backup

Backup шифруется до внешней передачи и содержит чувствительные volumes/configuration. Master key не включается в архив. Restore выполняется только по [BACKUP.md](BACKUP.md) и [MIGRATION.md](MIGRATION.md).

## Проверки

```bash
git status --short
git grep -nE 'BEGIN (RSA|OPENSSH) PRIVATE KEY'
git ls-files .env
python3 scripts/ci/assert-tenant-scope.py
python3 scripts/ci/assert-admin-route-access.py
```
