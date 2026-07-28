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

BANNER='
  ███████ ██    ██  █████  ███████ ███████ ██      ███████
  ██      ██    ██ ██   ██ ██      ██      ██      ██
  █████   ██    ██ ███████ ███████ █████   ██      █████
  ██       ██  ██  ██   ██      ██ ██      ██      ██
  ███████   ████   ██   ██ ███████ ███████ ███████ ██
'
printf '%s%s%s\n' "$C_BLUE" "$BANNER" "$C_RESET"
say "  Eva — an AI companion and self-discovery assistant, self-hosted."
say ""

# =====================================================================
# 1. host checks
# =====================================================================
step "Checking the host"

if [ -r /etc/os-release ]; then
	# shellcheck disable=SC1091
	. /etc/os-release
	info "OS: ${PRETTY_NAME:-unknown}"
	if [ "${ID:-}" != "ubuntu" ]; then
		warn "Evaself is tested on Ubuntu 24.04; continuing anyway"
	elif [ "${VERSION_ID:-}" != "24.04" ]; then
		warn "expected Ubuntu 24.04, found ${VERSION_ID:-?}; continuing anyway"
	fi
fi

CPUS="$(nproc)"
MEM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
DISK_GB="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
info "CPU: ${CPUS} vCPU   RAM: ${MEM_MB} MB   free disk: ${DISK_GB} GB"

[ "$CPUS" -ge 2 ] || warn "fewer than 2 vCPU — the stack will be slow"
[ "$MEM_MB" -ge 5800 ] || warn "less than 6 GB RAM — expect memory pressure (8 GB recommended)"
[ "$DISK_GB" -ge 25 ] || warn "less than 25 GB free — backups and images need room"

# =====================================================================
# 2. system packages
# =====================================================================
step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
	ca-certificates curl gnupg git jq openssl \
	ufw fail2ban tar gzip cron python3 \
	apt-transport-https software-properties-common >/dev/null
ok "base packages installed"

# =====================================================================
# 3. Docker
# =====================================================================
step "Installing Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
	ok "Docker $(docker --version | awk '{print $3}' | tr -d ,) with compose plugin already present"
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
	ok "Docker installed"
fi

systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die "the Docker daemon is not running"

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
	ok "Docker log rotation configured"
fi

# =====================================================================
# 4. firewall
# =====================================================================
step "Configuring the firewall"
SSH_PORT="$(sed -n 's/^[[:space:]]*Port[[:space:]]\+\([0-9]\+\).*/\1/p' /etc/ssh/sshd_config | head -n1)"
SSH_PORT="${SSH_PORT:-22}"
info "detected SSH port: $SSH_PORT (your SSH access is not modified)"

ufw --force default deny incoming >/dev/null
ufw --force default allow outgoing >/dev/null
ufw allow "${SSH_PORT}/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null   # HTTP/3
if ufw status | head -1 | grep -q inactive; then
	ufw --force enable >/dev/null
fi
ok "UFW active: SSH ${SSH_PORT}, HTTP 80, HTTPS 443 (tcp+udp)"
info "PostgreSQL and Valkey are not published on the host at all"

# =====================================================================
# 5. fail2ban
# =====================================================================
step "Configuring Fail2Ban"
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
systemctl enable --now fail2ban >/dev/null 2>&1 || warn "fail2ban did not start"
ok "Fail2Ban protecting SSH"

# =====================================================================
# 6. configuration
# =====================================================================
if [ -f "$ENV_FILE" ] && [ -n "$(get_env DOMAIN || true)" ]; then
	step "Configuration"
	ok "existing .env found for domain $(get_env DOMAIN)"
	info "run 'make configure' to change it"
else
	"$SCRIPT_DIR/configure.sh"
fi

load_env
[ -n "${DOMAIN:-}" ] || die ".env has no DOMAIN — run 'make configure'"

# =====================================================================
# 7. DNS sanity check (warning only — certificates need it, install does not)
# =====================================================================
step "Checking DNS"
SERVER_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
if [ -n "$SERVER_IP" ]; then
	info "this server appears as $SERVER_IP"
	for host in "$DOMAIN" "$DOMAIN_APP" "$DOMAIN_API" "$DOMAIN_N8N" "$DOMAIN_NOCODB" "$DOMAIN_LETTA"; do
		resolved="$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1 {print $1}')"
		if [ -z "$resolved" ]; then
			warn "$host does not resolve yet — HTTPS will fail until it does"
		elif [ "$resolved" != "$SERVER_IP" ]; then
			warn "$host resolves to $resolved, not $SERVER_IP"
		else
			ok "$host -> $resolved"
		fi
	done
