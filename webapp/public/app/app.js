/* Eva Mini App — compact single-screen doodle dashboard. */
(() => {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  const demoMode = new URLSearchParams(window.location.search).get("demo") === "1";
  const state = {
    screen: "today",
    loaded: new Set(),
    session: null,
    today: null,
    goals: [],
    profile: null,
    progress: null,
    profileTimer: null,
    firstName: "",
  };

  const titles = {
    today: "Сегодня",
    goals: "Развитие",
    organizer: "Органайзер",
    pult: "Пульт",
    progress: "Отчёты",
    profile: "Профиль",
  };

  const subtitles = {
    goals: "Цели и движение к важному",
    organizer: "Заметки, задачи и связи",
    pult: "Все возможности Evaself",
    progress: "Результаты и динамика",
    profile: "Настройки и контекст Евы",
  };

  const modules = [
    { code: "journal", title: "Дневник", note: "Жизнь и мысли" },
    { code: "state", title: "Состояние", note: "Настроение и энергия", checkin: true },
    { code: "compatibility", title: "Совместимость", note: "Люди и общение" },
    { code: "budget", title: "Бюджет", note: "Доходы и расходы" },
    { code: "practices", title: "Практики", note: "Перезагрузка" },
    { code: "tests", title: "Тесты", note: "Понять себя" },
    { code: "reports", title: "Отчёты", note: "Итоги и динамика", screen: "progress" },
    { code: "goals", title: "Цели", note: "Направление и шаги", screen: "goals" },
    { code: "life", title: "Карта жизни", note: "Важные сферы" },
    { code: "programs", title: "Программы", note: "7, 14 и 30 дней" },
    { code: "habits", title: "Привычки", note: "Поддерживающие ритмы" },
    { code: "focus", title: "Фокус", note: "5, 15 или 25 минут", action: "focus" },
    { code: "decisions", title: "Решения", note: "Факты и варианты" },
    { code: "astro", title: "Астрорефлексия", note: "Символический взгляд" },
  ];

  if (tg) {
    tg.ready();
    tg.expand();
    tg.enableClosingConfirmation?.();
    tg.setHeaderColor?.("#fffdf9");
    tg.setBackgroundColor?.("#fffdf9");
    tg.setBottomBarColor?.("#ffffff");
  }

  renderModules();
  bindStaticEvents();
  restoreCheckin();
  void bootstrap();

  function bindStaticEvents() {
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.addEventListener("click", () => void openScreen(button.dataset.target));
    });

    document.getElementById("add-goal")?.addEventListener("click", showGoalForm);
    document.getElementById("close-goal-form")?.addEventListener("click", hideGoalForm);
    document.getElementById("goal-form")?.addEventListener("submit", createGoal);
    document.getElementById("edit-result")?.addEventListener("click", () => void openScreen("goals"));
    document.getElementById("notifications-button")?.addEventListener("click", () => showNotice("Новых уведомлений пока нет."));

    document.querySelectorAll("[data-checkin]").forEach((button) => button.addEventListener("click", openCheckin));
    document.querySelectorAll("[data-quick]").forEach((button) => {
      button.addEventListener("click", () => handleQuickAction(button.dataset.quick));
    });

    document.getElementById("eva-fab")?.addEventListener("click", toggleEvaPanel);
    document.getElementById("eva-panel-close")?.addEventListener("click", closeEvaPanel);
    document.querySelectorAll("[data-eva-action]").forEach((button) => {
      button.addEventListener("click", () => {
        closeEvaPanel();
        showNotice(evaActionMessage(button.dataset.evaAction));
      });
    });

    const checkinForm = document.getElementById("checkin-form");
    checkinForm?.addEventListener("input", updateRangeLabels);
    checkinForm?.addEventListener("submit", saveCheckin);

    tg?.BackButton?.onClick(() => void openScreen("today"));
  }

  async function api(path, options = {}) {
    if (demoMode) return demoApi(path, options);
    const initData = tg && tg.initData;
    if (!initData) throw new Error("Откройте приложение из Telegram, чтобы загрузить свои данные.");

    const response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Init-Data": initData,
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || "Не удалось выполнить действие");
    return body;
  }

  async function bootstrap() {
    updateGreeting();
    try {
      state.session = await api("/public/session", { method: "POST" });
      state.firstName = state.session.user?.preferred_name || state.session.user?.first_name || tg?.initDataUnsafe?.user?.first_name || "";
      updateGreeting();
      await loadToday();
    } catch (error) {
      state.firstName = tg?.initDataUnsafe?.user?.first_name || "";
      updateGreeting();
      document.getElementById("main-result").textContent = "Выбрать главный результат дня";
      showNotice(error.message, true, false);
    }
  }

  function updateGreeting() {
    if (state.screen !== "today") return;
    const hour = new Date().getHours();
    const greeting = hour < 5 ? "Доброй ночи" : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
    document.getElementById("screen-title").textContent = state.firstName ? `${greeting}, ${state.firstName}` : greeting;
    document.getElementById("header-kicker").textContent = "Как ты себя чувствуешь сегодня?";
  }

  async function openScreen(screen) {
    if (!titles[screen]) return;
    closeEvaPanel();
    state.screen = screen;
    document.body.classList.toggle("is-today", screen === "today");

    document.querySelectorAll(".screen").forEach((node) => {
      const active = node.dataset.screen === screen;
      node.hidden = !active;
      node.classList.toggle("is-active", active);
    });
    document.querySelectorAll(".nav-item").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.target === screen);
    });

    if (screen === "today") {
      updateGreeting();
      tg?.BackButton?.hide?.();
    } else {
      document.getElementById("screen-title").textContent = titles[screen];
      document.getElementById("header-kicker").textContent = subtitles[screen] || "Ева рядом";
      tg?.BackButton?.show?.();
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
    if (!state.loaded.has(screen)) {
      const loaders = { goals: loadGoals, progress: loadProgress, profile: loadProfile };
      try {
        await loaders[screen]?.();
      } catch (error) {
        showNotice(error.message, true);
        renderUnavailable(screen);
      }
    }
  }

  async function loadToday() {
    const { today } = await api("/public/today");
    state.today = today || {};
    state.loaded.add("today");
    document.getElementById("main-result").textContent = today?.main_action || "Выбрать главный результат дня";
  }

  function renderModules() {
    const host = document.getElementById("modules-grid");
    const pult = document.getElementById("pult-grid");
    host.innerHTML = modules.map(moduleTile).join("") + '<div class="module-tile module-spacer" aria-hidden="true"></div><div class="module-tile module-spacer" aria-hidden="true"></div>';
    pult.innerHTML = modules.map((item) => `
      <button class="pult-card" type="button" data-module="${escapeAttribute(item.code)}">
        <span class="module-icon">${moduleIcon(item.code)}</span>
        <span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.note)}</p></span>
      </button>`).join("");

    document.querySelectorAll("[data-module]").forEach((button) => {
      button.addEventListener("click", () => handleModule(button.dataset.module));
    });
  }

  function moduleTile(item) {
    return `<button class="module-tile" type="button" data-module="${escapeAttribute(item.code)}" aria-label="${escapeAttribute(item.title)}">
      <span class="module-title">${escapeHtml(item.title)}</span>
      <span class="module-icon">${moduleIcon(item.code)}</span>
    </button>`;
  }

  function handleModule(code) {
    const item = modules.find((module) => module.code === code);
    if (!item) return;
    if (item.screen) return void openScreen(item.screen);
    if (item.checkin) return openCheckin();
    if (item.action === "focus") return handleQuickAction("focus");
    showNotice(`${item.title}: интерфейс подготовлен, backend будет подключён следующим этапом.`);
  }

  function handleQuickAction(action) {
    if (action === "eva") return toggleEvaPanel();
    if (action === "focus") {
      if (state.today?.work_block_id) return void changeWorkBlock({ disabled: false });
      return showNotice("Сначала добавьте главный результат дня в разделе «Развитие».");
    }
    if (action === "journal") return showNotice("Дневник: быстрый ввод будет подключён вместе с модулем.");
    showNotice("Практики: раздел будет подключён следующим этапом.");
  }

  function toggleEvaPanel() {
    const panel = document.getElementById("eva-panel");
    const button = document.getElementById("eva-fab");
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    tg?.HapticFeedback?.impactOccurred?.("light");
  }

  function closeEvaPanel() {
    document.getElementById("eva-panel").hidden = true;
    document.getElementById("eva-fab").setAttribute("aria-expanded", "false");
  }

  function evaActionMessage(action) {
    return {
      write: "Диалог с Евой будет подключён через существующий агентный API.",
      voice: "Голосовой ввод будет подключён через существующий ASR.",
      screen: "Ева получит контекст текущего экрана после подключения context API.",
      note: "Создание заметки будет подключено к Органайзеру.",
      task: "Создание задачи будет подключено к Органайзеру.",
    }[action] || "Функция будет подключена следующим этапом.";
  }

  function openCheckin() {
    const dialog = document.getElementById("checkin-dialog");
    const data = readCheckin();
    const form = document.getElementById("checkin-form");
    if (data.mood) {
      const mood = form.querySelector(`input[name="mood"][value="${cssEscape(data.mood)}"]`);
      if (mood) mood.checked = true;
    }
    form.elements.energy.value = data.energy || 5;
    form.elements.focus.value = data.focus || 5;
    updateRangeLabels();
    dialog.showModal?.();
  }

  function updateRangeLabels() {
    const form = document.getElementById("checkin-form");
    document.getElementById("energy-output").textContent = form.elements.energy.value;
    document.getElementById("focus-output").textContent = form.elements.focus.value;
  }

  function saveCheckin(event) {
    event.preventDefault();
    const submitter = event.submitter;
    if (submitter?.value === "cancel") {
      document.getElementById("checkin-dialog").close();
      return;
    }
    const form = event.currentTarget;
    const mood = form.querySelector('input[name="mood"]:checked')?.value || readCheckin().mood || "Спокойное";
    const data = { mood, energy: Number(form.elements.energy.value), focus: Number(form.elements.focus.value), savedAt: new Date().toISOString() };
    localStorage.setItem("eva.checkin.v1", JSON.stringify(data));
    renderCheckin(data);
    document.getElementById("checkin-dialog").close();
    showNotice("Состояние отмечено на этом устройстве.");
    tg?.HapticFeedback?.notificationOccurred?.("success");
  }

  function restoreCheckin() { renderCheckin(readCheckin()); }
  function readCheckin() {
    try { return JSON.parse(localStorage.getItem("eva.checkin.v1") || "{}"); } catch { return {}; }
  }
  function renderCheckin(data) {
    document.getElementById("mood-value").textContent = data.mood || "Отметить";
    document.getElementById("energy-value").textContent = data.energy ? `${data.energy} / 10` : "— / 10";
    document.getElementById("focus-value").textContent = data.focus ? `${data.focus} / 10` : "— / 10";
  }

  async function loadGoals() {
    const { goals } = await api("/public/goals");
    state.goals = goals || [];
    state.loaded.add("goals");
    renderGoals();
  }

  function renderGoals() {
    const host = document.getElementById("goals-content");
    host.classList.remove("loading-placeholder");
    if (!state.goals.length) {
      host.innerHTML = '<div class="empty-state"><strong>Целей пока нет</strong><span class="empty-copy">Добавьте одну цель, которую хочется приблизить.</span></div>';
      return;
    }
    host.innerHTML = state.goals.map((goal) => {
      const progress = Math.max(0, Math.min(100, Number(goal.progress_percent || 0)));
      return `<article class="goal-card" data-goal-id="${escapeAttribute(goal.id)}">
        <div class="goal-topline"><div><h3>${escapeHtml(goal.title)}</h3><p class="card-caption">${goal.target_date ? `до ${formatDate(goal.target_date)}` : "без жёсткого срока"}</p></div><span class="status-chip">${goalStatus(goal.status)}</span></div>
        <div><div class="goal-topline card-caption"><span>Прогресс</span><span>${progress}%</span></div><div class="progress-track"><span style="width:${progress}%"></span></div></div>
        ${goal.next_result ? `<div><p class="app-kicker">Ближайший результат</p><strong>${escapeHtml(goal.next_result)}</strong>${goal.next_step ? `<p class="card-caption">Следом: ${escapeHtml(goal.next_step)}</p>` : ""}</div>` : ""}
        <details class="goal-details"><summary>Подробнее</summary><p>${escapeHtml(goal.why_it_matters || "Смысл цели пока не уточнён.")}</p>${goal.status === "active" ? `<button type="button" class="secondary-action pause-goal" data-id="${escapeAttribute(goal.id)}">Поставить на паузу</button>` : ""}</details>
      </article>`;
    }).join("");
    host.querySelectorAll(".pause-goal").forEach((button) => button.addEventListener("click", () => void pauseGoal(button)));
  }

  function showGoalForm() {
    document.getElementById("goal-form").hidden = false;
    document.getElementById("goals-content").hidden = true;
    document.getElementById("add-goal").hidden = true;
    document.querySelector('#goal-form input[name="title"]')?.focus();
  }
  function hideGoalForm() {
    document.getElementById("goal-form").hidden = true;
    document.getElementById("goals-content").hidden = false;
    document.getElementById("add-goal").hidden = false;
  }

  async function createGoal(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const payload = Object.fromEntries(new FormData(form).entries());
    submit.disabled = true;
    try {
      const { goal } = await api("/public/goals", { method: "POST", body: JSON.stringify(payload) });
      state.goals.unshift({ ...goal, progress_percent: 0 });
      state.loaded.delete("today");
      renderGoals();
      form.reset();
      hideGoalForm();
      showNotice("Цель добавлена.");
      tg?.HapticFeedback?.notificationOccurred?.("success");
    } catch (error) { showNotice(error.message, true); }
    finally { submit.disabled = false; }
  }

  async function pauseGoal(button) {
    const id = button.dataset.id;
    const goal = state.goals.find((item) => String(item.id) === id);
    if (!goal) return;
    goal.status = "paused";
    renderGoals();
    try {
      await api(`/public/goals/${id}`, { method: "PATCH", body: JSON.stringify({ status: "paused" }) });
      state.loaded.delete("today");
      showNotice("Цель поставлена на паузу.");
    } catch (error) {
      goal.status = "active";
      renderGoals();
      showNotice(error.message, true);
    }
  }

  async function changeWorkBlock(button) {
    if (!state.today?.work_block_id) return showNotice("Фокус-сессия будет доступна после создания рабочего блока.");
    const isActive = state.today.work_block_status === "active";
    const operation = isActive ? "complete" : "start";
    button.disabled = true;
    try {
      await api(`/public/work-blocks/${state.today.work_block_id}/${operation}`, { method: "POST", body: JSON.stringify({}) });
      state.today.work_block_status = isActive ? "completed" : "active";
      showNotice(isActive ? "Готово — прогресс сохранён." : "Фокус начат.");
      tg?.HapticFeedback?.notificationOccurred?.("success");
    } catch (error) { showNotice(error.message, true); }
    finally { button.disabled = false; }
  }

  async function loadProgress() {
    const { progress } = await api("/public/progress");
    state.progress = progress || {};
    state.loaded.add("progress");
    renderProgress(state.progress);
  }

  function renderProgress(progress) {
    const results = progress.completed_results || [];
    const blocks = progress.work_blocks || [];
    const artifacts = blocks.filter((item) => item.artifact);
    const strategies = progress.strategies || [];
    const timeline = [
      ...results.map((item) => ({ title: item.title, text: item.result_artifact || `Цель: ${item.goal_title}`, date: item.completed_at })),
      ...blocks.map((item) => ({ title: item.actual_result || item.intention, text: item.artifact || item.helpful_factor || item.goal_title, date: item.completed_at })),
    ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 20);
    const host = document.getElementById("progress-content");
    host.classList.remove("loading-placeholder");
    host.innerHTML = `<div class="stats-grid"><div class="stat-card"><span class="stat-number">${results.length}</span><span class="card-caption">результатов завершено</span></div><div class="stat-card"><span class="stat-number">${artifacts.length}</span><span class="card-caption">артефактов создано</span></div></div>
      ${renderGoalProgress(progress.goals || [])}
      <section><div class="section-heading"><div><p class="app-kicker">История движения</p><h2>Последние шаги</h2></div></div>${timeline.length ? `<div class="content-card timeline">${timeline.map((item) => `<div class="timeline-item"><h3>${escapeHtml(item.title)}</h3><p class="card-caption">${escapeHtml(item.text || "")}${item.date ? ` · ${formatDate(item.date)}` : ""}</p></div>`).join("")}</div>` : emptyProgress()}</section>
      ${strategies.length ? `<section><div class="section-heading"><div><p class="app-kicker">То, что помогает</p><h2>Работающие стратегии</h2></div></div><div class="content-card">${strategies.map((item) => `<div class="task-row"><span class="task-index">✓</span><span><strong>${escapeHtml(item.title)}</strong><br><span class="card-caption">${escapeHtml(item.description)}</span></span><span></span></div>`).join("")}</div></section>` : ""}`;
  }

  function renderGoalProgress(goals) {
    if (!goals.length) return "";
    return `<section><div class="section-heading"><div><p class="app-kicker">Общая картина</p><h2>Цели</h2></div></div><div class="content-card">${goals.map((goal) => { const value = Math.max(0, Math.min(100, Number(goal.progress_percent || 0))); return `<div class="task-row"><span class="task-index">${value}</span><span><span class="task-title">${escapeHtml(goal.title)}</span><div class="progress-track"><span style="width:${value}%"></span></div></span><span class="task-date">%</span></div>`; }).join("")}</div></section>`;
  }
  function emptyProgress() { return '<div class="empty-state"><strong>Прогресс появится здесь</strong><span class="empty-copy">Начните первый рабочий блок — Ева сохранит результат.</span></div>'; }

  async function loadProfile() {
    const { profile } = await api("/public/profile");
    state.profile = profile || {};
    state.loaded.add("profile");
    renderProfile(state.profile);
  }

  function renderProfile(profile) {
    const user = profile.user || {};
    const interests = profileValue(profile, "interests") || user.interests || [];
    const style = profileValue(profile, "communication_style") || user.communication_style || "";
    const summary = profileValue(profile, "important_life_areas") || [];
    const host = document.getElementById("profile-content");
    host.classList.remove("loading-placeholder");
    host.innerHTML = `<div class="profile-score"><div class="score-row"><div><p class="app-kicker">Профиль заполнен</p><strong>Ева лучше понимает контекст</strong></div><span class="score-number">${Math.round(Number(profile.completeness || 0) * 100)}%</span></div><div class="progress-track"><span style="width:${Math.round(Number(profile.completeness || 0) * 100)}%"></span></div></div>
      ${renderCandidates(profile.candidates || [])}
      <form class="profile-form" id="profile-form">
        <label><span>Как к вам обращаться</span><input name="preferred_name" maxlength="120" value="${escapeAttribute(user.preferred_name || "")}" placeholder="Ваше имя"></label>
        <label><span>Город</span><input name="city" maxlength="200" value="${escapeAttribute(user.city || "")}" placeholder="Например, Екатеринбург"></label>
        <label><span>Часовой пояс</span><input name="timezone" maxlength="100" value="${escapeAttribute(user.timezone || "")}" placeholder="Asia/Yekaterinburg"><small class="field-help">Можно указать город или точный часовой пояс.</small></label>
        <label><span>Язык</span><select name="preferred_language"><option value="" ${!user.preferred_language ? "selected" : ""}>Автоматически</option><option value="ru" ${user.preferred_language === "ru" ? "selected" : ""}>Русский</option><option value="en" ${user.preferred_language === "en" ? "selected" : ""}>English</option></select></label>
        <label><span>Интересы</span><input name="interests" value="${escapeAttribute(asList(interests).join(", "))}" placeholder="Технологии, спорт, книги"></label>
        <label><span>Предпочтительный стиль общения</span><input name="communication_style" maxlength="500" value="${escapeAttribute(style)}" placeholder="Например, кратко и по делу"></label>
        <label><span>Что сейчас особенно важно</span><textarea name="important_life_areas" rows="3" placeholder="Работа, отношения, здоровье…">${escapeHtml(asList(summary).join(", "))}</textarea></label>
        <div class="autosave-state" id="autosave-state">Изменения сохраняются автоматически</div><button class="primary-action" type="submit">Сохранить профиль</button>
      </form>`;
    const form = document.getElementById("profile-form");
    form.addEventListener("input", scheduleProfileSave);
    form.addEventListener("change", scheduleProfileSave);
    form.addEventListener("submit", (event) => { event.preventDefault(); void saveProfile(true); });
    document.querySelectorAll(".candidate-action").forEach((button) => button.addEventListener("click", () => void decideCandidate(button)));
  }

  function renderCandidates(candidates) {
    if (!candidates.length) return "";
    return `<section><div class="section-heading"><div><p class="app-kicker">Нужна ваша проверка</p><h2>Сведения для подтверждения</h2></div></div>${candidates.map((field) => `<div class="candidate-card" data-field="${escapeAttribute(field.field_key)}"><strong>${escapeHtml(profileLabel(field.field_key))}</strong><p class="card-caption">${escapeHtml(displayValue(field.value))}</p><div class="candidate-actions"><button class="text-action candidate-action" type="button" data-action="confirm" data-field="${escapeAttribute(field.field_key)}">Подтвердить</button><button class="text-action candidate-action" type="button" data-action="decline" data-field="${escapeAttribute(field.field_key)}">Не сохранять</button></div></div>`).join("")}</section>`;
  }

  function scheduleProfileSave() {
    clearTimeout(state.profileTimer);
    document.getElementById("autosave-state").textContent = "Есть несохранённые изменения…";
    state.profileTimer = setTimeout(() => void saveProfile(false), 800);
  }

  async function saveProfile(showSuccess) {
    clearTimeout(state.profileTimer);
    const form = document.getElementById("profile-form");
    if (!form) return;
    const data = Object.fromEntries(new FormData(form).entries());
    const fields = {};
    for (const key of ["preferred_name", "city", "timezone", "communication_style"]) if (String(data[key] || "").trim()) fields[key] = String(data[key]).trim();
    for (const key of ["interests", "important_life_areas"]) { const values = String(data[key] || "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean); if (values.length) fields[key] = values; }
    const status = document.getElementById("autosave-state");
    status.textContent = "Сохраняю…";
    try {
      const { profile } = await api("/public/profile", { method: "PATCH", body: JSON.stringify({ fields, preferred_language: data.preferred_language || null }) });
      state.profile = profile;
      status.textContent = "Сохранено";
      if (showSuccess) showNotice("Профиль обновлён.");
    } catch (error) { status.textContent = "Не удалось сохранить"; showNotice(error.message, true); }
  }

  async function decideCandidate(button) {
    const field = button.dataset.field;
    const action = button.dataset.action;
    const card = button.closest(".candidate-card");
    card.style.opacity = ".45";
    try {
      const { profile } = await api("/public/profile", { method: "PATCH", body: JSON.stringify({ [action]: [field] }) });
      state.profile = profile;
      renderProfile(profile);
      showNotice(action === "confirm" ? "Сведение подтверждено." : "Сведение удалено.");
    } catch (error) { card.style.opacity = ""; showNotice(error.message, true); }
  }

  function profileValue(profile, key) { return (profile.confirmed || []).find((field) => field.field_key === key)?.value; }
  function profileLabel(key) { return ({ preferred_name: "Как обращаться", city: "Город", timezone: "Часовой пояс", interests: "Интересы", important_life_areas: "Важные области жизни", communication_style: "Стиль общения", recovery_methods: "Способы восстановления", typical_obstacles: "Типичные препятствия" })[key] || "Сведение профиля"; }

  function renderUnavailable(screen) {
    const host = document.getElementById(`${screen}-content`);
    if (!host) return;
    host.classList.remove("loading-placeholder");
    host.innerHTML = '<div class="empty-state"><strong>Не получилось загрузить данные</strong><span class="empty-copy">Проверьте соединение и откройте раздел ещё раз.</span></div>';
  }

  let noticeTimer;
  function showNotice(message, error = false, autoHide = true) {
    clearTimeout(noticeTimer);
    const notice = document.getElementById("notice");
    notice.textContent = message;
    notice.classList.toggle("is-error", error);
    notice.hidden = false;
    if (autoHide) noticeTimer = setTimeout(() => { notice.hidden = true; }, 3800);
  }

  function goalStatus(status) { return ({ active: "Активна", draft: "Черновик", paused: "Пауза", completed: "Готово" })[status] || "Цель"; }
  function formatDate(value) { if (!value) return ""; const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }); }
  function displayValue(value) { if (Array.isArray(value)) return value.join(", "); if (value && typeof value === "object") return Object.values(value).join(", "); return value == null ? "" : String(value); }
  function asList(value) { return Array.isArray(value) ? value : value ? [String(value)] : []; }
  function escapeHtml(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
  function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }
  function cssEscape(value) { return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&"); }

  function moduleIcon(code) {
    const icons = {
      journal: '<svg viewBox="0 0 64 64"><path d="M9 14c12-5 19-2 23 3v36c-6-5-14-7-23-3Z"/><path d="M55 14c-12-5-19-2-23 3v36c6-5 14-7 23-3Z"/><path d="M15 23h11M15 30h11M38 23h11M38 30h11"/><path class="orange-fill" d="m45 45 9-15 5 4-10 15-6 2Z"/></svg>',
      state: '<svg viewBox="0 0 64 64"><path class="orange-fill" d="M32 54 10 34C-2 21 16 7 27 19l5 6 5-6C48 7 66 21 54 34Z"/><circle cx="25" cy="31" r="2" class="fill-ink no-stroke"/><circle cx="39" cy="31" r="2" class="fill-ink no-stroke"/><path d="M24 38c5 5 11 5 16 0"/></svg>',
      compatibility: '<svg viewBox="0 0 64 64"><path class="peach-fill" d="M25 54 8 38C-2 27 13 14 22 24l3 4 3-4c9-10 24 3 14 14Z"/><path class="orange-fill" d="M43 54 28 40c-9-10 5-22 13-13l2 3 2-3c8-9 22 3 13 13Z"/><circle cx="19" cy="34" r="1.5" class="fill-ink no-stroke"/><circle cx="30" cy="34" r="1.5" class="fill-ink no-stroke"/><path d="M18 40c4 3 8 3 11 0"/><circle cx="39" cy="38" r="1.5" class="fill-ink no-stroke"/><circle cx="49" cy="38" r="1.5" class="fill-ink no-stroke"/><path d="M38 44c4 3 8 3 11 0"/></svg>',
      budget: '<svg viewBox="0 0 64 64"><path class="orange-fill" d="M8 20h43c4 0 7 3 7 7v25H8c-4 0-6-3-6-7V27c0-4 2-7 6-7Z"/><path d="M10 20 41 9c5-2 8 1 9 7M43 31h17v13H43c-4 0-6-3-6-6s2-7 6-7Z"/><circle cx="46" cy="38" r="2" class="fill-ink no-stroke"/></svg>',
      practices: '<svg viewBox="0 0 64 64"><path d="M32 57C29 41 18 31 4 32c4 14 14 23 28 25Zm0 0c3-16 14-26 28-25-4 14-14 23-28 25Zm0-1C18 46 15 30 23 17c11 9 14 24 9 39Zm0 0c14-10 17-26 9-39-11 9-14 24-9 39Z"/></svg>',
      tests: '<svg viewBox="0 0 64 64"><rect x="13" y="12" width="38" height="46" rx="4"/><path d="M25 12V7h14v5M22 27l4 4 7-8M22 40l4 4 7-8M37 28h8M37 41h8"/></svg>',
      reports: '<svg viewBox="0 0 64 64"><path d="M7 54h50"/><rect x="11" y="36" width="9" height="18"/><rect x="25" y="25" width="9" height="29" class="orange-fill"/><rect x="39" y="13" width="9" height="41" class="orange-fill"/><path d="M47 36a14 14 0 1 0 10 23l-10-9Z"/><path class="orange-fill" d="M50 34v13h13c0-7-6-13-13-13Z"/></svg>',
      goals: '<svg viewBox="0 0 64 64"><circle cx="29" cy="35" r="23"/><circle cx="29" cy="35" r="14"/><circle cx="29" cy="35" r="5"/><path d="m33 31 20-20M45 11h9v9"/></svg>',
      life: '<svg viewBox="0 0 64 64"><path d="m5 18 16-7 21 7 17-7v39l-17 7-21-7-16 7Z"/><path d="M21 11v39M42 18v39"/><path class="orange-fill" d="M42 6c-8 0-14 6-14 14 0 11 14 23 14 23s14-12 14-23c0-8-6-14-14-14Z"/><circle cx="42" cy="20" r="5" class="fill-bg"/></svg>',
      programs: '<svg viewBox="0 0 64 64"><path d="M7 50c12 3 11-17 23-13s8 14 25 9"/><path d="M39 36V12h16l-5 7 5 7H39"/><circle cx="8" cy="50" r="3" class="orange-fill no-stroke"/></svg>',
      habits: '<svg viewBox="0 0 64 64"><rect x="7" y="13" width="50" height="44" rx="5"/><path d="M18 7v12M46 7v12M7 24h50M17 35l5 5 8-10M34 35l5 5 8-10M17 49l5 5 8-10"/><path class="orange-fill" d="m17 35 5 5 8-10M34 35l5 5 8-10M17 49l5 5 8-10"/></svg>',
      focus: '<svg viewBox="0 0 64 64"><path d="m5 54 18-29 10 15 8-12 18 26Z"/><path class="orange-fill" d="M38 28V10h17l-5 6 5 6H38"/></svg>',
      decisions: '<svg viewBox="0 0 64 64"><path d="M32 57V7M15 17h36l7 8-7 8H15L7 25Zm-2 22H8l-6 7 6 7h22"/><path class="orange-fill" d="M15 17h36l7 8-7 8H15L7 25Z"/></svg>',
      astro: '<svg viewBox="0 0 64 64"><circle cx="32" cy="35" r="17" class="orange-fill"/><path d="M4 38c10 8 33 12 50 4 9-4 8-10 1-13M14 13l2 5 5 2-5 2-2 5-2-5-5-2 5-2Zm39 1 1 4 4 1-4 1-1 4-1-4-4-1 4-1Z"/></svg>',
    };
    return icons[code] || '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="24"/><path d="M20 32h24M32 20v24"/></svg>';
  }

  async function demoApi(path, options) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (path === "/public/session") return { user: { first_name: "Вик", preferred_name: "Вик", city: "Пермь", timezone: "Asia/Yekaterinburg", preferred_language: "ru" } };
    if (path === "/public/today") return { today: { main_action: "Закончить план проекта", work_block_id: "demo", work_block_status: "planned" } };
    if (path === "/public/goals" && (!options.method || options.method === "GET")) return { goals: [{ id: "1", title: "Запустить новую версию Евы", target_date: "2026-09-01", progress_percent: 42, status: "active", next_result: "Завершить главный экран WebApp", next_step: "Проверить на телефоне", why_it_matters: "Собрать цельный продукт." }] };
    if (path === "/public/goals" && options.method === "POST") return { goal: { id: String(Date.now()), ...JSON.parse(options.body), status: "active" } };
    if (path === "/public/progress") return { progress: { completed_results: [{ title: "Определена структура WebApp", result_artifact: "Техническое задание", completed_at: new Date().toISOString() }], work_blocks: [], strategies: [], goals: [{ title: "Запустить новую версию Евы", progress_percent: 42 }] } };
    if (path === "/public/profile") return { profile: { completeness: .72, user: { preferred_name: "Вик", city: "Пермь", timezone: "Asia/Yekaterinburg", preferred_language: "ru" }, confirmed: [], candidates: [] } };
    return {};
  }
})();
