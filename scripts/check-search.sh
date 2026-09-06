#!/usr/bin/env bash
# =====================================================================
# Что на самом деле отвечает поиск.
#
# `doctor.sh` спрашивает у SearXNG `/healthz` — и получает `200` даже
# тогда, когда все движки заблокированы адресом дата-центра, а выдача
# пуста. Контейнер жив, поиск не работает, и снаружи это выглядит
# одинаково: Ева говорит «ничего не нашлось».
#
# Здесь задаётся настоящий запрос и показывается, КТО ответил, а кто
# нет. Это единственный способ отличить «новостей действительно нет» от
# «искать было нечем».
#
#   ./scripts/check-search.sh                — запрос по умолчанию
#   ./scripts/check-search.sh "курс евро"    — свой запрос
# =====================================================================
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env

QUERY="${1:-новости Перми}"

step "Поиск"

# Запрос идёт ИЗ КОНТЕЙНЕРА АГЕНТА: движки видят его адрес, и проверять
# надо тот путь, которым ходит Ева, а не хост. Весь разбор — в одном
# вызове node: у образа агента нет ни curl, ни jq.
compose_no_stdin exec -T eva-agent-service node -e '
const base = process.argv[1].replace(/\/+$/, "");
const query = process.argv[2];

const probes = [
  { label: "общий запрос", params: { q: query, language: "ru" } },
  { label: "новости за неделю", params: { q: query, categories: "news", time_range: "week" } },
  { label: "погода", params: { q: "погода Пермь", categories: "weather" } },
];

let bad = 0;

for (const probe of probes) {
  const url = new URL(base + "/search");
  url.searchParams.set("format", "json");
  for (const [key, value] of Object.entries(probe.params)) url.searchParams.set(key, value);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Evaself/1.0 (self-hosted)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    const total = (data.results ?? []).length + (data.answers ?? []).length
      + (data.infoboxes ?? []).length;
    const answered = [...new Set((data.results ?? []).map((item) => item.engine))];
    const failed = (data.unresponsive_engines ?? [])
      .map((item) => Array.isArray(item) ? item.join(": ") : String(item));

    if (total > 0) {
      console.log(`  OK   ${probe.label}: ${total} — ответили: ${answered.join(", ") || "—"}`);
    } else {
      console.log(`  ПУСТО ${probe.label}`);
      bad += 1;
    }
    // Отказавшие показываются и при удачном запросе: выдача из одного
    // движка вместо пяти — ещё не поломка, но уже причина, по которой
    // ответы стали хуже.
    if (failed.length > 0) console.log(`       не ответили: ${failed.join(", ")}`);
  } catch (error) {
    console.log(`  ОШИБКА ${probe.label}: ${error.message}`);
    bad += 1;
  }
}
process.exit(bad > 0 ? 1 : 0);
' "${SEARXNG_BASE_URL:-http://searxng:8080/}" "$QUERY"
SEARCH_BAD=$?

step "Чтение страниц"
if compose_no_stdin ps --services --filter status=running 2>/dev/null | grep -qx crawl4ai; then
	compose_no_stdin exec -T eva-agent-service node -e '
		const base = process.argv[1].replace(/\/+$/, "");
		try {
			const response = await fetch(base + "/health", { signal: AbortSignal.timeout(15_000) });
			console.log(response.ok ? "  OK   crawl4ai отвечает" : `  ОШИБКА crawl4ai: HTTP ${response.status}`);
			process.exit(response.ok ? 0 : 1);
		} catch (error) {
			console.log(`  ОШИБКА crawl4ai: ${error.message}`);
			process.exit(1);
		}
	' "${CRAWL4AI_BASE_URL:-http://crawl4ai:11235/}"
	READ_BAD=$?
else
	info "crawl4ai не запущен (профиль выключен) — страницы Ева не читает"
	READ_BAD=0
fi

echo
if [ "$SEARCH_BAD" -eq 0 ] && [ "$READ_BAD" -eq 0 ]; then
	ok "поиск и чтение работают"
	exit 0
fi
fail "поиск работает не полностью"
info "движки массово «не ответили» — их блокирует адрес дата-центра;"
info "состав движков: searxng/settings.yml, логи: docker compose logs searxng --tail 50"
exit 1
