/**
 * Книга Excel архива: запись и безопасное чтение (docs/data-archive.md).
 *
 * Запись проверяется обратным чтением: всё, что выгрузка кладёт в файл,
 * читается назад без потерь. Чтение — на том, что пишут другие программы
 * (форматированный текст, ячейки без адреса, префиксы пространств имён,
 * календарь 1904 года), и на враждебных файлах: бомба сжатия, обход
 * каталогов, DTD, не-zip.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import JSZip from "jszip";

import { readWorkbook, serialToLocal, WorkbookFormatError } from "../dist/archive/xlsx-reader.js";
import { columnLetter, excelSerial, writeWorkbook, EXCEL_CELL_LIMIT } from "../dist/archive/xlsx-writer.js";

const META = { title: "Архив", creator: "Evaself", created: new Date("2026-10-07T10:00:00Z") };

test("запись и чтение: текст, числа, даты, да/нет и пустые ячейки возвращаются без потерь", async () => {
  const tricky = "Строка с <тегом> & \"кавычками\", _x000D_ буквально\nи переносом";
  const { bytes, truncatedCells } = await writeWorkbook([
    {
      name: "Задачи",
      columns: [
        { header: "Название", kind: "text" },
        { header: "Срок", kind: "datetime" },
        { header: "Дата", kind: "date" },
        { header: "Приоритет", kind: "int" },
        { header: "Сумма", kind: "number" },
        { header: "Готово", kind: "bool" },
        { header: "Текст", kind: "longtext" },
      ],
      rows: [
        ["Купить хлеб", "2026-10-07T14:30", "2026-10-07", 3, 1234.5, true, tricky],
        ["  с пробелами  ", null, undefined, null, 0, false, "=1+1"],
        [],
      ],
    },
    { name: "Пусто", columns: [{ header: "А", kind: "text" }], rows: [] },
  ], META);
  assert.equal(truncatedCells, 0);
  const book = await readWorkbook(bytes);
  assert.deepEqual(book.sheets.map((sheet) => sheet.name), ["Задачи", "Пусто"]);
  const [header, first, second, third] = book.sheets[0]!.rows;
  assert.deepEqual(header, ["Название", "Срок", "Дата", "Приоритет", "Сумма", "Готово", "Текст"]);
  assert.equal(first![0], "Купить хлеб");
  assert.equal(serialToLocal(first![1] as number), "2026-10-07T14:30");
  assert.equal(serialToLocal(first![2] as number), "2026-10-07T00:00");
  assert.equal(first![3], 3);
  assert.equal(first![4], 1234.5);
  assert.equal(first![5], "да");
  assert.equal(first![6], tricky, "экранирование XML и Excel обратимо");
  assert.equal(second![0], "  с пробелами  ");
  assert.equal(second![4], 0);
  assert.equal(second![5], "нет");
  // Формула — это строка: ячейка типа s не вычисляется ни Excel, ни нами.
  assert.equal(second![6], "=1+1");
  assert.deepEqual(third, []);
  assert.deepEqual(book.sheets[1]!.rows, [["А"]]);
});

test("запись: длинный текст обрезается до предела Excel и считается, управляющие символы убираются", async () => {
  const { bytes, truncatedCells } = await writeWorkbook([{
    name: "Заметки",
    columns: [{ header: "Текст", kind: "longtext" }, { header: "Метка", kind: "text" }],
    rows: [["я".repeat(EXCEL_CELL_LIMIT + 10), "a\u0001b\u0000c\uD800"]],
  }], META);
  assert.equal(truncatedCells, 1);
  const rows = (await readWorkbook(bytes)).sheets[0]!.rows;
  assert.equal((rows[1]![0] as string).length, EXCEL_CELL_LIMIT);
  assert.ok((rows[1]![0] as string).endsWith("…"));
  assert.equal(rows[1]![1], "abc");
});

test("запись: предел Excel — в символах, экранирование `_xHHHH_` его не съедает", async () => {
  const value = `${"_x000D_".repeat(4_000)}${"я".repeat(EXCEL_CELL_LIMIT - 28_000)}`;
  assert.equal(value.length, EXCEL_CELL_LIMIT);
  const { bytes, truncatedCells } = await writeWorkbook([{
    name: "Лист", columns: [{ header: "Текст", kind: "longtext" }], rows: [[value]],
  }], META);
  assert.equal(truncatedCells, 0);
  assert.equal((await readWorkbook(bytes)).sheets[0]!.rows[1]![0], value);
});

/**
 * jszip кодирует строку кусками по 16 384 знака: суррогатная пара на стыке
 * превращалась в два «�». Сдвиг на один знак гарантирует, что на одном из
 * двух прогонов эмодзи окажется ровно на стыке.
 */
