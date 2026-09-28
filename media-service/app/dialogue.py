"""Реплики по говорящим через всю запись: «Голос 1», «Голос 2», …

Длинная запись распознаётся частями (не больше 20 МБ каждая), и провайдер
нумерует говорящих в каждой части заново: «speaker_0» второй части — не
обязательно тот же человек, что в первой. Поэтому части режутся с
перекрытием в несколько секунд, и на общем отрезке голос новой части
сопоставляется с голосом предыдущей по тому, как долго они звучат
одновременно. Граница между частями проходит посередине перекрытия: каждая
реплика попадает в текст один раз.

Всё здесь — чистые функции над результатами распознавания. Если хотя бы у
одной части с текстом нет меток говорящих (например, ответил резервный
провайдер без разделения голосов), диалог не собирается: лучше обычный
текст, чем выдуманная разметка.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from .stt.types import SttResolvedConfig, SttResult

SPEAKER_LABEL = "Голос"

# Перекрытие частей для сшивки голосов. Десяти секунд хватает, чтобы на
# общем отрезке прозвучала хотя бы одна реплика, и это меньше 2 % стоимости
# при частях по 480–600 секунд.
MAX_OVERLAP_SECONDS = 10.0


@dataclass
class Turn:
    speaker: str
    start_ms: int
    end_ms: int
    text: str


@dataclass
class Part:
    """Результат распознавания части и её место в записи."""

    result: SttResult
    offset_ms: int
    # Где начинается и кончается доля этой части в итоговом тексте, в
    # миллисекундах от начала всей записи. `None` — до конца записи.
    keep_from_ms: int = 0
    keep_until_ms: int | None = None
    # Общий с предыдущей частью отрезок, от начала всей записи.
    overlap: tuple[int, int] | None = None
    turns: list[Turn] = field(default_factory=list)


def wants_speakers(chain: list[SttResolvedConfig]) -> bool:
    """Включено ли разделение говорящих у кого-нибудь в цепочке маршрута."""
    return any(bool(config.params.get("diarize") or config.params.get("diarization")) for config in chain)


def overlap_seconds(part_seconds: float) -> float:
    """Перекрытие для части заданной длины: не больше шестой её доли."""
    return min(MAX_OVERLAP_SECONDS, part_seconds / 6.0)


Placement = tuple[int, int, int | None, tuple[int, int] | None]


def layout(count: int, part_seconds: float, overlap: float) -> list[Placement]:
    """Смещение, доля и перекрытие каждой части, в миллисекундах.

    Часть i начинается в i·(P − O) и длится P; с предыдущей она делит
    отрезок длиной O, и граница долей проходит посередине него.
    """
    step_ms = round((part_seconds - overlap) * 1000)
    overlap_ms = round(overlap * 1000)
    rows: list[Placement] = []
    for index in range(count):
        offset = index * step_ms
        keep_from = 0 if index == 0 else offset + overlap_ms // 2
        keep_until = None if index == count - 1 else (index + 1) * step_ms + overlap_ms // 2
        shared = None if index == 0 or overlap_ms == 0 else (offset, offset + overlap_ms)
        rows.append((offset, keep_from, keep_until, shared))
    return rows


def turns_of(result: SttResult) -> list[Turn]:
    """Реплики части: готовые у провайдера или собранные из слов."""
    segments = [
        segment for segment in result.segments
        if segment.speaker and segment.text.strip()
        and segment.start_ms is not None and segment.end_ms is not None
    ]
    if segments:
        return [
            Turn(segment.speaker or "", segment.start_ms or 0, segment.end_ms or 0, segment.text.strip())
            for segment in segments
        ]
    turns: list[Turn] = []
    for word in result.words:
        text = word.text.strip()
        if not word.speaker or not text or word.start_ms is None or word.end_ms is None:
            continue
        if turns and turns[-1].speaker == word.speaker:
            turns[-1].end_ms = max(turns[-1].end_ms, word.end_ms)
            turns[-1].text += " " + text
        else:
            turns.append(Turn(word.speaker, word.start_ms, word.end_ms, text))
    return turns


def _midpoint(turn: Turn) -> int:
    return (turn.start_ms + turn.end_ms) // 2


def _inside(point: int, part: Part) -> bool:
    return point >= part.keep_from_ms and (part.keep_until_ms is None or point < part.keep_until_ms)


def stitch(parts: list[Part]) -> list[Turn] | None:
    """Реплики всей записи с голосами, согласованными между частями.

    `None`, если диалога нет: у части с текстом нет меток говорящих, или
    на всю запись звучит один голос — тогда «Голос 1:» перед каждым
    абзацем ничего не сообщает.
    """
    for part in parts:
        part.turns = turns_of(part.result)
        if part.result.text.strip() and not part.turns:
            return None

    next_id = 1
    previous: list[Turn] = []
    previous_mapping: dict[str, int] = {}
    kept: list[Turn] = []
    for part in parts:
        absolute = [
            Turn(turn.speaker, turn.start_ms + part.offset_ms, turn.end_ms + part.offset_ms, turn.text)
            for turn in part.turns
        ]
        mapping: dict[str, int] = {}
        if part.overlap is not None and previous:
            low, high = part.overlap
            scores: dict[tuple[str, int], int] = defaultdict(int)
            for turn in absolute:
                for earlier in previous:
                    start = max(turn.start_ms, earlier.start_ms, low)
                    end = min(turn.end_ms, earlier.end_ms, high)
                    if end > start:
                        scores[(turn.speaker, int(earlier.speaker))] += end - start
            for (local, known), _ in sorted(scores.items(), key=lambda item: -item[1]):
                if local in mapping or known in mapping.values():
                    continue
                mapping[local] = known
        # Голоса, которые на общем отрезке не прозвучали, свидетельства не
        # имеют. Состав участников записи обычно постоянен, поэтому такой
        # голос сначала получает ту же метку провайдера, что в прошлой
        # части, затем — свободный голос прошлой части, и только потом —
        # новый номер. Иначе каждая часть добавляла бы «Голос 3», «Голос 4».
        free = [int(turn.speaker) for turn in previous]
        for turn in absolute:
            if turn.speaker in mapping:
                continue
            taken = set(mapping.values())
            same = previous_mapping.get(turn.speaker)
            spare = next((known for known in free if known not in taken), None)
            if same is not None and same not in taken:
                mapping[turn.speaker] = same
            elif spare is not None:
                mapping[turn.speaker] = spare
            else:
                mapping[turn.speaker] = next_id
                next_id += 1
        for turn in absolute:
            turn.speaker = str(mapping[turn.speaker])
            if _inside(_midpoint(turn), part):
                kept.append(turn)
        previous = absolute
        previous_mapping = mapping

    if len({turn.speaker for turn in kept}) < 2:
        return None

    # Номера — по первому появлению в итоговом тексте: «Голос 1» говорит
    # первым, а не первым попал в сопоставление.
    order: dict[str, int] = {}
    merged: list[Turn] = []
    for turn in kept:
        order.setdefault(turn.speaker, len(order) + 1)
        label = f"{SPEAKER_LABEL} {order[turn.speaker]}"
        if merged and merged[-1].speaker == label:
            merged[-1].end_ms = turn.end_ms
            merged[-1].text += " " + turn.text
        else:
            merged.append(Turn(label, turn.start_ms, turn.end_ms, turn.text))
    return merged


def dialogue_text(turns: list[Turn]) -> str:
    return "\n\n".join(f"{turn.speaker}: {turn.text}" for turn in turns)


def plain_text(part: Part) -> str:
    """Доля части в обычном тексте, без повтора перекрытия.

    Режется по меткам времени слов или сегментов. Если их нет, часть
    отдаёт весь свой текст: несколько повторённых секунд лучше потерянных.
    """
    result = part.result
    offset = part.offset_ms
    words = [word for word in result.words if word.start_ms is not None and word.end_ms is not None]
    if words:
        return " ".join(
            word.text.strip() for word in words
            if word.text.strip()
            and _inside(offset + ((word.start_ms or 0) + (word.end_ms or 0)) // 2, part)
        ).strip()
    segments = [
        segment for segment in result.segments
        if segment.start_ms is not None and segment.end_ms is not None
    ]
    if segments:
        return " ".join(
            segment.text.strip() for segment in segments
            if segment.text.strip()
            and _inside(offset + ((segment.start_ms or 0) + (segment.end_ms or 0)) // 2, part)
        ).strip()
    return result.text.strip()
