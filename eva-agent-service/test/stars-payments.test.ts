/**
 * Оплата звёздами Telegram.
 *
 * Ради чего файл существует — отрицательные проверки. Деньги ошибаются
 * дороже всего остального: чужой счёт не должен оплачиваться, изменённая
 * цена не должна списываться молча, повторное событие не должно выдавать
 * вторую подписку. Всё это проверяется до Telegram, а не после.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PERIOD_DAYS, StarsPayments } from "../dist/payments/stars.js";

const INTENT = "11111111-2222-3333-4444-555555555555";

/** Поддельная база: ровно те запросы, которые модуль действительно шлёт. */
function db(rows: Record<string, unknown[]>) {
  const asked: string[] = [];
  const pick = (text: string): unknown[] => {
    asked.push(text);
    if (text.includes("FROM users WHERE id =")) return rows.owner ?? [{ id: "7" }];
    if (text.includes("FROM users WHERE telegram_id")) return rows.owner ?? [{ id: "7" }];
    if (text.includes("FROM plan_prices") && text.includes("ORDER BY")) return rows.offers ?? [];
    if (text.includes("FROM plan_prices")) return rows.price ?? [];
    if (text.includes("INSERT INTO payment_intents")) return rows.intent ?? [{ id: INTENT }];
    if (text.includes("SELECT 1 FROM payment_intents")) return rows.inProgress ?? [];
    if (text.includes("FROM payment_intents")) return rows.lookup ?? [];
    if (text.includes("INSERT INTO payments")) return rows.payment ?? [{ id: "9" }];
    if (text.includes("FROM subscriptions")) return rows.active ?? [];
    if (text.includes("INSERT INTO subscriptions")) return rows.subscription ?? [{ id: "10" }];
    if (text.includes("FROM quotas")) return rows.quotas ?? [];
    return [];
  };
  return {
    asked,
    db: {
      query: async (text: string) => ({ rows: pick(text) }),
      withSystemScope: async (_label: string, work: () => Promise<unknown>) => await work(),
      withUserScope: async (_input: unknown, work: () => Promise<unknown>) => await work(),
      transaction: async (work: (client: unknown) => Promise<unknown>) => await work({
        query: async (text: string) => ({ rows: pick(text) }),
      }),
    } as never,
  };
}

test("продаётся только то, у чего есть включённая цена", async () => {
  const { db: fake } = db({
    offers: [
      { plan: "plus", period: "month", stars: 500 },
      // Срок, которого нет в справочнике, в продажу не попадает: считать
      // подписку было бы не от чего.
      { plan: "plus", period: "century", stars: 1 },
    ],
  });
  const stars = new StarsPayments({ db: fake });
  const offers = await stars.offers();
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.plan, "plus");
  assert.equal(offers[0]?.stars, 500);
  assert.match(offers[0]?.title ?? "", /месяц/u);
});

test("без назначенной цены счёт не выставляется", async () => {
  const { db: fake } = db({ price: [] });
  const stars = new StarsPayments({ db: fake });
  await assert.rejects(
    () => stars.invoice(1, "plus", "month"),
    /цена не назначена/iu,
  );
});

test("неизвестный срок отвергается до записи намерения", async () => {
  const { db: fake, asked } = db({ price: [{ stars: 100 }] });
  const stars = new StarsPayments({ db: fake });
  await assert.rejects(() => stars.invoice(1, "plus", "century"), /срок/iu);
  assert.equal(
    asked.some((text) => text.includes("INSERT INTO payment_intents")), false,
    "намерение оплаты не должно появляться для срока, которого нет",
  );
});

test("счёт запоминает цену на момент выставления", async () => {
  const { db: fake } = db({ price: [{ stars: 750 }] });
  const stars = new StarsPayments({ db: fake });
  const invoice = await stars.invoice(7, "max", "quarter");
  assert.equal(invoice.stars, 750);
  assert.equal(invoice.payload, INTENT);
  assert.equal(PERIOD_DAYS.quarter, 90);
});

test("предварительная проверка отвергает чужой и просроченный счёт", async () => {
  const verdicts = async (lookup: Record<string, unknown>[]) => {
    const { db: fake } = db({ lookup, price: [{ stars: 500 }] });
    return await new StarsPayments({ db: fake }).preCheckout({
      payload: INTENT, telegramUserId: 42, totalAmount: 500, currency: "XTR",
    });
  };

  // Чужой счёт: заплатил бы один, а доступ получил бы другой. Запрос
  // ограничен своим владельцем, поэтому чужой счёт просто не находится —
  // и от несуществующего он неотличим намеренно.
  const foreign = await verdicts([]);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.ok === false && foreign.reason, "unknown_intent");

  // Цена изменилась, пока счёт висел в чате.
  const changed = await verdicts([
    { id: INTENT, status: "pending", amount_minor: "900", plan: "plus", provider_product_id: "plus:month" },
  ]);
  assert.equal(changed.ok, false);
  assert.equal(changed.ok === false && changed.reason, "amount_changed");

  // Уже оплачено — второй раз списывать не за что.
  const used = await verdicts([
    { id: INTENT, status: "succeeded", amount_minor: "500", plan: "plus", provider_product_id: "plus:month" },
  ]);
  assert.equal(used.ok, false);
  assert.equal(used.ok === false && used.reason, "not_pending");

  // Всё сходится.
  const good = await verdicts([
    { id: INTENT, status: "pending", amount_minor: "500", plan: "plus", provider_product_id: "plus:month" },
  ]);
  assert.equal(good.ok, true);
});

