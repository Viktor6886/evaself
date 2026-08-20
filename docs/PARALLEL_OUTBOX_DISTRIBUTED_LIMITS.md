# Параллельный outbox и распределённые лимиты

`telegram_outbox` остаётся единственной durable очередью доставки. Параллелизм не создаёт второй delivery path и не повторяет LLM-turn.

## Delivery

При `EVA_PARALLEL_OUTBOX=true` workers claims bounded batch через `FOR UPDATE SKIP LOCKED`. Порядок определяется priority, availability time и id. Части одного ответа сохраняют порядок.

Распределённые Telegram token buckets хранятся в Valkey. `retry_after` обновляет общий лимит чата; потеря Valkey не удаляет outbox и только временно снижает координацию workers.

## LLM provider limits

Router reservations по RPM, TPM и inflight также координируются через Valkey. PostgreSQL хранит provider chains и breaker state. Failover разрешён только по настроенной цепочке и техническим ошибкам; содержание сообщения не классифицируется.

## Приватность

Valkey не содержит текст сообщений, prompts, answers, Telegram tokens, profile или memory. В outbox находится готовый delivery payload с tenant scope и idempotency key.

## Rollback

- `EVA_PARALLEL_OUTBOX=false` возвращает последовательную доставку из той же таблицы.
- Отключение distributed router limits возвращает process-local coordination без изменения provider registry.

## Проверка

Тесты покрывают конкурентный claim, стабильный priority order, per-chat limits, `retry_after`, idempotent delivery, provider reservation и breaker transitions.