test("запись: эмодзи на стыке кусков архива доходит целым", async () => {
  for (const shift of [0, 1]) {
    const value = `${"x".repeat(shift)}${"😀".repeat(15_000)}`;
    const { bytes } = await writeWorkbook([{ name: "Эмодзи", columns: [{ header: "Текст", kind: "longtext" }], rows: [[value]] }], META);
    const back = (await readWorkbook(bytes)).sheets[0]!.rows[1]![0];
    assert.equal(back === value, true, `сдвиг ${shift}: ${String(back).split("\ufffd").length - 1} знаков «�»`);
  }
});

test("запись: имя листа проверяется по правилам Excel", async () => {
  await assert.rejects(writeWorkbook([{ name: "a/b", columns: [], rows: [] }], META));
  await assert.rejects(writeWorkbook([{ name: "x".repeat(32), columns: [], rows: [] }], META));
  await assert.rejects(writeWorkbook([
    { name: "Лист", columns: [], rows: [] }, { name: "лист", columns: [], rows: [] },
  ], META));
});

test("номер дня Excel: календарь 1900 и 1904, несуществующие даты", () => {
  assert.equal(excelSerial("1900-03-01"), 61);
  assert.equal(excelSerial("2026-02-31"), null);
  assert.equal(excelSerial("2026-10-07T12:00"), 46302.5);
  assert.equal(serialToLocal(46302.5), "2026-10-07T12:00");
  assert.equal(serialToLocal(46302.5 - 1462, true), "2026-10-07T12:00");
  assert.equal(serialToLocal(-1), null);
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
  assert.equal(columnLetter(701), "ZZ");
  assert.equal(columnLetter(702), "AAA");
});

