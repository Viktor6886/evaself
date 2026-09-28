"""Минимальный DOCX для расшифровки, принадлежащей человеку.

Ради обёртки простого текста второй стек документов не нужен: модуль пишет
то подмножество OOXML, которое понимают Word, LibreOffice и приём в базу
знаний (mammoth).
"""

from __future__ import annotations

import re
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
"""

_ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>
"""


# Управляющие символы, которых нет в XML 1.0: Word не откроет документ с
# ними, а в распознанном тексте или тексте модели они изредка бывают.
_INVALID_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _paragraph(text: str, *, bold: bool = False, size: int | None = None) -> str:
    text = _INVALID_XML.sub("", text)
    if not text:
        return "<w:p/>"
    properties = []
    if bold:
        properties.append("<w:b/>")
    if size:
        properties.append(f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
    rpr = f"<w:rPr>{''.join(properties)}</w:rPr>" if properties else ""
    return (
        "<w:p><w:r>"
        f'{rpr}<w:t xml:space="preserve">{escape(text)}</w:t>'
        "</w:r></w:p>"
    )


def _run(text: str, *, bold: bool = False, italic: bool = False, size: int | None = None) -> str:
    properties = []
    if bold:
        properties.append("<w:b/>")
    if italic:
        properties.append("<w:i/>")
    if size:
        properties.append(f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
    rpr = f"<w:rPr>{''.join(properties)}</w:rPr>" if properties else ""
    return f'<w:r>{rpr}<w:t xml:space="preserve">{escape(_INVALID_XML.sub("", text))}</w:t></w:r>'


# Реплика диалога из расшифровки: «Голос 2: текст».
_SPEAKER_LINE = re.compile(r"^(Голос \d{1,3}):\s*(.*)$")
# Жирное внутри строки документа: «**важное**».
_BOLD = re.compile(r"\*\*(.+?)\*\*")


def _inline(text: str) -> str:
    """Строка с выделением «**…**» — в последовательность run'ов."""
    runs: list[str] = []
    cursor = 0
    for match in _BOLD.finditer(text):
        if match.start() > cursor:
            runs.append(_run(text[cursor:match.start()]))
        runs.append(_run(match.group(1), bold=True))
        cursor = match.end()
    if cursor < len(text):
        runs.append(_run(text[cursor:]))
    return "".join(runs)


def _body_paragraph(line: str) -> str:
    """Абзац расшифровки: у реплики диалога метка говорящего жирная."""
    speaker = _SPEAKER_LINE.match(line)
    if speaker:
        return f"<w:p>{_run(speaker.group(1) + ': ', bold=True)}{_run(speaker.group(2))}</w:p>"
    return _paragraph(line)


def build_transcript_docx(
    destination: Path,
    *,
    title: str,
    transcript: str,
    source_name: str | None = None,
    language: str | None = None,
    duration_seconds: float | None = None,
) -> Path:
    """Записать корректный редактируемый DOCX: заголовок, сведения о записи, текст."""
    clean_title = title.strip() or "Транскрипция аудиозаписи"
    paragraphs = [_paragraph(clean_title, bold=True, size=32)]

    if source_name:
        paragraphs.append(_paragraph(f"Источник: {source_name.strip()}"))
    if duration_seconds is not None and duration_seconds >= 0:
        minutes = duration_seconds / 60.0
        paragraphs.append(_paragraph(f"Длительность: {minutes:.1f} мин."))
    if language:
        paragraphs.append(_paragraph(f"Язык: {language.strip()}"))
    paragraphs.append(_paragraph(""))

    for line in transcript.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        paragraphs.append(_body_paragraph(line))

    return _write(destination, paragraphs)


def build_text_docx(destination: Path, *, title: str, content: str) -> Path:
    """Документ, который Ева составила сама: тезисы, конспект, переработанная расшифровка.

    Разметка — то немногое, что модель пишет надёжно: «# » и «## » —
    заголовки, «- » и «* » — пункты, «1. » — нумерованные пункты,
    «**…**» — выделение, пустая строка — граница абзацев. Остальное
    остаётся текстом как есть.
    """
    paragraphs = [_paragraph(title.strip() or "Документ", bold=True, size=32), _paragraph("")]
    for raw in content.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.rstrip()
        stripped = line.lstrip()
        heading = re.match(r"^(#{1,3})\s+(.*)$", stripped)
        bullet = re.match(r"^[-*•]\s+(.*)$", stripped)
        numbered = re.match(r"^(\d{1,3})[.)]\s+(.*)$", stripped)
        if heading:
            size = {1: 28, 2: 26, 3: 24}[len(heading.group(1))]
            paragraphs.append(f"<w:p>{_run(heading.group(2).replace('**', ''), bold=True, size=size)}</w:p>")
        elif bullet:
            indent = 360 + 360 * min(3, (len(line) - len(stripped)) // 2)
            paragraphs.append(
                f'<w:p><w:pPr><w:ind w:left="{indent}" w:hanging="240"/></w:pPr>'
                f"{_run('• ')}{_inline(bullet.group(1))}</w:p>"
            )
        elif numbered:
            paragraphs.append(
                '<w:p><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr>'
                f"{_run(numbered.group(1) + '. ')}{_inline(numbered.group(2))}</w:p>"
            )
        elif _SPEAKER_LINE.match(stripped):
            paragraphs.append(_body_paragraph(stripped))
        elif stripped:
            paragraphs.append(f"<w:p>{_inline(stripped)}</w:p>")
        else:
            paragraphs.append("<w:p/>")
    return _write(destination, paragraphs)


def _write(destination: Path, paragraphs: list[str]) -> Path:
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>"
        + "".join(paragraphs)
        + (
            '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
            '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" '
            'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
        )
        + "</w:body></w:document>"
    )

    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _CONTENT_TYPES)
        archive.writestr("_rels/.rels", _ROOT_RELS)
        archive.writestr("word/document.xml", document)
    return destination
