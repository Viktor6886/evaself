/**
 * Тарифы: лимиты, пробные, цены в звёздах.
 *
 * Своего хранилища у сервиса нет — он правит `quotas` и `plan_prices`,
 * поэтому проверяется не запись, а решения: что он отвергает, что
 * нормализует и что собирает в один ответ.
 *
 * Правила схемы — уникальность пары «тариф и срок», запрет нулевой цены,
 * неотрицательные пробные — проверены на живом PostgreSQL в CI, а не
 * поддельным пулом.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { METRICS, PLANS, TariffService } from "../dist/admin/tariff-service.js";

function pool(captured: Array<{ text: string; values: unknown[] }> = [], rows: unknown[] = [{}]) {
  return {
    async query(text: string, values: unknown[] = []) {
      captured.push({ text, values });
      return { rows };
    },
  } as never;
}

test("состояние собирает лимиты, цены и расход одним ответом", async () => {
  const service = new TariffService(pool([], []));
  const state = await service.state();
  // Клиенту не нужно знать, какие бывают тарифы и расходники: он их
  // получает, а не хранит вторым списком у себя.
  assert.deepEqual(state.plans, PLANS);
  assert.deepEqual(state.limit_periods, ["day", "week", "month"]);
  assert.deepEqual(state.price_periods, ["week", "month", "quarter"]);
  assert.ok((state.metrics as unknown[]).length >= 8);
  for (const key of ["limits", "prices", "usage", "subscribers"]) {
    assert.ok(Object.hasOwn(state, key), `в ответе нет ${key}`);
  }
});

test("расходники названы по-человечески и не повторяются", () => {
  const names = METRICS.map((entry) => entry.metric);
  assert.equal(new Set(names).size, names.length, "метрика объявлена дважды");
  // Метрика, на которую смотрит гейт хода, обязана остаться прежней:
  // переименование сломало бы и гейт, и накопленные счётчики.
  assert.ok(names.includes("messages"));
  assert.ok(names.includes("voice_minutes"));
  for (const entry of METRICS) assert.ok(entry.title.length > 0, entry.metric);
});

test("безлимит записывается, выдуманные значения — нет", async () => {
  const captured: Array<{ text: string; values: unknown[] }> = [];
  const service = new TariffService(pool(captured));
  await service.setLimit({ plan: "plus", metric: "messages", period: "day", limit_value: -1 });
  assert.deepEqual(captured[0]!.values, ["plus", "messages", "day", -1, 0]);

  await assert.rejects(
    () => service.setLimit({ plan: "gold", metric: "messages", period: "day", limit_value: 1 }),
    /Неизвестный тариф/u,
  );
  await assert.rejects(
    () => service.setLimit({ plan: "plus", metric: "телепатия", period: "day", limit_value: 1 }),
    /Неизвестный расходник/u,
  );
  await assert.rejects(
    () => service.setLimit({ plan: "plus", metric: "messages", period: "year", limit_value: 1 }),
    /Неизвестный период/u,
  );
  // -2 не «ещё безлимитнее»: схема допускает ровно -1.
  await assert.rejects(
    () => service.setLimit({ plan: "plus", metric: "messages", period: "day", limit_value: -2 }),
    /не меньше -1/u,
  );
  await assert.rejects(
    () => service.setLimit({ plan: "plus", metric: "messages", period: "day", limit_value: 1.5 }),
    /целое число/u,
  );
});

test("пробных не может быть больше лимита тарифа", async () => {
  const service = new TariffService(pool());
  await assert.rejects(
    () => service.setLimit({ plan: "plus", metric: "messages", period: "day", limit_value: 10, free_value: 20 }),
    /платить будет не за что/u,
  );
  // При безлимите ограничения на пробные нет: платного предела просто нет.
  await service.setLimit({ plan: "plus", metric: "messages", period: "day", limit_value: -1, free_value: 20 });
});

test("бесплатный тариф не продаётся", async () => {
  const service = new TariffService(pool());
  await assert.rejects(
    () => service.setPrice({ plan: "free", period: "week", stars: 100 }, null),
    /не продаётся/u,
  );
});

test("цена в звёздах: целая, положительная, за известный срок", async () => {
  const captured: Array<{ text: string; values: unknown[] }> = [];
  const service = new TariffService(pool(captured));
  await service.setPrice({ plan: "max", period: "quarter", stars: 1200 }, "admin-1");
  assert.deepEqual(captured[0]!.values, ["max", "quarter", 1200, true, "admin-1"]);

  await assert.rejects(() => service.setPrice({ plan: "plus", period: "year", stars: 10 }, null), /Неизвестный срок/u);
  // Ноль — это «цена не задана», а не «бесплатно»: продавать за ноль
  // Telegram не даст, и тариф не должен попасть в продажу молча.
  await assert.rejects(() => service.setPrice({ plan: "plus", period: "week", stars: 0 }, null), /не меньше 1/u);
  await assert.rejects(() => service.setPrice({ plan: "plus", period: "week", stars: 99.5 }, null), /целое число/u);
});

test("сводный расход не выносит наружу ни одной пользовательской строки", async () => {
  const captured: Array<{ text: string; values: unknown[] }> = [];
  await new TariffService(pool(captured, [])).state();
  const usage = captured.find((query) => query.text.includes("usage_counters"))!;
  assert.match(usage.text, /sum\(used\)/u, "наружу должны идти суммы, а не строки");
  assert.doesNotMatch(usage.text, /telegram_id|first_name|username/u);
  // Граница арендатора объявлена: запрос к пользовательской таблице
  // обязан называть, от чьего имени он идёт.
  assert.match(usage.text, /-- tenant: system/u);
});