test("чужая валюта и мусорный payload не доходят до базы", async () => {
  const { db: fake, asked } = db({ lookup: [] });
  const stars = new StarsPayments({ db: fake });
  const currency = await stars.preCheckout({
    payload: INTENT, telegramUserId: 1, totalAmount: 10, currency: "RUB",
  });
  assert.equal(currency.ok, false);
  const garbage = await stars.preCheckout({
    payload: "'; DROP TABLE payments; --", telegramUserId: 1, totalAmount: 10, currency: "XTR",
  });
  assert.equal(garbage.ok, false);
  assert.deepEqual(asked, [], "проверка формы идёт до запроса");
});

test("платёж без намерения оплаты не выдаёт подписку", async () => {
  const { db: fake } = db({ lookup: [] });
  const stars = new StarsPayments({ db: fake });
  const outcome = await stars.apply({
    telegramUserId: 42, payload: INTENT, chargeId: "charge-1",
    totalAmount: 500, currency: "XTR", raw: {},
  });
  assert.equal(outcome.state, "unknown_intent");
});

test("состоявшийся платёж записывает подписку и закрывает намерение", async () => {
  const { db: fake, asked } = db({
    lookup: [{
      id: INTENT,
      user_id: "7",
      plan: "plus",
      duration_days: 30,
      amount_minor: "1",
      currency: "XTR",
      status: "pending",
      prechecked_at: new Date(),
    }],
  });
  const outcome = await new StarsPayments({ db: fake }).apply({
    telegramUserId: 42,
    payload: INTENT,
    chargeId: "charge-paid",
    totalAmount: 1,
    currency: "XTR",
    raw: { telegram_payment_charge_id: "charge-paid" },
  });

  assert.deepEqual(outcome, { state: "applied", plan: "plus", days: 30 });
  assert.equal(asked.some((sql) => sql.includes("INSERT INTO payments")), true);
  assert.equal(asked.some((sql) => sql.includes("INSERT INTO subscriptions")), true);
  assert.equal(asked.some((sql) => sql.includes("UPDATE payment_intents")), true);
});

test("состоявшийся платёж повторно сверяется с намерением", async () => {
  const { db: fake, asked } = db({
    lookup: [{
      id: INTENT,
      user_id: "7",
      plan: "plus",
      duration_days: 30,
      amount_minor: "1",
      currency: "XTR",
      status: "pending",
      prechecked_at: new Date(),
    }],
  });
  await assert.rejects(
    () => new StarsPayments({ db: fake }).apply({
      telegramUserId: 42,
      payload: INTENT,
      chargeId: "charge-wrong",
      totalAmount: 2,
      currency: "XTR",
      raw: {},
    }),
    /не совпадает/iu,
  );
  assert.equal(
    asked.some((sql) => sql.includes("INSERT INTO payments")),
    false,
    "несовпадающий платёж не должен выдавать доступ",
  );
});

test("активный тариф нельзя оплатить повторно или понизить", async () => {
  const end = new Date(Date.now() + 7 * 86_400_000);
  const same = db({
    price: [{ stars: 100 }],
    active: [{ plan: "plus", status: "active", source: "payment", current_period_end: end }],
  });
  await assert.rejects(
    () => new StarsPayments({ db: same.db }).invoice(7, "plus", "month"),
    /уже действует/iu,
  );
  assert.match(
    await new StarsPayments({ db: same.db }).unavailableMessage(7) ?? "",
    /повторная оплата.*после окончания/iu,
  );
  assert.equal(same.asked.some((sql) => sql.includes("INSERT INTO payment_intents")), false);

  const downgrade = db({
    price: [{ stars: 100 }],
    active: [{ plan: "max", status: "active", source: "payment", current_period_end: end }],
  });
  await assert.rejects(
    () => new StarsPayments({ db: downgrade.db }).invoice(7, "plus", "month"),
    /понизить тариф/iu,
  );
});

test("повышение Plus → Max остаётся доступным", async () => {
  const { db: fake } = db({
    price: [{ stars: 700 }],
    active: [{
      plan: "plus", status: "active", source: "payment",
      current_period_end: new Date(Date.now() + 7 * 86_400_000),
    }],
  });
  const invoice = await new StarsPayments({ db: fake }).invoice(7, "max", "month");
  assert.equal(invoice.plan, "max");
});

test("после pre-checkout второй счёт не создаётся", async () => {
  const { db: fake, asked } = db({ inProgress: [{ exists: 1 }] });
  await assert.rejects(
    () => new StarsPayments({ db: fake }).invoice(7, "plus", "month"),
    /оплата ещё завершается/iu,
  );
  assert.equal(asked.some((sql) => sql.includes("INSERT INTO payment_intents")), false);
});

test("выключенный lifecycle-флаг возвращает прежнюю возможность продления", async () => {
  const { db: fake } = db({
    price: [{ stars: 100 }],
    active: [{
      plan: "plus", status: "active", source: "payment",
      current_period_end: new Date(Date.now() + 7 * 86_400_000),
    }],
  });
  const invoice = await new StarsPayments({ db: fake, lifecycleEnabled: false })
    .invoice(7, "plus", "month");
  assert.equal(invoice.plan, "plus");
});
