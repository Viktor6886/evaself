/**
 * Реестры РФ: ЕГРЮЛ и ЕГРИП.
 *
 * Проверяется граница, а не только разбор: поиск по наименованию не
 * расширяет найденных однофамильцев-организаций, ФИО руководителя не
 * становится следом, у ИП нет адреса, иностранный номер не уходит в ФНС,
 * капча — деградация, а не «ничего нет».
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { EGRUL_BOUND, EgrulCollector } from "../dist/osint/registry-collectors.js";
import { OsintWorkerClient } from "../dist/osint/worker-client.js";
import { renderReport } from "../dist/osint/report.js";
import type { CollectorOutput, Finding } from "../dist/osint/collectors.js";

const signal = () => new AbortController().signal;
const target = (type: string, normalized: string) => ({ identifierId: "i", type, normalized, depth: 0 }) as never;
const findings = (output: CollectorOutput): Finding[] => output.sources.flatMap((item) => item.findings);

const ORGANIZATION = {
  kind: "organization", name: 'ПАО "СБЕРБАНК РОССИИ"', short_name: "ПАО СБЕРБАНК", inn: "7707083893",
  ogrn: "1027700132195", kpp: "773601001", registered: "2002-08-16", terminated: null, region: "Г.МОСКВА",
  address: "117312, Г.МОСКВА, УЛ. ВАВИЛОВА, Д.19", head: "ПРЕЗИДЕНТ: ГРЕФ ГЕРМАН ОСКАРОВИЧ",
};
const ENTREPRENEUR = {
  kind: "entrepreneur", name: "ИВАНОВ ИВАН ИВАНОВИЧ", inn: "500100732259", ogrn: "304500116000157",
  registered: "2004-02-01", terminated: "2019-03-15", region: null, address: "не должно попасть",
};

function worker(records: unknown[], extra: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  return {
    calls,
    client: {
      egrul: async (...args: unknown[]) => {
        calls.push(args);
        return {
          collector: "egrul", status: "ok", requests: 2, sourceUrl: "https://egrul.nalog.ru/",
          degradedReason: null, data: { records }, ...extra,
        };
      },
    },
  };
}

test("ИНН: организация с реестровыми свойствами, второй номер — за ней, без расширения", async () => {
  const { client, calls } = worker([ORGANIZATION]);
  const output = await new EgrulCollector(client as never)
    .collect({ target: target("tax_id", "7707083893"), signal: signal(), remainingRequests: 100 });
  assert.deepEqual(calls, [["tax_id", "7707083893"]]);
  assert.equal(output.status, "succeeded");
  assert.equal(output.sources[0]!.tier, "official_registry");
  assert.equal(output.sources[0]!.domain, "egrul.nalog.ru");
  const entity = findings(output).find((item) => item.kind === "entity");
  assert.ok(entity?.kind === "entity");
  assert.equal(entity.schema, "Organization");
  assert.equal(entity.identifier.normalized, "7707083893");
  assert.equal(entity.caption, 'ПАО "СБЕРБАНК РОССИИ"');
  const props = Object.fromEntries(entity.properties.map((item) => [item.property, item.value]));
  assert.equal(props.ogrnCode, "1027700132195");
  assert.equal(props.status, "действует");
  assert.equal(props.director, "ПРЕЗИДЕНТ: ГРЕФ ГЕРМАН ОСКАРОВИЧ");
  const discovered = findings(output).filter((item) => item.kind === "discovered");
  assert.deepEqual(discovered.map((item) => item.kind === "discovered" && [item.identifier.type, item.identifier.normalized, item.expand]),
    [["registration_number", "1027700132195", false]]);
  // ФИО руководителя — свойство, а не новый след.
  assert.equal(discovered.some((item) => item.kind === "discovered" && item.identifier.type === "name"), false);
});

test("ИП: LegalEntity без адреса, прекращённая деятельность видна", async () => {
  const { client } = worker([ENTREPRENEUR]);
  const output = await new EgrulCollector(client as never)
    .collect({ target: target("registration_number", "304500116000157"), signal: signal(), remainingRequests: 100 });
  const entity = findings(output).find((item) => item.kind === "entity");
  assert.ok(entity?.kind === "entity");
  assert.equal(entity.schema, "LegalEntity");
  const props = Object.fromEntries(entity.properties.map((item) => [item.property, item.value]));
  assert.equal(props.legalForm, "индивидуальный предприниматель");
  assert.equal(props.status, "деятельность прекращена");
  assert.equal(props.address, undefined);
  assert.equal(props.director, undefined);
});

test("наименование: несколько организаций, ни одна не расширяется", async () => {
  const other = { ...ORGANIZATION, name: "ООО РОМАШКА", inn: "7736050003", ogrn: "1027700067328" };
  const { client, calls } = worker([ORGANIZATION, other]);
  const output = await new EgrulCollector(client as never)
    .collect({ target: target("organization", "ромашка"), signal: signal(), remainingRequests: 100 });
  assert.deepEqual(calls, [["organization", "ромашка"]]);
  assert.equal(findings(output).filter((item) => item.kind === "entity").length, 2);
  assert.ok(findings(output).every((item) => item.kind !== "discovered" || item.expand === false));
});

test("иностранный номер и неверная контрольная сумма не уходят в ФНС", async () => {
  const { client, calls } = worker([ORGANIZATION]);
  const collector = new EgrulCollector(client as never);
  for (const [type, value] of [["tax_id", "DE123456789"], ["tax_id", "7707083894"], ["registration_number", "1027700132196"], ["organization", "ab"]]) {
    const output = await collector.collect({ target: target(type!, value!), signal: signal(), remainingRequests: 100 });
    assert.equal(output.status, "skipped", `${type}:${value}`);
    assert.equal(output.errorCode, "osint_registry_not_applicable");
  }
  assert.equal(calls.length, 0);
  assert.equal(collector.accepts("name"), false);
  assert.equal(collector.accepts("email"), false);
});

test("без бюджета на полный прогон сборщик не запускается", async () => {
  const { client, calls } = worker([ORGANIZATION]);
  const output = await new EgrulCollector(client as never)
    .collect({ target: target("tax_id", "7707083893"), signal: signal(), remainingRequests: EGRUL_BOUND - 1 });
  assert.equal(output.status, "skipped");
  assert.equal(calls.length, 0);
});

test("капча — деградация с причиной, а не пустой результат", async () => {
  const { client } = worker([], { status: "degraded", degradedReason: "captcha", sourceUrl: null, requests: 1 });
  const output = await new EgrulCollector(client as never)
    .collect({ target: target("tax_id", "7707083893"), signal: signal(), remainingRequests: 100 });
  assert.equal(output.status, "degraded");
  assert.equal(output.degradedReason, "captcha");
  assert.equal(output.sources.length, 0);
});

test("клиент worker: путь, тело и отказ от повтора", async () => {
  let calls = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    calls += 1;
    assert.equal(url, "http://w/v1/registry/egrul");
    assert.deepEqual(JSON.parse(String(init.body)), { kind: "tax_id", value: "7707083893" });
    return new Response("{}", { status: 503 });
  }) as typeof fetch;
  await assert.rejects(new OsintWorkerClient({ baseUrl: "http://w", token: "k", fetcher }).egrul("tax_id", "7707083893"));
  // Повтор скорее вызвал бы капчу ФНС, чем получил ответ.
  assert.equal(calls, 1);
});

test("отчёт показывает сведения реестра о самом субъекте", () => {
  const text = renderReport({
    id: "x", status: "completed", mode: "standard", purpose: "проверка контрагента",
    createdAt: "", completedAt: null,
    subject: {
      caption: "ПАО СБЕРБАНК", schema: "Organization", identifiers: [{ type: "tax_id", value: "7707083893" }],
      properties: { ogrnCode: ["1027700132195"], status: ["действует"] },
    },
    accounts: [], infrastructure: [], mentions: [], discovered: [], runs: [],
    externalRequests: 2, maxExternalRequests: 150, limitations: ["Использованы только открытые источники."],
  } as never);
  assert.match(text, /Сведения о субъекте из источников: ogrnCode: 1027700132195; status: действует/);
});
