/**
 * Production Mini App: мобильная приёмка iOS UI.
 *
 * Пользовательская навигация: Главная | Тесты | Дневник | Профиль.
 * Цели/план живут внутри Дневника, а служебный экран development
 * остаётся только внутренним контейнером существующей логики app.js.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, test } from "node:test";

import { DEVICES, NOW, PHONES, documentWidth, openApp, smallTapTargets } from "./harness.mjs";

const CORE_SCREENS = ["today", "discovery", "journal", "profile"];
const APP_SOURCE = readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");
const utcDateKeyDaysAgo = (days) => {
  const date = new Date(NOW);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

describe("Mini App production iOS UI", () => {
  const opened = [];
  const open = async (options) => {
    const app = await openApp(options);
    opened.push(app);
    return app;
  };

  after(async () => {
    for (const app of opened) await app.close().catch(() => {});
  });

  for (const device of DEVICES) {
    test(`${device.name}: пользовательские экраны не прокручиваются вбок`, async () => {
      const app = await open({ viewport: { width: device.width, height: device.height } });
      for (const screen of CORE_SCREENS) {
        await app.openScreen(screen);
        const width = await documentWidth(app.page);
        assert.equal(width.document, width.screen, `экран «${screen}» растягивает страницу`);
      }
      assert.deepEqual(app.errors, []);
    });
  }

  for (const device of PHONES.slice(0, 2)) {
    test(`${device.name}: интерактивные области не меньше 44×44`, async () => {
      const app = await open({ viewport: { width: device.width, height: device.height } });
      for (const screen of CORE_SCREENS) {
        await app.openScreen(screen);
        const small = await smallTapTargets(app.page);
        assert.deepEqual(small, [], `мелкие области на «${screen}»: ${JSON.stringify(small)}`);
      }
    });
  }

  test("нижняя навигация содержит четыре пользовательских сценария", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    const labels = await app.page.$$eval(".bottom-nav button:not([hidden])", (nodes) =>
      nodes.filter((node) => getComputedStyle(node).display !== "none")
        .map((node) => (node.textContent || "").trim()),
    );
    assert.deepEqual(labels, ["Главная", "Тесты", "Дневник", "Профиль"]);
    assert.equal(await app.page.locator('.bottom-nav [data-target="development"]:visible').count(), 0);
  });

  test("главная не смешивает фокус с целями и задачами", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    const text = await app.page.textContent('[data-screen="today"]');
    assert.match(text, /Фокус на сегодня/i);
    assert.match(text, /О тебе сегодня/i);
    assert.match(text, /Твой путь/i);
    assert.match(text, /Можно продолжить/i);
    assert.equal(await app.page.locator('[data-screen="today"] #development-content').count(), 0);
    assert.equal(await app.page.locator('[data-screen="today"] #add-goal').count(), 0);
    assert.equal(await app.page.locator('[data-screen="today"] .hero-card').count(), 1);
    assert.equal(await app.page.locator('[data-screen="today"] .reward-card').count(), 1);
  });

  test("служебный trigger/streak остаётся связан с runtime, но не перегружает главную", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    const summary = await app.page.textContent("#today-summary");
    const streak = await app.page.textContent("#streak-days");
    assert.match(summary, /1 шаг и 1 инсайт|1 шаг на сегодня|Новый инсайт готов|Сегодняшний фокус готов|Остался 1 шаг до цели недели|Итог дня готов|Снимок недели готов|Ева заметила новый паттерн/i);
    assert.match(streak, /^\d+$/);
    assert.equal(await app.page.locator(".utility-bar:visible").count(), 0);
  });

  test("hero считывается как одно действие", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    const text = await app.page.textContent("#main-focus-card");
    assert.match(text, /сегодня/i);
    assert.match(text, /Продолжить|Выбрать шаг|Начать/i);
    assert.doesNotMatch(text, /Результат:/i);
    assert.equal(await app.page.locator('[data-screen="today"] .hero-cta').count(), 1);
  });

  test("hero CTA запускает действие без промежуточной формы", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    await app.page.click("#main-focus-action");
    await app.page.waitForTimeout(150);
    assert.equal(await app.page.locator("#focus-form").count(), 0);
    assert.ok(
      app.requests.some((item) => item.method === "POST" && item.path.includes("/public/v2/focus-sessions")),
      "focus session должна стартовать сразу по CTA",
    );
  });

  test("тесты доступны напрямую и не обещают ещё не подключённые опросники", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    await app.openScreen("discovery");
    assert.match(await app.page.textContent('[data-screen="discovery"] .screen-header'), /Узнай себя/i);
    const text = await app.page.textContent("#discovery-content");
    assert.match(text, /опросники/i);
    assert.match(text, /Скоро/i);
    assert.match(text, /Пока они недоступны/i);
  });

  test("reward короткий, персональный и не выглядит системным отчётом", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    const card = await app.page.textContent("#reward-card");
    const title = await app.page.textContent("#reward-title");
    const subtitle = await app.page.textContent("#reward-text");
    assert.match(card, /Маленькая победа|Новый инсайт|Ева заметила|Вопрос дня|Сильная сторона|Новый сдвиг|Есть один паттерн|Итог дня|Снимок недели/i);
    assert.doesNotMatch(card, /По цели|WebApp|production-сценарий|dashboard|системн/i);
    assert.ok(title.trim().length <= 82, `слишком длинный reward title: ${title}`);
    assert.ok(subtitle.trim().length <= 74, `слишком длинный reward subtitle: ${subtitle}`);
  });

  test("реализовано 5+ обычных типов variable reward и curiosity hook", () => {
    for (const label of ["Маленькая победа", "Новый инсайт", "Ева заметила", "Вопрос дня", "Сильная сторона", "Есть один паттерн"]) {
      assert.match(APP_SOURCE, new RegExp(label));
    }
    assert.match(APP_SOURCE, /rewardSeed/);
    assert.match(APP_SOURCE, /curiosityEvidenceAvailable/);
  });

  test("V2/V3 retention-слои не добавляют новый CTA на главный экран", () => {
    assert.match(APP_SOURCE, /weeklySnapshotReward/);
    assert.match(APP_SOURCE, /perfectWeek/);
    assert.match(APP_SOURCE, /shareMilestone/);
    assert.match(APP_SOURCE, /openSelfIntentionSheet/);
    assert.match(APP_SOURCE, /notificationTriggerCandidates/);
    assert.match(APP_SOURCE, /ritualState/);
    assert.doesNotMatch(APP_SOURCE, /leaderboard|монет|coins|XP-фарм/i);
  });

  test("activation считается только после action + reward + investment", () => {
    assert.match(APP_SOURCE, /activation_completed/);
    assert.match(APP_SOURCE, /action_completed_at/);
    assert.match(APP_SOURCE, /reward_viewed_at/);
    assert.match(APP_SOURCE, /investment_completed_at/);
    assert.match(APP_SOURCE, /first_value_ready/);
  });

  test("streak считает meaningful action, а не простое открытие", () => {
    assert.match(APP_SOURCE, /recordMeaningfulAction\("daily_step"/);
    assert.match(APP_SOURCE, /markInvestmentCompleted/);
    assert.doesNotMatch(APP_SOURCE, /recordMeaningfulAction\("app_open"/);
    assert.match(APP_SOURCE, /streak_shield_earned/);
  });

  test("реактивация покрывает 24h 48h 72h и 7d", () => {
    assert.match(APP_SOURCE, /stage: "24h"/);
    assert.match(APP_SOURCE, /stage: "48h"/);
    assert.match(APP_SOURCE, /stage: "72h"/);
    assert.match(APP_SOURCE, /stage: "7d"/);
    assert.match(APP_SOURCE, /reactivation_offer_seen/);
    assert.match(APP_SOURCE, /reactivation_recovered/);
  });

  test("аналитика и performance floor инструментированы", () => {
    assert.match(APP_SOURCE, /reward_impression/);
    assert.match(APP_SOURCE, /reward_viewed/);
    assert.match(APP_SOURCE, /investment_completed/);
    assert.match(APP_SOURCE, /cold_start_under_2s/);
    assert.match(APP_SOURCE, /api_p95_under_500ms/);
    assert.match(APP_SOURCE, /client_error/);
  });

  test("first-value onboarding короткий и без permissions", () => {
    assert.match(APP_SOURCE, /first_value_2_step/);
    assert.match(APP_SOURCE, /С чего лучше начать/);
    assert.match(APP_SOURCE, /Первый фокус готов/);
    assert.match(APP_SOURCE, /Сделать за 2 минуты/);
    assert.doesNotMatch(APP_SOURCE, /Notification\.requestPermission/);
  });

  test("push policy ограничивает частоту и ждёт first value", () => {
    assert.match(APP_SOURCE, /max_per_week: 3/);
    assert.match(APP_SOURCE, /min_per_week: 1/);
    assert.match(APP_SOURCE, /opt_in_allowed/);
    assert.match(APP_SOURCE, /generic_broadcast_allowed: false/);
  });

  test("streak milestone меняет reward, сохраняя ту же форму карточки", async () => {
    const app = await open({
      viewport: { width: 390, height: 844 },
      routes: {
        "/public/progress": { progress: { completed_results: [], work_blocks: [{ id: "w", local_date: "2026-08-19" }], streak_days: 7, weekly_steps_completed: 4, weekly_steps_target: 5, goals: [] } },
        "/public/v2/dashboard": { main_focus: { id: "goal:1", title: "Продолжить путь к запуску Евы", subtitle: "Разобрать один барьер перед запуском", planned_minutes: 6 }, streak_days: 7, weekly_progress: { done: 4, target: 5 } },
      },
    });
    const card = await app.page.textContent("#reward-card");
    assert.match(card, /7 дней в ритме/i);
    assert.match(card, /целую неделю/i);
  });

  test("скрытый streak-control сохраняет recovery-функцию", async () => {
    const app = await open({
      viewport: { width: 390, height: 844 },
      routes: {
        "/public/progress": { progress: { completed_results: [], work_blocks: [{ id: "w", local_date: utcDateKeyDaysAgo(1) }], streak_days: 5, weekly_steps_completed: 3, weekly_steps_target: 5, goals: [] } },
        "/public/v2/dashboard": { main_focus: { id: "goal:1", title: "Продолжить путь к запуску Евы", subtitle: "Разобрать один барьер перед запуском", planned_minutes: 6 }, streak_days: 5, weekly_progress: { done: 3, target: 5 } },
      },
    });
    await app.page.evaluate(() => document.getElementById("streak-button").click());
    await app.page.waitForSelector("#sheet[open]");
    const sheet = await app.page.textContent("#sheet");
    assert.match(sheet, /ЗАЩИТА СЕРИИ/i);
    assert.match(sheet, /Восстановить сегодня/i);
    assert.doesNotMatch(sheet, /потеряешь|сгорит|обнул/i);
  });

  test("после reward предлагается микро-инвестиция в память или профиль", async () => {
    const app = await open({ viewport: { width: 390, height: 844 }, journal: true });
    await app.page.click("#reward-action");
    await app.page.waitForSelector("#sheet[open]");
    const sheet = await app.page.textContent("#sheet");
    assert.match(sheet, /Сохранить инсайт/i);
    assert.match(sheet, /Отметить эмоцию/i);
    assert.match(sheet, /Добавить мысль/i);
    assert.match(sheet, /Продолжить профиль/i);
  });

  test("профиль самопонимания показывает накопление", async () => {
    const app = await open({
      viewport: { width: 390, height: 844 },
      routes: {
        "/public/profile": { profile: { user: { first_name: "Тест", city: "Москва", timezone: "Europe/Moscow", communication_style: "concise", response_mode: "voice" }, completion: { overall: 42, emotions: 80, relationships: 20, goals: 55 } } },
      },
    });
    const text = await app.page.textContent("#profile-investment");
    assert.match(text, /Профиль самопонимания/i);
    assert.match(text, /42%/);
    assert.match(text, /Эмоции 80%/);
    assert.match(text, /Отношения 20%/);
    assert.match(text, /Цели 55%/);
  });

  test("быстрые переключения формата ответа сохраняют последний выбор", async () => {
    let writes = 0;
    const app = await open({
      viewport: { width: 390, height: 844 },
      routes: {
        "PATCH /public/profile": async ({ body }) => {
          writes += 1;
          if (writes === 1) await new Promise((resolve) => setTimeout(resolve, 80));
          return { profile: { user: { response_mode: body.response_mode } } };
        },
      },
    });
    await app.openScreen("profile");
    await app.page.click('[data-setting="voice"]');
    await app.page.click('[data-response-mode="voice"]');
    await app.page.click('[data-response-mode="text"]');
    await app.page.waitForFunction(() => window.EvaApp.state.profile?.user?.response_mode === "text");
    const modes = app.requests.filter(({ method, path }) => method === "PATCH" && path === "/public/profile").map(({ body }) => body.response_mode);
    assert.deepEqual(modes, ["voice", "text"]);
  });

  test("Дневник содержит Записи и План, а цели находятся в Плане", async () => {
    const app = await open({ viewport: { width: 390, height: 844 }, journal: true });
    await app.openScreen("journal");
    assert.equal(await app.page.locator('[data-ios-journal-tab="notes"]').count(), 1);
    assert.equal(await app.page.locator('[data-ios-journal-tab="plan"]').count(), 1);
    assert.equal(await app.page.locator("#ios-journal-plan:not([hidden])").count(), 1);
    assert.equal(await app.page.locator('[data-screen="today"] #development-content').count(), 0);
  });

  test("journal остаётся в навигации даже если серверный модуль выключен", async () => {
    const app = await open({ viewport: { width: 360, height: 640 }, journal: false });
    assert.ok(await app.page.$("#journal-nav:not([hidden])"));
    await app.openScreen("journal");
    await app.page.click('[data-ios-journal-tab="notes"]');
    assert.match(await app.page.textContent("#journal-content"), /Дневник пока недоступен/i);
  });

  test("клик по профилю самопонимания открывает Тесты", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    await app.page.click("#profile-investment");
    assert.equal(await app.page.evaluate(() => window.EvaApp.state.screen), "discovery");
  });

  test("самопознание открывает существующий handoff к Еве", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    await app.openScreen("discovery");
    await app.page.click("#discovery-start");
    await app.page.waitForSelector("#sheet[open]");
    assert.match(await app.page.textContent("#sheet-title"), /Обсудить с Евой/i);
  });

  test("нижняя навигация не перекрывает последний блок главной", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    const data = await app.page.evaluate(() => {
      const screen = document.querySelector('[data-screen="today"]');
      screen.scrollTop = screen.scrollHeight;
      const nav = document.querySelector(".bottom-nav").getBoundingClientRect();
      const last = [...screen.children].filter((node) => !node.hidden && getComputedStyle(node).display !== "none").at(-1).getBoundingClientRect();
      return { navTop: nav.top, lastBottom: last.bottom };
    });
    assert.ok(data.lastBottom <= data.navTop - 6, JSON.stringify(data));
  });

  test("Личные данные открывают существующую форму профиля", async () => {
    const app = await open({ viewport: { width: 360, height: 640 } });
    await app.openScreen("profile");
    await app.page.click(".ios-personal-row");
    await app.page.waitForSelector("#profile-form");
    assert.ok(await app.page.locator('#profile-form [name="communication_style"]').count());
  });

  test("удаление дневниковой записи требует отдельного подтверждения", async () => {
    const app = await open({
      viewport: { width: 360, height: 640 },
      journal: true,
      routes: {
        "/public/v2/journal": { entries: [{ id: "9", local_date: "2026-08-19", title: "Проверить", content: "Запись", mood: "neutral", people: [], share_state: "private" }] },
        "/public/v2/journal/9": {},
      },
    });
    await app.openScreen("journal");
    await app.page.click('[data-ios-journal-tab="notes"]');
    await app.page.click('[data-journal-entry="9"]');
    await app.page.waitForSelector("#journal-delete");
    await app.page.click("#journal-delete");
    await app.page.waitForSelector("#confirm-dialog[open]");
    assert.equal(app.requests.filter((item) => item.method === "DELETE").length, 0);
    await app.page.click("#confirm-accept");
    await app.page.waitForTimeout(200);
    assert.equal(app.requests.filter((item) => item.method === "DELETE" && item.path.includes("/journal/9")).length, 1);
  });
});

// ---------------------------------------------------------------------
// Когда Ева пишет первой
// ---------------------------------------------------------------------

describe("окна инициативы", () => {
  const opened = [];
  const open = async (options) => {
    const app = await openApp(options);
    opened.push(app);
    return app;
  };
  after(async () => {
    for (const app of opened) await app.close().catch(() => {});
  });

  const WINDOWS = {
    "/public/proactive-windows": {
      proactive: {
        enabled: true,
        max_windows: 6,
        min_minutes: 15,
        timezone: "Europe/Moscow",
        windows: [{ id: "1", start_minute: 660, end_minute: 720, weekdays: [1, 2, 3, 4, 5], enabled: true }],
      },
    },
  };

  test("выбранное окно видно прямо в списке настроек", async () => {
    const app = await open({ routes: WINDOWS });
    await app.openScreen("profile");
    const status = await app.page.textContent('[data-setting="initiative"] em');
    assert.equal(status.trim(), "11:00–12:00");
    assert.deepEqual(app.errors, []);
  });

  test("окно редактируется и сохраняется одним набором", async () => {
    const app = await open({ routes: WINDOWS });
    await app.openScreen("profile");
    await app.page.click('[data-setting="initiative"]');
    await app.page.waitForSelector("#initiative-save");
    await app.page.click("#initiative-add");
    await app.page.waitForSelector('[data-window="1"]');
    await app.page.fill('[data-window="1"] input[data-field="start"]', "17:00");
    await app.page.fill('[data-window="1"] input[data-field="end"]', "18:00");
    await app.page.click("#initiative-save");
    await app.page.waitForTimeout(200);
    const saved = app.requests.find((item) => item.method === "PUT" && item.path === "/public/proactive-windows");
    assert.ok(saved, "сохранение обязано уйти одним запросом");
    assert.equal(saved.body.enabled, true);
    assert.equal(saved.body.windows.length, 2);
    assert.deepEqual(saved.body.windows.map((window) => [window.start_minute, window.end_minute]), [[660, 720], [1020, 1080]]);
    assert.deepEqual(app.errors, []);
  });

  test("последний день недели снять нельзя: окно без дней не сработает", async () => {
    const app = await open({ routes: WINDOWS });
    await app.openScreen("profile");
    await app.page.click('[data-setting="initiative"]');
    await app.page.waitForSelector('[data-window="0"]');
    for (const day of [1, 2, 3, 4, 5]) {
      await app.page.click(`[data-window="0"] [data-day="${day}"]`);
      await app.page.waitForTimeout(40);
    }
    const selected = await app.page.$$eval('[data-window="0"] .choice-button.is-selected', (nodes) => nodes.length);
    assert.equal(selected, 1, "хотя бы один день обязан остаться");
  });

  test("выключенное согласие названо прямо, а не спрятано", async () => {
    const app = await open({
      routes: {
        "/public/proactive-windows": { proactive: { enabled: false, max_windows: 6, min_minutes: 15, timezone: "Europe/Moscow", windows: [] } },
      },
    });
    await app.openScreen("profile");
    assert.equal((await app.page.textContent('[data-setting="initiative"] em')).trim(), "Выключено");
  });
});
