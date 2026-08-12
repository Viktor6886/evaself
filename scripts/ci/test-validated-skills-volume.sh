#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="${GITHUB_RUN_ID:-local}-$$-${RANDOM}"
PREFIX="evaself-ci-skills-${RUN_ID//[^a-zA-Z0-9_.-]/-}"
VOLUME="$PREFIX-volume"
IMAGE="${VALIDATED_SKILLS_IMAGE:-$PREFIX-image}"
BUILT_IMAGE=0
containers=()

cleanup() {
  local status=$?
  for container in "${containers[@]}"; do docker rm -f "$container" >/dev/null 2>&1 || true; done
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  if [[ "$BUILT_IMAGE" == 1 ]]; then docker image rm -f "$IMAGE" >/dev/null 2>&1 || true; fi
  exit "$status"
}
trap cleanup EXIT INT TERM

run_named() {
  local name="$1"; shift
  containers+=("$name")
  docker run --name "$name" "$@"
  docker rm "$name" >/dev/null
}

if [[ -z "${VALIDATED_SKILLS_IMAGE:-}" ]]; then
  # Same service image used by skill-indexer and the long-running writer.
  # CI's images job may pass its already built tag to avoid rebuilding.
  # shellcheck disable=SC1091
  . "$ROOT/versions.env"
  docker build -q -t "$IMAGE" --build-arg "NODE_BASE_VERSION=$NODE_BASE_VERSION" \
    "$ROOT/eva-agent-service" >/dev/null
  BUILT_IMAGE=1
fi

docker volume create "$VOLUME" >/dev/null
COMMON=(-v "$VOLUME:/data/letta/.skills" -v "$ROOT/scripts/ci/test-validated-skills-volume.mjs:/test.mjs:ro")

run_named "$PREFIX-cold" "${COMMON[@]}" "$IMAGE" node /test.mjs cold
owner_mode="$(docker run --rm --entrypoint sh -v "$VOLUME:/skills:ro" "$IMAGE" -c 'stat -c "%U:%G %a" /skills')"
[[ "$owner_mode" == "node:node 750" ]] || { echo "unexpected volume root: $owner_mode" >&2; exit 1; }

generation_one="$(docker run --rm --entrypoint sh -v "$VOLUME:/skills:ro" "$IMAGE" -c 'cat /skills/valid/SKILL.md')"
[[ "$generation_one" == *generation-one* ]]
! docker run --rm --entrypoint sh -v "$VOLUME:/skills:ro" "$IMAGE" -c 'test -e /skills/malformed/SKILL.md'

run_named "$PREFIX-failed" "${COMMON[@]}" "$IMAGE" node /test.mjs failed
[[ "$(docker run --rm --entrypoint sh -v "$VOLUME:/skills:ro" "$IMAGE" -c 'cat /skills/valid/SKILL.md')" == "$generation_one" ]]

# A tight read loop runs concurrently with rename-based publication. It is bounded
# by timeout and fails on an empty/missing generation; no readiness sleep is used.
reader="$PREFIX-atomic-reader"
containers+=("$reader")
docker run -d --name "$reader" --entrypoint sh -v "$VOLUME:/skills:ro" "$IMAGE" -c \
  'timeout 20 sh -c '\''while :; do test -s /skills/valid/SKILL.md || exit 41; grep -Eq "generation-(one|two)" /skills/valid/SKILL.md || exit 42; done'\''; test $? -eq 124' >/dev/null
run_named "$PREFIX-update" "${COMMON[@]}" "$IMAGE" node /test.mjs update
docker stop --time 1 "$reader" >/dev/null
reader_status="$(docker inspect -f '{{.State.ExitCode}}' "$reader")"
[[ "$reader_status" == 0 || "$reader_status" == 137 || "$reader_status" == 143 ]] || { docker logs "$reader"; exit 1; }
docker rm "$reader" >/dev/null

# New containers prove persistence after the writer and first consumer are gone.
run_named "$PREFIX-restart-reader" --entrypoint sh -v "$VOLUME:/skills:ro" "$IMAGE" -c \
  'grep -q generation-two /skills/valid/SKILL.md && test -s /skills/valid/SKILL.md'

if docker run --rm --entrypoint sh --user node -v "$VOLUME:/skills:ro" "$IMAGE" -c \
  'printf forbidden > /skills/valid/SKILL.md' >/dev/null 2>&1; then
  echo "read-only consumer unexpectedly wrote to validated skills" >&2
  exit 1
fi

echo "validated_skills isolated volume lifecycle: PASS"
