#!/usr/bin/env python3
"""Structural validation of the n8n workflow files.

n8n happily imports a workflow whose connections point at nodes that do
not exist — the workflow then fails at runtime, on a user's message. This
catches that at commit time.
"""

from __future__ import annotations

import json
import pathlib
import sys

REQUIRED_NODE_KEYS = ("parameters", "id", "name", "type", "typeVersion", "position")
TRIGGER_MARKERS = ("trigger", "webhook")


def validate(path: pathlib.Path) -> list[str]:
    problems: list[str] = []
    try:
        workflow = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"invalid JSON: {exc}"]

    for key in ("name", "nodes", "connections"):
        if key not in workflow:
            problems.append(f"missing top-level key '{key}'")
    if problems:
        return problems

    nodes = workflow["nodes"]
    names = [node.get("name") for node in nodes]

    if len(set(names)) != len(names):
        duplicates = {name for name in names if names.count(name) > 1}
        problems.append(f"duplicate node names: {sorted(duplicates)}")

    ids = [node.get("id") for node in nodes]
    if len(set(ids)) != len(ids):
        problems.append("duplicate node ids")

    for node in nodes:
        for key in REQUIRED_NODE_KEYS:
            if key not in node:
                problems.append(f"node {node.get('name')!r} is missing '{key}'")

    known = set(names)
    targets: set[str] = set()
    for source, outputs in workflow["connections"].items():
        if source not in known:
            problems.append(f"connection from unknown node {source!r}")
        for branch in outputs.get("main", []):
            for connection in branch:
                target = connection.get("node")
                targets.add(target)
                if target not in known:
                    problems.append(f"{source!r} connects to unknown node {target!r}")

    triggers = {
        node["name"]
        for node in nodes
        if any(marker in node.get("type", "").lower() for marker in TRIGGER_MARKERS)
    }
    if not triggers:
        problems.append("no trigger node")

    orphans = known - targets - triggers
    if orphans:
        problems.append(f"unreachable nodes: {sorted(orphans)}")

    return problems


def main() -> int:
    directory = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "n8n/workflows")
    files = sorted(directory.glob("*.json"))
    if not files:
        print(f"  no workflow files in {directory}")
        return 0

    failed = 0
    for path in files:
        problems = validate(path)
        if problems:
            failed += 1
            print(f"  ✖ {path.name}")
            for problem in problems:
                print(f"      - {problem}")
        else:
            node_count = len(json.loads(path.read_text(encoding="utf-8"))["nodes"])
            print(f"  ✔ {path.name} ({node_count} nodes)")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
