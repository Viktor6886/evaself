"""Minimal DOCX writer for user-owned transcripts.

The media service should not need a second document stack only to wrap plain
text. This module writes the small OOXML subset that Word, LibreOffice and the
existing mammoth-based knowledge ingestor understand.
"""

from __future__ import annotations

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


def _paragraph(text: str, *, bold: bool = False, size: int | None = None) -> str:
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


def build_transcript_docx(
    destination: Path,
    *,
    title: str,
    transcript: str,
    source_name: str | None = None,
    language: str | None = None,
    duration_seconds: float | None = None,
) -> Path:
    """Write a valid, editable DOCX containing transcript text and metadata."""
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
        paragraphs.append(_paragraph(line))

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
