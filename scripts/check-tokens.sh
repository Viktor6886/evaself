#!/usr/bin/env bash
# =====================================================================
# Куда уходит вход модели.
#
# Админка показывает СКОЛЬКО потрачено: `llm_spend_ledger` даёт суммы за
# день по провайдерам. На вопрос ПОЧЕМУ столько она не отвечает — а счёт
# за вход складывается из трёх независимых множителей, и лечится каждый
# по-своему:
#
#   постоянный префикс × шагов в ходе × ходов
#
# Префикс — системный промпт, персона, четыре memory block, описания
# инструментов. Он одинаков в каждом обращении и не зависит от того,
# написал человек «привет» или страницу текста. Его величину видно по
# САМОМУ ДЕШЁВОМУ обращению за период: меньше префикса вход не бывает.
#
# Шаги — каждый вызов инструмента это отдельное обращение к модели, и
# каждое несёт префикс и всю историю заново. Ход с поиском и двумя
# чтениями стоит вчетверо дороже ответа без инструментов.
#
# История — Letta сжимает её по `default_context_window`. Предел взят от
# самой слабой модели цепочки, то есть «сколько физически влезет», а не
# «сколько нам не жалко платить за каждый шаг».
#
# Отдельно показана доля кэша провайдера. Кэшированный вход стоит кратно
# дешевле обычного, и если доля близка к нулю при неизменном префиксе —
# это не свойство нагрузки, а незадействованная возможность.
#
#   ./scripts/check-tokens.sh        — за последние 7 суток
#   ./scripts/check-tokens.sh 30     — за 30 суток
#
# Только чтение и только агрегаты: ни текста переписки, ни выборок по
# конкретному человеку здесь нет и быть не должно.
# =====================================================================
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env

DAYS="${1:-7}"
[[ "$DAYS" =~ ^[0-9]+$ ]] || die "период задаётся числом суток: ./scripts/check-tokens.sh 30"

# psql внутри контейнера базы: снаружи её порт наружу не смотрит.
q() {
	compose_no_stdin exec -T -e PGPASSWORD="$EVA_DB_PASSWORD" postgres \
		psql -X -q -U "$EVA_DB_USER" -d "$EVA_DB_NAME" \
		-v "days=$DAYS" -c "$1" 2>&1
}

echo "Период: последние $DAYS суток."

step "Постоянный префикс: во что обходится самое короткое обращение"
# Минимум входа за период — это и есть префикс: системный промпт,
# персона, блоки памяти и описания инструментов. Ниже него вход не
# опускается никогда, каким бы коротким ни было сообщение.
q "
SELECT p.name AS provider,
       count(*)                                   AS requests,
       min(r.tokens_in)                           AS prefix_min,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY r.tokens_in) AS median,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY r.tokens_in) AS p90,
       max(r.tokens_in)                           AS max
  FROM llm_requests r
  JOIN llm_providers p ON p.id = r.actual_provider_id
 WHERE r.succeeded
   AND r.started_at > now() - make_interval(days => :days)
 GROUP BY p.name
 ORDER BY count(*) DESC
 LIMIT 10;"

step "Доля кэша провайдера"
# cached_tokens_in — ЧАСТЬ tokens_in, а не добавка. Ноль при большом и
# неизменном префиксе означает, что кэш промпта не задействован: точки
# кэширования в запрос не ставятся.
q "
SELECT p.name AS provider,
       p.protocol,
       sum(r.tokens_in)                           AS tokens_in,
       sum(r.cached_tokens_in)                    AS cached,
       round(100.0 * sum(r.cached_tokens_in)
             / NULLIF(sum(r.tokens_in), 0), 1)    AS cached_pct,
       p.price_cached_in_micro                    AS price_cached
  FROM llm_requests r
  JOIN llm_providers p ON p.id = r.actual_provider_id
 WHERE r.succeeded
   AND r.started_at > now() - make_interval(days => :days)
 GROUP BY p.name, p.protocol, p.price_cached_in_micro
 ORDER BY sum(r.tokens_in) DESC
 LIMIT 10;"

step "Кто съедает вход: по маршруту и назначению"
q "
SELECT r.route_code,
       COALESCE(r.purpose, '—')                   AS purpose,
       count(*)                                   AS requests,
       sum(r.tokens_in)                           AS tokens_in,
       round(100.0 * sum(r.tokens_in)
             / NULLIF(sum(sum(r.tokens_in)) OVER (), 0), 1) AS share_pct,
       round(avg(r.tokens_in))                    AS avg_in,
       round(avg(r.tokens_out))                   AS avg_out
  FROM llm_requests r
 WHERE r.succeeded
   AND r.started_at > now() - make_interval(days => :days)
 GROUP BY r.route_code, r.purpose
 ORDER BY sum(r.tokens_in) DESC
 LIMIT 12;"