async function zipOf(parts: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const CONTENT_TYPES = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
const ROOT_RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/xl/workbook.xml"/></Relationships>`;

test("чтение: книга, как её пишут Excel и LibreOffice — общие строки, rich text, rPh, префиксы, 1904", async () => {
  const bytes = await zipOf({
    "[Content_Types].xml": CONTENT_TYPES,
    "_rels/.rels": ROOT_RELS,
    "xl/workbook.xml": `<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<x:workbookPr date1904='1'/><x:sheets>`
      + `<x:sheet name='Служебный' sheetId='1' r:id='rId9'/>`
      + `<x:sheet name="Заметки &amp; мысли" sheetId="2" r:id="rId2"/></x:sheets></x:workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/../worksheets/second.xml"/>`
      + `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/first.xml"/>`
      + `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`
      + `</Relationships>`,
    "xl/sharedStrings.xml": `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
      + `<si><t>Заголовок</t></si>`
      + `<si><r><rPr><b/></rPr><t xml:space="preserve">Жирное </t></r><r><t>и обычное</t></r><rPh sb="0" eb="1"><t>ФОНЕТИКА</t></rPh></si>`
      + `<si><t>Строка_x000D_с возвратом &#1071;&#x44F;</t></si></sst>`,
    "xl/worksheets/first.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>не нужен</t></is></c></row></sheetData></worksheet>`,
    "xl/worksheets/second.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
      + `<row><c t="s"><v>0</v></c><c><v>42</v></c></row>`
      + `<row r="3"><c r="B3" t="s"><v>1</v></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="e"><v>#N/A</v></c>`
      + `<c r="F3" t="str"><f>A1</f><v>формула</v></c><c r="G3" s="2"><v>44840.5</v></c><c r="H3" t="s"><v>2</v></c>`
      + `<c r="I3" t="s"><v>99</v></c><c r="Z9"><v>1</v></c></row>`
      + `</sheetData></worksheet>`,
  });
  const book = await readWorkbook(bytes, { wanted: (name) => name !== "Служебный" });
  assert.equal(book.date1904, true);
  assert.deepEqual(book.sheets.map((sheet) => sheet.name), ["Заметки & мысли"]);
  const rows = book.sheets[0]!.rows;
  assert.deepEqual(rows[0], ["Заголовок", 42]);
  assert.deepEqual(rows[1], []);
  // Ячейка Z9 в строке 3 — чужая строка: её не приклеивают к третьей.
  assert.deepEqual(rows[2], [null, "Жирное и обычное", null, true, null, "формула", 44840.5, "Строка\rс возвратом Яя"]);
  assert.equal(serialToLocal(44840.5, true), "2026-10-07T12:00");
});

test("чтение: враждебные файлы отвергаются с кодом, а не разбираются", async () => {
  const code = async (bytes: Buffer) => {
    try {
      await readWorkbook(bytes);
      return "ok";
    } catch (error) {
      assert.ok(error instanceof WorkbookFormatError, String(error));
      return error.code;
    }
  };
  assert.equal(await code(Buffer.from("не zip вовсе, а текст")), "xlsx_not_zip");
  assert.equal(await code(await zipOf({ "a.txt": "x" })), "xlsx_not_workbook");
  // Бомба: мегабайты нулей сжимаются в сотни раз.
  assert.equal(await code(await zipOf({
    "[Content_Types].xml": CONTENT_TYPES, "xl/workbook.xml": Buffer.alloc(8 * 1024 * 1024),
  })), "xlsx_zip_bomb");
  assert.equal(await code(await zipOf({
    "[Content_Types].xml": CONTENT_TYPES,
    "_rels/.rels": ROOT_RELS,
    "xl/workbook.xml": `<!DOCTYPE lol [<!ENTITY lol "lol">]><workbook>&lol;</workbook>`,
  })), "xlsx_doctype_forbidden");
  const many: Record<string, string> = { "[Content_Types].xml": CONTENT_TYPES };
  for (let index = 0; index < 501; index += 1) many[`x/${index}.xml`] = "<a/>";
  assert.equal(await code(await zipOf(many)), "xlsx_too_many_parts");
  // Строки в обратном порядке склеили бы чужие ячейки.
  const unordered = await zipOf({
    "[Content_Types].xml": CONTENT_TYPES,
    "xl/workbook.xml": `<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="s.xml"/></Relationships>`,
    "xl/s.xml": `<worksheet><sheetData><row r="5"><c><v>1</v></c></row><row r="2"><c><v>2</v></c></row></sheetData></worksheet>`,
  });
  assert.equal(await code(unordered), "xlsx_rows_unordered");
});

/** Книга с одним листом, XML которого задан целиком. */
async function bookWithSheet(sheetXml: string, extra: Record<string, string> = {}): Promise<Buffer> {
  return await zipOf({
    "[Content_Types].xml": CONTENT_TYPES,
    "xl/workbook.xml": `<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="s.xml"/>`
      + `<Relationship Id="rId2" Type="x/sharedStrings" Target="strings.xml"/></Relationships>`,
    "xl/s.xml": sheetXml,
    ...extra,
  });
}

/**
 * Процессорное время вызова, а не время по часам: под нагрузкой CI
 * (параллельные тесты и сборки образов) часы идут втрое-вдесятеро
 * быстрее работы самого разбора, а процессорное время — нет.
 */
async function cpuMs(run: () => Promise<unknown>): Promise<number> {
  const before = process.cpuUsage();
  await run();
  const spent = process.cpuUsage(before);
  return (spent.user + spent.system) / 1000;
}

/**
 * Враждебный XML разбирается за линейное время. Прежний разбор
 * регулярными выражениями перечитывал хвост от каждого незакрытого тега:
 * 80 000 незакрытых `<row>` — 10 секунд, атрибут в 200 000 знаков — 36.
 */
test("чтение: незакрытые теги и огромные атрибуты отвергаются быстро, а не перечитываются", async () => {
  const cases: Array<[string, Buffer]> = [
    ["80 000 незакрытых <row>", await bookWithSheet(`<worksheet><sheetData>${"<row>".repeat(80_000)}</sheetData></worksheet>`)],
    ["атрибут без значения на 200 000 знаков", await bookWithSheet(`<worksheet><sheetData><row><c ${"a".repeat(200_000)}/></row></sheetData></worksheet>`)],
    ["тег без конца", await bookWithSheet(`<worksheet><sheetData><row${" a".repeat(100_000)}`)],
    ["значение атрибута без закрывающей кавычки", await bookWithSheet(`<worksheet><sheetData><row r="${"1".repeat(200_000)}`)],
    ["40 000 незакрытых <si><t>", await bookWithSheet("<worksheet/>", { "xl/strings.xml": `<sst>${"<si><t>x".repeat(40_000)}</sst>` })],
    ["DOCTYPE в середине", await bookWithSheet(`<worksheet><!DOCTYPE x [<!ENTITY a "b">]><sheetData/></worksheet>`)],
  ];
  for (const [name, bytes] of cases) {
    const spent = await cpuMs(() =>
      assert.rejects(readWorkbook(bytes), (error: unknown) => error instanceof WorkbookFormatError, name));
    assert.ok(spent < 1_500, `${name}: ${Math.round(spent)} мс процессора`);
  }
});

/**
 * Самый большой разрешённый лист — меньше трёх секунд процессора, а
 * вчетверо больше строк — меньше чем в восемь раз больше процессора:
 * линейный разбор тратит примерно вчетверо больше (с постоянными
 * затратами — меньше), квадратичный — до шестнадцати раз. Отношение не
 * зависит ни от скорости машины, ни от соседей по CI.
 */
test("чтение: большой честный лист разбирается за линейное время", async () => {
  const sheetOf = (count: number) => bookWithSheet(`<worksheet><sheetData>${Array.from({ length: count }, (_, index) =>
    `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>строка ${index}</t></is></c><c r="B${index + 1}"><v>${index}</v></c></row>`,
  ).join("")}</sheetData></worksheet>`);
  const small = await sheetOf(5_000);
  const large = await sheetOf(20_000);
  // Первый разбор компилирует сканер — в замер он не входит; из двух
  // замеров берётся меньший, чтобы случайная сборка мусора не решала исход.
  await readWorkbook(small);
  const cheapest = async (bytes: Buffer) => Math.min(await cpuMs(() => readWorkbook(bytes)), await cpuMs(() => readWorkbook(bytes)));
  const smallSpent = await cheapest(small);
  const largeSpent = await cheapest(large);
  const book = await readWorkbook(large);
  assert.equal(book.sheets[0]!.rows.length, 20_000);
  assert.deepEqual(book.sheets[0]!.rows[19_999], ["строка 19999", 19_999]);
  const spent = `20 000 строк — ${Math.round(largeSpent)} мс процессора, 5 000 — ${Math.round(smallSpent)} мс`;
  assert.ok(largeSpent < 3_000, spent);
  assert.ok(largeSpent < smallSpent * 8, spent);
});

test("чтение: `>` внутри значения атрибута и CDATA не ломают разбор", async () => {
  const bytes = await bookWithSheet(
    `<worksheet><sheetData><row r="1" note="a > b"><c r="A1" t="inlineStr"><is><t><![CDATA[<не тег> & текст]]></t></is></c></row></sheetData></worksheet>`,
  );
  assert.deepEqual((await readWorkbook(bytes)).sheets[0]!.rows, [["<не тег> & текст"]]);
});

test("чтение: обход каталогов в имени части отвергается", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("xl/workbook.xml", "<workbook/>");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  // JSZip нормализует имя при записи, поэтому `..` вписывается в
  // центральный каталог и локальный заголовок вручную, той же длины.
  const forged = Buffer.from(bytes.toString("latin1").replaceAll("xl/workbook.xml", "../orkbook.xml"), "latin1");
  await assert.rejects(readWorkbook(forged), (error: unknown) =>
    error instanceof WorkbookFormatError
    && ["xlsx_part_name_invalid", "xlsx_zip_malformed"].includes(error.code));
});

test("чтение: лимиты строк и столбцов", async () => {
  const rows = Array.from({ length: 30 }, (_, index) => [`строка ${index}`]);
  const { bytes } = await writeWorkbook([{ name: "Много", columns: [{ header: "А", kind: "text" }], rows }], META);
  await assert.rejects(readWorkbook(bytes, { limits: { maxRows: 10 } }), /xlsx_too_many_rows/);
  const wide = await writeWorkbook([{
    name: "Широко",
    columns: Array.from({ length: 12 }, (_, index) => ({ header: `К${index}`, kind: "text" as const })),
    rows: [Array.from({ length: 12 }, (_, index) => `v${index}`)],
  }], META);
  const book = await readWorkbook(wide.bytes, { limits: { maxColumns: 5 } });
  assert.equal(book.sheets[0]!.rows[1]!.length, 5);
});
