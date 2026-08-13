#!/usr/bin/env bash
set -euo pipefail
root="${EVA_KNOWLEDGE_UPLOAD_ROOT:-/data/knowledge-uploads}"
case "$root" in /data/knowledge-uploads|/data/knowledge-uploads/*|/tmp/evaself-knowledge-test-*) ;; *) echo "refusing unsafe root: $root" >&2; exit 2;; esac
if [[ "${1:-}" != "--confirm" ]]; then echo "usage: $0 --confirm" >&2; exit 2; fi
if [[ -L "$root" ]]; then echo "refusing symlink root: $root" >&2; exit 2; fi
find "$root" -mindepth 1 -xdev -delete 2>/dev/null || true
install -d -m 0700 "$root"
if find "$root" -mindepth 1 -print -quit | grep -q .; then echo "cleanup left files behind" >&2; exit 1; fi
