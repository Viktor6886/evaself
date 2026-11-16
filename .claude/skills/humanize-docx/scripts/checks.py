#!/usr/bin/env python3
"""Все детекторы навыков правки текста и проверки сохранности одной командой.

  python3 checks.py ТЕКУЩИЙ.md [--orig ИСХОДНЫЙ.md] [--genre ЖАНР] [--json]

Жанр: academic (ВКР, статья, диссертация), general, business, blog, docs, telegram,
news, legal, fiction. Он выбирает --genre сканера humanizer-ru и --context детектора aiw-ru.

Что запускается:
  humanizer-ru     scripts/scan.py            чистота 0–100, выше — лучше
  avoid-ai-…       aiw-ru scan                ИИ-стиль 0–100, ниже — лучше; находки P0–P2
  antiplagiat      aiw-ru antiplagiat         доля ИИ-текста по фрагментам, цель 0 %
  humanizer-ru-vh  scripts/lint_style.py      балл признаков, ниже — лучше
  с --orig:        check_facts.py, aiw-ru validate, scan.py --before (факт-замок)

Инструменты ищутся сами: aiw-ru из PATH, иначе через uvx (aiw-ru==2.8.0); сканеру
humanizer-ru без pymorphy3 и razdel зависимости подставляет uv. Код выхода 1, если
проверка сохранности нашла повреждение; 0 — иначе.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

SKILLS = Path(__file__).resolve().parents[2]
SCAN = SKILLS / "humanizer-ru" / "scripts" / "scan.py"
LINT = SKILLS / "humanizer-ru-vh" / "scripts" / "lint_style.py"
FACTS = SKILLS / "humanizer-ru-vh" / "scripts" / "check_facts.py"
AIW_VERSION = "aiw-ru==2.8.0"
SCAN_DEPS = ["pymorphy3==2.0.6", "razdel==0.5.0"]
GENRES = {
    # жанр: (--genre сканера humanizer-ru или None, --context aiw-ru)
    "academic": ("academic", "vak"),
    "general": (None, "general"),
    "business": (None, "business-email"),
    "blog": (None, "blog"),
    "docs": (None, "docs"),
    "telegram": (None, "telegram"),
    "news": ("news", "general"),
    "legal": ("legal", "general"),
    "fiction": ("fiction", "general"),
}


def aiw_cmd() -> list[str] | None:
    if shutil.which("aiw-ru"):
        return ["aiw-ru"]
    if shutil.which("uvx"):
        return ["uvx", "-q", "--from", AIW_VERSION, "aiw-ru"]
    return None


def run(cmd: list[str], timeout: int = 600) -> tuple[int, str, str]:
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 99, "", str(exc)
    return res.returncode, res.stdout, res.stderr


def run_json(cmd: list[str]):
    code, out, err = run(cmd)
    try:
        return code, json.loads(out), err
    except json.JSONDecodeError:
        return code, None, (err or out)[-400:]


def scan_py(args: list[str]):
    """scan.py humanizer-ru; без pymorphy3/razdel — через uv с закреплёнными версиями."""
    code, data, err = run_json([sys.executable, "-B", str(SCAN), *args, "--json"])
    if data is None and shutil.which("uv"):
        withs = [x for dep in SCAN_DEPS for x in ("--with", dep)]
        code, data, err = run_json(["uv", "run", "-q", "--no-project", *withs, "python", "-B",
                                    str(SCAN), *args, "--json"])
    return code, data, err


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("current")
    ap.add_argument("--orig")
    ap.add_argument("--genre", default="general", choices=sorted(GENRES))
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    genre, context = GENRES[a.genre]
    cur, orig = a.current, a.orig
    aiw = aiw_cmd()
    report: dict = {"genre": a.genre, "context": context, "tools": {}, "damage": []}
    lines = ["Детекторы (жанр %s: scan.py %s, aiw-ru --context %s)" % (
        a.genre, "--genre " + genre if genre else "без --genre", context)]
    gflag = ["--genre", genre] if genre else []

    # humanizer-ru: чистота и, с исходником, факт-замок
    _code, data, err = scan_py([cur, *gflag] + (["--before", orig] if orig else []))
    if data:
        was = data.get("before", {}).get("score")
        report["tools"]["humanizer-ru"] = {"score": data["score"], "before": was,
                                           "hard_bans": data.get("hard_ban_count"),
                                           "markers": data.get("marker_count")}
        lines.append("  humanizer-ru  scan.py         чистота %s/100%s, жёстких запретов %s, маркеров %s"
                     "   [выше — лучше, ≥85 чисто]" % (data["score"], " (было %s)" % was if was is not None else "",
                                                       data.get("hard_ban_count"), data.get("marker_count")))
        facts = data.get("facts")
        if facts and not facts.get("ok", True):
            lost = [str(x) for x in facts.get("lost", [])] + ["добавлено: %s" % x for x in facts.get("added", [])]
            report["damage"].append("scan.py факт-замок: " + "; ".join(lost)[:300])
    else:
        lines.append("  humanizer-ru  scan.py         не запустился: %s" % (err or "").strip()[:200])

    if aiw:
        _code, data, err = run_json([*aiw, "scan", cur, "--context", context, "--json"])
        if isinstance(data, list):
            data = data[0] if data else None
        if data:
            sev: dict[str, int] = {}
            for issue in data.get("issues", []):
                sev[issue.get("severity", "?")] = sev.get(issue.get("severity", "?"), 0) + 1
            light = data.get("light", {})
            report["tools"]["aiw-ru scan"] = {"score": data["score"], "label": data.get("label"),
                                              "severity": sev, "light": light.get("level")}
            lines.append("  avoid-ai-…    aiw-ru scan     ИИ-стиль %s/100 (%s), P0 %d, P1 %d, P2 %d, стиль %d, "
                         "светофор %s   [ниже — лучше]" % (
                             data["score"], data.get("label"), sev.get("P0", 0), sev.get("P1", 0),
                             sev.get("P2", 0), sev.get("стиль", 0), light.get("level")))
            if light.get("level") == "red":
                report["damage"].append("светофор красный: %s" % light.get("hint"))
        else:
            lines.append("  avoid-ai-…    aiw-ru scan     не запустился: %s" % (err or "").strip()[:200])
        _code, data, err = run_json([*aiw, "antiplagiat", cur, "--context", context, "--json"])
        if data:
            frags = data.get("fragments", [])
            red = [f for f in frags if f.get("zone") == "red"]
            yellow = [f for f in frags if f.get("zone") == "yellow"]
            report["tools"]["antiplagiat"] = {
                "aiShare": data.get("aiShare"), "red": len(red), "yellow": len(yellow),
                "fragments": len(frags), "suspicious": data.get("suspicious"),
                "red_lines": [[f.get("line"), f.get("endLine")] for f in red],
                "yellow_lines": [[f.get("line"), f.get("endLine")] for f in yellow]}
            lines.append("  antiplagiat   aiw-ru antiplag доля ИИ %s %%, красных %d, жёлтых %d из %d фрагментов%s"
                         "   [цель 0 %%, ни одного красного]" % (
                             data.get("aiShare"), len(red), len(yellow), len(frags),
                             ", ДОКУМЕНТ ПОДОЗРИТЕЛЬНЫЙ" if data.get("suspicious") else ""))
            if red or yellow:
                lines.append("                строки красных: %s; жёлтых: %s" % (
                    ", ".join("%s–%s" % tuple(x) for x in report["tools"]["antiplagiat"]["red_lines"]) or "нет",
                    ", ".join("%s–%s" % tuple(x) for x in report["tools"]["antiplagiat"]["yellow_lines"]) or "нет"))
            if data.get("suspicious"):
                report["damage"].append("документ подозрительный: %s" % "; ".join(
                    str(x) for x in data.get("suspiciousReasons", []))[:300])
        else:
            lines.append("  antiplagiat   aiw-ru antiplag не запустился: %s" % (err or "").strip()[:200])
    else:
        lines.append("  aiw-ru не найден, и uvx нет: детектор avoid-ai-writing-russian и antiplagiat не запускался")

    _code, data, err = run_json([sys.executable, "-B", str(LINT), cur, "--json"])
    if data:
        report["tools"]["humanizer-ru-vh"] = {"score": data.get("score"), "level": data.get("level")}
        lines.append("  humanizer-ru-vh lint_style    признаков %s (%s)   [ниже — лучше]" % (
            data.get("score"), data.get("level")))
    else:
        lines.append("  humanizer-ru-vh lint_style    не запустился: %s" % (err or "").strip()[:200])

    if orig:
        lines.append("Сохранность против исходного %s" % orig)
        _code, data, err = run_json([sys.executable, "-B", str(FACTS), orig, cur, "--json"])
        if data is not None:
            errs = data.get("errors", [])
            report["tools"]["check_facts"] = {"errors": errs}
            lines.append("  check_facts.py  %s" % ("ошибок нет" if not errs else "ОШИБКИ: " + "; ".join(
                str(e) for e in errs)[:400]))
            if errs:
                report["damage"].append("check_facts: " + "; ".join(str(e) for e in errs)[:300])
        else:
            lines.append("  check_facts.py  не запустился: %s" % (err or "").strip()[:200])
        if aiw:
            _code, data, err = run_json([*aiw, "validate", orig, cur, "--context", context, "--json"])
            if data is not None:
                viol, warn = data.get("violations", []), data.get("warnings", [])
                report["tools"]["validate"] = {"ok": data.get("ok"), "violations": viol, "warnings": warn}
                lines.append("  aiw-ru validate %s%s" % (
                    "ок" if data.get("ok") else "ПОВРЕЖДЕНО: " + "; ".join(json.dumps(v, ensure_ascii=False)
                                                                        for v in viol)[:400],
                    ", предупреждений %d (сверь с исходником)" % len(warn) if warn else ""))
                if not data.get("ok"):
                    report["damage"].append("validate: " + "; ".join(
                        json.dumps(v, ensure_ascii=False) for v in viol)[:300])
            else:
                lines.append("  aiw-ru validate не запустился: %s" % (err or "").strip()[:200])

    aiw_s = " ".join(aiw) if aiw else "aiw-ru"
    lines.append("Подробно: %s antiplagiat %s --context %s --explain | %s scan %s --context %s | "
                 "python3 %s %s%s | python3 %s %s%s" % (
                     aiw_s, cur, context, aiw_s, cur, context, SCAN, cur,
                     " --genre " + genre if genre else "", LINT, cur,
                     " | python3 %s %s %s" % (FACTS, orig, cur) if orig else ""))
    if report["damage"]:
        lines.append("ИТОГ: правка повредила текст — верни факты и оговорки, потом продолжай")
    if a.json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    else:
        print("\n".join(lines))
    return 1 if report["damage"] else 0


if __name__ == "__main__":
    sys.exit(main())
