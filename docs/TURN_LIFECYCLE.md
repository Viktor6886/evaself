# Жизненный цикл хода

Ход пользователя хранится durable в PostgreSQL и проходит только канонические состояния из `src/turns/states.ts`.

## Поток

```text
accepted → aggregating → queued → claimed
→ context_building → context_built
→ sent_to_letta → letta_processing → tools_pending/approval_pending
→ result_received → outbox_committed → delivering → delivered → completed
```

Ошибочные и управляющие состояния: `cancelling`, `cancelled`, `failed_retryable`, `recovery_required`, `recovering`, `failed_terminal`.

## Компоненты

- `src/turns/turn-lifecycle.ts` — создание хода, переходы и idempotency key.
- `src/turns/user-turn-lock.ts` — renewable Valkey lock и FIFO пользователя.
- `src/turns/semaphores.ts` — распределённые слоты по классам нагрузки.
- `src/turns/effect-journal.ts` — однократное выполнение побочных действий.
- `src/turns/aggregator.ts` — объединение быстрой серии сообщений.
- `src/turns/message-timeline.ts` — временные метаданные серии без текста.

## Правила

- Разные пользователи выполняются параллельно; один mutating turn пользователя — последовательно.
- Потеря lock или отмена ставит barrier: поздний результат не создаёт outbox и не выполняет effect.
- Tool approval хранится durable и связывается с SDK request id.
- После `outbox_committed` retry повторяет только delivery.
- Контекст, память и tool selection внутри хода принадлежат Letta. Evaself передаёт только продуктовый `RuntimeContext`.

## Наблюдение

Состояния, длительности, lock/semaphore usage и ошибки доступны в `/metrics` и административных операциях над ходами. Текст сообщения и reasoning в telemetry не входят.
