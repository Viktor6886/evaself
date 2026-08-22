#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCOPE="$ROOT/scripts/ci/changed-scope.sh"

value() {
	local files="$1" key="$2"
	CHANGED_FILES="$files" "$SCOPE" HEAD HEAD 2>/dev/null | awk -F= -v key="$key" '$1 == key { print $2 }'
}

expect() {
	local files="$1" prompt="$2" content="$3"
	test "$(value "$files" prompt_only)" = "$prompt"
	test "$(value "$files" docs_only)" = "$content"
}

expect 'library/persona/eva.md' true true
expect 'library/system/letta_local_memfs.md' true true
expect $'library/persona/eva.md\nlibrary/system/letta_local_memfs.md' true true
expect $'library/persona/eva.md\neva-agent-service/src/eva-workflow.ts' false false
expect $'library/persona/eva.md\ncompose.yml' false false
expect 'library/persona/other.md' false false
expect '.github/workflows/ci.yml' false false

echo 'changed-scope prompt classification: ok'
