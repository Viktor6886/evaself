#!/usr/bin/env bash
# =====================================================================
# Evaself installer — clean Ubuntu 24.04 to a running system.
#
#   git clone <repo> && cd evaself && sudo make install
#
# Safe to re-run: every step checks its own state first, no data volume
# is ever removed, and existing secrets in .env are preserved.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_root
export EVASELF_INSTALL_LOG="${EVASELF_INSTALL_LOG:-/var/log/evaself-install.log}"
touch "$EVASELF_INSTALL_LOG"
chmod 600 "$EVASELF_INSTALL_LOG"

BANNER='
  ███████ ██    ██  █████  ███████ ███████ ██      ███████
  ██      ██    ██ ██   ██ ██      ██      ██      ██
  █████   ██    ██ ███████ ███████ █████   ██      █████
  ██       ██  ██  ██   ██      ██ ██      ██      ██
  ███████   ████   ██   ██ ███████ ███████ ███████ ██
'
printf '%s%s%s\n' "$C_BLUE" "$BANNER" "$C_RESET"
say "  Ева — self-hosted ассистент для поддержки и саморефлексии."
say ""

# =====================================================================
# 1. host checks
# =====================================================================
step "Проверка сервера"

if [ -r /etc/os-release ]; then
	# shellcheck disable=SC1091
	. /etc/os-release
	info "ОС: ${PRETTY_NAME:-неизвестно}"
	if [ "${ID:-}" != "ubuntu" ]; then
		warn "Evaself тестируется на Ubuntu 24.04; установка продолжается"
	elif [ "${VERSION_ID:-}" != "24.04" ]; then
		warn "ожидалась Ubuntu 24.04, найдена ${VERSION_ID:-?}; установка продолжается"
	fi
fi

CPUS="$(nproc)"
MEM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
DISK_GB="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
info "CPU: ${CPUS} vCPU   RAM: ${MEM_MB} МБ   свободно: ${DISK_GB} ГБ"

[ "$CPUS" -ge 2 ] || warn "меньше 2 vCPU — стек будет работать медленно"
[ "$MEM_MB" -ge 5800 ] || warn "меньше 6 ГБ RAM — рекомендуется 8 ГБ"
[ "$DISK_GB" -ge 25 ] || warn "меньше 25 ГБ — образам и backup может не хватить места"

# =====================================================================
# 2. system packages
# =====================================================================
step "Установка системных пакетов"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
	ca-certificates curl gnupg git jq openssl \
	ufw fail2ban tar gzip cron python3 fzf \
	apt-transport-https software-properties-common >/dev/null
ok "базовые пакеты установлены"

# =====================================================================
# 3. Docker
# =====================================================================
step "Установка Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
	ok "Docker $(docker --version | awk '{print $3}' | tr -d ,) и Compose уже установлены"
else
	install -m 0755 -d /etc/apt/keyrings
	if [ ! -f /etc/apt/keyrings/docker.asc ]; then
		curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
		chmod a+r /etc/apt/keyrings/docker.asc
	fi
	# shellcheck disable=SC1091
	. /etc/os-release
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
		> /etc/apt/sources.list.d/docker.list
	apt-get update -qq
	apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
		docker-buildx-plugin docker-compose-plugin >/dev/null
	ok "Docker установлен"
fi

systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die "Docker daemon не запущен"

# Keep container logs from eating the disk, in addition to the per-service
# limits set in compose.yaml.
if [ ! -f /etc/docker/daemon.json ]; then
	mkdir -p /etc/docker
	cat > /etc/docker/daemon.json <<-'JSON'
		{
		  "log-driver": "json-file",
		  "log-opts": { "max-size": "10m", "max-file": "3" }
		}
	JSON
	systemctl restart docker
	ok "ротация логов Docker настроена"
fi

# =====================================================================
# 4. firewall
# =====================================================================
step "Настройка firewall"
SSH_PORT="$(sed -n 's/^[[:space:]]*Port[[:space:]]\+\([0-9]\+\).*/\1/p' /etc/ssh/sshd_config | head -n1)"
SSH_PORT="${SSH_PORT:-22}"
info "обнаружен SSH-порт: $SSH_PORT (SSH-настройки не изменяются)"

ufw --force default deny incoming >/dev/null
ufw --force default allow outgoing >/dev/null
ufw allow "${SSH_PORT}/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null   # HTTP/3
if ufw status | head -1 | grep -q inactive; then
	ufw --force enable >/dev/null
fi
ok "UFW активен: SSH ${SSH_PORT}, HTTP 80, HTTPS 443 (tcp+udp)"
info "PostgreSQL и Valkey не публикуются на host"

# =====================================================================
# 5. fail2ban
# =====================================================================
step "Настройка Fail2Ban"
if [ ! -f /etc/fail2ban/jail.d/evaself.conf ]; then
	cat > /etc/fail2ban/jail.d/evaself.conf <<-CONF
		[sshd]
		enabled  = true
		port     = ${SSH_PORT}
		maxretry = 5
		bantime  = 1h
		findtime = 10m
	CONF
fi
systemctl enable --now fail2ban >/dev/null 2>&1 || warn "Fail2Ban не запустился"
ok "Fail2Ban защищает SSH"

# =====================================================================
# 6. configuration
# =====================================================================
if [ -f "$ENV_FILE" ] && [ -n "$(get_env DOMAIN || true)" ]; then
	step "Конфигурация"
	ok "найден существующий .env для домена $(get_env DOMAIN)"
	info "для изменения выполните make configure"
else
	"$SCRIPT_DIR/configure.sh"
fi

load_env

