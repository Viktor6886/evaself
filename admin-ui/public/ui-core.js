/**
 * Общее для всех разделов панели: состояние, доступ к API, диалоги
 * подтверждения и форматирование.
 *
 * Панель — набор обычных скриптов с общей глобальной областью, и порядок
 * подключения в index.html значит ровно то, чем он был в одном файле:
 * этот загружается первым, `ui.js` — последним. Ни одна страница не
 * обращается к переменным другой страницы во время загрузки, только из
 * обработчиков.
 */
const API = "/api/admin/v1";
const ROUTER_DEFAULTS = {
  priority: 100, quality_tier: 3, max_output_tokens: 4096,
  request_timeout_ms: 180000, max_retries: 2, max_concurrency: 8,
};

const state = {
  me: null,
  page: "overview",
  overview: null,
  integration: null,
  settings: null,
  etag: null,
  providers: [],
  router: null,
  settingProfiles: [],
  secrets: [],
  showAllSecrets: false,
  users: [],
  currentUser: null,
  pendingSudo: null,
  pendingConfirm: null,
  events: null,
  refreshTimer: null,
  // Распознавание речи. Схемы кэшируются: они меняются только с
  // выкладкой media-service, а не между переходами по разделам.
  sttSchemas: null,
  sttConfigs: [],
  sttRoutes: [],
  sttEditing: null,
  sttTestingId: null,
  sttSchemaError: null,
  // Разделы единой панели.
  agents: [],
  currentAgent: null,
  currentSubscription: null,
  persona: null,
  personaTab: "persona",
  letta: null,
  lettaTab: "runtime",
  lettaAgentId: null,
  monitoring: null,
};

/**
 * Базовый путь панели.
 *
 * Панель отдаётся с `/admin/` основного домена, и Caddy снимает этот
 * префикс до статики: `/admin/agents` приходит сюда как `/agents` и
 * попадает в index.html через try_files. Значит, адрес раздела —
 * настоящий адрес, его можно скопировать и открыть заново, а не якорь.
 *
 * Префикс вычисляется, а не зашит: браузерные тесты открывают ту же
 * статику с корня, и зашитое `/admin/` увело бы их в несуществующий путь.
 */
const PANEL_BASE = window.location.pathname.replace(/\/[^/]*$/, "/");
const $ = (selector) => document.querySelector(selector);

function csrf() {
  const part = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("eva_admin_csrf="));
  return part ? decodeURIComponent(part.split("=").slice(1).join("=")) : "";
}

async function request(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (!["GET", "HEAD"].includes(options.method || "GET")) {
    headers["X-CSRF-Token"] = csrf();
  }
  const response = await fetch(`${API}${path}`, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  const payload = response.status === 204
    ? null
    : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || "Административный API недоступен",
    );
    error.code = payload?.error?.code;
    error.status = response.status;
    error.details = payload?.error?.details;
    throw error;
  }
  return { payload, response };
}

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.className = "toast";
  }, 4200);
}

function showLogin(message = "") {
  stopLiveUpdates();
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-error").hidden = !message;
  $("#login-error").textContent = message;
}

function showApp(user) {
  state.me = user;
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#account-name").textContent = user.username;
  $("#account-role").textContent = user.role;
  document.body.dataset.role = user.role;
  startLiveUpdates();
}

function localDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function duration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "—";
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return days ? `${days} д ${hours} ч` : hours ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

function bytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let current = size;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char],
  );
}

function handleError(error) {
  if (error.status === 401) {
    showLogin("Сессия завершена. Войдите снова.");
    return;
  }
  if (error.status === 409) {
    toast("Настройки изменены в другой сессии. Обновите страницу.", true);
    return;
  }
  toast(error.message || "Не удалось выполнить действие", true);
}

/**
 * Таблицы на узком экране.
 *
 * Ни одна таблица панели не помещается в 360 пикселей: восемьсот
 * восемьдесят — её минимальная ширина. Раньше она прокручивалась вбок
 * внутри своей рамки; читать так можно, но сравнивать строки — нет:
 * заголовок уезжает вместе с содержимым.
 *
 * Поэтому каждая ячейка получает подпись своего столбца, и CSS ниже 720
 * пикселей раскладывает строку карточкой «подпись — значение». Разметка
 * остаётся таблицей: ни один из тридцати с лишним мест, где панель
 * строит таблицы, переписывать не нужно, и новая таблица получит
 * подписи сама.
 *
 * Наблюдатель, а не вызов после каждой отрисовки: `innerHTML =` в этом
 * файле встречается в трёх десятках мест, и забытый вызов означал бы
 * одну таблицу без подписей — ровно ту, которую не проверили.
 */
function labelTable(table) {
  const headings = [...table.querySelectorAll("thead th")].map(
    (cell) => cell.textContent.trim(),
  );
  if (headings.length === 0) return;
  for (const row of table.querySelectorAll("tbody tr")) {
    [...row.children].forEach((cell, index) => {
      const label = headings[index];
      // Ячейка на всю ширину («Пока нет данных») подписи не получает:
      // подпись столбца к ней не относится.
      if (label && !cell.hasAttribute("colspan")) cell.dataset.label = label;
      else delete cell.dataset.label;
    });
  }
}

function labelTableCells(root) {
  if (root.matches?.("table")) labelTable(root);
  for (const table of root.querySelectorAll?.("table") ?? []) labelTable(table);
}

