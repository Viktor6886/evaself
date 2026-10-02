import assert from "node:assert/strict";
import test from "node:test";

import {
  assemblePassages,
  citeOf,
  diversify,
  fuseRankedLists,
  KNOWLEDGE_RESULT_CHARS,
  overlapLength,
  pagesOf,
  sectionPathOf,
  trigramTerms,
} from "../dist/knowledge/search-fusion.js";

test("RRF: найденное несколькими способами выше найденного одним, равные — по id", () => {
  const fused = fuseRankedLists([
    { signal: "vector", ids: ["7", "3", "9"], scores: new Map([["7", 0.91], ["3", 0.8], ["9", 0.7]]) },
    { signal: "fts", ids: ["3", "12"] },
    { signal: "trgm", ids: ["3"] },
  ]);
  assert.deepEqual(fused.map((item) => item.id), ["3", "7", "12", "9"]);
  assert.deepEqual(fused[0]!.ranks, { vector: 2, fts: 1, trgm: 1 });
  assert.equal(fused[0]!.rrf, 1 / 62 + 1 / 61 + 1 / 61);
  assert.equal(fused[1]!.scores.vector, 0.91);
  // Ранги, а не оценки: близость 0,91 не перевешивает три совпадения.
  assert.ok(fused[0]!.rrf > fused[1]!.rrf);
  // Повтор id внутри одного списка не удваивает его вклад.
  const repeated = fuseRankedLists([{ signal: "fts", ids: ["1", "1"] }]);
  assert.equal(repeated[0]!.rrf, 1 / 61);
});

test("разнообразие: дубли текста — один раз, из документа — не больше трёх, пока есть другие", () => {
  const item = (id: string, documentId: string, contentHash = id) => ({ id, documentId, contentHash });
  const chosen = diversify([
    item("a1", "A"), item("a2", "A"), item("dup", "B", "a1"), item("a3", "A"), item("a4", "A"),
    item("b1", "B"), item("c1", "C"),
  ], 5);
  assert.deepEqual(chosen.map((entry) => entry.id), ["a1", "a2", "a3", "b1", "c1"]);
  // Других документов нет — лишние из того же встают в конец, а не пропадают.
  const single = diversify([item("a1", "A"), item("a2", "A"), item("a3", "A"), item("a4", "A")], 4);
  assert.deepEqual(single.map((entry) => entry.id), ["a1", "a2", "a3", "a4"]);
});

test("перекрытие соседних фрагментов находится и не повторяется", () => {
  const previous = "Первый абзац о сроках. Оплата вносится до десятого числа каждого месяца.";
  const next = "Оплата вносится до десятого числа каждого месяца. Штраф — один процент в день.";
  assert.equal(overlapLength(previous, next), "Оплата вносится до десятого числа каждого месяца.".length);
  assert.equal(overlapLength("совсем другой текст", "ничего общего здесь нет"), 0);
});

test("ответ собирается в бюджете: найденные целиком, последний укорачивается, соседи — из остатка", () => {
  const hit = (ordinal: number, length: number, documentId = "D") => ({ documentId, ordinal, content: "х".repeat(length) });
  // Четыре фрагмента по 1400 знаков в 5000 не помещаются: четвёртый
  // укорочен, пятый не попадает вовсе.
  const passages = assemblePassages([hit(1, 1_400), hit(5, 1_400), hit(9, 1_400), hit(13, 1_400), hit(17, 1_400)], [], { depth: 1 });
  assert.equal(KNOWLEDGE_RESULT_CHARS, 5_000);
  assert.equal(passages.length, 4);
  assert.equal(passages[3]!.truncated, true);
  assert.equal(passages.reduce((sum, passage) => sum + passage.content.length, 0), KNOWLEDGE_RESULT_CHARS);
  // Источник и раздел уходят модели вместе с текстом и входят в бюджет.
  const withSource = assemblePassages([hit(1, 1_400), hit(5, 1_400), hit(9, 1_400)], [], { budget: 2_900, depth: 0, overhead: () => 100 });
  assert.equal(withSource.length, 2);
  assert.equal(withSource[1]!.truncated, true);
  assert.equal(withSource.reduce((sum, passage) => sum + passage.content.length + 100, 0), 2_900);
  // Остаток меньше 400 знаков — обрывок не добавляется.
  const tight = assemblePassages([hit(1, 1_000), hit(3, 1_000)], [], { budget: 1_300, depth: 0 });
  assert.equal(tight.length, 1);
});

test("соседние фрагменты: без перекрытия, без повтора найденного, дальний — только за ближним", () => {
  const hits = [
    { documentId: "D", ordinal: 5, content: "Найденное: штраф один процент в день." },
    { documentId: "D", ordinal: 6, content: "Тоже найдено: расторжение через месяц." },
  ];
  const neighbors = [
    { documentId: "D", ordinal: 4, content: "Раньше: оплата до десятого числа. Найденное: штраф один процент в день." },
    { documentId: "D", ordinal: 6, content: hits[1]!.content },
    { documentId: "D", ordinal: 7, content: "Тоже найдено: расторжение через месяц. Потом: возврат залога." },
    { documentId: "D", ordinal: 2, content: "Дальний без ближнего: ordinal 3 нет." },
  ];
  const passages = assemblePassages(hits, neighbors, { depth: 2 });
  assert.equal(passages[0]!.before, "Раньше: оплата до десятого числа.");
  // Сосед 6 сам найден — к фрагменту 5 он не приклеивается повтором.
  assert.equal(passages[0]!.after, undefined);
  assert.equal(passages[1]!.after, "Потом: возврат залога.");
  assert.ok(!JSON.stringify(passages).includes("Дальний без ближнего"));
});

test("источник: документ, страницы, путь разделов без повторов", () => {
  const source = { documentName: "Договор.pdf", pageStart: 12, pageEnd: 13, section: "2. Оплата", subsection: "2.1 Штрафы", heading: "2.1 Штрафы" };
  assert.equal(pagesOf(source), "12–13");
  assert.equal(pagesOf({ pageStart: 4, pageEnd: 4 }), "4");
  assert.equal(pagesOf({ pageStart: null, pageEnd: null }), null);
  assert.equal(sectionPathOf(source), "2. Оплата › 2.1 Штрафы");
  assert.equal(citeOf(source), "Договор.pdf, с. 12–13, раздел «2. Оплата › 2.1 Штрафы»");
  assert.equal(citeOf({ documentName: "Заметки.md", pageStart: null, pageEnd: null, section: null, subsection: null, heading: null }), "Заметки.md");
});

test("триграммы: обозначения, номера и фамилии из длинного вопроса; короткий — целиком", () => {
  assert.deepEqual(
    trigramTerms("Где в документах сказано про станцию Р-168-5УН и что Иванов писал по договору 2027?"),
    ["Р-168-5УН", "Иванов", "2027"],
  );
  assert.deepEqual(trigramTerms("какие сроки оплаты по договору аренды квартиры"), []);
  assert.deepEqual(trigramTerms("догавор аренды"), ["догавор", "аренды"]);
  assert.deepEqual(trigramTerms("АБ-12/3 ГОСТ"), ["АБ-12/3", "ГОСТ"]);
  assert.equal(trigramTerms("a1 b2 c3 d4 e5 f6").length, 4);
});
