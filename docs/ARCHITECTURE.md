# Архитектура

## Главная граница

**Letta Agent SDK и App Server — единственный cognitive runtime Евы.** Letta владеет агентом, conversations, историей, контекстом, memory blocks, MemFS, skills, recall, Dreaming и выбором инструментов. Evaself предоставляет продуктовую оболочку и не вставляет собственный когнитивный слой между пользователем и Letta.

Подробно: [letta-native.md](letta-native.md).

## Поток сообщения

```text
Telegram webhook
  → PostgreSQL telegram_updates
  → inbox dispatcher / turn lifecycle
  → RuntimeContextBuilder
  → Letta Agent SDK → Letta App Server
  → LLM Router → provider chain
  → PostgreSQL telegram_outbox
  → Telegram delivery worker
```

Webhook сохраняет update и быстро отвечает Telegram. Worker claims записи через `FOR UPDATE SKIP LOCKED`. Один пользователь обрабатывается последовательно, разные пользователи — параллельно. Готовый ответ сначала фиксируется в outbox; delivery retry не запускает новый LLM-turn.

`RuntimeContextBuilder` добавляет только продуктовые факты текущего хода: локальное время, часовой пояс, профиль, подписку, цели и ближайшие задачи. Историей, памятью и объёмом контекста управляет Letta.

## Хранилища

- **PostgreSQL:** пользователи, tenancy, mappings `user → agent → conversation`, product state, inbox/outbox, задачи, платежи, approvals, audit и idempotency.
- **Letta App Server volume:** agents, conversations, история, memory blocks и MemFS.
- **Valkey:** locks, semaphores, BullMQ, rate limits и кэш; только восстановимое операционное состояние.
- **Provider store:** конфигурация официального Letta CLI.

Переписка не зеркалируется в PostgreSQL. Продуктовые записи не считаются памятью агента.

## Conversations

Один пользователь имеет одного активного агента и несколько conversations по назначению: основной чат и служебные ветки. Назначение ограничивает продуктовые действия, но не выбирает за Letta skill, воспоминание или глубину ответа.

## Инструменты

Продуктовые инструменты зарегистрированы в Letta и выполняются серверным кодом Evaself. Обработчик проверяет tenant scope, permissions, подтверждение и idempotency. LLM не получает прямой SQL и не изменяет продуктовые таблицы самостоятельно.

## Фоновые задания

BullMQ используется только для фоновых, отложенных, периодических, recovery и maintenance-задач. Интерактивный Telegram ingress, основной agent turn и delivery остаются на durable PostgreSQL lifecycle. Фоновые задания не обслуживают память Letta.

## LLM Router

Router выбирает provider по явному route, требованиям запроса, purpose conversation и настройке пользователя. Он не анализирует семантику пользовательского текста и не выбирает skills, память или сложность размышления — это ответственность Letta.

## Безопасность

- Только `eva-agent-service` взаимодействует с Letta App Server.
- Каждый запрос к пользовательским данным имеет tenant scope.
- Секреты хранятся в environment/Secret Store и не возвращаются браузеру.
- Опасные tool calls требуют durable approval.
- Содержимое диалогов и reasoning не попадают в telemetry.

См. [SECURITY.md](SECURITY.md) и [TENANT_ISOLATION.md](TENANT_ISOLATION.md).
