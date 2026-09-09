/**
 * Общая обвязка браузерных тестов панели.
 *
 * Страница открывается по file://, а весь административный API
 * перехватывается: тесты проверяют поведение интерфейса, а не сервер, и
 * не должны зависеть от поднятой базы.
 *
 * Ключевое, ради чего это вообще написано, — отрицательные проверки:
 * какие запросы интерфейс НЕ отправляет. Переписка не должна уходить при
 * открытии карточки, а действие с последствиями — до подтверждения в
 * окне. Такое нельзя увидеть в `node --check`, и на сервере это уже не
 * поймать: запрос либо пришёл, либо нет.
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
 * Статика отдаётся по http, а не открывается как file://.
 *
 * ui.js обращается к API по абсолютному пути `/api/admin/v1`. Со
 * страницы file:// это превращается в `file:///api/...`: запрос до
 * перехватчика не доходит и падает с «Failed to fetch». В одной сборке
 * браузера это случайно срабатывало, в другой — нет, и тест начинал
 * зависеть от того, какой chromium подвернулся. По http адрес получается
 * тот же, что и за Caddy в рабочей установке.
 */
async function servePublic() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const name = url.pathname === "/" ? "/index.html" : url.pathname;
    // Ходить выше каталога статики нельзя даже в тесте.
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

/**
 * В CI браузер ставит `npx playwright install chromium`, и обычный запуск
 * его находит. В образах, где лежит уже собранный chromium другой версии,
 * путь передаётся переменной — иначе playwright ищет ровно ту сборку, под
 * которую собран, и не находит.
 */
function launchOptions() {
  const executablePath = process.env.EVA_CHROMIUM_PATH;
  return executablePath ? { executablePath } : {};
}

/**
 * Без браузера запуск не падает, а молча висит, и в CI это выглядит как
 * зависший job вместо внятной ошибки. Ограничиваем ожидание и объясняем,
 * что делать.
 */
async function launch() {
  try {
    return await chromium.launch({ ...launchOptions(), timeout: 60_000 });
  } catch (error) {
    throw new Error(
      "не удалось запустить Chromium. В CI его ставит "
      + "`npx playwright install --with-deps chromium`; если браузер уже есть "
      + "в образе другой сборкой, укажите путь в EVA_CHROMIUM_PATH. "
      + `Исходная ошибка: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * viewport задаётся явно там, где проверяется вёрстка под телефон.
 * 360×740 — распространённый андроид (Galaxy A-серии, Redmi): если
 * помещается сюда, поместится и в остальные.
 */
export const PHONE = { width: 360, height: 740 };

/**
 * Матрица разрешений шага 26. Ниже 320 телефонов нет, выше 430
 * начинается планшет, а десктоп нужен, чтобы мобильные правила не
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

/**
 * Интерактивные элементы мельче области нажатия.
 *
 * Меряются только видимые: скрытая страница отдаёт нулевые рамки, и без
 * фильтра тест ловил бы не промахи, а невидимые кнопки.
 */
export const smallTapTargets = (page, minimum = 44) => page.evaluate((min) => {
  const small = [];
  const selector = ".page.active button, .page.active a[href], .page.active input,"
    + " .page.active select, .page.active textarea";
  for (const node of document.querySelectorAll(selector)) {
    if (node.type === "hidden" || node.type === "checkbox" || node.type === "range") continue;
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
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

export async function openPanel({ routes = {}, role = "owner", viewport = null } = {}) {
  const server = await servePublic();
  const browser = await launch();
  const page = await browser.newPage(viewport ? { viewport } : {});

  /** Каждый запрос к API, который интерфейс успел отправить. */
  const requests = [];
  const errors = [];

  // Роль отдаётся ответом /me, как в рабочей установке. Подставлять её
  // прямо в state нельзя: ui.js при загрузке сам запрашивает /me и
  // перезаписывает состояние — подстановка выигрывала эту гонку через раз,
  // и тест роли падал примерно в одном прогоне из пяти.
  const session = {
    user: { id: "u1", login: role, username: role, role },
    csrf_token: "test-csrf",
  };
  const defaults = { "/me": session, "/session": session };

  await page.route("**/api/admin/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname.replace("/api/admin/v1", "");
    const method = route.request().method();
    let body = null;
    try {
      body = route.request().postData() ? JSON.parse(route.request().postData()) : null;
    } catch {
      body = route.request().postData();
    }
    requests.push({ method, path: pathname, search: url.search, body });

    const handler = routes[`${method} ${pathname}`] ?? routes[pathname] ?? defaults[pathname];
    const payload = typeof handler === "function" ? handler() : handler;
    // Отказ API описывается как { __status, __body }: без этого нельзя
    // проверить, что интерфейс переживает недоступный бэкенд, а такие
    // проверки — половина смысла браузерных тестов. Метка выбрана
    // приметной, чтобы не столкнуться с обычным полем ответа.
    if (payload && typeof payload === "object" && "__status" in payload) {
      return await route.fulfill({
        status: payload.__status,
        contentType: "application/json",
        body: JSON.stringify(payload.__body ?? {}),
      });
    }
    return await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload ?? {}),
    });
  });

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${server.origin}/index.html`);
  // Ждём, пока приложение примет сессию: до этого state.me ещё пуст, и
  // любое действие теста опередило бы загрузку.
  await page.waitForFunction(() => !document.querySelector("#app").hidden);

  return {
    page,
    requests,
    errors,
    /** Сколько запросов ушло на путь, содержащий фрагмент. */
    countTo: (fragment) => requests.filter((r) => r.path.includes(fragment)).length,
    /**
     * Дождаться запроса, который интерфейс отправляет сам.
     *
     * Запись ведётся в Node, а отправляет её браузер: без ожидания тест
     * читал бы массив раньше, чем в него попал запрос, и падал бы через
     * раз в зависимости от скорости машины.
     */
    waitForRequest: async (predicate, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = requests.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    /** Сбросить отложенное подтверждение, чтобы увидеть именно новое. */
    confirmWatch: async () => await page.evaluate(() => {
      state.pendingConfirm = null;
      return true;
    }),
    /** Заголовок открытого окна подтверждения или `null`, если его нет. */
    confirmTitle: async () => await page.evaluate(() => (
      state.pendingConfirm ? document.querySelector("#confirm-title").textContent : null
    )),
    /** Подтвердить так же, как это делает форма диалога. */
    confirmAccept: async () => await page.evaluate(async () => {
      const pending = state.pendingConfirm;
      state.pendingConfirm = null;
      document.querySelector("#confirm-dialog").close();
      await pending.action();
    }),
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}