step "Шагов в ходе: во сколько раз ход дороже одного обращения"
# Шаги одного хода идут подряд и укладываются в минуту. Точного
# идентификатора хода в журнале нет, поэтому берётся окно: это оценка
# снизу — растянувшийся ход попадёт в два окна и занизит число.
q "
WITH bursts AS (
  SELECT r.user_id,
         date_trunc('minute', r.started_at) AS slot,
         count(*)      AS steps,
         sum(r.tokens_in) AS tokens_in
    FROM llm_requests r
   WHERE r.succeeded
     AND r.user_id IS NOT NULL
     AND r.started_at > now() - make_interval(days => :days)
   GROUP BY r.user_id, date_trunc('minute', r.started_at)
)
SELECT count(*)                                        AS turns,
       round(avg(steps), 2)                            AS avg_steps,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY steps) AS p90_steps,
       max(steps)                                      AS max_steps,
       round(avg(tokens_in))                           AS avg_tokens_per_turn,
       max(tokens_in)                                  AS max_tokens_per_turn
  FROM bursts;"

step "Растёт ли история изо дня в день"
# Средний вход, ползущий вверх день ото дня при неизменной нагрузке,
# означает, что разговор копится и сжатие не наступает.
q "
SELECT date_trunc('day', r.started_at)::date       AS day,
       count(*)                                    AS requests,
       round(avg(r.tokens_in))                     AS avg_in,
       max(r.tokens_in)                            AS max_in,
       sum(r.tokens_in)                            AS tokens_in
  FROM llm_requests r
 WHERE r.succeeded
   AND r.started_at > now() - make_interval(days => :days)
 GROUP BY 1
 ORDER BY 1 DESC
 LIMIT 14;"

step "Потолок истории, по которому Letta сжимает разговор"
# Потолок складывается из двух разных величин, и путать их нельзя.
#
# Безопасность — сколько физически примет самая слабая ВКЛЮЧЁННАЯ модель.
# Одна слабая модель в цепочке опускает потолок всем; одна очень большая
# ничего не поднимает.
#
# Бюджет — сколько истории мы согласны оплачивать в каждом шаге. Он
# только опускает безопасный предел и живёт в коде
# (`HISTORY_BUDGET_TOKENS` в `src/letta/context-window.ts`). Числа здесь
# нет намеренно: копия константы в скрипте разошлась бы с кодом молча, и
# диагностика начала бы врать ровно в тот день, когда её поправят.
q "
SELECT name, protocol, enabled, context_window, max_output_tokens
  FROM llm_providers
 WHERE enabled
 ORDER BY context_window
 LIMIT 12;"

q "
SELECT min(context_window)                                     AS weakest,
       max(GREATEST(max_output_tokens, 0))                     AS output,
       min(context_window) - max(GREATEST(max_output_tokens, 0)) - 40000
                                                               AS safety_ceiling
  FROM llm_providers
 WHERE enabled AND context_window > 0;"

# Что задано человеком. NULL означает «не задано»: потолок выводится
# кодом как минимум из безопасного предела и бюджета, и в базу это
# выведенное число не пишется — Letta получает его напрямую.
q "
SELECT COALESCE(default_context_window::text, 'не задан — выводится кодом')
         AS default_context_window
  FROM sdk_settings
 WHERE id = 1;"

step "Что это значит"
cat <<'HINT'
  prefix_min      — вход самого короткого обращения. Это цена «привет»:
                    она платится в КАЖДОМ шаге КАЖДОГО хода.
  cached_pct      — доля входа, отданная провайдером из кэша. При
                    неизменном префиксе ноль означает, что кэш промпта
                    не задействован.
  avg_steps       — множитель: ход из четырёх шагов стоит четыре
                    префикса и четыре истории.
  safety_ceiling  — сколько физически примет самая слабая включённая
                    модель. Это верхняя граница, а не действующий предел:
                    поверх неё бюджет (`historyLimit`) опускает потолок до
                    того, что мы согласны платить в каждом шаге.
  max_in по дням  — во что предел обходится на самом деле. Он и есть
                    ответ, если стоит вопрос «а бюджет вообще работает».
HINT
