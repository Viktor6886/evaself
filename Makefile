# =====================================================================
# Evaself — operator entry point
# ---------------------------------------------------------------------
#   sudo make install     one-command install on clean Ubuntu 24.04
#   make status           what is running
#   make doctor           full health report
#   make backup / restore / update / rollback
#
# Every target is a thin wrapper around a script in scripts/ so the same
# logic is reachable from systemd units and from a shell.
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

# `make logs s=eva-agent-service`
s ?=
BACKUP ?=

export ROOT_DIR SCRIPTS ENV_FILE VERSIONS COMPOSE_FILE

.PHONY: help install configure configure-advanced start stop restart status logs doctor \
        backup restore update-preview update update-force rollback \
        configure-llm test-llm list-models configure-letta \
        disk-cleanup build pull ps shell-db validate test

# ---------------------------------------------------------------------
help: ## Показать справку
	@echo "Evaself — доступные команды"
	@echo ""
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | sort \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Примеры:"
	@echo "  sudo make install"
	@echo "  make logs s=eva-agent-service"
	@echo "  make restore BACKUP=/var/backups/evaself/evaself-backup-2026-07-28-10-00.tar.gz"

# ---------------------------------------------------------------------
# Installation & configuration
# ---------------------------------------------------------------------
install: ## Полная установка на чистую Ubuntu 24.04 (запускать с sudo)
	@$(SCRIPTS)/install.sh

configure: ## Повторно запустить мастер настройки .env
	@$(SCRIPTS)/configure.sh

configure-advanced: ## Мастер настройки с ручным изменением поддоменов и JSON LLM
	@$(SCRIPTS)/configure.sh --advanced

configure-llm: ## Добавить, проверить и при необходимости активировать LLM
	@$(SCRIPTS)/configure-llm.sh

test-llm: ## Проверить активный LLM; можно передать id=<UUID>
	@$(SCRIPTS)/test-llm.sh "$(id)"

list-models: ## Получить /models активного LLM; можно передать id=<UUID>
	@$(SCRIPTS)/list-models.sh "$(id)"

configure-letta: ## Устаревший псевдоним configure-llm
	@$(SCRIPTS)/configure-letta.sh

validate: ## Статические проверки compose/Caddy/SQL/workflows
	@$(SCRIPTS)/validate.sh

# ---------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------
start: ## Запустить весь стек
	@$(SCRIPTS)/require-env.sh
	@$(COMPOSE) up -d --remove-orphans
	@echo "==> стек запущен; состояние: make doctor"

stop: ## Остановить контейнеры, сохранив volumes и данные
	@$(SCRIPTS)/require-env.sh
	@$(COMPOSE) stop

restart: ## Перезапустить все контейнеры
	@$(SCRIPTS)/require-env.sh
	@$(COMPOSE) restart

build: ## Пересобрать локальные Docker-образы
	@$(SCRIPTS)/require-env.sh
	@$(COMPOSE) build --pull

pull: ## Скачать зафиксированные upstream-образы
	@$(SCRIPTS)/require-env.sh
	@$(COMPOSE) pull

status: ## Показать состояние контейнеров
	@$(SCRIPTS)/require-env.sh
	@$(COMPOSE) ps

ps: status ## Псевдоним status

logs: ## Смотреть логи; один сервис: make logs s=<service>
	@$(SCRIPTS)/require-env.sh
	@if [ -z "$(s)" ]; then $(COMPOSE) logs -f --tail=200; \
	else $(COMPOSE) logs -f --tail=200 $(s); fi

doctor: ## Проверить контейнеры, HTTPS, БД, очередь и агентов
	@$(SCRIPTS)/doctor.sh

shell-db: ## Открыть psql для базы eva
	@$(SCRIPTS)/require-env.sh
	@set -a; . $(ENV_FILE); set +a; \
	  $(COMPOSE) exec -e PGPASSWORD="$$EVA_DB_PASSWORD" postgres \
	    psql -U "$$EVA_DB_USER" -d "$$EVA_DB_NAME"

# ---------------------------------------------------------------------
# Backup / restore
# ---------------------------------------------------------------------
backup: ## Создать полную резервную копию в BACKUP_DIR
	@$(SCRIPTS)/backup.sh

restore: ## Восстановить: make restore BACKUP=/path/to/archive.tar.gz
	@if [ -z "$(BACKUP)" ]; then \
	  echo "использование: make restore BACKUP=/path/to/evaself-backup-....tar.gz" >&2; exit 2; fi
	@$(SCRIPTS)/restore.sh "$(BACKUP)"

# ---------------------------------------------------------------------
# Updates
# ---------------------------------------------------------------------
update-preview: ## Показать обновления, ничего не меняя
	@$(SCRIPTS)/update.sh --preview

update: ## Backup, обновление, перезапуск и проверка с автооткатом
	@$(SCRIPTS)/update.sh

update-force: ## То же, но даже когда скачивать нечего (после смены ветки)
	@$(SCRIPTS)/update.sh --force

rollback: ## Вернуться к предыдущим версиям и commit
	@$(SCRIPTS)/rollback.sh

# ---------------------------------------------------------------------
# Maintenance
# ---------------------------------------------------------------------
disk-cleanup: ## Очистить образы, build cache, старые логи и backups
	@$(SCRIPTS)/disk-cleanup.sh

test: ## Запустить unit-тесты eva-agent-service и media-service
	@$(SCRIPTS)/run-tests.sh

# ---------------------------------------------------------------------
# NOTE: there is deliberately NO `make destroy` / `make clean-volumes`
# target. Removing the data volumes must be an explicit, manual
# `docker volume rm` so a mistyped make target can never wipe user data,
# memory, workflows or credentials.
# ---------------------------------------------------------------------
