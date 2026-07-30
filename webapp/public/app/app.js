/* =====================================================================
 * Eva Mini App.
 *
 * The home screen is drawn entirely from HTML/CSS/SVG: no bitmap of the
 * reference is used anywhere, every icon below is an inline <svg>, and
 * every value on screen comes either from the API or from the device.
 *
 * Screens that the backend does not serve yet say so plainly instead of
 * showing invented numbers — a self-knowledge app that lies about the
 * user's own data is worse than one that admits a gap.
 * ===================================================================== */
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
    tasks: [],
    progress: null,
    profile: null,
    profileTimer: null,
    firstName: "",
    focus: null,
  };

  const SCREEN_TITLES = {
    today: "Сегодня",
    goals: "Развитие",
    organizer: "Органайзер",
    pult: "Пульт",
    progress: "Отчёты",
    profile: "Профиль",
    module: "Модуль",
  };

  /* The 14 tiles of the reference, in reading order. `screen` routes a
   * tile to a section that already exists; everything else opens its own
   * module page. */
  const MODULES = [
    { code: "journal", title: "Дневник", note: "Жизнь и мысли", sheet: "journal" },
    { code: "state", title: "Состояние", note: "Настроение и энергия", sheet: "checkin" },
    { code: "compatibility", title: "Совместимость", note: "Люди и общение" },
    { code: "budget", title: "Бюджет", note: "Доходы и расходы" },
    { code: "practices", title: "Практики", note: "Перезагрузка" },
    { code: "tests", title: "Тесты", note: "Понять себя" },
    { code: "reports", title: "Отчёты", note: "Итоги и динамика", screen: "progress" },
    { code: "goals", title: "Цели", note: "Направление и шаги", screen: "goals" },
    { code: "life", title: "Карта жизни", note: "Важные сферы" },
    { code: "programs", title: "Программы", note: "7, 14 и 30 дней" },
    { code: "habits", title: "Привычки", note: "Поддерживающие ритмы" },
    { code: "focus", title: "Фокус", note: "5, 15 или 25 минут", sheet: "focus" },
    { code: "decisions", title: "Решения", note: "Факты и варианты" },
    { code: "astro", title: "Астрорефлексия", note: "Символический взгляд" },
  ];

  const MOODS = ["Тяжёлое", "Спокойное", "Хорошее", "Отличное"];

  if (tg) {
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.("#f8f7f3");
    tg.setBackgroundColor?.("#f8f7f3");
    tg.setBottomBarColor?.("#fffefa");
  }

  renderModules();
  bindStaticEvents();
  renderCheckin(readCheckin());
  updateGreeting();
  void bootstrap();

  // -------------------------------------------------------------------
  // wiring
  // -------------------------------------------------------------------
  function bindStaticEvents() {
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.addEventListener("click", () => void openScreen(button.dataset.target));
    });
    document.querySelectorAll("[data-checkin]").forEach((button) => {
      button.addEventListener("click", () => openCheckinSheet(button.dataset.checkin));
    });
    document.querySelectorAll("[data-quick]").forEach((button) => {
      button.addEventListener("click", () => handleQuickAction(button.dataset.quick));
    });
    document.getElementById("edit-result").addEventListener("click", openResultSheet);
    document.getElementById("eva-fab").addEventListener("click", openEvaSheet);
    document.getElementById("add-goal").addEventListener("click", openGoalSheet);
    document.getElementById("notifications-button").addEventListener("click", openNotificationsSheet);

    const sheet = document.getElementById("sheet");
    document.getElementById("sheet-close").addEventListener("click", () => sheet.close());
    // A dialog fills the viewport, so "outside" means outside its box.
    sheet.addEventListener("click", (event) => {
      if (event.target !== sheet) return;
      const box = sheet.getBoundingClientRect();
      const outside = event.clientY < box.top || event.clientY > box.bottom ||
        event.clientX < box.left || event.clientX > box.right;
      if (outside) sheet.close();
    });

    tg?.BackButton?.onClick(() => void openScreen("today"));
  }

  // -------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------
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
    try {
      state.session = await api("/public/session", { method: "POST" });
      state.firstName = state.session.user?.preferred_name
        || state.session.user?.first_name
        || tg?.initDataUnsafe?.user?.first_name
        || "";
      updateGreeting();
      await loadToday();
    } catch (error) {
      state.firstName = tg?.initDataUnsafe?.user?.first_name || "";
      updateGreeting();
      setResult(null);
      showNotice(error.message, true, false);
    }
  }

  async function loadToday() {
    const { today } = await api("/public/today");
    state.today = today || {};
    state.loaded.add("today");
    setResult(state.today.main_action);
  }

  function setResult(value) {
    const node = document.getElementById("main-result");
    node.textContent = value || "Выбрать главный результат";
    node.classList.toggle("is-empty", !value);
  }

  function updateGreeting() {
    const hour = new Date().getHours();
    const greeting = hour < 5
      ? "Доброй ночи"
      : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
    document.getElementById("greeting-text").textContent =
      state.firstName ? `${greeting}, ${state.firstName}` : greeting;
  }

  // -------------------------------------------------------------------
  // navigation
  // -------------------------------------------------------------------
  async function openScreen(screen, options = {}) {
    if (!SCREEN_TITLES[screen]) return;
    document.getElementById("sheet").close();
    state.screen = screen;
    document.body.classList.toggle("is-today", screen === "today");

    document.querySelectorAll(".screen").forEach((node) => {
      node.hidden = node.dataset.screen !== screen;
    });
    document.querySelectorAll(".nav-item").forEach((node) => {
      const active = node.dataset.target === screen;
      node.classList.toggle("is-active", active);
      if (active) node.setAttribute("aria-current", "page");
      else node.removeAttribute("aria-current");
    });

    if (screen === "today") {
      updateGreeting();
      tg?.BackButton?.hide?.();
    } else {
      tg?.BackButton?.show?.();
    }
    document.getElementById("screens").scrollTop = 0;

    if (options.reload) state.loaded.delete(screen);
    if (state.loaded.has(screen)) return;

    const loaders = {
      goals: loadGoals,
      organizer: loadOrganizer,
      progress: loadProgress,
      profile: loadProfile,
    };
    try {
      await loaders[screen]?.();
    } catch (error) {
      showNotice(error.message, true);
      renderUnavailable(screen);
    }
  }

  // -------------------------------------------------------------------
  // modules grid
  // -------------------------------------------------------------------
  function renderModules() {
    document.getElementById("modules-grid").innerHTML = MODULES.map((item) => `
      <button class="module-tile" type="button" data-module="${attribute(item.code)}">
        <span class="module-title${item.title.length > 11 ? " is-long" : ""}">${text(item.title)}</span>
        <span class="module-icon" aria-hidden="true">${moduleIcon(item.code)}</span>
      </button>`).join("");

    document.getElementById("pult-grid").innerHTML = MODULES.map((item) => `
      <button class="pult-card" type="button" data-module="${attribute(item.code)}">
        <span class="module-icon" aria-hidden="true">${moduleIcon(item.code)}</span>
        <span><h3>${text(item.title)}</h3><p>${text(item.note)}</p></span>
      </button>`).join("");

    document.querySelectorAll("[data-module]").forEach((button) => {
      button.addEventListener("click", () => openModule(button.dataset.module));
    });
  }

  function openModule(code) {
    const item = MODULES.find((module) => module.code === code);
    if (!item) return;
    haptic("light");
    if (item.screen) return void openScreen(item.screen);
    if (item.sheet === "checkin") return openCheckinSheet("mood");
    if (item.sheet === "focus") return openFocusSheet();
    if (item.sheet === "journal") return openJournalSheet();

    document.getElementById("module-kicker").textContent = item.note;
    document.getElementById("module-title").textContent = item.title;
    document.getElementById("module-content").innerHTML = `
      <div class="placeholder-card">
        <span class="module-icon" aria-hidden="true">${moduleIcon(item.code)}</span>
        <h3>${text(item.title)}</h3>
        <p>Экран модуля готов — данные подключаются на стороне сервиса.
           Пока эту тему можно вести в чате с Евой: там она уже работает.</p>
        <button class="ghost-button" type="button" id="module-ask-eva">Спросить Еву</button>
      </div>`;
    document.getElementById("module-ask-eva").addEventListener("click", () => openEvaSheet());
    void openScreen("module");
  }

  // -------------------------------------------------------------------
  // quick actions
  // -------------------------------------------------------------------
  function handleQuickAction(action) {
    haptic("light");
    if (action === "journal") return openJournalSheet();
    if (action === "focus") return openFocusSheet();
    if (action === "eva") return openEvaSheet();
    return openModule("practices");
  }

  // -------------------------------------------------------------------
  // bottom sheets
  // -------------------------------------------------------------------
  function openSheet({ title, subtitle = "", html, onMount }) {
    const sheet = document.getElementById("sheet");
    document.getElementById("sheet-title").textContent = title;
    const subtitleNode = document.getElementById("sheet-subtitle");
    subtitleNode.textContent = subtitle;
    subtitleNode.hidden = !subtitle;
    const content = document.getElementById("sheet-content");
    content.innerHTML = html;
    if (!sheet.open) sheet.showModal();
    onMount?.(content, sheet);
  }

  function optionButton({ action, icon, title, note = "" }) {
    return `<button class="sheet-option" type="button" data-action="${attribute(action)}">
      <span class="option-icon" aria-hidden="true">${icon}</span>
      <span><strong>${text(title)}</strong>${note ? `<small>${text(note)}</small>` : ""}</span>
    </button>`;
  }

  function onOption(content, handler) {
    content.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => handler(button.dataset.action, button));
    });
  }

  // --- быстрый check-in ------------------------------------------------
  function openCheckinSheet() {
    const saved = readCheckin();
    openSheet({
      title: "Как ты сейчас?",
      subtitle: "Отметка занимает несколько секунд",
      html: `<form class="form-grid" id="checkin-form">
        <fieldset>
          <legend>Настроение</legend>
          <div class="mood-options">${MOODS.map((mood) => `
            <label><input type="radio" name="mood" value="${attribute(mood)}"${saved.mood === mood ? " checked" : ""} /><span>${text(mood)}</span></label>`).join("")}
          </div>
        </fieldset>
        <label class="range-row"><span>Энергия <strong id="energy-output">${Number(saved.energy) || 5}</strong> / 10</span>
          <input type="range" name="energy" min="1" max="10" value="${Number(saved.energy) || 5}" /></label>
        <label class="range-row"><span>Фокус <strong id="focus-output">${Number(saved.focus) || 5}</strong> / 10</span>
          <input type="range" name="focus" min="1" max="10" value="${Number(saved.focus) || 5}" /></label>
        <button class="primary-action" type="submit">Сохранить</button>
      </form>`,
      onMount(content, sheet) {
        const form = content.querySelector("#checkin-form");
        form.addEventListener("input", () => {
          content.querySelector("#energy-output").textContent = form.elements.energy.value;
          content.querySelector("#focus-output").textContent = form.elements.focus.value;
        });
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const data = {
            mood: form.querySelector('input[name="mood"]:checked')?.value || saved.mood || "Спокойное",
            energy: Number(form.elements.energy.value),
            focus: Number(form.elements.focus.value),
            savedAt: new Date().toISOString(),
          };
          writeCheckin(data);
          renderCheckin(data);
          sheet.close();
          showNotice("Состояние отмечено на этом устройстве.");
          haptic("success");
        });
      },
    });
  }

  function renderCheckin(data) {
    document.getElementById("mood-value").textContent = data.mood || "Отметить";
    document.getElementById("energy-value").textContent = data.energy ? `${data.energy} / 10` : "— / 10";
    document.getElementById("focus-value").textContent = data.focus ? `${data.focus} / 10` : "— / 10";
  }

  function readCheckin() {
    try {
      const saved = JSON.parse(localStorage.getItem("eva.checkin.v1") || "{}");
      // Yesterday's mood is not today's state.
      return saved.savedAt && sameLocalDay(new Date(saved.savedAt), new Date()) ? saved : {};
    } catch {
      return {};
    }
  }
  function writeCheckin(data) {
    try {
      localStorage.setItem("eva.checkin.v1", JSON.stringify(data));
    } catch {
      /* private mode: the value simply does not persist */
    }
  }
  function sameLocalDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // --- главный результат дня -------------------------------------------
  function openResultSheet() {
    const today = state.today || {};
    const rows = [
      ["Цель", today.goal_title],
      ["Ожидаемый результат", today.expected_result],
      ["Первый шаг", today.first_step],
      ["Продолжение", today.continuation],
    ].filter(([, value]) => Boolean(value));

    openSheet({
      title: "Главный результат дня",
      subtitle: today.main_action || "Пока не выбран",
      html: `
        ${rows.length ? `<div class="content-card">${rows.map(([label, value]) => `
          <div class="task-row"><span class="task-index">·</span>
            <span><span class="card-caption">${text(label)}</span><br><strong>${text(value)}</strong></span><span></span></div>`).join("")}</div>` : ""}
        <div class="sheet-options">
          ${today.work_block_id ? optionButton({
            action: today.work_block_status === "active" ? "complete" : "start",
            icon: icon("play"),
            title: today.work_block_status === "active" ? "Завершить рабочий блок" : "Начать рабочий блок",
            note: "Ева запишет результат в вашу цель",
          }) : ""}
          ${optionButton({ action: "goals", icon: icon("target"), title: "Открыть цели", note: "Результат дня берётся из активной цели" })}
          ${optionButton({ action: "eva", icon: icon("chat"), title: "Обсудить с Евой", note: "Выбрать результат в диалоге" })}
        </div>`,
      onMount(content, sheet) {
        onOption(content, (action, button) => {
          if (action === "goals") { sheet.close(); return void openScreen("goals"); }
          if (action === "eva") { return openEvaSheet(); }
          void changeWorkBlock(action, button, sheet);
        });
      },
    });
  }

  async function changeWorkBlock(operation, button, sheet) {
    const id = state.today?.work_block_id;
    if (!id) return;
    button.disabled = true;
    try {
      await api(`/public/work-blocks/${id}/${operation}`, { method: "POST", body: JSON.stringify({}) });
      state.today.work_block_status = operation === "start" ? "active" : "completed";
      sheet.close();
      showNotice(operation === "start" ? "Рабочий блок начат." : "Готово — результат сохранён.");
      haptic("success");
      state.loaded.delete("progress");
      await loadToday();
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  // --- «Записать» --------------------------------------------------------
  function openJournalSheet() {
    openSheet({
      title: "Записать",
      subtitle: "Мысль, событие или наблюдение",
      html: `<form class="form-grid" id="journal-form">
          <label><span>Текстовая запись</span>
            <textarea name="entry" rows="4" maxlength="4000" placeholder="Что происходит прямо сейчас?"></textarea>
            <small class="field-help">Черновик хранится на этом устройстве, пока модуль «Дневник» не подключён к серверу.</small></label>
          <button class="primary-action" type="submit">Сохранить черновик</button>
        </form>
        <div class="sheet-options">
          ${optionButton({ action: "voice", icon: icon("mic"), title: "Голосовая запись", note: "Наговорить Еве в чат — она расшифрует" })}
          ${optionButton({ action: "photo", icon: icon("photo"), title: "Фото", note: "Отправить снимок Еве в чат" })}
        </div>`,
      onMount(content, sheet) {
        const drafts = readDrafts();
        content.querySelector("#journal-form").addEventListener("submit", (event) => {
          event.preventDefault();
          const entry = event.currentTarget.elements.entry.value.trim();
          if (!entry) return showNotice("Запись пустая.", true);
          drafts.unshift({ entry, at: new Date().toISOString() });
          writeDrafts(drafts.slice(0, 50));
          sheet.close();
          showNotice("Черновик сохранён на этом устройстве.");
          haptic("success");
        });
        onOption(content, (action) => {
          sheet.close();
          openInChat(action === "voice"
            ? "Голосовые записи Ева принимает прямо в чате — просто надиктуйте сообщение."
            : "Фотографии Ева принимает прямо в чате — отправьте снимок сообщением.");
        });
      },
    });
  }

  function readDrafts() {
    try { return JSON.parse(localStorage.getItem("eva.journal.drafts.v1") || "[]"); } catch { return []; }
  }
  function writeDrafts(value) {
    try { localStorage.setItem("eva.journal.drafts.v1", JSON.stringify(value)); } catch { /* ignore */ }
  }

  // --- «Фокус» -----------------------------------------------------------
  function openFocusSheet() {
    if (state.focus) return stopFocus(true);
    openSheet({
      title: "Фокус-сессия",
      subtitle: "Таймер идёт в приложении",
      html: `<div class="sheet-options is-columns">
          ${[5, 15, 25].map((minutes) => optionButton({
            action: String(minutes), icon: icon("clock"), title: `${minutes} минут`,
          })).join("")}
          ${optionButton({ action: "free", icon: icon("infinity"), title: "Свободный режим" })}
        </div>`,
      onMount(content, sheet) {
        onOption(content, (action) => {
          sheet.close();
          startFocus(action === "free" ? null : Number(action));
        });
      },
    });
  }

  function startFocus(minutes) {
    stopFocus(false);
    const endsAt = minutes ? Date.now() + minutes * 60_000 : null;
    const pill = document.createElement("div");
    pill.className = "focus-pill";
    pill.innerHTML = '<strong id="focus-clock">00:00</strong><button type="button" id="focus-stop">Завершить</button>';
    document.body.append(pill);
    pill.querySelector("#focus-stop").addEventListener("click", () => stopFocus(true));

    const startedAt = Date.now();
    const tick = () => {
      const remaining = endsAt ? endsAt - Date.now() : Date.now() - startedAt;
      if (endsAt && remaining <= 0) {
        stopFocus(false);
        showNotice("Фокус-сессия завершена. Что получилось?");
        haptic("success");
        return;
      }
      pill.querySelector("#focus-clock").textContent = clock(Math.max(0, remaining));
    };
    tick();
    state.focus = { pill, timer: setInterval(tick, 1000) };
    haptic("light");
  }

  function stopFocus(announce) {
    if (!state.focus) return;
    clearInterval(state.focus.timer);
    state.focus.pill.remove();
    state.focus = null;
    if (announce) showNotice("Фокус-сессия остановлена.");
  }

  function clock(ms) {
    const total = Math.round(ms / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  // --- Ева ---------------------------------------------------------------
  function openEvaSheet() {
    document.getElementById("eva-fab").setAttribute("aria-expanded", "true");
    openSheet({
      title: "Ева рядом",
      subtitle: "Диалог идёт в чате Telegram",
      html: `<div class="sheet-options">
          ${optionButton({ action: "write", icon: icon("chat"), title: "Написать Еве" })}
          ${optionButton({ action: "voice", icon: icon("mic"), title: "Надиктовать" })}
          ${optionButton({ action: "screen", icon: icon("screen"), title: "Обсудить этот экран" })}
          ${optionButton({ action: "note", icon: icon("note"), title: "Создать заметку" })}
          ${optionButton({ action: "task", icon: icon("check"), title: "Создать задачу" })}
        </div>`,
      onMount(content, sheet) {
        sheet.addEventListener("close", () => {
          document.getElementById("eva-fab").setAttribute("aria-expanded", "false");
        }, { once: true });
        onOption(content, (action) => {
          sheet.close();
          openInChat({
            write: "Напишите Еве в чат — она продолжит разговор с вашим контекстом.",
            voice: "Надиктуйте голосовое в чат — Ева расшифрует и ответит.",
            screen: `Спросите Еву в чате: «${screenQuestion()}»`,
            note: "Отправьте заметку сообщением в чат — Ева сохранит её.",
            task: "Опишите задачу в чате — Ева поставит её и напомнит.",
          }[action]);
        });
      },
    });
  }

  function screenQuestion() {
    if (state.screen !== "today") return `Расскажи про раздел «${SCREEN_TITLES[state.screen]}»`;
    return state.today?.main_action
      ? `Помоги с результатом дня: ${state.today.main_action}`
      : "Помоги выбрать главный результат на сегодня";
  }

  /* Everything conversational lives in the bot; the Mini App hands over
   * rather than reimplementing a second chat. */
  function openInChat(message) {
    showNotice(message);
    if (tg?.close) setTimeout(() => tg.close(), 1400);
  }

  function openNotificationsSheet() {
    const checkin = readCheckin();
    const items = [];
    if (!checkin.mood) items.push("Состояние сегодня ещё не отмечено.");
    if (!state.today?.main_action) items.push("Главный результат дня не выбран.");
    if (state.today?.continuation) items.push(`Продолжение с прошлого раза: ${state.today.continuation}`);

    document.getElementById("notification-dot").hidden = items.length === 0;
    openSheet({
      title: "Уведомления",
      subtitle: items.length ? "Что стоит закрыть сегодня" : "",
      html: items.length
        ? `<div class="content-card">${items.map((item) => `
            <div class="task-row"><span class="task-index">!</span><span>${text(item)}</span><span></span></div>`).join("")}</div>`
        : '<div class="empty-state"><strong>Всё спокойно</strong><span class="card-caption">Новых уведомлений нет.</span></div>',
    });
  }

  // -------------------------------------------------------------------
  // Развитие
  // -------------------------------------------------------------------
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
      host.innerHTML = '<div class="empty-state"><strong>Целей пока нет</strong><span class="card-caption">Добавьте одну цель, которую хочется приблизить.</span></div>';
      return;
    }
    host.innerHTML = state.goals.map((goal) => {
      const progress = Math.max(0, Math.min(100, Number(goal.progress_percent || 0)));
      return `<article class="goal-card">
        <div class="goal-topline">
          <div><h3>${text(goal.title)}</h3>
            <p class="card-caption">${goal.target_date ? `до ${formatDate(goal.target_date)}` : "без жёсткого срока"}</p></div>
          <span class="status-chip">${goalStatus(goal.status)}</span>
        </div>
        <div>
          <div class="goal-topline card-caption"><span>Прогресс</span><span>${progress}%</span></div>
          <div class="progress-track"><span style="width:${progress}%"></span></div>
        </div>
        ${goal.next_result ? `<div><p class="kicker">Ближайший результат</p><strong>${text(goal.next_result)}</strong>${goal.next_step ? `<p class="card-caption">Следом: ${text(goal.next_step)}</p>` : ""}</div>` : ""}
        <details class="goal-details"><summary>Подробнее</summary>
          <p>${text(goal.why_it_matters || "Смысл цели пока не уточнён.")}</p>
          ${goal.status === "active" ? `<button type="button" class="secondary-action pause-goal" data-id="${attribute(goal.id)}">Поставить на паузу</button>` : ""}
        </details>
      </article>`;
    }).join("");
    host.querySelectorAll(".pause-goal").forEach((button) => {
      button.addEventListener("click", () => void pauseGoal(button));
    });
  }

  function openGoalSheet() {
    openSheet({
      title: "Новая цель",
      subtitle: "Одна формулировка, которую хочется приблизить",
      html: `<form class="form-grid" id="goal-form">
        <label><span>Что хотите получить?</span><input name="title" maxlength="500" required placeholder="Например, подготовить запуск проекта" /></label>
        <label><span>Почему это важно?</span><textarea name="why_it_matters" maxlength="5000" rows="3" placeholder="Коротко, своими словами"></textarea></label>
        <label><span>Желаемый срок</span><input name="target_date" type="date" /></label>
        <button class="primary-action" type="submit">Сохранить цель</button>
      </form>`,
      onMount(content, sheet) {
        content.querySelector("#goal-form").addEventListener("submit", (event) => void createGoal(event, sheet));
        content.querySelector('input[name="title"]').focus();
      },
    });
  }

  async function createGoal(event, sheet) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      const { goal } = await api("/public/goals", { method: "POST", body: JSON.stringify(payload) });
      state.goals.unshift({ ...goal, progress_percent: 0 });
      state.loaded.delete("today");
      renderGoals();
      sheet.close();
      showNotice("Цель добавлена.");
      haptic("success");
      await loadToday().catch(() => {});
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      submit.disabled = false;
    }
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

  // -------------------------------------------------------------------
  // Органайзер
  // -------------------------------------------------------------------
  async function loadOrganizer() {
    const { tasks } = await api("/public/tasks");
    state.tasks = tasks || [];
    state.loaded.add("organizer");
    const host = document.getElementById("organizer-content");
    host.classList.remove("loading-placeholder");
    if (!state.tasks.length) {
      host.innerHTML = '<div class="empty-state"><strong>Задач пока нет</strong><span class="card-caption">Опишите задачу Еве в чате — она появится здесь.</span></div>';
      return;
    }
    host.innerHTML = `<div class="content-card">${state.tasks.map((task, index) => `
      <div class="task-row">
        <span class="task-index">${index + 1}</span>
        <span><strong>${text(task.title)}</strong>${task.due_at ? `<br><span class="card-caption">до ${formatDate(task.due_at)}</span>` : ""}</span>
        <span class="status-chip">${taskStatus(task.status)}</span>
      </div>`).join("")}</div>`;
  }

  // -------------------------------------------------------------------
  // Отчёты
  // -------------------------------------------------------------------
  async function loadProgress() {
    const { progress } = await api("/public/progress");
    state.progress = progress || {};
    state.loaded.add("progress");

    const results = state.progress.completed_results || [];
    const blocks = state.progress.work_blocks || [];
    const artifacts = blocks.filter((item) => item.artifact);
    const timeline = [
      ...results.map((item) => ({ title: item.title, note: item.result_artifact || `Цель: ${item.goal_title}`, date: item.completed_at })),
      ...blocks.map((item) => ({ title: item.actual_result || item.intention, note: item.artifact || item.helpful_factor || item.goal_title, date: item.completed_at })),
    ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 20);

    const host = document.getElementById("progress-content");
    host.classList.remove("loading-placeholder");
    host.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><span class="stat-number">${results.length}</span><span class="card-caption">результатов завершено</span></div>
        <div class="stat-card"><span class="stat-number">${artifacts.length}</span><span class="card-caption">артефактов создано</span></div>
      </div>
      ${renderGoalProgress(state.progress.goals || [])}
      ${timeline.length
        ? `<div><p class="kicker">История движения</p><div class="content-card">${timeline.map((item) => `
            <div class="timeline-item"><h3>${text(item.title)}</h3>
              <p class="card-caption">${text(item.note || "")}${item.date ? ` · ${formatDate(item.date)}` : ""}</p></div>`).join("")}</div></div>`
        : '<div class="empty-state"><strong>Прогресс появится здесь</strong><span class="card-caption">Начните первый рабочий блок — Ева сохранит результат.</span></div>'}`;
  }

  function renderGoalProgress(goals) {
    if (!goals.length) return "";
    return `<div><p class="kicker">Общая картина</p><div class="content-card">${goals.map((goal) => {
      const value = Math.max(0, Math.min(100, Number(goal.progress_percent || 0)));
      return `<div class="task-row"><span class="task-index">${value}</span>
        <span><strong>${text(goal.title)}</strong><div class="progress-track"><span style="width:${value}%"></span></div></span>
        <span class="card-caption">%</span></div>`;
    }).join("")}</div></div>`;
  }

  // -------------------------------------------------------------------
  // Профиль
  // -------------------------------------------------------------------
  async function loadProfile() {
    const { profile } = await api("/public/profile");
    state.profile = profile || {};
    state.loaded.add("profile");
    renderProfile(state.profile);
  }

  function renderProfile(profile) {
    const user = profile.user || {};
    const completeness = Math.round(Number(profile.completeness || 0) * 100);
    const interests = confirmedValue(profile, "interests") || user.interests || [];
    const style = confirmedValue(profile, "communication_style") || user.communication_style || "";
    const areas = confirmedValue(profile, "important_life_areas") || [];

    const host = document.getElementById("profile-content");
    host.classList.remove("loading-placeholder");
    host.innerHTML = `
      <div class="profile-score">
        <div class="score-row">
          <div><p class="kicker">Профиль заполнен</p><strong>Ева лучше понимает контекст</strong></div>
          <span class="score-number">${completeness}%</span>
        </div>
        <div class="progress-track"><span style="width:${completeness}%"></span></div>
      </div>
      ${renderCandidates(profile.candidates || [])}
      <form class="form-grid" id="profile-form">
        <label><span>Как к вам обращаться</span><input name="preferred_name" maxlength="120" value="${attribute(user.preferred_name || "")}" placeholder="Ваше имя" /></label>
        <label><span>Город</span><input name="city" maxlength="200" value="${attribute(user.city || "")}" placeholder="Например, Пермь" /></label>
        <label><span>Часовой пояс</span><input name="timezone" maxlength="100" value="${attribute(user.timezone || "")}" placeholder="Asia/Yekaterinburg" />
          <small class="field-help">Можно указать город или точный часовой пояс.</small></label>
        <label><span>Язык</span><select name="preferred_language">
          <option value=""${!user.preferred_language ? " selected" : ""}>Автоматически</option>
          <option value="ru"${user.preferred_language === "ru" ? " selected" : ""}>Русский</option>
          <option value="en"${user.preferred_language === "en" ? " selected" : ""}>English</option>
        </select></label>
        <label><span>Интересы</span><input name="interests" value="${attribute(asList(interests).join(", "))}" placeholder="Технологии, спорт, книги" /></label>
        <label><span>Предпочтительный стиль общения</span><input name="communication_style" maxlength="500" value="${attribute(style)}" placeholder="Например, кратко и по делу" /></label>
        <label><span>Что сейчас особенно важно</span><textarea name="important_life_areas" rows="3" placeholder="Работа, отношения, здоровье…">${text(asList(areas).join(", "))}</textarea></label>
        <div class="autosave-state" id="autosave-state">Изменения сохраняются автоматически</div>
        <button class="primary-action" type="submit">Сохранить профиль</button>
      </form>`;

    const form = document.getElementById("profile-form");
    form.addEventListener("input", scheduleProfileSave);
    form.addEventListener("change", scheduleProfileSave);
    form.addEventListener("submit", (event) => { event.preventDefault(); void saveProfile(true); });
    host.querySelectorAll(".candidate-action").forEach((button) => {
      button.addEventListener("click", () => void decideCandidate(button));
    });
  }

  function renderCandidates(candidates) {
    if (!candidates.length) return "";
    return `<div><p class="kicker">Нужна ваша проверка</p>${candidates.map((field) => `
      <div class="candidate-card">
        <strong>${text(profileLabel(field.field_key))}</strong>
        <p class="card-caption">${text(displayValue(field.value))}</p>
        <div class="candidate-actions">
          <button class="text-action candidate-action" type="button" data-action="confirm" data-field="${attribute(field.field_key)}">Подтвердить</button>
          <button class="text-action candidate-action" type="button" data-action="decline" data-field="${attribute(field.field_key)}">Не сохранять</button>
        </div>
      </div>`).join("")}</div>`;
  }

  function scheduleProfileSave() {
    clearTimeout(state.profileTimer);
    document.getElementById("autosave-state").textContent = "Есть несохранённые изменения…";
    state.profileTimer = setTimeout(() => void saveProfile(false), 800);
  }

  async function saveProfile(announce) {
    clearTimeout(state.profileTimer);
    const form = document.getElementById("profile-form");
    if (!form) return;
    const data = Object.fromEntries(new FormData(form).entries());
    const fields = {};
    for (const key of ["preferred_name", "city", "timezone", "communication_style"]) {
      if (String(data[key] || "").trim()) fields[key] = String(data[key]).trim();
    }
    for (const key of ["interests", "important_life_areas"]) {
      const values = String(data[key] || "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
      if (values.length) fields[key] = values;
    }
    const status = document.getElementById("autosave-state");
    status.textContent = "Сохраняю…";
    try {
      const { profile } = await api("/public/profile", {
        method: "PATCH",
        body: JSON.stringify({ fields, preferred_language: data.preferred_language || null }),
      });
      state.profile = profile;
      state.firstName = profile.user?.preferred_name || state.firstName;
      updateGreeting();
      status.textContent = "Сохранено";
      if (announce) showNotice("Профиль обновлён.");
    } catch (error) {
      status.textContent = "Не удалось сохранить";
      showNotice(error.message, true);
    }
  }

  async function decideCandidate(button) {
    const card = button.closest(".candidate-card");
    card.style.opacity = ".45";
    try {
      const { profile } = await api("/public/profile", {
        method: "PATCH",
        body: JSON.stringify({ [button.dataset.action]: [button.dataset.field] }),
      });
      state.profile = profile;
      renderProfile(profile);
      showNotice(button.dataset.action === "confirm" ? "Сведение подтверждено." : "Сведение удалено.");
    } catch (error) {
      card.style.opacity = "";
      showNotice(error.message, true);
    }
  }

  function confirmedValue(profile, key) {
    return (profile.confirmed || []).find((field) => field.field_key === key)?.value;
  }
  function profileLabel(key) {
    return ({
      preferred_name: "Как обращаться",
      city: "Город",
      timezone: "Часовой пояс",
      interests: "Интересы",
      important_life_areas: "Важные области жизни",
      communication_style: "Стиль общения",
      recovery_methods: "Способы восстановления",
      typical_obstacles: "Типичные препятствия",
    })[key] || "Сведение профиля";
  }

  // -------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------
  function renderUnavailable(screen) {
    const host = document.getElementById(`${screen}-content`);
    if (!host) return;
    host.classList.remove("loading-placeholder");
    host.innerHTML = '<div class="empty-state"><strong>Не получилось загрузить данные</strong><span class="card-caption">Проверьте соединение и откройте раздел ещё раз.</span></div>';
  }

  let noticeTimer;
  function showNotice(message, isError = false, autoHide = true) {
    clearTimeout(noticeTimer);
    const notice = document.getElementById("notice");
    notice.textContent = message;
    notice.classList.toggle("is-error", isError);
    notice.hidden = false;
    if (autoHide) noticeTimer = setTimeout(() => { notice.hidden = true; }, 4200);
  }

  function haptic(kind) {
    if (kind === "success") tg?.HapticFeedback?.notificationOccurred?.("success");
    else tg?.HapticFeedback?.impactOccurred?.(kind);
  }

  function goalStatus(status) {
    return ({ active: "Активна", draft: "Черновик", paused: "Пауза", completed: "Готово" })[status] || "Цель";
  }
  function taskStatus(status) {
    return ({ open: "Открыта", in_progress: "В работе", done: "Готово", completed: "Готово" })[status] || "Задача";
  }
  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  }
  function displayValue(value) {
    if (Array.isArray(value)) return value.join(", ");
    if (value && typeof value === "object") return Object.values(value).join(", ");
    return value == null ? "" : String(value);
  }
  function asList(value) { return Array.isArray(value) ? value : value ? [String(value)] : []; }
  function text(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }
  function attribute(value) { return text(value).replace(/`/g, "&#96;"); }

  // -------------------------------------------------------------------
  // inline SVG — no emoji, no icon font, no bitmap anywhere
  // -------------------------------------------------------------------
  function icon(name) {
    return ({
      play: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="13"/><path class="fill-orange" d="m13 10 10 6-10 6Z"/></svg>',
      target: '<svg viewBox="0 0 32 32"><circle cx="14" cy="18" r="11"/><circle cx="14" cy="18" r="6"/><circle cx="14" cy="18" r="1.8" class="fill-ink no-stroke"/><path d="m17 15 12-12M23 3h6v6"/></svg>',
      chat: '<svg viewBox="0 0 32 32"><path d="M4 13c0-5 5-9 12-9s12 4 12 9-5 9-12 9c-2 0-3 0-4-1l-6 3 2-6c-2-1-4-3-4-5Z"/><path d="M11 12h10M11 16h6"/></svg>',
      mic: '<svg viewBox="0 0 32 32"><rect x="12" y="3" width="8" height="15" rx="4"/><path d="M7 15c0 6 4 9 9 9s9-3 9-9M16 24v5M12 29h8"/></svg>',
      photo: '<svg viewBox="0 0 32 32"><rect x="3" y="8" width="26" height="19" rx="4"/><path d="m11 8 2-4h6l2 4"/><circle cx="16" cy="18" r="6" class="fill-orange"/></svg>',
      note: '<svg viewBox="0 0 32 32"><path d="M6 5h20v22l-6 5H6Z"/><path d="M20 32V27h6M11 12h10M11 17h10M11 22h5"/></svg>',
      check: '<svg viewBox="0 0 32 32"><rect x="4" y="4" width="24" height="24" rx="6"/><path class="stroke-orange" d="m10 16 4 5 8-10"/></svg>',
      screen: '<svg viewBox="0 0 32 32"><rect x="4" y="5" width="24" height="17" rx="3"/><path d="M12 27h8M16 22v5M9 11h9M9 16h5"/></svg>',
      clock: '<svg viewBox="0 0 32 32"><circle cx="16" cy="17" r="12"/><path d="M16 10v7l5 3M11 3l-5 4M21 3l5 4"/></svg>',
      infinity: '<svg viewBox="0 0 32 32"><path d="M16 16c-3-5-6-6-9-4s-3 6 0 8 6 1 9-4 6-6 9-4 3 6 0 8-6 1-9-4Z"/></svg>',
    })[name] || '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="12"/></svg>';
  }

  function moduleIcon(code) {
    return ({
      // раскрытая книга + карандаш с оранжевым корпусом
      journal: '<svg viewBox="0 0 64 64"><path d="M32 19c-6-5-14-6-25-4v33c11-2 19-1 25 4 6-5 14-6 25-4V15c-11-2-19-1-25 4Z"/><path d="M32 19v33"/><path d="M13 26h12M13 33h12M13 40h9M39 26h11M39 33h8"/><path class="fill-orange" d="m36 56 2-8 15-15 6 6-15 15Z"/><path d="m38 48 6 6M50 36l6 6"/></svg>',
      // сердце с лицом
      state: '<svg viewBox="0 0 64 64"><path class="fill-orange" d="M32 55 12 36C1 25 15 10 27 21l5 5 5-5c12-11 26 4 15 15Z"/><circle cx="25" cy="32" r="2.1" class="fill-ink no-stroke"/><circle cx="39" cy="32" r="2.1" class="fill-ink no-stroke"/><path d="M25 39c4 4 10 4 14 0"/></svg>',
      // два сердца с лицами
      compatibility: '<svg viewBox="0 0 64 64"><path class="fill-peach" d="M24 54 8 39C-1 29 12 16 21 26l3 3 3-3c9-10 22 3 13 13Z"/><path class="fill-orange" d="M43 55 29 42c-8-9 4-20 11-11l3 3 3-3c7-9 19 2 11 11Z"/><circle cx="18" cy="34" r="1.7" class="fill-ink no-stroke"/><circle cx="28" cy="34" r="1.7" class="fill-ink no-stroke"/><path d="M18 40c3 3 7 3 10 0"/><circle cx="38" cy="38" r="1.7" class="fill-ink no-stroke"/><circle cx="48" cy="38" r="1.7" class="fill-ink no-stroke"/><path d="M38 44c3 3 7 3 10 0"/></svg>',
      // кошелёк с купюрами и застёжкой
      budget: '<svg viewBox="0 0 64 64"><path class="fill-paper" d="m17 10 27-6 3 14-27 6Z"/><path class="fill-orange" d="M9 20h42a6 6 0 0 1 6 6v22a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6V26a6 6 0 0 1 6-6Z"/><path class="fill-paper" d="M57 31H45a6 6 0 0 0 0 12h12Z"/><circle cx="48" cy="37" r="2.1" class="fill-ink no-stroke"/></svg>',
      // лотос, только контур
      practices: '<svg viewBox="0 0 64 64"><path d="M32 56C29 41 18 32 4 33c4 13 14 21 28 23Zm0 0c3-15 14-24 28-23-4 13-14 21-28 23Zm0-1C18 46 15 30 23 17c11 9 14 24 9 38Zm0 0c14-9 17-25 9-38-11 9-14 24-9 38Z"/></svg>',
      // планшет с зажимом и тремя галочками
      tests: '<svg viewBox="0 0 64 64"><rect x="12" y="11" width="40" height="47" rx="5"/><path class="fill-paper" d="M25 11V9a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2Z"/><rect x="19" y="21" width="9" height="9" rx="2.5"/><path class="stroke-orange" d="m21.5 25.5 2 2.5 4-4.5"/><path d="M33 26h11"/><rect x="19" y="34" width="9" height="9" rx="2.5"/><path class="stroke-orange" d="m21.5 38.5 2 2.5 4-4.5"/><path d="M33 39h11"/><rect x="19" y="47" width="9" height="9" rx="2.5"/><path class="stroke-orange" d="m21.5 51.5 2 2.5 4-4.5"/><path d="M33 52h11"/></svg>',
      // столбцы + круговая диаграмма
      reports: '<svg viewBox="0 0 64 64"><path d="M5 54h35"/><rect x="7" y="34" width="8" height="20"/><rect x="18" y="21" width="8" height="33" class="fill-orange"/><rect x="29" y="28" width="8" height="26" class="fill-orange"/><circle cx="50" cy="41" r="12"/><path class="fill-orange" d="M50 41V29a12 12 0 0 1 12 12Z"/></svg>',
      // мишень со стрелой
      goals: '<svg viewBox="0 0 64 64"><circle cx="28" cy="36" r="22"/><circle cx="28" cy="36" r="13"/><circle cx="28" cy="36" r="5" class="fill-peach"/><path d="m31 33 22-22M43 11h11v11"/></svg>',
      // сложенная карта с оранжевой меткой
      life: '<svg viewBox="0 0 64 64"><path d="m4 17 18-7 20 7 18-7v37l-18 7-20-7-18 7Z"/><path d="M22 10v37M42 17v37"/><path class="fill-orange" d="M41 6c-7 0-12 5-12 12 0 9 12 21 12 21s12-12 12-21c0-7-5-12-12-12Z"/><circle cx="41" cy="18" r="4.5" class="fill-paper"/></svg>',
      // извилистый путь с оранжевым флагом
      programs: '<svg viewBox="0 0 64 64"><path d="M8 51c11 3 5-13 16-16s17 7 24-3"/><circle cx="8" cy="51" r="3" class="fill-ink no-stroke"/><path d="M46 36V11"/><path class="fill-orange" d="M46 12h14l-4 6 4 6H46Z"/></svg>',
      // календарь с кольцами и оранжевыми галочками
      habits: '<svg viewBox="0 0 64 64"><rect x="6" y="15" width="52" height="43" rx="6"/><path d="M19 8v13M45 8v13M6 29h52M23 29v29M41 29v29M6 44h52"/><path class="stroke-orange" d="m10 36 3 4 5-7M28 36l3 4 5-7M46 51l3 4 5-7"/></svg>',
      // две горы с оранжевым флагом на вершине
      focus: '<svg viewBox="0 0 64 64"><path d="M3 53 21 24l11 17 7-11 20 23Z"/><path d="m21 24 6 9M39 30l5 6"/><path d="M39 30V9"/><path class="fill-orange" d="M39 10h13l-4 5 4 5H39Z"/></svg>',
      // дорожный указатель, верхняя стрелка оранжевая
      decisions: '<svg viewBox="0 0 64 64"><path d="M31 58V8M24 58h14"/><path class="fill-orange" d="M31 15h20l7 8-7 8H31Z"/><path class="fill-paper" d="M31 36H12l-7 8 7 8h19Z"/></svg>',
      // планета с кольцом и звёздами
      astro: '<svg viewBox="0 0 64 64"><circle cx="35" cy="36" r="16" class="fill-orange"/><path d="M17 45c-8 4-11 9-9 12 3 4 17 1 30-6s21-16 18-20c-2-3-7-2-13 1"/><path class="fill-yellow" d="m12 10 2.4 5.4L20 18l-5.6 2.6L12 26l-2.4-5.4L4 18l5.6-2.6Z"/><path d="m55 13 1.6 3.6L60 18l-3.4 1.4L55 23l-1.6-3.6L50 18l3.4-1.4Z"/><path d="m54 47 1.2 2.8L58 51l-2.8 1.2L54 55l-1.2-2.8L50 51l2.8-1.2Z"/></svg>',
    })[code] || '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="24"/></svg>';
  }

  // -------------------------------------------------------------------
  // demo data — only reachable with ?demo=1, never in Telegram
  // -------------------------------------------------------------------
  async function demoApi(path, options) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (path === "/public/session") {
      return { user: { first_name: "Вик", preferred_name: "Вик", city: "Пермь", timezone: "Asia/Yekaterinburg", preferred_language: "ru" } };
    }
    if (path === "/public/today") {
      return { today: { main_action: "Закончить план проекта", expected_result: "Готовый план на одну страницу", first_step: "Открыть черновик", goal_title: "Запустить новую версию Евы", work_block_id: "1", work_block_status: "planned" } };
    }
    if (path === "/public/tasks") {
      return { tasks: [{ id: "1", title: "Свести бюджет за неделю", status: "open" }, { id: "2", title: "Позвонить по аренде", status: "in_progress", due_at: "2026-08-02" }] };
    }
    if (path === "/public/goals" && (!options.method || options.method === "GET")) {
      return { goals: [{ id: "1", title: "Запустить новую версию Евы", target_date: "2026-09-01", progress_percent: 42, status: "active", next_result: "Собрать главный экран WebApp", next_step: "Проверить на телефоне", why_it_matters: "Собрать цельный продукт." }] };
    }
    if (path === "/public/goals" && options.method === "POST") {
      return { goal: { id: String(Date.now()), ...JSON.parse(options.body), status: "active" } };
    }
    if (path === "/public/progress") {
      return { progress: { completed_results: [{ title: "Определена структура WebApp", result_artifact: "Техническое задание", completed_at: new Date().toISOString() }], work_blocks: [], goals: [{ title: "Запустить новую версию Евы", progress_percent: 42 }] } };
    }
    if (path === "/public/profile") {
      return { profile: { completeness: .72, user: { preferred_name: "Вик", city: "Пермь", timezone: "Asia/Yekaterinburg", preferred_language: "ru" }, confirmed: [], candidates: [] } };
    }
    return {};
  }
})();
