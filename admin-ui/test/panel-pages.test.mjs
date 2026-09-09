/**
 * Разделы единой панели в браузере: агенты, подписки, персона, Letta и
 * мониторинг.
 *
 * Ради чего этот файл существует — отрицательные проверки. Какие запросы
 * интерфейс НЕ отправляет: переписка не должна уходить при открытии
 * раздела, текст персоны — до подтверждения, а удаление агента — до
 * предпросмотра и подтверждения. Это нельзя увидеть в `node --check`, а
 * на сервере уже поздно: запрос либо ушёл, либо нет.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { DEVICES, openPanel, PHONE } from "./harness.mjs";

const AGENTS = {
  total: 1,
  agents: [{
    agentId: "agent-1", userId: 11, kind: "eva", agentName: "Ева",
    model: "gpt", embeddingModel: "emb", status: "active", messageCount: 12,
    lastMessageAt: "2026-08-01T10:00:00Z", conversations: 2, activeTurns: 0,
    personaVersion: "abc123", canonicalSyncStatus: "ok", canonicalSyncAt: "2026-08-02T10:00:00Z",
    owner: {
      userId: 11, telegramId: "555", username: "eva_user", firstName: "Аня",
      isBlocked: false, plan: "free", subscriptionStatus: "none",
    },
  }],
};

const AGENT_CARD = {
  agent: AGENTS.agents[0],
  conversations: [{
    conversationId: "conv-1", agentId: "agent-1", userId: 11, purpose: "chat",
    title: "Разговор", status: "active", messageCount: 3,
    startedAt: "2026-08-01T10:00:00Z", lastMessageAt: "2026-08-01T10:00:00Z", archivedAt: null,
  }],
  active_turns: [],
  live: { id: "agent-1", name: "Ева", description: "", model: "gpt", hidden: false, tags: ["eva"] },
  live_error: null,
};

const PERSONA_TEXT = "Ева — внимательный собеседник";
const PROMPT_TEXT = "Системный промпт установки";

const PERSONA_STATE = {
  documents: {
    persona: {
      source: "persona", text: PERSONA_TEXT, origin: "file", version: null, versionId: null,
      checksum: null, publishedAt: null, rollbackAvailable: false,
      defaultPath: "/app/library/persona/eva.md", matchesDefault: true, bytes: 42,
    },
    system_prompt: {
      source: "system_prompt", text: PROMPT_TEXT, origin: "registry", version: 3, versionId: 9,
      checksum: "deadbeef", publishedAt: "2026-08-20T10:00:00Z", rollbackAvailable: true,
      defaultPath: "/app/library/system/letta_local_memfs.md", matchesDefault: false, bytes: 4200,
    },
  },
  state: {
    status: "ok", version: "abc123", lastRunAt: "2026-08-20T10:00:00Z",
    updated: 2, upToDate: 5, failed: 0, unsupported: 0, staleAgents: 0,
  },
};

const LETTA = {
  system: { version: "0.3.0", runtime: "letta-agent-sdk", setup_complete: true },
  settings: {
    permissionMode: "standard", memfs_enabled: true, dreaming: { trigger: "compaction-event" },
    reasoning_effort: "none", default_context_window: 200000,
    session_pool_size: 4, turn_timeout_ms: 240000, app_server_request_timeout_ms: 180000,
  },
  stats: { users: 12, messages: 340 },
  agents: [{ id: "agent-1", name: "Ева", model: "gpt", hidden: false }],
  errors: [],
};

const MONITORING = {
  overall_status: "yellow",
  failing: [{ id: "searxng", type: "service", title: "SearXNG", color: "yellow", state: "degraded", message: "медленно" }],
  installation: { version: "0.4.2" },
  host: {
    load_average: [0.4, 0.5, 0.6], cpu_count: 4,
    memory_total_bytes: 8 * 2 ** 30, memory_free_bytes: 3 * 2 ** 30,
    disk_total_bytes: 100 * 2 ** 30, disk_free_bytes: 38 * 2 ** 30,
    uptime_seconds: 372_000, hostname: "eva-prod",
  },
  summary: { services: 5, healthy: 4, warnings: 1, critical: 0, critical_events_24h: 2 },
  groups: {
    core: [{
      id: "agent-runtime", type: "service", title: "Agent Runtime", purpose: "Ева",
      status: { color: "green", enabled: true, configured: true, state: "healthy", message: "", last_check_at: "2026-08-20T10:00:00Z" },
    }],
  },
  recent_checks: [{
    id: "c1", target_type: "service", target_id: "searxng", title: "SearXNG",
    status: "failure", requested_at: "2026-08-20T10:00:00Z", finished_at: "2026-08-20T10:00:05Z",
    ok: false, duration_ms: 5000, error_code: "timeout", error_message_short: "таймаут",
  }],
  errors: {
    hours: 24, count: 1,
    items: [{ source: "check", at: "2026-08-20T10:00:05Z", target: "searxng", title: "SearXNG", message: "таймаут" }],
  },
};

const SUBSCRIPTIONS = {
  by_plan: [{ plan: "plus", source: "manual", status: "active", total: "3" }],
  expiring: [{
    user_id: 11, telegram_id: "555", username: "eva_user", plan: "plus",
    source: "manual", status: "active", current_period_end: "2026-09-01T00:00:00Z",
  }],
};

const SUBSCRIPTION_CARD = {
  user: { id: 11, telegram_id: "555", username: "eva_user", is_blocked: false, state: "active" },
  current: {
    id: 101, plan: "plus", status: "active", source: "manual", provider: null,
    started_at: "2026-08-01T00:00:00Z", current_period_start: "2026-08-01T00:00:00Z",
    current_period_end: "2026-09-01T00:00:00Z", canceled_at: null,
    actor_name: "owner", note: "компенсация",
  },
  access: { level: "manual_override", reason: "Действует ручное решение администратора", source: "manual" },
  history: [], events: [], payments: [],
};

const ROUTES = {
  "/panel/agents": AGENTS,
  "/panel/agents/agent-1": AGENT_CARD,
  "/panel/agents/agent-1/deletion-preview": {
    kind: "agent", target: "agent-1", deletable: true, blockingTurns: [], awaitingApproval: 0, note: "",
  },
  "/panel/subscriptions": SUBSCRIPTIONS,
  "/panel/subscriptions/11": SUBSCRIPTION_CARD,
  "/panel/persona": PERSONA_STATE,
  "/panel/persona/persona/history": { source: "persona", history: [] },
  "/panel/persona/system_prompt/history": {
    source: "system_prompt",
    history: [{
      version: 3, versionId: 9, checksum: "deadbeef",
      publishedAt: "2026-08-20T10:00:00Z", retiredAt: null, reason: "правка тона", active: true,
    }],
  },
  "/panel/letta": LETTA,
  "/panel/letta/agents/agent-1/conversations": {
    conversations: [{ id: "conv-1", summary: "Разговор", archived: false, message_count: 3 }],
  },
  "/panel/letta/conversations/conv-1/messages": {
    messages: [{ role: "user", content: "личное сообщение", created_at: "2026-08-20T10:00:00Z" }],
  },
  "/panel/letta/context": { conversations: [] },
  "/panel/letta/audit": { events: [] },
  "/panel/monitoring": MONITORING,
};

describe("разделы единой панели", () => {
  const panels = [];
  const open = async (options = {}) => {
    const panel = await openPanel({ routes: ROUTES, ...options });
    panels.push(panel);
    return panel;
  };
  after(async () => {
    for (const panel of panels) await panel.close().catch(() => {});
  });

  // -------------------------------------------------------------------
  // Меню и адреса
  // -------------------------------------------------------------------

  test("Letta и мониторинг — разделы меню, а не ссылки на другие домены", async () => {
    const panel = await open();
    const nav = await panel.page.evaluate(() =>
      [...document.querySelectorAll("#nav .nav-item")].map((item) => item.dataset.page));
    for (const page of ["agents", "subscriptions", "persona", "letta", "monitoring"]) {
      assert.ok(nav.includes(page), `в меню нет раздела ${page}`);
    }
    // Ни одной ссылки наружу: прежняя кнопка «Открыть Letta» вела на
    // отдельный поддомен со своим входом.
    const external = await panel.page.evaluate(() =>
      [...document.querySelectorAll('#app a[target="_blank"]')]
        .map((node) => node.getAttribute("href"))
        .filter((href) => href && !href.startsWith("#")));
    assert.deepEqual(external, []);
  });

  test("раздел меняет адрес страницы, а не якорь", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("letta"));
    assert.equal(new URL(panel.page.url()).pathname, "/letta");
    await panel.page.evaluate(() => openPage("monitoring"));
    assert.equal(new URL(panel.page.url()).pathname, "/monitoring");
    // Обзор — корень раздела, а не /overview: адрес панели остаётся её адресом.
    await panel.page.evaluate(() => openPage("overview"));
    assert.equal(new URL(panel.page.url()).pathname, "/");
  });

  test("хвостовой слэш в адресе раздела не ломает базовый путь", async () => {
    // `/admin/agents/` набирают руками и присылают ссылкой. Наивное
    // вычисление базы принимало такой адрес за корень панели: показывался
    // обзор, а следующий переход строил `/admin/agents/letta`.
    const panel = await open();
    await panel.page.evaluate(() => window.history.replaceState({}, "", "/agents/"));
    const resolved = await panel.page.evaluate(() => {
      const base = panelBase();
      return { base, page: pageFromLocation() };
    });
    assert.equal(resolved.base, "/");
    assert.equal(resolved.page, "agents");
  });

  test("кнопка «назад» возвращает в предыдущий раздел", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("agents"));
    await panel.page.evaluate(() => openPage("letta"));
    await panel.page.goBack();
    await panel.page.waitForFunction(() => state.page === "agents");
    assert.equal(await panel.page.evaluate(() => state.page), "agents");
  });

  // -------------------------------------------------------------------
  // Агенты
  // -------------------------------------------------------------------

  test("список агентов показывает владельца и состояние персоны", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("agents"));
    await panel.page.waitForSelector("#agents-body .agent-row");
    const row = await panel.page.textContent("#agents-body .agent-row");
    assert.match(row, /eva_user/);
    assert.match(row, /abc123/);
  });

  test("удаление агента не уходит на сервер без предпросмотра и подтверждения", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("agents"));
    await panel.page.waitForSelector("#agents-body .agent-row");
    await panel.page.click("#agents-body .agent-row");
    await panel.page.waitForSelector('[data-agent-action="delete"]');
    await panel.page.click('[data-agent-action="delete"]');
    await panel.page.waitForFunction(() => state.pendingConfirm !== null);

    // Ни одного DELETE: панель сперва спросила, что мешает удалению.
    assert.equal(
      panel.requests.filter((item) => item.method === "DELETE").length,
      0,
      "агент удалён до подтверждения",
    );
    assert.equal(panel.countTo("/deletion-preview"), 1);
  });

  test("правка агента не отправляет системный промпт", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("agents"));
    await panel.page.waitForSelector("#agents-body .agent-row");
    await panel.page.click("#agents-body .agent-row");
    await panel.page.waitForSelector("#agent-edit-form");
    const fields = await panel.page.evaluate(() =>
      [...document.querySelectorAll("#agent-edit-form [name]")].map((node) => node.name));
    assert.equal(fields.includes("system"), false, "форма агента правит общий системный промпт");
  });

  // -------------------------------------------------------------------
  // Персона и промпт
  // -------------------------------------------------------------------

  test("редактор показывает действующий текст и его происхождение", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("persona"));
    await panel.page.waitForFunction(() => document.querySelector("#persona-text").value.length > 0);
    assert.equal(await panel.page.inputValue("#persona-text"), PERSONA_TEXT);
    const facts = await panel.page.textContent("#persona-facts");
    assert.match(facts, /файл репозитория/);
    // Состояние применения — на экране, а не в голове оператора.
    const applyState = await panel.page.textContent("#persona-apply-body");
    assert.match(applyState, /abc123/);
  });

  test("вкладка системного промпта показывает версию и историю", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("persona"));
    await panel.page.waitForFunction(() => document.querySelector("#persona-text").value.length > 0);
    await panel.page.click('[data-persona-tab="system_prompt"]');
    await panel.page.waitForFunction(
      (text) => document.querySelector("#persona-text").value === text, PROMPT_TEXT,
    );
    const facts = await panel.page.textContent("#persona-facts");
    assert.match(facts, /версия 3/);
    await panel.page.waitForSelector("#persona-history-body tr");
    assert.match(await panel.page.textContent("#persona-history-body"), /правка тона/);
  });

  test("сохранение персоны не уходит на сервер без подтверждения", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("persona"));
    await panel.page.waitForFunction(() => document.querySelector("#persona-text").value.length > 0);
    await panel.page.fill("#persona-text", "другой текст");
    await panel.page.click("#persona-save");
    await panel.page.waitForFunction(() => state.pendingConfirm !== null);
    assert.equal(
      panel.requests.filter((item) => item.method === "PUT").length,
      0,
      "канонический текст сохранён без подтверждения",
    );
  });

  test("откат недоступен, пока откатывать не на что", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("persona"));
    await panel.page.waitForFunction(() => document.querySelector("#persona-text").value.length > 0);
    assert.equal(await panel.page.isDisabled("#persona-rollback"), true);
    await panel.page.click('[data-persona-tab="system_prompt"]');
    await panel.page.waitForFunction(
      () => document.querySelector("#persona-rollback").disabled === false,
    );
  });

  /*
   * Полноэкранная правка.
   *
   * Персона — тридцать шесть килобайт markdown. В поле на четверть
   * экрана телефона такой текст правят, прокручивая страницу вокруг
   * поля: место правки теряется, а кнопка «Сохранить» уезжает за нижний
   * край. Проверяется то, ради чего режим существует: поле занимает
   * большую часть экрана, действия остаются в нём, а текст не теряется.
   */
  test("развёрнутый редактор отдаёт полю экран и держит кнопки на виду", async () => {
    const panel = await open({ viewport: PHONE });
    await panel.page.evaluate(() => openPage("persona"));
    await panel.page.waitForFunction(() => document.querySelector("#persona-text").value.length > 0);

    const before = await panel.page.evaluate(() =>
      document.querySelector("#persona-text").getBoundingClientRect().height);
    await panel.page.click("#persona-expand");
    await panel.page.waitForTimeout(200);

    const after = await panel.page.evaluate(() => {
      const field = document.querySelector("#persona-text").getBoundingClientRect();
      const actions = document.querySelector("#persona-actions").getBoundingClientRect();
      return {
        fieldHeight: field.height,
        fieldWidth: field.width,
        actionsVisible: actions.bottom <= window.innerHeight + 1 && actions.top >= 0,
        screen: window.innerHeight,
        width: window.innerWidth,
        text: document.querySelector("#persona-text").value.length,
      };
    });
    assert.ok(
      after.fieldHeight > before * 1.5,
      `поле не выросло: было ${Math.round(before)}, стало ${Math.round(after.fieldHeight)}`,
    );
    assert.ok(
      after.fieldHeight > after.screen * 0.5,
      `поле занимает меньше половины экрана: ${Math.round(after.fieldHeight)} из ${after.screen}`,
    );
    assert.ok(after.fieldWidth <= after.width, "поле шире экрана");
    assert.ok(after.actionsVisible, "кнопки ушли за край — до них надо прокручивать вслепую");
    assert.ok(after.text > 0, "текст потерялся при разворачивании");

    // Сквозь развёрнутый редактор не должно читаться то, что под ним.
    const alpha = await panel.page.evaluate(() => {
      const value = getComputedStyle(document.querySelector("#persona-editor")).backgroundColor;
      const parts = value.match(/[\d.]+/g) ?? [];
      return parts.length > 3 ? Number(parts[3]) : 1;
    });
    assert.equal(alpha, 1, "фон развёрнутого редактора полупрозрачен");
  });

  test("Escape сворачивает редактор, а переход в другой раздел его не оставляет", async () => {
    const panel = await open({ viewport: PHONE });
    await panel.page.evaluate(() => openPage("persona"));
    await panel.page.waitForFunction(() => document.querySelector("#persona-text").value.length > 0);
    const expanded = () => panel.page.evaluate(() =>
      document.querySelector("#persona-editor").classList.contains("is-fullscreen"));

    await panel.page.click("#persona-expand");
    assert.equal(await expanded(), true);
    await panel.page.keyboard.press("Escape");
    assert.equal(await expanded(), false, "Escape не свернул редактор");

    // Развёрнутый редактор закрывает собой всё; уход в другой раздел
    // обязан его снять, иначе он накроет страницу, которую не открывали.
    await panel.page.click("#persona-expand");
    assert.equal(await expanded(), true);
    await panel.page.evaluate(() => document.querySelector('#nav [data-page="agents"]').click());
    await panel.page.waitForTimeout(150);
    assert.equal(await expanded(), false, "редактор остался поверх другого раздела");
    assert.equal(
      await panel.page.evaluate(() => document.body.classList.contains("editor-open")),
      false,
      "прокрутка страницы осталась заблокированной",
    );
  });

  test("viewer не правит канонический текст", async () => {
    const panel = await open({ role: "viewer" });
    await panel.page.evaluate(() => openPage("persona"));
    await panel.page.waitForFunction(() => document.querySelector("#persona-text").value.length > 0);
    assert.equal(await panel.page.isDisabled("#persona-save"), true);
    assert.equal(await panel.page.evaluate(() => document.querySelector("#persona-text").readOnly), true);
  });

  // -------------------------------------------------------------------
  // Letta
  // -------------------------------------------------------------------

  test("открытие раздела Letta не загружает ничью переписку", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("letta"));
    await panel.page.waitForSelector("#letta-agents-body tr");
    assert.equal(panel.countTo("/messages"), 0, "переписка загружена при открытии раздела");
    const summary = await panel.page.textContent("#letta-summary");
    assert.match(summary, /letta-agent-sdk/);
  });

  test("история диалога открывается только после подтверждения", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("letta"));
    await panel.page.waitForSelector("#letta-agents-body tr");
    await panel.page.click('[data-letta-tab="conversations"]');
    await panel.page.fill('#letta-conversations-form [name="agent_id"]', "agent-1");
    await panel.page.click('#letta-conversations-form button[type="submit"]');
    await panel.page.waitForSelector("[data-letta-messages]");
    await panel.page.click("[data-letta-messages]");
    await panel.page.waitForFunction(() => state.pendingConfirm !== null);

    // Окно объясняет, что открывается личный разговор, но пароль не
    // спрашивает: он введён при входе в панель.
    assert.equal(await panel.confirmTitle(), "Открыть переписку");
    assert.equal(
      await panel.page.textContent("#confirm-eyebrow"), "ЛИЧНЫЕ ДАННЫЕ",
    );
    assert.equal(panel.countTo("/messages"), 0, "переписка ушла до подтверждения");
    assert.equal(panel.countTo("/sudo"), 0, "панель всё ещё просит sudo-грант");
  });

  test("настройки SDK правит только owner и admin", async () => {
    const viewer = await open({ role: "viewer" });
    await viewer.page.evaluate(() => openPage("letta"));
    await viewer.page.waitForSelector("#letta-settings");
    assert.equal(await viewer.page.locator("#letta-settings-form").count(), 0);

    const owner = await open();
    await owner.page.evaluate(() => openPage("letta"));
    await owner.page.waitForSelector("#letta-settings-form");
  });

  // -------------------------------------------------------------------
  // Мониторинг
  // -------------------------------------------------------------------

  test("мониторинг называет неисправный сервис, проверки и ошибки", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("monitoring"));
    await panel.page.waitForSelector("#monitoring-checks-body tr");
    assert.match(await panel.page.textContent("#monitoring-title"), /SearXNG/);
    assert.match(await panel.page.textContent("#monitoring-checks-body"), /таймаут/);
    assert.match(await panel.page.textContent("#monitoring-errors-body"), /SearXNG/);
    assert.match(await panel.page.textContent("#monitoring-host"), /eva-prod/);
  });

  test("смена окна перезапрашивает мониторинг с новым параметром", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("monitoring"));
    await panel.page.waitForSelector("#monitoring-checks-body tr");
    await panel.page.selectOption("#monitoring-hours", "168");
    await panel.page.waitForFunction(
      () => performance.now() > 0,
    );
    await panel.page.waitForTimeout(150);
    const last = panel.requests.filter((item) => item.path.includes("/panel/monitoring")).at(-1);
    assert.match(last.search, /hours=168/);
  });

  // -------------------------------------------------------------------
  // Подписки
  // -------------------------------------------------------------------

  test("карточка доступа различает ручное решение и оплату", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("subscriptions"));
    await panel.page.waitForSelector(".subscription-row");
    await panel.page.click(".subscription-row");
    await panel.page.waitForSelector("#subscription-assign-form");
    const body = await panel.page.textContent("#subscription-card-body");
    assert.match(body, /ручное решение/);
    // Снятие ручного решения доступно, отмена — тоже: подписка есть.
    assert.equal(
      await panel.page.isDisabled('[data-subscription-action="clear"]'), false,
    );
  });

  test("назначение подписки не уходит без причины", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("subscriptions"));
    await panel.page.waitForSelector(".subscription-row");
    await panel.page.click(".subscription-row");
    await panel.page.waitForSelector("#subscription-assign-form");
    await panel.page.fill('#subscription-assign-form [name="reason"]', "");
    await panel.page.evaluate(() => {
      const form = document.querySelector("#subscription-assign-form");
      form.elements.reason.removeAttribute("required");
    });
    await panel.page.click('#subscription-assign-form button[value="assign"]');
    await panel.page.waitForTimeout(120);
    assert.equal(
      panel.requests.filter((item) => item.path.includes("/assign")).length,
      0,
      "подписка назначена без причины",
    );
  });

  test("отмена подписки требует набрать идентификатор человека", async () => {
    const panel = await open();
    await panel.page.evaluate(() => openPage("subscriptions"));
    await panel.page.waitForSelector(".subscription-row");
    await panel.page.click(".subscription-row");
    await panel.page.waitForSelector('[data-subscription-action="cancel"]');
    await panel.page.click('[data-subscription-action="cancel"]');
    await panel.page.waitForFunction(() => state.pendingConfirm !== null);
    assert.equal(await panel.page.evaluate(() => state.pendingConfirm.expected), "11");
    assert.equal(
      panel.requests.filter((item) => item.path.includes("/cancel")).length,
      0,
      "подписка отменена до подтверждения",
    );
  });
});

