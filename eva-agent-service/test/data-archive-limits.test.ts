/**
 * Пределы разбора и записи архива (docs/data-archive.md): что присланный
 * файл может заставить сервис прочитать и посчитать. Каждый случай здесь —
 * способ, которым один файл занимал процессор сервиса секундами и
 * минутами. Меряется процессорное время, а не часы: соседи по CI на него
 * не влияют.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanJson, jsonValue, stringList } from "../dist/archive/format.js";
import { applyArchive } from "../dist/archive/import-apply.js";
import { repeatsTooOften } from "../dist/archive/import-goals.js";
import { ARCHIVE_ROW_LIMIT, parseArchive } from "../dist/archive/import-parse.js";
import { ArchiveRejected } from "../dist/archive/import-types.js";

const ZONE = "Europe/Moscow";
const NOW = new Date("2026-10-07T12:00:00.000Z");

type Cell = string | number | boolean | null;
const book = (...sheets: Array<{ name: string; rows: Cell[][] }>) => ({ date1904: false, sheets });

async function cpuMs(run: () => unknown): Promise<number> {
  const before = process.cpuUsage();
  await run();
  const spent = process.cpuUsage(before);
  return (spent.user + spent.system) / 1000;
}

/** Отказ всему файлу; любой другой исход — провал теста. */
async function rejection(run: () => Promise<unknown>): Promise<ArchiveRejected> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ArchiveRejected) return error;
    throw error;
  }
  return assert.fail("файл не отвергнут");
}

/** База для предпросмотра: пустая или с заданными строками, записи не принимает. */
function readOnlyDb(rows: (sql: string) => unknown[] = () => []) {
  return {
    async query(sql: string) {
      if (/^\s*(INSERT|UPDATE|DELETE)/iu.test(sql)) throw new Error(`предпросмотр пишет: ${sql.slice(0, 60)}`);
      return { rows: rows(sql.replace(/\s+/gu, " ").trim()) };
    },
  };
}

const preview = async (parsed: ReturnType<typeof parseArchive>, rows?: (sql: string) => unknown[]) =>
  await applyArchive(readOnlyDb(rows) as never, { userId: 7, parsed, now: NOW, mode: "preview" });

test("разбор: одна длинная строка в тысяче ячеек — отказ по бюджету текста, без прохода по каждой", async () => {
  // Excel хранит одинаковый текст один раз: в файле это килобайты, а
  // прежний разбор чистил два мегабайта в каждой ячейке — минута процессора.
  const huge = "а".repeat(2_000_000);
  const notes = [["Заголовок", "Текст"], ...Array.from({ length: 1_000 }, (_, index) => [`Заметка ${index}`, huge])];
  let error: ArchiveRejected | null = null;
  const spent = await cpuMs(async () => {
    error = await rejection(() => parseArchive(book({ name: "Заметки", rows: notes }), { zone: ZONE }));
  });
  assert.match(error!.message, /слишком много текста/);
  assert.ok(spent < 1_000, `${Math.round(spent)} мс процессора`);
});

test("разбор: строка в пределах поля, но в тысячах ячеек — тоже отказ, и быстро", async () => {
  const long = "б".repeat(150_000);
  const notes = [["Заголовок", "Текст"], ...Array.from({ length: 2_000 }, (_, index) => [`Заметка ${index}`, long])];
  let error: ArchiveRejected | null = null;
  const spent = await cpuMs(async () => {
    error = await rejection(() => parseArchive(book({ name: "Заметки", rows: notes }), { zone: ZONE }));
  });
  assert.match(error!.message, /слишком много текста/);
  assert.ok(spent < 1_500, `${Math.round(spent)} мс процессора`);
});

test("разбор: значение из продолжений длиннее миллиона знаков не склеивается — ошибка строки", async () => {
  const part = "в".repeat(600_000);
  const parsed = await parseArchive(book(
    { name: "Профиль", rows: [["Поле", "Значение"], ["Город", part, part], ["Имя", "Аня"]] },
    { name: "Заметки", rows: [["Заголовок", "Текст", "Текст (продолжение 1)"], ["Длинная", part, part], ["Короткая", "текст", null]] },
  ), { zone: ZONE });
  assert.deepEqual(parsed.profile, { first_name: "Аня" });
  assert.deepEqual(parsed.notes.map((item) => item.value.title), ["Короткая"]);
  const errors = parsed.errors.map((item) => `${item.sheet}:${item.row}:${item.message}`);
  assert.ok(errors.includes("Профиль:2:длиннее 1000000 знаков"), errors.join("; "));
  assert.ok(errors.some((item) => item.startsWith("Заметки:2:") && item.includes("1000000")), errors.join("; "));
});

