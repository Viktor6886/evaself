from zipfile import ZipFile

from app.docx import build_text_docx, build_transcript_docx


def test_transcript_docx_is_valid_ooxml_and_keeps_text(tmp_path):
    target = tmp_path / "transcript.docx"
    build_transcript_docx(
        target,
        title="Транскрипция встречи",
        transcript='Первая строка\nВторая <строка> & "кавычки"',
        source_name="meeting.mp3",
        language="ru",
        duration_seconds=90,
    )

    with ZipFile(target) as archive:
        assert {"[Content_Types].xml", "_rels/.rels", "word/document.xml"} <= set(
            archive.namelist()
        )
        xml = archive.read("word/document.xml").decode("utf-8")

    assert "Транскрипция встречи" in xml
    assert "meeting.mp3" in xml
    assert "1.5 мин." in xml
    assert "Первая строка" in xml
    assert "Вторая &lt;строка&gt; &amp;" in xml


def _xml(path):
    with ZipFile(path) as archive:
        return archive.read("word/document.xml").decode("utf-8")


def test_dialogue_labels_are_bold(tmp_path):
    target = build_transcript_docx(
        tmp_path / "t.docx", title="Встреча", transcript="Голос 1: Добрый день.\n\nГолос 2: Здравствуйте.",
    )
    xml = _xml(target)
    assert '<w:b/></w:rPr><w:t xml:space="preserve">Голос 1: </w:t>' in xml
    assert "Добрый день." in xml


def test_eva_document_renders_headings_bullets_and_bold(tmp_path):
    target = build_text_docx(
        tmp_path / "d.docx",
        title="Тезисы встречи",
        content="# Главное\n- Первый **важный** тезис\n1. Шаг\nОбычный абзац\u0007",
    )
    xml = _xml(target)
    assert "Тезисы встречи" in xml
    assert '<w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve">Главное</w:t>' in xml
    assert "• " in xml and "Первый " in xml
    assert '<w:b/></w:rPr><w:t xml:space="preserve">важный</w:t>' in xml
    assert "1. " in xml and "Шаг" in xml
    # Управляющий символ выброшен: с ним Word не открыл бы файл.
    assert "\u0007" not in xml and "Обычный абзац" in xml