// ---------------------------------------------------------------------
// Телефон
// ---------------------------------------------------------------------

describe("новые разделы на телефоне", () => {
  const panels = [];
  after(async () => {
    for (const panel of panels) await panel.close().catch(() => {});
  });

  const NEW_PAGES = ["agents", "subscriptions", "persona", "letta", "monitoring"];

  test("ни один новый раздел не прокручивается вбок с настоящими данными", async () => {
    const panel = await openPanel({ routes: ROUTES, viewport: PHONE });
    panels.push(panel);
    for (const name of NEW_PAGES) {
      await panel.page.evaluate((page) => openPage(page), name);
      await panel.page.waitForTimeout(160);
      const width = await panel.page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        screen: window.innerWidth,
      }));
      assert.equal(
        width.document, width.screen,
        `раздел «${name}» растягивает страницу до ${width.document} при экране ${width.screen}`,
      );
    }
  });

  test("редактор персоны помещается в узкий экран", async () => {
    const panel = await openPanel({ routes: ROUTES, viewport: PHONE });
    panels.push(panel);
    await panel.page.evaluate(() => openPage("persona"));
    await panel.page.waitForFunction(() => document.querySelector("#persona-text").value.length > 0);
    const box = await panel.page.evaluate(() => {
      const node = document.querySelector("#persona-text");
      const rect = node.getBoundingClientRect();
      return { width: rect.width, screen: window.innerWidth, height: rect.height };
    });
    assert.ok(box.width <= box.screen, `поле шире экрана: ${box.width} > ${box.screen}`);
    // Слишком высокое поле уводит кнопки «Сохранить» за экран, и до них
    // приходится прокручивать вслепую.
    assert.ok(box.height <= 400, `поле выше разумного: ${box.height}`);
  });

  test("строки мониторинга читаются на всех размерах, а не только на телефоне", async () => {
    for (const device of DEVICES) {
      const panel = await openPanel({
        routes: ROUTES,
        viewport: { width: device.width, height: device.height },
      });
      panels.push(panel);
      await panel.page.evaluate(() => openPage("monitoring"));
      await panel.page.waitForSelector(".monitor-row");
      const width = await panel.page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        screen: window.innerWidth,
      }));
      assert.equal(
        width.document, width.screen,
        `${device.name}: мониторинг растягивает страницу до ${width.document}`,
      );
      await panel.close();
    }
  });
});

