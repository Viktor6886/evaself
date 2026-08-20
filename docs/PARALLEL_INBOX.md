# Параллельный Telegram inbox

`telegram_updates` — единственный durable ingress. Webhook записывает update и не выполняет LLM-turn синхронно.

## Dispatcher

`src/delivery/dispatcher.ts` claims bounded batch через `FOR UPDATE SKIP LOCKED`. Different users выполняются параллельно; FIFO и `UserTurnLock` не допускают одновременный mutating turn одного пользователя.

Если свободного слота нет, update возвращается в `queued` без расхода processing attempt. Истёкшая lease переводится sweeper в retry/dead согласно политике, чтобы ранняя зависшая запись не блокировала FIFO навсегда.

## Ограничения

- Interactive ingress не переносится в BullMQ.
- Запасного выполнения внутри webhook нет.
- В Valkey находятся только locks/semaphores; update и канонический статус остаются в PostgreSQL.
- После claim используется обычный turn lifecycle и единственная Letta session path.

## Метрики

- `eva_inbox_pending`;
- `eva_inbox_oldest_age_seconds`;
- `eva_turn_slots_used{class}`;
- `eva_turns_active{state}`;
- `eva_user_locks{state}`;
- PostgreSQL pool и event-loop lag.

## Rollback

`EVA_PARALLEL_INBOX=false` возвращает последовательный dispatcher с той же таблицей и семантикой статусов. Данные и формат update не меняются.