else
	warn "could not determine the public IP; skipping the DNS check"
fi

# =====================================================================
# 8. build and start
# =====================================================================
step "Pulling images"
compose pull --ignore-buildable 2>&1 | grep -Ev '^$' | tail -5 || true
ok "upstream images pulled"

# The Caddy image exists now, so the basic-auth hash can be produced even
# on a host that had no Docker at all when configure.sh ran.
"$SCRIPT_DIR/hash-letta-password.sh" || warn "the Letta console password is not hashed — https://${DOMAIN_LETTA} will reject logins"

step "Building local images (eva-core, media-service, webapp, letta-ui, n8n, backup)"
compose build --pull >/dev/null
ok "images built"

step "Starting the stack"
compose up -d --remove-orphans
ok "containers started"

step "Waiting for the core services"
for svc in postgres valkey; do
	if wait_for_health "$svc" 180; then ok "$svc healthy"; else die "$svc did not become healthy"; fi
done
for svc in letta eva-core n8n nocodb; do
	if wait_for_health "$svc" 300; then ok "$svc up"; else warn "$svc is still starting — check 'make logs s=$svc'"; fi
done

# =====================================================================
# 9. database migrations
# =====================================================================
"$SCRIPT_DIR/db-migrate.sh"

# =====================================================================
# 10. n8n workflows
# =====================================================================
"$SCRIPT_DIR/n8n-import.sh" || warn "workflow import failed — run 'make import-n8n' once n8n is up"

# =====================================================================
# 11. Hermes Agent (installed into Ubuntu, not into Docker)
# =====================================================================
"$SCRIPT_DIR/install-hermes.sh" || warn "Hermes installation failed — run scripts/install-hermes.sh manually"

# =====================================================================
# 12. systemd units (daily backup timer)
# =====================================================================
step "Installing systemd units"
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
ok "daily backup timer enabled ($(systemctl show -p TimersCalendar --value evaself-backup.timer 2>/dev/null | head -c 60))"

mkdir -p "${BACKUP_DIR:-/var/backups/evaself}"
chmod 700 "${BACKUP_DIR:-/var/backups/evaself}"

# =====================================================================
# 13. verification
# =====================================================================
"$SCRIPT_DIR/doctor.sh" || warn "some checks did not pass — see above"

# =====================================================================
# 14. summary
# =====================================================================
step "Evaself is installed"
cat <<SUMMARY

  ${C_BOLD}Addresses${C_RESET}
    Site        https://${DOMAIN}
    WebApp      https://${DOMAIN_APP}
    API         https://${DOMAIN_API}/health
    n8n         https://${DOMAIN_N8N}
    NocoDB      https://${DOMAIN_NOCODB}
    Letta       https://${DOMAIN_LETTA}
    Status      https://${DOMAIN_STATUS}

  ${C_BOLD}Administrative credentials${C_RESET}  (also in .env, mode 600)
    NocoDB      ${NC_ADMIN_EMAIL} / ${NC_ADMIN_PASSWORD}
    Letta UI    ${LETTA_UI_USER} / ${LETTA_UI_PASSWORD}
    n8n         create the owner account on first visit,
                suggested: ${N8N_OWNER_EMAIL} / ${N8N_OWNER_PASSWORD}

  ${C_BOLD}Next steps${C_RESET}
    1. Open https://${DOMAIN_N8N} and create the n8n owner account.
    2. Register Eva's Telegram webhook:   scripts/telegram-webhook.sh set
    3. Activate the two Telegram workflows in the n8n editor.
    4. Connect NocoDB to the eva database: scripts/nocodb-connect.sh
    5. Give Hermes an LLM when you are ready:  make configure-hermes
    6. Fill in MEDIA_ASR_* / MEDIA_TTS_* in .env for voice, then: make restart

  ${C_BOLD}Everyday commands${C_RESET}
    make status | make doctor | make logs s=n8n
    make backup | make update-preview | make update | make rollback

SUMMARY
