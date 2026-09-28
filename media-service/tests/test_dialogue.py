"""Голоса через всю запись: сшивка частей по перекрытию."""

from types import SimpleNamespace

from app.dialogue import (
    Part,
    dialogue_text,
    layout,
    overlap_seconds,
    plain_text,
    stitch,
    turns_of,
    wants_speakers,
)
from app.stt.types import SttResult, SttSegment, SttWord


def _result(text: str, segments=(), words=()) -> SttResult:
    return SttResult(
        text=text, provider="deepgram", model="nova-3", latency_ms=1,
        segments=list(segments), words=list(words),
    )


def _segment(speaker: str, start: float, end: float, text: str) -> SttSegment:
    return SttSegment(text=text, start_ms=round(start * 1000), end_ms=round(end * 1000), speaker=speaker)


def _parts(*results: SttResult, part_seconds: float = 20, overlap: float = 4) -> list[Part]:
    return [
        Part(result=result, offset_ms=offset, keep_from_ms=keep_from, keep_until_ms=keep_until, overlap=shared)
        for result, (offset, keep_from, keep_until, shared)
        in zip(results, layout(len(results), part_seconds, overlap), strict=True)
    ]


def test_layout_splits_overlap_in_the_middle():
    assert layout(3, 20, 4) == [
        (0, 0, 18_000, None),
        (16_000, 18_000, 34_000, (16_000, 20_000)),
        (32_000, 34_000, None, (32_000, 36_000)),
    ]
    assert overlap_seconds(600) == 10
    assert overlap_seconds(55) == 55 / 6


def test_speakers_keep_their_numbers_across_parts():
    # Во второй части провайдер назвал голоса наоборот: «speaker_0» там —
    # тот, кто в первой был «speaker_1». Перекрытие 16–20 с это выдаёт.
    first = _result("a b c", [
        _segment("speaker_0", 0, 8, "Здравствуйте, начнём."),
        _segment("speaker_1", 9, 15, "Да, давайте."),
        _segment("speaker_0", 16.5, 19.5, "Первый вопрос такой."),
    ])
    second = _result("d e", [
        _segment("speaker_1", 0.5, 3.5, "Первый вопрос такой."),
        _segment("speaker_0", 5, 12, "Отвечу коротко."),
    ])
    turns = stitch(_parts(first, second))
    assert turns is not None
    assert dialogue_text(turns) == (
        "Голос 1: Здравствуйте, начнём.\n\n"
        "Голос 2: Да, давайте.\n\n"
        "Голос 1: Первый вопрос такой.\n\n"
        "Голос 2: Отвечу коротко."
    )


def test_no_dialogue_without_speaker_labels_or_with_one_voice():
    labelled = _result("x", [_segment("speaker_0", 0, 5, "Один голос.")])
    unlabelled = _result("y", [SttSegment(text="без метки", start_ms=0, end_ms=500)])
    assert stitch(_parts(labelled, unlabelled)) is None
    assert stitch(_parts(labelled)) is None


def test_turns_are_built_from_words_when_segments_have_no_speaker():
    result = _result("Да нет", words=[
        SttWord("Да,", 0, 300, speaker="speaker_1"),
        SttWord("конечно.", 300, 700, speaker="speaker_1"),
        SttWord("Нет.", 900, 1200, speaker="speaker_2"),
    ])
    turns = turns_of(result)
    assert [(turn.speaker, turn.text) for turn in turns] == [
        ("speaker_1", "Да, конечно."),
        ("speaker_2", "Нет."),
    ]


def test_plain_text_drops_the_repeated_overlap():
    first = _result("раз два", words=[SttWord("раз", 1000, 1500), SttWord("два", 17_000, 17_500)])
    second = _result("два три", words=[SttWord("два", 1000, 1500), SttWord("три", 5000, 5500)])
    parts = _parts(first, second)
    assert [plain_text(part) for part in parts] == ["раз два", "три"]


def test_wants_speakers_reads_either_parameter_name():
    assert wants_speakers([SimpleNamespace(params={"diarize": True})])
    assert wants_speakers([SimpleNamespace(params={}), SimpleNamespace(params={"diarization": True})])
    assert not wants_speakers([SimpleNamespace(params={"diarize": False})])


def test_a_voice_new_to_the_recording_gets_a_new_number():
    first = _result("a", [
        _segment("speaker_0", 0, 8, "Начнём."),
        _segment("speaker_1", 16.5, 19.5, "Согласен."),
    ])
    second = _result("b", [
        _segment("speaker_0", 0.5, 3.5, "Согласен."),
        _segment("speaker_1", 5, 7, "Я продолжу."),
        _segment("speaker_2", 8, 12, "А можно я?"),
    ])
    turns = stitch(_parts(first, second))
    assert [turn.speaker for turn in turns or []] == ["Голос 1", "Голос 2", "Голос 1", "Голос 3"]