test("разбор: строки с ошибками считаются в предел записей и не собирают стек", async () => {
  // Четыре листа по 7 500 строк с неверной датой — больше предела файла.
  const broken = (header: string[]) => [header, ...Array.from({ length: 7_501 }, (_, index) => [`не дата ${index}`, "x", "x", "x"])];
  const sheets = [
    { name: "Самочувствие", rows: broken(["Дата", "Настроение", "Энергия (1–10)", "Напряжение (1–10)"]) },
    { name: "Дневник", rows: broken(["Дата", "Запись"]) },
    { name: "Бюджет", rows: broken(["Дата", "Сумма"]) },
    { name: "Задачи и напоминания", rows: broken(["Срок", "Название"]) },
  ];
  let error: ArchiveRejected | null = null;
  const spent = await cpuMs(async () => {
    error = await rejection(() => parseArchive(book(...sheets), { zone: ZONE }));
  });
  assert.match(error!.message, new RegExp(`больше ${ARCHIVE_ROW_LIMIT} записей`));
  assert.ok(spent < 2_000, `${Math.round(spent)} мс процессора на ${4 * 7_501} строк с ошибками`);
  // Ровно у предела — разбор проходит, а ошибки названы с номерами строк.
  const parsed = await parseArchive(book(sheets[0]!), { zone: ZONE });
  assert.equal(parsed.errors.length, 7_501);
  assert.equal(parsed.errors[0]!.row, 2);
});

test("разбор: упоминания людей в дневнике считаются в предел записей", async () => {
  const people = Array.from({ length: 20 }, (_, index) => `Человек ${index}`).join("\n");
  const entries = [["Дата", "Запись", "Люди"], ...Array.from({ length: 1_500 }, (_, index) => ["01.10.2026", `запись ${index}`, people])];
  const error = await rejection(() => parseArchive(book({ name: "Дневник", rows: entries }), { zone: ZONE }));
  assert.match(error.message, /записей/);
});

test("cron: частота повтора — по полям минут и часов, без перебора срабатываний", () => {
  for (const cron of ["* * * * *", "*/5 * * * *", "0,10 9 * * *", "55,5 9,10 * * *", "50,0 23,0 * * *"]) {
    assert.equal(repeatsTooOften(cron), true, cron);
  }
  for (const cron of ["0 9 * * *", "0,30 * * * *", "55,5 9 * * *", "0 0 1 1 *", "*/15 * * * *", "0 * * * *"]) {
    assert.equal(repeatsTooOften(cron), false, cron);
  }
});

test("задачи: разных повторов в файле не больше 50, одинаковые проверяются один раз", async () => {
  const header = ["Название", "Повтор (cron)", "Повторять"];
  // «Раз в год» — самый дорогой для поиска следующего срабатывания.
  const distinct = Array.from({ length: 1_000 }, (_, index) =>
    [`Годовщина ${index}`, `${index % 60} ${Math.floor(index / 60) % 24} ${1 + (index % 28)} ${1 + (index % 12)} *`, "да"]);
  const parsed = await parseArchive(book({ name: "Задачи и напоминания", rows: [header, ...distinct] }), { zone: ZONE });
  let report: Awaited<ReturnType<typeof preview>> | null = null;
  const spent = await cpuMs(async () => {
    report = await preview(parsed);
  });
  assert.equal(report!.sheets.find((item) => item.id === "tasks")?.added, 50);
  assert.equal(report!.error_count, 950);
  assert.match(report!.errors[0]!.message, /больше 50 разных повторов/);
  assert.ok(spent < 2_000, `${Math.round(spent)} мс процессора`);

  const same = Array.from({ length: 1_000 }, (_, index) => [`Годовщина ${index}`, "0 9 1 1 *", "да"]);
  const sameParsed = await parseArchive(book({ name: "Задачи и напоминания", rows: [header, ...same] }), { zone: ZONE });
  let sameReport: Awaited<ReturnType<typeof preview>> | null = null;
  const sameSpent = await cpuMs(async () => {
    sameReport = await preview(sameParsed);
  });
  assert.equal(sameReport!.sheets.find((item) => item.id === "tasks")?.added, 1_000);
  assert.ok(sameSpent < 1_000, `${Math.round(sameSpent)} мс процессора`);
});

