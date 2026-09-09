/**
 * Панель на телефоне.
 *
 * Проверяется одно свойство, которое нельзя увидеть в коде и легко
 * потерять при любой правке вёрстки: страница не должна прокручиваться
 * вбок. На телефоне это худшее, что может случиться, — содержимое
 * уезжает под край экрана, и промахиваешься мимо всего сразу.
 *
 * Раздел STT именно так и был сломан: три вкладки не помещались в
 * строку шириной 360 и растягивали документ до 456 пикселей.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { DEVICES, openPanel, PHONE, smallTapTargets } from "./harness.mjs";

const svc = (name, color) => ({
  name, title: name,
  status: { color, enabled: true, message: "", last_check_at: "2026-08-01T10:00:00Z" },
});

const OVERVIEW = {
  installation: { version: "0.4.2" },
  verdict: { color: "green", title: "Все сервисы работают", detail: "" },
  groups: { core: [svc("eva-agent-service", "green"), svc("media-service", "green")] },
  host: {
    load_average: [0.4, 0.5, 0.6], cpu_count: 4,
    memory_total_bytes: 8 * 2 ** 30, memory_free_bytes: 3 * 2 ** 30,
    disk_total_bytes: 100 * 2 ** 30, disk_free_bytes: 38 * 2 ** 30,
    uptime_seconds: 372_000, hostname: "eva-prod",
  },
};

const CONFIG = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Deepgram production", provider: "deepgram", mode: "batch",
  base_url: "https://api.deepgram.com/v1/listen", model: "nova-3",
  public_config: {}, status: "healthy", config_version: 1, archived: false,
  used_by: ["telegram_voice"], last_test: { at: null, ok: null },
  secret: { configured: true }, keys: { total: 3, usable: 2, exhausted: 1, invalid: 0 },
};

// Провайдер приходит одной записью из /llm/state: конфигурация,
// возможности, маршруты, breaker и расход вместе. Имя модели длинное,
// а сообщение проверки — в три строки: ровно то, что и вылезало.
const PROVIDER = {
  id: "p1", name: "Openrouter2", protocol: "openai-compatible",
  base_url: "https://openrouter.ai/api/v1", model: "minimax/minimax-m3:free",
  context_window: 1_000_000, is_active: true, enabled: true, api_key_configured: true,
  supports_tools: true, supports_json: true, supports_vision: false, supports_streaming: true,
  breaker_state: "closed", pinned_out: false,
  // Имена — те же, что отдаёт v_llm_provider_health. Значения нарочно
  // крупные: пятизначная задержка и двузначный расход и растягивали
  // карточку за край экрана.
  requests_1h: 1284, failures_1h: 17, p95_latency_ms: 12480,
  spent_today_micro: 1234560, spent_month_micro: 98765432,
  daily_budget_micro: 2000000, monthly_budget_micro: 150000000,
  priority: 10, last_error_code: "429", probe_after: "2026-08-25T21:00:00Z",
  last_checked_at: "2026-08-25T20:46:18Z",
  last_check_ok: true, last_check_status: "limited",
  last_check_message: "Подключение работает; получено моделей: 418. "
    + "Модель работает с ограничениями: vision: пустой ответ на изображение; "
    + "finish_reason=stop, допустимый output budget=4096.",
  last_models: null, additional_parameters: {},
  status: {
    code: "limited", label: "работает с ограничениями", color: "yellow",
    detail: { check: "limited", router: "closed" },
  },
  routes: [{ code: "chat", title: "Основная модель", position: 0 }],
  single_selected: false,
  created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-25T20:46:18Z",
};
const PROVIDERS = { providers: [PROVIDER] };
const STATE = {
  providers: [PROVIDER],
  routes: [
    { code: "chat", title: "Основная модель", min_context_window: 32768, rotation_enabled: true,
      chain: [{ provider_id: "p1", name: "Openrouter2", model: "minimax/minimax-m3:free", protocol: "openai-compatible", enabled: true }] },
    { code: "vision", title: "Изображения", min_context_window: 8192, rotation_enabled: true, chain: [] },
    { code: "deep", title: "Мощная модель", min_context_window: 32768, rotation_enabled: true, chain: [] },
  ],
  // Один и тот же отказ десять раз — ровно то, что и было в панели.
  recent_failures: Array.from({ length: 10 }, (_, index) => ({
    provider: "Openrouter2", switch_reason: "rate_limited", http_status: 429,
    started_at: `2026-08-25T2${index % 2}:01:42Z`,
    error_summary: "лимит запросов провайдера: Provider returned error",
  })),
  routing_settings: { mode: "adaptive", updated_at: "2026-08-01T00:00:00Z" },
};

const ROUTES = {
  "/overview": OVERVIEW,
  // Без состояния роутера раздел ИИ рисует пустую заглушку, и проверка
  // целей касания смотрит на страницу без единой кнопки маршрута.
  "/llm/state": STATE,
  "/providers": PROVIDERS,
  "/stt/provider-schemas": { providers: [] },
  "/stt/configs": { configs: [CONFIG] },
  "/stt/routes": {
    routes: [{
      use_case: "telegram_voice", enabled: true, rotation_enabled: true,
      timeout_ms: 120000, max_audio_seconds: 1800, config_version: 4,
      chain: [{
        position: 0, config_id: CONFIG.id, name: "Deepgram production",
        provider: "deepgram", model: "nova-3", status: "healthy",
      }],
    }],
  },
  // Раздел «Операции» строит две таблицы: без этих ответов проверять
  // карточный режим не на чем.
  "/backups": {
    backups: [{
      id: "b1", created_at: "2026-08-01T03:00:00Z", size_bytes: 1024 * 1024 * 12,
      status: "ok", encrypted: true, location: "s3",
    }],
  },
  "/updates": {
    current: { version: "0.4.2", channel: "stable", updated_at: "2026-08-01T03:00:00Z" },
    history: [{
      started_at: "2026-08-01T03:00:00Z", component: "eva-agent-service",
      from_version: "0.4.1", to_version: "0.4.2", status: "success", rolled_back: false,
    }],
  },
  [`/stt/configs/${CONFIG.id}/keys`]: {
    keys: Array.from({ length: 6 }, (_, index) => ({
      id: `aaaaaaaa-0000-0000-0000-00000000000${index}`,
      label: `Ключ ${index + 1}`, position: index * 10, enabled: true,
      status: "active", cooldown_until: null, last_error_code: null,
      success_count: 0, failure_count: 0,
    })),
  },
};

/** Ширина документа против ширины экрана — та самая боковая прокрутка. */
const documentWidth = (page) => page.evaluate(() => ({
  document: document.documentElement.scrollWidth,
  screen: window.innerWidth,
}));

