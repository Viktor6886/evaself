# Административная панель: контракт фазы 1

Этот документ фиксирует контракт до реализации runtime-кода. Фаза 1 не
переиспользует интерфейс Letta: `/admin/` обслуживается отдельным `admin-ui`,
а `/api/admin/v1` — отдельным процессом `admin-api`.

## Схема данных

Миграция: `postgres/migrations/014_admin_panel_phase1.sql`.
Обратная миграция: `postgres/migrations/down/014_admin_panel_phase1.sql`.

| Таблица | Назначение и важные ограничения |
|---|---|
| `admin_users` | Администраторы; `argon2id`, роли `owner/admin/operator/viewer`, один активный `owner`, блокировка входа |
| `admin_sessions` | Только SHA-256 хеши session/CSRF-токенов; срок действия и отзыв |
| `sudo_grants` | Короткие гранты, привязанные к сессии и scope |
| `system_settings` | Основной источник несекретных настроек; `version` для optimistic locking |
| `config_versions` | История изменений и rollback несекретных настроек |
| `secret_records` | Только AES-256-GCM ciphertext, nonce и auth tag; открытого значения нет |
| `audit_log` | `pending` до мутации и `success/failure` после неё, со сквозным `request_id` |

Секреты не допускаются в `system_settings`, `config_versions` и `audit_log`.
Существующая таблица `admin_audit_log` остаётся журналом операций консоли
Letta и не используется новым `admin-api`.

## API

Полный контракт первой фазы находится в
`docs/openapi/admin-v1-phase1.yaml`.

- `POST /api/admin/v1/auth/login`
- `POST /api/admin/v1/auth/logout`
- `POST /api/admin/v1/auth/password`
- `GET /api/admin/v1/me`
- `POST /api/admin/v1/sudo`
- `GET /api/admin/v1/settings`
- `PUT /api/admin/v1/settings` (`If-Match` обязателен)
- `POST /api/admin/v1/settings/rollback/{version_id}`
- `GET /api/admin/v1/secrets` (только метаданные)
- `PUT /api/admin/v1/secrets/{secret_ref}` (write-only, sudo)
- `GET /api/admin/v1/audit`

Любой ответ получает `X-Request-Id`. Небезопасные методы после входа требуют
double-submit CSRF. Session cookie имеет `HttpOnly`, `Secure` и
`SameSite=Strict`.

## Фоновые задачи

В фазе 1 существует только `admin-bootstrap`:

1. ожидает PostgreSQL;
2. создаёт первого `owner`, если администраторов ещё нет;
3. один раз переносит известные несекретные переменные окружения в
   `system_settings`;
4. переносит известные секретные переменные в `secret_records`;
5. записывает маркер завершения в `system_settings`;
6. повторный запуск ничего не перезаписывает и завершается успешно.

`health-worker`, проверки интеграций, SSE, резервное копирование и
`eva-updater` относятся к следующим фазам и здесь отсутствуют.

## Разрешение bootstrap-конфликта

Техническое задание одновременно относит пароли БД к секретам и требует
`DATABASE_URL`/`VALKEY_URL` для bootstrap. Для разрыва циклической зависимости
эти два DSN считаются bootstrap-транспортом согласно §2.2 ТЗ. Они не
возвращаются API и не попадают в `system_settings`. Мастер-ключ хранится в
отдельном root-only файле на хосте, не в БД, `.env` или backup.