/**
 * Что развёрнуто и что скачано — разные вещи.
 *
 * Пока панель называла «развёрнутым» commit рабочего дерева, прерванное
 * или откаченное обновление выглядело как успешное: в дереве новый код,
 * на стенде — прежний, и человек искал ошибку в исправлении, которое
 * до него не доехало.
 */
describe("раздел обновлений отличает развёрнутое от скачанного", () => {
  const panels = [];
  after(async () => { for (const panel of panels) await panel.close(); });

  const withUpdates = (current) => ({
    ...ROUTES,
    "/backups": { backups: [] },
    "/updates": { current, history: [] },
  });

  const openOperations = async (current) => {
    const panel = await openPanel({ routes: withUpdates(current), viewport: PHONE });
    panels.push(panel);
    await panel.page.evaluate(() => openPage("operations"));
    await panel.page.waitForFunction(
      () => document.querySelector("#update-info dl") !== null);
    return await panel.page.evaluate(() => document.querySelector("#update-info").textContent);
  };

  test("показан развёрнутый commit, а расхождение названо вслух", async () => {
    const text = await openOperations({
      branch: "main", dirty: false,
      commit: "aaaaaaaaaaaaaaaaaaaa", deployed: "bbbbbbbbbbbbbbbbbbbb",
    });
    assert.match(text, /bbbbbbbbbbbb/u, "развёрнутым назван commit из маркера");
    assert.match(text, /aaaaaaaaaaaa/u, "скачанное тоже показано");
    assert.match(text, /не развёрнут/u, "расхождение названо прямо");
  });

  test("совпали — лишней строки нет", async () => {
    const text = await openOperations({
      branch: "main", dirty: false,
      commit: "cccccccccccccccccccc", deployed: "cccccccccccccccccccc",
    });
    assert.match(text, /cccccccccccc/u);
    assert.doesNotMatch(text, /не развёрнут/u);
  });
});
