#!/usr/bin/env python3
"""Версии Letta выводятся из lockfile, а не набираются во второй раз руками.

Одна и та же связка версий жила в трёх местах: `package.json` агента
(клиент), `versions.env` (образ App Server) и `VERIFIED_VERSIONS`
(матрица возможностей). Согласовывать их приходилось вручную, и
автоматическое обновление зависимостей приходило заведомо красным:
dependabot правит только `package.json`, а образ App Server остаётся на
прежней версии. Клиент и сервер говорят по одному протоколу — разъехаться
им нельзя.

Истина здесь одна: `eva-agent-service/package-lock.json`. Что там
установлено, то и должно стоять в остальных файлах, потому что
`@letta-ai/letta-agent-sdk` зависит от `@letta-ai/letta-code` точной
версией — выбирать нечего, значение выводится однозначно.

    python3 scripts/ci/sync-letta-versions.py          # проверить
    python3 scripts/ci/sync-letta-versions.py --fix    # выровнять

Проверка версий не отменяет проверку поведения: что установленный пакет
действительно умеет обещанное, доказывает `letta-contract.test.ts` на
живых объектах, а живой прогон — smoke на стенде.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCKFILE = ROOT / "eva-agent-service" / "package-lock.json"
VERSIONS_ENV = ROOT / "versions.env"
CAPABILITIES = ROOT / "eva-agent-service" / "src" / "letta" / "capabilities.ts"
DOCKERFILE = ROOT / "letta-app-server" / "Dockerfile"

SDK = "@letta-ai/letta-agent-sdk"
CODE = "@letta-ai/letta-code"
CLIENT = "@letta-ai/letta-client"


def installed() -> dict[str, str]:
    """Версии из lockfile: то, что действительно установится по `npm ci`."""
    packages = json.loads(LOCKFILE.read_text(encoding="utf-8"))["packages"]
    found: dict[str, str] = {}
    for name in (SDK, CODE, CLIENT):
        entry = packages.get(f"node_modules/{name}")
        if not entry or not entry.get("version"):
            raise SystemExit(f"{LOCKFILE}: не найдена версия {name}")
        found[name] = entry["version"]

    # Связь SDK и CLI — не совпадение, а объявленная зависимость. Если
    # SDK когда-нибудь ослабит её до диапазона, выводить версию образа
    # из lockfile станет нельзя, и узнать об этом лучше здесь.
    declared = packages[f"node_modules/{SDK}"].get("dependencies", {}).get(CODE)
    if declared != found[CODE]:
        raise SystemExit(
            f"{SDK} {found[SDK]} требует {CODE} «{declared}», а установлен "
            f"{found[CODE]}: версия образа App Server больше не выводится однозначно"
        )
    return found


def rules(version: dict[str, str]) -> list[tuple[Path, str, str, str]]:
    """Где ещё лежит версия: файл, регулярное выражение, замена, объяснение."""
    return [
        (
            VERSIONS_ENV,
            r"(?m)^LETTA_AGENT_SDK_VERSION=.*$",
            f"LETTA_AGENT_SDK_VERSION={version[SDK]}",
            "версия SDK в versions.env",
        ),
        (
            VERSIONS_ENV,
            r"(?m)^LETTA_CODE_VERSION=.*$",
            f"LETTA_CODE_VERSION={version[CODE]}",
            "версия CLI образа App Server",
        ),
        (
            VERSIONS_ENV,
            r"(?m)^LETTA_CLIENT_VERSION=.*$",
            f"LETTA_CLIENT_VERSION={version[CLIENT]}",
            "версия клиента в versions.env",
        ),
        (
            VERSIONS_ENV,
            r"(?m)^# @letta-ai/letta-agent-sdk .* зависит от @letta-ai/letta-code ровно$",
            f"# @letta-ai/letta-agent-sdk {version[SDK]} зависит от @letta-ai/letta-code ровно",
            "пояснение к связке версий",
        ),
        (
            VERSIONS_ENV,
            r"(?m)^# \d+\.\d+\.\d+ и от @letta-ai/letta-client \^.*$",
            f"# {version[CODE]} и от @letta-ai/letta-client ^{version[CLIENT]}. App Server и SDK говорят",
            "пояснение к связке версий",
        ),
        (
            CAPABILITIES,
            r'(?m)^(\s*agentSdk: )"[^"]*",$',
            None,  # подставляется ниже: нужна сохранённая отступом группа
            "проверенная версия матрицы возможностей",
        ),
        (
            DOCKERFILE,
            r"(?m)^ARG LETTA_CODE_VERSION=.*$",
            f"ARG LETTA_CODE_VERSION={version[CODE]}",
            "умолчание версии CLI в образе App Server",
        ),
    ]


def apply(fix: bool) -> int:
    version = installed()
    problems: list[str] = []
    edits: dict[Path, str] = {}

    for path, pattern, replacement, reason in rules(version):
        if replacement is None:
            replacement = f'\\g<1>"{version[SDK]}",'
        text = edits.get(path, path.read_text(encoding="utf-8"))
        if not re.search(pattern, text):
            problems.append(f"{path.relative_to(ROOT)}: не найдена строка — {reason}")
            continue
        updated = re.sub(pattern, replacement, text, count=1)
        if updated == text:
            continue
        if not fix:
            problems.append(
                f"{path.relative_to(ROOT)}: {reason} разошлась с lockfile "
                f"(ожидается по {SDK} {version[SDK]})"
            )
            continue
        edits[path] = updated

    for path, text in edits.items():
        path.write_text(text, encoding="utf-8")
        print(f"  выровнено {path.relative_to(ROOT)}")

    if problems:
        for problem in problems:
            print(f"::error::{problem}", file=sys.stderr)
        print(
            "\nВерсии Letta выводятся из eva-agent-service/package-lock.json. "
            "Выровнять: python3 scripts/ci/sync-letta-versions.py --fix",
            file=sys.stderr,
        )
        return 1

    print(
        f"версии Letta согласованы: SDK {version[SDK]}, "
        f"CLI {version[CODE]}, клиент {version[CLIENT]}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(apply(fix="--fix" in sys.argv[1:]))
