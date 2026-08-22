/**
 * Обвязка браузерных тестов Mini App.
 *
 * Статика отдаётся по http, а не открывается как file://: app.js ходит
 * к API по абсолютному пути `/api`, и со страницы file:// это
 * превращается в `file:///api/...` — запрос не доходит до перехватчика
 * и падает ещё до того, как тест что-нибудь проверит. По http адрес
 * получается тот же, что за Caddy в рабочей установке.
 *
 * Telegram подменяется до загрузки скриптов: `telegram-web-app.js`
 * приходит с внешнего домена, которого в тесте нет, а без `initData`
 * приложение честно отказывается работать вне Telegram.
 */

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(HERE, "..", "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * Матрица разрешений из задания шага 26. Ниже 320 телефонов нет, выше
 * 430 начинается планшет, а десктоп нужен, чтобы мобильные правила не
 * протекли на широкий экран.
 */
export const DEVICES = [
  { name: "320×568", width: 320, height: 568 },
  { name: "360×640", width: 360, height: 640 },
  { name: "375×667", width: 375, height: 667 },
  { name: "390×844", width: 390, height: 844 },
  { name: "412×915", width: 412, height: 915 },
  { name: "430×932", width: 430, height: 932 },
  { name: "768×1024", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

export const PHONES = DEVICES.filter((device) => device.width <= 430);

async function servePublic() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const name = url.pathname === "/" ? "/index.html" : url.pathname;
    const target = path.join(PUBLIC_DIR, path.normalize(name).replace(/^(\.\.[/\\])+/, ""));
    if (!target.startsWith(PUBLIC_DIR)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(target);
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(target)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function launchOptions() {
  const executablePath = process.env.EVA_CHROMIUM_PATH;
  return executablePath ? { executablePath } : {};
}

async function launch() {
  try {
    return await chromium.launch({ ...launchOptions(), timeout: 60_000 });
  } catch (error) {
    throw new Error(
      "не удалось запустить Chromium. В CI его ставит "
      + "`npx playwright install --with-deps chromium`; если браузер уже есть "
      + "в образе другой сборкой, укажите путь в EVA_CHROMIUM_PATH. "
      + `Исходная ошибка: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const NOW = "2026-08-14T09:00:00.000Z";

/** Ответы API по умолчанию: ровно столько, чтобы экраны наполнились. */
export const DEFAULT_ROUTES = {
  "/public/session": {
    user: { id: 1, first_name: "Аня", timezone: "Europe/Moscow" },
    plan: "free",
    quotas: [],
    session_token: "test-session",
    session_expires_in: 900,
  },
  "/public/bot": { username: "eva_test_bot", configured: true },
  "/public/goals": {
    goals: [{
      id: "1", title: "Дописать интерфейс", status: "active",
      progress_percent: 40, next_result: "Готовый экран", why_it_matters: "Важно",
    }],
  },
  "/public/profile": {
    profile: {
      user: { preferred_name: "Аня", city: "Москва", timezone: "Europe/Moscow" },
      completeness: 60, confirmed: [], candidates: [],
    },
  },
  "/public/progress": { progress: { completed_results: [], work_blocks: [], goals: [] } },
  "/public/v2/dashboard": {
    local_time: "12:00",
    checkin: { mood: "good", energy: 7, tension: 4 },
    main_focus: {
      id: "goal:1", title: "Дописать интерфейс",
      source_label: "Цель: запуск", expected_result: "Экран без боковой прокрутки",
    },
    main_focus_candidates: [],
    tasks: [
      { id: "1", title: "Проверить экран на 320 пикселях", status: "open", priority: 2, due_at: NOW, remind_at: NOW },
      { id: "2", title: "Сверить области нажатия", status: "done", priority: 3 },
    ],
    notes: [{ id: "1", title: "Идея", content: "Убрать боковую прокрутку", category: "Рабочее", updated_at: NOW, entry_type: "note" }],
    counts: { open_tasks: 1, today_tasks: 1, open_decisions: 0 },
    next_reminder: { title: "Проверить экран", remind_at: NOW },
    active_goal: { title: "Дописать интерфейс", next_result: "Готовый экран" },
    insight: { text: "Энергия выше напряжения.", observations: 8 },
    budget: { income_minor: 1000000, expense_minor: 400000, recent: [] },
  },
  "/public/v2/tasks": { tasks: [] },
  "/public/v2/notes": { notes: [] },
  "/public/v2/decisions": { decisions: [] },
  "/public/v2/budget": { records: [], summary: { income_minor: 0, expense_minor: 0 } },
  "/public/v2/journal": { entries: [] },
  "/public/v2/journal/people": { people: [] },
  "/public/v2/journal/weekly-review": {
    from: "2026-08-08", to: "2026-08-14", sufficient: false,
    summary: "За период набралось 2 наблюдения. Для честного вывода нужно хотя бы 5.",
    sections: [], totals: {},
  },
};

/**
 * Открывает Mini App на заданном разрешении.
 *
 * `routes` перекрывает ответы по умолчанию; значение `{ __status }`
 * описывает отказ — без него нельзя проверить, что экран показывает
 * состояние ошибки, а не пустой список.
 */
export async function openApp({ routes = {}, viewport, journal = false } = {}) {
  const server = await servePublic();
  const browser = await launch();
  const page = await browser.newPage({ viewport: viewport ?? { width: 390, height: 844 } });

  const requests = [];
  const errors = [];

  await page.addInitScript(() => {
    const noop = () => {};
    window.__backHandlers = [];
    window.Telegram = {
      WebApp: {
        initData: "auth_date=1&hash=test&user=%7B%22id%22%3A1%7D",
        initDataUnsafe: { user: { id: 1, first_name: "Аня" } },
        ready: noop,
        expand: noop,
        close: () => { window.__closed = true; },
        setHeaderColor: noop,
        setBackgroundColor: noop,
        setBottomBarColor: noop,
        openTelegramLink: noop,
        HapticFeedback: {
          impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop,
        },
        BackButton: {
          show: noop,
          hide: noop,
          onClick: (handler) => window.__backHandlers.push(handler),
        },
      },
    };
  });

  // Внешний скрипт Telegram в тесте недоступен: подмена уже стоит,
  // и загрузка настоящего файла только добавила бы минуту ожидания.
  await page.route("https://telegram.org/**", (route) => route.fulfill({
    status: 200, contentType: "text/javascript", body: "",
  }));

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname.replace(/^\/api/, "");
    const method = route.request().method();
    let body = null;
    try {
      body = route.request().postData() ? JSON.parse(route.request().postData()) : null;
    } catch { body = route.request().postData(); }
    requests.push({ method, path: pathname, search: url.search, body });

    // Дневник за флагом: сервер с выключенным флагом отвечает 404 на
    // ВСЕ его маршруты, и раздела в интерфейсе быть не должно.
    if (!journal && pathname.startsWith("/public/v2/journal")) {
      return await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }

    const table = { ...DEFAULT_ROUTES, ...routes };
    const handler = table[`${method} ${pathname}`] ?? table[pathname]
      ?? table[Object.keys(table).find((key) => key.startsWith("/") && pathname.startsWith(key)) ?? ""];
    const payload = typeof handler === "function"
      ? await handler({ method, pathname, body })
      : handler;
    if (payload && typeof payload === "object" && "__status" in payload) {
      return await route.fulfill({
        status: payload.__status,
        contentType: "application/json",
        body: JSON.stringify(payload.__body ?? {}),
      });
    }
    return await route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(payload ?? {}),
    });
  });

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${server.origin}/app/index.html`);
  await page.waitForFunction(() => window.EvaApp && window.EvaApp.state.phase !== "loading");

  return {
    page,
    requests,
    errors,
    /** Открыть экран так же, как это делает нижняя навигация. */
    openScreen: async (screen) => {
      await page.click(`.nav-item[data-target="${screen}"]`);
      await page.waitForTimeout(120);
    },
    /** Нажатие аппаратной «Назад» в Android приходит этим обработчиком. */
    pressBack: async () => {
      await page.evaluate(() => window.__backHandlers.forEach((handler) => handler()));
      await page.waitForTimeout(120);
    },
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}

/** Ширина документа против ширины экрана — та самая боковая прокрутка. */
export const documentWidth = (page) => page.evaluate(() => ({
  document: document.documentElement.scrollWidth,
  screen: window.innerWidth,
}));

/**
 * Интерактивные элементы мельче области нажатия.
 *
 * Считаются только видимые: скрытый экран возвращает нулевые рамки, и
 * без этого фильтра тест ловил бы не промахи, а невидимые кнопки.
 */
export const smallTapTargets = (page, minimum = 44) => page.evaluate((min) => {
  const selector = "button, a[href], input, select, textarea, [role=button]";
  const small = [];
  for (const node of document.querySelectorAll(selector)) {
    if (node.closest("[hidden]") || node.type === "hidden") continue;
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    // Ползунок и переключатель меряются по своей строке: у input[range]
    // высота задаётся браузером и правится только вместе с ней.
    if (node.type === "range" || node.type === "checkbox") continue;
    if (box.width < min - 0.5 || box.height < min - 0.5) {
      small.push({
        tag: node.tagName.toLowerCase(),
        className: String(node.className || ""),
        text: (node.textContent || "").trim().slice(0, 30),
        width: Math.round(box.width),
        height: Math.round(box.height),
      });
    }
  }
  return small;
}, minimum);
