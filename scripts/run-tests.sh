#!/usr/bin/env bash
# =====================================================================
# Unit tests for the two services Evaself owns the source of.
#
# Runs inside the built images, so the tests execute against exactly the
# dependency versions that will run in production — and the host needs no
# Python environment at all.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env

FAILURES=0

run_suite() {
	local name="$1" image="$2" context="$3"
	step "$name"

	if ! docker image inspect "$image" >/dev/null 2>&1; then
		info "building $image"
		compose build "$context" >/dev/null || { fail "build failed"; FAILURES=$((FAILURES + 1)); return; }
	fi

	if docker run --rm \
		-v "$ROOT_DIR/$context:/src:ro" \
		-e MEDIA_WORK_DIR=/tmp/media \
		--entrypoint sh "$image" -c '
			set -e
			cp -r /src /tests && cd /tests
			pip install --quiet --no-cache-dir pytest pytest-asyncio >/dev/null 2>&1 || true
			python -m pytest
		'; then
		ok "$name passed"
	else
		fail "$name failed"
		FAILURES=$((FAILURES + 1))
	fi
}

# The agent service's tests run inside its own image build (the Dockerfile
# runs `node --test` in the build stage), so a successful build IS the test
# run. Building it here keeps `make test` a single entry point.
step "eva-agent-service (TypeScript, tested during the image build)"
if compose build eva-agent-service >/dev/null 2>&1; then
	ok "eva-agent-service built — typecheck and unit tests passed"
else
	fail "eva-agent-service build/tests failed"
	compose build eva-agent-service 2>&1 | tail -30
	FAILURES=$((FAILURES + 1))
fi

run_suite "media-service" "evaself/media-service:0.1.0" "media-service"

step "Static validation"
"$SCRIPT_DIR/validate.sh" || FAILURES=$((FAILURES + 1))

step "Result"
if [ "$FAILURES" -eq 0 ]; then
	ok "all suites passed"
else
	fail "$FAILURES suite(s) failed"
fi
exit $(( FAILURES > 0 ? 1 : 0 ))
