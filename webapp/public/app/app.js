(() => {
  "use strict";

  const tg = window.Telegram?.WebApp;
  const DEMO = new URLSearchParams(location.search).get("demo") === "1";
  const API = "/api";
  const BUILD = "20260730-v3";

  const state = {
    screen: "today",
    previousScreen: "today",
    session: null,
    bot: null,
    dashboard: null,
    goals: [],
    tasks: [],
    notes: [],
    budgets: [],
    decisions: [],
    progress: null,
    profile: null,
    organizerTab: "tasks",
    taskFilter: "open",
    developmentTab: "overview",
    module: null,
    astroTab: "horoscope",
    busy: new Set(),
  };

  const moodLabels = {
    very_low: "Тяжёлое",
    low: "Сниженное",
    neutral: "Спокойное",
    good: "Хорошее",
    great: "Отличное",
  };

  const hubModules = [
    { code: "tests", title: "Тесты", note: "Профиль личности и самопознание", icon: "clipboard", badge: "Скоро" },
    { code: "compatibility", title: "Совместимость", note: "Люди, приглашения и отчёты", icon: "hearts", badge: "Скоро" },
    { code: "budget", title: "Бюджет", note: "Доходы, расходы и остаток", icon: "wallet", badge: "Работает" },
    { code: "practices", title: "Практики", note: "Каталог коротких перезагрузок", icon: "lotus", badge: "Работает" },
    { code: "reports", title: "Отчёты", note: "Результаты и динамика", icon: "chart", badge: "Работает" },
    { code: "astro", title: "Астрорефлексия", note: "Гороскоп, Таро и нумерология", icon: "planet", badge: "Символически" },
  ];

  if (tg) {
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.("#fbfaf6");
    tg.setBackgroundColor?.("#fbfaf6");
    tg.setBottomBarColor?.("#fffefa");
  }

  injectIcons(document);
  renderBalloon();
  renderEvaMini();
  bindStaticEvents();
  setLoadingState();
  void bootstrap();

  async function bootstrap() {
    try {
      state.session = await api("/public/session", { method: "POST" });
      updateGreeting();
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
        state.tasks = tasks?.tasks || [];
        state.dashboard = legacyDashboard(today?.today || {}, state.tasks);
      } else {
        state.tasks = state.dashboard.tasks || [];
      }
      state.notes = state.dashboard?.notes || [];
      state.budgets = state.dashboard?.budget?.recent || [];
      renderAll();
    } catch (error) {
      renderAll();
      showFriendlyFailure(error);
    }
  }

  function setLoadingState() {
    document.getElementById("checkin-metrics").innerHTML = '<div class="loading-skeleton"></div><div class="loading-skeleton"></div><div class="loading-skeleton"></div>';
    document.getElementById("main-focus-title").textContent = "Собираю актуальный контекст…";
    renderHub();
    renderDevelopment();
    renderOrganizer();
    renderProfile();
  }

  function renderAll() {
    renderToday();
    renderHub();
    renderDevelopment();
    renderOrganizer();
    renderProfile();
    updateNotificationDot();
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  async function api(path, options = {}, requireTelegram = true) {
    if (DEMO) return demoApi(path, options);
    const headers = { ...(options.headers || {}) };
    if (requireTelegram) {
      const initData = tg?.initData;
      if (!initData) throw new Error("Откройте приложение из Telegram");
      headers["X-Telegram-Init-Data"] = initData;
    }
    if (options.body != null && !(options.body instanceof FormData)) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
    }
    const response = await fetch(`${API}${path}`, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => "");
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
    try { return await api(path, options, requireTelegram); }
    catch (error) {
      console.warn(`[Eva WebApp] ${path}`, error);
      return fallback;
    }
  }

  function friendlyError(error) {
    if (!error) return "Не удалось выполнить действие";
    if (error.status === 401) return "Сессия Telegram устарела. Закройте и снова откройте приложение.";
    if (error.status === 404) return "Эта функция ещё не подключена на сервере.";
    if (error.status >= 500) return "Сервис временно недоступен. Данные не потеряны.";
    const message = String(error.message || "");
    if (/Body cannot be empty|content-type|application\/json/i.test(message)) return "Сервер использует старую версию API. Обновите Evaself.";
    return message.length < 150 ? message : "Не удалось выполнить действие";
  }

  function showFriendlyFailure(error) {
    toast(friendlyError(error), true);
    document.getElementById("today-caption").textContent = "Часть данных временно недоступна";
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  function bindStaticEvents() {
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.addEventListener("click", () => openScreen(button.dataset.target));
    });
    document.getElementById("module-back").addEventListener("click", () => openScreen(state.previousScreen || "hub"));
    document.getElementById("sheet-close").addEventListener("click", closeSheet);
    document.getElementById("sheet").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeSheet();
    });
    document.getElementById("checkin-edit").addEventListener("click", openCheckinSheet);
    document.getElementById("checkin-card").addEventListener("click", (event) => {
      if (!event.target.closest("button")) openCheckinSheet();
    });
    document.getElementById("main-focus-card").addEventListener("click", (event) => {
      if (!event.target.closest("#main-focus-action")) openMainFocusSheet();
    });
    document.getElementById("main-focus-action").addEventListener("click", (event) => {
      event.stopPropagation();
      startMainFocus();
    });
    document.getElementById("today-tasks-card").addEventListener("click", () => {
      state.organizerTab = "tasks";
      openScreen("organizer");
    });
    document.getElementById("continue-card").addEventListener("click", () => {
      state.developmentTab = "goals";
      openScreen("development");
    });
    document.getElementById("notifications-button").addEventListener("click", openNotificationsSheet);
    document.querySelectorAll("[data-quick]").forEach((button) => button.addEventListener("click", () => handleQuick(button.dataset.quick, button)));
    document.getElementById("development-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-development]");
      if (!button) return;
      state.developmentTab = button.dataset.development;
      selectGroup("[data-development]", button);
      renderDevelopment();
      haptic("light");
    });
    document.getElementById("organizer-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-organizer]");
      if (!button) return;
      state.organizerTab = button.dataset.organizer;
      selectGroup("[data-organizer]", button);
      document.getElementById("task-filters").hidden = state.organizerTab === "notes";
      renderOrganizer();
      haptic("light");
    });
    document.getElementById("task-filters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      state.taskFilter = button.dataset.filter;
      selectGroup("[data-filter]", button);
      renderOrganizer();
    });
    document.getElementById("organizer-add").addEventListener("click", () => {
      if (state.organizerTab === "notes") openNoteSheet();
      else openTaskSheet(null, state.organizerTab === "reminders");
    });
    tg?.BackButton?.onClick(() => {
      if (state.screen === "module") openScreen(state.previousScreen || "hub");
      else openScreen("today");
    });
  }

  function selectGroup(selector, selected) {
    document.querySelectorAll(selector).forEach((button) => {
      const active = button === selected;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
  }

  function openScreen(screen) {
    if (!document.querySelector(`[data-screen="${screen}"]`)) return;
    if (screen !== "module") state.previousScreen = state.screen;
    state.screen = screen;
    document.querySelectorAll(".screen").forEach((node) => {
      const active = node.dataset.screen === screen;
      node.hidden = !active;
      node.classList.toggle("is-active", active);
    });
    document.querySelectorAll(".nav-item").forEach((button) => {
      const active = button.dataset.target === screen || (screen === "module" && button.dataset.target === state.previousScreen);
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    });
    if (screen === "today") tg?.BackButton?.hide?.(); else tg?.BackButton?.show?.();
    document.querySelector(`[data-screen="${screen}"] .scroll-content`)?.scrollTo?.(0, 0);
    if (screen === "organizer") void loadOrganizerData();
    if (screen === "hub") renderHub();
    if (screen === "development") renderDevelopment();
    if (screen === "profile") renderProfile();
    haptic("light");
  }

  // ---------------------------------------------------------------------------
  // Today
  // ---------------------------------------------------------------------------

  function updateGreeting() {
    const timezone = state.session?.user?.timezone;
    const hour = Number(new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", hour12: false, timeZone: timezone || undefined }).format(new Date()));
    const phrase = hour < 5 ? "Доброй ночи" : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
    const firstName = state.profile?.user?.preferred_name || state.session?.user?.first_name || tg?.initDataUnsafe?.user?.first_name || "";
    document.getElementById("greeting").textContent = firstName ? `${phrase}, ${firstName}` : phrase;
  }

  function renderToday() {
    updateGreeting();
    const dashboard = state.dashboard || {};
    renderCheckin(dashboard.checkin || null);
    renderMainFocus(dashboard.main_focus || dashboard.mainFocus || null);
    renderTodayCards(dashboard);
    document.getElementById("insight-text").textContent = dashboard.insight?.text || dashboard.insight || "После нескольких отметок здесь появится полезное наблюдение без лишней психодиагностики.";
    document.getElementById("today-caption").textContent = dashboard.local_time ? `Местное время ${dashboard.local_time}` : "Твой день — твои решения";
  }

  function renderCheckin(checkin) {
    const mood = checkin?.mood ? moodLabels[checkin.mood] || checkin.mood : "Отметить";
    const metrics = [
      { key: "mood", label: "Настроение", value: mood, icon: "smile" },
      { key: "energy", label: "Энергия", value: checkin?.energy ? `${checkin.energy}/10` : "—/10", icon: "bolt" },
      { key: "tension", label: "Напряжение", value: checkin?.tension ? `${checkin.tension}/10` : "—/10", icon: "tension" },
    ];
    const host = document.getElementById("checkin-metrics");
    host.innerHTML = metrics.map((item) => `<button class="metric-button ${checkin ? "is-selected" : ""}" type="button" data-metric="${item.key}">
      <span class="metric-icon">${icon(item.icon)}</span><span class="metric-copy"><small>${escapeHtml(item.label)}</small><strong>${escapeHtml(item.value)}</strong></span>
    </button>`).join("");
    host.querySelectorAll("[data-metric]").forEach((button) => button.addEventListener("click", openCheckinSheet));
    document.getElementById("checkin-edit").textContent = checkin ? "Изменить" : "Отметить";
  }

  function renderMainFocus(main) {
    const title = main?.title || main?.main_action || "Выбрать главное вместе с Евой";
    const source = main?.source_label || main?.goal_title || main?.source || "Ева сопоставит цели и ближайшие действия";
    const expected = main?.expected_result || main?.result || "";
    document.getElementById("main-focus-title").textContent = title;
    document.getElementById("main-focus-source").textContent = source;
    const resultNode = document.getElementById("main-focus-result");
    resultNode.hidden = !expected;
    resultNode.textContent = expected ? `Результат: ${expected}` : "";
    const action = document.getElementById("main-focus-action");
    action.textContent = main?.work_block_status === "active" ? "Продолжить" : main?.id || main?.work_block_id ? "Начать" : "Выбрать";
  }

  function renderTodayCards(dashboard) {
    const counts = dashboard.counts || {};
    const open = Number(counts.open_tasks ?? state.tasks.filter((task) => !isDone(task)).length);
    const today = Number(counts.today_tasks ?? state.tasks.filter((task) => !isDone(task) && isToday(task.due_at)).length);
    const nextReminder = dashboard.next_reminder;
    document.getElementById("today-tasks-title").textContent = today ? `${today} ${plural(today, "задача", "задачи", "задач")} на сегодня` : open ? `${open} текущих задач` : "Нет срочных задач";
    document.getElementById("today-tasks-note").textContent = nextReminder?.title
      ? `${nextReminder.title} · ${formatDateTime(nextReminder.remind_at)}`
      : open ? "Открыть список" : "Можно добавить следующий шаг";

    const activeGoal = dashboard.active_goal || state.goals.find((goal) => goal.status === "active") || state.goals[0];
    document.getElementById("continue-title").textContent = activeGoal?.title || "Выбрать направление";
    document.getElementById("continue-note").textContent = activeGoal?.next_result || activeGoal?.next_step || "Открыть развитие";
  }

  async function openCheckinSheet() {
    const current = state.dashboard?.checkin || {};
    const moods = [
      ["very_low", "Тяжёлое"], ["low", "Сниженное"], ["neutral", "Спокойное"], ["good", "Хорошее"], ["great", "Отличное"],
    ];
    openSheet({
      title: "Состояние сегодня",
      subtitle: "Ева использует отметку, чтобы точнее выбрать нагрузку и практику. Это не медицинская оценка.",
      html: `<form class="form-grid" id="checkin-form">
        <fieldset><legend>Настроение</legend><div class="choice-grid">${moods.map(([value,label]) => `<button class="choice-button ${current.mood === value ? "is-selected" : ""}" type="button" data-mood="${value}">${label}</button>`).join("")}</div></fieldset>
        <label class="range-row"><span>Энергия: <strong id="energy-output">${current.energy || 5}</strong>/10</span><input name="energy" type="range" min="1" max="10" value="${current.energy || 5}"></label>
        <label class="range-row"><span>Напряжение: <strong id="tension-output">${current.tension || 5}</strong>/10</span><input name="tension" type="range" min="1" max="10" value="${current.tension || 5}"></label>
        <label><span>Что повлияло? Необязательно</span><textarea name="note" maxlength="1000" rows="2" placeholder="Сон, работа, разговор, событие…">${escapeHtml(current.note || "")}</textarea></label>
        <input type="hidden" name="mood" value="${escapeAttr(current.mood || "neutral")}">
        <button class="primary-action" type="submit">Сохранить состояние</button>
      </form>`,
      onMount(host) {
        const form = host.querySelector("#checkin-form");
        host.querySelectorAll("[data-mood]").forEach((button) => button.addEventListener("click", () => {
          form.elements.mood.value = button.dataset.mood;
          host.querySelectorAll("[data-mood]").forEach((item) => item.classList.toggle("is-selected", item === button));
          haptic("selection");
        }));
        form.addEventListener("input", () => {
          host.querySelector("#energy-output").textContent = form.elements.energy.value;
          host.querySelector("#tension-output").textContent = form.elements.tension.value;
        });
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const payload = Object.fromEntries(new FormData(form).entries());
          payload.energy = Number(payload.energy);
          payload.tension = Number(payload.tension);
          try {
            const result = await api("/public/v2/checkins", { method: "POST", body: JSON.stringify(payload) });
            state.dashboard = { ...(state.dashboard || {}), checkin: result.checkin };
            closeSheet(); renderToday(); toast("Состояние сохранено"); haptic("success");
          } catch (error) { toast(friendlyError(error), true); }
        });
      },
    });
  }

  function openMainFocusSheet() {
    const main = state.dashboard?.main_focus || {};
    const alternatives = state.dashboard?.main_focus_candidates || [];
    openSheet({
      title: "Главное на сегодня",
      subtitle: "Выбор строится на активном рабочем блоке, цели, ближайшей задаче и точке продолжения.",
      html: `<div class="section-stack">
        <article class="section-card"><span class="eyebrow">ТЕКУЩИЙ ВЫБОР</span><h3>${escapeHtml(main.title || "Пока не выбран")}</h3><p>${escapeHtml(main.reason || main.source_label || "Автоматический выбор по контексту")}</p>${main.expected_result ? `<p><strong>Ожидаемый результат:</strong> ${escapeHtml(main.expected_result)}</p>` : ""}</article>
        ${alternatives.length ? `<div class="sheet-options">${alternatives.map((item) => sheetOption("target", item.title, item.source_label || "Другой вариант", `data-focus-candidate="${escapeAttr(item.id || item.title)}"`)).join("")}</div>` : ""}
        <div class="sheet-options">
          ${sheetOption("refresh", "Вернуть автоматический выбор", "Ева снова будет обновлять главное по контексту", 'data-focus-action="auto"')}
          ${sheetOption("chat", "Обсудить с Евой", "Открыть чат с подготовленной формулировкой", 'data-focus-action="eva"')}
          ${sheetOption("checklist", "Создать задачу", "Добавить конкретное действие в Органайзер", 'data-focus-action="task"')}
        </div>
      </div>`,
      onMount(host) {
        host.querySelectorAll("[data-focus-candidate]").forEach((button) => button.addEventListener("click", async () => {
          const item = alternatives.find((candidate) => String(candidate.id || candidate.title) === button.dataset.focusCandidate);
          if (!item) return;
          try {
            const result = await api("/public/v2/main-result", { method: "PUT", body: JSON.stringify(item) });
            state.dashboard.main_focus = result.main_focus;
            closeSheet(); renderToday(); toast("Главное обновлено");
          } catch (error) { toast(friendlyError(error), true); }
        }));
        host.querySelectorAll("[data-focus-action]").forEach((button) => button.addEventListener("click", async () => {
          const action = button.dataset.focusAction;
          if (action === "auto") {
            try {
              await api("/public/v2/main-result", { method: "DELETE" });
              await refreshDashboard(); closeSheet(); toast("Автоматический выбор включён");
            } catch (error) { toast(friendlyError(error), true); }
          } else if (action === "eva") openEvaHandoff(`Помоги уточнить главное на сегодня: ${main.title || "пока не выбрано"}`);
          else openTaskSheet(null, false, main.title || "");
        }));
      },
    });
  }

  function startMainFocus() {
    const main = state.dashboard?.main_focus || {};
    if (!main.title) return openMainFocusSheet();
    openFocusSheet(main);
  }

  function openFocusSheet(main) {
    openSheet({
      title: "Фокус на результате",
      subtitle: "Таймер помогает начать, но главное — что появится к концу сессии.",
      html: `<form class="form-grid" id="focus-form">
        <label><span>Ожидаемый результат</span><input name="title" maxlength="500" required value="${escapeAttr(main.title || "")}"></label>
        <fieldset><legend>Длительность</legend><div class="choice-grid">${[5,15,25,45].map((minutes) => `<button class="choice-button ${minutes === 15 ? "is-selected" : ""}" type="button" data-minutes="${minutes}">${minutes} минут</button>`).join("")}</div></fieldset>
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
          const payload = { title: raw.title.trim(), planned_minutes: Number(raw.minutes), source_type: main.source_type || null, source_id: main.source_id || null, work_block_id: main.work_block_id || null };
          try {
            const result = await api("/public/v2/focus-sessions", { method: "POST", body: JSON.stringify(payload) });
            closeSheet(); startFocusTimer(result.focus_session, payload); haptic("success");
          } catch (error) { toast(friendlyError(error), true); }
        });
      },
    });
  }

  function startFocusTimer(session, payload) {
    const started = Date.now();
    const ends = started + payload.planned_minutes * 60_000;
    const timer = document.createElement("button");
    timer.type = "button";
    timer.className = "toast";
    timer.hidden = false;
    timer.innerHTML = `<strong id="live-focus-clock"></strong> · ${escapeHtml(payload.title)} · Завершить`;
    document.body.appendChild(timer);
    const tick = () => {
      const remaining = Math.max(0, ends - Date.now());
      timer.querySelector("#live-focus-clock").textContent = clock(remaining);
      if (remaining === 0) finish();
    };
    const interval = setInterval(tick, 1000);
    tick();
    const finish = async () => {
      clearInterval(interval);
      timer.remove();
      const actualMinutes = Math.max(1, Math.round((Date.now() - started) / 60000));
      try {
        await api(`/public/v2/focus-sessions/${encodeURIComponent(session?.id || "0")}/complete`, { method: "POST", body: JSON.stringify({ actual_minutes: actualMinutes, actual_result: payload.title }) });
      } catch (error) { console.warn(error); }
      toast("Фокус-сессия завершена");
    };
    timer.addEventListener("click", finish, { once: true });
  }

  function handleQuick(action, button) {
    button.classList.add("is-selected");
    setTimeout(() => button.classList.remove("is-selected"), 350);
    if (action === "write") openComposeSheet();
    else if (action === "eva") openEvaHandoff(screenContext());
    else if (action === "reset") openPractices();
    else openAddSheet();
    haptic("light");
  }

  function openAddSheet() {
    openSheet({
      title: "Добавить",
      subtitle: "Новая запись сразу попадёт в соответствующий раздел.",
      html: `<div class="sheet-options">
        ${sheetOption("checklist", "Задачу", "Срок, напоминание и приоритет", 'data-add="task"')}
        ${sheetOption("bell", "Напоминание", "Однократное или повторяющееся", 'data-add="reminder"')}
        ${sheetOption("note", "Заметку", "Идею, материал или справочную информацию", 'data-add="note"')}
        ${sheetOption("wallet", "Доход или расход", "Добавить финансовую запись", 'data-add="budget"')}
        ${sheetOption("signpost", "Решение", "Факты, варианты, риски и проверка", 'data-add="decision"')}
      </div>`,
      onMount(host) {
        host.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => {
          const type = button.dataset.add;
          if (type === "task") openTaskSheet();
          else if (type === "reminder") openTaskSheet(null, true);
          else if (type === "note") openNoteSheet();
          else if (type === "budget") openBudgetEntrySheet();
          else openDecisionSheet();
        }));
      },
    });
  }

  function openComposeSheet(prefill = "") {
    openSheet({
      title: "Записать",
      subtitle: "Дневниковая запись сохраняется отдельно от рабочих заметок.",
      html: `<form class="form-grid" id="journal-form">
        <label><span>Что важно сохранить?</span><textarea name="content" maxlength="10000" rows="5" required placeholder="Событие, мысль, наблюдение или вывод…">${escapeHtml(prefill)}</textarea></label>
        <label><span>Заголовок, необязательно</span><input name="title" maxlength="300"></label>
        <button class="primary-action" type="submit">Сохранить в дневник</button>
      </form>
      <div class="sheet-options" style="margin-top:10px">${sheetOption("voice", "Надиктовать в чате", "Открыть Еву и отправить голосовое", 'data-journal-handoff="voice"')}${sheetOption("photo", "Добавить фото", "Отправить изображение Еве", 'data-journal-handoff="photo"')}</div>`,
      onMount(host) {
        host.querySelector("#journal-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const raw = Object.fromEntries(new FormData(event.currentTarget).entries());
          const payload = { title: raw.title.trim() || firstLine(raw.content).slice(0, 100), content: raw.content.trim(), category: "Дневник", entry_type: "journal" };
          try {
            const result = await api("/public/v2/notes", { method: "POST", body: JSON.stringify(payload) });
            state.notes.unshift(result.note); closeSheet(); toast("Запись сохранена"); await refreshDashboard();
          } catch (error) { toast(friendlyError(error), true); }
        });
        host.querySelectorAll("[data-journal-handoff]").forEach((button) => button.addEventListener("click", () => openEvaHandoff(button.dataset.journalHandoff === "voice" ? "Хочу надиктовать запись в дневник" : "Хочу добавить фото в дневник")));
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Organizer
  // ---------------------------------------------------------------------------

  async function loadOrganizerData() {
    const [tasks, notes] = await Promise.all([
      safeApi("/public/v2/tasks?view=all", {}, null),
      safeApi("/public/v2/notes?limit=100", {}, null),
    ]);
    if (tasks) state.tasks = tasks.tasks || [];
    if (notes) state.notes = notes.notes || [];
    renderOrganizer();
  }

  function renderOrganizer() {
    const active = state.tasks.filter((task) => !isDone(task) && task.status !== "canceled");
    const reminders = state.tasks.filter((task) => task.remind_at && task.status !== "canceled");
    document.getElementById("task-count").textContent = active.length;
    document.getElementById("reminder-count").textContent = reminders.filter((task) => !isDone(task)).length;
    document.getElementById("note-count").textContent = organizerNotes().length;
    const filters = document.getElementById("task-filters");
    filters.hidden = state.organizerTab === "notes";
    const host = document.getElementById("organizer-content");
    if (state.organizerTab === "notes") return renderNotes(host);
    let items = state.organizerTab === "reminders" ? reminders : state.tasks.filter((task) => task.status !== "canceled");
    items = items.filter((task) => {
      if (state.taskFilter === "done") return isDone(task);
      if (state.taskFilter === "today") return !isDone(task) && isToday(task.due_at || task.remind_at);
      return !isDone(task);
    });
    items.sort((a, b) => taskSort(a) - taskSort(b));
    if (!items.length) {
      host.innerHTML = emptyState(state.organizerTab === "reminders" ? "Напоминаний пока нет" : state.taskFilter === "done" ? "Выполненных задач пока нет" : "Задач пока нет", "Нажмите «+» или попросите Еву добавить запись.");
      return;
    }
    const groups = groupTasks(items);
    host.innerHTML = Object.entries(groups).map(([title, group]) => `<div class="task-group-title">${escapeHtml(title)}</div>${group.map(renderTaskRow).join("")}`).join("");
    injectIcons(host);
    host.querySelectorAll("[data-task-toggle]").forEach((button) => button.addEventListener("click", () => toggleTask(button.dataset.taskToggle)));
    host.querySelectorAll("[data-task-edit]").forEach((button) => button.addEventListener("click", () => openTaskSheet(state.tasks.find((task) => String(task.id) === button.dataset.taskEdit), state.organizerTab === "reminders")));
  }

  function renderTaskRow(task) {
    const done = isDone(task);
    const dueText = task.due_at ? `Срок ${formatDateTime(task.due_at)}` : "";
    const reminderText = task.remind_at ? `Напомнить ${formatDateTime(task.remind_at)}` : "";
    const overdue = !done && task.due_at && new Date(task.due_at) < new Date();
    return `<article class="task-row ${done ? "is-done" : ""}">
      <button class="task-check" type="button" data-task-toggle="${escapeAttr(task.id)}" aria-label="${done ? "Вернуть задачу" : "Отметить выполненной"}"><span data-icon="check"></span></button>
      <button class="task-copy" type="button" data-task-edit="${escapeAttr(task.id)}"><span class="task-title">${escapeHtml(task.title)}</span><span class="task-meta">${dueText ? `<span class="${overdue ? "overdue" : ""}">${escapeHtml(dueText)}</span>` : ""}${reminderText ? `<span>${escapeHtml(reminderText)}</span>` : ""}${task.repeat_enabled ? "<span>Повторяется</span>" : ""}</span></button>
      <button class="task-edit" type="button" data-task-edit="${escapeAttr(task.id)}" aria-label="Изменить"><span data-icon="edit"></span></button>
    </article>`;
  }

  function renderNotes(host) {
    const notes = organizerNotes();
    if (!notes.length) {
      host.innerHTML = emptyState("Заметок пока нет", "Здесь хранятся идеи, материалы и рабочая информация. Дневник остаётся отдельной лентой.");
      return;
    }
    host.innerHTML = notes.map((note) => `<button class="note-row" type="button" data-note-edit="${escapeAttr(note.id)}"><h3>${escapeHtml(note.title || "Без названия")}</h3><p>${escapeHtml(note.content || "")}</p><footer><span>${escapeHtml(note.category || "Заметка")}</span><span>${formatDate(note.updated_at || note.created_at)}</span></footer></button>`).join("");
    host.querySelectorAll("[data-note-edit]").forEach((button) => button.addEventListener("click", () => openNoteSheet(state.notes.find((note) => String(note.id) === button.dataset.noteEdit))));
  }

  async function toggleTask(id) {
    const task = state.tasks.find((item) => String(item.id) === String(id));
    if (!task) return;
    const previous = task.status;
    task.status = isDone(task) ? "open" : "done";
    renderOrganizer();
    try {
      const result = await api(`/public/v2/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: task.status }) });
      Object.assign(task, result.task || {});
      toast(task.status === "done" ? "Готово" : "Задача возвращена");
      await refreshDashboard(); haptic("success");
    } catch (error) {
      task.status = previous; renderOrganizer(); toast(friendlyError(error), true);
    }
  }

  function openTaskSheet(task = null, reminderMode = false, prefillTitle = "") {
    closeSheet();
    openSheet({
      title: task ? "Изменить задачу" : reminderMode ? "Новое напоминание" : "Новая задача",
      subtitle: "Срок определяет, когда задача должна быть готова. Напоминание — когда Ева должна напомнить.",
      html: `<form class="form-grid" id="task-form">
        <label><span>Название</span><input name="title" maxlength="500" required value="${escapeAttr(task?.title || prefillTitle)}" placeholder="Что нужно сделать?"></label>
        <label><span>Описание</span><textarea name="description" maxlength="5000" rows="2">${escapeHtml(task?.description || "")}</textarea></label>
        <label><span>Срок</span><input name="due_at" type="datetime-local" value="${escapeAttr(toLocalInput(task?.due_at))}"></label>
        <label><span>Напомнить</span><input name="remind_at" type="datetime-local" value="${escapeAttr(toLocalInput(task?.remind_at))}" ${reminderMode && !task ? "required" : ""}></label>
        <label><span>Приоритет</span><select name="priority"><option value="3">Обычный</option><option value="2" ${Number(task?.priority) === 2 ? "selected" : ""}>Высокий</option><option value="1" ${Number(task?.priority) === 1 ? "selected" : ""}>Срочный</option><option value="4" ${Number(task?.priority) === 4 ? "selected" : ""}>Низкий</option></select></label>
        <button class="primary-action" type="submit">${task ? "Сохранить" : "Добавить"}</button>
        ${task ? '<button class="danger-action" id="delete-task" type="button">Удалить задачу</button>' : ""}
      </form>`,
      onMount(host) {
        const form = host.querySelector("#task-form");
        form.addEventListener("submit", (event) => saveTask(event, task));
        host.querySelector("#delete-task")?.addEventListener("click", () => deleteTask(task));
      },
    });
  }

  async function saveTask(event, task) {
    event.preventDefault();
    const form = event.currentTarget;
    const raw = Object.fromEntries(new FormData(form).entries());
    const payload = {
      title: raw.title.trim(),
      description: raw.description.trim() || null,
      due_at: localInputToIso(raw.due_at),
      remind_at: localInputToIso(raw.remind_at),
      priority: Number(raw.priority),
    };
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const result = task
        ? await api(`/public/v2/tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", body: JSON.stringify(payload) })
        : await api("/public/v2/tasks", { method: "POST", body: JSON.stringify(payload) });
      if (task) Object.assign(task, result.task); else state.tasks.unshift(result.task);
      closeSheet(); renderOrganizer(); await refreshDashboard(); toast(task ? "Изменения сохранены" : "Задача добавлена"); haptic("success");
    } catch (error) { toast(friendlyError(error), true); }
    finally { submit.disabled = false; }
  }

  async function deleteTask(task) {
    if (!task || !confirm("Удалить задачу?")) return;
    try {
      await api(`/public/v2/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      state.tasks = state.tasks.filter((item) => item.id !== task.id);
      closeSheet(); renderOrganizer(); await refreshDashboard(); toast("Задача удалена");
    } catch (error) { toast(friendlyError(error), true); }
  }

  function openNoteSheet(note = null) {
    closeSheet();
    openSheet({
      title: note ? "Изменить заметку" : "Новая заметка",
      subtitle: "Заметки — рабочая информация. Личные события и переживания лучше сохранять в дневнике.",
      html: `<form class="form-grid" id="note-form">
        <label><span>Заголовок</span><input name="title" maxlength="300" required value="${escapeAttr(note?.title || "")}"></label>
        <label><span>Содержание</span><textarea name="content" maxlength="100000" rows="6" required>${escapeHtml(note?.content || "")}</textarea></label>
        <label><span>Категория</span><input name="category" maxlength="200" value="${escapeAttr(note?.category || "Рабочее")}"></label>
        <button class="primary-action" type="submit">${note ? "Сохранить" : "Добавить"}</button>
        ${note ? '<button class="danger-action" id="delete-note" type="button">Удалить заметку</button>' : ""}
      </form>`,
      onMount(host) {
        host.querySelector("#note-form").addEventListener("submit", (event) => saveNote(event, note));
        host.querySelector("#delete-note")?.addEventListener("click", () => deleteNote(note));
      },
    });
  }

  async function saveNote(event, note) {
    event.preventDefault();
    const raw = Object.fromEntries(new FormData(event.currentTarget).entries());
    const payload = { title: raw.title.trim(), content: raw.content.trim(), category: raw.category.trim() || null, entry_type: "note" };
    try {
      const result = note
        ? await api(`/public/v2/notes/${encodeURIComponent(note.id)}`, { method: "PATCH", body: JSON.stringify(payload) })
        : await api("/public/v2/notes", { method: "POST", body: JSON.stringify(payload) });
      if (note) Object.assign(note, result.note); else state.notes.unshift(result.note);
      closeSheet(); renderOrganizer(); await refreshDashboard(); toast(note ? "Заметка изменена" : "Заметка добавлена");
    } catch (error) { toast(friendlyError(error), true); }
  }

  async function deleteNote(note) {
    if (!note || !confirm("Удалить заметку?")) return;
    try {
      await api(`/public/v2/notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
      state.notes = state.notes.filter((item) => item.id !== note.id);
      closeSheet(); renderOrganizer(); await refreshDashboard(); toast("Заметка удалена");
    } catch (error) { toast(friendlyError(error), true); }
  }

  // ---------------------------------------------------------------------------
  // Development
  // ---------------------------------------------------------------------------

  function renderDevelopment() {
    const host = document.getElementById("development-content");
    if (!host) return;
    const tab = state.developmentTab;
    if (tab === "goals") return renderGoals(host);
    if (tab === "decisions") return void renderDecisions(host);
    if (tab === "programs") return renderUnavailableDevelopment(host, "Программы", "Персональные маршруты на 7, 14 и 30 дней. Раздел появится после подключения серверного каталога и учёта ежедневных шагов.", "route");
    if (tab === "habits") return renderUnavailableDevelopment(host, "Привычки и ритуалы", "Здесь будут поддерживающие ритуалы с полной и минимальной версией без штрафов за пропуск.", "repeat");
    const activeGoals = state.goals.filter((goal) => goal.status === "active");
    const completed = state.progress?.completed_results?.length || 0;
    const decisionsOpen = state.dashboard?.counts?.open_decisions || state.decisions.filter((item) => item.status !== "completed").length;
    host.innerHTML = `<div class="section-stack">
      <div class="summary-row"><div class="summary-pill"><strong>${activeGoals.length}</strong><span>активные цели</span></div><div class="summary-pill"><strong>${completed}</strong><span>готовые результаты</span></div><div class="summary-pill"><strong>${decisionsOpen}</strong><span>решения в работе</span></div></div>
      <article class="section-card"><span class="eyebrow">ТЕКУЩЕЕ НАПРАВЛЕНИЕ</span><h2>${escapeHtml(activeGoals[0]?.title || "Выбрать одну важную область")}</h2><p>${escapeHtml(activeGoals[0]?.next_result || "Карта жизни помогает выбрать направление, но не требует одинакового баланса во всех сферах.")}</p><div class="action-row"><button class="primary-action" id="overview-goals" type="button">Открыть цели</button><button class="secondary-action" id="life-map" type="button">Карта жизни</button></div></article>
      <article class="section-card"><h3>Логика раздела</h3><p>Цели отвечают за результат. Программы — за последовательность обучения. Привычки — за поддерживающий ритм. Решения — за выбор и последующую проверку фактического результата.</p></article>
    </div>`;
    host.querySelector("#overview-goals").addEventListener("click", () => { state.developmentTab = "goals"; selectDevelopmentTab(); renderDevelopment(); });
    host.querySelector("#life-map").addEventListener("click", () => openLifeMapSheet());
  }

  function selectDevelopmentTab() {
    document.querySelectorAll("[data-development]").forEach((button) => button.classList.toggle("is-active", button.dataset.development === state.developmentTab));
  }

  function renderGoals(host) {
    if (!state.goals.length) {
      host.innerHTML = `${emptyState("Целей пока нет", "Добавьте ориентир, который действительно хочется приблизить.")}<div class="action-row"><button class="primary-action" id="add-goal" type="button">Добавить цель</button></div>`;
      host.querySelector("#add-goal").addEventListener("click", openGoalSheet);
      return;
    }
    host.innerHTML = `<div class="section-stack">${state.goals.map((goal) => {
      const progress = Math.max(0, Math.min(100, Number(goal.progress_percent || 0)));
      return `<article class="section-card"><span class="eyebrow">${escapeHtml(goal.status === "active" ? "АКТИВНАЯ ЦЕЛЬ" : goal.status?.toUpperCase() || "ЦЕЛЬ")}</span><h3>${escapeHtml(goal.title)}</h3><p>${escapeHtml(goal.why_it_matters || "")}</p><div style="height:6px;background:#eeeae3;border-radius:99px;margin-top:10px;overflow:hidden"><span style="display:block;height:100%;width:${progress}%;background:var(--orange);border-radius:99px"></span></div><p>${progress}% · ${escapeHtml(goal.next_result || goal.next_step || "Следующий результат ещё не сформирован")}</p></article>`;
    }).join("")}<button class="primary-action" id="add-goal" type="button">Добавить цель</button></div>`;
    host.querySelector("#add-goal").addEventListener("click", openGoalSheet);
  }

  function openGoalSheet() {
    openSheet({
      title: "Новая цель",
      subtitle: "Цель должна описывать желаемый результат, а не постоянное чувство вины за невыполнение.",
      html: `<form class="form-grid" id="goal-form"><label><span>Что должно измениться?</span><input name="title" maxlength="500" required></label><label><span>Почему это важно?</span><textarea name="why_it_matters" maxlength="5000" rows="3"></textarea></label><label><span>Желаемый срок</span><input name="target_date" type="date"></label><button class="primary-action" type="submit">Сохранить цель</button></form>`,
      onMount(host) {
        host.querySelector("#goal-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
          try {
            const result = await api("/public/goals", { method: "POST", body: JSON.stringify(payload) });
            state.goals.unshift(result.goal); closeSheet(); renderDevelopment(); await refreshDashboard(); toast("Цель добавлена");
          } catch (error) { toast(friendlyError(error), true); }
        });
      },
    });
  }

  async function renderDecisions(host) {
    if (!state.decisions.length) {
      const result = await safeApi("/public/v2/decisions", {}, null);
      if (result) state.decisions = result.decisions || [];
    }
    if (!state.decisions.length) {
      host.innerHTML = `${emptyState("Решений пока нет", "Зафиксируйте вопрос, варианты, факты и дату проверки результата.")}<div class="action-row"><button class="primary-action" id="add-decision" type="button">Разобрать решение</button></div>`;
      host.querySelector("#add-decision").addEventListener("click", () => openDecisionSheet());
      return;
    }
    host.innerHTML = `<div class="section-stack">${state.decisions.map((decision) => `<button class="section-card" type="button" data-decision="${escapeAttr(decision.id)}" style="text-align:left"><span class="eyebrow">${escapeHtml(decision.status === "completed" ? "ЗАВЕРШЕНО" : "РЕШЕНИЕ В РАБОТЕ")}</span><h3>${escapeHtml(decision.question)}</h3><p>${escapeHtml(decision.selected_option || decision.review_at ? `Пересмотреть ${formatDate(decision.review_at)}` : "Вариант ещё не выбран")}</p></button>`).join("")}<button class="primary-action" id="add-decision" type="button">Новое решение</button></div>`;
    host.querySelectorAll("[data-decision]").forEach((button) => button.addEventListener("click", () => openDecisionSheet(state.decisions.find((item) => String(item.id) === button.dataset.decision))));
    host.querySelector("#add-decision").addEventListener("click", () => openDecisionSheet());
  }

  function openDecisionSheet(decision = null) {
    closeSheet();
    openSheet({
      title: decision ? "Изменить решение" : "Разобрать решение",
      subtitle: "Ева может помочь сформулировать варианты, но итоговый выбор остаётся за пользователем.",
      html: `<form class="form-grid" id="decision-form">
        <label><span>Какой вопрос нужно решить?</span><textarea name="question" maxlength="2000" rows="2" required>${escapeHtml(decision?.question || "")}</textarea></label>
        <label><span>Варианты, каждый с новой строки</span><textarea name="options" maxlength="5000" rows="3">${escapeHtml(arrayToLines(decision?.options))}</textarea></label>
        <label><span>Известные факты</span><textarea name="facts" maxlength="5000" rows="3">${escapeHtml(arrayToLines(decision?.facts))}</textarea></label>
        <label><span>Риски и ограничения</span><textarea name="risks" maxlength="5000" rows="2">${escapeHtml(arrayToLines(decision?.risks))}</textarea></label>
        <label><span>Выбранный вариант</span><input name="selected_option" maxlength="1000" value="${escapeAttr(decision?.selected_option || "")}"></label>
        <label><span>Когда пересмотреть?</span><input name="review_at" type="date" value="${escapeAttr(dateInput(decision?.review_at))}"></label>
        <button class="primary-action" type="submit">${decision ? "Сохранить" : "Создать карточку"}</button>
        <button class="secondary-action" id="decision-eva" type="button">Обсудить с Евой</button>
      </form>`,
      onMount(host) {
        host.querySelector("#decision-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const raw = Object.fromEntries(new FormData(event.currentTarget).entries());
          const payload = { question: raw.question.trim(), options: linesToArray(raw.options), facts: linesToArray(raw.facts), risks: linesToArray(raw.risks), selected_option: raw.selected_option.trim() || null, review_at: raw.review_at || null };
          try {
            const result = decision
              ? await api(`/public/v2/decisions/${encodeURIComponent(decision.id)}`, { method: "PATCH", body: JSON.stringify(payload) })
              : await api("/public/v2/decisions", { method: "POST", body: JSON.stringify(payload) });
            if (decision) Object.assign(decision, result.decision); else state.decisions.unshift(result.decision);
            closeSheet(); state.developmentTab = "decisions"; renderDevelopment(); await refreshDashboard(); toast("Карточка решения сохранена");
          } catch (error) { toast(friendlyError(error), true); }
        });
        host.querySelector("#decision-eva").addEventListener("click", () => {
          const question = host.querySelector('[name="question"]').value.trim();
          openEvaHandoff(`Помоги разобрать решение: ${question || "я ещё формулирую вопрос"}. Отделяй факты от предположений, предложи варианты, риски и дешёвый тест.`);
        });
      },
    });
  }

  function renderUnavailableDevelopment(host, title, description, iconName) {
    host.innerHTML = `<div class="section-stack"><article class="section-card"><div style="width:44px;height:44px;color:var(--orange-dark)">${icon(iconName)}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><div class="action-row"><button class="secondary-action" id="development-eva" type="button">Обсудить с Евой</button></div></article><article class="section-card"><span class="eyebrow">ПОЧЕМУ НЕ ЗАГЛУШКА</span><p>Пока серверный учёт не подключён, раздел не имитирует сохранение данных и не дублирует цели или Органайзер.</p></article></div>`;
    host.querySelector("#development-eva").addEventListener("click", () => openEvaHandoff(`Помоги составить ${title.toLowerCase()} без сохранения в WebApp`));
  }

  function openLifeMapSheet() {
    openSheet({
      title: "Карта жизни",
      subtitle: "Низкая оценка не означает проблему, если сфера сейчас не важна.",
      html: `<div class="section-stack"><article class="section-card"><h3>Архитектура подготовлена</h3><p>Для полноценной карты нужны серверные оценки важности, удовлетворённости, желаемого изменения и допустимой цены. Пока данные не сохраняются, чтобы не создавать ложное ощущение работающего модуля.</p></article><button class="secondary-action" id="life-eva" type="button">Обсудить сферы с Евой</button></div>`,
      onMount(host) { host.querySelector("#life-eva").addEventListener("click", () => openEvaHandoff("Помоги оценить важность и удовлетворённость основными сферами жизни без требования идеального баланса")); },
    });
  }

  // ---------------------------------------------------------------------------
  // Hub / modules
  // ---------------------------------------------------------------------------

  function renderHub() {
    const host = document.getElementById("hub-content");
    const summaries = state.dashboard?.hub || {};
    host.innerHTML = hubModules.map((item) => `<button class="hub-card" type="button" data-hub="${item.code}"><div class="hub-card-top"><span class="hub-icon">${icon(item.icon)}</span><span class="hub-badge">${escapeHtml(item.badge)}</span></div><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.note)}</p></div><footer>${escapeHtml(hubSummary(item.code, summaries))}</footer></button>`).join("");
    host.querySelectorAll("[data-hub]").forEach((button) => button.addEventListener("click", () => openHubModule(button.dataset.hub)));
  }

  function hubSummary(code, summaries) {
    if (code === "budget") return summaries.budget || budgetSummaryText();
    if (code === "reports") return summaries.reports || `${state.progress?.completed_results?.length || 0} готовых результатов`;
    if (code === "practices") return "5 коротких способов перезагрузки";
    if (code === "astro") return "Три отдельных символических раздела";
    if (code === "tests") return "Будет включено после подключения тестов";
    return "Будет включено после подключения приглашений";
  }

  function openHubModule(code) {
    if (code === "budget") return openBudgetModule();
    if (code === "practices") return openPractices();
    if (code === "reports") return openReportsModule();
    if (code === "astro") return openAstroModule();
    openModule({
      code,
      title: code === "tests" ? "Тесты" : "Совместимость",
      kicker: "МОДУЛЬ ПОДГОТОВЛЕН",
      html: `<div class="section-stack"><article class="section-card"><h2>${code === "tests" ? "Тесты личности" : "Совместимость людей"}</h2><p>${code === "tests" ? "Frontend не выдаёт вымышленные результаты. Для запуска нужны каталог методик, версии шкал, хранение ответов и серверный расчёт отчёта." : "Frontend не создаёт фиктивные ссылки. Для запуска нужны приглашения, согласие второго участника, результаты тестов и отдельные карточки отчётов."}</p></article><button class="secondary-action" id="module-eva" type="button">Обсудить с Евой</button></div>`,
      onMount(host) { host.querySelector("#module-eva").addEventListener("click", () => openEvaHandoff(code === "tests" ? "Помоги выбрать подходящий тест для самопознания" : "Помоги подготовить разговор о совместимости и общении")); },
    });
  }

  function openModule({ code, title, kicker, html, onMount }) {
    state.module = code;
    state.previousScreen = state.screen === "module" ? state.previousScreen : state.screen;
    document.getElementById("module-title").textContent = title;
    document.getElementById("module-kicker").textContent = kicker;
    const host = document.getElementById("module-content");
    host.innerHTML = html;
    injectIcons(host);
    onMount?.(host);
    openScreen("module");
  }

  async function openBudgetModule() {
    const data = await safeApi("/public/v2/budget?period=month&limit=100", {}, null);
    if (data) {
      state.budgets = data.records || [];
      state.dashboard = { ...(state.dashboard || {}), budget: data.summary || state.dashboard?.budget };
    }
    const summary = state.dashboard?.budget || calculateBudget(state.budgets);
    openModule({
      code: "budget", title: "Бюджет", kicker: "ДОХОДЫ И РАСХОДЫ",
      html: `<div class="module-cards"><div class="budget-total"><div class="money-card positive"><span>Доходы</span><strong>${money(summary.income_minor || 0)}</strong></div><div class="money-card negative"><span>Расходы</span><strong>${money(summary.expense_minor || 0)}</strong></div><div class="money-card"><span>Остаток</span><strong>${money((summary.income_minor || 0) - (summary.expense_minor || 0))}</strong></div></div><div class="action-row"><button class="primary-action" id="add-budget-entry" type="button">Добавить запись</button><button class="secondary-action" id="budget-eva" type="button">Спросить Еву</button></div><div class="section-stack">${state.budgets.length ? state.budgets.map(renderBudgetEntry).join("") : emptyState("Записей пока нет", "Добавьте доход или расход. Чеки будут подключены через media-service отдельным этапом.")}</div></div>`,
      onMount(host) {
        host.querySelector("#add-budget-entry").addEventListener("click", openBudgetEntrySheet);
        host.querySelector("#budget-eva").addEventListener("click", () => openEvaHandoff("Проанализируй мой бюджет за текущий месяц и предложи осторожные рекомендации без финансовых гарантий"));
        host.querySelectorAll("[data-budget-edit]").forEach((button) => button.addEventListener("click", () => openBudgetEntrySheet(state.budgets.find((item) => String(item.id) === button.dataset.budgetEdit))));
      },
    });
  }

  function renderBudgetEntry(entry) {
    const type = entry.entry_type || entry.type;
    const amount = Number(entry.amount_minor || Math.round(Number(entry.amount || 0) * 100));
    return `<button class="entry-row" type="button" data-budget-edit="${escapeAttr(entry.id)}"><span class="entry-icon"><span data-icon="${type === "income" ? "plus" : "minus"}"></span></span><span class="entry-copy"><strong>${escapeHtml(entry.category || entry.store || (type === "income" ? "Доход" : "Расход"))}</strong><small>${formatDate(entry.occurred_on || entry.date)} · ${escapeHtml(entry.description || "")}</small></span><span class="entry-amount ${type}">${type === "income" ? "+" : "−"}${money(amount)}</span></button>`;
  }

  function openBudgetEntrySheet(entry = null) {
    closeSheet();
    openSheet({
      title: entry ? "Изменить запись" : "Доход или расход",
      subtitle: "Сумма хранится в минимальных денежных единицах без округления в отчётах.",
      html: `<form class="form-grid" id="budget-form">
        <label><span>Тип</span><select name="type"><option value="expense" ${entry?.entry_type === "expense" ? "selected" : ""}>Расход</option><option value="income" ${entry?.entry_type === "income" ? "selected" : ""}>Доход</option></select></label>
        <label><span>Сумма, ₽</span><input name="amount" type="number" min="0" step="0.01" required value="${escapeAttr(entry ? Number(entry.amount_minor) / 100 : "")}"></label>
        <label><span>Категория</span><input name="category" maxlength="200" value="${escapeAttr(entry?.category || "")}"></label>
        <label><span>Магазин или источник</span><input name="store" maxlength="300" value="${escapeAttr(entry?.store || "")}"></label>
        <label><span>Описание</span><input name="description" maxlength="2000" value="${escapeAttr(entry?.description || "")}"></label>
        <label><span>Дата</span><input name="date" type="date" value="${escapeAttr(dateInput(entry?.occurred_on) || dateInput(new Date()))}"></label>
        <button class="primary-action" type="submit">Сохранить</button>
        ${entry ? '<button class="danger-action" id="delete-budget" type="button">Удалить запись</button>' : ""}
      </form>`,
      onMount(host) {
        host.querySelector("#budget-form").addEventListener("submit", async (event) => {
          event.preventDefault(); const raw = Object.fromEntries(new FormData(event.currentTarget).entries());
          const payload = { type: raw.type, amount: Number(raw.amount), category: raw.category.trim() || null, store: raw.store.trim() || null, description: raw.description.trim() || null, date: raw.date };
          try {
            const result = entry
              ? await api(`/public/v2/budget/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: JSON.stringify(payload) })
              : await api("/public/v2/budget", { method: "POST", body: JSON.stringify(payload) });
            if (entry) Object.assign(entry, result.record); else state.budgets.unshift(result.record);
            closeSheet(); await refreshDashboard(); toast("Финансовая запись сохранена"); openBudgetModule();
          } catch (error) { toast(friendlyError(error), true); }
        });
        host.querySelector("#delete-budget")?.addEventListener("click", async () => {
          if (!confirm("Удалить финансовую запись?")) return;
          try { await api(`/public/v2/budget/${encodeURIComponent(entry.id)}`, { method: "DELETE" }); state.budgets = state.budgets.filter((item) => item.id !== entry.id); closeSheet(); await refreshDashboard(); openBudgetModule(); }
          catch (error) { toast(friendlyError(error), true); }
        });
      },
    });
  }

  function openPractices() {
    const practices = [
      ["breath", "Ровное дыхание", "Свободный ритм или мягкое удлинение выдоха"],
      ["ground", "Заземление 5–4–3–2–1", "Последовательно вернуть внимание к ощущениям"],
      ["sort", "Разложить мысли", "Сейчас, позже и вне контроля"],
      ["dot", "Фокус на минуту", "Спокойная точка без мигания и счёта"],
      ["dump", "Сброс перегрузки", "Выгрузить мысли и выбрать один следующий шаг"],
    ];
    openModule({
      code: "practices", title: "Практики", kicker: "КОРОТКАЯ ПЕРЕЗАГРУЗКА",
      html: `<div class="module-cards"><article class="section-card"><h3>Выберите то, что подходит сейчас</h3><p>Практики не заменяют помощь специалиста и не оцениваются баллами или сериями.</p></article><div class="practice-grid">${practices.map(([code,title,note]) => `<button class="practice-button" type="button" data-practice="${code}"><span>${icon(practiceIcon(code))}</span><span><strong>${title}</strong><small>${note}</small></span></button>`).join("")}</div></div>`,
      onMount(host) { host.querySelectorAll("[data-practice]").forEach((button) => button.addEventListener("click", () => runPractice(button.dataset.practice))); },
    });
  }

  function runPractice(code) {
    const configs = {
      breath: ["Ровное дыхание", "Дышите в удобном ритме. Не задерживайте дыхание, если это неприятно. Остановитесь при дискомфорте."],
      ground: ["Заземление 5–4–3–2–1", "Назовите 5 предметов, которые видите; 4 ощущения тела; 3 звука; 2 запаха; 1 вкус или спокойный вдох."],
      sort: ["Разложить мысли", "Запишите мысли и распределите их: «сейчас», «позже», «не контролирую». В «сейчас» оставьте не больше трёх."],
      dot: ["Фокус на минуту", "Смотрите на неподвижную точку и мягко возвращайте внимание, когда оно уходит. Здесь нет правильного результата."],
      dump: ["Сброс перегрузки", "Запишите всё, что занимает внимание. Затем отметьте один доступный следующий шаг."],
    };
    const [title, textValue] = configs[code];
    openSheet({ title, subtitle: "Можно остановиться в любой момент", html: `<article class="section-card"><p>${escapeHtml(textValue)}</p></article><div class="action-row"><button class="primary-action" id="practice-start" type="button">Начать</button><button class="secondary-action" id="practice-note" type="button">Записать мысли</button></div>`, onMount(host) { host.querySelector("#practice-start").addEventListener("click", () => { closeSheet(); toast("Практика началась. Действуйте в удобном темпе."); }); host.querySelector("#practice-note").addEventListener("click", () => openComposeSheet(`${title}: `)); } });
  }

  function openReportsModule() {
    const progress = state.progress || {};
    const goals = progress.goals || [];
    const results = progress.completed_results || [];
    const blocks = progress.work_blocks || [];
    openModule({
      code: "reports", title: "Отчёты", kicker: "ИТОГИ И ДИНАМИКА",
      html: `<div class="module-cards"><div class="summary-row"><div class="summary-pill"><strong>${results.length}</strong><span>результатов</span></div><div class="summary-pill"><strong>${blocks.length}</strong><span>фокус-сессий</span></div><div class="summary-pill"><strong>${goals.length}</strong><span>целей</span></div></div><article class="section-card"><h3>Последние результаты</h3>${results.length ? results.slice(0,5).map((item) => `<p><strong>${escapeHtml(item.title)}</strong><br>${escapeHtml(item.goal_title || "")}</p>`).join("") : "<p>Завершённые результаты появятся после работы с целями.</p>"}</article><button class="secondary-action" id="report-eva" type="button">Попросить Еву подвести итог</button></div>`,
      onMount(host) { host.querySelector("#report-eva").addEventListener("click", () => openEvaHandoff("Подведи краткий итог моей недели: результаты, трудности, повторяющиеся темы и один следующий фокус")); },
    });
  }

  function openAstroModule() {
    const html = `<div class="astro-tabs"><button class="is-active" data-astro="horoscope" type="button">Гороскоп</button><button data-astro="tarot" type="button">Таро</button><button data-astro="numerology" type="button">Нумерология</button></div><div id="astro-body"></div>`;
    openModule({
      code: "astro", title: "Астрорефлексия", kicker: "СИМВОЛИЧЕСКИЙ ВЗГЛЯД", html,
      onMount(host) {
        const render = () => renderAstroBody(host.querySelector("#astro-body"));
        host.querySelectorAll("[data-astro]").forEach((button) => button.addEventListener("click", () => {
          state.astroTab = button.dataset.astro;
          host.querySelectorAll("[data-astro]").forEach((item) => item.classList.toggle("is-active", item === button));
          render();
        }));
        render();
      },
    });
  }

  function renderAstroBody(host) {
    if (state.astroTab === "tarot") {
      host.innerHTML = `<article class="section-card"><h3>Карты Таро</h3><p>Карты используются как метафорические вопросы, а не как достоверное предсказание будущего.</p><div class="tarot-row">${[1,2,3].map((n) => `<button class="tarot-card" data-tarot="${n}" type="button"><span>${icon("star")}</span></button>`).join("")}</div><p id="tarot-result">Выберите карту.</p></article>`;
      host.querySelectorAll("[data-tarot]").forEach((button) => button.addEventListener("click", () => {
        const cards = ["Звезда — какой ориентир важно не потерять?", "Отшельник — что стоит осмыслить без спешки?", "Умеренность — где нужна постепенность?", "Сила — где поможет мягкая настойчивость?", "Мир — что пора завершить?"];
        host.querySelector("#tarot-result").textContent = cards[Math.floor(Math.random() * cards.length)];
      }));
      return;
    }
    if (state.astroTab === "numerology") {
      host.innerHTML = `<article class="section-card"><h3>Нумерология</h3><p>Интерпретация используется только как символический повод для размышления.</p><form class="form-grid" id="numerology-form"><label><span>Дата рождения</span><input name="date" type="date" required></label><button class="primary-action" type="submit">Рассчитать тему</button></form><p id="numerology-result"></p></article>`;
      host.querySelector("#numerology-form").addEventListener("submit", (event) => {
        event.preventDefault(); const date = event.currentTarget.elements.date.value; const number = lifePath(date); host.querySelector("#numerology-result").textContent = `Число ${number}. ${numberMeaning(number)}`;
      });
      return;
    }
    host.innerHTML = `<article class="section-card"><h3>Гороскоп как вопрос для рефлексии</h3><p>Раздел не утверждает, что небесные объекты определяют события. Он предлагает символическую тему дня.</p><p><strong>${dailyAstroTheme()}</strong></p><button class="secondary-action" id="astro-journal" type="button">Ответить в дневнике</button></article>`;
    host.querySelector("#astro-journal").addEventListener("click", () => openComposeSheet(`${dailyAstroTheme()}\n`));
  }

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  function renderProfile() {
    const host = document.getElementById("profile-content");
    const user = state.profile?.user || state.session?.user || {};
    const completeness = Number(state.profile?.completeness || 0);
    host.innerHTML = `<div class="profile-stack">
      <article class="section-card profile-summary"><span class="profile-avatar">${evaPortrait()}</span><div><h3>${escapeHtml(user.preferred_name || user.first_name || "Пользователь")}</h3><p>${escapeHtml(user.city || "Город не указан")} · ${escapeHtml(user.timezone || "Часовой пояс не определён")}</p></div></article>
      <article class="section-card"><span class="eyebrow">ПРОФИЛЬ ЗАПОЛНЕН</span><h2>${completeness}%</h2><p>Ева уточняет данные постепенно и не должна задавать больше одного уместного вопроса за сообщение.</p><div class="action-row"><button class="primary-action" id="edit-profile" type="button">Изменить данные</button></div></article>
      <div class="settings-list">
        ${settingsRow("memory", "Память Евы", "Подтверждённые факты и кандидаты", `${state.profile?.confirmed?.length || 0} записей`)}
        ${settingsRow("card", "Подписка и квоты", "Тариф, бесплатные сообщения и гранты", state.session?.plan || "free")}
        ${settingsRow("bell", "Уведомления", "Время, частота и тихие часы", "Настроить")}
        ${settingsRow("voice", "Голос и портрет", "Режим ответа, ASR, TTS и анимация", "Настроить")}
        ${settingsRow("link", "Интеграции", "Todoist, поиск и внешние сервисы", "Проверить")}
        ${settingsRow("shield", "Приватность", "Экспорт, память и удаление данных", "Открыть")}
        ${settingsRow("pulse", "Диагностика", "Версия интерфейса и подключение к API", BUILD)}
      </div>
    </div>`;
    injectIcons(host);
    host.querySelector("#edit-profile").addEventListener("click", openProfileSheet);
    host.querySelectorAll("[data-setting]").forEach((button) => button.addEventListener("click", () => openSetting(button.dataset.setting)));
  }

  function settingsRow(code, title, note, status) {
    const icons = { memory: "brain", card: "card", bell: "bell", voice: "voice", link: "link", shield: "shield", pulse: "pulse" };
    return `<button class="settings-row" type="button" data-setting="${code}"><span data-icon="${icons[code]}"></span><span><strong>${title}</strong><small>${note}</small></span><em>${escapeHtml(status)}</em></button>`;
  }

  function openProfileSheet() {
    const user = state.profile?.user || state.session?.user || {};
    openSheet({
      title: "Личные данные",
      subtitle: "Изменения становятся подтверждёнными данными профиля.",
      html: `<form class="form-grid" id="profile-form"><label><span>Как обращаться</span><input name="preferred_name" maxlength="100" value="${escapeAttr(user.preferred_name || user.first_name || "")}"></label><label><span>Город</span><input name="city" maxlength="200" value="${escapeAttr(user.city || "")}"></label><label><span>Стиль общения</span><textarea name="communication_style" maxlength="2000" rows="3">${escapeHtml(user.communication_style || "")}</textarea></label><button class="primary-action" type="submit">Сохранить</button></form>`,
      onMount(host) {
        host.querySelector("#profile-form").addEventListener("submit", async (event) => {
          event.preventDefault(); const raw = Object.fromEntries(new FormData(event.currentTarget).entries()); const fields = Object.fromEntries(Object.entries(raw).filter(([,value]) => String(value).trim()).map(([key,value]) => [key,String(value).trim()]));
          try {
            const result = await api("/public/profile", { method: "PATCH", body: JSON.stringify({ fields }) });
            state.profile = result.profile; closeSheet(); renderProfile(); updateGreeting(); toast("Профиль обновлён");
          } catch (error) { toast(friendlyError(error), true); }
        });
      },
    });
  }

  function openSetting(code) {
    if (code === "memory") {
      const confirmed = state.profile?.confirmed || [];
      const candidates = state.profile?.candidates || [];
      return openSheet({ title: "Память Евы", subtitle: "Показываются только структурированные поля профиля, а не вся история Letta.", html: `<div class="section-stack"><article class="section-card"><h3>Подтверждено: ${confirmed.length}</h3>${confirmed.slice(0,8).map((item) => `<p><strong>${escapeHtml(item.field_key)}</strong>: ${escapeHtml(formatValue(item.value))}</p>`).join("") || "<p>Подтверждённых полей пока нет.</p>"}</article><article class="section-card"><h3>Нужно проверить: ${candidates.length}</h3><p>Подтверждение и отклонение кандидатов будет подключено к отдельному экрану памяти.</p></article></div>` });
    }
    if (code === "pulse") return openSheet({ title: "Диагностика", subtitle: "Технические детали скрыты от обычных экранов.", html: `<div class="section-stack"><article class="section-card"><p><strong>Frontend:</strong> ${BUILD}</p><p><strong>API v2:</strong> ${state.dashboard ? "доступен" : "не подключён"}</p><p><strong>Telegram initData:</strong> ${tg?.initData ? "получена" : "отсутствует"}</p><p><strong>Тариф:</strong> ${escapeHtml(state.session?.plan || "неизвестно")}</p></article></div>` });
    openSheet({ title: "Настройки", subtitle: "Раздел не дублирует инструменты Пульта.", html: `<article class="section-card"><p>Эта настройка будет подключена к серверному профилю и административной конфигурации. Сейчас интерфейс не имитирует сохранение.</p></article>` });
  }

  // ---------------------------------------------------------------------------
  // Eva handoff / notifications
  // ---------------------------------------------------------------------------

  function openEvaHandoff(context = "") {
    closeSheet();
    openSheet({
      title: "Обсудить с Евой",
      subtitle: "WebApp не подключается к Letta напрямую. Контекст будет скопирован, затем откроется чат.",
      html: `<article class="section-card"><p>${escapeHtml(context || "Продолжить разговор")}</p></article><div class="action-row"><button class="primary-action" id="open-eva-chat" type="button">Открыть чат</button><button class="secondary-action" id="copy-eva-context" type="button">Скопировать</button></div>`,
      onMount(host) {
        host.querySelector("#copy-eva-context").addEventListener("click", async () => { await copyText(context); toast("Формулировка скопирована"); });
        host.querySelector("#open-eva-chat").addEventListener("click", async () => {
          await copyText(context);
          const username = state.bot?.username;
          if (username) tg?.openTelegramLink?.(`https://t.me/${username.replace(/^@/, "")}`);
          else { toast("Вернитесь в чат с Евой — формулировка скопирована"); setTimeout(() => tg?.close?.(), 700); }
        });
      },
    });
  }

  function openNotificationsSheet() {
    const next = state.dashboard?.next_reminder;
    openSheet({
      title: "Уведомления",
      subtitle: "Показываются пользовательские события, а не технические ошибки сервера.",
      html: next ? `<article class="section-card"><span class="eyebrow">БЛИЖАЙШЕЕ</span><h3>${escapeHtml(next.title)}</h3><p>${formatDateTime(next.remind_at)}</p></article>` : `<div class="empty-state"><strong>Новых уведомлений нет</strong><span>Ближайшие напоминания появятся здесь.</span></div>`,
    });
  }

  function updateNotificationDot() {
    document.getElementById("notification-dot").hidden = !state.dashboard?.next_reminder;
  }

  // ---------------------------------------------------------------------------
  // Sheet / toast
  // ---------------------------------------------------------------------------

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

  let toastTimer;
  function toast(message, error = false) {
    const node = document.getElementById("toast");
    node.textContent = message;
    node.classList.toggle("is-error", error);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
  }

  async function refreshDashboard() {
    const dashboard = await safeApi("/public/v2/dashboard", {}, null);
    if (dashboard) {
      state.dashboard = dashboard;
      state.tasks = dashboard.tasks || state.tasks;
      state.notes = dashboard.notes || state.notes;
      renderToday(); renderHub(); renderProfile(); updateNotificationDot();
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers / icons
  // ---------------------------------------------------------------------------

  function injectIcons(root) {
    root.querySelectorAll?.("[data-icon]").forEach((node) => { node.innerHTML = icon(node.dataset.icon); });
  }

  function icon(name) {
    const paths = {
      bell: '<path d="M10 26c3-3 4-7 4-12a6 6 0 0 1 12 0c0 5 1 9 4 12Z"/><path d="M17 30a4 4 0 0 0 8 0M20 8V4"/>',
      smile: '<circle cx="18" cy="18" r="14"/><circle cx="13" cy="15" r="1.5" fill="currentColor" stroke="none"/><circle cx="23" cy="15" r="1.5" fill="currentColor" stroke="none"/><path d="M12 22c3 4 9 4 12 0"/>',
      bolt: '<path d="m21 2-12 19h9l-3 13 13-21h-9Z"/>',
      tension: '<path d="M4 12c5-7 10 7 15 0s10 7 15 0M4 24c5-7 10 7 15 0s10 7 15 0"/>',
      checklist: '<rect x="6" y="5" width="25" height="28" rx="4"/><path d="m10 13 3 3 5-6M21 13h6m-17 9 3 3 5-6M21 22h6"/>',
      route: '<path d="M5 29c4-9 8 1 12-8s8 2 12-8"/><path d="M25 5h7v7M29 13l3-1"/>',
      pencil: '<path d="m6 29 3-9L25 4l7 7-16 16Z"/><path d="m9 20 7 7M23 6l7 7M5 33c7-2 14-2 21 0"/>',
      chat: '<path d="M5 7h26v18H16l-8 6 2-6H5Z"/><path d="M11 13h14M11 18h10"/>',
      wave: '<path d="M3 18c4-8 8 8 12 0s8 8 12 0 8 8 12 0"/><path d="M7 28h25"/>',
      plus: '<path d="M18 6v24M6 18h24"/>',
      minus: '<path d="M6 18h24"/>',
      home: '<path d="M4 16 18 5l14 11v16H22V22h-8v10H4Z"/>',
      sprout: '<path d="M18 32V17M18 20C9 18 8 10 9 5c8 1 12 7 9 15Zm0-4c8-2 11-8 10-13-8 1-13 7-10 13Z"/>',
      calendar: '<rect x="5" y="8" width="28" height="25" rx="4"/><path d="M11 4v8M27 4v8M5 15h28M11 21h4M21 21h4M11 27h4M21 27h4"/>',
      sliders: '<path d="M5 9h28M5 18h28M5 27h28"/><circle cx="13" cy="9" r="3" fill="var(--paper)"/><circle cx="24" cy="18" r="3" fill="var(--paper)"/><circle cx="16" cy="27" r="3" fill="var(--paper)"/>',
      user: '<circle cx="18" cy="10" r="6"/><path d="M6 33c1-10 5-15 12-15s11 5 12 15"/>',
      back: '<path d="m22 6-12 12 12 12M11 18h21"/>',
      check: '<path d="m5 18 8 8L31 8"/>',
      edit: '<path d="M7 29h6L30 12l-6-6L7 23Zm14-20 6 6M6 33h26"/>',
      clipboard: '<rect x="8" y="7" width="23" height="28" rx="4"/><path d="M14 7V4h11v3M13 15l2 2 4-5M22 15h5M13 24l2 2 4-5M22 24h5"/>',
      hearts: '<path d="M12 28 4 20C-2 13 7 4 13 11l2 2 2-2c6-7 15 2 9 9Z"/><path d="m23 31-6-6c-5-6 3-13 8-7l2 2 2-2c5-6 13 1 8 7l-6 6Z" fill="var(--orange-soft)"/>',
      wallet: '<path d="M5 11h26a3 3 0 0 1 3 3v18H8a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4h19"/><path d="M26 18h9v8h-9a4 4 0 0 1 0-8Z" fill="var(--orange-soft)"/>',
      lotus: '<path d="M18 33C8 29 5 22 6 15c8 1 13 7 12 18Zm0 0c10-4 13-11 12-18-8 1-13 7-12 18Zm0-1C10 25 10 15 18 7c8 8 8 18 0 25Z"/>',
      chart: '<path d="M5 31h29M8 28V17h6v11m5 0V8h6v20m5 0V13h5v15"/><path d="M26 15a8 8 0 1 1 0 16" fill="var(--orange-soft)"/>',
      planet: '<circle cx="19" cy="19" r="9" fill="var(--orange)"/><path d="M5 25c5 5 19 1 27-6 5-5 4-8-1-7M29 6l2-3m4 8 3-1M31 31l2 3"/>',
      brain: '<path d="M14 7a6 6 0 0 0-6 6c-4 1-5 7-2 10-2 5 2 10 7 9 2 3 7 2 7-2V10c0-4-3-6-6-3Zm8 3v20c0 4 5 5 7 2 5 1 9-4 7-9 3-3 2-9-2-10a6 6 0 0 0-6-6c-3-3-6-1-6 3Z"/><path d="M12 14c4 0 5 3 5 6M29 14c-4 0-5 3-5 6M12 26c4 0 5-3 5-6M29 26c-4 0-5-3-5-6"/>',
      card: '<rect x="4" y="8" width="32" height="23" rx="4"/><path d="M4 15h32M9 25h8"/>',
      voice: '<rect x="13" y="4" width="12" height="21" rx="6"/><path d="M8 18c0 7 5 11 11 11s11-4 11-11M19 29v6M13 35h12"/>',
      link: '<path d="M15 23 11 27a6 6 0 0 1-9-9l7-7a6 6 0 0 1 9 0M23 15l4-4a6 6 0 0 1 9 9l-7 7a6 6 0 0 1-9 0M12 18h15"/>',
      shield: '<path d="M18 3 32 8v10c0 9-6 14-14 17C10 32 4 27 4 18V8Z"/><path d="m11 19 5 5 10-11"/>',
      pulse: '<path d="M3 20h8l4-9 6 18 5-12 3 3h7"/>',
      note: '<path d="M8 4h21l5 5v25H8Z"/><path d="M29 4v6h6M13 16h16M13 22h16M13 28h10"/>',
      signpost: '<path d="M18 34V5M18 8h15l-4 5 4 5H18M18 21H5l4 5-4 5h13"/>',
      target: '<circle cx="18" cy="18" r="14"/><circle cx="18" cy="18" r="8"/><circle cx="18" cy="18" r="2"/><path d="m24 12 9-9m-5 0h5v5"/>',
      refresh: '<path d="M31 10V4l-5 5a13 13 0 1 0 4 15"/>',
      voice2: '<path d="M18 5v26M11 11v14M25 11v14M5 15v6M31 15v6"/>',
      photo: '<rect x="4" y="6" width="32" height="27" rx="4"/><circle cx="14" cy="15" r="4"/><path d="m7 29 9-9 6 6 4-4 7 7"/>',
      repeat: '<path d="M8 12h20l-4-4m4 4-4 4M28 26H8l4 4m-4-4 4-4"/>',
      star: '<path d="m18 3 4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1Z"/>',
      ground: '<path d="M4 29h28M8 24c3-8 5-10 10-15 5 5 7 7 10 15"/>',
      sort: '<path d="M6 8h26M6 18h19M6 28h12"/><circle cx="31" cy="18" r="3"/><circle cx="24" cy="28" r="3"/>',
      dot: '<circle cx="18" cy="18" r="4" fill="var(--orange)"/><circle cx="18" cy="18" r="13" stroke-dasharray="2 5"/>',
      dump: '<path d="M6 7h26v22H18l-7 5 2-5H6Z"/><path d="M11 14h16M11 20h12"/>',
    };
    return `<svg viewBox="0 0 36 36" aria-hidden="true">${paths[name] || paths.note}</svg>`;
  }

  function renderBalloon() {
    document.getElementById("balloon").innerHTML = `<svg viewBox="0 0 78 102" aria-hidden="true"><path d="M39 5C18 5 8 22 10 45c3 24 16 41 29 47 13-6 26-23 29-47C70 22 60 5 39 5Z" fill="var(--orange)" stroke="var(--ink)" stroke-width="2.3"/><ellipse cx="31" cy="39" rx="2.2" ry="3" fill="var(--ink)" stroke="none"/><ellipse cx="47" cy="39" rx="2.2" ry="3" fill="var(--ink)" stroke="none"/><path d="M26 52c4 10 20 11 26 0" fill="none" stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round"/><path d="M34 91c0 4-3 6-4 8 5 2 13 2 18 0-1-2-4-4-4-8" fill="var(--orange-soft)" stroke="var(--ink)" stroke-width="2"/><path d="M42 100c1 7 10 3 11 8" fill="none" stroke="var(--ink)" stroke-width="1.8"/><path d="M12 24 5 19M20 11l-2-7M65 22l7-5" fill="none" stroke="var(--ink)" stroke-width="1.7" stroke-linecap="round"/></svg>`;
  }

  function renderEvaMini() { document.getElementById("eva-mini").innerHTML = evaPortrait(); }

  function evaPortrait() {
    return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" fill="#fff" stroke="var(--line-strong)"/><path d="M14 55c1-11 2-23 1-31C14 10 22 4 32 4s18 6 17 20c-1 8 0 20 1 31-5-5-11-7-18-7s-13 2-18 7Z" fill="#fff" stroke="var(--ink)"/><ellipse cx="32" cy="28" rx="13" ry="16" fill="#fff" stroke="var(--ink)"/><path d="M19 23c2-10 7-15 13-15s11 5 13 15c-5-1-9-4-12-8-3 4-7 7-14 8Z" fill="#fff" stroke="var(--ink)"/><circle cx="27" cy="28" r="1.4" fill="var(--ink)" stroke="none"/><circle cx="37" cy="28" r="1.4" fill="var(--ink)" stroke="none"/><path d="M28 36c3 2 5 2 8 0"/><path d="M18 64c1-11 6-18 14-18s13 7 14 18Z" fill="var(--orange)" stroke="var(--ink)"/><path d="M32 51c3-4 8 1 4 5l-4 3-4-3c-4-4 1-9 4-5Z" fill="#fff" stroke="var(--ink)"/></svg>`;
  }

  function practiceIcon(code) { return ({ breath: "wave", ground: "ground", sort: "sort", dot: "dot", dump: "dump" })[code] || "lotus"; }
  function sheetOption(iconName, title, note, attrs = "") { return `<button class="sheet-option" type="button" ${attrs}><span>${icon(iconName)}</span><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(note)}</small></span></button>`; }
  function emptyState(title, note) { return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(note)}</span></div>`; }
  function screenContext() { return state.screen === "today" ? `Помоги с главным результатом дня: ${state.dashboard?.main_focus?.title || "пока не выбран"}` : `Помоги в разделе «${screenTitle(state.screen)}»`; }
  function screenTitle(screen) { return ({ today: "Сегодня", development: "Развитие", organizer: "Органайзер", hub: "Пульт", profile: "Профиль", module: document.getElementById("module-title").textContent })[screen] || "Evaself"; }
  function haptic(type) { try { if (type === "success") tg?.HapticFeedback?.notificationOccurred?.("success"); else if (type === "selection") tg?.HapticFeedback?.selectionChanged?.(); else tg?.HapticFeedback?.impactOccurred?.("light"); } catch {} }
  function organizerNotes() { return state.notes.filter((note) => (note.entry_type || "note") !== "journal"); }
  function isDone(task) { return ["done", "completed"].includes(task?.status); }
  function taskSort(task) { return new Date(task.remind_at || task.due_at || "2999-12-31").getTime() + Number(task.priority || 3) * 1000; }
  function groupTasks(items) { const groups = { "СЕГОДНЯ": [], "ПРЕДСТОЯЩИЕ": [], "БЕЗ СРОКА": [], "ВЫПОЛНЕНО": [] }; items.forEach((task) => { if (isDone(task)) groups["ВЫПОЛНЕНО"].push(task); else if (isToday(task.due_at || task.remind_at)) groups["СЕГОДНЯ"].push(task); else if (task.due_at || task.remind_at) groups["ПРЕДСТОЯЩИЕ"].push(task); else groups["БЕЗ СРОКА"].push(task); }); return Object.fromEntries(Object.entries(groups).filter(([,value]) => value.length)); }
  function isToday(value) { if (!value) return false; const date = new Date(value); const now = new Date(); return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate(); }
  function toLocalInput(value) { if (!value) return ""; const date = new Date(value); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return local.toISOString().slice(0,16); }
  function localInputToIso(value) { return value ? new Date(value).toISOString() : null; }
  function dateInput(value) { if (!value) return ""; const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) return String(value).slice(0,10); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return local.toISOString().slice(0,10); }
  function formatDate(value) { if (!value) return ""; const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value).slice(0,10); return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(date); }
  function formatDateTime(value) { if (!value) return ""; const date = new Date(value); if (Number.isNaN(date.getTime())) return ""; return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date); }
  function clock(ms) { const seconds = Math.ceil(ms / 1000); return `${String(Math.floor(seconds / 60)).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`; }
  function plural(number, one, few, many) { const n10 = number % 10, n100 = number % 100; return n10 === 1 && n100 !== 11 ? one : n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14) ? few : many; }
  function firstLine(value) { return String(value || "").split(/\r?\n/).find(Boolean) || "Запись"; }
  function linesToArray(value) { return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0,50); }
  function arrayToLines(value) { return Array.isArray(value) ? value.join("\n") : ""; }
  function formatValue(value) { return typeof value === "string" ? value : JSON.stringify(value); }
  function calculateBudget(records) { return records.reduce((sum,item) => { const type = item.entry_type || item.type; const amount = Number(item.amount_minor || 0); if (type === "income") sum.income_minor += amount; else sum.expense_minor += amount; return sum; }, { income_minor: 0, expense_minor: 0 }); }
  function budgetSummaryText() { const sum = state.dashboard?.budget || calculateBudget(state.budgets); return `Расходы за месяц: ${money(sum.expense_minor || 0)}`; }
  function money(minor) { return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(Number(minor || 0) / 100); }
  function lifePath(date) { let sum = String(date).replace(/\D/g, "").split("").reduce((a,b) => a + Number(b), 0); while (sum > 9 && ![11,22,33].includes(sum)) sum = String(sum).split("").reduce((a,b) => a + Number(b), 0); return sum; }
  function numberMeaning(n) { return ({1:"Инициатива. Где важно начать самому?",2:"Сотрудничество. Где нужен диалог?",3:"Выражение. Что стоит сформулировать?",4:"Структура. Какую опору создать?",5:"Изменение. Где нужна гибкость?",6:"Забота. Что важно поддержать?",7:"Исследование. Что понять глубже?",8:"Управление. Какой ресурс использовать точнее?",9:"Завершение. Что пора закончить?",11:"Идея. Как проверить её фактами?",22:"Воплощение. Какой первый артефакт создать?",33:"Поддержка. Как помочь, сохраняя границы?"})[n] || "Символическая тема для размышления."; }
  function dailyAstroTheme() { const themes = ["Где сегодня важно сохранить направление, но проявить гибкость?", "Какой разговор стоит провести яснее и спокойнее?", "Какое небольшое действие вернёт ощущение опоры?", "Что можно завершить, чтобы освободить внимание?", "Где полезно сначала проверить факты?"]; return themes[new Date().getDate() % themes.length]; }
  async function copyText(value) { try { await navigator.clipboard.writeText(value || ""); } catch {} }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }

  function legacyDashboard(today, tasks) {
    const main = today?.main_action ? { title: today.main_action, source_label: today.goal_title || "Активная цель", expected_result: today.expected_result, work_block_id: today.work_block_id, work_block_status: today.work_block_status } : null;
    return { local_time: today?.local_time, checkin: null, main_focus: main, tasks, counts: { open_tasks: tasks.filter((task) => !isDone(task)).length, today_tasks: tasks.filter((task) => !isDone(task) && isToday(task.due_at)).length }, next_reminder: tasks.filter((task) => task.remind_at && !isDone(task)).sort((a,b) => new Date(a.remind_at) - new Date(b.remind_at))[0] || null, insight: { text: "Серверный модуль состояния ещё не подключён. Основные цели и задачи уже доступны." } };
  }

  function demoApi(path, options) {
    const now = new Date();
    const due = new Date(now.getTime() + 3 * 3600_000).toISOString();
    if (path === "/public/session") return { user: { first_name: "Вик", timezone: "Asia/Yekaterinburg" }, plan: "free" };
    if (path === "/public/bot") return { username: "eva_demo_bot" };
    if (path === "/public/goals") return { goals: [{ id: "1", title: "Запустить обновлённый Evaself", status: "active", progress_percent: 42, next_result: "Готовая структура WebApp" }] };
    if (path === "/public/profile") return { profile: { user: { preferred_name: "Вик", city: "Пермь", timezone: "Asia/Yekaterinburg" }, completeness: 68, confirmed: [], candidates: [] } };
    if (path === "/public/progress") return { progress: { completed_results: [{ title: "Собран первый макет", goal_title: "Evaself" }], work_blocks: [], goals: [] } };
    if (path.startsWith("/public/v2/dashboard")) return { local_time: "17:29", checkin: { mood: "good", energy: 7, tension: 4 }, main_focus: { id: "goal:1", title: "Завершить структуру главного экрана", source_label: "Цель: Запуск Evaself", expected_result: "Согласованный интерфейс без дублирования" }, tasks: [{ id: "1", title: "Проверить главный экран", status: "open", due_at: due, remind_at: due, priority: 2 }, { id: "2", title: "Сверить API", status: "done", priority: 3 }], notes: [{ id: "1", title: "Идеи WebApp", content: "Убрать дублирование модулей", category: "Рабочее", updated_at: now.toISOString() }], counts: { open_tasks: 1, today_tasks: 1, open_decisions: 1 }, next_reminder: { title: "Проверить главный экран", remind_at: due }, active_goal: { title: "Запустить обновлённый Evaself", next_result: "Готовая структура WebApp" }, insight: { text: "Сегодня энергия выше напряжения — можно начать с конкретного результата на 15 минут." }, budget: { income_minor: 12000000, expense_minor: 4365000, recent: [] } };
    if (path.startsWith("/public/v2/tasks")) return { tasks: [] };
    if (path.startsWith("/public/v2/notes")) return { notes: [] };
    if (path.startsWith("/public/v2/budget")) return { records: [], summary: { income_minor: 12000000, expense_minor: 4365000 } };
    if (path.startsWith("/public/v2/decisions")) return { decisions: [] };
    if (path.startsWith("/public/v2/checkins")) return { checkin: JSON.parse(options.body) };
    if (path.startsWith("/public/v2/focus-sessions")) return { focus_session: { id: "demo" } };
    return {};
  }
})();
