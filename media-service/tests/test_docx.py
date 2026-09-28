from zipfile import ZipFile

from app.docx import build_transcript_docx


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
