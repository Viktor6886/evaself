# =====================================================================
# Evaself — operator entry point
# ---------------------------------------------------------------------
#   sudo make install     one-command install on clean Ubuntu 24.04
#   make status           what is running
#   make doctor           full health report
#   make backup / restore / update / rollback
#
# Every target is a thin wrapper around a script in scripts/ so the same
# logic is reachable from Hermes, from systemd units and from a shell.
# =====================================================================

SHELL       := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

ROOT_DIR   := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
SCRIPTS    := $(ROOT_DIR)/scripts
ENV_FILE   := $(ROOT_DIR)/.env
VERSIONS   := $(ROOT_DIR)/versions.env
COMPOSE_FILE := $(ROOT_DIR)/compose.yaml

# Both env files are passed to compose: versions.env pins image tags,
# .env holds the installation's own configuration and secrets.
COMPOSE := docker compose --env-file $(VERSIONS) --env-file $(ENV_FILE) -f $(COMPOSE_FILE)

# `make logs s=n8n` / `make logs s=eva-core`
s ?=
BACKUP ?=

export ROOT_DIR SCRIPTS ENV_FILE VERSIONS COMPOSE_FILE

.PHONY: help install configure start stop restart status logs doctor \
        backup restore update-preview update rollback \
        import-n8n export-n8n \
        configure-hermes start-hermes stop-hermes restart-hermes \
        update-hermes hermes-status \
        disk-cleanup build pull ps shell-db validate test

# ---------------------------------------------------------------------
help: ## Show this help
	@echo "Evaself — available commands"
	@echo ""
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | sort \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Examples:"
	@echo "  sudo make install"
	@echo "  make logs s=n8n"
	@echo "  make restore BACKUP=/var/backups/evaself/evaself-backup-2026-07-28-10-00.tar.gz"

# ---------------------------------------------------------------------
# Installation & configuration
# ---------------------------------------------------------------------
install: ## Full install on a clean Ubuntu 24.04 host (run with sudo)
	@$(SCRIPTS)/install.sh

configure: ## Re-run the interactive configuration wizard (rewrites .env)
	@$(SCRIPTS)/configure.sh

validate: ## Static validation of compose/Caddy/SQL/workflows (no services touched)
	@$(SCRIPTS)/validate.sh

# ---------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------
start: ## Start the whole stack
	@$(SCRIPTS)/require-env.sh
	@$(COMPOSE) up -d --remove-orphans
	@echo "==> stack started; run 'make doctor' for a health report"

stop: ## Stop all containers (volumes and data are kept)
	@$(SCRIPTS)/require-env.sh
	@$(COMPOSE) stop

restart: ## Restart all containers
	@$(SCRIPTS)/require-env.sh
	@$(COMPOSE) restart

build: ## Rebuild locally built images (eva-core, webapp, media, n8n, letta-ui)
	@$(SCRIPTS)/require-env.sh
	@$(COMPOSE) build --pull

pull: ## Pull the pinned upstream images
	@$(SCRIPTS)/require-env.sh
	@$(COMPOSE) pull

status: ## Container status overview
	@$(SCRIPTS)/require-env.sh
	@$(COMPOSE) ps

ps: status ## Alias for status

logs: ## Tail logs; use `make logs s=<service>` for a single service
	@$(SCRIPTS)/require-env.sh
	@if [ -z "$(s)" ]; then $(COMPOSE) logs -f --tail=200; \
	else $(COMPOSE) logs -f --tail=200 $(s); fi

doctor: ## Health report: containers, HTTPS, databases, queue, agents
	@$(SCRIPTS)/doctor.sh

shell-db: ## Open a psql shell on the eva database
	@$(SCRIPTS)/require-env.sh
	@set -a; . $(ENV_FILE); set +a; \
	  $(COMPOSE) exec -e PGPASSWORD="$$EVA_DB_PASSWORD" postgres \
	    psql -U "$$EVA_DB_USER" -d "$$EVA_DB_NAME"

# ---------------------------------------------------------------------
# Backup / restore
# ---------------------------------------------------------------------
backup: ## Create a full backup in $BACKUP_DIR (default /var/backups/evaself)
	@$(SCRIPTS)/backup.sh

restore: ## Restore from an archive: make restore BACKUP=/path/to/archive.tar.gz
	@if [ -z "$(BACKUP)" ]; then \
	  echo "usage: make restore BACKUP=/path/to/evaself-backup-....tar.gz" >&2; exit 2; fi
	@$(SCRIPTS)/restore.sh "$(BACKUP)"

# ---------------------------------------------------------------------
# Updates
# ---------------------------------------------------------------------
update-preview: ## Show available updates without changing anything
	@$(SCRIPTS)/update.sh --preview

update: ## Backup, update service versions, restart, verify (auto-rollback on failure)
	@$(SCRIPTS)/update.sh

rollback: ## Return to the previous versions.env + git commit and restart
	@$(SCRIPTS)/rollback.sh

# ---------------------------------------------------------------------
# n8n workflows
# ---------------------------------------------------------------------
import-n8n: ## Import the workflows and credentials shipped in n8n/workflows
	@$(SCRIPTS)/n8n-import.sh

export-n8n: ## Export the live workflows back into n8n/workflows
	@$(SCRIPTS)/n8n-export.sh

# ---------------------------------------------------------------------
# Hermes Agent (installed directly in Ubuntu, not in Docker)
# ---------------------------------------------------------------------
configure-hermes: ## Configure the Hermes LLM provider and enable autostart
	@$(SCRIPTS)/configure-hermes.sh

start-hermes: ## Start the Hermes systemd service
	@systemctl start evaself-hermes.service
	@systemctl --no-pager --lines=0 status evaself-hermes.service || true

stop-hermes: ## Stop the Hermes systemd service
	@systemctl stop evaself-hermes.service

restart-hermes: ## Restart the Hermes systemd service
	@systemctl restart evaself-hermes.service

update-hermes: ## Update the Hermes Agent binary in place
	@$(SCRIPTS)/update-hermes.sh

hermes-status: ## Hermes service state, config summary and allowlist
	@$(SCRIPTS)/hermes-status.sh

# ---------------------------------------------------------------------
# Maintenance
# ---------------------------------------------------------------------
disk-cleanup: ## Reclaim disk: dangling images, build cache, old logs and backups
	@$(SCRIPTS)/disk-cleanup.sh

test: ## Run the unit tests of eva-core and media-service
	@$(SCRIPTS)/run-tests.sh

# ---------------------------------------------------------------------
# NOTE: there is deliberately NO `make destroy` / `make clean-volumes`
# target. Removing the data volumes must be an explicit, manual
# `docker volume rm` so a mistyped make target can never wipe user data,
# memory, workflows or credentials.
# ---------------------------------------------------------------------
