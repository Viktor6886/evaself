#!/usr/bin/env python3
"""Абзацы .docx для правки навыками и обратная запись с сохранением оформления.

Команды:
  extract ДОК.docx ПАПКА [--tables]    разобрать документ: ПАПКА/doc.json (служебное)
                                       и ПАПКА/orig.edit.md (абзацы для правки)
  text ПАПКА ПРАВКА.edit.md ВЫХОД.md   текст для детекторов: заголовки и проза
  apply ПАПКА ПРАВКА.edit.md ВЫХОД.docx записать правку в копию документа
  verify ПАПКА ПРАВКА.edit.md ВЫХОД.docx [--pdf]
                                       проверить, что вне правленых абзацев ничего
                                       не изменилось; --pdf ещё и открыть в LibreOffice

Разметка в .edit.md (меняется только текст под заголовком блока):
  <!-- p12 | ... -->   заголовок блока, его не трогать
  ⟦1⟧…⟦/1⟧             фрагмент с особым оформлением (жирный, курсив, индекс и т. п.);
                       пару можно сдвинуть на другие слова или убрать
  ⟦@1⟧                 неделимый объект: поле-ссылка [12], сноска, формула, рисунок,
                       гиперссылка; каждый должен остаться ровно один раз
  ⟦br⟧ ⟦tab⟧            разрыв строки и табуляция внутри абзаца
  ⟦¶⟧                  разбить абзац на два (оформление абзаца копируется)
  пустой блок          удалить абзац (нельзя, если в нём есть ⟦@n⟧)

Нужен python-docx (pip install python-docx). Исходный файл не меняется никогда.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

try:
    from docx import Document
    from lxml import etree
except ImportError:  # pragma: no cover - сообщение для человека
    print("Нужен python-docx: python3 -m pip install python-docx "
          "(или uv run --with python-docx python3 docx_text.py …)", file=sys.stderr)
    sys.exit(3)

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


def q(tag: str, ns: str = W) -> str:
    return "{%s}%s" % (ns, tag)


OPEN, CLOSE = "⟦", "⟧"  # ⟦ ⟧
TOKEN_RE = re.compile(r"(⟦(?:/?\d+|@\d+|br|tab|¶)⟧)")
HEADER_RE = re.compile(r"^<!-- (p\d+)(?: \|.*)? -->\s*$")
SKIP_ANCESTORS = {q("txbxContent"), q("Fallback", MC)}
FLOAT_START = {q("bookmarkStart"), q("commentRangeStart"), q("permStart"),
               q("moveFromRangeStart"), q("moveToRangeStart")}
FLOAT_END = {q("bookmarkEnd"), q("commentRangeEnd"), q("permEnd"),
             q("moveFromRangeEnd"), q("moveToRangeEnd")}
TRACKED = {q("ins"), q("del"), q("moveFrom"), q("moveTo")}
TEXT_RUN_CHILDREN = {q("rPr"), q("t"), q("tab"), q("br"), q("cr"), q("noBreakHyphen"),
                     q("softHyphen"), q("lastRenderedPageBreak")}
SIG_NOISE = {q("lang"), q("noProof")}
HEADING_RE = re.compile(r"^(heading|заголовок|title|subtitle|название|подзаголовок)\b", re.IGNORECASE)
TOC_RE = re.compile(r"^(toc|оглавление|table of contents)", re.IGNORECASE)
CAPTION_STYLE_RE = re.compile(r"^(caption|название объекта)$", re.IGNORECASE)
CAPTION_TEXT_RE = re.compile(r"^(рисунок|рис\.|таблица|табл\.|схема|figure|fig\.|table)\s*[\dA-ZА-Я]", re.IGNORECASE)
BIBLIO_RE = re.compile(
    r"^\s*(список\s+(использованн\w+\s+|цитируем\w+\s+)?(литературы|источников)"
    r"|библиографи\w*(\s+список)?|литература|references|bibliography|источники)\s*:?\s*$", re.IGNORECASE)


# ---------------------------------------------------------------- разбор документа

def paragraphs(body):
    """Абзацы тела документа по порядку: (элемент, в таблице, в элементе управления)."""
    out = []
    for p in body.iter(q("p")):
        anc, skip, in_table, in_sdt = p.getparent(), False, False, False
        while anc is not None and anc is not body:
            if anc.tag in SKIP_ANCESTORS:
                skip = True
                break
            if anc.tag == q("tc"):
                in_table = True
            if anc.tag == q("sdtContent"):
                in_sdt = True
            anc = anc.getparent()
        if not skip:
            out.append((p, in_table, in_sdt))
    return out


def c14n_hash(el) -> str:
    return hashlib.sha256(etree.tostring(el, method="c14n")).hexdigest()


def all_text(el) -> str:
    return "".join(t.text or "" for t in el.iter(q("t"), q("t", M)))


def signature(rpr) -> bytes:
    if rpr is None:
        return b""
    r = copy.deepcopy(rpr)
    for child in list(r):
        if child.tag in SIG_NOISE:
            r.remove(child)
        elif child.tag == q("rFonts"):
            child.attrib.pop(q("hint"), None)
    return etree.tostring(r, method="c14n") if len(r) else b""


def describe_rpr(rpr) -> str:
    if rpr is None:
        return "обычный"
    words = []
    names = {"b": "жирный", "i": "курсив", "u": "подчёркнутый", "strike": "зачёркнутый",
             "caps": "прописные", "smallCaps": "капитель", "highlight": "выделение цветом",
             "color": "цвет", "sz": "размер", "rFonts": "шрифт", "rStyle": "стиль",
             "shd": "заливка", "spacing": "интервал"}
    for child in rpr:
        tag = etree.QName(child).localname
        val = child.get(q("val"))
        if tag == "vertAlign":
            words.append({"superscript": "верхний индекс", "subscript": "нижний индекс"}.get(val, tag))
        elif tag in names and val not in ("0", "false", "none"):
            words.append(names[tag] + (" " + val if tag in ("rStyle",) and val else ""))
    return ", ".join(words) or "другое оформление"


def run_text(r) -> str | None:
    """Текст обычного прогона или None, если в прогоне есть что-то кроме текста."""
    parts = []
    for c in r:
        if c.tag not in TEXT_RUN_CHILDREN:
            return None
        if c.tag == q("t"):
            parts.append(c.text or "")
        elif c.tag == q("tab"):
            parts.append("\t")
        elif c.tag in (q("br"), q("cr")):
            if c.get(q("type")) in ("page", "column"):
                return None
            parts.append("\n")
        elif c.tag == q("noBreakHyphen"):
            parts.append("‑")
        elif c.tag == q("softHyphen"):
            parts.append("­")
        elif c.tag == q("rPr") and c.find(q("rPrChange")) is not None:
            return None
    return "".join(parts)


def atom_kind(elems) -> tuple[str, str]:
    """Вид неделимого объекта и подсказка для легенды и детекторов."""
    first = elems[0]
    if first.tag == q("hyperlink"):
        return "ссылка", all_text(first)
    if first.tag == q("fldSimple"):
        instr = (first.get(q("instr")) or "").split()
        return "поле " + (instr[0] if instr else ""), all_text(first)
    if first.tag in (q("oMath", M), q("oMathPara", M)):
        return "формула", all_text(first)
    if first.tag == q("r"):
        if first.find(q("fldChar")) is not None:
            instr = "".join(t.text or "" for e in elems for t in e.iter(q("instrText"))).split()
            result, after_sep = [], False
            for e in elems:
                for c in e.iter(q("fldChar"), q("t")):
                    if c.tag == q("fldChar") and c.get(q("fldCharType")) == "separate":
                        after_sep = True
                    elif c.tag == q("t") and after_sep:
                        result.append(c.text or "")
            return "поле " + (instr[0] if instr else ""), "".join(result)
        if first.find(q("footnoteReference")) is not None:
            return "сноска", ""
        if first.find(q("endnoteReference")) is not None:
            return "концевая сноска", ""
        if first.find(".//" + q("drawing")) is not None or first.find(q("pict")) is not None:
            return "рисунок", ""
        if first.find(q("br")) is not None:
            return "разрыв страницы", ""
        return "объект", all_text(first)
    if first.tag == q("sdt"):
        return "элемент управления", all_text(first)
    return "объект", all_text(first)


def parse_paragraph(p):
    """Разбор абзаца: последовательность элементов и причина, если править нельзя."""
    seq, floats_start, floats_end, problem = [], [], [], None
    field, depth = [], 0
    for c in p:
        if c.tag == q("pPr"):
            continue
        if depth:
            field.append(c)
            if c.tag == q("r"):
                for fc in c.iter(q("fldChar")):
                    t = fc.get(q("fldCharType"))
                    depth += 1 if t == "begin" else -1 if t == "end" else 0
            if depth == 0:
                seq.append(("atom", field))
                field = []
            continue
        if c.tag == q("r"):
            begins = [fc.get(q("fldCharType")) for fc in c.iter(q("fldChar"))]
            if begins:
                depth = sum(1 if t == "begin" else -1 if t == "end" else 0 for t in begins)
                if depth > 0:
                    field = [c]
                else:
                    seq.append(("atom", [c]))
                    depth = 0
                continue
            if c.find(q("commentReference")) is not None:
                floats_end.append(c)
                continue
            text = run_text(c)
            if text is None:
                seq.append(("atom", [c]))
            else:
                seq.append(("text", c.find(q("rPr")), text))
        elif c.tag in FLOAT_START:
            floats_start.append(c)
        elif c.tag in FLOAT_END:
            floats_end.append(c)
        elif c.tag == q("proofErr"):
            continue
        elif c.tag in TRACKED:
            problem = "правки в режиме рецензирования"
        else:
            seq.append(("atom", [c]))
    if depth:
        problem = "незакрытое поле"
    return seq, floats_start, floats_end, problem


def render(seq):
    """Текст с разметкой, описание фрагментов оформления и объектов."""
    sig_len: dict[bytes, int] = {}
    rprs: dict[bytes, object] = {}
    for item in seq:
        if item[0] == "text":
            sig = signature(item[1])
            sig_len[sig] = sig_len.get(sig, 0) + len(item[2].strip())
            rprs.setdefault(sig, item[1])
    base = max(sig_len, key=lambda s: sig_len[s]) if sig_len else b""
    spans: dict[bytes, int] = {}
    out, atoms = [], []
    # соседние прогоны с одинаковым оформлением склеиваются
    merged = []
    for item in seq:
        if item[0] == "text" and merged and merged[-1][0] == "text" and \
                signature(merged[-1][1]) == signature(item[1]):
            merged[-1] = ("text", merged[-1][1], merged[-1][2] + item[2])
        else:
            merged.append(item)
    for item in merged:
        if item[0] == "atom":
            atoms.append(item[1])
            out.append("%s@%d%s" % (OPEN, len(atoms), CLOSE))
            continue
        sig, text = signature(item[1]), item[2]
        shown = text.replace("\t", OPEN + "tab" + CLOSE).replace("\n", OPEN + "br" + CLOSE)
        if sig == base or not text.strip():
            out.append(shown)
        else:
            n = spans.setdefault(sig, len(spans) + 1)
            out.append("%s%d%s%s%s/%d%s" % (OPEN, n, CLOSE, shown, OPEN, n, CLOSE))
    span_rpr = {n: rprs[sig] for sig, n in spans.items()}
    return "".join(out), rprs.get(base), span_rpr, atoms


def visible(marked: str, atoms: dict) -> str:
    """Текст для детекторов: без разметки, объекты заменены их видимым текстом."""
    def sub(m):
        tok = m.group(1)[1:-1]
        if tok.startswith("@"):
            a = atoms.get(tok[1:], {})
            return a.get("hint", "") if not a.get("kind", "").startswith(("сноска", "рисунок")) else ""
        if tok in ("br", "tab"):
            return " "
        if tok == "¶":
            return "\n\n"
        return ""
    return TOKEN_RE.sub(sub, marked)


def style_names(doc):
    names = {}
    for s in doc.styles:
        try:
            names[s.style_id] = s.name or ""
        except Exception:  # noqa: BLE001 - необычный стиль не мешает разбору
            continue
    return names


def classify(p, in_table, in_sdt, styles, after_biblio, text, tables_ok):
    ppr = p.find(q("pPr"))
    style_id = ""
    outline = None
    if ppr is not None:
        ps = ppr.find(q("pStyle"))
        style_id = ps.get(q("val")) if ps is not None else ""
        ol = ppr.find(q("outlineLvl"))
        outline = int(ol.get(q("val"))) if ol is not None and ol.get(q("val"), "").isdigit() else None
    style = styles.get(style_id, style_id)
    level = None
    if CAPTION_STYLE_RE.match(style):
        return "caption", "подпись", style, level
    if HEADING_RE.match(style) or (outline is not None and outline < 9):
        digits = re.search(r"(\d)", style)
        level = int(digits.group(1)) if digits else (outline + 1 if outline is not None else 1)
        return "heading", "заголовок", style, level
    if TOC_RE.match(style) or in_sdt:
        return "toc", "оглавление или элемент управления", style, level
    if in_table and not tables_ok:
        return "table", "таблица", style, level
    if CAPTION_STYLE_RE.match(style) or CAPTION_TEXT_RE.match(text.strip()):
        return "caption", "подпись", style, level
    if after_biblio:
        return "biblio", "список литературы", style, level
    return "prose", "", style, level


def doc_paragraph_records(doc, tables_ok=False):
    styles = style_names(doc)
    records, after_biblio = [], False
    for idx, (p, in_table, in_sdt) in enumerate(paragraphs(doc.element.body)):
        seq, _fs, _fe, problem = parse_paragraph(p)
        plain = all_text(p)
        if not plain.strip():
            continue
        kind, reason, style, level = classify(p, in_table, in_sdt, styles, after_biblio, plain, tables_ok)
        if BIBLIO_RE.match(plain):
            after_biblio = True
            kind, reason = ("heading", "заголовок") if kind in ("prose", "biblio") else (kind, reason)
            level = level or 1
        elif kind == "heading":
            after_biblio = False
        rec = {"id": "p%d" % idx, "index": idx, "kind": kind, "style": style, "level": level,
               "hash": c14n_hash(p), "visible": plain}
        if problem:
            kind, reason = kind if kind != "prose" else "complex", problem
            rec["kind"] = kind
        marked, _base_rpr, span_rpr, atoms = render(seq)
        if OPEN in plain or CLOSE in plain:
            reason = reason or "в тексте есть символы ⟦ ⟧"
            if rec["kind"] == "prose":
                rec["kind"] = "complex"
        rec["editable"] = rec["kind"] == "prose" and not reason
        rec["reason"] = reason
        rec["marked"] = marked
        rec["spans"] = {str(n): describe_rpr(r) for n, r in span_rpr.items()}
        rec["atoms"] = {}
        for k, elems in enumerate(atoms, 1):
            akind, hint = atom_kind(elems)
            rec["atoms"][str(k)] = {"kind": akind.strip(), "hint": hint,
                                    "text": "".join(all_text(e) for e in elems)}
        records.append(rec)
    return records


# ---------------------------------------------------------------- файлы правки

def write_edit(path: Path, records) -> int:
    lines = ["<!-- humanize-docx: правьте только текст под заголовками блоков. "
             "Разметка: ⟦n⟧…⟦/n⟧ оформление, ⟦@n⟧ объект (оставить ровно один раз), "
             "⟦br⟧ ⟦tab⟧, ⟦¶⟧ разбить абзац, пустой блок удалить абзац. -->", ""]
    n = 0
    for r in records:
        if not r["editable"]:
            continue
        legend = ["⟦%s⟧ %s" % (k, v) for k, v in r["spans"].items()]
        legend += ["@%s %s%s" % (k, a["kind"], " «%s»" % a["hint"][:40] if a["hint"] else "")
                   for k, a in r["atoms"].items()]
        legend_text = "; ".join(legend).replace("--", "–").replace("\n", " ")
        lines.append("<!-- %s%s -->" % (r["id"], (" | " + legend_text) if legend else ""))
        lines.append(r["marked"])
        lines.append("")
        n += 1
    path.write_text("\n".join(lines), encoding="utf-8")
    return n


def read_edit(path: Path) -> dict[str, str]:
    blocks: dict[str, list[str]] = {}
    current = None
    for line in path.read_text(encoding="utf-8").splitlines():
        m = HEADER_RE.match(line)
        if m:
            current = m.group(1)
            if current in blocks:
                raise SystemExit("блок %s встречается дважды в %s" % (current, path))
            blocks[current] = []
        elif current is not None:
            if line.strip():
                blocks[current].append(line.strip())
    return {k: " ".join(v) for k, v in blocks.items()}


def load_state(workdir: Path):
    state = json.loads((workdir / "doc.json").read_text(encoding="utf-8"))
    return state, {r["id"]: r for r in state["paragraphs"]}


def edits_against(state, recs, edit_path: Path) -> dict[str, str]:
    edits = read_edit(edit_path)
    unknown = [k for k in edits if k not in recs or not recs[k]["editable"]]
    if unknown:
        raise SystemExit("в правке блоки, которых нет среди правимых абзацев: " + ", ".join(unknown))
    return {k: v for k, v in edits.items() if " ".join(v.split()) != " ".join(recs[k]["marked"].split())}


# ---------------------------------------------------------------- обратная запись

def check_tokens(text: str, rec) -> list[str]:
    errors, used, current = [], [], None
    stray = TOKEN_RE.sub("", text)
    if OPEN in stray or CLOSE in stray:
        errors.append("скобки ⟦ ⟧ вне разметки")
    for tok in TOKEN_RE.findall(text):
        body = tok[1:-1]
        if body.startswith("@"):
            if body[1:] not in rec["atoms"]:
                errors.append("неизвестный объект %s" % tok)
            used.append(body[1:])
        elif body.startswith("/"):
            if current != body[1:]:
                errors.append("закрывающая %s без открывающей" % tok)
            current = None
        elif body.isdigit():
            if current is not None:
                errors.append("вложенное оформление %s" % tok)
            if body not in rec["spans"]:
                errors.append("неизвестное оформление %s" % tok)
            current = body
        elif body == "¶" and current is not None:
            errors.append("⟦¶⟧ внутри фрагмента оформления")
    if current is not None:
        errors.append("не закрыто оформление ⟦%s⟧" % current)
    missing = [k for k in rec["atoms"] if used.count(k) == 0]
    twice = sorted({k for k in used if used.count(k) > 1})
    if missing:
        errors.append("пропали объекты: " + ", ".join(
            "⟦@%s⟧ %s" % (k, rec["atoms"][k]["kind"]) for k in missing))
    if twice:
        errors.append("объекты повторены: " + ", ".join("⟦@%s⟧" % k for k in twice))
    return errors


def text_runs(text: str, rpr):
    """Прогоны для куска текста: w:t, w:tab, w:br, неразрывный и мягкий дефис."""
    runs = []
    for piece in re.split(r"(‑|­)", text):
        if not piece:
            continue
        r = etree.Element(q("r"))
        if rpr is not None:
            r.append(copy.deepcopy(rpr))
        if piece == "‑":
            etree.SubElement(r, q("noBreakHyphen"))
        elif piece == "­":
            etree.SubElement(r, q("softHyphen"))
        else:
            t = etree.SubElement(r, q("t"))
            t.text = piece
            t.set(XML_SPACE, "preserve")
        runs.append(r)
    return runs


def build_parts(text: str, base_rpr, span_rpr, atoms):
    parts, current = [[]], None
    for tok in TOKEN_RE.split(text):
        if not tok:
            continue
        if TOKEN_RE.fullmatch(tok):
            body = tok[1:-1]
            rpr = span_rpr.get(int(current)) if current else base_rpr
            if body.startswith("@"):
                parts[-1].extend(atoms[int(body[1:]) - 1])
            elif body.startswith("/"):
                current = None
            elif body.isdigit():
                current = body
            elif body in ("br", "tab"):
                r = etree.Element(q("r"))
                if rpr is not None:
                    r.append(copy.deepcopy(rpr))
                etree.SubElement(r, q("br" if body == "br" else "tab"))
                parts[-1].append(r)
            elif body == "¶":
                parts.append([])
            continue
        rpr = span_rpr.get(int(current)) if current else base_rpr
        parts[-1].extend(text_runs(tok, rpr))
    return parts


def apply_edits(doc, recs, edits) -> list[str]:
    plist = paragraphs(doc.element.body)
    errors, ops = [], []
    for pid, text in edits.items():
        rec = recs[pid]
        p = plist[rec["index"]][0]
        if c14n_hash(p) != rec["hash"]:
            errors.append("%s: абзац в документе не совпадает с разобранным" % pid)
            continue
        problems = check_tokens(text, rec)
        if not text.strip() and rec["atoms"]:
            problems.append("удалять нельзя: в абзаце есть объекты")
        if problems:
            errors.append("%s: %s" % (pid, "; ".join(problems)))
            continue
        ops.append((pid, p, text))
    if errors:
        return errors
    for pid, p, text in ops:
        seq, fs, fe, _ = parse_paragraph(p)
        _, base_rpr, span_rpr, atoms = render(seq)
        ppr = p.find(q("pPr"))
        has_sect = ppr is not None and ppr.find(q("sectPr")) is not None
        if not text.strip():
            keep = [f for f in fs + fe if f.get(q("name")) not in ("_GoBack", None)
                    or f.tag not in (q("bookmarkStart"), q("bookmarkEnd"))]
            if has_sect or keep:
                errors.append("%s: удалять нельзя: в абзаце разрыв раздела или закладка" % pid)
                continue
            p.getparent().remove(p)
            continue
        parts = build_parts(text, base_rpr, span_rpr, atoms)
        if len(parts) > 1 and has_sect:
            errors.append("%s: ⟦¶⟧ нельзя в абзаце с разрывом раздела" % pid)
            continue
        for c in list(p):
            if c is not ppr:
                p.remove(c)
        p.extend(fs + parts[0] + fe)
        last = p
        for part in parts[1:]:
            np_ = etree.Element(q("p"))
            if ppr is not None:
                pp = copy.deepcopy(ppr)
                for sp in pp.findall(q("sectPr")):
                    pp.remove(sp)
                np_.append(pp)
            np_.extend(part)
            last.addnext(np_)
            last = np_
    return errors


# ---------------------------------------------------------------- проверка результата

def part_digests(path: Path) -> dict[str, str]:
    out = {}
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            data = z.read(name)
            if name.endswith((".xml", ".rels")):
                try:
                    data = etree.tostring(etree.fromstring(data), method="c14n")
                except etree.XMLSyntaxError:
                    pass
            out[name] = hashlib.sha256(data).hexdigest()
    return out


def stored_text(marked: str, atoms: dict) -> str:
    """Текст, который окажется в w:t абзаца: объекты со своим текстом, без br/tab и дефисов-элементов."""
    def sub(m):
        tok = m.group(1)[1:-1]
        return atoms.get(tok[1:], {}).get("text", "") if tok.startswith("@") else ""
    return TOKEN_RE.sub(sub, marked).replace("‑", "").replace("­", "")


def expected_paragraphs(recs_all, edits):
    """Ожидаемый порядок абзацев результата: (hash или None, текст)."""
    out = []
    for r in recs_all:
        if r["id"] not in edits:
            out.append((r["hash"], None))
            continue
        for part in edits[r["id"]].split(OPEN + "¶" + CLOSE):
            text = stored_text(part, r["atoms"])
            if text.strip():
                out.append((None, text))
    return out


def verify(state, recs, edits, out_path: Path, pdf: bool) -> list[str]:
    errors = []
    src = Path(state["source"])
    if src.exists() and hashlib.sha256(src.read_bytes()).hexdigest() != state["sha256"]:
        errors.append("исходный файл изменился после разбора")
    try:
        doc = Document(str(out_path))
    except Exception as exc:  # noqa: BLE001
        return ["результат не открывается: %s" % exc]
    got = [(c14n_hash(p), all_text(p)) for p, _, _ in paragraphs(doc.element.body) if all_text(p).strip()]
    want = expected_paragraphs(state["paragraphs"], edits)
    if len(got) != len(want):
        errors.append("абзацев с текстом %d, ожидалось %d" % (len(got), len(want)))
    for (gh, gt), (wh, wt) in zip(got, want, strict=False):
        if wh is not None and gh != wh:
            errors.append("изменён абзац, которого нет в правке: «%s…»" % gt[:60])
        if wh is None and " ".join(gt.split()) != " ".join(wt.split()):
            errors.append("текст правленого абзаца не совпал: «%s…»" % gt[:60])
    if src.exists():
        a, b = part_digests(src), part_digests(out_path)
        for name in sorted(set(a) | set(b)):
            if name != "word/document.xml" and a.get(name) != b.get(name):
                errors.append("изменилась часть документа %s" % name)
    if pdf:
        office = shutil.which("soffice") or shutil.which("libreoffice")
        if not office:
            errors.append("LibreOffice не найден, проверка открытием пропущена")
        else:
            with tempfile.TemporaryDirectory() as tmp:
                res = subprocess.run([office, "--headless", "--convert-to", "pdf", "--outdir", tmp,
                                      str(out_path)], capture_output=True, text=True, timeout=180)
                if not list(Path(tmp).glob("*.pdf")):
                    errors.append("LibreOffice не открыл результат: %s" % (res.stderr or res.stdout)[-300:])
    return errors


# ---------------------------------------------------------------- команды

def cmd_extract(a):
    src = Path(a.docx).resolve()
    work = Path(a.workdir)
    work.mkdir(parents=True, exist_ok=True)
    doc = Document(str(src))
    recs = doc_paragraph_records(doc, a.tables)
    state = {"source": str(src), "sha256": hashlib.sha256(src.read_bytes()).hexdigest(),
             "tables": a.tables, "paragraphs": recs}
    (work / "doc.json").write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    n = write_edit(work / "orig.edit.md", recs)
    kinds: dict[str, int] = {}
    for r in recs:
        if not r["editable"]:
            kinds[r["reason"] or r["kind"]] = kinds.get(r["reason"] or r["kind"], 0) + 1
    words = sum(len(r["visible"].split()) for r in recs if r["editable"])
    print("Абзацев для правки: %d (%d слов). Не правятся: %s." % (
        n, words, ", ".join("%s %d" % kv for kv in sorted(kinds.items())) or "нет"))
    print("Правка: %s" % (work / "orig.edit.md"))
    return 0


def cmd_text(a):
    state, recs = load_state(Path(a.workdir))
    edits = edits_against(state, recs, Path(a.edit))
    out = []
    for r in state["paragraphs"]:
        if r["kind"] in ("table", "toc"):
            continue
        if r["id"] in edits:
            body = visible(edits[r["id"]], r["atoms"]).strip()
        elif r["editable"]:
            body = visible(r["marked"], r["atoms"]).strip()
        else:
            body = r["visible"].strip()
        if not body:
            continue
        if r["kind"] == "heading":
            body = "#" * min(r["level"] or 1, 6) + " " + " ".join(body.split())
        out.append(body)
    Path(a.out).write_text("\n\n".join(out) + "\n", encoding="utf-8")
    return 0


def cmd_apply(a):
    state, recs = load_state(Path(a.workdir))
    src, dst = Path(state["source"]), Path(a.out).resolve()
    if dst == src.resolve():
        raise SystemExit("результат нельзя писать поверх исходного файла")
    if hashlib.sha256(src.read_bytes()).hexdigest() != state["sha256"]:
        raise SystemExit("исходный файл изменился после разбора: разберите его заново (extract)")
    edits = edits_against(state, recs, Path(a.edit))
    doc = Document(str(src))
    errors = apply_edits(doc, recs, edits)
    if errors:
        print("Правка не записана, исправьте блоки:", file=sys.stderr)
        for e in errors:
            print("  - " + e, file=sys.stderr)
        return 1
    dst.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(dst))
    deleted = sum(1 for t in edits.values() if not t.strip())
    split = sum(t.count(OPEN + "¶" + CLOSE) for t in edits.values())
    print("Записано: %s. Изменено абзацев: %d, удалено: %d, разбито: %d." % (
        dst, len(edits) - deleted, deleted, split))
    return 0


def cmd_verify(a):
    state, recs = load_state(Path(a.workdir))
    edits = edits_against(state, recs, Path(a.edit))
    errors = verify(state, recs, edits, Path(a.out), a.pdf)
    if errors:
        print("Проверка docx: есть расхождения")
        for e in errors:
            print("  - " + e)
        return 1
    print("Проверка docx: всё вне правленых абзацев на месте, правленые абзацы записаны как в правке"
          + (", LibreOffice открывает файл" if a.pdf else "") + ".")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("extract")
    s.add_argument("docx")
    s.add_argument("workdir")
    s.add_argument("--tables", action="store_true", help="править и текст в таблицах")
    s.set_defaults(fn=cmd_extract)
    s = sub.add_parser("text")
    s.add_argument("workdir")
    s.add_argument("edit")
    s.add_argument("out")
    s.set_defaults(fn=cmd_text)
    s = sub.add_parser("apply")
    s.add_argument("workdir")
    s.add_argument("edit")
    s.add_argument("out")
    s.set_defaults(fn=cmd_apply)
    s = sub.add_parser("verify")
    s.add_argument("workdir")
    s.add_argument("edit")
    s.add_argument("out")
    s.add_argument("--pdf", action="store_true", help="ещё и открыть результат в LibreOffice")
    s.set_defaults(fn=cmd_verify)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