test("цели: цепочка «потомок раньше родителя» упорядочивается за один проход", async () => {
  const count = 10_000;
  // Цель i входит в цель i + 1: каждый потомок стоит раньше родителя.
  const chain = Array.from({ length: count }, (_, index) => [`Ц${index}`, index + 1 < count ? `Ц${index + 1}` : null, `Цель ${index}`]);
  const parsed = await parseArchive(book({ name: "Цели", rows: [["Ключ", "Входит в цель", "Название"], ...chain] }), { zone: ZONE });
  let report: Awaited<ReturnType<typeof preview>> | null = null;
  const spent = await cpuMs(async () => {
    report = await preview(parsed);
  });
  assert.equal(report!.added_total, count);
  assert.equal(report!.warnings.some((item) => item.includes("родительская цель не найдена")), false);
  assert.ok(spent < 1_500, `${Math.round(spent)} мс процессора`);

  // Цикл — без родителя и с предупреждением, а не бесконечный обход.
  const cycle = await parseArchive(book({ name: "Цели", rows: [["Ключ", "Входит в цель", "Название"], ["Ц1", "Ц2", "А"], ["Ц2", "Ц1", "Б"]] }), { zone: ZONE });
  const cycleReport = await preview(cycle);
  assert.equal(cycleReport.added_total, 2);
  assert.ok(cycleReport.warnings.some((item) => item.includes("родительская цель не найдена")), cycleReport.warnings.join("; "));
});

test("задачи: время ночи перевода часов вперёд сравнивается так, как его хранит база", async () => {
  // 02:30 8 марта 2026 в Нью-Йорке не было: база хранит такую задачу как 03:30.
  const parsed = await parseArchive(book({ name: "Задачи и напоминания", rows: [["Название", "Напомнить"], ["Весенний звонок", "2026-03-08T02:30"]] }), { zone: "America/New_York" });
  const report = await preview(parsed, (sql) => sql.startsWith("SELECT title, due_at, remind_at, cron_expression FROM tasks")
    ? [{ title: "Весенний звонок", due_at: null, remind_at: new Date("2026-03-08T07:30:00Z"), cron_expression: null }]
    : []);
  const tasks = report.sheets.find((item) => item.id === "tasks");
  assert.deepEqual([tasks?.added, tasks?.existing], [0, 1]);
});

test("JSON из файла: \\u0000, половина суррогатной пары и глубокая вложенность не доходят до записи", () => {
  assert.deepEqual(jsonValue('["x\\u0000y", "\\ud800z"]', "Критерии"), ["xy", "�z"]);
  assert.deepEqual(stringList('["a\\u0001b", "c"]', 10, 100, "Варианты"), ["ab", "c"]);
  assert.deepEqual(cleanJson({ "к\u0000": ["\udc00"] }), { к: ["�"] });
  // Половина пары из экранирования Excel `_xD800_` — в построчном списке тоже.
  assert.deepEqual(stringList("вариант \ud800\nдругой", 10, 100, "Варианты"), ["вариант \ufffd", "другой"]);
  assert.throws(() => jsonValue(`${"[".repeat(40)}${"]".repeat(40)}`, "Ограничения"), /вложенность/);
});

test("разбор: неразборчивая справка «О файле» — файл как чужая таблица, а не сбой", async () => {
  const parsed = await parseArchive(book(
    { name: "О файле", rows: [["Поле", "Значение"], ["Формат", "ф".repeat(5_000)], ["Часовой пояс времени в файле", "п".repeat(5_000)]] },
    { name: "Заметки", rows: [["Заголовок", "Текст"], ["Заметка", "текст"]] },
  ), { zone: ZONE });
  assert.equal(parsed.recognized, false);
  assert.equal(parsed.zone, ZONE);
  assert.equal(parsed.notes.length, 1);
});

