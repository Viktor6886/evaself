#!/usr/bin/env bash
# =====================================================================
# Static validation — no service is started, nothing is changed.
#
# Runs the checks that catch a broken commit before it reaches a server:
# compose renders, Caddyfiles parse, shell scripts parse, workflow JSON
# is well-formed and internally consistent, SQL migrations are readable.
# =====================================================================
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

FAILURES=0
check_failed() { fail "$*"; FAILURES=$((FAILURES + 1)); }

# ---------------------------------------------------------------------
step "Shell scripts"
# ---------------------------------------------------------------------
for file in "$ROOT_DIR"/scripts/*.sh "$ROOT_DIR"/backup-service/backup-service; do
	[ -e "$file" ] || continue
	if bash -n "$file" 2>/dev/null; then
		ok "$(basename "$file")"
	else
		check_failed "$(basename "$file") has a syntax error"
		bash -n "$file" 2>&1 | sed 's/^/      /'
	fi
done

if command -v shellcheck >/dev/null 2>&1; then
	step "shellcheck"
	for file in "$ROOT_DIR"/scripts/*.sh; do
		if shellcheck -S error -x "$file" >/dev/null 2>&1; then
			ok "$(basename "$file")"
		else
			check_failed "$(basename "$file")"
			shellcheck -S error -x "$file" 2>&1 | head -12 | sed 's/^/      /'
		fi
	done
else
	info "shellcheck not installed — skipping the deeper shell lint"
fi

# ---------------------------------------------------------------------
step "Docker Compose"
# ---------------------------------------------------------------------
ENV_FOR_CHECK="$ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
	# Render against the template so validation works before installation.
	ENV_FOR_CHECK="$(mktemp)"
	sed 's/^\([A-Z0-9_]*\)=$/\1=placeholder/' "$ROOT_DIR/.env.example" > "$ENV_FOR_CHECK"
	info "no .env yet — validating against .env.example"
fi

if docker compose --env-file "$VERSIONS_FILE" --env-file "$ENV_FOR_CHECK" \
	-f "$ROOT_DIR/compose.yaml" config -q 2>/tmp/compose-err; then
	SERVICES="$(docker compose --env-file "$VERSIONS_FILE" --env-file "$ENV_FOR_CHECK" \
		-f "$ROOT_DIR/compose.yaml" config --services | wc -l)"
	ok "compose.yaml renders ($SERVICES default services)"
else
	check_failed "compose.yaml does not render"
	sed 's/^/      /' /tmp/compose-err
fi
[ "$ENV_FOR_CHECK" = "$ENV_FILE" ] || rm -f "$ENV_FOR_CHECK"

# ---------------------------------------------------------------------
step "Caddy configuration"
# ---------------------------------------------------------------------
if command -v caddy >/dev/null 2>&1; then
	CADDY_CMD=(caddy)
else
	# shellcheck disable=SC1090
	. "$VERSIONS_FILE"
	CADDY_CMD=(docker run --rm -i -v "$ROOT_DIR:/work:ro" -w /work "${CADDY_IMAGE}:${CADDY_VERSION}" caddy)
fi

validate_caddyfile() {
	local path="$1" label="$2"
	if env \
		DOMAIN=example.test DOMAIN_APP=app.example.test DOMAIN_API=api.example.test \
		DOMAIN_N8N=n8n.example.test DOMAIN_NOCODB=admin.example.test \
		DOMAIN_LETTA=letta.example.test DOMAIN_STATUS=status.example.test \
		ACME_EMAIL=ops@example.test ACME_CA=https://acme-v02.api.letsencrypt.org/directory \
		LETTA_UI_USER=admin LETTA_UI_PASSWORD_HASH='$2a$14$placeholderplaceholderpl' \
		EVA_CORE_PORT=8080 LETTA_URL=http://letta:8283 LETTA_SERVER_PASSWORD=placeholder \
		"${CADDY_CMD[@]}" validate --config "$path" >/dev/null 2>&1; then
		ok "$label"
	else
		check_failed "$label does not validate"
	fi
}

validate_caddyfile "$ROOT_DIR/Caddyfile"          "Caddyfile (edge)"
validate_caddyfile "$ROOT_DIR/webapp/Caddyfile"   "webapp/Caddyfile"
validate_caddyfile "$ROOT_DIR/letta-ui/Caddyfile" "letta-ui/Caddyfile"

# ---------------------------------------------------------------------
step "n8n workflows"
# ---------------------------------------------------------------------
if ! python3 "$SCRIPT_DIR/validate-workflows.py" "$ROOT_DIR/n8n/workflows"; then
	check_failed "workflow validation failed"
fi

# ---------------------------------------------------------------------
step "TypeScript"
# ---------------------------------------------------------------------
if command -v node >/dev/null 2>&1 && [ -d "$ROOT_DIR/eva-agent-service/node_modules" ]; then
	if (cd "$ROOT_DIR/eva-agent-service" && npx --no-install tsc -p tsconfig.json --noEmit 2>&1 | head -20); then
		ok "eva-agent-service typechecks"
	else
		check_failed "eva-agent-service does not typecheck"
	fi
else
	info "node/node_modules not present — typecheck runs in CI and in the image build"
fi

# ---------------------------------------------------------------------
step "SQL migrations"
# ---------------------------------------------------------------------
for file in "$ROOT_DIR"/postgres/migrations/*.sql; do
	[ -e "$file" ] || continue
	name="$(basename "$file")"
	if grep -q 'BEGIN;' "$file" && grep -q 'COMMIT;' "$file"; then
		if grep -q "INSERT INTO schema_migrations" "$file"; then
			ok "$name (transactional, records its version)"
		else
			check_failed "$name does not record itself in schema_migrations"
		fi
	else
		check_failed "$name is not wrapped in a transaction"
	fi
done

# ---------------------------------------------------------------------
step "Secrets"
# ---------------------------------------------------------------------
if git -C "$ROOT_DIR" ls-files --error-unmatch .env >/dev/null 2>&1; then
	check_failed ".env is tracked by git — it must never be committed"
else
	ok ".env is not tracked by git"
fi

LEAKS="$(git -C "$ROOT_DIR" grep -lIE '(BEGIN (RSA|OPENSSH) PRIVATE KEY|[0-9]{8,}:AA[A-Za-z0-9_-]{30,})' -- . 2>/dev/null | grep -v '^scripts/validate.sh$' || true)"
if [ -n "$LEAKS" ]; then
	check_failed "possible secret material in: $LEAKS"
else
	ok "no bot tokens or private keys in tracked files"
fi

# ---------------------------------------------------------------------
step "Result"
# ---------------------------------------------------------------------
if [ "$FAILURES" -eq 0 ]; then
	ok "all static checks passed"
else
	fail "$FAILURES check(s) failed"
fi
exit $(( FAILURES > 0 ? 1 : 0 ))
