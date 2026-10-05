// Запросы лексической половины поиска по базе знаний — в SQL-тест.
//
// `scripts/ci/test-knowledge-search.sql` проверяет запросы на настоящем
// PostgreSQL, а настоящего PostgreSQL в job агента нет. Ручная копия
// запроса расходилась с кодом незаметно: правка кода меняла план, а тест
// проверял старый текст. Поэтому блок между маркерами строится из
// собранного `search-queries.js`: тот же текст запроса и те же параметры
// через PREPARE/EXECUTE, а CI (`--check`) сверяет блок с кодом.
//
//   node ../scripts/ci/gen-knowledge-search-probes.mjs          переписать блок
//   node ../scripts/ci/gen-knowledge-search-probes.mjs --check  сверить

import { readFileSync, writeFileSync } from "node:fs";

import { lexicalCandidates } from "../../eva-agent-service/dist/knowledge/search-queries.js";

const FILE = new URL("./test-knowledge-search.sql", import.meta.url);
const BEGIN = "-- >>> сгенерировано scripts/ci/gen-knowledge-search-probes.mjs — не править руками";
const END = "-- <<< конец сгенерированного блока";

// Человек 920100; метка, запрос, слова для триграмм, личная база в поиске.
const PROBES = [
  ["morphology", "договор аренда", [], true],
  ["question", "какие сроки оплаты по договору квартиры", [], true],
  ["trigram", "Иваноф Р-168-5УН", ["Иваноф", "Р-168-5УН"], true],
  ["name", "Петрову", ["Петрову"], true],
  ["private_off", "аренда", [], false],
];

// Слова и триграммы — два запроса: каждый становится своей вставкой.
let captured = [];
const capture = async (sql, values) => {
  if (!sql.startsWith("SET")) captured.push([sql, values]);
  return { rows: [] };
};
const db = {
  withUserScope: async (_scope, work) => await work(null),
  transaction: async (work) => await work({ query: capture }),
  query: capture,
};

const literal = (value) => typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);

// Запрос уходит в PostgreSQL как есть — подготовленным, с параметрами:
// так ловятся и ошибки, которых не видно при подстановке литералов
// (параметр, чей тип не определить, несовпадение типов).
const blocks = [];
let number = 0;
for (const [label, query, terms, privateEnabled] of PROBES) {
  captured = [];
  await lexicalCandidates(db, { userId: 920100, privateEnabled, globalEnabled: true }, query, terms, 30);
  for (const [sql, values] of captured) {
    number += 1;
    const name = `probe_${number}`;
    const body = sql.split("\n").map((line) => line.replace(/^ {7}/, "")).join("\n  ");
    blocks.push(`-- ${label}: «${query}»${terms.length ? `, триграммы: ${terms.join(", ")}` : ""}${privateEnabled ? "" : ", личная база выключена"}
PREPARE ${name} AS
  ${body};
CREATE TEMP TABLE ${name}_rows ON COMMIT DROP AS EXECUTE ${name}(${values.map(literal).join(", ")});
INSERT INTO probe_lexical
SELECT '${label}', q.signal, d.name, c.ordinal
  FROM ${name}_rows q
  JOIN knowledge_chunks c ON c.id = q.id::bigint
  JOIN knowledge_documents d ON d.id = c.document_id;
DEALLOCATE ${name};
`);
  }
}

const generated = `${BEGIN}\n${blocks.join("\n")}${END}`;
const current = readFileSync(FILE, "utf8");
const start = current.indexOf(BEGIN);
const end = current.indexOf(END);
if (start < 0 || end < start) {
  console.error("в test-knowledge-search.sql нет маркеров сгенерированного блока");
  process.exit(1);
}
const next = current.slice(0, start) + generated + current.slice(end + END.length);
if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error("::error::test-knowledge-search.sql расходится с src/knowledge/search-queries.ts: запустите node ../scripts/ci/gen-knowledge-search-probes.mjs");
    process.exit(1);
  }
  console.log(`запросы поиска в SQL-тесте совпадают с кодом (${PROBES.length})`);
} else {
  writeFileSync(FILE, next);
  console.log(`блок переписан: ${PROBES.length} запросов`);
}
