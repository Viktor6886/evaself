# LLM Router

LLM Router — единственный выход Evaself к текстовым моделям. Он выбирает provider по техническому route и настроенной failover chain, но не управляет мышлением агента.

## Граница с Letta

Letta определяет глубину ответа, использование skills, recall, memory и tool selection. Router не анализирует семантику пользовательского текста и не вычисляет классификацию сложности.

Route задаётся детерминированно из:

- явно выбранного режима;
- типа запроса: обычный chat, vision, research или structured output;
- purpose служебной conversation;
- явного выбора пользователя между качеством и стоимостью.

Подписанный routing marker создаётся backend, проверяется Router и удаляется перед обращением к provider.

## Режимы

- `adaptive` — отдельные chains для routes;
- `single` — все запросы идут выбранному provider; аварийный fallback допускается только при явно включённой настройке и технической ошибке.

Смена provider не пересоздаёт Letta agent или conversation.

## Capability probe

До активации проверяются заявленные возможности: обычный ответ, SSE streaming, tool call с JSON arguments, возврат tool result и structured output. Probe не получает пользовательские данные и является единственным разрешённым обращением к непроверенному provider вне Router chain.

## Chains и failover

Порядок providers в chain является приоритетом. Provider пропускается, если выключен, несовместим с route, вручную исключён или его circuit breaker открыт. Failover не выполняется по содержанию ответа.

Распределённые RPM, TPM и inflight limits координируются через Valkey; канонические chains и breaker state находятся в PostgreSQL.

## Telemetry

`llm_requests` хранит requested/actual route, purpose, correlation ID, provider, model, status, latency и usage. Prompt, response, документы, memory и reasoning не сохраняются.

## Проверка

```bash
cd eva-agent-service
npm run build
npx node --test --experimental-strip-types test/llm-router.test.ts
```