[ -n "${DOMAIN:-}" ] || die "в .env нет DOMAIN — выполните make configure"
"$SCRIPT_DIR/ensure-admin-master-key.sh"
load_env

# =====================================================================
# 7. DNS sanity check (warning only — certificates need it, install does not)
# =====================================================================
step "Проверка DNS"
SERVER_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
if [[ "$DOMAIN" == *.localhost ]]; then
	info "локальный режим: публичная проверка DNS пропущена"
elif [ -n "$SERVER_IP" ]; then
	info "публичный IP сервера: $SERVER_IP"
	for host in "$DOMAIN" "$DOMAIN_APP" "$DOMAIN_API"; do
		resolved="$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1 {print $1}')"
		if [ -z "$resolved" ]; then
			warn "$host пока не разрешается — HTTPS не заработает"
		elif [ "$resolved" != "$SERVER_IP" ]; then
			warn "$host указывает на $resolved, а не $SERVER_IP"
		else
			ok "$host -> $resolved"
		fi
	done
else
	warn "не удалось определить публичный IP; проверка DNS пропущена"
fi

# =====================================================================
# 8. build and start
# =====================================================================
step "Загрузка образов"
run_with_progress "загрузка upstream-образов" compose pull --ignore-buildable

step "Сборка локальных образов"
run_with_progress "сборка локальных образов" compose build --pull

# При повторном запуске install PostgreSQL продолжает работать со старым
# приложением. Совместимые миграции нужно применить до запуска нового worker,
# иначе он несколько секунд обращается к ещё не созданным таблицам.
if service_running postgres; then
	step "Миграции перед обновлением сервисов"
	"$SCRIPT_DIR/db-migrate.sh"
fi

step "Запуск стека"
run_with_progress "создание и запуск контейнеров" compose up -d --remove-orphans

step "Ожидание основных сервисов"
for svc in postgres valkey; do
	if wait_for_health "$svc" 180; then ok "$svc работает"; else die "$svc не прошёл healthcheck"; fi
done
for svc in letta-app-server eva-agent-service admin-api admin-ui; do
	if wait_for_health "$svc" 300; then ok "$svc запущен"; else warn "$svc ещё запускается — проверьте make logs s=$svc"; fi
done

# =====================================================================
# 9. database migrations
# =====================================================================
"$SCRIPT_DIR/db-migrate.sh"
"$SCRIPT_DIR/admin-finalize-env.sh"
"$SCRIPT_DIR/configure-llm.sh" --from-env

# =====================================================================
# 10. systemd units (daily backup timer)
# =====================================================================
step "Установка systemd units"
install -m 0644 "$ROOT_DIR/systemd/evaself-backup.service" /etc/systemd/system/
install -m 0644 "$ROOT_DIR/systemd/evaself-backup.timer"   /etc/systemd/system/
install -m 0644 "$ROOT_DIR/systemd/evaself.service"        /etc/systemd/system/

# The units need to know where the installation lives.
mkdir -p /etc/systemd/system/evaself-backup.service.d /etc/systemd/system/evaself.service.d
printf '[Service]\nEnvironment=EVASELF_DIR=%s\nWorkingDirectory=%s\n' "$ROOT_DIR" "$ROOT_DIR" \
	> /etc/systemd/system/evaself-backup.service.d/override.conf
printf '[Service]\nEnvironment=EVASELF_DIR=%s\nWorkingDirectory=%s\n' "$ROOT_DIR" "$ROOT_DIR" \
	> /etc/systemd/system/evaself.service.d/override.conf

systemctl daemon-reload
systemctl enable --now evaself-backup.timer >/dev/null 2>&1
systemctl enable evaself.service >/dev/null 2>&1 || true
ok "ежедневный timer backup включён ($(systemctl show -p TimersCalendar --value evaself-backup.timer 2>/dev/null | head -c 60))"

mkdir -p "${BACKUP_DIR:-/var/backups/evaself}"
chmod 700 "${BACKUP_DIR:-/var/backups/evaself}"

# =====================================================================
# 11. Telegram webhook and verification
# =====================================================================
"$SCRIPT_DIR/telegram-webhook.sh" set || warn "Telegram webhook не зарегистрирован — повторите scripts/telegram-webhook.sh set"
"$SCRIPT_DIR/doctor.sh" || warn "часть проверок не прошла — смотрите сообщения выше"

# =====================================================================
# 12. summary
# =====================================================================
step "Evaself установлена"
cat <<SUMMARY

  ${C_BOLD}Адреса${C_RESET}
    Сайт        https://${DOMAIN}
    Панель      https://${DOMAIN}/admin
    WebApp      https://${DOMAIN_APP}
    API         https://${DOMAIN_API}/health

  ${C_BOLD}Административный доступ${C_RESET}
    Вход один: https://${DOMAIN}/admin, логин ${EVA_ADMIN_USERNAME:-admin}.
    Letta, мониторинг, агенты и подписки — разделы этой же панели.
    Пароли не выводятся в терминал и журнал.
  ${C_BOLD}Следующие шаги${C_RESET}
    1. Проверьте Telegram webhook: scripts/telegram-webhook.sh status
    2. Откройте https://${DOMAIN}/admin и проверьте разделы «Агенты» и «Letta».
    3. Для голоса заполните MEDIA_ASR_* / MEDIA_TTS_* и выполните make restart

  ${C_BOLD}Основные команды${C_RESET}
    make status | make doctor | make logs s=eva-agent-service
    make test-llm | make list-models | make configure-llm
    make backup | make update-preview | make update | make rollback

  Полный журнал установки: ${EVASELF_INSTALL_LOG}

SUMMARY
