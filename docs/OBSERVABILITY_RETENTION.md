# Наблюдаемость и хранение данных

## Граница приватности

Telemetry содержит только закрытый набор метаданных: идентификаторы хода и correlation, состояния, длительности, коды ошибок, route/provider/model и агрегированный usage. Пользовательский текст, ответы, документы, tool arguments/results, memory и reasoning не экспортируются.

| Компонент | Путь |
|---|---|
| Privacy processor | `src/observability/privacy.ts` |
| Observability gateway | `src/observability/gateway.ts` |
| Tracing | `src/observability/tracing.ts` |
| Prometheus metrics | `src/metrics.ts`, `src/metrics-queries.ts` |
| Retention policy | `src/retention/policy.ts` |
| Retention enforcement | `src/retention/service.ts` |

`ObservabilityGateway` — единственная граница внешней telemetry. Langfuse получает только разрешённые метаданные после privacy processing. OTel-контекст используется для correlation; отдельный неограниченный exporter отсутствует.

## Метрики

Метрики описывают turn lifecycle, inbox/outbox, locks, PostgreSQL pool, event-loop lag, LLM requests, jobs и delivery. Labels берутся из закрытых словарей, чтобы не превратить PII или произвольный текст в размерность Prometheus.

## Retention

Политики задаются по классам данных. Перед удалением доступен preview; legal/operational hold останавливает удаление класса. PostgreSQL очищается пакетно и с audit run. Логи Docker и временные media-файлы исполняются соответствующими внешними владельцами хранения, а не SQL-сервисом.

Флаги и сроки перечислены в `.env.example`. Изменение политики не меняет память Letta: agents, conversations, memory blocks и MemFS обслуживаются их собственным lifecycle и backup.

## Проверка

Тесты проверяют закрытый набор полей, pseudonymous user key, отсутствие содержимого, propagation trace context, preview/enforcement retention, holds и idempotency run.
