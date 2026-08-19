(() => {
  "use strict";

  const tg = window.Telegram?.WebApp;
  const DEMO = new URLSearchParams(location.search).get("demo") === "1";
  const API = "/api";
  const BUILD = "20260819-hook-v17";
  const APP_STARTED_AT = performance.now();
  const SESSION_STARTED_AT = Date.now();
  const CLIENT_SESSION_ID = globalThis.crypto?.randomUUID?.() || `session-${SESSION_STARTED_AT}-${Math.random().toString(36).slice(2,8)}`;
  const RETENTION_SCHEMA = "eva-retention-v1";
  const RETENTION_QUEUE_KEY = "eva:retention-events:v1";
  const ACTIVATION_KEY = "eva:activation:v1";
  const MEANINGFUL_KEY = "eva:meaningful-actions:v1";
  const SHIELD_KEY = "eva:streak-shield:v1";
  const FIRST_VALUE_KEY = "eva:first-value:v1";

  let retentionMemory = [];
  let activationMemory = {};
  let meaningfulMemory = [];
  let shieldMemory = {};

  const state = {
    screen: "today",
    session: null,
    sessionToken: null,
    bot: null,
    dashboard: null,
    goals: [],
    progress: null,
    profile: null,
    journalEnabled: false,
    developmentTab: "goals",
    phase: "loading",
    failed: new Set(),
    lastError: "",
    performance: {
      apiSamples: [],
      coldStartMs: null,
    },
  };

  window.addEventListener("error", (event) => {
    trackRetention("client_error", {
      message: String(event?.message || "unknown_error").slice(0, 180),
      source: "window.error",
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    trackRetention("client_error", {
      message: String(event?.reason?.message || event?.reason || "unhandled_rejection").slice(0, 180),
      source: "unhandledrejection",
    });
  });
  window.addEventListener("pagehide", () => {
    trackRetention("session_closed", {
      duration_ms: Math.max(0, Date.now() - SESSION_STARTED_AT),
      performance: performanceSnapshot(),
    });
    void flushRetentionEvents();
  });

  if (tg) {
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.(dark ? "#141a18" : "#f8faf9");
    tg.setBackgroundColor?.(dark ? "#101513" : "#f3f6f5");
    tg.setBottomBarColor?.(dark ? "#101513" : "#f3f6f5");
  }

  injectIcons(document);
  bindStaticEvents();
  setLoadingState();
  void bootstrap();

  async function bootstrap() {
    try {
      ensureFirstSession();
      state.session = await api("/public/session", { method: "POST" });
      state.sessionToken = state.session?.session_token || null;

      const [dashboard, goals, profile, progress, bot] = await Promise.all([
        safeApi("/public/v2/dashboard", {}, null),
        safeApi("/public/goals", {}, { goals: [] }),
        safeApi("/public/profile", {}, { profile: null }),
        safeApi("/public/progress", {}, { progress: null }),
        safeApi("/public/bot", {}, null, false),
      ]);

      state.dashboard = dashboard;
      state.goals = goals?.goals || [];
      state.profile = profile?.profile || null;
      state.progress = progress?.progress || null;
      state.bot = bot;

      if (!state.dashboard) {
        const [today, tasks] = await Promise.all([
          safeApi("/public/today", {}, { today: {} }),
          safeApi("/public/tasks", {}, { tasks: [] }),
        ]);
        state.dashboard = legacyDashboard(today?.today || {}, tasks?.tasks || []);
      }

      state.journalEnabled = Boolean(await window.EvaJournal?.probe?.());
      document.getElementById("journal-add-top").hidden = !state.journalEnabled;

      state.phase = "ready";
      state.performance.coldStartMs = Math.round(performance.now() - APP_STARTED_AT);
      renderAll();
      trackRetention("session_ready", {
        cold_start_ms: state.performance.coldStartMs,
        cold_start_under_2s: state.performance.coldStartMs < 2000,
      });
      void flushRetentionEvents();
      queueMicrotask(() => maybeStartFirstValueFlow());
    } catch (error) {
      state.phase = "error";
      state.lastError = friendlyError(error);
      renderAll();
      toast(state.lastError, true);
    }
  }

  function setLoadingState() {
    document.getElementById("main-focus-title").textContent = "Собираю актуальный фокус…";
    document.getElementById("reward-title").textContent = "Ева собирает личный вывод…";
    document.getElementById("development-content").innerHTML =
      '<div class="section-stack"><div class="loading-skeleton"></div><div class="loading-skeleton"></div></div>';
    document.getElementById("profile-content").innerHTML =
      '<div class="section-stack"><div class="loading-skeleton"></div><div class="loading-skeleton"></div></div>';
  }

  function renderAll() {
    renderToday();
    renderDevelopment();
    renderProfile();
    updateNotificationDot();
  }

  async function api(path, options = {}, requireTelegram = true) {
    if (DEMO) return demoApi(path, options);
    const headers = { ...(options.headers || {}) };
    if (requireTelegram) {
      if (state.sessionToken && path !== "/public/session") {
        headers["X-Eva-Webapp-Session"] = state.sessionToken;
      } else {
        const initData = tg?.initData;
        if (!initData) throw new Error("Откройте приложение из Telegram");
        headers["X-Telegram-Init-Data"] = initData;
      }
    }
    if (options.body != null && !(options.body instanceof FormData)) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
    }

    const apiStarted = performance.now();
    const response = await fetch(`${API}${path}`, { ...options, headers });
    const type = response.headers.get("content-type") || "";
    const payload = type.includes("application/json")
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => "");

    recordApiSample(path, performance.now() - apiStarted, response.status);

    if (!response.ok) {
      const message = typeof payload === "object"
        ? payload?.error?.message || payload?.message
        : "";
      const error = new Error(message || `Запрос не выполнен (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload || {};
  }

  async function safeApi(path, options, fallback, requireTelegram = true) {
    try {
      const result = await api(path, options, requireTelegram);
      state.failed.delete(sourceKey(path));
      return result;
    } catch (error) {
      state.failed.add(sourceKey(path));
      state.lastError = friendlyError(error);
      return fallback;
    }
  }

  function sourceKey(path) {
    return String(path).split("?")[0];
  }

  function friendlyError(error) {
    if (!error) return "Не удалось выполнить действие";
    if (error.status === 401) return "Сессия Telegram устарела. Закройте и снова откройте приложение.";
    if (error.status === 404) return "Функция пока не подключена на сервере.";
    if (error.status >= 500) return "Сервис временно недоступен. Данные не потеряны.";
    const message = String(error.message || "");
    return message.length < 160 ? message : "Не удалось выполнить действие";
  }

  function trackRetention(name, properties = {}) {
    const event = {
      schema: RETENTION_SCHEMA,
      name,
      ts: new Date().toISOString(),
      build: BUILD,
      session_id: CLIENT_SESSION_ID,
      properties: {
        ...properties,
        screen: state.screen,
      },
    };

    retentionMemory.push(event);
    retentionMemory = retentionMemory.slice(-250);

    try {
      const queue = JSON.parse(localStorage.getItem(RETENTION_QUEUE_KEY) || "[]");
      queue.push(event);
      localStorage.setItem(RETENTION_QUEUE_KEY, JSON.stringify(queue.slice(-250)));
    } catch {}

    try {
      window.EvaAnalytics?.track?.(name, event.properties);
    } catch {}

    try {
      window.dispatchEvent(new CustomEvent("eva:retention", { detail: event }));
    } catch {}

    return event;
  }

  function retentionQueue() {
    try {
      const stored = JSON.parse(localStorage.getItem(RETENTION_QUEUE_KEY) || "[]");
      return Array.isArray(stored) && stored.length ? stored : [...retentionMemory];
    } catch {
      return [...retentionMemory];
    }
  }

  async function flushRetentionEvents() {
    const endpoint = state.session?.analytics_endpoint || window.EVA_ANALYTICS_ENDPOINT || "";
    const queue = retentionQueue();
    if (!endpoint || !queue.length) return { sent: 0, pending: queue.length };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema: RETENTION_SCHEMA, events: queue }),
        keepalive: true,
      });
      if (!response.ok) return { sent: 0, pending: queue.length, status: response.status };
      localStorage.removeItem(RETENTION_QUEUE_KEY);
      return { sent: queue.length, pending: 0 };
    } catch {
      return { sent: 0, pending: queue.length };
    }
  }

  function retentionMetricsSnapshot() {
    const activation = activationState();
    const firstSession = activation.first_session_at ? Date.parse(activation.first_session_at) : null;
    const firstValue = activation.first_value_at ? Date.parse(activation.first_value_at) : null;
    const activated = activation.activation_completed_at ? Date.parse(activation.activation_completed_at) : null;
    const queue = retentionQueue();

    return {
      time_to_first_value_ms: firstSession && firstValue ? Math.max(0, firstValue - firstSession) : null,
      activated: Boolean(activated),
      activation_ms: firstSession && activated ? Math.max(0, activated - firstSession) : null,
      meaningful_action_count_local: meaningfulActions().length,
      retention_event_count_pending: queue.length,
      lifecycle: lifecycleState(),
      churn_risk: churnRiskState(),
      performance: performanceSnapshot(),
    };
  }

  function activationState() {
    try {
      const stored = JSON.parse(localStorage.getItem(ACTIVATION_KEY) || "{}");
      return { ...activationMemory, ...(stored || {}) };
    } catch {
      return { ...activationMemory };
    }
  }

  function updateActivation(patch) {
    const next = { ...activationState(), ...patch };
    activationMemory = next;
    try {
      localStorage.setItem(ACTIVATION_KEY, JSON.stringify(next));
    } catch {}
    return next;
  }

  function markActivationStep(step, properties = {}) {
    const current = activationState();
    const key = `${step}_at`;
    const patch = current[key] ? {} : { [key]: new Date().toISOString() };
    const next = updateActivation(patch);

    if (!current[key]) {
      trackRetention(`activation_${step}`, properties);
    }

    if (
      next.action_completed_at
      && next.reward_viewed_at
      && next.investment_completed_at
      && !next.activation_completed_at
    ) {
      const started = Date.parse(next.first_session_at || next.first_value_at || new Date().toISOString());
      const completedAt = Date.now();
      updateActivation({ activation_completed_at: new Date(completedAt).toISOString() });
      trackRetention("activation_completed", {
        activation_ms: Math.max(0, completedAt - started),
        activation_definition: "action+reward+investment",
      });
    }
  }

  function ensureFirstSession() {
    const current = activationState();
    if (current.first_session_at) return current;
    const firstSessionAt = new Date(SESSION_STARTED_AT).toISOString();
    return updateActivation({ first_session_at: firstSessionAt });
  }

  function markFirstValue(source = "home") {
    const current = ensureFirstSession();
    if (current.first_value_at) return;

    const now = Date.now();
    updateActivation({ first_value_at: new Date(now).toISOString(), first_value_source: source });
    trackRetention("first_value_ready", {
      source,
      time_to_first_value_ms: Math.max(0, Math.round(performance.now() - APP_STARTED_AT)),
      under_60s: performance.now() - APP_STARTED_AT < 60_000,
    });
  }

  function markRewardViewed(reward) {
    const today = localNowParts().dateKey;
    const impressionKey = `reward-view:${today}:${reward?.kind || "unknown"}`;
    try {
      if (sessionStorage.getItem(impressionKey)) {
        markActivationStep("reward_viewed", { reward_kind: reward?.kind || "unknown" });
        return;
      }
      sessionStorage.setItem(impressionKey, "1");
    } catch {}

    trackRetention("reward_viewed", {
      reward_kind: reward?.kind || "unknown",
      reward_type: reward?.type || "",
    });
    markActivationStep("reward_viewed", { reward_kind: reward?.kind || "unknown" });
  }

  function markInvestmentCompleted(type, properties = {}) {
    trackRetention("investment_completed", { investment_type: type, ...properties });
    markActivationStep("investment_completed", { investment_type: type });
    recordMeaningfulAction(type);
  }

  function meaningfulActions() {
    try {
      const raw = JSON.parse(localStorage.getItem(MEANINGFUL_KEY) || "[]");
      return Array.isArray(raw) && raw.length ? raw : [...meaningfulMemory];
    } catch {
      return [...meaningfulMemory];
    }
  }

  function recordMeaningfulAction(type, dateKey = localNowParts().dateKey, properties = {}) {
    const before = reactivationState();
    const action = {
      type,
      date_key: dateKey,
      ts: new Date().toISOString(),
      ...properties,
    };

    meaningfulMemory.push(action);
    meaningfulMemory = meaningfulMemory.slice(-120);

    try {
      const existing = meaningfulActions();
      if (!existing.some((item) => item.ts === action.ts && item.type === action.type)) existing.push(action);
      localStorage.setItem(MEANINGFUL_KEY, JSON.stringify(existing.slice(-120)));
    } catch {}

    trackRetention("meaningful_action", {
      action_type: type,
      date_key: dateKey,
      ...properties,
    });

    if (["24h", "48h", "72h", "7d"].includes(before.stage)) {
      trackRetention("reactivation_recovered", {
        from_stage: before.stage,
        inactive_hours: before.hours != null ? Math.round(before.hours) : null,
        recovery_action: type,
      });
    }

    return action;
  }

  function lastMeaningfulActionAt() {
    const candidates = [];

    for (const item of meaningfulActions()) {
      if (item?.ts) candidates.push(new Date(item.ts));
      else if (item?.date_key) candidates.push(new Date(`${item.date_key}T12:00:00`));
    }

    const progress = state.progress || {};
    for (const item of [
      ...(Array.isArray(progress.completed_results) ? progress.completed_results : []),
      ...(Array.isArray(progress.work_blocks) ? progress.work_blocks : []),
      ...(Array.isArray(progress.meaningful_actions) ? progress.meaningful_actions : []),
      ...(Array.isArray(window.EvaJournal?.state?.entries) ? window.EvaJournal.state.entries : []),
    ]) {
      const value = item?.completed_at || item?.achieved_at || item?.started_at || item?.created_at || item?.local_date || item?.date;
      if (!value) continue;
      const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00` : value);
      if (!Number.isNaN(date.getTime())) candidates.push(date);
    }

    return candidates.sort((a, b) => b - a)[0] || null;
  }

  function reactivationState() {
    const last = lastMeaningfulActionAt();
    if (!last) return { stage: "new", hours: null, message: null };

    const hours = Math.max(0, (Date.now() - last.getTime()) / 3_600_000);
    if (hours >= 168) return { stage: "7d", hours, message: "Собран новый фокус, чтобы начать заново" };
    if (hours >= 72) return { stage: "72h", hours, message: "Можно быстро вернуться в ритм за 2 минуты" };
    if (hours >= 48) return { stage: "48h", hours, message: "Ева собрала короткий инсайт" };
    if (hours >= 24) {
      const week = weeklyProgress();
      return {
        stage: "24h",
        hours,
        message: week.target - week.done === 1
          ? "Остался 1 шаг до цели недели"
          : "Сегодня готов короткий фокус",
      };
    }
    return { stage: "active", hours, message: null };
  }

  function recordApiSample(path, durationMs, status) {
    const sample = {
      path: sourceKey(path),
      duration_ms: Math.round(durationMs),
      status,
      ts: Date.now(),
    };
    state.performance.apiSamples.push(sample);
    state.performance.apiSamples = state.performance.apiSamples.slice(-80);

    if (durationMs > 500) {
      trackRetention("api_slow", {
        path: sample.path,
        duration_ms: sample.duration_ms,
        status,
        target_ms: 500,
      });
    }
  }

  function performanceSnapshot() {
    const samples = state.performance.apiSamples
      .map((item) => item.duration_ms)
      .sort((a, b) => a - b);
    const p95Index = samples.length ? Math.min(samples.length - 1, Math.ceil(samples.length * .95) - 1) : 0;
    const p95 = samples.length ? samples[p95Index] : null;
    return {
      cold_start_ms: state.performance.coldStartMs,
      cold_start_under_2s: state.performance.coldStartMs != null ? state.performance.coldStartMs < 2000 : null,
      api_p95_ms: p95,
      api_p95_under_500ms: p95 != null ? p95 < 500 : null,
      sample_count: samples.length,
    };
  }

  function maybeStartFirstValueFlow() {
    if (DEMO) return;

    let completed = false;
    try {
      completed = localStorage.getItem(FIRST_VALUE_KEY) === "done";
    } catch {}
    if (completed) return;

    const progress = state.progress || {};
    const hasProgress =
      (Array.isArray(progress.completed_results) && progress.completed_results.length)
      || (Array.isArray(progress.work_blocks) && progress.work_blocks.length)
      || meaningfulActions().length
      || (Array.isArray(window.EvaJournal?.state?.entries) && window.EvaJournal.state.entries.length);

    const profile = profileInvestmentState();
    if (hasProgress || profile.overall > 12) {
      try { localStorage.setItem(FIRST_VALUE_KEY, "done"); } catch {}
      return;
    }

    trackRetention("onboarding_started", { variant: "first_value_2_step" });

    openSheet({
      title: "С чего лучше начать?",
      subtitle: "Выбери только то, что сейчас даст больше пользы. Никаких длинных анкет.",
      html: `<div class="first-value-grid">
        <button class="choice-button first-value-choice" data-first-need="clarity" type="button">
          <strong>Нужна ясность</strong><span>Сузить всё до одного следующего шага</span>
        </button>
        <button class="choice-button first-value-choice" data-first-need="calm" type="button">
          <strong>Слишком много шума</strong><span>Разобрать одну мысль, которая мешает</span>
        </button>
        <button class="choice-button first-value-choice" data-first-need="decision" type="button">
          <strong>Нужно принять решение</strong><span>Отделить факт от предположений</span>
        </button>
      </div>`,
      onMount(host) {
        host.querySelectorAll("[data-first-need]").forEach((button) => {
          button.addEventListener("click", () => showFirstValueResult(button.dataset.firstNeed));
        });
      },
    });
  }

  function showFirstValueResult(need) {
    const variants = {
      clarity: {
        title: "Сузить задачу до одного следующего шага",
        insight: "Сейчас тебе не нужен весь план — достаточно выбрать ближайший шаг.",
      },
      calm: {
        title: "Назвать одну мысль, которая создаёт лишний шум",
        insight: "Когда мысль названа конкретно, с ней проще работать.",
      },
      decision: {
        title: "Отделить один факт от предположений",
        insight: "Один проверяемый факт часто даёт больше ясности, чем ещё десять вариантов.",
      },
    };
    const selected = variants[need] || variants.clarity;

    trackRetention("onboarding_need_selected", { need });
    markFirstValue("onboarding");

    openSheet({
      title: "Первый фокус готов",
      subtitle: "Это уже рабочий результат. Дальше — один короткий шаг.",
      html: `<article class="section-card first-value-result">
          <span class="eyebrow">ПЕРВЫЙ ВЫВОД</span>
          <h3>${escapeHtml(selected.insight)}</h3>
          <p>${escapeHtml(selected.title)}</p>
        </article>
        <div class="action-row">
          <button class="primary-action" id="first-value-start" type="button">Сделать за 2 минуты</button>
        </div>`,
      onMount(host) {
        host.querySelector("#first-value-start").addEventListener("click", () => {
          state.dashboard = state.dashboard || {};
          state.dashboard.main_focus = {
            id: `onboarding:${need}`,
            title: selected.title,
            subtitle: selected.insight,
            planned_minutes: 2,
            source_type: "onboarding",
            source_id: need,
          };
          try { localStorage.setItem(FIRST_VALUE_KEY, "done"); } catch {}
          trackRetention("onboarding_first_action_ready", { need, planned_minutes: 2 });
          closeSheet();
          renderToday();
          startMainFocus();
        });
      },
    });
  }

  function bindStaticEvents() {
    document.querySelectorAll(".nav-item[data-target]").forEach((button) => {
      button.addEventListener("click", () => openScreen(button.dataset.target));
    });
    document.getElementById("dialog-nav").addEventListener("click", () => openEvaHandoff(screenContext()));
    document.getElementById("journal-add-top").addEventListener("click", () => window.EvaJournal?.openNew?.());
    document.getElementById("main-focus-action").addEventListener("click", (event) => {
      event.stopPropagation();
      startMainFocus();
    });
    document.getElementById("reward-action").addEventListener("click", openCurrentReward);
    document.getElementById("reward-card").addEventListener("click", (event) => {
      if (!event.target.closest("#reward-action")) openCurrentReward();
    });
    document.getElementById("profile-investment").addEventListener("click", () => {
      trackRetention("profile_investment_opened", {
        completion_percent: profileInvestmentState().overall,
        next_focus: profileInvestmentState().next.label,
      });
      state.developmentTab = "tests";
      syncDevelopmentTabs();
      openScreen("development");
    });
    document.getElementById("streak-button").addEventListener("click", openStreakSheet);
    document.getElementById("development-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-development]");
      if (!button) return;
      state.developmentTab = button.dataset.development;
      syncDevelopmentTabs();
      renderDevelopment();
      haptic("light");
    });
    document.getElementById("sheet-close").addEventListener("click", closeSheet);
    document.getElementById("sheet").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeSheet();
    });
    tg?.BackButton?.onClick(handleBack);
    bindKeyboardHandling();
  }

  function syncDevelopmentTabs() {
    document.querySelectorAll("[data-development]").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.development === state.developmentTab);
    });
  }

  function openScreen(screen) {
    const target = document.querySelector(`[data-screen="${screen}"]`);
    if (!target) return;

    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    state.screen = screen;
    document.querySelectorAll(".screen").forEach((node) => {
      const active = node.dataset.screen === screen;
      node.hidden = !active;
      node.classList.toggle("is-active", active);
    });
    document.querySelectorAll(".nav-item[data-target]").forEach((button) => {
      const active = button.dataset.target === screen;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (screen === "today") tg?.BackButton?.hide?.();
    else tg?.BackButton?.show?.();

    target.querySelector(".scroll-content")?.scrollTo?.(0, 0);
    if (screen === "journal") void window.EvaJournal?.render?.();
    if (screen === "development") renderDevelopment();
    if (screen === "profile") renderProfile();
    haptic("light");
  }

  function handleBack() {
    const confirmDialog = document.getElementById("confirm-dialog");
    if (confirmDialog?.open) return void confirmDialog.close();
    const sheet = document.getElementById("sheet");
    if (sheet?.open) return closeSheet();
    if (state.screen !== "today") return openScreen("today");
    tg?.close?.();
  }

  function bindKeyboardHandling() {
    const viewport = window.visualViewport;
    if (viewport) {
      const apply = () => {
        const hidden = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
        document.documentElement.style.setProperty("--keyboard", `${Math.round(hidden)}px`);
      };
      viewport.addEventListener("resize", apply);
      viewport.addEventListener("scroll", apply);
      apply();
    }
    document.addEventListener("focusin", (event) => {
      const field = event.target;
      if (!(field instanceof HTMLElement) || !field.matches("input, textarea, select")) return;
      setTimeout(() => field.scrollIntoView({ block: "center", behavior: "smooth" }), 220);
    });
  }

  function localNowParts() {
    const user = state.profile?.user || state.session?.user || {};
    const timezone = user.timezone || state.session?.user?.timezone;
    try {
      const parts = new Intl.DateTimeFormat("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone: timezone || undefined,
      }).formatToParts(new Date());
      const get = (type) => parts.find((item) => item.type === type)?.value || "";
      return {
        hour: Number(get("hour")),
        dateKey: `${get("year")}-${get("month")}-${get("day")}`,
        timezone,
      };
    } catch {
      const now = new Date();
      return {
        hour: now.getHours(),
        dateKey: now.toISOString().slice(0, 10),
        timezone,
      };
    }
  }

  function renderToday() {
    const dashboard = state.dashboard || {};
    const main = dashboard.main_focus || dashboard.mainFocus || null;
    const reward = currentReward();
    const streak = streakState();
    const reactivation = reactivationState();

    renderTopStatus(main, reward, streak, reactivation);
    renderMainFocus(main);
    renderReward(reward);
    renderProfileInvestment();

    if (state.phase === "ready" && (main?.title || reward?.title)) {
      markFirstValue("home");
    }
  }

  function renderTopStatus(main, reward, streak, reactivation = reactivationState()) {
    const week = weeklyProgress();
    const ritual = ritualState();
    const summary = triggerBarText({ main, reward, streak, week, ritual, reactivation });
    trackReactivationImpression(reactivation);

    document.getElementById("today-summary").textContent = summary;
    document.getElementById("streak-days").textContent = String(streak.days);

    const avatar = document.getElementById("eva-status-avatar");
    avatar.style.setProperty("--ring-progress", `${streak.ring}%`);

    const pill = document.getElementById("streak-button");
    pill.classList.toggle("is-milestone", Boolean(streak.milestone));
    pill.classList.toggle("is-grace", Boolean(streak.graceEligible));
    pill.classList.toggle("is-perfect", Boolean(streak.perfectWeek));
    pill.setAttribute(
      "aria-label",
      `${streak.days} ${streak.days === 1 ? "день" : "дней"} подряд${streak.graceEligible ? ", серия защищена до конца дня" : ""}${streak.perfectWeek ? ", идеальная неделя" : ""}`,
    );
  }

  function trackReactivationImpression(reactivation) {
    if (!["24h", "48h", "72h", "7d"].includes(reactivation?.stage)) return;
    const key = `eva:reactivation-impression:${reactivation.stage}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {}
    trackRetention("reactivation_offer_seen", {
      stage: reactivation.stage,
      inactive_hours: reactivation.hours != null ? Math.round(reactivation.hours) : null,
      message: reactivation.message,
    });
  }

  function triggerBarText({ main, reward, streak, week, ritual, reactivation }) {
    const remaining = Math.max(0, week.target - week.done);

    if (reactivation?.message && ["48h", "72h", "7d"].includes(reactivation.stage)) {
      return reactivation.message;
    }
    if (remaining === 1) return "Остался 1 шаг до цели недели";
    if (ritual.weeklySnapshotReady) return "Снимок недели готов";
    if (reward?.kind === "curiosity") return "Ева заметила новый паттерн";
    if (reward?.kind === "question") return "Новый вопрос готов";
    if (reward?.kind === "milestone") return `${streak.days} дней — новая отметка`;
    if (ritual.period === "evening" && streak.todayDone) return "Итог дня готов";
    if (main && reward) return "1 шаг и 1 инсайт";
    if (reward) return "Новый инсайт готов";
    if (main) return "1 шаг на сегодня";
    return "Сегодняшний фокус готов";
  }

  function ritualState() {
    const local = localNowParts();
    const weekday = new Date(`${local.dateKey}T12:00:00Z`).getUTCDay();
    const period = local.hour < 12 ? "morning" : local.hour < 18 ? "day" : "evening";
    return {
      period,
      weekday,
      weeklySnapshotReady: weekday === 0 && activityDates().some((date) => inCurrentWeek(date)),
    };
  }

  function renderMainFocus(main) {
    const title = main?.title || main?.main_action || "Выбрать один шаг вместе с Евой";
    const plannedMinutes = Number(main?.planned_minutes || main?.duration_minutes || 0) || 6;
    const source = main?.subtitle
      || main?.next_step
      || main?.source_label
      || main?.goal_title
      || "Один короткий шаг перед следующим результатом";

    document.getElementById("main-focus-title").textContent = conciseTitle(title);
    document.getElementById("main-focus-source").textContent = conciseFocusSubtitle(source);
    document.getElementById("hero-duration").textContent = `${plannedMinutes} мин`;

    const button = document.getElementById("main-focus-action");
    button.disabled = state.phase === "loading";
    button.firstElementChild.textContent = main?.work_block_status === "active"
      ? "Продолжить"
      : main?.id || main?.work_block_id
        ? "Продолжить"
        : "Выбрать шаг";

    const week = weeklyProgress();
    const remaining = Math.max(0, week.target - week.done);
    document.getElementById("week-progress-label").textContent = remaining === 1
      ? `Неделя: ${week.done} из ${week.target} шагов · Остался 1 шаг`
      : `Неделя: ${week.done} из ${week.target} шагов`;
    document.getElementById("week-progress-bar").style.width = `${week.percent}%`;
    document.getElementById("main-focus-card").classList.toggle("is-near-week-goal", remaining === 1);
  }

  function conciseTitle(value) {
    const text = String(value || "").trim();
    if (!text) return "Продолжить путь";
    return text.length > 72 ? `${text.slice(0, 69).trim()}…` : text;
  }

  function conciseFocusSubtitle(source) {
    const text = String(source || "")
      .replace(/^Цель:\s*/i, "")
      .replace(/^Результат:\s*/i, "")
      .trim();
    if (!text) return "Один короткий шаг перед следующим результатом";
    return text.length > 82 ? `${text.slice(0, 79).trim()}…` : text;
  }


  function openMainFocusSheet() {
    const main = state.dashboard?.main_focus || {};
    const alternatives = state.dashboard?.main_focus_candidates || [];
    openSheet({
      title: "Следующий шаг",
      subtitle: "Ева связывает его с активной целью и фактической точкой продолжения.",
      html: `<div class="section-stack">
        <article class="section-card">
          <span class="eyebrow">ТЕКУЩИЙ ВЫБОР</span>
          <h3>${escapeHtml(main.title || "Пока не выбран")}</h3>
          <p>${escapeHtml(main.reason || main.source_label || "Выбор по актуальному контексту")}</p>
          ${main.expected_result ? `<p><strong>Результат:</strong> ${escapeHtml(main.expected_result)}</p>` : ""}
        </article>
        ${alternatives.length ? `<div class="section-stack">${alternatives.slice(0,3).map((item) => `<button class="secondary-action" data-focus-candidate="${escapeAttr(item.id || item.title)}" type="button">${escapeHtml(item.title)}</button>`).join("")}</div>` : ""}
        <div class="action-row">
          <button class="primary-action" data-focus-action="eva" type="button">Обсудить с Евой</button>
          <button class="secondary-action" data-focus-action="auto" type="button">Автовыбор</button>
        </div>
      </div>`,
      onMount(host) {
        host.querySelectorAll("[data-focus-candidate]").forEach((button) => button.addEventListener("click", async () => {
          const item = alternatives.find((candidate) => String(candidate.id || candidate.title) === button.dataset.focusCandidate);
          if (!item) return;
          try {
            const result = await api("/public/v2/main-result", { method: "PUT", body: JSON.stringify(item) });
            state.dashboard.main_focus = result.main_focus || item;
            closeSheet();
            renderToday();
            toast("Следующий шаг обновлён");
          } catch (error) {
            toast(friendlyError(error), true);
          }
        }));
        host.querySelectorAll("[data-focus-action]").forEach((button) => button.addEventListener("click", async () => {
          if (button.dataset.focusAction === "eva") {
            return openEvaHandoff(`Помоги уточнить следующий шаг: ${main.title || "пока не выбран"}`);
          }
          try {
            await api("/public/v2/main-result", { method: "DELETE" });
            await refreshDashboard();
            closeSheet();
            toast("Автоматический выбор включён");
          } catch (error) {
            toast(friendlyError(error), true);
          }
        }));
      },
    });
  }

  async function startMainFocus() {
    const main = state.dashboard?.main_focus || {};
    if (!main.title) return openMainFocusSheet();

    const payload = {
      title: main.title,
      planned_minutes: Number(main.planned_minutes || main.duration_minutes || 0) || 6,
      source_type: main.source_type || null,
      source_id: main.source_id || null,
      work_block_id: main.work_block_id || null,
    };

    const button = document.getElementById("main-focus-action");
    button.disabled = true;
    trackRetention("core_action_started", {
      planned_minutes: payload.planned_minutes,
      source_type: payload.source_type,
    });
    try {
      const result = await api("/public/v2/focus-sessions", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      startFocusTimer(result.focus_session, payload);
      haptic("success");
    } catch (error) {
      toast(friendlyError(error), true);
    } finally {
      button.disabled = false;
    }
  }

  function openFocusSheet(main) {
    openSheet({
      title: "Начать следующий шаг",
      subtitle: "Таймер нужен только для старта. Важен конкретный результат.",
      html: `<form class="form-grid" id="focus-form">
        <label><span>Результат</span><input name="title" maxlength="500" required value="${escapeAttr(main.title || "")}"></label>
        <fieldset><legend>Сколько времени выделить?</legend><div class="choice-grid">${[5,15,25,45].map((minutes) => `<button class="choice-button ${minutes === 15 ? "is-selected" : ""}" type="button" data-minutes="${minutes}">${minutes} минут</button>`).join("")}</div></fieldset>
        <input type="hidden" name="minutes" value="15">
        <button class="primary-action" type="submit">Начать</button>
      </form>`,
      onMount(host) {
        const form = host.querySelector("#focus-form");
        host.querySelectorAll("[data-minutes]").forEach((button) => button.addEventListener("click", () => {
          form.elements.minutes.value = button.dataset.minutes;
          host.querySelectorAll("[data-minutes]").forEach((item) => item.classList.toggle("is-selected", item === button));
        }));
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const raw = Object.fromEntries(new FormData(form).entries());
          const payload = {
            title: raw.title.trim(),
            planned_minutes: Number(raw.minutes),
            source_type: main.source_type || null,
            source_id: main.source_id || null,
            work_block_id: main.work_block_id || null,
          };
          try {
            const result = await api("/public/v2/focus-sessions", { method: "POST", body: JSON.stringify(payload) });
            closeSheet();
            startFocusTimer(result.focus_session, payload);
          } catch (error) {
            toast(friendlyError(error), true);
          }
        });
      },
    });
  }

  function startFocusTimer(session, payload) {
    const started = Date.now();
    const ends = started + payload.planned_minutes * 60_000;
    const timer = document.createElement("button");
    timer.className = "toast";
    timer.hidden = false;
    timer.type = "button";
    document.body.appendChild(timer);

    const finish = async () => {
      clearInterval(interval);
      timer.remove();
      const actualMinutes = Math.max(1, Math.round((Date.now() - started) / 60000));
      try {
        await api(`/public/v2/focus-sessions/${encodeURIComponent(session?.id || "0")}/complete`, {
          method: "POST",
          body: JSON.stringify({ actual_minutes: actualMinutes, actual_result: payload.title }),
        });

        const [dashboard, progress] = await Promise.all([
          safeApi("/public/v2/dashboard", {}, null),
          safeApi("/public/progress", {}, null),
        ]);
        if (dashboard) state.dashboard = dashboard;
        if (progress?.progress) state.progress = progress.progress;

        recordMeaningfulAction("daily_step", localNowParts().dateKey, {
          actual_minutes: actualMinutes,
          planned_minutes: payload.planned_minutes,
        });
        completeShieldRecoveryIfPending();
        markActivationStep("action_completed", {
          action_type: "daily_step",
          actual_minutes: actualMinutes,
        });
        trackRetention("core_action_completed", {
          actual_minutes: actualMinutes,
          planned_minutes: payload.planned_minutes,
        });

        renderToday();
        haptic("success");
        toast("Готово. Теперь посмотри, что Ева заметила.");
      } catch {
        toast("Шаг завершён. Обновление прогресса появится чуть позже.");
      }
    };
    const tick = () => {
      const remaining = Math.max(0, ends - Date.now());
      timer.textContent = `${clock(remaining)} · ${payload.title} · завершить`;
      if (remaining === 0) void finish();
    };
    const interval = setInterval(tick, 1000);
    timer.addEventListener("click", finish, { once: true });
    tick();
  }

  function openContextReset() {
    openSheet({
      title: "Короткая перезагрузка",
      subtitle: "Это не лечение и не тест. Выбери только то, что сейчас комфортно.",
      html: `<div class="section-stack">
        <button class="section-card" data-practice="breath" type="button"><h3>Ровное дыхание</h3><p>Мягко удлинить выдох без задержек и усилия.</p></button>
        <button class="section-card" data-practice="ground" type="button"><h3>Заземление 5–4–3–2–1</h3><p>Вернуть внимание к тому, что видишь, слышишь и ощущаешь.</p></button>
        <button class="section-card" data-practice="sort" type="button"><h3>Разложить мысли</h3><p>Сейчас, позже и вне контроля.</p></button>
      </div>`,
      onMount(host) {
        host.querySelectorAll("[data-practice]").forEach((button) => button.addEventListener("click", () => runPractice(button.dataset.practice)));
      },
    });
  }

  function runPractice(code) {
    const practices = {
      breath: ["Ровное дыхание", "Дыши в удобном ритме и мягко сделай выдох немного длиннее вдоха. Не задерживай дыхание. Остановись при дискомфорте."],
      ground: ["Заземление 5–4–3–2–1", "Назови 5 вещей, которые видишь; 4 ощущения тела; 3 звука; 2 запаха; 1 вкус или спокойный вдох."],
      sort: ["Разложить мысли", "Раздели всё, что занимает внимание, на три группы: «сейчас», «позже», «вне контроля». В «сейчас» оставь один доступный шаг."],
    };
    const [title, text] = practices[code] || practices.sort;
    openSheet({
      title,
      subtitle: "Можно остановиться в любой момент.",
      html: `<article class="section-card"><p>${escapeHtml(text)}</p></article>
        <div class="action-row">
          <button class="primary-action" id="practice-done" type="button">Готово</button>
          ${state.journalEnabled ? '<button class="secondary-action" id="practice-write" type="button">Записать</button>' : ""}
        </div>`,
      onMount(host) {
        host.querySelector("#practice-done").addEventListener("click", closeSheet);
        host.querySelector("#practice-write")?.addEventListener("click", () => {
          closeSheet();
          window.EvaJournal?.openNew?.();
        });
      },
    });
  }


  function renderDevelopment() {
    const host = document.getElementById("development-content");
    if (!host) return;
    syncDevelopmentTabs();
    if (state.phase === "loading") return;
    if (state.failed.has("/public/goals") || state.failed.has("/public/progress")) {
      host.innerHTML = `${emptyState("Данные не загрузились", state.lastError || "Сервис временно недоступен")}
        <div class="action-row"><button class="primary-action" data-retry type="button">Повторить</button></div>`;
      host.querySelector("[data-retry]")?.addEventListener("click", () => void retryBootstrap());
      return;
    }
    if (state.developmentTab === "progress") return renderProgress(host);
    if (state.developmentTab === "tests") return renderTests(host);
    renderGoals(host);
  }

  function renderTests(host) {
    const profile = profileInvestmentState();
    host.innerHTML = `<div class="section-stack">
      <article class="tests-placeholder">
        <span class="tests-placeholder-icon">${icon("brain")}</span>
        <span class="eyebrow">ТЕСТЫ И САМОПОЗНАНИЕ · СКОРО</span>
        <h2>Профиль, который становится точнее со временем</h2>
        <p>Личность, эмоции, отношения и профориентация будут собираться в единый профиль Евы. До подключения юридически допустимых методик результаты не имитируются.</p>
        <div class="tests-tags"><span>Личность</span><span>Эмоции</span><span>Отношения</span><span>Профориентация</span></div>
      </article>
      <article class="section-card">
        <span class="eyebrow">ТЕКУЩАЯ ИНВЕСТИЦИЯ</span>
        <h3>Профиль самопонимания: ${profile.overall}%</h3>
        <div class="goal-progress"><span style="width:${profile.overall}%"></span></div>
        <p>Эмоции ${profile.emotions}% · Отношения ${profile.relationships}% · Цели ${profile.goals}%</p>
      </article>
    </div>`;
  }

  function renderGoals(host) {
    const goals = state.goals || [];
    if (!goals.length) {
      host.innerHTML = `${emptyState("Целей пока нет", "Добавь один результат, который действительно хочешь приблизить.")}
        <div class="action-row"><button class="primary-action" id="add-goal" type="button">Добавить цель</button></div>`;
      host.querySelector("#add-goal").addEventListener("click", openGoalSheet);
      return;
    }

    host.innerHTML = `<div class="section-stack">
      ${goals.map((goal) => {
        const progress = Math.max(0, Math.min(100, Number(goal.progress_percent || 0)));
        return `<article class="section-card">
          <span class="eyebrow">${goal.status === "active" ? "АКТИВНАЯ ЦЕЛЬ" : "ЦЕЛЬ"}</span>
          <h3>${escapeHtml(goal.title)}</h3>
          ${goal.why_it_matters ? `<p>${escapeHtml(goal.why_it_matters)}</p>` : ""}
          <div class="goal-progress"><span style="width:${progress}%"></span></div>
          <p>${progress}% · ${escapeHtml(goal.next_result || goal.next_step || "Следующий результат ещё не определён")}</p>
        </article>`;
      }).join("")}
      <button class="primary-action" id="add-goal" type="button">Добавить цель</button>
    </div>`;
    host.querySelector("#add-goal").addEventListener("click", openGoalSheet);
  }

  function openGoalSheet() {
    openSheet({
      title: "Новая цель",
      subtitle: "Формулируй результат, а не обязанность быть идеальным.",
      html: `<form class="form-grid" id="goal-form">
        <label><span>Что должно измениться?</span><input name="title" maxlength="500" required></label>
        <label><span>Почему это важно?</span><textarea name="why_it_matters" maxlength="5000" rows="3"></textarea></label>
        <label><span>Желаемый срок</span><input name="target_date" type="date"></label>
        <button class="primary-action" type="submit">Сохранить цель</button>
      </form>`,
      onMount(host) {
        host.querySelector("#goal-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
          try {
            const result = await api("/public/goals", { method: "POST", body: JSON.stringify(payload) });
            if (result.goal) state.goals.unshift(result.goal);
            closeSheet();
            renderDevelopment();
            await refreshDashboard();
            toast("Цель добавлена");
          } catch (error) {
            toast(friendlyError(error), true);
          }
        });
      },
    });
  }

  function renderProgress(host) {
    const progress = state.progress || {};
    const results = Array.isArray(progress.completed_results) ? progress.completed_results : [];
    const blocks = Array.isArray(progress.work_blocks) ? progress.work_blocks : [];
    const goals = Array.isArray(progress.goals) ? progress.goals : state.goals;

    host.innerHTML = `<div class="section-stack">
      <div class="summary-row">
        <div class="summary-pill"><strong>${results.length}</strong><span>результатов</span></div>
        <div class="summary-pill"><strong>${blocks.length}</strong><span>фокус-сессий</span></div>
        <div class="summary-pill"><strong>${(goals || []).length}</strong><span>целей</span></div>
      </div>
      <article class="section-card">
        <span class="eyebrow">ПОСЛЕДНИЕ РЕЗУЛЬТАТЫ</span>
        ${results.length
          ? results.slice(0,6).map((item) => `<p><strong>${escapeHtml(item.title || "Результат")}</strong>${item.goal_title ? `<br>${escapeHtml(item.goal_title)}` : ""}</p>`).join("")
          : "<p>Завершённые результаты появятся здесь после работы с целями.</p>"}
      </article>
      <button class="primary-action" id="progress-eva" type="button">Подвести итог с Евой</button>
    </div>`;
    host.querySelector("#progress-eva").addEventListener("click", () => {
      openEvaHandoff("Подведи итог моего прогресса: реальные результаты, что повторяется, что тормозит и один следующий фокус. Не придумывай данные, которых нет.");
    });
  }

  function renderProfile() {
    const host = document.getElementById("profile-content");
    if (!host || state.phase === "loading") return;
    if (state.failed.has("/public/profile")) {
      host.innerHTML = `${emptyState("Профиль не загрузился", state.lastError || "Сервис временно недоступен")}
        <div class="action-row"><button class="primary-action" data-retry type="button">Повторить</button></div>`;
      host.querySelector("[data-retry]")?.addEventListener("click", () => void retryBootstrap());
      return;
    }

    const user = state.profile?.user || state.session?.user || {};
    const known = [
      ["Как обращаться", user.preferred_name || user.first_name],
      ["Город", user.city],
      ["Часовой пояс", user.timezone],
      ["Стиль общения", user.communication_style],
      ["Формат ответа", responseModeTitle(user.response_mode)],
      ["Активные цели", state.goals.filter((goal) => goal.status === "active").length || null],
    ].filter(([,value]) => value !== undefined && value !== null && value !== "");

    host.innerHTML = `<div class="profile-stack">
      <article class="profile-summary">
        <span class="profile-avatar">${icon("user")}</span>
        <div><h3>${escapeHtml(user.preferred_name || user.first_name || "Пользователь")}</h3>
        <p>${escapeHtml(user.city || "Город пока не указан")} · ${escapeHtml(user.timezone || "часовой пояс уточняется")}</p></div>
      </article>

      <article class="section-card">
        <span class="eyebrow">ЧТО ЕВА УЖЕ ЗНАЕТ</span>
        <h2>Профиль растёт постепенно</h2>
        <p>Не нужно заполнять большую анкету. Ева уточняет только уместные данные по ходу общения.</p>
        <div class="known-grid">${known.length
          ? known.map(([label,value]) => `<div class="known-card"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`).join("")
          : '<div class="known-card"><small>Пока мало данных</small><strong>Начни с обычного разговора с Евой</strong></div>'}
        </div>
        <div class="action-row"><button class="primary-action" id="edit-profile" type="button">Изменить данные</button></div>
      </article>

      <div class="settings-list">
        ${settingsRow("conversations", "Диалоги с Евой", "Создать, выбрать или архивировать диалог", "Открыть")}
        ${settingsRow("subscription", "Подписка и квоты", "Текущий доступ и остаток квоты", state.session?.plan || "free")}
        ${settingsRow("voice", "Формат ответов", "Текст, голос или оба", responseModeTitle(user.response_mode))}
        ${settingsRow("notifications", "Уведомления", "Конкретные поводы вернуться к Еве", state.dashboard?.next_reminder ? "Есть ближайшее" : "Открыть")}
        ${settingsRow("privacy", "Приватность", "Как хранятся данные и память Евы", "Открыть")}
      </div>
    </div>`;

    injectIcons(host);
    host.querySelector("#edit-profile").addEventListener("click", openProfileSheet);
    host.querySelectorAll("[data-setting]").forEach((button) => {
      button.addEventListener("click", () => openSetting(button.dataset.setting));
    });
  }

  function settingsRow(code, title, note, status) {
    const icons = { conversations: "chat", subscription: "card", voice: "voice", notifications: "bell", privacy: "shield" };
    return `<button class="settings-row" data-setting="${code}" type="button">
      <span data-icon="${icons[code]}"></span>
      <span><strong>${title}</strong><small>${note}</small></span>
      <em>${escapeHtml(status)}</em>
    </button>`;
  }

  function openProfileSheet() {
    const user = state.profile?.user || state.session?.user || {};
    openSheet({
      title: "Личные данные",
      subtitle: "Сохраняются только те поля, которые ты явно изменил.",
      html: `<form class="form-grid" id="profile-form">
        <label><span>Как обращаться</span><input name="preferred_name" maxlength="100" value="${escapeAttr(user.preferred_name || user.first_name || "")}"></label>
        <label><span>Город</span><input name="city" maxlength="200" value="${escapeAttr(user.city || "")}"></label>
        <label><span>Стиль общения</span><textarea name="communication_style" maxlength="2000" rows="3">${escapeHtml(user.communication_style || "")}</textarea></label>
        <button class="primary-action" type="submit">Сохранить</button>
      </form>`,
      onMount(host) {
        host.querySelector("#profile-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const raw = Object.fromEntries(new FormData(event.currentTarget).entries());
          const fields = Object.fromEntries(
            Object.entries(raw)
              .map(([key,value]) => [key, String(value).trim()])
              .filter(([,value]) => value),
          );
          try {
            const result = await api("/public/profile", { method: "PATCH", body: JSON.stringify({ fields }) });
            state.profile = result.profile || state.profile;
            markInvestmentCompleted("profile_update", { fields: Object.keys(fields) });
            closeSheet();
            renderProfile();
            renderToday();
            toast("Профиль обновлён");
          } catch (error) {
            toast(friendlyError(error), true);
          }
        });
      },
    });
  }

  const RESPONSE_MODES = [
    { value: "text", title: "Текст", note: "Ева отвечает только текстом." },
    { value: "both", title: "Голос + текст", note: "Ева присылает текст и голосовое сообщение." },
    { value: "voice", title: "Только голос", note: "Ева присылает голосовое сообщение без текста." },
  ];

  function responseModeTitle(value) {
    return (RESPONSE_MODES.find((mode) => mode.value === value) || RESPONSE_MODES[0]).title;
  }

  function openSetting(code) {
    if (code === "conversations") return void openConversationsSheet();
    if (code === "voice") return void openResponseModeSheet();
    if (code === "subscription") return openSubscriptionSheet();
    if (code === "notifications") return openNotificationsSheet();
    if (code === "privacy") return openPrivacySheet();
  }

  function openResponseModeSheet() {
    const current = state.profile?.user?.response_mode || "text";
    openSheet({
      title: "Формат ответов",
      subtitle: "Если синтез голоса временно недоступен, текстовый ответ не теряется.",
      html: `<div class="settings-list">${RESPONSE_MODES.map((mode) => `<button class="settings-row" type="button" data-response-mode="${mode.value}">
        <span data-icon="voice"></span>
        <span><strong>${mode.title}</strong><small>${mode.note}</small></span>
        <em>${mode.value === current ? "Выбрано" : ""}</em>
      </button>`).join("")}</div>`,
      onMount(host) {
        injectIcons(host);
        host.querySelectorAll("[data-response-mode]").forEach((button) => {
          button.addEventListener("click", () => void saveResponseMode(button.dataset.responseMode));
        });
      },
    });
  }

  async function saveResponseMode(mode) {
    try {
      const result = await api("/public/profile", { method: "PATCH", body: JSON.stringify({ response_mode: mode }) });
      state.profile = result.profile || state.profile;
      closeSheet();
      renderProfile();
      toast(`Формат ответов: ${responseModeTitle(mode).toLowerCase()}`);
    } catch (error) {
      toast(friendlyError(error), true);
    }
  }

  function openSubscriptionSheet() {
    const plan = state.session?.plan || "free";
    const quotas = Array.isArray(state.session?.quotas) ? state.session.quotas : [];
    openSheet({
      title: "Подписка и квоты",
      html: `<article class="section-card">
        <span class="eyebrow">ТЕКУЩИЙ ДОСТУП</span>
        <h3>${escapeHtml(plan)}</h3>
        ${quotas.length
          ? quotas.map((item) => `<p>${escapeHtml(item.name || item.type || "Квота")}: <strong>${escapeHtml(item.remaining ?? item.value ?? "—")}</strong></p>`).join("")
          : "<p>Подробная квота не передана сервером.</p>"}
      </article>`,
    });
  }

  function openPrivacySheet() {
    openSheet({
      title: "Приватность",
      subtitle: "WebApp показывает только продуктовые данные пользователя.",
      html: `<div class="section-stack">
        <article class="section-card"><h3>Память Евы</h3><p>Долговременная память и история диалогов принадлежат агенту Letta. WebApp не зеркалирует переписку в отдельную ленту.</p></article>
        <article class="section-card"><h3>Дневник</h3><p>Запись хранится отдельно и не передаётся Еве автоматически. Для обсуждения нужна отдельная команда пользователя.</p></article>
        <article class="section-card"><h3>Третьи лица</h3><p>Ева не строит скрытые психологические профили других людей по твоим записям.</p></article>
      </div>`,
    });
  }

  async function openConversationsSheet() {
    openSheet({
      title: "Диалоги с Евой",
      subtitle: "Новый диалог не создаёт новую Еву и не стирает её память.",
      html: '<div id="conversations-host"><div class="loading-skeleton"></div></div>',
      onMount() { void refreshConversations(); },
    });
  }

  async function refreshConversations() {
    const host = document.getElementById("conversations-host");
    if (!host) return;
    try {
      const conversations = (await api("/public/conversations")).conversations || [];
      host.innerHTML = `<form class="form-grid" id="conversation-create-form">
        <label><span>Новый диалог</span><input id="new-conversation-title" maxlength="120" value="Новый диалог"></label>
        <button class="primary-action" type="submit">Создать</button>
      </form>
      <div class="conversation-list" style="margin-top:12px">
        ${conversations.length ? conversations.map((item) => `<article class="section-card">
          <h3>${escapeHtml(item.title || "Диалог с Евой")}</h3>
          <p>${item.active
            ? `<span class="conversation-badge">Активный</span> Сначала выберите другой диалог, чтобы этот можно было архивировать.`
            : "Можно сделать активным или архивировать."}</p>
          ${item.active ? "" : `<div class="action-row">
            <button class="primary-action conversation-action" data-activate-conversation="${escapeAttr(item.id)}" type="button">Активировать</button>
            <button class="danger-action conversation-action" data-archive-conversation="${escapeAttr(item.id)}" type="button">Архивировать</button>
          </div>`}
        </article>`).join("") : emptyState("Диалогов пока нет", "Создай первый диалог с Евой.")}
      </div>`;

      host.querySelector("#conversation-create-form").addEventListener("submit", (event) => {
        event.preventDefault();
        void createConversation();
      });
      host.querySelectorAll("[data-activate-conversation]").forEach((button) => {
        button.addEventListener("click", async () => {
          try {
            await api(`/public/conversations/${encodeURIComponent(button.dataset.activateConversation)}/activate`, {
              method: "POST",
              body: "{}",
            });
            await refreshConversations();
            toast("Диалог активирован");
          } catch (error) {
            toast(friendlyError(error), true);
          }
        });
      });
      host.querySelectorAll("[data-archive-conversation]").forEach((button) => {
        button.addEventListener("click", async () => {
          const ok = await confirmDanger({
            title: "Архивировать диалог?",
            detail: "История сохранится, но диалог исчезнет из активного списка.",
            confirmLabel: "Архивировать",
          });
          if (!ok) return;
          try {
            await api(`/public/conversations/${encodeURIComponent(button.dataset.archiveConversation)}`, { method: "DELETE" });
            await refreshConversations();
            toast("Диалог архивирован");
          } catch (error) {
            toast(friendlyError(error), true);
          }
        });
      });
    } catch (error) {
      host.innerHTML = emptyState("Диалоги не загрузились", friendlyError(error));
    }
  }

  async function createConversation() {
    const title = document.getElementById("new-conversation-title")?.value.trim();
    if (!title) return;
    try {
      await api("/public/conversations", { method: "POST", body: JSON.stringify({ title }) });
      await refreshConversations();
      toast("Диалог создан");
    } catch (error) {
      toast(friendlyError(error), true);
    }
  }

  function openNotificationsSheet() {
    const next = state.dashboard?.next_reminder;
    const triggers = notificationTriggerCandidates();

    const policy = notificationPolicy();
    openSheet({
      title: "Уведомления",
      subtitle: "Ева напоминает только когда есть конкретная ценность.",
      html: `<div class="section-stack">
        ${next ? `<article class="section-card"><span class="eyebrow">БЛИЖАЙШЕЕ</span><h3>${escapeHtml(next.title)}</h3><p>${formatDateTime(next.remind_at)}</p></article>` : ""}
        <article class="section-card">
          <span class="eyebrow">РЕЖИМ</span>
          <h3>${policy.opt_in_allowed ? "Персональные поводы, не чаще 3 раз в неделю" : "Сначала первая ценность — потом уведомления"}</h3>
          <p>${policy.opt_in_allowed ? "Базовый режим: 1–3 уведомления в неделю. Общие broadcast-пуши не используются." : "Запрос разрешения на push не должен появляться до завершения первого полезного цикла."}</p>
        </article>
        <article class="section-card">
          <span class="eyebrow">КАКИЕ ПОВОДЫ МОГУТ ПРИЙТИ</span>
          ${triggers.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
        </article>
      </div>`,
    });
  }

  function notificationTriggerCandidates() {
    const main = state.dashboard?.main_focus || null;
    const reward = rewardState || currentReward();
    const streak = streakState();
    const week = weeklyProgress();
    const ritual = ritualState();
    const reactivation = reactivationState();
    const candidates = [];

    if (reactivation.message && ["24h", "48h", "72h", "7d"].includes(reactivation.stage)) {
      candidates.push(`${reactivation.message}.`);
    }

    if (reward.kind === "curiosity") candidates.push("Ева заметила новый паттерн.");
    else if (reward.kind === "question") candidates.push("Сегодня готов один вопрос, который может дать новый фокус.");
    else candidates.push("Сегодня готов короткий инсайт.");

    if (week.target - week.done === 1) candidates.push("Остался 1 шаг до цели недели.");
    if (streak.graceEligible) candidates.push("Один короткий шаг сегодня сохранит твой ритм.");
    if (ritual.period === "evening" && streak.todayDone) candidates.push("Итог дня готов — можно сохранить одну важную мысль.");
    if (ritual.weeklySnapshotReady) candidates.push("Ева собрала снимок твоей недели.");
    if (main && !streak.todayDone) candidates.push("Сегодня достаточно одного короткого шага.");

    return [...new Set(candidates)].slice(0, 4);
  }

  function notificationPolicy() {
    const activation = activationState();
    return {
      min_per_week: 1,
      max_per_week: 3,
      opt_in_allowed: Boolean(activation.activation_completed_at || activation.first_value_at),
      generic_broadcast_allowed: false,
    };
  }

  function lifecycleState() {
    const activation = activationState();
    const reactivation = reactivationState();
    if (!activation.first_value_at) return "new";
    if (!activation.activation_completed_at) return "activating";
    if (["24h", "48h", "72h", "7d"].includes(reactivation.stage)) return `reactivation_${reactivation.stage}`;
    return "active";
  }

  function churnRiskState() {
    const reactivation = reactivationState();
    const streak = streakState();
    if (reactivation.stage === "7d") return { level: "high", reason: "inactive_7d" };
    if (reactivation.stage === "72h") return { level: "medium", reason: "inactive_72h" };
    if (reactivation.stage === "48h") return { level: "medium", reason: "inactive_48h" };
    if (streak.protectionAvailable) return { level: "watch", reason: "streak_recovery_window" };
    return { level: "low", reason: "active" };
  }

  function updateNotificationDot() {
    const dot = document.getElementById("notification-dot");
    if (dot) dot.hidden = !state.dashboard?.next_reminder;
  }

  function openEvaHandoff(context = "") {
    closeSheet();
    openSheet({
      title: "Обсудить с Евой",
      subtitle: "Контекст копируется, затем открывается чат.",
      html: `<article class="section-card"><p>${escapeHtml(context || "Продолжить разговор")}</p></article>
        <div class="action-row">
          <button class="primary-action" id="open-eva-chat" type="button">Открыть чат</button>
          <button class="secondary-action" id="copy-eva-context" type="button">Скопировать</button>
        </div>`,
      onMount(host) {
        host.querySelector("#copy-eva-context").addEventListener("click", async () => {
          await copyText(context);
          toast("Формулировка скопирована");
        });
        host.querySelector("#open-eva-chat").addEventListener("click", async () => {
          await copyText(context);
          const username = state.bot?.username;
          if (username) tg?.openTelegramLink?.(`https://t.me/${username.replace(/^@/, "")}`);
          else {
            toast("Вернись в чат с Евой — формулировка скопирована");
            setTimeout(() => tg?.close?.(), 700);
          }
        });
      },
    });
  }

  function openSheet({ title, subtitle = "", html, onMount }) {
    const sheet = document.getElementById("sheet");
    document.getElementById("sheet-title").textContent = title;
    const subtitleNode = document.getElementById("sheet-subtitle");
    subtitleNode.textContent = subtitle;
    subtitleNode.hidden = !subtitle;
    const host = document.getElementById("sheet-content");
    host.innerHTML = html;
    injectIcons(host);
    if (!sheet.open) sheet.showModal();
    sheet.querySelector(".sheet-card").scrollTo(0, 0);
    onMount?.(host);
  }

  function closeSheet() {
    const sheet = document.getElementById("sheet");
    if (sheet.open) sheet.close();
  }

  function confirmDanger({ title, detail, confirmLabel = "Удалить" }) {
    const dialog = document.getElementById("confirm-dialog");
    dialog.querySelector("#confirm-title").textContent = title;
    dialog.querySelector("#confirm-detail").textContent = detail;
    const accept = dialog.querySelector("#confirm-accept");
    accept.textContent = confirmLabel;
    return new Promise((resolve) => {
      let decided = false;
      const finish = (value) => {
        if (decided) return;
        decided = true;
        accept.removeEventListener("click", onAccept);
        dialog.removeEventListener("close", onClose);
        dialog.removeEventListener("click", onBackdrop);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onAccept = () => finish(true);
      const onClose = () => finish(false);
      const onBackdrop = (event) => { if (event.target === dialog) finish(false); };
      accept.addEventListener("click", onAccept);
      dialog.addEventListener("close", onClose);
      dialog.addEventListener("click", onBackdrop);
      dialog.querySelector("#confirm-cancel").onclick = () => finish(false);
      dialog.showModal();
      dialog.querySelector("#confirm-cancel").focus();
    });
  }

  let toastTimer;
  function toast(message, error = false) {
    const node = document.getElementById("toast");
    node.textContent = message;
    node.classList.toggle("is-error", error);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
  }

  async function retryBootstrap() {
    state.phase = "loading";
    state.failed.clear();
    state.lastError = "";
    setLoadingState();
    await bootstrap();
  }

  async function refreshDashboard() {
    const dashboard = await safeApi("/public/v2/dashboard", {}, null);
    if (dashboard) {
      state.dashboard = dashboard;
      renderToday();
      updateNotificationDot();
    }
  }

  function injectIcons(root) {
    root.querySelectorAll?.("[data-icon]").forEach((node) => {
      node.innerHTML = icon(node.dataset.icon);
    });
  }

  function icon(name) {
    const paths = {
      bell: '<path d="M10 26c3-3 4-7 4-12a6 6 0 0 1 12 0c0 5 1 9 4 12Z"/><path d="M17 30a4 4 0 0 0 8 0M20 8V4"/>',
      smile: '<circle cx="18" cy="18" r="14"/><circle cx="13" cy="15" r="1.5" fill="currentColor" stroke="none"/><circle cx="23" cy="15" r="1.5" fill="currentColor" stroke="none"/><path d="M12 22c3 4 9 4 12 0"/>',
      bolt: '<path d="m21 2-12 19h9l-3 13 13-21h-9Z"/>',
      tension: '<path d="M4 12c5-7 10 7 15 0s10 7 15 0M4 24c5-7 10 7 15 0s10 7 15 0"/>',
      pencil: '<path d="m6 29 3-9L25 4l7 7-16 16Z"/><path d="m9 20 7 7M23 6l7 7M5 33c7-2 14-2 21 0"/>',
      chat: '<path d="M5 7h26v18H16l-8 6 2-6H5Z"/><path d="M11 13h14M11 18h10"/>',
      home: '<path d="M4 16 18 5l14 11v16H22V22h-8v10H4Z"/>',
      sprout: '<path d="M18 32V17M18 20C9 18 8 10 9 5c8 1 12 7 9 15Zm0-4c8-2 11-8 10-13-8 1-13 7-10 13Z"/>',
      user: '<circle cx="18" cy="10" r="6"/><path d="M6 33c1-10 5-15 12-15s11 5 12 15"/>',
      note: '<path d="M8 4h21l5 5v25H8Z"/><path d="M29 4v6h6M13 16h16M13 22h16M13 28h10"/>',
      card: '<rect x="4" y="8" width="32" height="23" rx="4"/><path d="M4 15h32M9 25h8"/>',
      voice: '<rect x="13" y="4" width="12" height="21" rx="6"/><path d="M8 18c0 7 5 11 11 11s11-4 11-11M19 29v6M13 35h12"/>',
      shield: '<path d="M18 3 32 8v10c0 9-6 14-14 17C10 32 4 27 4 18V8Z"/><path d="m11 19 5 5 10-11"/>',
      spark: '<path d="M18 3c1.5 7 4 9.5 11 11-7 1.5-9.5 4-11 11-1.5-7-4-9.5-11-11 7-1.5 9.5-4 11-11Z"/><path d="M29 24c.8 3.6 2.1 4.9 5.7 5.7-3.6.8-4.9 2.1-5.7 5.7-.8-3.6-2.1-4.9-5.7-5.7 3.6-.8 4.9-2.1 5.7-5.7Z"/>',
      flame: '<path d="M20 3c1 7-5 8-3 14 1-3 4-4 5-7 5 4 8 8 8 13 0 7-5 11-12 11S6 30 6 23c0-6 4-10 9-14 0 5 1 7 2 8-1-6 4-8 3-14Z"/>',
      award: '<circle cx="18" cy="14" r="8"/><path d="m13 21-2 12 7-4 7 4-2-12"/><path d="m18 9 1.5 3 3.3.5-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.4-2.3 3.3-.5Z"/>',
      question: '<circle cx="18" cy="18" r="14"/><path d="M13 14c.7-3 3-5 6-5 3.4 0 6 2 6 5 0 4-5 4-5 8"/><path d="M20 28h.01"/>',
      trophy: '<path d="M11 5h14v8c0 6-3 10-7 10s-7-4-7-10Z"/><path d="M11 9H6c0 6 2 9 7 9M25 9h5c0 6-2 9-7 9M18 23v6M12 33h12M14 29h8"/>',
      brain: '<path d="M15 5c-4 0-6 3-5 6-3 1-4 4-2 7-2 3 0 7 3 8 0 4 4 6 7 4V7c0-1-1-2-3-2Zm6 0c4 0 6 3 5 6 3 1 4 4 2 7 2 3 0 7-3 8 0 4-4 6-7 4V7c0-1 1-2 3-2Z"/><path d="M12 14c3 0 4 2 4 4M24 14c-3 0-4 2-4 4M12 24c3 0 4-2 4-4M24 24c-3 0-4-2-4-4"/>',
    };
    return `<svg viewBox="0 0 36 36" aria-hidden="true">${paths[name] || paths.note}</svg>`;
  }


  function emptyState(title, note) {
    return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(note)}</span></div>`;
  }

  let rewardState = null;

  function currentReward() {
    const dashboard = state.dashboard || {};
    const explicit = dashboard.daily_reward || dashboard.personal_reward || dashboard.reward;

    if (explicit?.title && !looksSystemLikeReward(explicit)) {
      return {
        kind: explicit.kind || "insight",
        icon: explicit.icon || "spark",
        type: explicit.type || "Новый инсайт",
        title: conciseRewardTitle(explicit.title),
        text: conciseRewardText(explicit.text || explicit.subtitle || "Ева заметила это в последних шагах"),
        detail: conciseRewardText(explicit.detail || explicit.explanation || explicit.text || explicit.subtitle || ""),
        action: explicit.action || "strength",
        cta: explicit.cta || "Посмотреть",
      };
    }

    const streak = streakState();
    const milestone = milestoneReward(streak);
    if (milestone) return milestone;

    const ritual = ritualState();
    const snapshot = weeklySnapshotReward(ritual);
    if (snapshot) return snapshot;

    const progress = state.progress || {};
    const results = Array.isArray(progress.completed_results) ? progress.completed_results : [];
    const latest = results[0] || null;
    const todayKey = localNowParts().dateKey;
    const latestDate = dateKeyOf(latest?.local_date || latest?.completed_at || latest?.achieved_at || latest?.created_at);

    if (latest && latestDate === todayKey) {
      return {
        kind: "win",
        icon: "trophy",
        type: "Маленькая победа",
        title: personalWinTitle(latest),
        text: "Теперь двигаться дальше проще.",
        detail: latest.goal_title
          ? `Это уже подтверждённый шаг по направлению «${latest.goal_title}».`
          : "Это уже подтверждённый завершённый шаг.",
        action: "progress",
        cta: "Посмотреть",
      };
    }

    if (ritual.period === "evening" && streak.todayDone) {
      return {
        kind: "ritual",
        icon: "note",
        type: "Итог дня",
        title: "Сегодня ты сохранил ритм",
        text: "Можно зафиксировать одну важную мысль.",
        detail: "Короткая вечерняя запись поможет Еве точнее связать действия, состояние и результат.",
        action: "journal",
        cta: "Подвести итог",
      };
    }

    const strength = positiveStrength();
    const seed = rewardSeed(todayKey);
    const variant = seed % 6;

    if (variant === 0) {
      return {
        kind: "question",
        icon: "question",
        type: "Вопрос дня",
        title: "Что сейчас больше всего тормозит запуск?",
        text: "Один честный ответ даст новый фокус.",
        detail: "Ответ можно сохранить в дневник — Ева учтёт его в следующих разговорах.",
        action: "dialog",
        cta: "Ответить",
      };
    }

    if (variant === 1) {
      return {
        kind: "insight",
        icon: "spark",
        type: "Новый инсайт",
        title: "Ты быстрее находишь рабочее решение",
        text: "Ева заметила это в последних шагах.",
        detail: strength.evidence || "Вывод основан на последних подтверждённых действиях.",
        action: "strength",
        cta: "Открыть",
      };
    }

    if (variant === 2) {
      return {
        kind: "noticed",
        icon: "wave",
        type: "Ева заметила",
        title: "Ты стал спокойнее относиться к запуску",
        text: "Это снижает внутреннее сопротивление.",
        detail: "Такой сдвиг стоит сохранить как ориентир для следующих сложных решений.",
        action: "strength",
        cta: "Посмотреть",
      };
    }

    if (variant === 3) {
      return {
        kind: "strength",
        icon: "award",
        type: "Сильная сторона",
        title: rewardStrengthTitle(strength.text),
        text: "Это помогает быстрее переходить к действию.",
        detail: strength.evidence || "Ева будет уточнять этот вывод по мере накопления контекста.",
        action: "strength",
        cta: "Посмотреть",
      };
    }

    if (variant === 4 && curiosityEvidenceAvailable()) {
      return {
        kind: "curiosity",
        icon: "brain",
        type: "Есть один паттерн",
        title: "Ева заметила повторяющуюся закономерность",
        text: "Она проявилась в нескольких последних шагах.",
        detail: curiosityDetail(),
        action: "strength",
        cta: "Раскрыть",
      };
    }

    return {
      kind: "reflection",
      icon: "spark",
      type: "Новый сдвиг",
      title: "Ты быстрее отделяешь главное от лишнего",
      text: "Из-за этого решения становятся проще.",
      detail: strength.evidence || "Ева сравнила несколько последних шагов и увидела повторяющийся способ действия.",
      action: "strength",
      cta: "Посмотреть",
    };
  }

  function rewardSeed(dateKey) {
    const user = state.profile?.user || state.session?.user || {};
    const identity = user.id || user.chat_id || user.username || user.preferred_name || user.first_name || "";
    return [...`${dateKey}:${identity}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  }

  function curiosityEvidenceAvailable() {
    const insight = state.dashboard?.positive_insight || state.dashboard?.insight || {};
    const observations = Number(insight.observations || insight.count || 0);
    const results = Array.isArray(state.progress?.completed_results) ? state.progress.completed_results.length : 0;
    const blocks = Array.isArray(state.progress?.work_blocks) ? state.progress.work_blocks.length : 0;
    return observations >= 2 || results >= 2 || blocks >= 3;
  }

  function curiosityDetail() {
    const direct = state.dashboard?.pattern_hint?.text
      || state.dashboard?.insight?.text
      || state.dashboard?.positive_insight?.text;
    if (direct) return String(direct);
    const strength = positiveStrength();
    return `${strength.text}. ${strength.evidence || ""}`.trim();
  }

  function weeklySnapshotReward(ritual) {
    const explicit = state.dashboard?.weekly_snapshot;
    if (explicit?.title) {
      return {
        kind: "snapshot",
        icon: "card",
        type: "Снимок недели",
        title: conciseRewardTitle(explicit.title),
        text: conciseRewardText(explicit.subtitle || explicit.text || "Короткий итог последних семи дней."),
        detail: conciseRewardText(explicit.detail || explicit.summary || explicit.text || ""),
        action: "progress",
        cta: "Открыть",
      };
    }

    if (!ritual.weeklySnapshotReady) return null;

    const week = weeklyProgress();
    const strength = positiveStrength();
    return {
      kind: "snapshot",
      icon: "card",
      type: "Снимок недели",
      title: `На этой неделе ты сделал ${week.done} из ${week.target} шагов`,
      text: "Ева собрала короткий итог без оценок и давления.",
      detail: `${strength.text}. ${strength.evidence || ""}`.trim(),
      action: "progress",
      cta: "Открыть",
    };
  }

  function milestoneReward(streak) {
    if (!streak.milestone) return null;

    const rewards = {
      3: {
        kind: "milestone",
        icon: "spark",
        type: "3 дня в ритме",
        title: "Ты вошёл в ритм",
        text: "Ева собрала новый короткий инсайт.",
        detail: "Три дня подряд — уже достаточно, чтобы увидеть первый устойчивый рисунок действий.",
        action: "strength",
        cta: "Открыть",
      },
      7: {
        kind: "milestone",
        icon: "award",
        type: "7 дней в ритме",
        title: "Ты удержал ритм целую неделю",
        text: "Ева подготовила особую карточку.",
        detail: streak.perfectWeek
          ? "Это идеальная неделя: семь дней без пропуска и без восстановления серии."
          : "Неделя ритма уже даёт достаточно контекста для более точных наблюдений.",
        action: "strength",
        cta: "Посмотреть",
      },
      14: {
        kind: "milestone",
        icon: "card",
        type: "14 дней в ритме",
        title: "Готов расширенный снимок прогресса",
        text: "Две недели уже показывают заметные изменения.",
        detail: "Ева может сопоставить цели, завершённые шаги и повторяющиеся паттерны за две недели.",
        action: "progress",
        cta: "Открыть",
      },
      30: {
        kind: "milestone",
        icon: "trophy",
        type: "30 дней в ритме",
        title: "Месяц личного прогресса собран",
        text: "Это редкая отметка — посмотри, что изменилось.",
        detail: "Снимок месяца собирает реальные завершённые шаги, ритм и накопленный профиль.",
        action: "progress",
        cta: "Посмотреть",
      },
    };

    return rewards[streak.milestone] || null;
  }

  function looksSystemLikeReward(reward) {
    const text = `${reward?.title || ""} ${reward?.text || reward?.subtitle || ""}`;
    return /webapp|production|по цели|систем|дашборд|dashboard|сценарий интерфейса/i.test(text);
  }

  function personalWinTitle(latest) {
    const raw = String(latest?.title || latest?.actual_result || "").toLowerCase();
    if (/сценар|webapp|интерфейс|экран/.test(raw)) return "Ты собрал ясный сценарий запуска";
    if (/запуск|релиз|production|продакш/.test(raw)) return "Ты сделал запуск заметно ближе";
    if (/решен|готов|заверш|собран|сделан/.test(raw)) return "Ты довёл ещё один важный шаг до результата";
    return "Ты продвинулся дальше, чем кажется";
  }

  function rewardStrengthTitle(value) {
    const text = String(value || "");
    if (/быстро|решен|действ|конкрет/i.test(text)) return "Ты умеешь быстро убирать лишнее";
    return "Ты умеешь быстро убирать лишнее";
  }

  function conciseRewardTitle(value) {
    const text = String(value || "").trim();
    return text.length > 82 ? `${text.slice(0, 79).trim()}…` : text;
  }

  function conciseRewardText(value) {
    const text = String(value || "").trim();
    return text.length > 74 ? `${text.slice(0, 71).trim()}…` : text;
  }

  function positiveStrength() {
    const direct = state.dashboard?.positive_insight?.text || state.dashboard?.strength?.text || state.profile?.positive_insight?.text || state.profile?.strength?.text;
    if (direct) return { text: String(direct), evidence: "Основано на подтверждённых наблюдениях" };

    const progress = state.progress || {};
    const results = Array.isArray(progress.completed_results) ? progress.completed_results : [];
    const blocks = Array.isArray(progress.work_blocks) ? progress.work_blocks : [];
    const goals = (state.goals || []).filter((goal) => goal.status === "active");

    if (results.length >= 2) return { text: "Ты умеешь доводить важное до результата", evidence: `Уже ${results.length} подтверждённых результатов` };
    if (results.length === 1) return { text: "Ты умеешь превращать намерение в конкретный результат", evidence: "Это уже подтверждено одним завершённым результатом" };
    if (blocks.length >= 2) return { text: "Ты умеешь возвращаться к важному и удерживать фокус", evidence: `${blocks.length} фокус-сессии уже зафиксированы` };
    if (goals.length) return { text: "Ты умеешь превращать намерение в конкретную цель", evidence: "Есть активная сформулированная цель" };
    return { text: "Ты готов разбираться в себе и переводить выводы в действия", evidence: "Этот вывод будет уточняться по мере работы" };
  }

  function renderReward(reward) {
    rewardState = reward;
    trackRewardImpression(reward);
    document.getElementById("reward-icon").innerHTML = icon(reward.icon);
    document.getElementById("reward-type").textContent = reward.type;
    document.getElementById("reward-title").textContent = reward.title;
    document.getElementById("reward-text").textContent = reward.text;
    document.getElementById("reward-action").textContent = reward.cta || "Посмотреть";
    document.getElementById("reward-card").dataset.rewardKind = reward.kind || "insight";
  }

  function trackRewardImpression(reward) {
    const key = `eva:reward-impression:${localNowParts().dateKey}:${reward?.kind || "unknown"}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {}
    trackRetention("reward_impression", {
      reward_kind: reward?.kind || "unknown",
      reward_type: reward?.type || "",
    });
  }

  function openCurrentReward() {
    const reward = rewardState || currentReward();
    markRewardViewed(reward);
    const primaryLabel = reward.action === "dialog"
      ? "Ответить Еве"
      : reward.action === "progress"
        ? "Открыть прогресс"
        : reward.action === "journal"
          ? "Добавить итог"
          : reward.kind === "curiosity"
            ? "Раскрыть паттерн"
            : "Обсудить с Евой";

    const shareAction = ["milestone", "snapshot"].includes(reward.kind)
      ? `<button class="secondary-action" id="reward-share" type="button">Поделиться отметкой</button>`
      : "";

    openSheet({
      title: reward.type,
      subtitle: reward.kind === "curiosity"
        ? "Ева раскрывает вывод только после твоего действия."
        : "Короткий личный вывод без лишней аналитики.",
      html: `<article class="section-card reward-detail">
          <h3>${escapeHtml(reward.title)}</h3>
          <p>${escapeHtml(reward.text)}</p>
          ${reward.detail ? `<p class="reward-detail-more">${escapeHtml(reward.detail)}</p>` : ""}
        </article>
        <div class="investment-actions">
          <button class="primary-action" id="reward-primary" type="button">${escapeHtml(primaryLabel)}</button>
          <div class="micro-investment-grid">
            <button class="secondary-action" id="reward-save" type="button">Сохранить инсайт</button>
            <button class="secondary-action" id="reward-mood" type="button">Отметить эмоцию</button>
            <button class="secondary-action" id="reward-thought" type="button">Добавить мысль</button>
            <button class="secondary-action" id="reward-profile" type="button">Продолжить профиль</button>
          </div>
          ${shareAction}
        </div>`,
      onMount(host) {
        host.querySelector("#reward-primary").addEventListener("click", () => {
          if (reward.action === "progress") {
            closeSheet();
            state.developmentTab = "progress";
            syncDevelopmentTabs();
            return openScreen("development");
          }

          if (reward.action === "journal") {
            closeSheet();
            return window.EvaJournal?.openNew?.({
              title: "Итог дня",
              content: "Что сегодня было самым важным?\n\n",
            });
          }

          openEvaHandoff(
            reward.action === "dialog"
              ? `Ответим на вопрос: ${reward.title}`
              : reward.kind === "curiosity"
                ? `Ева заметила паттерн: ${reward.detail || reward.title}. Помоги понять, как он проявляется и что с ним делать.`
                : `Ева заметила про меня: ${reward.title}. Помоги понять, как использовать это дальше.`,
          );
        });

        host.querySelector("#reward-save").addEventListener("click", () => {
          closeSheet();
          window.EvaJournal?.openNew?.({
            title: reward.type,
            content: `${reward.title}\n${reward.detail || reward.text}`,
          });
        });

        host.querySelector("#reward-mood").addEventListener("click", () => {
          openMoodInvestment(reward);
        });

        host.querySelector("#reward-thought").addEventListener("click", () => {
          closeSheet();
          window.EvaJournal?.openNew?.({
            title: "Мысль после инсайта",
            content: `${reward.title}\n\nМоя мысль: `,
          });
        });

        host.querySelector("#reward-profile").addEventListener("click", () => {
          closeSheet();
          state.developmentTab = "tests";
          syncDevelopmentTabs();
          openScreen("development");
        });

        host.querySelector("#reward-share")?.addEventListener("click", () => {
          shareMilestone(reward);
        });
      },
    });
  }

  function openMoodInvestment(reward) {
    openSheet({
      title: "Что ты чувствуешь сейчас?",
      subtitle: "Одна отметка поможет Еве точнее видеть изменения со временем.",
      html: `<div class="mood-investment-grid">
        ${[
          ["calm", "Спокойно"],
          ["good", "Хорошо"],
          ["neutral", "Нейтрально"],
          ["tense", "Напряжённо"],
          ["hard", "Тяжело"],
        ].map(([value, label]) => `<button class="choice-button" data-reward-mood="${value}" type="button">${label}</button>`).join("")}
      </div>`,
      onMount(host) {
        host.querySelectorAll("[data-reward-mood]").forEach((button) => {
          button.addEventListener("click", async () => {
            try {
              await api("/public/v2/checkins", {
                method: "POST",
                body: JSON.stringify({
                  mood: button.dataset.rewardMood,
                  source: "reward",
                  note: reward?.title || null,
                }),
              });
              markInvestmentCompleted("emotion", { mood: button.dataset.rewardMood });
              closeSheet();
              toast("Эмоция отмечена — Ева учтёт её дальше");
              haptic("success");
            } catch (error) {
              toast(friendlyError(error), true);
            }
          });
        });
      },
    });
  }

  async function shareMilestone(reward) {
    const text = `${reward.type}\n${reward.title}\n${reward.text}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Ева — личный прогресс", text });
        return;
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
    }

    await copyText(text);
    toast("Карточка прогресса скопирована");
  }

  function profileInvestmentState() {
    const explicit = state.profile?.completion || state.profile?.self_understanding || {};
    const explicitOverall = numberPercent(explicit.overall ?? explicit.percent ?? state.profile?.completion_percent);
    const explicitEmotions = numberPercent(explicit.emotions);
    const explicitRelationships = numberPercent(explicit.relationships);
    const explicitGoals = numberPercent(explicit.goals);

    const user = state.profile?.user || state.session?.user || {};
    const knownBase = [user.preferred_name || user.first_name, user.city, user.timezone, user.communication_style, user.response_mode].filter(Boolean).length;
    const confirmed = Array.isArray(state.profile?.confirmed) ? state.profile.confirmed.length : 0;
    const journalEntries = window.EvaJournal?.state?.entries?.length || 0;
    const activeGoals = (state.goals || []).filter((goal) => goal.status === "active").length;

    const emotions = explicitEmotions ?? clampPercent(15 + Math.min(60, journalEntries * 8) + (confirmed ? 10 : 0));
    const relationships = explicitRelationships ?? clampPercent(10 + Math.min(55, confirmed * 7));
    const goals = explicitGoals ?? clampPercent(activeGoals ? 55 + Math.min(35, activeGoals * 10) : 15);
    const derivedOverall = clampPercent(Math.round((knownBase / 5) * 25 + emotions * .25 + relationships * .20 + goals * .30));

    const dimensions = [
      { key: "emotions", label: "эмоции", value: emotions },
      { key: "relationships", label: "отношения", value: relationships },
      { key: "goals", label: "цели", value: goals },
    ].filter((item) => item.value < 100);
    const next = dimensions.sort((a, b) => a.value - b.value)[0] || { label: "новые наблюдения", value: 100 };

    return {
      overall: explicitOverall ?? derivedOverall,
      emotions,
      relationships,
      goals,
      next,
    };
  }

  function renderProfileInvestment() {
    const profile = profileInvestmentState();
    document.getElementById("profile-progress-label").textContent = `${profile.overall}%`;
    document.getElementById("profile-progress-bar").style.width = `${profile.overall}%`;
    document.getElementById("profile-emotions").textContent = `${profile.emotions}%`;
    document.getElementById("profile-relationships").textContent = `${profile.relationships}%`;
    document.getElementById("profile-goals").textContent = `${profile.goals}%`;
    document.getElementById("profile-next").textContent = `Дальше: ${profile.next.label}`;

    const note = document.getElementById("profile-value-note");
    note.textContent = profile.overall >= 80
      ? "Ева уже видит устойчивый контекст"
      : profile.overall >= 50
        ? "Чем полнее профиль, тем точнее выводы"
        : "Больше контекста — точнее инсайты";
  }

  function numberPercent(value) {
    if (value === undefined || value === null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? clampPercent(number) : null;
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  }

  function weeklyProgress() {
    const explicitDone = Number(state.dashboard?.weekly_progress?.done ?? state.progress?.weekly_steps_completed);
    const explicitTarget = Number(state.dashboard?.weekly_progress?.target ?? state.progress?.weekly_steps_target ?? 5);
    if (Number.isFinite(explicitDone) && explicitDone >= 0) {
      const target = Number.isFinite(explicitTarget) && explicitTarget > 0 ? explicitTarget : 5;
      return { done: Math.min(explicitDone, target), target, percent: Math.min(100, Math.round(explicitDone / target * 100)) };
    }

    const dates = activityDates().filter((date) => inCurrentWeek(date));
    const done = new Set(dates.map((date) => dateKeyOf(date))).size;
    const target = 5;
    return { done: Math.min(done, target), target, percent: Math.min(100, Math.round(done / target * 100)) };
  }

  function streakState() {
    const explicit = Number(state.dashboard?.streak_days ?? state.progress?.streak_days);
    const dates = activityDates();
    const days = Number.isFinite(explicit) && explicit >= 0
      ? Math.round(explicit)
      : calculateStreak(dates);

    const milestones = [3, 7, 14, 30];
    const milestone = milestones.includes(days) ? days : null;
    const nextMilestone = milestones.find((value) => value > days) || Math.ceil((days + 1) / 30) * 30;
    const daysToMilestone = Math.max(0, nextMilestone - days);

    if (days >= 7) ensureStreakShield();

    const keys = new Set(dates.map((date) => dateKeyOf(date)).filter(Boolean));
    const todayKey = localNowParts().dateKey;
    const yesterdayKey = addDaysKey(todayKey, -1);
    const todayDone = keys.has(todayKey);
    const yesterdayDone = keys.has(yesterdayKey);

    const backendProtection = state.dashboard?.streak_protection_available
      ?? state.progress?.streak_protection_available
      ?? null;
    const backendShields = Number(state.dashboard?.streak_shields ?? state.progress?.streak_shields ?? 0);
    const localShield = streakShieldState();
    const shieldAvailable = backendShields > 0 || Boolean(localShield.available && !localShield.used_at);

    const graceEligible = !todayDone && days > 0 && yesterdayDone;
    const last = lastMeaningfulActionAt();
    const hoursSinceLast = last ? Math.max(0, (Date.now() - last.getTime()) / 3_600_000) : Infinity;
    const shieldRecoveryEligible = !todayDone && days > 0 && shieldAvailable && hoursSinceLast <= 48;
    const protectionAvailable = backendProtection == null
      ? graceEligible || shieldRecoveryEligible
      : Boolean(backendProtection);

    const currentWeekKeys = [...keys].filter((key) => inCurrentWeek(new Date(`${key}T12:00:00Z`)));
    const perfectWeek = new Set(currentWeekKeys).size >= 7
      && !Boolean(state.dashboard?.streak_protection_used_this_week ?? state.progress?.streak_protection_used_this_week);

    const ringBase = nextMilestone > 0 ? Math.min(1, days / nextMilestone) : 0;
    const ring = days ? Math.max(12, Math.min(100, ringBase * 100)) : 8;

    return {
      days,
      ring,
      milestone,
      nextMilestone,
      daysToMilestone,
      todayDone,
      graceEligible,
      protectionAvailable,
      shieldAvailable,
      shieldRecoveryEligible,
      perfectWeek,
    };
  }

  function streakShieldState() {
    try {
      const stored = JSON.parse(localStorage.getItem(SHIELD_KEY) || "{}");
      return { ...shieldMemory, ...(stored || {}) };
    } catch {
      return { ...shieldMemory };
    }
  }

  function ensureStreakShield() {
    const current = streakShieldState();
    if (current.earned_at) return current;

    const next = {
      available: true,
      earned_at: new Date().toISOString(),
      used_at: null,
    };
    shieldMemory = next;
    try {
      localStorage.setItem(SHIELD_KEY, JSON.stringify(next));
    } catch {}
    trackRetention("streak_shield_earned", { milestone_days: 7 });
    return next;
  }

  function reserveShieldRecovery() {
    const current = streakShieldState();
    if (!current.available || current.used_at) return false;
    const next = {
      ...current,
      pending_recovery_at: new Date().toISOString(),
    };
    shieldMemory = next;
    try {
      localStorage.setItem(SHIELD_KEY, JSON.stringify(next));
    } catch {}
    trackRetention("streak_shield_recovery_started");
    return true;
  }

  function completeShieldRecoveryIfPending() {
    const current = streakShieldState();
    if (!current.pending_recovery_at || current.used_at) return;
    const next = {
      ...current,
      available: false,
      used_at: new Date().toISOString(),
      pending_recovery_at: null,
    };
    shieldMemory = next;
    try {
      localStorage.setItem(SHIELD_KEY, JSON.stringify(next));
    } catch {}
    trackRetention("streak_shield_used");
  }

  function activityDates() {
    const progress = state.progress || {};
    const results = Array.isArray(progress.completed_results) ? progress.completed_results : [];
    const blocks = Array.isArray(progress.work_blocks) ? progress.work_blocks : [];
    const backendMeaningful = Array.isArray(progress.meaningful_actions) ? progress.meaningful_actions : [];
    const journalEntries = Array.isArray(window.EvaJournal?.state?.entries) ? window.EvaJournal.state.entries : [];
    const localMeaningful = meaningfulActions();

    return [
      ...results,
      ...blocks,
      ...backendMeaningful,
      ...journalEntries,
      ...localMeaningful,
    ]
      .map((item) =>
        item.local_date
        || item.date_key
        || item.completed_at
        || item.achieved_at
        || item.started_at
        || item.created_at
        || item.ts
        || item.date
      )
      .filter(Boolean)
      .map((value) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00` : value))
      .filter((date) => !Number.isNaN(date.getTime()));
  }

  function calculateStreak(dates) {
    if (!dates.length) return 0;
    const keys = new Set(dates.map((date) => dateKeyOf(date)).filter(Boolean));
    let cursor = localNowParts().dateKey;
    if (!keys.has(cursor)) cursor = addDaysKey(cursor, -1);
    let count = 0;
    while (keys.has(cursor)) {
      count += 1;
      cursor = addDaysKey(cursor, -1);
    }
    return count;
  }

  function inCurrentWeek(date) {
    const todayKey = localNowParts().dateKey;
    const today = new Date(`${todayKey}T12:00:00Z`);
    const mondayOffset = (today.getUTCDay() + 6) % 7;
    const startKey = addDaysKey(todayKey, -mondayOffset);
    const endKey = addDaysKey(startKey, 7);
    const key = dateKeyOf(date);
    return key >= startKey && key < endKey;
  }

  function dateKeyOf(value) {
    const date = value instanceof Date ? value : value ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00Z` : value) : null;
    if (!date || Number.isNaN(date.getTime())) return "";
    const timezone = state.profile?.user?.timezone || state.session?.user?.timezone;
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone: timezone || undefined,
      }).formatToParts(date);
      const get = (type) => parts.find((item) => item.type === type)?.value || "";
      return `${get("year")}-${get("month")}-${get("day")}`;
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  function addDaysKey(key, delta) {
    const date = new Date(`${key}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + delta);
    return date.toISOString().slice(0, 10);
  }

  function openStreakSheet() {
    const streak = streakState();
    const milestoneText = streak.milestone
      ? `Отметка ${streak.milestone} дней достигнута`
      : `До отметки ${streak.nextMilestone} дней — ${streak.daysToMilestone}`;

    const dailyState = streak.todayDone
      ? "Дневная цель выполнена: один короткий шаг уже есть."
      : "Дневная цель: один короткий шаг. Этого достаточно, чтобы сохранить ритм.";

    const perfect = streak.perfectWeek
      ? `<article class="section-card perfect-streak-card">
          <span class="eyebrow">ИДЕАЛЬНАЯ НЕДЕЛЯ</span>
          <h3>7 дней без пропуска</h3>
          <p>Чистый ритм без восстановления серии. Это редкая отметка, но не обязательная цель.</p>
        </article>`
      : "";

    const protection = streak.protectionAvailable
      ? `<article class="section-card streak-protection">
          <span class="eyebrow">ЗАЩИТА СЕРИИ</span>
          <h3>Сегодня можно восстановить ритм</h3>
          <p>${streak.shieldRecoveryEligible ? "У тебя есть заработанный щит серии. Он даст до 24 часов на мягкое восстановление." : "Сделай один короткий шаг сегодня — без штрафов и давления."}</p>
          <div class="action-row"><button class="secondary-action" id="streak-restore" type="button">Восстановить сегодня</button></div>
        </article>`
      : "";

    const shieldCard = streak.shieldAvailable && !streak.protectionAvailable
      ? `<article class="section-card">
          <span class="eyebrow">ЩИТ СЕРИИ</span>
          <h3>1 защита доступна</h3>
          <p>Она заработана после 7 дней ритма и поможет мягко пережить один пропуск.</p>
        </article>`
      : "";

    const intention = selfIntention();
    const intentionCard = `<article class="section-card">
      <span class="eyebrow">НАМЕРЕНИЕ</span>
      <h3>${intention ? escapeHtml(intention) : "Один договор с собой"}</h3>
      <p>${intention ? "Это твоё собственное напоминание, без внешнего давления." : "Можно оставить короткое обещание себе на сегодня."}</p>
      <div class="action-row"><button class="secondary-action" id="streak-intention" type="button">${intention ? "Изменить" : "Задать намерение"}</button></div>
    </article>`;

    openSheet({
      title: `${streak.days} ${streak.days === 1 ? "день" : "дней"} в ритме`,
      subtitle: "Серия поддерживает привычку, но не оценивает тебя.",
      html: `<div class="section-stack">
        <article class="section-card">
          <span class="eyebrow">ЕЖЕДНЕВНАЯ ЦЕЛЬ</span>
          <h3>1 короткий шаг</h3>
          <p>${escapeHtml(dailyState)}</p>
        </article>
        <article class="section-card">
          <span class="eyebrow">СЛЕДУЮЩАЯ ОТМЕТКА</span>
          <h3>${escapeHtml(milestoneText)}</h3>
          <p>Отметки: 3 · 7 · 14 · 30 дней. На каждой Ева открывает новый формат награды.</p>
        </article>
        ${perfect}
        ${shieldCard}
        ${protection}
        ${intentionCard}
      </div>`,
      onMount(host) {
        host.querySelector("#streak-restore")?.addEventListener("click", () => {
          if (streak.shieldRecoveryEligible) reserveShieldRecovery();
          trackRetention("streak_recovery_started", {
            shield: Boolean(streak.shieldRecoveryEligible),
            grace: Boolean(streak.graceEligible),
          });
          closeSheet();
          startMainFocus();
        });

        host.querySelector("#streak-intention")?.addEventListener("click", () => {
          openSelfIntentionSheet();
        });
      },
    });
  }

  function selfIntentionKey() {
    return `eva:self-intention:${localNowParts().dateKey}`;
  }

  function selfIntention() {
    try {
      return localStorage.getItem(selfIntentionKey()) || "";
    } catch {
      return "";
    }
  }

  function openSelfIntentionSheet() {
    const current = selfIntention();
    openSheet({
      title: "Намерение на сегодня",
      subtitle: "Короткая фраза для себя — не обязательство перед кем-то.",
      html: `<form class="form-grid" id="self-intention-form">
        <label><span>Что ты обещаешь себе сегодня?</span>
          <input name="intention" maxlength="120" value="${escapeAttr(current)}" placeholder="Например: сделать один короткий шаг">
        </label>
        <button class="primary-action" type="submit">Сохранить</button>
      </form>`,
      onMount(host) {
        host.querySelector("#self-intention-form").addEventListener("submit", (event) => {
          event.preventDefault();
          const value = String(new FormData(event.currentTarget).get("intention") || "").trim();
          try {
            if (value) localStorage.setItem(selfIntentionKey(), value);
            else localStorage.removeItem(selfIntentionKey());
          } catch {}
          closeSheet();
          toast(value ? "Намерение сохранено" : "Намерение очищено");
        });
      },
    });
  }

  function screenContext() {
    if (state.screen === "today") {
      return `Помоги с моим следующим шагом: ${state.dashboard?.main_focus?.title || "пока не выбран"}`;
    }
    if (state.screen === "journal") return "Хочу обсудить мои записи и текущее состояние";
    if (state.screen === "development") return "Хочу обсудить мой рост, цели и реальный прогресс";
    if (state.screen === "profile") return "Помоги уточнить то, что тебе важно знать обо мне для более персональной помощи";
    return "Продолжим";
  }

  function haptic(type) {
    try {
      if (type === "success") tg?.HapticFeedback?.notificationOccurred?.("success");
      else tg?.HapticFeedback?.impactOccurred?.("light");
    } catch {}
  }

  function clock(ms) {
    const seconds = Math.ceil(ms / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`;
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0,10);
    return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(date);
  }

  function formatDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("ru-RU", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    }).format(date);
  }

  async function copyText(value) {
    try { await navigator.clipboard.writeText(value || ""); } catch {}
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    })[char]);
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function legacyDashboard(today, tasks) {
    const main = today?.main_action
      ? {
          title: today.main_action,
          source_label: today.goal_title || "Активная цель",
          expected_result: today.expected_result,
          work_block_id: today.work_block_id,
          work_block_status: today.work_block_status,
        }
      : null;
    return {
      local_time: today?.local_time,
      checkin: null,
      main_focus: main,
      next_reminder: tasks
        .filter((task) => task.remind_at && !["done","completed"].includes(task.status))
        .sort((a,b) => new Date(a.remind_at) - new Date(b.remind_at))[0] || null,
      insight: { text: "Основные цели уже доступны. Для наблюдений о состоянии нужно несколько отметок." },
    };
  }

  function demoApi(path, options) {
    const now = new Date();
    const due = new Date(now.getTime() + 3 * 3600_000).toISOString();
    if (path === "/public/session") return {
      user: { first_name: "Вик", timezone: "Asia/Yekaterinburg" },
      plan: "free", quotas: [], session_token: "demo",
    };
    if (path === "/public/bot") return { username: "eva_demo_bot" };
    if (path === "/public/goals") return {
      goals: [{
        id: "1", title: "Запустить обновлённую Еву", status: "active",
        progress_percent: 42, next_result: "Готовый production WebApp",
      }],
    };
    if (path === "/public/profile") return {
      profile: {
        user: {
          preferred_name: "Вик", city: "Пермь",
          timezone: "Asia/Yekaterinburg", response_mode: "text", communication_style: "Кратко и по делу",
        },
        completion: { overall: 42, emotions: 80, relationships: 20, goals: 55 },
        confirmed: [], candidates: [],
      },
    };
    if (path === "/public/progress") return {
      progress: {
        completed_results: [{ title: "Собран новый главный сценарий WebApp", goal_title: "Запустить обновлённую Еву", local_date: "2026-08-19" }],
        work_blocks: [
          { id: "w1", completed_at: "2026-08-18T10:00:00" },
          { id: "w2", completed_at: "2026-08-17T10:00:00" },
          { id: "w3", completed_at: "2026-08-16T10:00:00" }
        ],
        streak_days: 5, weekly_steps_completed: 4, weekly_steps_target: 5, goals: [],
      },
    };
    if (path.startsWith("/public/v2/dashboard")) return {
      local_time: "14:17",
      checkin: { mood: "good", energy: 7, tension: 4 },
      main_focus: {
        id: "goal:1",
        title: "Продолжить путь к запуску Евы",
        subtitle: "Разобрать один барьер перед запуском",
        planned_minutes: 6,
      },
      main_focus_candidates: [],
      next_reminder: { title: "Проверить главный экран", remind_at: due },
      positive_insight: {
        text: "Ты быстро превращаешь идеи в конкретные действия",
        observations: 8,
      },
      streak_days: 5,
      weekly_progress: { done: 4, target: 5 },
    };
    if (path.startsWith("/public/v2/checkins")) {
      return { checkin: JSON.parse(options.body || "{}") };
    }
    if (path.startsWith("/public/v2/focus-sessions")) return { focus_session: { id: "demo" } };
    if (path.startsWith("/public/v2/journal")) return { entries: [] };
    return {};
  }

  window.EvaRetention = {
    track: trackRetention,
    queue: retentionQueue,
    flush: flushRetentionEvents,
    metrics: retentionMetricsSnapshot,
    activation: activationState,
    markInvestmentCompleted,
    recordMeaningfulAction,
    reactivation: reactivationState,
    notifications: notificationPolicy,
    lifecycle: lifecycleState,
    churnRisk: churnRiskState,
    streak: streakState,
    performance: performanceSnapshot,
  };

  window.EvaApp = {
    state,
    api,
    safeApi,
    friendlyError,
    openSheet,
    closeSheet,
    openEvaHandoff,
    confirmDanger,
    toast,
    emptyState,
    escapeHtml,
    escapeAttr,
    formatDate,
  };
})();
