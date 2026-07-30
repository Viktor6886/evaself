/* Eva WebApp — final frontend-only interface. */
(() => {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  const demoMode = new URLSearchParams(location.search).get("demo") === "1";
  const DAY_KEY = new Date().toISOString().slice(0, 10);

  const state = {
    screen: "today",
    session: null,
    firstName: "",
    today: {},
    goals: [],
    tasks: [],
    notes: [],
    progress: null,
    profile: null,
    organizerTab: "tasks",
    taskFilter: "open",
    developmentTab: "goals",
    astroTab: "horoscope",
    focusTimer: null,
    selectedResult: null,
  };

  const MODULES = [
    { code: "journal", title: "Дневник", note: "Жизнь и мысли" },
    { code: "state", title: "Состояние", note: "Настроение и энергия" },
    { code: "compatibility", title: "Совместимость", note: "Люди и общение" },
    { code: "budget", title: "Бюджет", note: "Доходы и расходы" },
    { code: "practices", title: "Практики", note: "Перезагрузка" },
    { code: "tests", title: "Тесты", note: "Понять себя" },
    { code: "reports", title: "Отчёты", note: "Итоги и динамика" },
    { code: "goals", title: "Цели", note: "Направление и шаги" },
    { code: "life", title: "Карта жизни", note: "Важные сферы" },
    { code: "programs", title: "Программы", note: "7, 14 и 30 дней" },
    { code: "habits", title: "Привычки", note: "Поддерживающие ритмы" },
    { code: "focus", title: "Фокус", note: "5, 15 или 25 минут" },
    { code: "decisions", title: "Решения", note: "Факты и варианты" },
    { code: "astro", title: "Астрорефлексия", note: "Гороскоп, Таро и числа" },
  ];

  const PULT_SECTIONS = [
    { code: "memory", title: "Память Евы", note: "Что Ева знает и использует", status: "Управление", icon: "memory" },
    { code: "notifications", title: "Уведомления", note: "Время, частота и тишина", status: "Настроить", icon: "bell" },
    { code: "voice", title: "Голос и портрет", note: "TTS, ASR и анимация", status: "Включено", icon: "voice" },
    { code: "connections", title: "Интеграции", note: "Todoist, поиск и сервисы", status: "Проверить", icon: "link" },
    { code: "subscription", title: "Подписка", note: "Тариф, квоты и гранты", status: "Открыть", icon: "card" },
    { code: "privacy", title: "Данные и приватность", note: "Экспорт, память и удаление", status: "Контроль", icon: "shield" },
    { code: "appearance", title: "Оформление", note: "Тема, анимация и положение Евы", status: "Светлая", icon: "palette" },
    { code: "diagnostics", title: "Помощь и диагностика", note: "Связь с сервисами и поддержка", status: "Работает", icon: "pulse" },
  ];

  const ASTRO_TAROT = [
    ["Звезда", "Надежда, ориентир и восстановление направления"],
    ["Отшельник", "Пауза, самостоятельное осмысление и поиск ответа"],
    ["Колесница", "Движение, управление усилиями и выбранный курс"],
    ["Умеренность", "Баланс, постепенность и соединение противоположностей"],
    ["Сила", "Мягкая настойчивость и управление импульсом"],
    ["Мир", "Завершение этапа и переход к следующему циклу"],
  ];

  if (tg) {
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.("#fbfaf6");
    tg.setBackgroundColor?.("#fbfaf6");
    tg.setBottomBarColor?.("#fffefa");
  }

  renderModules();
  renderPult();
  bindEvents();
  renderCheckin(readCheckin());
  renderAstro();
  updateGreeting();
  void bootstrap();

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------
  async function api(path, options = {}) {
    if (demoMode) return demoApi(path, options);
    const initData = tg?.initData;
    if (!initData) throw new Error("Приложение нужно открыть из Telegram.");

    const headers = {
      "X-Telegram-Init-Data": initData,
      ...(options.headers || {}),
    };
    // Do not send application/json with an empty body. Some backend
    // frameworks reject GET/empty POST requests with that header.
    if (options.body != null && !(options.body instanceof FormData)) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
    }

    const response = await fetch(`/api${path}`, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => "");
    if (!response.ok) {
      const serverMessage = typeof payload === "object" ? payload?.error?.message || payload?.message : "";
      throw new Error(serverMessage || `Ошибка запроса (${response.status})`);
    }
    return payload || {};
  }

  async function safeApi(path, options = {}, fallback = {}) {
    try { return await api(path, options); }
    catch (error) {
      console.warn(`[Eva API] ${path}`, error);
      return fallback;
    }
  }

  async function bootstrap() {
    state.session = await safeApi("/public/session", { method: "POST" }, {});
    state.firstName = state.session?.user?.preferred_name
      || state.session?.user?.first_name
      || tg?.initDataUnsafe?.user?.first_name
      || "";
    updateGreeting();

    const [todayData, goalsData, tasksData, notesData] = await Promise.all([
      safeApi("/public/today", {}, { today: {} }),
      safeApi("/public/goals", {}, { goals: [] }),
      safeApi("/public/tasks", {}, { tasks: [] }),
      safeApi("/public/notes", {}, { notes: [] }),
    ]);
    state.today = todayData.today || {};
    state.goals = goalsData.goals || [];
    state.tasks = tasksData.tasks || [];
    state.notes = notesData.notes || [];
    selectAutomaticResult();
    renderOrganizer();
    renderDevelopment();
    updateNotificationDot();
  }

  // ------------------------------------------------------------------
  // Events and navigation
  // ------------------------------------------------------------------
  function bindEvents() {
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.addEventListener("click", () => void openScreen(button.dataset.target));
    });
    document.querySelectorAll("[data-checkin]").forEach((button) => {
      button.addEventListener("click", openCheckinSheet);
    });
    document.querySelectorAll("[data-quick]").forEach((button) => {
      button.addEventListener("click", () => handleQuick(button.dataset.quick));
    });
    document.getElementById("main-result-card").addEventListener("click", openResultSheet);
    document.getElementById("notifications-button").addEventListener("click", openNotificationsSheet);
    document.getElementById("eva-fab").addEventListener("click", openEvaSheet);
    document.getElementById("sheet-close").addEventListener("click", closeSheet);
    document.getElementById("sheet").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeSheet();
    });

    document.getElementById("development-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-development-tab]");
      if (!button) return;
      state.developmentTab = button.dataset.developmentTab;
      document.querySelectorAll("[data-development-tab]").forEach((item) => item.classList.toggle("is-active", item === button));
      renderDevelopment();
    });
    document.querySelector(".organizer-switch").addEventListener("click", (event) => {
      const button = event.target.closest("[data-organizer-tab]");
      if (!button) return;
      state.organizerTab = button.dataset.organizerTab;
      document.querySelectorAll("[data-organizer-tab]").forEach((item) => item.classList.toggle("is-active", item === button));
      renderOrganizer();
    });
    document.getElementById("organizer-filters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-task-filter]");
      if (!button) return;
      state.taskFilter = button.dataset.taskFilter;
      document.querySelectorAll("[data-task-filter]").forEach((item) => item.classList.toggle("is-active", item === button));
      renderOrganizer();
    });
    document.getElementById("add-organizer-item").addEventListener("click", () => openTaskSheet(null, state.organizerTab === "reminders"));
    document.querySelector(".astro-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-astro-tab]");
      if (!button) return;
      state.astroTab = button.dataset.astroTab;
      document.querySelectorAll("[data-astro-tab]").forEach((item) => item.classList.toggle("is-active", item === button));
      renderAstro();
    });

    tg?.BackButton?.onClick(() => void openScreen("today"));
  }

  async function openScreen(screen) {
    const allowed = ["today", "goals", "organizer", "pult", "profile", "progress", "astro", "module"];
    if (!allowed.includes(screen)) return;
    state.screen = screen;
    document.body.classList.toggle("is-home", screen === "today");
    closeSheet();
    document.querySelectorAll(".screen").forEach((node) => { node.hidden = node.dataset.screen !== screen; });
    document.querySelectorAll(".nav-item").forEach((node) => {
      const active = node.dataset.target === screen;
      node.classList.toggle("is-active", active);
      if (active) node.setAttribute("aria-current", "page"); else node.removeAttribute("aria-current");
    });
    if (screen === "today") {
      updateGreeting();
      tg?.BackButton?.hide?.();
    } else {
      tg?.BackButton?.show?.();
    }
    document.querySelector(`[data-screen="${screen}"]`)?.scrollTo?.(0, 0);

    if (screen === "organizer" && !state.tasks.length) {
      const data = await safeApi("/public/tasks", {}, { tasks: [] });
      state.tasks = data.tasks || [];
      renderOrganizer();
    }
    if (screen === "goals") {
      if (!state.goals.length) {
        const data = await safeApi("/public/goals", {}, { goals: [] });
        state.goals = data.goals || [];
      }
      renderDevelopment();
    }
    if (screen === "profile" && !state.profile) await loadProfile();
    if (screen === "progress" && !state.progress) await loadProgress();
    if (screen === "astro") renderAstro();
    haptic("light");
  }

  // ------------------------------------------------------------------
  // Greeting / state
  // ------------------------------------------------------------------
  function updateGreeting() {
    const hour = new Date().getHours();
    const phrase = hour < 5 ? "Доброй ночи" : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
    const textValue = state.firstName ? `${phrase}, ${state.firstName}` : phrase;
    const node = document.getElementById("greeting-text");
    node.textContent = textValue;
    node.classList.toggle("is-compact", textValue.length > 18);
  }

  function readCheckin() {
    try {
      const value = JSON.parse(localStorage.getItem("eva.checkin.v2") || "{}");
      return value.day === DAY_KEY ? value : {};
    } catch { return {}; }
  }
  function renderCheckin(data) {
    document.getElementById("mood-value").textContent = data.mood || "Отметить";
    document.getElementById("energy-value").textContent = data.energy ? `${data.energy} / 10` : "— / 10";
    document.getElementById("focus-value").textContent = data.focus ? `${data.focus} / 10` : "— / 10";
  }
  function openCheckinSheet() {
    const data = readCheckin();
    const moods = ["Тяжёлое", "Спокойное", "Хорошее", "Отличное"];
    openSheet({
      title: "Как ты сейчас?",
      subtitle: "Быстрая отметка займёт несколько секунд",
      html: `<form class="form-grid" id="checkin-form">
        <fieldset><legend>Настроение</legend><div class="mood-options">${moods.map((mood) => `<label><input type="radio" name="mood" value="${attr(mood)}" ${data.mood === mood ? "checked" : ""}><span>${text(mood)}</span></label>`).join("")}</div></fieldset>
        <label class="range-row"><span>Энергия: <strong id="energy-output">${data.energy || 5}</strong>/10</span><input type="range" name="energy" min="1" max="10" value="${data.energy || 5}"></label>
        <label class="range-row"><span>Фокус: <strong id="focus-output">${data.focus || 5}</strong>/10</span><input type="range" name="focus" min="1" max="10" value="${data.focus || 5}"></label>
        <button class="primary-action" type="submit">Сохранить</button>
      </form>`,
      onMount(host) {
        const form = host.querySelector("#checkin-form");
        form.addEventListener("input", () => {
          host.querySelector("#energy-output").textContent = form.elements.energy.value;
          host.querySelector("#focus-output").textContent = form.elements.focus.value;
        });
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const value = {
            day: DAY_KEY,
            mood: form.querySelector('input[name="mood"]:checked')?.value || data.mood || "Спокойное",
            energy: Number(form.elements.energy.value),
            focus: Number(form.elements.focus.value),
          };
          localStorage.setItem("eva.checkin.v2", JSON.stringify(value));
          renderCheckin(value);
          closeSheet();
          toast("Состояние отмечено");
          updateNotificationDot();
          haptic("success");
        });
      },
    });
  }

  // ------------------------------------------------------------------
  // Main result: backend + goals + tasks + notes
  // ------------------------------------------------------------------
  function deriveResultCandidates() {
    const candidates = [];
    const add = (title, source, id) => {
      const clean = String(title || "").trim();
      if (!clean || candidates.some((item) => item.title.toLowerCase() === clean.toLowerCase())) return;
      candidates.push({ title: clean, source, id: id || `${source}:${clean}` });
    };

    add(state.today?.main_action, "Ева", "today");
    state.goals.filter((goal) => goal.status === "active" || !goal.status).forEach((goal) => {
      add(goal.next_result, `Цель: ${goal.title}`, `goal-result:${goal.id}`);
      add(goal.next_step, `Следующий шаг цели: ${goal.title}`, `goal-step:${goal.id}`);
    });

    [...state.tasks]
      .filter((task) => !["done", "completed", "canceled"].includes(task.status))
      .sort((a, b) => taskPriority(a) - taskPriority(b))
      .slice(0, 6)
      .forEach((task) => add(task.title, task.due_at ? `Задача до ${formatDateTime(task.due_at)}` : "Задача", `task:${task.id}`));

    state.notes.slice(0, 4).forEach((note) => {
      const title = note.title || firstLine(note.content);
      if (title) add(`Разобрать: ${title}`, "Заметка", `note:${note.id}`);
    });
    return candidates.slice(0, 10);
  }

  function taskPriority(task) {
    const date = task.due_at ? new Date(task.due_at).getTime() : Number.MAX_SAFE_INTEGER;
    const p = { urgent: 0, high: 1, medium: 2, normal: 2, low: 3 }[task.priority] ?? 2;
    return Math.min(date, Date.now() + p * 86_400_000);
  }

  function selectAutomaticResult() {
    const saved = readSavedResult();
    const candidates = deriveResultCandidates();
    state.selectedResult = saved || candidates[0] || { title: "Обсудить главный результат с Евой", source: "Ева", id: "eva" };
    renderMainResult();
  }

  function renderMainResult() {
    document.getElementById("main-result").textContent = state.selectedResult?.title || "Выбрать главный результат";
    document.getElementById("main-result-source").textContent = state.selectedResult?.source || "Автоматический выбор";
  }

  function readSavedResult() {
    try {
      const value = JSON.parse(localStorage.getItem("eva.main-result.v2") || "null");
      return value?.day === DAY_KEY ? value : null;
    } catch { return null; }
  }

  function openResultSheet() {
    const candidates = deriveResultCandidates();
    openSheet({
      title: "Главный результат дня",
      subtitle: "Ева сопоставляет активную цель, ближайшие задачи, заметки и текущий контекст",
      html: `<div class="sheet-options">${candidates.length ? candidates.map((item) => `
        <button class="result-suggestion ${state.selectedResult?.id === item.id ? "is-selected" : ""}" type="button" data-result-id="${attr(item.id)}">
          <small>${text(item.source)}</small><strong>${text(item.title)}</strong>
        </button>`).join("") : `<div class="empty-state"><strong>Пока нет вариантов</strong><span>Добавьте цель, задачу или заметку — результат появится автоматически.</span></div>`}</div>
        <div class="sheet-options">
          ${option("auto", "refresh", "Выбирать автоматически", "Снять ручной выбор и обновлять по контексту")}
          ${option("eva", "chat", "Обсудить с Евой", "Определить результат в разговоре")}
          ${option("task", "check", "Создать задачу", "Добавить конкретное действие")}
        </div>`,
      onMount(host) {
        host.querySelectorAll("[data-result-id]").forEach((button) => button.addEventListener("click", () => {
          const item = candidates.find((candidate) => candidate.id === button.dataset.resultId);
          if (!item) return;
          state.selectedResult = { ...item, day: DAY_KEY };
          localStorage.setItem("eva.main-result.v2", JSON.stringify(state.selectedResult));
          renderMainResult();
          closeSheet();
          toast("Главный результат обновлён");
        }));
        bindOptions(host, (action) => {
          if (action === "auto") {
            localStorage.removeItem("eva.main-result.v2");
            state.selectedResult = deriveResultCandidates()[0] || { title: "Обсудить главный результат с Евой", source: "Ева", id: "eva" };
            renderMainResult(); closeSheet(); toast("Включён автоматический выбор");
          } else if (action === "eva") openEvaSheet("Помоги выбрать главный результат дня");
          else openTaskSheet(null, false);
        });
      },
    });
  }

  // ------------------------------------------------------------------
  // Home modules and quick actions
  // ------------------------------------------------------------------
  function renderModules() {
    const host = document.getElementById("modules-grid");
    host.innerHTML = MODULES.map((item) => `<button class="module-tile" type="button" data-module="${attr(item.code)}">
      <span class="module-icon" aria-hidden="true">${moduleIcon(item.code)}</span>
      <span class="module-title ${item.title.length > 12 ? "is-long" : ""}">${text(item.title)}</span>
    </button>`).join("") + '<span class="module-tile is-empty"></span><span class="module-tile is-empty"></span>';
    host.querySelectorAll("[data-module]").forEach((button) => button.addEventListener("click", () => openModule(button.dataset.module)));
  }

  function openModule(code) {
    if (code === "state") return openCheckinSheet();
    if (code === "focus") return openFocusSheet();
    if (code === "goals") { state.developmentTab = "goals"; return void openScreen("goals"); }
    if (["life", "programs", "habits", "decisions"].includes(code)) {
      state.developmentTab = code;
      document.querySelectorAll("[data-development-tab]").forEach((button) => button.classList.toggle("is-active", button.dataset.developmentTab === code));
      return void openScreen("goals");
    }
    if (code === "reports") return void openScreen("progress");
    if (code === "astro") return void openScreen("astro");
    if (code === "journal") return openJournalSheet();
    showModulePage(code);
  }

  function handleQuick(action) {
    if (action === "journal") return openJournalSheet();
    if (action === "focus") return openFocusSheet();
    if (action === "eva") return openEvaSheet();
    showModulePage("practices");
  }

  function showModulePage(code) {
    const item = MODULES.find((module) => module.code === code);
    if (!item) return;
    document.getElementById("module-kicker").textContent = item.note.toUpperCase();
    document.getElementById("module-title").textContent = item.title;
    const descriptions = {
      compatibility: "Здесь будут карточки людей, приглашения на тестирование и совместные отчёты с рекомендациями по общению.",
      budget: "Здесь будут доходы, расходы, чеки, лимиты и ежемесячные рекомендации Евы.",
      practices: "Короткие практики: дыхание, заземление, разгрузка мыслей и фокус на минуту.",
      tests: "Типологический профиль, Big Five и другие тесты с понятными отчётами.",
      journal: "События, голосовые записи, люди, темы и автоматические обзоры.",
    };
    document.getElementById("module-content").innerHTML = `<div class="placeholder-card">
      <span class="module-icon" aria-hidden="true">${moduleIcon(code)}</span>
      <h2>${text(item.title)}</h2><p>${text(descriptions[code] || item.note)}</p>
      <button class="secondary-action" id="ask-module-eva" type="button">Обсудить с Евой</button>
    </div>`;
    document.getElementById("ask-module-eva").addEventListener("click", () => openEvaSheet(`Расскажи про раздел «${item.title}»`));
    void openScreen("module");
  }

  // ------------------------------------------------------------------
  // Organizer — tasks and reminders
  // ------------------------------------------------------------------
  function renderOrganizer() {
    const host = document.getElementById("organizer-content");
    const activeTasks = state.tasks.filter((task) => !["done", "completed", "canceled"].includes(task.status));
    const reminders = state.tasks.filter((task) => task.remind_at && !["canceled"].includes(task.status));
    document.getElementById("tasks-count").textContent = activeTasks.length;
    document.getElementById("reminders-count").textContent = reminders.filter((task) => !["done", "completed"].includes(task.status)).length;

    let items = state.organizerTab === "reminders" ? reminders : state.tasks;
    items = items.filter((task) => {
      const done = ["done", "completed"].includes(task.status);
      if (state.taskFilter === "done") return done;
      if (state.taskFilter === "today") return !done && isToday(task.due_at || task.remind_at);
      return !done;
    });
    items.sort((a, b) => new Date(a.remind_at || a.due_at || "2999-01-01") - new Date(b.remind_at || b.due_at || "2999-01-01"));

    if (!items.length) {
      host.innerHTML = `<div class="empty-state"><strong>${state.organizerTab === "reminders" ? "Напоминаний пока нет" : "Задач пока нет"}</strong><span>Нажмите «+» или попросите Еву добавить ${state.organizerTab === "reminders" ? "напоминание" : "задачу"}.</span></div>`;
      return;
    }
    host.innerHTML = items.map((task) => renderTask(task)).join("");
    host.querySelectorAll("[data-task-toggle]").forEach((button) => button.addEventListener("click", () => void toggleTask(button.dataset.taskToggle)));
    host.querySelectorAll("[data-task-edit]").forEach((button) => button.addEventListener("click", () => {
      const task = state.tasks.find((item) => String(item.id) === button.dataset.taskEdit);
      openTaskSheet(task, state.organizerTab === "reminders");
    }));
  }

  function renderTask(task) {
    const done = ["done", "completed"].includes(task.status);
    const due = task.due_at ? formatDateTime(task.due_at) : "";
    const remind = task.remind_at ? formatDateTime(task.remind_at) : "";
    const overdue = !done && task.due_at && new Date(task.due_at) < new Date();
    return `<article class="task-item ${done ? "is-done" : ""}">
      <button class="task-check" type="button" data-task-toggle="${attr(task.id)}" aria-label="${done ? "Вернуть задачу" : "Отметить выполненной"}">${icon("check")}</button>
      <div class="task-copy"><span class="task-title">${text(task.title)}</span><div class="task-meta">
        ${due ? `<span class="${overdue ? "is-overdue" : ""}">Срок: ${text(due)}</span>` : ""}
        ${remind ? `<span class="reminder-badge">Напомнить: ${text(remind)}</span>` : ""}
        ${task.repeat || task.cron ? `<span>Повторяется</span>` : ""}
      </div></div>
      <button class="task-edit" type="button" data-task-edit="${attr(task.id)}" aria-label="Изменить">${icon("edit")}</button>
    </article>`;
  }

  async function toggleTask(id) {
    const task = state.tasks.find((item) => String(item.id) === String(id));
    if (!task) return;
    const previous = task.status;
    task.status = ["done", "completed"].includes(previous) ? "open" : "done";
    renderOrganizer();
    try {
      await api(`/public/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: task.status }) });
      toast(task.status === "done" ? "Задача выполнена" : "Задача возвращена");
      selectAutomaticResult();
      haptic("success");
    } catch (error) {
      task.status = previous;
      renderOrganizer();
      toast(friendlyError(error), true);
    }
  }

  function openTaskSheet(task = null, reminderMode = false) {
    const timezone = state.session?.user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    openSheet({
      title: task ? "Изменить" : reminderMode ? "Новое напоминание" : "Новая задача",
      subtitle: reminderMode ? "Можно добавить отдельный срок и время напоминания" : "Задачу можно выполнить и изменить прямо в Органайзере",
      html: `<form class="form-grid" id="task-form">
        <label><span>Название</span><input name="title" maxlength="500" required value="${attr(task?.title || "")}" placeholder="Что нужно сделать?"></label>
        <label><span>Описание</span><textarea name="description" rows="2" maxlength="3000" placeholder="Необязательно">${text(task?.description || "")}</textarea></label>
        <label><span>Срок</span><input name="due_at" type="datetime-local" value="${attr(toLocalInput(task?.due_at))}"></label>
        <label><span>Напомнить</span><input name="remind_at" type="datetime-local" value="${attr(toLocalInput(task?.remind_at))}" ${reminderMode && !task ? "required" : ""}></label>
        <label><span>Приоритет</span><select name="priority"><option value="normal">Обычный</option><option value="high" ${task?.priority === "high" ? "selected" : ""}>Высокий</option><option value="low" ${task?.priority === "low" ? "selected" : ""}>Низкий</option></select></label>
        <input type="hidden" name="timezone" value="${attr(timezone)}">
        <button class="primary-action" type="submit">${task ? "Сохранить изменения" : "Добавить"}</button>
      </form>`,
      onMount(host) {
        host.querySelector("#task-form").addEventListener("submit", (event) => void saveTask(event, task));
      },
    });
  }

  async function saveTask(event, existing) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const raw = Object.fromEntries(new FormData(form).entries());
    const payload = {
      title: raw.title.trim(), description: raw.description.trim() || null,
      due_at: fromLocalInput(raw.due_at), remind_at: fromLocalInput(raw.remind_at),
      priority: raw.priority, timezone: raw.timezone,
    };
    submit.disabled = true;
    try {
      if (existing) {
        const result = await api(`/public/tasks/${encodeURIComponent(existing.id)}`, { method: "PATCH", body: JSON.stringify(payload) });
        Object.assign(existing, result.task || payload);
      } else {
        const result = await api("/public/tasks", { method: "POST", body: JSON.stringify(payload) });
        state.tasks.unshift(result.task || { id: `local-${Date.now()}`, status: "open", ...payload });
      }
      closeSheet(); renderOrganizer(); selectAutomaticResult(); toast(existing ? "Изменения сохранены" : "Добавлено"); haptic("success");
    } catch (error) { toast(friendlyError(error), true); }
    finally { submit.disabled = false; }
  }

  // ------------------------------------------------------------------
  // Development
  // ------------------------------------------------------------------
  function renderDevelopment() {
    const host = document.getElementById("development-content");
    if (state.developmentTab === "goals") return renderGoals(host);
    const configs = {
      life: ["Карта жизни", "Оцените важность и удовлетворённость сферами жизни, затем выберите один фокус месяца.", "Оценить сферы", "life"],
      programs: ["Программы", "Персональные маршруты на 7, 14 и 30 дней с одним упражнением и действием в день.", "Выбрать программу", "programs"],
      habits: ["Привычки и ритуалы", "Утро, начало работы, вечер и минимальная версия на сложный день без наказаний за пропуск.", "Создать ритуал", "habits"],
      decisions: ["Решения", "Соберите варианты, факты, предположения, риски и дату проверки фактического результата.", "Разобрать решение", "decisions"],
    };
    const [title, description, action, iconCode] = configs[state.developmentTab] || configs.life;
    host.innerHTML = `<div class="development-hub"><div class="placeholder-card"><span class="module-icon">${moduleIcon(iconCode)}</span><h2>${text(title)}</h2><p>${text(description)}</p><button class="secondary-action" id="development-eva" type="button">${text(action)}</button></div></div>`;
    host.querySelector("#development-eva").addEventListener("click", () => openEvaSheet(`${action}: ${title}`));
  }

  function renderGoals(host) {
    if (!state.goals.length) {
      host.innerHTML = `<div class="empty-state"><strong>Целей пока нет</strong><span>Добавьте один ориентир, который хочется приблизить.</span><button class="primary-action" id="add-goal" type="button">Добавить цель</button></div>`;
      host.querySelector("#add-goal").addEventListener("click", openGoalSheet);
      return;
    }
    host.innerHTML = `<div class="development-hub">${state.goals.map((goal) => {
      const progress = Math.max(0, Math.min(100, Number(goal.progress_percent || 0)));
      return `<article class="goal-card"><div class="goal-topline"><div><h3>${text(goal.title)}</h3><span class="card-caption">${goal.target_date ? `до ${formatDate(goal.target_date)}` : "без жёсткого срока"}</span></div><span class="status-chip">${text(goalStatus(goal.status))}</span></div><div><div class="goal-topline card-caption"><span>Прогресс</span><span>${progress}%</span></div><div class="progress-track"><span style="width:${progress}%"></span></div></div>${goal.next_result ? `<div><strong>${text(goal.next_result)}</strong>${goal.next_step ? `<div class="card-caption">Следом: ${text(goal.next_step)}</div>` : ""}</div>` : ""}</article>`;
    }).join("")}<button class="primary-action" id="add-goal" type="button">Добавить цель</button></div>`;
    host.querySelector("#add-goal").addEventListener("click", openGoalSheet);
  }

  function openGoalSheet() {
    openSheet({
      title: "Новая цель", subtitle: "Сформулируйте результат, который хочется приблизить",
      html: `<form class="form-grid" id="goal-form"><label><span>Цель</span><input name="title" required maxlength="500" placeholder="Например, подготовить запуск проекта"></label><label><span>Почему это важно</span><textarea name="why_it_matters" rows="3" maxlength="5000"></textarea></label><label><span>Желаемый срок</span><input name="target_date" type="date"></label><button class="primary-action" type="submit">Сохранить</button></form>`,
      onMount(host) { host.querySelector("#goal-form").addEventListener("submit", (event) => void saveGoal(event)); },
    });
  }
  async function saveGoal(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    try {
      const result = await api("/public/goals", { method: "POST", body: JSON.stringify(payload) });
      state.goals.unshift(result.goal || { id: `local-${Date.now()}`, status: "active", progress_percent: 0, ...payload });
      closeSheet(); renderDevelopment(); selectAutomaticResult(); toast("Цель добавлена");
    } catch (error) { toast(friendlyError(error), true); }
  }

  // ------------------------------------------------------------------
  // Pult: control center, not duplicate module list
  // ------------------------------------------------------------------
  function renderPult() {
    document.getElementById("pult-sections").innerHTML = PULT_SECTIONS.map((item) => `<button class="control-card" type="button" data-control="${attr(item.code)}"><span class="control-icon">${controlIcon(item.icon)}</span><span><h3>${text(item.title)}</h3><p>${text(item.note)}</p></span><small>${text(item.status)}</small></button>`).join("");
    document.querySelectorAll("[data-control]").forEach((button) => button.addEventListener("click", () => openControl(button.dataset.control)));
  }
  function openControl(code) {
    if (code === "memory" || code === "privacy") return void openScreen("profile");
    const data = PULT_SECTIONS.find((item) => item.code === code);
    openSheet({
      title: data?.title || "Настройки", subtitle: data?.note || "",
      html: `<div class="sheet-options">${option("settings", "sliders", "Настроить", "Параметры будут подключены к административной конфигурации")}${option("eva", "chat", "Обсудить с Евой", "Получить пояснение по этой настройке")}</div>`,
      onMount(host) { bindOptions(host, (action) => action === "eva" ? openEvaSheet(`Расскажи про настройку «${data?.title}»`) : toast("Раздел настроек подготовлен")); },
    });
  }

  // ------------------------------------------------------------------
  // Astro: Horoscope / Tarot / Numerology
  // ------------------------------------------------------------------
  function renderAstro() {
    const host = document.getElementById("astro-content");
    if (state.astroTab === "tarot") return renderTarot(host);
    if (state.astroTab === "numerology") return renderNumerology(host);
    const profile = readAstroProfile();
    host.innerHTML = `<article class="astro-card"><div class="astro-hero"><span class="astro-hero-icon">${moduleIcon("astro")}</span><div><h3>Персональная тема дня</h3><p>Вопрос для размышления формируется на основе данных рождения и не является прогнозом событий.</p></div></div><form class="form-grid" id="astro-profile-form"><label><span>Дата рождения</span><input type="date" name="birth_date" value="${attr(profile.birth_date || "")}"></label><label><span>Время рождения</span><input type="time" name="birth_time" value="${attr(profile.birth_time || "")}"></label><label><span>Место рождения</span><input name="birth_place" value="${attr(profile.birth_place || "")}" placeholder="Город"></label><button class="primary-action" type="submit">Сохранить и получить тему</button></form></article><article class="astro-card"><h3>Тема для рефлексии</h3><p id="daily-astro-theme">${text(profile.birth_date ? dailyAstroTheme() : "Укажите дату рождения, чтобы получить символическую тему дня.")}</p><button class="astro-action" id="astro-save-journal" type="button">Ответить в дневнике</button></article>`;
    host.querySelector("#astro-profile-form").addEventListener("submit", (event) => {
      event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget).entries()); localStorage.setItem("eva.astro.profile.v1", JSON.stringify(value)); host.querySelector("#daily-astro-theme").textContent = dailyAstroTheme(); toast("Профиль астрорефлексии сохранён");
    });
    host.querySelector("#astro-save-journal").addEventListener("click", () => openJournalSheet(dailyAstroTheme()));
  }
  function renderTarot(host) {
    host.innerHTML = `<article class="astro-card"><h3>Карты Таро</h3><p>Используйте карту как метафорический вопрос, а не как достоверное предсказание будущего.</p><div class="tarot-cards">${[1,2,3].map((i) => `<button class="tarot-card" type="button" data-tarot-card="${i}">${controlIcon("star")}</button>`).join("")}</div><p id="tarot-result">Выберите одну карту или откройте расклад из трёх.</p><button class="astro-action" id="tarot-three" type="button">Открыть три карты</button></article>`;
    host.querySelectorAll("[data-tarot-card]").forEach((button) => button.addEventListener("click", () => showTarot(host, 1)));
    host.querySelector("#tarot-three").addEventListener("click", () => showTarot(host, 3));
  }
  function showTarot(host, count) {
    const selected = [...ASTRO_TAROT].sort(() => Math.random() - .5).slice(0, count);
    host.querySelector("#tarot-result").innerHTML = selected.map(([name, meaning]) => `<strong>${text(name)}</strong> — ${text(meaning)}`).join("<br><br>");
    haptic("light");
  }
  function renderNumerology(host) {
    const saved = JSON.parse(localStorage.getItem("eva.numerology.v1") || "{}");
    const number = saved.birth_date ? lifePath(saved.birth_date) : null;
    host.innerHTML = `<article class="astro-card"><div class="numerology-number" id="life-path-number">${number || "?"}</div><h3>Число жизненного пути</h3><p id="life-path-text">${number ? text(numberMeaning(number)) : "Введите дату рождения. Интерпретация используется только как символический повод для размышления."}</p><form class="form-grid" id="numerology-form"><label><span>Дата рождения</span><input type="date" name="birth_date" value="${attr(saved.birth_date || "")}" required></label><button class="primary-action" type="submit">Рассчитать</button></form></article><article class="astro-card"><h3>Дополнительные разделы</h3><p>Персональный год, число имени и нумерологическая совместимость будут доступны в этом разделе.</p></article>`;
    host.querySelector("#numerology-form").addEventListener("submit", (event) => { event.preventDefault(); const birth_date = event.currentTarget.elements.birth_date.value; localStorage.setItem("eva.numerology.v1", JSON.stringify({ birth_date })); const n = lifePath(birth_date); host.querySelector("#life-path-number").textContent = n; host.querySelector("#life-path-text").textContent = numberMeaning(n); });
  }
  function readAstroProfile() { try { return JSON.parse(localStorage.getItem("eva.astro.profile.v1") || "{}"); } catch { return {}; } }
  function dailyAstroTheme() { const themes = ["Где сегодня важно сохранить направление, но проявить гибкость в способе?", "Какой разговор стоит провести яснее и спокойнее?", "Какое небольшое действие вернёт ощущение опоры?", "Что сегодня можно завершить, чтобы освободить внимание?", "Где полезно сначала проверить факты, а уже затем делать вывод?"]; return themes[new Date().getDate() % themes.length]; }
  function lifePath(date) { let digits = date.replace(/\D/g, "").split("").map(Number); let sum = digits.reduce((a,b)=>a+b,0); while (sum > 9 && ![11,22,33].includes(sum)) sum = String(sum).split("").reduce((a,b)=>a+Number(b),0); return sum; }
  function numberMeaning(n) { return ({1:"Инициатива и самостоятельность. Вопрос: где важно начать первым?",2:"Сотрудничество и чувствительность. Вопрос: где нужен диалог?",3:"Выражение и творчество. Вопрос: что стоит сформулировать?",4:"Структура и устойчивость. Вопрос: какую опору создать?",5:"Изменения и свобода. Вопрос: где нужна гибкость?",6:"Забота и ответственность. Вопрос: что важно поддержать?",7:"Исследование и внутренний поиск. Вопрос: что стоит понять глубже?",8:"Управление и результат. Вопрос: какой ресурс использовать точнее?",9:"Завершение и вклад. Вопрос: что пора отпустить или закончить?",11:"Интуитивный ориентир. Вопрос: какую идею стоит проверить фактами?",22:"Большой замысел и практическое воплощение. Вопрос: какой первый артефакт создать?",33:"Поддержка и служение. Вопрос: как помочь без потери собственных границ?"})[n] || "Символическая тема для размышления."; }

  // ------------------------------------------------------------------
  // Journal / focus / Eva
  // ------------------------------------------------------------------
  function openJournalSheet(prefill = "") {
    openSheet({
      title: "Записать", subtitle: "Мысль, событие, наблюдение или следующий шаг",
      html: `<form class="form-grid" id="journal-form"><label><span>Запись</span><textarea name="content" rows="5" maxlength="5000" placeholder="Что важно сохранить?">${text(prefill)}</textarea></label><label><span>Заголовок</span><input name="title" maxlength="200" placeholder="Необязательно"></label><button class="primary-action" type="submit">Сохранить</button></form><div class="sheet-options">${option("voice","voice","Надиктовать в чате","Ева распознает голосовое сообщение")}${option("photo","photo","Добавить фото","Отправить изображение Еве")}</div>`,
      onMount(host) {
        host.querySelector("#journal-form").addEventListener("submit", (event) => void saveJournal(event));
        bindOptions(host, (action) => openEvaSheet(action === "voice" ? "Хочу надиктовать запись в дневник" : "Хочу добавить фото в дневник"));
      },
    });
  }
  async function saveJournal(event) {
    event.preventDefault(); const form = event.currentTarget; const raw = Object.fromEntries(new FormData(form).entries()); if (!raw.content.trim()) return toast("Запись пустая", true);
    const payload = { title: raw.title.trim() || firstLine(raw.content).slice(0, 100), content: raw.content.trim(), category: "Личное" };
    try {
      const result = await api("/public/notes", { method: "POST", body: JSON.stringify(payload) });
      state.notes.unshift(result.note || { id: `local-${Date.now()}`, ...payload });
      closeSheet(); selectAutomaticResult(); toast("Запись сохранена");
    } catch {
      const drafts = JSON.parse(localStorage.getItem("eva.journal.drafts.v2") || "[]"); drafts.unshift({ ...payload, created_at: new Date().toISOString() }); localStorage.setItem("eva.journal.drafts.v2", JSON.stringify(drafts.slice(0,50))); closeSheet(); toast("Черновик сохранён на устройстве");
    }
  }

  function openFocusSheet() {
    if (state.focusTimer) return stopFocus(true);
    openSheet({ title: "Фокус-сессия", subtitle: "Что должно появиться к концу сессии?", html: `<form class="form-grid" id="focus-form"><label><span>Ожидаемый результат</span><input name="result" value="${attr(state.selectedResult?.title || "")}" required></label><div class="sheet-options">${[5,15,25].map((m)=>option(String(m),"hourglass",`${m} минут`,"")).join("")}${option("free","hourglass","Свободный режим","")}</div></form>`, onMount(host) { bindOptions(host, (action) => { const result = host.querySelector('input[name="result"]').value.trim(); if (!result) return toast("Укажите результат", true); closeSheet(); startFocus(action === "free" ? null : Number(action), result); }); } });
  }
  function startFocus(minutes, result) {
    stopFocus(false); const started = Date.now(); const ends = minutes ? started + minutes*60000 : null; const pill = document.createElement("button"); pill.type="button"; pill.className="toast"; pill.style.display="block"; pill.style.background="#fffefa"; pill.style.color="#151311"; pill.style.border="1px solid #d8d5cf"; pill.innerHTML=`<strong id="focus-clock">${minutes?`${String(minutes).padStart(2,"0")}:00`:"00:00"}</strong> · ${text(result)} · Завершить`; document.body.appendChild(pill); const tick=()=>{ const ms=ends?Math.max(0,ends-Date.now()):Date.now()-started; pill.querySelector("#focus-clock").textContent=clock(ms); if(ends&&ms<=0){stopFocus(false);toast("Фокус-сессия завершена");haptic("success");}}; tick(); const timer=setInterval(tick,1000); state.focusTimer={pill,timer}; pill.addEventListener("click",()=>stopFocus(true));
  }
  function stopFocus(show) { if(!state.focusTimer)return; clearInterval(state.focusTimer.timer); state.focusTimer.pill.remove(); state.focusTimer=null; if(show)toast("Фокус-сессия остановлена"); }
  function clock(ms){const sec=Math.floor(ms/1000);return `${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;}

  function openEvaSheet(context = "") {
    openSheet({ title: "Ева рядом", subtitle: context || "Что сделать на текущем экране?", html: `<div class="sheet-options">${option("write","chat","Написать Еве","")}${option("voice","voice","Надиктовать сообщение","")}${option("screen","screen","Обсудить этот экран",screenContext())}${option("note","note","Создать заметку","")}${option("task","check","Создать задачу","")}</div>`, onMount(host){bindOptions(host,(action)=>{ if(action==="note")return openJournalSheet(); if(action==="task")return openTaskSheet(); const prompts={write:"Продолжить разговор с Евой",voice:"Надиктовать голосовое сообщение",screen:screenContext()}; copyAndReturnToChat(prompts[action]||context); });}});
  }
  function screenContext(){ if(state.screen==="today")return `Обсудить результат дня: ${state.selectedResult?.title||"не выбран"}`; return `Обсудить раздел «${screenTitle(state.screen)}»`; }
  async function copyAndReturnToChat(message){ try{await navigator.clipboard?.writeText(message);}catch{} toast("Вернитесь в чат с Евой — формулировка скопирована"); setTimeout(()=>tg?.close?.(),900); }

  // ------------------------------------------------------------------
  // Profile / progress
  // ------------------------------------------------------------------
  async function loadProfile(){ const data=await safeApi("/public/profile",{}, {profile:{}}); state.profile=data.profile||{}; renderProfile(); }
  function renderProfile(){ const host=document.getElementById("profile-content"); const profile=state.profile||{}; const user=profile.user||state.session?.user||{}; host.innerHTML=`<div class="profile-grid"><article class="profile-card"><h3>Личные настройки</h3><form class="form-grid" id="profile-form"><label><span>Как обращаться</span><input name="preferred_name" value="${attr(user.preferred_name||state.firstName||"")}"></label><label><span>Город</span><input name="city" value="${attr(user.city||"")}"></label><label><span>Часовой пояс</span><input name="timezone" value="${attr(user.timezone||"")}"></label><label><span>Стиль общения</span><textarea name="communication_style" rows="3">${text(user.communication_style||"")}</textarea></label><button class="primary-action" type="submit">Сохранить</button></form></article><article class="profile-card"><h3>Память Евы</h3><p class="card-caption">Здесь будет прозрачный список подтверждённых фактов, предпочтений, целей и важных людей.</p><button class="secondary-action" type="button" id="memory-info">Открыть описание</button></article></div>`; host.querySelector("#profile-form").addEventListener("submit",(event)=>void saveProfile(event)); host.querySelector("#memory-info").addEventListener("click",()=>toast("Раздел памяти будет подключён к MemoryProjectionService")); }
  async function saveProfile(event){event.preventDefault();const form=event.currentTarget;const raw=Object.fromEntries(new FormData(form).entries());const fields={};Object.entries(raw).forEach(([k,v])=>{if(String(v).trim())fields[k]=String(v).trim();});try{const data=await api("/public/profile",{method:"PATCH",body:JSON.stringify({fields})});state.profile=data.profile||state.profile;state.firstName=fields.preferred_name||state.firstName;updateGreeting();toast("Профиль сохранён");}catch(error){toast(friendlyError(error),true);}}
  async function loadProgress(){const data=await safeApi("/public/progress",{}, {progress:{}});state.progress=data.progress||{};renderProgress();}
  function renderProgress(){const host=document.getElementById("progress-content");const p=state.progress||{};const results=p.completed_results||[];const blocks=p.work_blocks||[];host.innerHTML=`<div class="stats-grid"><div class="stat-card"><span class="stat-number">${results.length}</span><span class="card-caption">завершённых результатов</span></div><div class="stat-card"><span class="stat-number">${blocks.filter(x=>x.artifact).length}</span><span class="card-caption">созданных артефактов</span></div></div>${results.length?`<div class="content-card">${results.slice(0,12).map(r=>`<div class="timeline-item"><strong>${text(r.title)}</strong><div class="card-caption">${text(r.result_artifact||r.goal_title||"")}</div></div>`).join("")}</div>`:`<div class="empty-state"><strong>Отчёты появятся здесь</strong><span>Ева соберёт результаты и динамику после первых завершённых действий.</span></div>`}`;}

  // ------------------------------------------------------------------
  // Notifications
  // ------------------------------------------------------------------
  function updateNotificationDot(){ const has=!readCheckin().mood || !state.selectedResult?.title || state.tasks.some(t=>t.remind_at&&!['done','completed','canceled'].includes(t.status)&&new Date(t.remind_at)<=new Date(Date.now()+86400000)); document.getElementById("notification-dot").hidden=!has; }
  function openNotificationsSheet(){ const items=[]; if(!readCheckin().mood)items.push(["Состояние не отмечено","Отметить настроение, энергию и фокус"]); if(!state.selectedResult?.title)items.push(["Нет результата дня","Ева может подобрать его по контексту"]); state.tasks.filter(t=>t.remind_at&&!['done','completed','canceled'].includes(t.status)&&new Date(t.remind_at)<=new Date(Date.now()+86400000)).slice(0,3).forEach(t=>items.push([t.title,`Напоминание: ${formatDateTime(t.remind_at)}`])); openSheet({title:"Уведомления",subtitle:items.length?"Что требует внимания":"",html:items.length?`<div class="sheet-options">${items.map(([a,b])=>option("notice","bell",a,b)).join("")}</div>`:`<div class="empty-state"><strong>Всё спокойно</strong><span>Новых уведомлений нет.</span></div>`}); }

  // ------------------------------------------------------------------
  // UI helpers
  // ------------------------------------------------------------------
  function openSheet({title,subtitle="",html,onMount}){const sheet=document.getElementById("sheet");document.getElementById("sheet-title").textContent=title;const sub=document.getElementById("sheet-subtitle");sub.textContent=subtitle;sub.hidden=!subtitle;const host=document.getElementById("sheet-content");host.innerHTML=html;if(!sheet.open)sheet.showModal();onMount?.(host);}
  function closeSheet(){const sheet=document.getElementById("sheet");if(sheet.open)sheet.close();}
  function option(action,iconName,title,note){return `<button class="sheet-option" type="button" data-option="${attr(action)}"><span class="option-icon">${icon(iconName)}</span><span><strong>${text(title)}</strong>${note?`<small>${text(note)}</small>`:""}</span></button>`;}
  function bindOptions(host,handler){host.querySelectorAll("[data-option]").forEach(b=>b.addEventListener("click",()=>handler(b.dataset.option,b)));}
  let toastTimer;
  function toast(message,isError=false){clearTimeout(toastTimer);const node=document.getElementById("toast");node.textContent=message;node.classList.toggle("is-error",isError);node.hidden=false;toastTimer=setTimeout(()=>{node.hidden=true;},3600);}
  function friendlyError(error){console.warn(error);const msg=String(error?.message||"");if(msg.includes("Body cannot be empty"))return "Не удалось отправить запрос. Обновите страницу — исправление уже включено в эти файлы.";if(msg.includes("Telegram"))return "Откройте WebApp из Telegram.";return "Не удалось сохранить. Проверьте соединение и повторите.";}
  function haptic(type){if(type==="success")tg?.HapticFeedback?.notificationOccurred?.("success");else tg?.HapticFeedback?.impactOccurred?.(type||"light");}
  function screenTitle(screen){return ({today:"Сегодня",goals:"Развитие",organizer:"Органайзер",pult:"Пульт",profile:"Профиль",progress:"Отчёты",astro:"Астрорефлексия",module:document.getElementById("module-title")?.textContent||"Модуль"})[screen]||"Экран";}
  function goalStatus(status){return ({active:"Активна",paused:"Пауза",completed:"Готово",draft:"Черновик"})[status]||"Цель";}
  function firstLine(value){return String(value||"").split(/\n/)[0].trim();}
  function isToday(value){if(!value)return false;const d=new Date(value),n=new Date();return d.getFullYear()===n.getFullYear()&&d.getMonth()===n.getMonth()&&d.getDate()===n.getDate();}
  function formatDate(value){const d=new Date(value);return Number.isNaN(d.getTime())?"":d.toLocaleDateString("ru-RU",{day:"numeric",month:"short",year:d.getFullYear()!==new Date().getFullYear()?"numeric":undefined});}
  function formatDateTime(value){const d=new Date(value);return Number.isNaN(d.getTime())?"":d.toLocaleString("ru-RU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});}
  function toLocalInput(value){if(!value)return "";const d=new Date(value);if(Number.isNaN(d.getTime()))return "";const off=d.getTimezoneOffset()*60000;return new Date(d-off).toISOString().slice(0,16);}
  function fromLocalInput(value){return value?new Date(value).toISOString():null;}
  function text(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}
  function attr(value){return text(value).replace(/`/g,"&#96;");}

  // ------------------------------------------------------------------
  // SVG icons
  // ------------------------------------------------------------------
  function moduleIcon(code){
    const icons={
      journal:'<svg viewBox="0 0 64 64"><path d="M8 14c11-4 19-2 24 4v36c-7-5-15-7-24-3Z"/><path d="M56 14c-11-4-19-2-24 4v36c7-5 15-7 24-3Z"/><path d="M14 24h12M14 31h12M38 24h12M38 31h12"/><path class="accent-fill" d="m44 48 10-17 6 4-11 17-7 2Z"/></svg>',
      state:'<svg viewBox="0 0 64 64"><path class="accent-fill" d="M32 55 9 34C-3 20 16 6 27 19l5 6 5-6c11-13 30 1 18 15Z"/><circle cx="25" cy="31" r="2" class="solid"/><circle cx="39" cy="31" r="2" class="solid"/><path d="M24 39c5 4 11 4 16 0"/></svg>',
      compatibility:'<svg viewBox="0 0 64 64"><path fill="#f6b37f" d="M25 54 7 38C-3 27 13 13 22 24l3 4 3-4c9-11 25 3 15 14Z"/><path class="accent-fill" d="M44 54 28 40c-9-10 5-23 13-14l3 4 3-4c8-9 22 4 13 14Z"/><circle cx="19" cy="34" r="1.5" class="solid"/><circle cx="30" cy="34" r="1.5" class="solid"/><path d="M18 40c4 3 8 3 11 0"/><circle cx="40" cy="38" r="1.5" class="solid"/><circle cx="50" cy="38" r="1.5" class="solid"/><path d="M39 44c4 3 8 3 11 0"/></svg>',
      budget:'<svg viewBox="0 0 64 64"><path class="accent-fill" d="M9 20h42c5 0 8 3 8 8v25H9c-5 0-7-3-7-8V28c0-5 2-8 7-8Z"/><path d="m11 20 30-11c5-2 9 1 10 7M44 32h18v13H44c-4 0-7-3-7-6s3-7 7-7Z"/><circle cx="47" cy="39" r="2" class="solid"/></svg>',
      practices:'<svg viewBox="0 0 64 64"><path d="M32 57C29 41 18 31 4 32c4 14 14 23 28 25Zm0 0c3-16 14-26 28-25-4 14-14 23-28 25Zm0-1C18 46 15 30 23 17c11 9 14 24 9 39Zm0 0c14-10 17-26 9-39-11 9-14 24-9 39Z"/></svg>',
      tests:'<svg viewBox="0 0 64 64"><rect x="13" y="12" width="38" height="46" rx="4"/><path d="M25 12V7h14v5M21 27l4 4 7-8M21 40l4 4 7-8M37 28h8M37 41h8"/><circle cx="23" cy="27" r="6" class="accent-fill" opacity=".25"/><circle cx="23" cy="40" r="6" class="accent-fill" opacity=".25"/></svg>',
      reports:'<svg viewBox="0 0 64 64"><path d="M7 55h50"/><rect x="11" y="37" width="9" height="18"/><rect x="25" y="25" width="9" height="30" class="accent-fill"/><rect x="39" y="13" width="9" height="42" class="accent-fill"/><path d="M47 37a14 14 0 1 0 10 23l-10-9Z"/><path class="accent-fill" d="M50 35v13h13c0-7-6-13-13-13Z"/></svg>',
      goals:'<svg viewBox="0 0 64 64"><circle cx="29" cy="35" r="23"/><circle cx="29" cy="35" r="14"/><circle cx="29" cy="35" r="5" fill="#ffb98a"/><path d="m33 31 20-20M45 11h9v9"/></svg>',
      life:'<svg viewBox="0 0 64 64"><path d="m5 18 16-7 21 7 17-7v39l-17 7-21-7-16 7Z"/><path d="M21 11v39M42 18v39"/><path class="accent-fill" d="M42 6c-8 0-14 6-14 14 0 11 14 23 14 23s14-12 14-23c0-8-6-14-14-14Z"/><circle cx="42" cy="20" r="5" class="paper-fill"/></svg>',
      programs:'<svg viewBox="0 0 64 64"><path d="M7 51c12 3 11-17 23-13s8 14 25 9"/><path d="M39 37V12h16l-5 7 5 7H39"/><path class="accent-fill" d="M39 12h16l-5 7 5 7H39Z"/></svg>',
      habits:'<svg viewBox="0 0 64 64"><rect x="7" y="13" width="50" height="44" rx="5"/><path d="M18 7v12M46 7v12M7 24h50M17 35l5 5 8-10M34 35l5 5 8-10M17 49l5 5 8-10"/><path class="accent-fill" d="m17 35 5 5 8-10M34 35l5 5 8-10M17 49l5 5 8-10"/></svg>',
      focus:'<svg viewBox="0 0 64 64"><path d="M19 5h26M19 59h26M22 7c0 13 5 18 10 25-5 7-10 12-10 25M42 7c0 13-5 18-10 25 5 7 10 12 10 25"/><path class="accent-fill" d="M25 15h14c-1 8-4 12-7 17-4-5-7-9-7-17Zm2 34c2-5 3-9 5-13 2 4 3 8 5 13Z"/></svg>',
      decisions:'<svg viewBox="0 0 64 64"><path d="M32 58V7M15 17h36l7 8-7 8H15L7 25Zm15 22H8l-6 7 6 7h22"/><path class="accent-fill" d="M15 17h36l7 8-7 8H15L7 25Z"/></svg>',
      astro:'<svg viewBox="0 0 64 64"><circle cx="32" cy="35" r="17" class="accent-fill"/><path d="M4 38c10 8 33 12 50 4 9-4 8-10 1-13M14 13l2 5 5 2-5 2-2 5-2-5-5-2 5-2Zm39 1 1 4 4 1-4 1-1 4-1-4-4-1 4-1Z"/></svg>',
    }; return icons[code]||'<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="24"/><path d="M20 32h24M32 20v24"/></svg>';
  }
  function icon(code){const m={check:'<svg viewBox="0 0 32 32"><path d="m7 17 6 6L26 9"/></svg>',edit:'<svg viewBox="0 0 32 32"><path d="m6 25 2-7L22 4l6 6-14 14Z"/></svg>',refresh:'<svg viewBox="0 0 32 32"><path d="M26 11V5l-4 4a11 11 0 1 0 3 12"/></svg>',chat:'<svg viewBox="0 0 32 32"><path d="M5 6h22v16H13l-7 5v-5H5Z"/><path d="M10 12h12M10 17h8"/></svg>',note:'<svg viewBox="0 0 32 32"><path d="M7 4h18v24H7Z"/><path d="M11 10h10M11 15h10M11 20h7"/></svg>',voice:'<svg viewBox="0 0 32 32"><rect x="11" y="4" width="10" height="16" rx="5"/><path d="M7 15c0 6 4 9 9 9s9-3 9-9M16 24v5"/></svg>',photo:'<svg viewBox="0 0 32 32"><rect x="4" y="6" width="24" height="20" rx="3"/><circle cx="12" cy="13" r="3"/><path d="m6 23 7-7 5 5 3-3 5 5"/></svg>',screen:'<svg viewBox="0 0 32 32"><rect x="4" y="5" width="24" height="18" rx="2"/><path d="M12 28h8M16 23v5"/></svg>',bell:controlIcon('bell'),hourglass:moduleIcon('focus'),sliders:controlIcon('palette')};return m[code]||moduleIcon('goals');}
  function controlIcon(code){const icons={memory:'<svg viewBox="0 0 48 48"><path d="M15 10c-7 1-9 8-5 13-5 5-1 14 6 13 2 6 10 6 12 1V12c-2-6-11-7-13-2Zm18 0c7 1 9 8 5 13 5 5 1 14-6 13-2 6-10 6-12 1V12c2-6 11-7 13-2Z"/><path d="M18 17c3 0 5 2 5 5M30 17c-3 0-5 2-5 5M17 30c3 0 5-2 5-5M31 30c-3 0-5-2-5-5"/></svg>',bell:'<svg viewBox="0 0 48 48"><path d="M12 34c3-3 5-8 5-14a7 7 0 0 1 14 0c0 6 2 11 5 14Z"/><path d="M20 39a5 5 0 0 0 8 0M24 13V8"/></svg>',voice:'<svg viewBox="0 0 48 48"><rect x="17" y="6" width="14" height="24" rx="7"/><path d="M11 23c0 9 6 14 13 14s13-5 13-14M24 37v6"/></svg>',link:'<svg viewBox="0 0 48 48"><path d="M20 29 14 35a8 8 0 0 1-11-11l8-8a8 8 0 0 1 11 0M28 19l6-6a8 8 0 0 1 11 11l-8 8a8 8 0 0 1-11 0M16 32l16-16"/></svg>',card:'<svg viewBox="0 0 48 48"><rect x="5" y="10" width="38" height="28" rx="5"/><path d="M5 19h38M11 31h10"/></svg>',shield:'<svg viewBox="0 0 48 48"><path d="M24 4 40 10v12c0 11-7 18-16 22C15 40 8 33 8 22V10Z"/><path d="m17 24 5 5 10-12"/></svg>',palette:'<svg viewBox="0 0 48 48"><path d="M24 5a19 19 0 1 0 0 38h4c4 0 5-5 2-7-2-2 0-6 4-6h4c4 0 5-3 5-7C43 13 35 5 24 5Z"/><circle cx="15" cy="18" r="2" class="accent-fill"/><circle cx="24" cy="13" r="2"/><circle cx="34" cy="18" r="2"/></svg>',pulse:'<svg viewBox="0 0 48 48"><path d="M4 25h9l4-12 8 25 6-18 4 5h9"/></svg>',star:'<svg viewBox="0 0 48 48"><path class="accent-fill" d="m24 5 5 11 12 2-9 8 3 12-11-6-11 6 3-12-9-8 12-2Z"/></svg>'};return icons[code]||icons.pulse;}

  // ------------------------------------------------------------------
  // Demo
  // ------------------------------------------------------------------
  async function demoApi(path,options={}){await new Promise(r=>setTimeout(r,60));if(path==="/public/session")return{user:{preferred_name:"Вик",first_name:"Вик",city:"Пермь",timezone:"Asia/Yekaterinburg"}};if(path==="/public/today")return{today:{main_action:"Закончить план проекта",work_block_id:"demo",work_block_status:"planned"}};if(path==="/public/goals"&&(!options.method||options.method==="GET"))return{goals:[{id:"g1",title:"Запустить новую версию Евы",status:"active",progress_percent:42,next_result:"Завершить главный экран WebApp",next_step:"Проверить интерфейс на телефоне",target_date:"2026-09-01"}]};if(path==="/public/tasks"&&(!options.method||options.method==="GET"))return{tasks:[{id:"t1",title:"Проверить главный экран на телефоне",status:"open",due_at:new Date(Date.now()+7200000).toISOString(),remind_at:new Date(Date.now()+3600000).toISOString(),priority:"high"},{id:"t2",title:"Подготовить описание модулей",status:"open",due_at:new Date(Date.now()+86400000).toISOString(),priority:"normal"},{id:"t3",title:"Проверить старые ссылки",status:"done",priority:"low"}]};if(path==="/public/notes")return{notes:[{id:"n1",title:"Идеи по WebApp",content:"Сделать интерфейс легче и понятнее"}]};if(path==="/public/profile")return{profile:{user:{preferred_name:"Вик",city:"Пермь",timezone:"Asia/Yekaterinburg"}}};if(path==="/public/progress")return{progress:{completed_results:[{title:"Создана структура WebApp",result_artifact:"Рабочий прототип"}],work_blocks:[]}};if(path==="/public/goals"&&options.method==="POST")return{goal:{id:`g${Date.now()}`,status:"active",progress_percent:0,...JSON.parse(options.body)}};if(path==="/public/tasks"&&options.method==="POST")return{task:{id:`t${Date.now()}`,status:"open",...JSON.parse(options.body)}};return{};}
})();
