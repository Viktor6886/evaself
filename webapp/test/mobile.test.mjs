/**
 * Hook-focused Mini App: мобильная приёмка.
 *
 * Главный экран строится вокруг одного действия:
 * trigger → один hero CTA → variable reward → post-reward investment.
 * Тесты находятся только в «Рост», а нижняя навигация фиксирована:
 * Сегодня | Диалог | Дневник | Рост | Профиль.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, test } from "node:test";

import { DEVICES, PHONES, documentWidth, openApp, smallTapTargets } from "./harness.mjs";

const CORE_SCREENS = ["today", "journal", "development", "profile"];
const APP_SOURCE = readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");
const utcDateKeyDaysAgo = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

describe("Mini App hook-focused", () => {
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
    test(`${device.name}: основные экраны не прокручиваются вбок`, async () => {
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

  test("нижняя навигация имеет пять понятных сценариев", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    const labels = await app.page.$$eval(".bottom-nav button", (nodes) =>
      nodes.map((node) => (node.textContent || "").trim()),
    );
    assert.deepEqual(labels, ["Сегодня", "Диалог", "Дневник", "Рост", "Профиль"]);
    assert.doesNotMatch(labels.join(" "), /Органайзер|Пульт|Бюджет|Астро|Интеграц/i);
  });

  test("первый экран содержит один hero CTA и одну reward-карточку", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    assert.equal(await app.page.locator('[data-screen="today"] .hero-card').count(), 1);
    assert.equal(await app.page.locator('[data-screen="today"] .reward-card').count(), 1);
    assert.equal(await app.page.locator('[data-screen="today"] #tests-feature').count(), 0);
    assert.equal(await app.page.locator('[data-screen="today"] #checkin-card').count(), 0);

    const text = await app.page.textContent('[data-screen="today"]');
    assert.match(text, /Неделя: \d+ из \d+ шагов/i);
    assert.doesNotMatch(text, /Для тебя/i);
    assert.equal(await app.page.locator(".section-heading").count(), 0);
    assert.match(text, /Профиль самопонимания/i);
  });

  test("trigger-bar содержит только одну строку статуса и streak", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    const summary = await app.page.textContent("#today-summary");
    const streak = await app.page.textContent("#streak-days");
    const height = await app.page.locator(".utility-bar").evaluate((node) =>
      Math.round(node.getBoundingClientRect().height)
    );

    assert.equal(await app.page.locator("#greeting").count(), 0);
    assert.equal(await app.page.locator("#today-hint").count(), 0);
    assert.equal(await app.page.locator(".utility-copy").evaluate((node) => node.children.length), 1);
    assert.match(summary, /1 шаг и 1 инсайт|1 шаг на сегодня|Новый инсайт готов|Сегодняшний фокус готов|Остался 1 шаг до цели недели|Итог дня готов|Снимок недели готов|Ева заметила новый паттерн/i);
    assert.match(streak, /^\d+$/);
    assert.ok(height <= 46, `utility-bar слишком высокий: ${height}px`);
  });

  test("hero считывается как одно действие и один недельный прогресс", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    const text = await app.page.textContent("#main-focus-card");

    assert.match(text, /Сегодня/i);
    assert.match(text, /6 мин/i);
    assert.match(text, /Продолжить|Выбрать шаг/i);
    assert.match(text, /Неделя: \d+ из \d+ шагов/i);
    assert.doesNotMatch(text, /Результат:/i);
    assert.doesNotMatch(text, /Сфокусируйся|пользовательский путь/i);
    assert.equal(await app.page.locator('[data-screen="today"] .hero-cta').count(), 1);
  });

  test("при 4 из 5 hero показывает близость к недельной цели", async () => {
    const app = await open({
      viewport: { width: 390, height: 844 },
      routes: {
        "/public/v2/dashboard": {
          main_focus: {
            id: "goal:1",
            title: "Продолжить путь к запуску Евы",
            subtitle: "Разобрать один барьер перед запуском",
            planned_minutes: 6,
          },
          weekly_progress: { done: 4, target: 5 },
        },
        "/public/progress": {
          progress: {
            completed_results: [],
            work_blocks: [],
            streak_days: 4,
            weekly_steps_completed: 4,
            weekly_steps_target: 5,
            goals: [],
          },
        },
      },
    });

    const text = await app.page.textContent("#main-focus-card");
    assert.match(text, /Неделя: 4 из 5 шагов · Остался 1 шаг/i);
  });

  test("на главном экране только один primary CTA", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    assert.equal(await app.page.locator('[data-screen="today"] .hero-cta').count(), 1);
    assert.equal(await app.page.locator('[data-screen="today"] .primary-action').count(), 0);

    const rewardButton = await app.page.locator("#reward-action").evaluate((node) =>
      getComputedStyle(node).backgroundColor
    );
    const heroButton = await app.page.locator("#main-focus-action").evaluate((node) =>
      getComputedStyle(node).backgroundColor
    );
    assert.notEqual(rewardButton, heroButton, "reward CTA не должен конкурировать с hero CTA");
  });

  test("hero CTA запускает действие без промежуточной формы", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    await app.page.click("#main-focus-action");
    await app.page.waitForTimeout(150);

    assert.equal(await app.page.locator("#focus-form").count(), 0);
    assert.ok(
      app.requests.some((item) =>
        item.method === "POST" && item.path.includes("/public/v2/focus-sessions")
      ),
      "focus session должна стартовать сразу по CTA",
    );
  });

  test("тесты перенесены в Рост и не конкурируют с hero", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    await app.openScreen("development");
    await app.page.click('[data-development="tests"]');
    const text = await app.page.textContent("#development-content");
    assert.match(text, /Тесты и самопознание/i);
    assert.match(text, /Скоро/i);
    assert.match(text, /Профиль самопонимания/i);
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
    if (/Маленькая победа/i.test(card)) {
      assert.match(subtitle, /Теперь двигаться дальше проще/i);
    }
    assert.match(card, /Посмотреть|Открыть|Ответить/i);
  });

  test("реализовано 5+ обычных типов variable reward и curiosity hook", () => {
    for (const label of [
      "Маленькая победа",
      "Новый инсайт",
      "Ева заметила",
      "Вопрос дня",
      "Сильная сторона",
      "Есть один паттерн",
    ]) {
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
    assert.match(APP_SOURCE, /time_to_first_value_ms/);
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
        "/public/progress": {
          progress: {
            completed_results: [],
            work_blocks: [{ id: "w", local_date: "2026-08-19" }],
            streak_days: 7,
            weekly_steps_completed: 4,
            weekly_steps_target: 5,
            goals: [],
          },
        },
        "/public/v2/dashboard": {
          main_focus: {
            id: "goal:1",
            title: "Продолжить путь к запуску Евы",
            subtitle: "Разобрать один барьер перед запуском",
            planned_minutes: 6,
          },
          streak_days: 7,
          weekly_progress: { done: 4, target: 5 },
        },
      },
    });

    assert.equal(await app.page.locator("#reward-card").count(), 1);
    const card = await app.page.textContent("#reward-card");
    assert.match(card, /7 дней в ритме/i);
    assert.match(card, /целую неделю/i);
    assert.equal(await app.page.locator(".section-heading").count(), 0);
  });

  test("streak имеет мягкую защиту и восстановление через короткий шаг", async () => {
    const app = await open({
      viewport: { width: 390, height: 844 },
      routes: {
        "/public/progress": {
          progress: {
            completed_results: [],
            work_blocks: [{ id: "w", local_date: utcDateKeyDaysAgo(1) }],
            streak_days: 5,
            weekly_steps_completed: 3,
            weekly_steps_target: 5,
            goals: [],
          },
        },
        "/public/v2/dashboard": {
          main_focus: {
            id: "goal:1",
            title: "Продолжить путь к запуску Евы",
            subtitle: "Разобрать один барьер перед запуском",
            planned_minutes: 6,
          },
          streak_days: 5,
          weekly_progress: { done: 3, target: 5 },
        },
      },
    });

    await app.page.click("#streak-button");
    await app.page.waitForSelector("#sheet[open]");
    const sheet = await app.page.textContent("#sheet");
    assert.match(sheet, /ЗАЩИТА СЕРИИ/i);
    assert.match(sheet, /Восстановить сегодня/i);
    assert.match(sheet, /1 короткий шаг/i);
    assert.match(sheet, /3 · 7 · 14 · 30/i);
    assert.match(sheet, /НАМЕРЕНИЕ/i);
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

  test("профиль показывает накопление и следующий фокус", async () => {
    const app = await open({
      viewport: { width: 390, height: 844 },
      routes: {
        "/public/profile": {
          profile: {
            user: {
              first_name: "Тест",
              city: "Москва",
              timezone: "Europe/Moscow",
              communication_style: "concise",
              response_mode: "voice",
            },
            completion: {
              overall: 42,
              emotions: 80,
              relationships: 20,
              goals: 55,
            },
          },
        },
      },
    });
    const text = await app.page.textContent("#profile-investment");

    assert.match(text, /Профиль самопонимания/i);
    assert.match(text, /42%/);
    assert.match(text, /Дальше: отношения/i);
    assert.match(text, /Эмоции 80%/);
    assert.match(text, /Отношения 20%/);
    assert.match(text, /Цели 55%/);
    assert.match(text, /Больше контекста|точнее выводы|устойчивый контекст/i);
    assert.match(text, /Продолжить/i);
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

    const modes = app.requests
      .filter(({ method, path }) => method === "PATCH" && path === "/public/profile")
      .map(({ body }) => body.response_mode);
    assert.deepEqual(modes, ["voice", "text"]);
  });

  test("journal остаётся в навигации даже если серверный модуль выключен", async () => {
    const app = await open({ viewport: { width: 360, height: 640 }, journal: false });
    assert.ok(await app.page.$("#journal-nav:not([hidden])"));
    await app.openScreen("journal");
    const text = await app.page.textContent("#journal-content");
    assert.match(text, /Дневник пока недоступен/i);
  });

  test("клик по профилю самопонимания открывает Рост → Тесты", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    await app.page.click("#profile-investment");
    assert.equal(await app.page.evaluate(() => window.EvaApp.state.screen), "development");
    assert.equal(await app.page.evaluate(() => window.EvaApp.state.developmentTab), "tests");
  });

  test("Диалог открывает handoff к Еве, а не отдельный дублирующий экран", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    await app.page.click("#dialog-nav");
    await app.page.waitForSelector("#sheet[open]");
    assert.match(await app.page.textContent("#sheet-title"), /Обсудить с Евой/i);
  });

  test("нижняя навигация не перекрывает контент после прокрутки", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    const data = await app.page.evaluate(() => {
      const screen = document.querySelector('[data-screen="today"]');
      screen.scrollTop = screen.scrollHeight;
      const nav = document.querySelector(".bottom-nav").getBoundingClientRect();
      const last = [...screen.children].filter((node) => !node.hidden).at(-1).getBoundingClientRect();
      return { navTop: nav.top, lastBottom: last.bottom };
    });
    assert.ok(data.lastBottom <= data.navTop - 6, JSON.stringify(data));
  });

  test("клавиатура не накрывает поле профиля", async () => {
    const app = await open({ viewport: { width: 360, height: 640 } });
    await app.openScreen("profile");
    await app.page.click("#edit-profile");
    await app.page.waitForSelector("#profile-form");
    await app.page.evaluate(() => {
      document.documentElement.style.setProperty("--keyboard", "260px");
    });
    const field = app.page.locator('#profile-form [name="communication_style"]');
    await field.focus();
    await app.page.waitForTimeout(400);
    const visible = await field.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { bottom: box.bottom, limit: window.innerHeight - 260 };
    });
    assert.ok(visible.bottom <= visible.limit + 1, JSON.stringify(visible));
  });

  test("удаление дневниковой записи требует отдельного подтверждения", async () => {
    const app = await open({
      viewport: { width: 360, height: 640 },
      journal: true,
      routes: {
        "/public/v2/journal": {
          entries: [{
            id: "9",
            local_date: "2026-08-19",
            title: "Проверить",
            content: "Запись",
            mood: "neutral",
            people: [],
            share_state: "private",
          }],
        },
        "/public/v2/journal/9": {},
      },
    });
    await app.openScreen("journal");
    await app.page.click('[data-journal-entry="9"]');
    await app.page.waitForSelector("#journal-delete");
    await app.page.click("#journal-delete");
    await app.page.waitForSelector("#confirm-dialog[open]");
    assert.equal(app.requests.filter((item) => item.method === "DELETE").length, 0);
    await app.page.click("#confirm-accept");
    await app.page.waitForTimeout(200);
    assert.equal(
      app.requests.filter((item) => item.method === "DELETE" && item.path.includes("/journal/9")).length,
      1,
    );
  });
});
