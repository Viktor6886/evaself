#!/usr/bin/env bash
# =====================================================================
# Разделы панели — настоящие адреса, а старые имена — редирект.
#
# Проверяется поведение живого Caddy, а не текст конфигурации. Две вещи
# ломаются молча и одинаково выглядят в логах:
#
#   1. `/admin/letta` возвращает 404. Так бывает, когда раздел живёт
#      только якорем или когда `handle_path /admin/*` не доходит до
#      SPA-fallback статики. Закладка на раздел перестаёт работать, а в
#      журнале — обычный 404 без объяснений;
#   2. выведенное из эксплуатации имя перестаёт редиректить и начинает
#      что-то отдавать само. Это возвращает вторую административную
#      поверхность ровно тем способом, от которого её убирали.
#
# Поднимаются два настоящих Caddy с настоящими файлами репозитория:
# admin-ui/Caddyfile на своём порту и корневой Caddyfile перед ним. HTTP
# вместо HTTPS — сертификаты к маршрутизации отношения не имеют, а имя
# сайта задаётся через те же переменные окружения.
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
CADDY="${CADDY_BIN:-caddy}"
WORK="$(mktemp -d)"
EDGE_PORT="${EDGE_PORT:-9080}"
LEGACY_PORT="${LEGACY_PORT:-9081}"
STATUS_PORT="${STATUS_PORT:-9082}"
UI_PORT=8083

