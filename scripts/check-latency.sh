#!/usr/bin/env bash
# =====================================================================
# Куда уходит время хода.
#
# «Ева долго думает» — это сумма, а лечатся слагаемые по-разному:
# ожидание слота пользователя, сборка контекста, ожидание сессии,
# генерация модели, синтез речи, доставка в Telegram. Сумма их не
# различает, и разбирать её догадками — самый дорогой способ.
#
# Разложение уже считается на каждом ходе и уходит в лог одной строкой
# `Telegram turn обработан`. Здесь оно только собирается в таблицу.
# Ничего нового не измеряется и не включается.
#
#   ./scripts/check-latency.sh          — по последним 5000 строк лога
#   ./scripts/check-latency.sh 20000    — глубже в историю логов
#
# Числа в миллисекундах. Медиана — обычный ход, p90 — то, на что человек
# жалуется: раз в десять ходов бывает так.
# =====================================================================
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env

TAIL="${1:-5000}"
[[ "$TAIL" =~ ^[0-9]+$ ]] || die "глубина задаётся числом строк: ./scripts/check-latency.sh 20000"

LOG_FILE="$(mktemp)"
trap 'rm -f "$LOG_FILE"' EXIT

# Логи берутся с хоста: строка о ходе пишется сервисом Евы, а `grep`
# внутри контейнера потребовал бы его же оболочки.
compose_no_stdin logs --no-color --tail="$TAIL" eva-agent-service 2>/dev/null \
  | grep -F 'Telegram turn обработан' > "$LOG_FILE" || true

TURNS="$(wc -l < "$LOG_FILE" | tr -d ' ')"

step "Из чего складывается ход"

if [ "${TURNS:-0}" -eq 0 ]; then
	echo "  В последних $TAIL строках лога законченных ходов нет."
	echo "  Либо человек ещё не писал после перезапуска, либо глубина мала:"
	echo "  попробуйте ./scripts/check-latency.sh 50000"
else
	echo "  Ходов в выборке: $TURNS"
	echo
	printf '  %-26s %8s %8s %8s\n' "стадия" "медиана" "p90" "макс"
	printf '  %-26s %8s %8s %8s\n' "--------------------------" "--------" "--------" "--------"

	# Одно и то же по каждой стадии: вытащить числа, отсортировать,
	# взять медиану, p90 и максимум. Без внешних зависимостей: у
	# оператора может не быть ни jq, ни python.
	metric() {
		local key="$1" label="$2"
		# `+`, а не `*`: со звёздочкой регулярное выражение допускает
		# пустое совпадение, и `grep -o` молча отдаёт ключ без числа —
		# таблица заполняется нулями, а поломки не видно. Пробел после
		# двоеточия допускается: `JSON.stringify` его не ставит, но
		# зависеть от этого в диагностике незачем.
		grep -oE "\"$key\":[[:space:]]*[0-9]+" "$LOG_FILE" \
			| grep -oE '[0-9]+$' | sort -n | awk -v label="$label" '
			{ v[NR] = $1 }
			END {
				if (NR == 0) { printf "  %-26s %8s %8s %8s\n", label, "—", "—", "—"; exit }
				med = v[int((NR + 1) / 2)]
				p90 = v[int(NR * 0.9) < 1 ? 1 : int(NR * 0.9)]
				printf "  %-26s %8d %8d %8d\n", label, med, p90, v[NR]
			}'
	}

	metric total_turn_ms          "ВЕСЬ ХОД"
	metric queue_wait_ms          "  очередь пользователя"
	metric context_build_ms       "  сборка контекста"
	metric profile_check_ms       "  проверка профиля"
	metric session_acquire_ms     "  ожидание сессии"
	metric time_to_first_delta_ms "  до первого слова"
	metric letta_generation_ms    "  генерация целиком"
	metric tts_ms                 "  синтез речи"
	metric telegram_delivery_ms   "  доставка в Telegram"
	metric context_characters     "  размер контекста, знаков"