function watchTables() {
  const root = document.querySelector("#app");
  if (!root) return;
  labelTableCells(root);
  new MutationObserver((records) => {
    const tables = new Set();
    for (const record of records) {
      // Строки чаще всего появляются присвоением innerHTML прямо в
      // tbody: сам tbody при этом не добавляется, и искать таблицу надо
      // от цели изменения, а не только внутри добавленных узлов.
      const nearest = record.target?.closest?.("table");
      if (nearest) tables.add(nearest);
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches("table")) tables.add(node);
        for (const table of node.querySelectorAll("table")) tables.add(table);
      }
    }
    for (const table of tables) labelTable(table);
  }).observe(root, { childList: true, subtree: true });
}

function statusName(status) {
  if (!status.enabled) return "Выключено";
  return {
    healthy: "Работает",
    running: "Запущен",
    checking: "Проверяется",
    degraded: "Требует внимания",
    failed: "Ошибка",
    stopped: "Остановлен",
    disabled: "Выключено",
    unknown: "Нет снимка",
  }[status.state] || status.state;
}

function statusCard(item, options = {}) {
  const status = item.status;
  const checkButton = options.check === false
    ? ""
    : `<button class="button tiny ghost" data-check="${escapeHtml(item.id)}" data-target-type="${escapeHtml(item.type)}">Проверить</button>`;
  // Старт показывается, когда сервис не работает, стоп — когда работает.
  // Перезапуск доступен всегда: он же чинит «работает, но нездоров».
  const managed = item.restartable && ["owner", "admin"].includes(state.me.role);
  const running = ["healthy", "degraded", "running"].includes(item.status.state);
  const restartButton = managed
    ? [
      running
        ? `<button class="button tiny ghost" data-lifecycle="stop" data-service="${escapeHtml(item.id)}">Остановить</button>`
        : `<button class="button tiny primary" data-lifecycle="start" data-service="${escapeHtml(item.id)}">Запустить</button>`,
      `<button class="button tiny secondary" data-lifecycle="restart" data-service="${escapeHtml(item.id)}">Перезапустить</button>`,
    ].join("")
    : "";
  const link = item.public_url
    ? `<a class="button tiny ghost" href="${escapeHtml(item.public_url)}" target="_blank" rel="noreferrer">Открыть ↗</a>`
    : "";
  // Настраиваются только интеграции: у сервисов правится не адрес, а
  // системные настройки, и они живут на своей вкладке.
  const configureButton = item.type === "integration" && ["owner", "admin"].includes(state.me.role)
    ? `<button class="button tiny ghost" data-configure="${escapeHtml(item.id)}">Настроить</button>`
    : "";
  return `
    <article class="status-card color-${escapeHtml(status.color)}">
      <div class="status-card-head">
        <div><span class="status-dot"></span><h3>${escapeHtml(item.title)}</h3></div>
        <span class="state-label">${escapeHtml(statusName(status))}</span>
      </div>
      <p>${escapeHtml(item.purpose)}</p>
      <div class="status-facts">
        <span>Настройка: <strong>${status.configured ? "готова" : "неполная"}</strong></span>
        <span>Проверка: <strong>${escapeHtml(localDate(status.last_check_at))}</strong></span>
        <span>Длительность: <strong>${status.duration_ms == null ? "—" : `${status.duration_ms} мс`}</strong></span>
      </div>
      ${status.message ? `<p class="status-message">${escapeHtml(status.message)}</p>` : ""}
      <div class="card-actions">${checkButton}${configureButton}${restartButton}${link}</div>
    </article>`;
}

function askSudo({ scope, title, description, action }) {
  state.pendingSudo = { scope, action };
  $("#sudo-title").textContent = title;
  $("#sudo-description").textContent = description;
  $("#sudo-form").reset();
  $("#sudo-dialog").showModal();
}

/**
 * Подтверждение опасной операции.
 *
 * `expected` задаёт контрольное слово: его вводят там, где ошибка
 * необратима. Без него окно остаётся тем же — с описанием последствий и
 * разнесёнными кнопками, — но набирать ничего не нужно. Это заменило
 * `window.confirm`: системное окно на телефоне появляется у верхнего
 * края, где палец уже стоит после нажатия, и последствий не объясняет.
 */
function askConfirm({ title, description, expected = null, action }) {
  state.pendingConfirm = { expected, action };
  $("#confirm-title").textContent = title;
  $("#confirm-description").textContent = expected
    ? `${description} Введите ${expected}.`
    : description;
  $("#confirm-form").reset();
  $("#confirm-input-label").hidden = !expected;
  $("#confirm-form").elements.confirmation.required = Boolean(expected);
  $("#confirm-dialog").showModal();
  // Фокус на отмене: случайный Enter отменяет, а не выполняет.
  $("#confirm-form").querySelector('button[value="cancel"]').focus();
}

$("#sudo-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (event.submitter?.value === "cancel") {
    state.pendingSudo = null;
    $("#sudo-dialog").close();
    return;
  }
  const pending = state.pendingSudo;
  if (!pending) return;
  const password = new FormData(form).get("password");
  request("/sudo", {
    method: "POST",
    body: JSON.stringify({ password, scope: pending.scope }),
  }).then(async () => {
    $("#sudo-dialog").close();
    form.reset();
    state.pendingSudo = null;
    await pending.action();
  }).catch(handleError);
});
$("#confirm-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    state.pendingConfirm = null;
    $("#confirm-dialog").close();
    return;
  }
  const form = event.currentTarget;
  const pending = state.pendingConfirm;
  if (!pending) return;
  if (pending.expected && form.elements.confirmation.value !== pending.expected) {
    toast(`Введите ${pending.expected} без изменений`, true);
    return;
  }
  $("#confirm-dialog").close();
  form.reset();
  state.pendingConfirm = null;
  Promise.resolve(pending.action()).catch(handleError);
});