describe("панель на телефоне", () => {
  const panels = [];
  const open = async (options) => {
    const panel = await openPanel({ ...options, viewport: PHONE });
    panels.push(panel);
    return panel;
  };
  after(async () => {
    for (const panel of panels) await panel.close().catch(() => {});
  });

  test("ни один раздел не прокручивается вбок", async () => {
    const panel = await open({ routes: ROUTES });
    const pages = await panel.page.evaluate(() =>
      [...document.querySelectorAll("#nav .nav-item")].map((item) => item.dataset.page));
    assert.ok(pages.length >= 8, "разделы должны быть найдены");

    for (const name of pages) {
      await panel.page.evaluate((page) => openPage(page), name);
      await panel.page.waitForTimeout(120);
      const width = await documentWidth(panel.page);
      assert.equal(
        width.document, width.screen,
        `раздел «${name}» растягивает страницу до ${width.document} при экране ${width.screen}`,
      );
    }
  });

  /*
   * Раздел, до которого нельзя дотянуться, отсутствует — но выглядит
   * присутствующим.
   *
   * Список разделов вырос до тысячи с лишним пикселей, а выехавшее меню
   * — это высота экрана с `overflow: visible`. «Системные настройки»,
   * «Безопасность и ключи» и «Журнал событий» на телефоне просто не
   * пролезали: ни ошибки, ни обрезанного края — они молча были ниже
   * экрана, и открыть их было нельзя вовсе.
   */
  test("до последнего раздела меню можно дотянуться прокруткой", async () => {
    for (const size of [{ width: 320, height: 568 }, PHONE]) {
      const panel = await openPanel({ routes: ROUTES, viewport: size });
      panels.push(panel);
      await panel.page.evaluate(() => setSidebar(true));
      await panel.page.waitForTimeout(150);

      const state = await panel.page.evaluate(() => {
        const bar = document.querySelector(".sidebar");
        return {
          scrollable: getComputedStyle(bar).overflowY,
          hidden: bar.scrollHeight > bar.clientHeight,
        };
      });
      // Содержимое выше ящика — это норма; недопустимо, когда его при
      // этом нельзя прокрутить.
      if (state.hidden) {
        assert.match(
          state.scrollable, /auto|scroll/,
          `${size.width}: меню не прокручивается, а содержимое в него не помещается`,
        );
      }

      const reached = await panel.page.evaluate(() => {
        const bar = document.querySelector(".sidebar");
        const items = [...document.querySelectorAll(".nav-item")];
        const last = items[items.length - 1];
        bar.scrollTop = bar.scrollHeight;
        const box = last.getBoundingClientRect();
        return {
          page: last.dataset.page,
          visible: box.top >= 0 && box.bottom <= window.innerHeight + 1,
        };
      });
      assert.ok(
        reached.visible,
        `${size.width}: до раздела «${reached.page}» нельзя дотянуться даже прокруткой`,
      );
    }
  });

  /*
   * Выехавшее меню накрывает содержимое, а не просвечивает сквозь себя.
   * У боковой панели фон был на 94 % непрозрачности: в своей колонке на
   * широком экране разницы нет, а поверх страницы сквозь список разделов
   * читался чужой текст.
   */
  test("выехавшее меню непрозрачно", async () => {
    const panel = await open({ routes: ROUTES });
    await panel.page.evaluate(() => setSidebar(true));
    await panel.page.waitForTimeout(150);
    const alpha = await panel.page.evaluate(() => {
      const value = getComputedStyle(document.querySelector(".sidebar")).backgroundColor;
      const parts = value.match(/[\d.]+/g) ?? [];
      return parts.length > 3 ? Number(parts[3]) : 1;
    });
    assert.equal(alpha, 1, `фон меню полупрозрачен (alpha ${alpha})`);
  });

  test("вкладки раздела STT переносятся, а не уезжают за экран", async () => {
    const panel = await open({ routes: ROUTES });
    await panel.page.evaluate(() => openPage("stt"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-configs .status-card").length > 0);

    // Именно вкладки STT: такие же есть и в других разделах.
    const tabs = await panel.page.$$eval("#page-stt .tab", (nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { right: box.right, height: box.height };
    }));
    assert.equal(tabs.length, 3);
    for (const tab of tabs) {
      assert.ok(tab.right <= PHONE.width + 1, "вкладка не должна выходить за экран");
      // Палец — не мышь: ниже сорока пикселей начинаются промахи.
      assert.ok(tab.height >= 40, `высота вкладки ${tab.height} мала для касания`);
    }
  });

  test("цепочка провайдеров читается и управляется с телефона", async () => {
    const panel = await open({ routes: ROUTES });
    await panel.page.evaluate(() => openPage("stt"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-configs .status-card").length > 0);
    await panel.page.click('[data-stt-tab="routes"]');
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-routes .chain-link").length > 0);

    const overflowing = await panel.page.evaluate(() => {
      const bad = [];
      for (const node of document.querySelectorAll("#stt-routes *")) {
        const box = node.getBoundingClientRect();
        if (box.width > 0 && box.right > window.innerWidth + 1) bad.push(node.className);
      }
      return bad;
    });
    assert.deepEqual(overflowing, []);

    // Выключатель ротации должен быть на экране, а не только в вёрстке.
    const toggle = await panel.page.$eval(
      '[data-route-field="rotation_enabled"]', (node) => node.checked);
    assert.equal(toggle, true);
  });

  test("длинный диалог помещается в экран и прокручивается внутри себя", async () => {
    const panel = await open({ routes: ROUTES });
    await panel.page.evaluate(() => openPage("stt"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-configs .status-card").length > 0);
    await panel.page.click('[data-stt-action="key"]');
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-key-list .key-row").length === 6);

    const dialog = await panel.page.evaluate(() => {
      const node = document.querySelector("#stt-key-dialog");
      const box = node.getBoundingClientRect();
      return {
        fitsWidth: box.left >= -1 && box.right <= window.innerWidth + 1,
        bottomOnScreen: box.bottom <= window.innerHeight + 1,
        scrollsInside: node.scrollHeight > node.clientHeight,
      };
    });
    assert.equal(dialog.fitsWidth, true, "диалог не должен выходить за края");
    // Шесть ключей в 740 пикселей не влезают — значит, прокрутка должна
    // быть у самого диалога, а не у страницы под ним.
    assert.equal(dialog.bottomOnScreen, true, "низ диалога должен быть на экране");
    assert.equal(dialog.scrollsInside, true, "содержимое должно прокручиваться внутри");
  });

  test("боковое меню закрывается тычком мимо и клавишей Escape", async () => {
    const panel = await open({ routes: ROUTES });
    const state = () => panel.page.evaluate(() => ({
      open: document.querySelector(".sidebar").classList.contains("open"),
      scrim: document.querySelector("#sidebar-scrim").classList.contains("show"),
      expanded: document.querySelector("#menu").getAttribute("aria-expanded"),
    }));

    await panel.page.click("#menu");
    assert.deepEqual(await state(), { open: true, scrim: true, expanded: "true" });

    // Панель занимает 260 пикселей слева; тычок правее — мимо неё.
    await panel.page.mouse.click(340, 420);
    await panel.page.waitForTimeout(150);
    assert.deepEqual(await state(), { open: false, scrim: false, expanded: "false" });

    await panel.page.click("#menu");
    await panel.page.keyboard.press("Escape");
    await panel.page.waitForTimeout(150);
    assert.equal((await state()).open, false, "Escape тоже должен закрывать меню");
  });

  // -------------------------------------------------------------------
  // Матрица разрешений шага 26
  // -------------------------------------------------------------------

  for (const device of DEVICES) {
    test(`${device.name}: ни один раздел не уезжает вбок`, async () => {
      const panel = await openPanel({
        routes: ROUTES,
        viewport: { width: device.width, height: device.height },
      });
      panels.push(panel);
      const pages = await panel.page.evaluate(() =>
        [...document.querySelectorAll("#nav .nav-item")].map((item) => item.dataset.page));
      for (const name of pages) {
        await panel.page.evaluate((page) => openPage(page), name);
        await panel.page.waitForTimeout(80);
        const width = await panel.page.evaluate(() => ({
          document: document.documentElement.scrollWidth,
          screen: window.innerWidth,
        }));
        assert.equal(
          width.document, width.screen,
          `раздел «${name}» на ${device.name} растягивает страницу до ${width.document}`,
        );
      }
    });
  }

  test("на телефоне таблица становится карточками с подписями полей", async () => {
    const panel = await open({ routes: ROUTES });
    await panel.page.evaluate(() => openPage("operations"));
    // `#update-history` — это сам tbody: строки лежат прямо в нём.
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#update-history tr").length > 0);

    const layout = await panel.page.evaluate(() => {
      const cell = document.querySelector("#update-history td");
      const table = document.querySelector("#update-history").closest("table");
      return {
        display: getComputedStyle(cell).display,
        label: cell.dataset.label ?? null,
        headHidden: getComputedStyle(table.querySelector("thead")).position === "absolute",
        rowWidth: document.querySelector("#update-history tr").getBoundingClientRect().width,
      };
    });
    // Подпись столбца стоит у самой ячейки: заголовок таблицы на узком
    // экране не виден, и без неё число ни о чём не говорит.
    assert.ok(layout.label, "ячейка обязана нести подпись своего столбца");
    assert.equal(layout.display, "grid", "строка должна раскладываться карточкой");
    assert.equal(layout.headHidden, true, "заголовок таблицы уходит с экрана");
    assert.ok(layout.rowWidth <= PHONE.width, "карточка не шире экрана");
  });

  /*
   * Подпись поля не рвётся посреди слова.
   *
   * Колонка подписи фиксированной ширины, и «ПРОИСХОЖДЕНИЕ» в неё не
   * влезало на шесть пикселей: `overflow-wrap: anywhere`, нужный длинным
   * путям и отпечаткам в значениях, ломал слово на «ПРОИСХОЖДЕНИ» и «Е».
   * Читается это как опечатка в интерфейсе.
   *
   * Проверяется не конкретная подпись, а правило: ни одной подписи не
   * должно быть тесно. Следующая длинная подпись сломает этот тест, а не
   * вёрстку у оператора.
   */
  test("ни одна подпись поля не рвётся посреди слова", async () => {
    const panel = await open({ routes: ROUTES });
    const pages = await panel.page.evaluate(() =>
      [...document.querySelectorAll("#nav .nav-item")].map((item) => item.dataset.page));

    const tight = [];
    for (const name of pages) {
      await panel.page.evaluate((page) => openPage(page), name);
      await panel.page.waitForTimeout(120);
      tight.push(...await panel.page.evaluate((section) => {
        const found = [];
        const probe = document.createElement("span");
        probe.style.position = "absolute";
        probe.style.visibility = "hidden";
        probe.style.whiteSpace = "nowrap";
        document.body.appendChild(probe);
        for (const cell of document.querySelectorAll("td[data-label]")) {
          const style = getComputedStyle(cell);
          if (style.display !== "grid") continue;
          const track = parseFloat(style.gridTemplateColumns.split(" ")[0]);
          if (!Number.isFinite(track)) continue;
          const label = getComputedStyle(cell, "::before");
          probe.style.font = label.font;
          probe.style.letterSpacing = label.letterSpacing;
          probe.style.textTransform = label.textTransform;
          probe.textContent = cell.dataset.label;
          const need = probe.getBoundingClientRect().width;
          // Однословной подписи переноситься некуда: ей обязано хватить.
          if (!cell.dataset.label.includes(" ") && need > track) {
            found.push({ section, label: cell.dataset.label, need: Math.round(need), track });
          }
        }
        probe.remove();
        return found;
      }, name));
    }
    assert.deepEqual(
      tight, [],
      `подписи не помещаются в свою колонку и порвутся по букве: ${JSON.stringify(tight)}`,
    );
  });

  test("на телефоне до каждой кнопки раздела можно дотянуться", async () => {
    const panel = await open({ routes: ROUTES });
    // Раздел ИИ сюда добавлен после того, как кнопки маршрутов в карточке
    // провайдера оказались втрое мельче цели касания: страница, на которую
    // жалуются с телефона, обязана проверяться наравне с остальными.
    for (const name of ["overview", "operations", "stt", "ai"]) {
      await panel.page.evaluate((page) => openPage(page), name);
      await panel.page.waitForTimeout(120);
      const small = await smallTapTargets(panel.page);
      assert.deepEqual(
        small, [],
        `в разделе «${name}» есть области нажатия меньше 44×44: ${JSON.stringify(small)}`,
      );
    }
  });

  test("опасное действие требует подтверждения и не срабатывает от касания", async () => {
    const panel = await open({ routes: ROUTES });
    await panel.page.evaluate(() => openPage("stt"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-configs .status-card").length > 0);
    await panel.page.click('[data-stt-action="key"]');
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-key-list .key-row").length === 6);

    const before = panel.requests.filter((item) => item.method === "DELETE").length;
    await panel.page.click('[data-key-action="remove"]');
    await panel.page.waitForFunction(() => document.querySelector("#confirm-dialog").open);
    assert.equal(
      panel.requests.filter((item) => item.method === "DELETE").length, before,
      "удаление ключа ушло на сервер до подтверждения",
    );
    // Фокус на отмене: случайный Enter не должен стирать секрет.
    const focused = await panel.page.evaluate(() => document.activeElement?.value);
    assert.equal(focused, "cancel");
  });

  test("на широком экране вёрстка остаётся прежней", async () => {
    // Мобильные правила не должны протечь на ноутбук: диалог там
    // по-прежнему окно по центру, а не лист снизу.
    const panel = await openPanel({ routes: ROUTES, viewport: { width: 1440, height: 900 } });
    panels.push(panel);
    await panel.page.evaluate(() => openPage("stt"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-configs .status-card").length > 0);

    const dialog = await panel.page.evaluate(() => {
      const node = document.querySelector("#stt-key-dialog");
      node.showModal();
      const box = node.getBoundingClientRect();
      const radius = getComputedStyle(node).borderBottomLeftRadius;
      node.close();
      return { width: Math.round(box.width), radius };
    });
    assert.ok(dialog.width <= 620, "на широком экране диалог не растягивается во всю ширину");
    assert.notEqual(dialog.radius, "0px", "нижние углы скругляются только у листа снизу");
  });
});

/**
 * Раздел «Искусственный интеллект» на телефоне.
 *
 * Три вещи ломались именно здесь и именно на узком экране: описание
 * ошибки в строке отказа налезало на заголовок, строка назначений
 * провайдера вылезала за карточку, а восемь развёрнутых маршрутов давали
 * несколько экранов прокрутки. Первые две не видны ни в коде, ни на
 * широком экране — только измерением.
 */
describe("раздел ИИ на телефоне", () => {
  let panel;
  after(async () => await panel?.close());

  test("ничего не налезает друг на друга и не вылезает за экран", async () => {
    panel = await openPanel({
      routes: { ...ROUTES, "/providers": PROVIDERS, "/llm/state": STATE },
      viewport: PHONE,
    });
    await panel.page.evaluate(() => openPage("ai"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#providers-list .provider-card").length > 0);
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#router-failures .failure-row").length > 0);

    const layout = await panel.page.evaluate((width) => {
      const overflowing = [];
      const scope = document.querySelector("#page-ai");
      for (const node of scope.querySelectorAll("*")) {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.right > width + 1) overflowing.push(node.className || node.tagName);
      }
      // Наложение: заголовок отказа и его подробность обязаны лежать в
      // разных строках, а не в соседних колонках одной.
      const row = document.querySelector("#router-failures .failure-row");
      const title = row.querySelector(".failure-title").getBoundingClientRect();
      const more = row.querySelector(".failure-more");
      return {
        overflowing: overflowing.slice(0, 5),
        documentWidth: document.documentElement.scrollWidth,
        failureRows: document.querySelectorAll("#router-failures .failure-row").length,
        countBadge: row.querySelector(".failure-count")?.textContent ?? null,
        detailBelowTitle: more ? more.getBoundingClientRect().top >= title.bottom : true,
        openRoutes: scope.querySelectorAll(".route-item[open]").length,
        totalRoutes: scope.querySelectorAll(".route-item").length,
        // Провайдер рисуется ровно одной карточкой. Отдельного списка
        // «Состояние провайдеров», повторявшего тех же провайдеров с
        // другим набором фактов, в разделе больше нет.
        cards: scope.querySelectorAll(".provider-card").length,
        healthRows: scope.querySelectorAll(".health-row").length,
        // Место в маршрутах — в самой карточке, и оба факта про маршрут
        // (имя и позиция) обязаны лежать в разных колонках, а не
        // накладываться друг на друга.
        routeChips: [...scope.querySelectorAll(".provider-route")].map((node) => {
          const name = node.querySelector(".provider-route-name").getBoundingClientRect();
          const rank = node.querySelector(".provider-route-rank").getBoundingClientRect();
          return { text: node.textContent.trim(), overlap: rank.left < name.right - 0.5 };
        }),
        // Полная схема маршрутов свёрнута: разворачивают её тогда, когда
        // правят цепочку целиком.
        routesCardOpen: document.querySelector("#router-routes-card")?.open ?? null,
        // Числа эксплуатации видны сразу, без разворачивания.
        facts: [...scope.querySelectorAll(".provider-facts dd")].map((node) => node.textContent),
        // Техническая справка по умолчанию свёрнута.
        diagnosticsOpen: scope.querySelector(".provider-diagnostics")?.open ?? null,
      };
    }, PHONE.width);

    assert.deepEqual(layout.overflowing, [], "элементы раздела выходят за экран");
    assert.ok(layout.documentWidth <= PHONE.width,
      `страница шире экрана: ${layout.documentWidth}`);
    // Десять одинаковых отказов сводятся в одну строку со счётчиком.
    assert.equal(layout.failureRows, 1, "одинаковые отказы обязаны схлопываться");
    assert.equal(layout.countBadge, "10×");
    assert.equal(layout.detailBelowTitle, true,
      "подробность отказа лежит под заголовком, а не рядом с ним");
    // Маршруты свёрнуты: список показывает, кто их обслуживает, а не
    // повторяет одних и тех же провайдеров в каждом.
    assert.equal(layout.openRoutes, 0, "маршруты по умолчанию свёрнуты");
    assert.equal(layout.totalRoutes, 3);
    assert.equal(layout.routesCardOpen, false, "полная схема маршрутов свёрнута");

    // Один провайдер — одна карточка.
    assert.equal(layout.cards, 1, "провайдер нарисован дважды");
    assert.equal(layout.healthRows, 0,
      "отдельный список «Состояние провайдеров» повторяет карточки");
    assert.equal(layout.routeChips.length, 1);
    assert.match(layout.routeChips[0].text, /Основная модель/);
    assert.match(layout.routeChips[0].text, /основной/);
    assert.equal(layout.routeChips[0].overlap, false,
      "позиция в маршруте налезает на его название");

    // Четыре числа, из-за которых в карточку и приходят, — на виду.
    assert.deepEqual(layout.facts, ["1284 · ошибок 17", "12480 мс", "$1.23", "$98.77"]);
    assert.equal(layout.diagnosticsOpen, false,
      "техническая справка не должна быть развёрнута по умолчанию");
  });

  /**
   * Карточка не рисует кнопку, которую роль не может выполнить.
   *
   * Раньше «Проверить» и «Изменить» показывались всем, и viewer узнавал
   * о своих правах из 403 после нажатия. Роли здесь ровно те же, что
   * объявлены у маршрутов: правка — owner/admin, проверка — ещё и
   * operator.
   */
  for (const [role, expected] of [["viewer", []], ["operator", ["check"]]]) {
    test(`${role} видит состояние и только разрешённые ему действия`, async () => {
      const limited = await openPanel({
        routes: { ...ROUTES, "/providers": PROVIDERS, "/llm/state": STATE },
        viewport: PHONE, role,
      });
      try {
        await limited.page.evaluate(() => openPage("ai"));
        await limited.page.waitForFunction(
          () => document.querySelectorAll("#providers-list .provider-card").length > 0);
        const card = await limited.page.evaluate(() => {
          const node = document.querySelector("#providers-list .provider-card");
          return {
            status: node.querySelector(".status-pill")?.textContent.trim(),
            routeChip: node.querySelector(".provider-route")?.textContent.trim(),
            actions: [...node.querySelectorAll("[data-provider-action]")]
              .map((button) => button.dataset.providerAction),
            routeActions: node.querySelectorAll(".provider-route-actions").length,
            addRoute: node.querySelectorAll(".provider-route-add").length,
          };
        });
        // Читать состояние роль обязана: раздел для неё не пустой.
        assert.equal(card.status, "работает с ограничениями");
        assert.match(card.routeChip, /Основная модель/);
        assert.deepEqual(card.actions, expected);
        // Маршруты не правятся ни той, ни другой ролью.
        assert.equal(card.routeActions, 0);
        assert.equal(card.addRoute, 0);
      } finally {
        await limited.close();
      }
    });
  }
});