fi

step "Обращения к модели: чья задержка"

q() {
	compose_no_stdin exec -T -e PGPASSWORD="$EVA_DB_PASSWORD" postgres \
		psql -X -q -U "$EVA_DB_USER" -d "$EVA_DB_NAME" -c "$1" 2>&1
}

q "
SELECT p.name AS provider,
       count(*)                                                     AS requests,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY r.latency_ms)     AS median_ms,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY r.latency_ms)     AS p90_ms,
       max(r.latency_ms)                                            AS max_ms,
       sum((r.attempts > 1)::int)                                   AS retried,
       sum(r.switches)                                              AS switches
  FROM llm_requests r
  JOIN llm_providers p ON p.id = r.actual_provider_id
 WHERE r.succeeded
   AND r.started_at > now() - interval '3 days'
 GROUP BY p.name
 ORDER BY count(*) DESC
 LIMIT 8;"

step "Сколько обращений приходится на один ход"
# Шаг с инструментом — отдельное обращение с полным контекстом. Ход из
# четырёх шагов идёт вчетверо дольше одного, и это не поломка, а цена
# работы: увидеть её нужно раньше, чем начинать оптимизировать другое.
q "
WITH bursts AS (
  SELECT user_id, date_trunc('minute', started_at) AS slot,
         count(*) AS steps, sum(latency_ms) AS model_ms
    FROM llm_requests
   WHERE succeeded AND user_id IS NOT NULL
     AND started_at > now() - interval '3 days'
   GROUP BY user_id, date_trunc('minute', started_at)
)
SELECT count(*)                                            AS turns,
       round(avg(steps), 2)                                AS avg_steps,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY steps)  AS p90_steps,
       max(steps)                                          AS max_steps,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY model_ms) AS p90_model_ms
  FROM bursts;"

step "Настройки, от которых ход становится долгим"
# Ни одна из них не поломка: это выбор, сделанный человеком или
# умолчанием. Здесь они собраны рядом, чтобы выбор был виден.
q "
SELECT reasoning_effort,
       COALESCE(default_context_window::text, 'выводится кодом') AS context_window,
       turn_timeout_ms,
       session_pool_size,
       dreaming ->> 'trigger' AS dreaming
  FROM sdk_settings
 WHERE id = 1;"

echo
echo "  Агрегация сообщений (пауза ПЕРЕД началом хода):"
echo "    EVA_TURN_AGGREGATION           = ${EVA_TURN_AGGREGATION:-не задан}"
echo "    EVA_TURN_AGGREGATION_DEBOUNCE_MS = ${EVA_TURN_AGGREGATION_DEBOUNCE_MS:-умолчание}"
echo "    EVA_TURN_AGGREGATION_WINDOW_MS   = ${EVA_TURN_AGGREGATION_WINDOW_MS:-умолчание}"

step "Как это читать"
cat <<'HINT'
  Сначала смотрите на строку ВЕСЬ ХОД и на то, какая стадия занимает
  бо́льшую её часть. Дальше — по стадии:

  очередь пользователя  — ход ждал, пока освободится слот. Виноват не
                          ответ, а то, что перед ним шла другая работа:
                          фоновая задача, окно инициативы, прошлый ход.
  сборка контекста      — продуктовый контекст и профиль. Секунды здесь
                          означают медленную базу, а не модель.
  ожидание сессии       — сессия Letta была занята или пересоздавалась.
  до первого слова      — сколько человек ждал молча. Если это почти
                          весь ход, время уходит в модель, а не в нас.
  генерация целиком     — вместе с вызовами инструментов. Разница с
                          «до первого слова» и есть работа инструментов.
  доставка в Telegram   — от готового текста до отправленного сообщения.

  reasoning_effort выше `none` заставляет модель думать дольше по
  прямому указанию — это не поломка, а настройка.
  dreaming = compaction-event означает, что на каждом сжатии заводится
  ещё и рефлексия.
HINT
