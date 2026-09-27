/**
 * Сессии браузера: один Chromium, у каждой сессии — свой изолированный
 * контекст (куки, хранилище, кэш) и одна вкладка.
 *
 * Границы, которые здесь держатся детерминированно, а не просьбой к модели:
 *
 *   - только чтение: запрос с методом, отличным от GET/HEAD/OPTIONS,
 *     отменяется. Браузер Евы читает сайты — отправить форму, оплатить,
 *     оставить комментарий он не может;
 *   - адрес каждого запроса проверяется `EgressPolicy`, соединение идёт
 *     через локальный прокси к проверенному IP;
 *   - в поле пароля, одноразового кода и карты текст не вводится;
 *   - загрузки, всплывающие окна, диалоги, разрешения и service workers
 *     выключены;
 *   - сессия принадлежит владельцу, названному при создании: чужой
 *     владелец её не видит;
 *   - пределы: сессий всего и на владельца, простой и возраст, время
 *     операции. Зависшая операция закрывает сессию, а не держит её.
 *
 * Управление сессиями вдохновлено Hermes Agent
 * (tools/browser_tool_session.py, MIT, Nous Research): отдельная
 * сессия на задачу и переработка сессии после таймаута.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";

import type { BrowserServiceConfig } from "./config.js";
import type { EgressPolicy } from "./egress.js";
import { takeSnapshot, type PageSnapshot } from "./snapshot.js";

export type BrowserErrorCode =
  | "blocked_url" | "invalid_ref" | "timeout" | "session_limit" | "not_found" | "forbidden"
  | "navigation_failed" | "sensitive_field" | "invalid_request" | "unavailable";

export class BrowserError extends Error {
  constructor(readonly code: BrowserErrorCode, message: string) {
    super(message);
    this.name = "BrowserError";
  }
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const REF = /^[A-Za-z0-9]{1,24}$/;

interface Session {
  id: string;
  owner: string;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastUsedAt: number;
  operations: number;
  blockedRequests: number;
  queue: Promise<unknown>;
}

export interface SessionView {
  id: string;
  owner: string;
  ageMs: number;
  idleMs: number;
  operations: number;
  blockedRequests: number;
}

export interface OperationResult extends PageSnapshot {
  session: string;
  status: number | null;
  blockedRequests: number;
}

export class SessionManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, Session>();
  private sweeper: NodeJS.Timeout | null = null;
  readonly counters = { opened: 0, closed: 0, expired: 0, recycled: 0 };

  constructor(
    private readonly config: BrowserServiceConfig,
    private readonly policy: EgressPolicy,
    private readonly proxyUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<void> {
    await this.ensureBrowser();
    this.sweeper = setInterval(() => void this.sweep(), 15_000);
    this.sweeper.unref();
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const session of [...this.sessions.values()]) await this.dispose(session);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  get connected(): boolean {
    return this.browser?.isConnected() === true;
  }

  list(): SessionView[] {
    const now = this.now();
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      owner: session.owner,
      ageMs: now - session.createdAt,
      idleMs: now - session.lastUsedAt,
      operations: session.operations,
      blockedRequests: session.blockedRequests,
    }));
  }

  async open(id: string, owner: string, url: string): Promise<OperationResult> {
    const verdict = await this.policy.checkUrl(url);
    if (!verdict.ok) throw new BrowserError("blocked_url", `Адрес закрыт для браузера: ${verdict.reason}`);
    return await this.operate(id, owner, true, async (session) => {
      let status: number | null = null;
      try {
        const response = await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
        status = response?.status() ?? null;
      } catch (error) {
        throw navigationError(error);
      }
      await session.page.waitForLoadState("load", { timeout: 3_000 }).catch(() => undefined);
      return status;
    });
  }

  async snapshot(id: string, owner: string, offset = 0): Promise<OperationResult> {
    return await this.operate(id, owner, false, async () => null, offset);
  }

  async click(id: string, owner: string, ref: string): Promise<OperationResult> {
    const target = this.ref(ref);
    return await this.operate(id, owner, false, async (session) => {
      const locator = await this.element(session.page, target);
      try {
        await locator.click({ timeout: this.config.operationTimeoutMs });
      } catch (error) {
        throw actionError(error);
      }
      await session.page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
      return null;
    });
  }

  async type(id: string, owner: string, ref: string, text: string, submit: boolean): Promise<OperationResult> {
    const target = this.ref(ref);
    if (text.length > this.config.maxTypeChars) {
      throw new BrowserError("invalid_request", `Текст длиннее ${this.config.maxTypeChars} знаков`);
    }
    return await this.operate(id, owner, false, async (session) => {
      const locator = await this.element(session.page, target);
      let sensitive: boolean;
      try {
        sensitive = await locator.evaluate((element) => {
          const input = element as { type?: string; autocomplete?: string };
          const type = String(input.type ?? "").toLowerCase();
          const autocomplete = String(input.autocomplete ?? "").toLowerCase();
          return type === "password" || type === "file" || /cc-|one-time-code|current-password|new-password/.test(autocomplete);
        }, undefined, { timeout: this.config.operationTimeoutMs });
      } catch (error) {
        throw actionError(error);
      }
      if (sensitive) throw new BrowserError("sensitive_field", "В поле пароля, кода или карты браузер Евы ничего не вводит");
      try {
        await locator.fill(text, { timeout: this.config.operationTimeoutMs });
        if (submit) await locator.press("Enter", { timeout: this.config.operationTimeoutMs });
      } catch (error) {
        throw actionError(error);
      }
      if (submit) await session.page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
      return null;
    });
  }

  async scroll(id: string, owner: string, direction: "up" | "down", pages: number): Promise<OperationResult> {
    const amount = Math.min(5, Math.max(1, Math.floor(pages)));
    return await this.operate(id, owner, false, async (session) => {
      await session.page.evaluate(([sign, count]) => window.scrollBy(0, sign * count * window.innerHeight * 0.9), [direction === "up" ? -1 : 1, amount] as const);
      // Ленивые списки дозагружаются по прокрутке; ждём их коротко.
      await session.page.waitForTimeout(400);
      return null;
    });
  }

  async back(id: string, owner: string): Promise<OperationResult> {
    return await this.operate(id, owner, false, async (session) => {
      try {
        const response = await session.page.goBack({ waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
        return response?.status() ?? null;
      } catch (error) {
        throw navigationError(error);
      }
    });
  }

  async close(id: string, owner: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.owner !== owner) throw new BrowserError("forbidden", "Сессия принадлежит другому владельцу");
    await this.dispose(session);
    this.counters.closed += 1;
    return true;
  }

  private ref(ref: string): string {
    if (!REF.test(ref)) throw new BrowserError("invalid_ref", "Ссылка на элемент — вида e12 из последнего снимка");
    return ref;
  }

  /**
   * Элемент по ссылке снимка. Несуществующую ссылку локатор ждал бы до
   * конца таймаута — проверка наличия отвечает сразу.
   */
  private async element(page: Page, ref: string) {
    const locator = page.locator(`aria-ref=${ref}`);
    const count = await locator.count().catch(() => 0);
    if (count === 0) throw new BrowserError("invalid_ref", "Элемента с такой ссылкой нет: возьми ссылку из свежего снимка");
    return locator.first();
  }

  /**
   * Операции одной сессии идут строго по очереди: два параллельных
   * нажатия в одной вкладке дали бы снимок, не соответствующий ни одному.
   * Общий предел времени закрывает зависшую сессию — следующий вызов
   * начнёт с чистой.
   */
  private async operate(
    id: string, owner: string, create: boolean,
    action: (session: Session) => Promise<number | null>, offset = 0,
  ): Promise<OperationResult> {
    const session = await this.session(id, owner, create);
    const run = session.queue.then(async () => {
      session.lastUsedAt = this.now();
      session.operations += 1;
      const status = await action(session);
      const snapshot = await takeSnapshot(session.page, {
        maxChars: this.config.snapshotMaxChars, timeoutMs: this.config.operationTimeoutMs, offset,
      });
      session.lastUsedAt = this.now();
      return { session: session.id, status, blockedRequests: session.blockedRequests, ...snapshot };
    });
    session.queue = run.catch(() => undefined);
    const limit = this.config.navigationTimeoutMs + this.config.operationTimeoutMs * 2;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        run,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new BrowserError("timeout", "Страница не ответила вовремя; сессия закрыта")), limit);
        }),
      ]);
    } catch (error) {
      if (error instanceof BrowserError && error.code === "timeout") {
        this.counters.recycled += 1;
        await this.dispose(session);
      }
      throw error instanceof BrowserError ? error : new BrowserError("unavailable", "Браузер не выполнил операцию");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async session(id: string, owner: string, create: boolean): Promise<Session> {
    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.owner !== owner) throw new BrowserError("forbidden", "Сессия принадлежит другому владельцу");
      return existing;
    }
    if (!create) throw new BrowserError("not_found", "Сессии нет: сначала открой страницу через browser_open");
    const own = [...this.sessions.values()].filter((session) => session.owner === owner);
    if (own.length >= this.config.maxSessionsPerOwner) {
      // Свою самую давнюю сессию владелец освобождает сам собой; чужие
      // сессии ради него не закрываются.
      const oldest = own.sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0]!;
      await this.dispose(oldest);
      this.counters.expired += 1;
    }
    if (this.sessions.size >= this.config.maxSessions) {
      throw new BrowserError("session_limit", "Все сессии браузера заняты; попробуй позже");
    }
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
      viewport: { width: 1280, height: 900 },
      locale: "ru-RU",
      bypassCSP: false,
      ignoreHTTPSErrors: false,
    });
    context.setDefaultTimeout(this.config.operationTimeoutMs);
    context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    const page = await context.newPage();
    const session: Session = {
      id, owner, context, page, createdAt: this.now(), lastUsedAt: this.now(),
      operations: 0, blockedRequests: 0, queue: Promise.resolve(),
    };
    await context.route("**/*", async (route) => await this.filter(route, session));
    // Всплывающее окно закрывается: вкладка у сессии одна, и снимок
    // всегда описывает её.
    context.on("page", (other) => { if (other !== page) void other.close().catch(() => undefined); });
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
    this.sessions.set(id, session);
    this.counters.opened += 1;
    return session;
  }

  private async filter(route: Route, session: Session): Promise<void> {
    const request = route.request();
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") {
      await route.continue();
      return;
    }
    if (!READ_METHODS.has(request.method().toUpperCase()) || !(await this.policy.checkUrl(url)).ok) {
      session.blockedRequests += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = chromium.launch({
        headless: true,
        ...(this.config.executablePath ? { executablePath: this.config.executablePath } : {}),
        args: [
          // Весь трафик — через проверяющий прокси, включая loopback:
          // по умолчанию Chromium ходит к нему мимо прокси.
          `--proxy-server=${this.proxyUrl}`,
          "--proxy-bypass-list=<-loopback>",
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-domain-reliability",
          "--disable-sync",
          "--no-first-run",
          "--disable-dev-shm-usage",
        ],
      }).then((browser) => {
        browser.on("disconnected", () => {
          // Упавший Chromium уносит все контексты: сессии больше не живы.
          this.sessions.clear();
          this.browser = null;
        });
        this.browser = browser;
        return browser;
      }).finally(() => { this.launching = null; });
    }
    return await this.launching;
  }

  private async sweep(): Promise<void> {
    const now = this.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastUsedAt > this.config.sessionIdleMs || now - session.createdAt > this.config.sessionMaxAgeMs) {
        await this.dispose(session);
        this.counters.expired += 1;
      }
    }
  }

  /** Для тестов: прогнать истечение без таймера. */
  async sweepNow(): Promise<void> {
    await this.sweep();
  }

  private async dispose(session: Session): Promise<void> {
    this.sessions.delete(session.id);
    await session.context.close().catch(() => undefined);
  }
}

function navigationError(error: unknown): BrowserError {
  const message = error instanceof Error ? error.message : String(error);
  if (/ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/.test(message)) {
    return new BrowserError("blocked_url", "Адрес или его перенаправление закрыты для браузера");
  }
  if (/Timeout/i.test(message)) return new BrowserError("timeout", "Страница не загрузилась вовремя");
  return new BrowserError("navigation_failed", "Страницу открыть не удалось");
}

function actionError(error: unknown): BrowserError {
  if (error instanceof BrowserError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/Timeout/i.test(message)) return new BrowserError("timeout", "Элемент не ответил вовремя: он скрыт, перекрыт или неактивен");
  return new BrowserError("invalid_ref", "С элементом по этой ссылке ничего сделать нельзя: возьми ссылку из свежего снимка");
}