test("JSON: одна строка-список из десятков тысяч объектов в сотнях ячеек — отказ до разбора, быстро", async () => {
  // В файле 6 КБ, а прежний разбор создавал миллионы объектов: 7 секунд и 1,4 ГБ.
  const shapes = {
    "список объектов": `[${Array.from({ length: 33_000 }, () => "{}").join(",")}]`,
    "список списков": `[${Array.from({ length: 33_000 }, () => "[]").join(",")}]`,
    "объект на 7 000 ключей": `{${Array.from({ length: 7_000 }, (_, index) => `"k${index}":1`).join(",")}}`,
    "список строк": `[${Array.from({ length: 20_000 }, () => '"a"').join(",")}]`,
  };
  for (const [name, json] of Object.entries(shapes)) {
    const goals = [["Название", "Критерии успеха", "Ограничения"], ...Array.from({ length: 250 }, (_, index) => [`Цель ${index}`, json, json])];
    let outcome: unknown = null;
    const spent = await cpuMs(async () => {
      try {
        outcome = await parseArchive(book({ name: "Цели", rows: goals }), { zone: ZONE });
      } catch (error) {
        outcome = error;
      }
    });
    if (outcome instanceof ArchiveRejected) {
      assert.match(outcome.message, /списков и вложенных значений/, name);
    } else {
      const parsed = outcome as Awaited<ReturnType<typeof parseArchive>>;
      assert.equal(parsed.goals.length, 0, name);
      assert.ok(parsed.errors.every((item) => /слишком сложное значение|больше 200 пунктов/.test(item.message)), name);
    }
    assert.ok(spent < 1_000, `${name}: ${Math.round(spent)} мс процессора`);
  }
});

test("JSON: варианты решения — длинный список отвергается до разбора, короткий лишний — до очистки пунктов", async () => {
  // 12 500 пунктов в 900 строках: прежний разбор чистил каждый — 3 с.
  const long = JSON.stringify(Array.from({ length: 12_500 }, () => "a"));
  const decisions = [["Вопрос", "Варианты"], ...Array.from({ length: 900 }, (_, index) => [`Вопрос ${index}`, long])];
  let outcome: unknown = null;
  const spent = await cpuMs(async () => {
    try {
      outcome = await parseArchive(book({ name: "Решения", rows: decisions }), { zone: ZONE });
    } catch (error) {
      outcome = error;
    }
  });
  // Каждая строка — ошибка до разбора JSON, а вместе они исчерпывают бюджет
  // файла: отказ всему файлу.
  assert.ok(outcome instanceof ArchiveRejected, String(outcome));
  assert.match(outcome.message, /списков и вложенных значений/);
  assert.ok(spent < 1_000, `${Math.round(spent)} мс процессора`);

  const extra = JSON.stringify(Array.from({ length: 60 }, (_, index) => `вариант ${index}`));
  const few = await parseArchive(book({ name: "Решения", rows: [["Вопрос", "Варианты"], ["Вопрос", extra]] }), { zone: ZONE });
  assert.match(few.errors[0]!.message, /больше 50 пунктов/);
});

test("разбор: текст из `\\r` и управляющих символов через знак чистится линейно, не по совпадению за раз", async () => {
  // Регулярное выражение тратило на каждое совпадение до 90 нс: 250 ссылок
  // на одну такую строку держали сервис 5 секунд.
  for (const filler of ["а\r", "а\u0001", "а\r\u0001\n"]) {
    const dense = filler.repeat(Math.floor(199_000 / filler.length));
    const notes = [["Заголовок", "Текст"], ...Array.from({ length: 250 }, (_, index) => [`Заметка ${index}`, dense])];
    let outcome: unknown = null;
    const spent = await cpuMs(async () => {
      try {
        outcome = await parseArchive(book({ name: "Заметки", rows: notes }), { zone: ZONE });
      } catch (error) {
        outcome = error;
      }
    });
    assert.ok(spent < 1_000, `${JSON.stringify(filler)}: ${Math.round(spent)} мс процессора`);
    // После очистки «а\r…» — те же 199 000 знаков, длиннее заметки; в
    // остальных половина знаков уходит, и текст ложится в предел.
    if (!(outcome instanceof ArchiveRejected)) {
      const parsed = outcome as Awaited<ReturnType<typeof parseArchive>>;
      const expected = filler === "а\r" ? 0 : 250;
      assert.equal(parsed.notes.length, expected, JSON.stringify(filler));
      if (expected > 0) assert.equal(parsed.notes[0]!.value.content, filler === "а\u0001" ? "а".repeat(99_500) : "а\n".repeat(49_750).trimEnd());
    }
  }
});
