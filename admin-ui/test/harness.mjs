/**
 * Общая обвязка браузерных тестов панели.
 *
 * Страница открывается по file://, а весь административный API
 * перехватывается: тесты проверяют поведение интерфейса, а не сервер, и
 * не должны зависеть от поднятой базы.
 *
 * Ключевое, ради чего это вообще написано, — отрицательные проверки:
 * какие запросы интерфейс НЕ отправляет. Переписка не должна уходить при
 * открытии карточки, а мутации — до подтверждения sudo. Такое нельзя
 * увидеть в `node --check`, и на сервере это уже не поймать: запрос либо
 * пришёл, либо нет.
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
    /** Сбросить и затем прочитать реальное отложенное sudo-действие. */
    sudoWatch: async () => await page.evaluate(() => {
      state.pendingSudo = null;
      return true;
    }),
    sudoScope: async () => await page.evaluate(() => state.pendingSudo?.scope ?? null),
    /** Подтвердить отложенное sudo так же, как это делает форма диалога. */
    confirmSudo: async () => await page.evaluate(async () => {
      const pending = state.pendingSudo;
      document.querySelector("#sudo-dialog").close();
      await pending.action();
    }),
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}