cleanup() {
	[ -n "${UI_PID:-}" ] && kill "$UI_PID" 2>/dev/null || true
	[ -n "${EDGE_PID:-}" ] && kill "$EDGE_PID" 2>/dev/null || true
	[ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null || true
	if [ "${ADDED_HOSTS:-0}" = "1" ]; then
		sed -i "/$HOSTS_MARK/d" /etc/hosts 2>/dev/null || true
	fi
	rm -rf "$WORK"
}
trap cleanup EXIT

command -v "$CADDY" >/dev/null 2>&1 || { echo "caddy не найден; укажите CADDY_BIN"; exit 2; }

# Корневой Caddyfile проксирует по именам контейнеров. Вне compose их
# некому разрешить, и всякий /admin/* отвечал бы 502 — то есть тест
# «падал» бы на своём стенде, а не на конфигурации. Имена заводятся на
# loopback; строка помечена, чтобы её было видно в /etc/hosts.
#
# Отказ, а не пропуск. Зелёная проверка, которая ничего не выполнила,
# хуже отсутствующей: она обещает, что маршрутизация цела, и молчит ровно
# тогда, когда её некому проверить. В CI запуск идёт под sudo, и прав
# всегда достаточно; локально без них — явный отказ с подсказкой.
HOSTS_MARK="# evaself admin routing test"
if ! grep -q "$HOSTS_MARK" /etc/hosts 2>/dev/null; then
	if ! printf '127.0.0.1 admin-ui admin-api eva-agent-service webapp %s\n' "$HOSTS_MARK" \
		>> /etc/hosts 2>/dev/null; then
		echo "::error::нет прав дописать /etc/hosts: запустите под sudo"
		exit 1
	fi
	ADDED_HOSTS=1
fi

fail=0
checked=0
say() { printf '  %s\n' "$1"; }
check() {
	local label="$1" want="$2" got="$3"
	checked=$((checked + 1))
	if [ "$want" = "$got" ]; then
		say "ok   $label ($got)"
	else
		say "FAIL $label: ожидалось $want, получено $got"
		fail=1
	fi
}

# admin-ui: файл репозитория с одной подменой — корень статики. В образе
# она лежит в /srv, и без подмены проверялся бы пустой каталог хоста, а не
# настоящие страницы панели. Заголовки, try_files и SPA-fallback остаются
# ровно теми, что уедут в production.
sed "s#root \* /srv#root * ${ROOT_DIR}/admin-ui/public#" \
	"$ROOT_DIR/admin-ui/Caddyfile" > "$WORK/ui.Caddyfile"
XDG_DATA_HOME="$WORK/ui-data" XDG_CONFIG_HOME="$WORK/ui-config" \
	"$CADDY" run --config "$WORK/ui.Caddyfile" >"$WORK/ui.log" 2>&1 &
UI_PID=$!

# Заглушки остальных upstream: маршрутизацию проверяем, а не сервисы.
# Тело блока Caddyfile начинается со следующей строки: `{` обязана быть
# последним токеном своей строки, иначе конфигурация не разбирается, а
# заглушка молча не поднимается — и проверка API отвечает 502, как будто
# сломана маршрутизация.
cat > "$WORK/stubs.Caddyfile" <<'STUB'
{
	auto_https off
	admin off
}
:8071 {
	respond "admin-api" 200
}
:8070 {
	respond "agent" 200
}
:8082 {
	respond "webapp" 200
}
STUB

# Корневой Caddyfile — тоже настоящий. Имена сайтов подставляются как в
# production, только по http и на нестандартных портах.
XDG_DATA_HOME="$WORK/edge-data" XDG_CONFIG_HOME="$WORK/edge-config" \
DOMAIN="http://localhost:${EDGE_PORT}" \
DOMAIN_APP="http://app.localhost:${EDGE_PORT}" \
DOMAIN_API="http://api.localhost:${EDGE_PORT}" \
DOMAIN_LETTA_LEGACY="http://localhost:${LEGACY_PORT}" \
DOMAIN_STATUS_LEGACY="http://localhost:${STATUS_PORT}" \
ACME_EMAIL="ops@example.test" \
ACME_CA="https://acme-v02.api.letsencrypt.org/directory" \
EVA_AGENT_PORT="8070" EVA_AGENT_API_KEY="placeholder" \
	"$CADDY" run --config "$ROOT_DIR/Caddyfile" --adapter caddyfile >"$WORK/edge.log" 2>&1 &
EDGE_PID=$!

XDG_DATA_HOME="$WORK/stub-data" XDG_CONFIG_HOME="$WORK/stub-config" \
	"$CADDY" run --config "$WORK/stubs.Caddyfile" >"$WORK/stubs.log" 2>&1 &
STUB_PID=$!

# Ждём все три процесса, а не только два. Заглушка admin-api поднимается
# последней, и без неё проверка API отвечала 502 — то есть падала на
# гонке стенда, а не на конфигурации.
ready=0
for _ in $(seq 1 100); do
	if curl -fsS -o /dev/null "http://127.0.0.1:${UI_PORT}/healthz" 2>/dev/null \
		&& curl -fsS -o /dev/null "http://127.0.0.1:8071/" 2>/dev/null \
		&& curl -fsS -o /dev/null "http://localhost:${EDGE_PORT}/admin/" 2>/dev/null; then
		ready=1
		break
	fi
	sleep 0.2
done
[ "$ready" = "1" ] || {
	echo "::error::стенд не поднялся"
	tail -5 "$WORK/ui.log" "$WORK/edge.log" "$WORK/stubs.log" 2>/dev/null
	exit 1
}

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@"; }
location() { curl -s -o /dev/null -w '%{redirect_url}' --max-time 5 "$@"; }
body() { curl -s --max-time 5 "$@"; }

echo "Маршрутизация панели"
# Каждый раздел — свой адрес, и все они отдают одну и ту же страницу
# панели: SPA-fallback обязан сработать после снятия префикса /admin.
for section in "" letta monitoring agents subscriptions persona; do
	check "/admin/${section}" 200 "$(code "http://localhost:${EDGE_PORT}/admin/${section}")"
done

# Тело сохраняется в файл, а не подаётся в `grep -q` конвейером: `grep -q`
# закрывает вход на первом совпадении, curl получает SIGPIPE, и при
# `pipefail` конвейер отчитывается ошибкой ровно тогда, когда совпадение
# нашлось. Проверка при этом выглядит как честный отказ.
body "http://localhost:${EDGE_PORT}/admin/letta" > "$WORK/letta.html"
if grep -q 'data-page="letta"' "$WORK/letta.html"; then
	say "ok   /admin/letta отдаёт разметку панели, а не пустую страницу"
else
	say "FAIL /admin/letta вернул не панель"
	fail=1
fi

# Ассеты берутся относительным путём от /admin/: без снятия префикса они
# уходили бы мимо и страница открывалась без стилей и скриптов.
check "/admin/ui.css" 200 "$(code "http://localhost:${EDGE_PORT}/admin/ui.css")"
check "/admin/ui-letta.js" 200 "$(code "http://localhost:${EDGE_PORT}/admin/ui-letta.js")"
check "/admin (без слэша)" 308 "$(code "http://localhost:${EDGE_PORT}/admin")"
check "API панели" 200 "$(code "http://localhost:${EDGE_PORT}/api/admin/v1/me")"

echo "Выведенные из эксплуатации имена"
for pair in "${LEGACY_PORT}:/admin/letta" "${STATUS_PORT}:/admin/monitoring"; do
	port="${pair%%:*}"; target="${pair#*:}"
	check "порт ${port}" 308 "$(code "http://localhost:${port}/")"
	# Цель редиректа собирается из {$DOMAIN}, а на стенде он несёт схему
	# (иначе Caddy поднял бы HTTPS) — поэтому сверяется путь, а не адрес
	# целиком: именно путь и решает, в какой раздел попадёт закладка.
	got="$(location "http://localhost:${port}/")"
	case "$got" in
		*"${target}") say "ok   ${port} → ${got}" ;;
		*) say "FAIL ${port} редиректит на ${got}, ожидалось …${target}"; fail=1 ;;
	esac
	# Ничего своего они не отдают: только редирект, на любом пути.
	check "порт ${port} на глубоком пути" 308 "$(code "http://localhost:${port}/agents/x")"
done

echo "Внутренняя поверхность закрыта"
check "/api/v1 наружу" 404 "$(code "http://localhost:${EDGE_PORT}/api/v1/sdk/agents")"
check "/api/metrics наружу" 404 "$(code "http://localhost:${EDGE_PORT}/api/metrics")"

[ "$fail" -eq 0 ] || { echo "::error::маршрутизация панели сломана"; exit 1; }
# Счётчик, а не просто «ok»: если стенд когда-нибудь поднимется, но до
# проверок дело не дойдёт, зелёный лог с нулём выполненных проверок
# выглядел бы точно так же, как настоящий успех.
[ "$checked" -ge 15 ] || {
	echo "::error::выполнено проверок: $checked — стенд поднялся, но проверять было нечего"
	exit 1
}
echo "маршрутизация панели: ok, проверок выполнено: $checked"
