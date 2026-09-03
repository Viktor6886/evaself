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

### Кэшированный вход

Провайдеры отдают часть промпта из своего кэша и берут за неё от четверти до десятой доли обычной ставки. Постоянная часть запроса Евы — системный промпт, персона, блоки памяти и описания инструментов — почти сто килобайт, и она едет в каждом обращении к модели, поэтому разница между холодным и тёплым ходом в счёте измеряется разами.

`cached_tokens_in` — **часть** `tokens_in`, а не добавка к ней: кэш меняет не объём запроса, а его цену. Поле пишется в `llm_requests` и в `llm_spend_ledger`, читается у всех четырёх протоколов (`prompt_tokens_details.cached_tokens` и `prompt_cache_hit_tokens` у OpenAI-совместимых, `cache_read_input_tokens` у Anthropic, `cachedContentTokenCount` у Gemini, `input_tokens_details.cached_tokens` у Responses API).

У Anthropic `input_tokens` не включает кэш: чтение и запись лежат отдельными полями, и вход считается их суммой — иначе журнал показывает запрос втрое меньше настоящего.

Ставка задаётся полем «Цена кэша» в карточке провайдера (`price_cached_in_micro`). Пусто — кэшированный вход считается по обычной цене: занизить счёт хуже, чем не показать экономию. Ноль — законное значение для провайдеров, у которых чтение кэша бесплатно.

Дневной и месячный бюджеты провайдера считаются по этой же оценке, поэтому с учётом кэша они перестали срабатывать раньше времени.

Разложение дорогого хода по запросам:

```sql
SELECT date_trunc('minute', started_at) AS minute,
       count(*) AS requests, sum(tokens_in) AS tokens_in,
       sum(cached_tokens_in) AS cached, sum(tokens_out) AS tokens_out,
       sum(tool_calls) AS tool_calls,
       round(sum(cost_micro) / 1000000.0, 4) AS cost
  FROM llm_requests
 WHERE started_at > now() - interval '3 days'
 GROUP BY 1 ORDER BY 1 DESC LIMIT 25;
```

Одно сообщение человека — это несколько строк: каждый вызов инструмента идёт к модели отдельным запросом со всем контекстом.

## Проверка

```bash
cd eva-agent-service
npm run build
npx node --test --experimental-strip-types test/llm-router.test.ts
```
