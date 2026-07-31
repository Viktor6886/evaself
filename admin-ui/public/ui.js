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
};
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

const LOADERS = {
  overview: loadOverview,
  services: loadServicesAndIntegrations,
  ai: loadProviders,
  operations: loadOperations,
  users: loadUsers,
  settings: loadSettings,
  security: loadSecrets,
  audit: loadAudit,
};

function openPage(name) {
  state.page = name;
  document.querySelectorAll(".page").forEach((item) => {
    item.classList.toggle("active", item.id === `page-${name}`);
  });
  document.querySelectorAll(".nav-item[data-page]").forEach((item) => {
    item.classList.toggle("active", item.dataset.page === name);
  });
  $(".sidebar").classList.remove("open");
  LOADERS[name]?.().catch(handleError);
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

async function loadOverview() {
  const { payload } = await request("/overview");
  state.overview = payload;
  $("#system-version").textContent = payload.installation.version;
  renderVerdict(payload);
  renderHostBar(payload);
  renderOverviewGroups(payload);
}

/**
 * Сводный индикатор. В норме — короткая фраза и ровный зелёный пульс,
 * без перечисления сервисов: если всё работает, их параметры не нужны.
 * При сбое называет конкретный сервис, а не «система требует внимания».
 */
function renderVerdict(payload) {
  const failing = payload.failing || [];
  const verdict = $("#verdict");
  const action = $("#verdict-action");
  verdict.className = `verdict color-${payload.overall_status}`;

  $("#system-dot").className = `color-${payload.overall_status}`;
  $("#system-label").textContent = failing.length
    ? `Не в порядке: ${failing[0].title}`
    : "Все сервисы работают";

  if (!failing.length) {
    $("#verdict-title").textContent = "Все сервисы работают";
    $("#verdict-detail").textContent = payload.last_backup
      ? `Последний backup: ${localDate(payload.last_backup.created_at)}`
      : "Backup ещё не создавался";
    action.hidden = true;
    return;
  }

  const red = failing.filter((item) => item.color === "red");
  const head = failing[0];
  $("#verdict-title").textContent = red.length
    ? `Не работает: ${red.map((item) => item.title).join(", ")}`
    : `Требует внимания: ${head.title}`;
  const rest = failing.length - (red.length || 1);
  $("#verdict-detail").textContent = [
    head.message || `состояние: ${head.state}`,
    rest > 0 ? `и ещё ${rest} — в списке ошибок` : "",
  ].filter(Boolean).join(" · ");
  action.hidden = false;
}

/** Сервер одной компактной строкой вместо шести карточек. */
function renderHostBar(payload) {
  const host = payload.host || {};
  const usedMemory = Number(host.memory_total_bytes) - Number(host.memory_free_bytes);
  const usedDisk = Number(host.disk_total_bytes) - Number(host.disk_free_bytes);
  const load = Array.isArray(host.load_average) ? Number(host.load_average[0]) : null;
  const cpus = Number(host.cpu_count) || 1;
  const cells = [
    ["CPU", load === null ? "—" : `${Math.round((load / cpus) * 100)}%`, `load ${load === null ? "—" : load.toFixed(2)} на ${cpus} ядер`],
    ["RAM", percent(usedMemory, host.memory_total_bytes), `${bytes(usedMemory)} из ${bytes(host.memory_total_bytes)}`],
    ["Диск", percent(usedDisk, host.disk_total_bytes), `свободно ${bytes(host.disk_free_bytes)}`],
    ["Сеть", host.network_rx_bytes === undefined ? "—" : `${bytes(host.network_rx_bytes)} ↓`, host.network_tx_bytes === undefined ? "нет данных" : `${bytes(host.network_tx_bytes)} ↑`],
    ["Uptime", duration(host.uptime_seconds), escapeHtml(host.hostname || "сервер")],
  ];
  $("#host-bar").innerHTML = cells
    .map(([label, value, hint]) => `
      <div class="host-cell" title="${escapeHtml(hint)}">
        <span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>
      </div>`)
    .join("");
}

function percent(used, total) {
  const value = Number(total);
  if (!Number.isFinite(value) || value <= 0) return "—";
  return `${Math.round((Number(used) / value) * 100)}%`;
}

const GROUP_NAMES = {
  core: "Основное ядро",
  storage: "Хранилища",
  ai: "Внутренние AI-сервисы",
  external: "Внешние интеграции",
  infrastructure: "Инфраструктура",
};

/**
 * Карточки раскрываются нажатием: подробности живут внутри <details>, а
 * в свёрнутом виде остаются только название и цвет. Нативный <details>
 * взят намеренно — он доступен с клавиатуры и не требует состояния в JS.
 */
function renderOverviewGroups(payload) {
  $("#overview-groups").innerHTML = Object.entries(payload.groups)
    .map(([name, items]) => `
      <section class="overview-group">
        <div class="section-heading">
          <div><h3>${escapeHtml(GROUP_NAMES[name] || name)}</h3></div>
          <span class="group-count" title="Сколько из них сейчас в норме">${items.filter((i) => i.status.color === "green").length} из ${items.length} в норме</span>
        </div>
        <div class="mini-status-list">${items.map(overviewRow).join("")}</div>
      </section>`)
    .join("");
}

function overviewRow(item) {
  const status = item.status;
  const rows = [
    ["Состояние", statusName(status)],
    ["Сообщение", status.message || "—"],
    ["Последняя проверка", status.last_check_at ? localDate(status.last_check_at) : "—"],
    ["Последний успех", status.last_ok_at ? localDate(status.last_ok_at) : "—"],
    ["Контейнер", status.container || "—"],
  ];
  return `
    <details class="mini-status">
      <summary>
        <span class="status-dot color-${escapeHtml(status.color)}"></span>
        <strong>${escapeHtml(item.title)}</strong>
        <span class="mini-hint">${escapeHtml(item.purpose)}</span>
      </summary>
      <dl class="mini-details">
        ${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
      </dl>
      <div class="mini-actions">
        <button class="button tiny ghost" data-goto-service="${escapeHtml(item.id)}">Открыть в разделе</button>
      </div>
    </details>`;
}

/** Кнопка «Ошибки»: конкретные события со временем и сервисом. */
async function showErrors() {
  const { payload } = await request("/errors?hours=24&limit=50");
  $("#errors-window").textContent = payload.count
    ? `${payload.count} за последние ${payload.hours} ч`
    : `За последние ${payload.hours} ч ошибок нет`;
  const labels = { operation: "операция", check: "проверка", status: "состояние" };
  $("#errors-list").innerHTML = payload.items.length
    ? payload.items.map((item) => `
        <article class="error-row">
          <div class="error-head">
            <strong>${escapeHtml(item.title)}</strong>
            <span class="error-kind">${escapeHtml(labels[item.source] || item.source)}</span>
          </div>
          <p>${escapeHtml(item.message)}</p>
          <small>${escapeHtml(localDate(item.at))}${item.actor ? ` · ${escapeHtml(item.actor)}` : ""}</small>
        </article>`).join("")
    : '<p class="muted">Ошибок за это окно не зафиксировано.</p>';
  $("#errors-dialog").showModal();
}

async function loadServicesAndIntegrations() {
  const [services, integrations] = await Promise.all([
    request("/services"),
    request("/integrations"),
  ]);
  $("#services-list").innerHTML = services.payload.services
    .map((item) => statusCard(item))
    .join("");
  $("#integrations-list").innerHTML = integrations.payload.integrations
    .map((item) => statusCard(item))
    .join("");
  applyLettaLink(services.payload.services);
}

/**
 * Ссылка «Открыть Letta» в боковом меню. Раньше в разметке стоял домен
 * одной конкретной установки, поэтому у всех остальных кнопка вела в
 * никуда. Берём адрес оттуда же, откуда его берут карточки сервисов.
 */
function applyLettaLink(services) {
  const link = $("#letta-link");
  if (!link) return;
  const letta = services.find((item) => item.id === "letta-ui");
  if (letta?.public_url) {
    link.href = letta.public_url;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

/* ---------------------------------------------------------------------
 * Редактор интеграции (2.3)
 * ------------------------------------------------------------------- */
const FIELD_STATE_LABELS = {
  green: "работает", yellow: "требует внимания", red: "ошибка",
  blue: "проверяется", gray: "выключено",
};

async function openIntegration(id) {
  const { payload } = await request(`/integrations/${encodeURIComponent(id)}/config`);
  state.integration = payload;
  $("#integration-title").textContent = payload.title;
  $("#integration-purpose").textContent = payload.purpose;

  const check = payload.last_check;
  const statusNode = $("#integration-status");
  statusNode.className = `integration-status color-${check ? check.color : "gray"}`;
  statusNode.textContent = check
    ? `Последняя проверка: ${FIELD_STATE_LABELS[check.color] || check.state}` +
      `${check.checked_at ? ` · ${localDate(check.checked_at)}` : ""}` +
      `${check.message ? ` · ${check.message}` : ""}`
    : "Проверок ещё не было";

  const note = $("#integration-note");
  const parts = [];
  if (payload.note) parts.push(payload.note);
  if (payload.restart_required) {
    // Значения читают контейнеры при старте — об этом надо сказать
    // прямо, иначе администратор ждёт мгновенного эффекта.
    parts.push(`Изменения вступят в силу после перезапуска «${payload.restart_required}».`);
  }
  note.textContent = parts.join(" ");
  note.hidden = parts.length === 0;

  $("#integration-form").innerHTML = payload.editable
    ? payload.fields.map(integrationField).join("")
    : '<p class="muted">У этой интеграции нет настраиваемых полей: она работает на внутренних значениях установки.</p>';
  $("#integration-save").hidden = !payload.editable;
  const testBox = $("#integration-test-result");
  testBox.hidden = true;
  testBox.textContent = "";
  $("#integration-check").textContent = ["asr", "tts"].includes(id)
    ? (id === "tts" ? "Проверить синтез" : "Проверить распознавание")
    : "Проверить соединение";
  $("#integration-dialog").showModal();
}

function integrationField(field) {
  const mark = field.configured
    ? '<span class="field-ok">настроен</span>'
    : (field.required ? '<span class="field-missing">не задан</span>' : "");
  if (field.kind === "select") {
    const options = (field.options || [])
      .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === field.value ? " selected" : ""}>${escapeHtml(option.title)}</option>`)
      .join("");
    return `<label><span>${escapeHtml(field.title)} ${mark}</span>
      <select name="${escapeHtml(field.name)}"><option value="">—</option>${options}</select>
      <small>${escapeHtml(field.hint)}</small></label>`;
  }
  // У секрета поле всегда пустое: текущее значение не показывается, а
  // пустое поле означает «оставить как есть».
  const type = field.kind === "secret" ? "password" : "text";
  const value = field.kind === "secret" ? "" : (field.value || "");
  const placeholder = field.kind === "secret"
    ? (field.configured ? "оставьте пустым, чтобы не менять" : "введите значение")
    : (field.placeholder || "");
  return `<label><span>${escapeHtml(field.title)} ${mark}</span>
    <input type="${type}" name="${escapeHtml(field.name)}" value="${escapeHtml(value)}"
      placeholder="${escapeHtml(placeholder)}"${field.kind === "secret" ? ' autocomplete="new-password"' : ""}>
    <small>${escapeHtml(field.hint)}</small></label>`;
}

async function runIntegrationTest(id) {
  const button = $("#integration-check");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = id === "tts" ? "Синтезирую…" : "Распознаю…";
  const box = $("#integration-test-result");
  box.hidden = false;
  box.className = "integration-test";
  box.textContent = "Идёт проверка у провайдера, это занимает несколько секунд…";
  try {
    const { payload } = await request(`/integrations/${encodeURIComponent(id)}/test`, {
      method: "POST",
    });
    box.className = `integration-test ${payload.ok ? "is-ok" : "is-fail"}`;
    box.textContent = payload.ok
      ? [
        payload.message,
        payload.latency_ms != null ? `${payload.latency_ms} мс` : "",
        payload.model ? `модель ${payload.model}` : "",
        payload.voice ? `голос ${payload.voice}` : "",
        // Пустая расшифровка тестового тона — нормальный результат, и об
        // этом надо сказать, иначе выглядит как поломка.
        id === "asr" ? `расшифровка: ${payload.transcript ? `«${payload.transcript}»` : "пусто, в тестовом сигнале нет речи"}` : "",
      ].filter(Boolean).join(" · ")
      : `Не прошло: ${payload.message || "провайдер не ответил"}`;
  } catch (error) {
    box.className = "integration-test is-fail";
    box.textContent = `Не прошло: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function saveIntegration() {
  const id = state.integration?.id;
  if (!id) return;
  const form = $("#integration-form");
  const body = {};
  for (const [key, value] of new FormData(form).entries()) body[key] = String(value);
  askSudo({
    scope: "secrets:write",
    title: "Сохранить настройки интеграции",
    description: "Значения без секретов попадут в настройки установки, ключи — в Secret Store.",
    action: async () => {
      const { payload } = await request(`/integrations/${encodeURIComponent(id)}/config`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      // Для ASR/TTS значения применяются на лету; если не доехали —
      // сказать прямо, а не оставить администратора в уверенности, что
      // всё работает.
      if (payload.applied_live === false && payload.apply_error) {
        toast(`Сохранено, но сервис не принял значения: ${payload.apply_error}`, true);
      } else if (payload.applied_live) {
        toast("Настройки сохранены и применены без перезапуска");
      } else {
        toast("Настройки сохранены");
      }
      await openIntegration(id);
      await loadServicesAndIntegrations();
    },
  });
}

async function startCheck(targetType, id) {
  const plural = targetType === "service" ? "services" : "integrations";
  const { payload } = await request(`/${plural}/${encodeURIComponent(id)}/check`, {
    method: "POST",
  });
  toast("Проверка поставлена в очередь");
  await pollCheck(payload.check_id);
}

async function pollCheck(id) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { payload } = await request(`/checks/${encodeURIComponent(id)}`);
    if (["success", "failure"].includes(payload.check.status)) {
      toast(
        payload.check.status === "success"
          ? "Проверка завершена успешно"
          : payload.check.error_message_short || "Проверка завершилась ошибкой",
        payload.check.status !== "success",
      );
      await loadServicesAndIntegrations();
      return;
    }
  }
  toast("Проверка продолжается в фоне");
}

function askSudo({ scope, title, description, action }) {
  state.pendingSudo = { scope, action };
  $("#sudo-title").textContent = title;
  $("#sudo-description").textContent = description;
  $("#sudo-form").reset();
  $("#sudo-dialog").showModal();
}

const LIFECYCLE_LABELS = {
  start: { verb: "Запуск", title: "Запустить сервис",
    description: "Контейнер будет запущен. Данные и volumes не затрагиваются." },
  stop: { verb: "Остановка", title: "Остановить сервис",
    description: "Контейнер будет остановлен штатно. Данные сохраняются; функции, зависящие от сервиса, станут недоступны." },
  restart: { verb: "Перезапуск", title: "Перезапустить сервис",
    description: "Контейнер будет штатно перезапущен; его persistent volumes не удаляются." },
};

async function lifecycleService(action, id) {
  const { payload } = await request(`/services/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
  });
  toast(`${LIFECYCLE_LABELS[action].verb} принят. Состояние обновится автоматически.`);
  await pollOperation(payload.operation_id);
}

async function pollOperation(id) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const { payload } = await request(`/operations/${encodeURIComponent(id)}`);
    if (["success", "failure", "rolled_back"].includes(payload.operation.status)) {
      const ok = payload.operation.status === "success";
      toast(
        ok ? "Операция успешно завершена" : payload.operation.error_message || "Операция не выполнена",
        !ok,
      );
      LOADERS[state.page]?.().catch(handleError);
      return;
    }
  }
  toast("Операция продолжается в фоне");
}

async function loadProviders() {
  const [list, router] = await Promise.all([
    request("/providers?kind=llm"),
    // Роутер мог ещё не получить ни одного запроса — тогда состояние
    // пустое, но страница всё равно должна открыться.
    request("/llm/state").catch(() => ({ payload: { providers: [], routes: [], recent_failures: [] } })),
  ]);
  state.providers = Array.isArray(list.payload.providers) ? list.payload.providers : [];
  state.router = router.payload;

  renderRouterRoutes();
  renderRouterHealth();
  renderRouterFailures();

  $("#providers-list").innerHTML = state.providers.length
    ? state.providers.map(providerCard).join("")
    : '<article class="empty-card"><h3>LLM-провайдер ещё не добавлен</h3><p>Добавьте первую конфигурацию — до тех пор Ева не сможет ответить.</p></article>';
}

const ROUTE_TITLES = {
  chat: "Разговор", deep: "Глубокий анализ",
  tools: "Работа с инструментами", json: "Строгий JSON",
};

/**
 * Цепочка маршрута. Позиция 0 — основной, дальше резервы. Порядок
 * меняется стрелками и уходит одним PUT: сервер принимает список
 * целиком, поэтому перестановка не может оставить дыру в нумерации.
 */
function renderRouterRoutes() {
  const routes = state.router?.routes || [];
  const editable = ["owner", "admin"].includes(state.me.role);
  $("#router-routes").innerHTML = routes.length
    ? routes.map((route) => {
      const chain = route.chain || [];
      const requires = [
        route.requires_tools ? "инструменты" : "",
        route.requires_json ? "строгий JSON" : "",
        route.requires_streaming ? "поток" : "",
        `контекст от ${Number(route.min_context_window).toLocaleString("ru-RU")}`,
      ].filter(Boolean).join(" · ");
      return `
        <section class="route-block" data-route="${escapeHtml(route.code)}">
          <div class="route-head">
            <h4>${escapeHtml(ROUTE_TITLES[route.code] || route.title || route.code)}</h4>
            <span class="route-requires">требует: ${escapeHtml(requires)}</span>
          </div>
          ${chain.length ? `<ol class="chain">${chain.map((link, index) => `
            <li class="chain-link${link.enabled ? "" : " is-off"}">
              <span class="chain-rank">${index === 0 ? "основной" : `резерв ${index}`}</span>
              <span class="chain-name"><strong>${escapeHtml(link.name)}</strong><small>${escapeHtml(link.model)} · ${escapeHtml(link.protocol)}</small></span>
              ${editable ? `<span class="chain-move">
                <button class="button tiny ghost" data-chain-move="up" data-route="${escapeHtml(route.code)}" data-provider="${escapeHtml(link.provider_id)}"${index === 0 ? " disabled" : ""}>↑</button>
                <button class="button tiny ghost" data-chain-move="down" data-route="${escapeHtml(route.code)}" data-provider="${escapeHtml(link.provider_id)}"${index === chain.length - 1 ? " disabled" : ""}>↓</button>
                <button class="button tiny danger-outline" data-chain-remove="${escapeHtml(link.provider_id)}" data-route="${escapeHtml(route.code)}">Убрать</button>
              </span>` : ""}
            </li>`).join("")}</ol>`
            : '<p class="muted">Цепочка пуста — маршрут не обслуживается.</p>'}
          ${editable ? chainAdder(route, chain) : ""}
        </section>`;
    }).join("")
    : '<p class="muted">Маршруты появятся после применения миграций роутера.</p>';
}

function chainAdder(route, chain) {
  const used = new Set(chain.map((link) => link.provider_id));
  const free = state.providers.filter((item) => !used.has(item.id));
  if (chain.length >= 6) {
    return '<p class="muted">Достигнут предел: основной и пять резервов.</p>';
  }
  if (free.length === 0) return "";
  return `<div class="chain-add">
    <select data-chain-add-select="${escapeHtml(route.code)}">
      ${free.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} — ${escapeHtml(item.model)}</option>`).join("")}
    </select>
    <button class="button tiny secondary" data-chain-add="${escapeHtml(route.code)}">Добавить в конец</button>
  </div>`;
}

const BREAKER_LABELS = {
  closed: { title: "работает", color: "green" },
  open: { title: "закрыт после ошибок", color: "red" },
  half_open: { title: "пробный запрос", color: "yellow" },
};

function renderRouterHealth() {
  const rows = state.router?.providers || [];
  const editable = ["owner", "admin"].includes(state.me.role);
  $("#router-health").innerHTML = rows.length
    ? rows.map((row) => {
      const breaker = BREAKER_LABELS[row.breaker_state] || BREAKER_LABELS.closed;
      const failures = Number(row.failures_1h || 0);
      const requests = Number(row.requests_1h || 0);
      return `
        <article class="health-row">
          <div class="health-head">
            <span class="status-dot color-${row.pinned_out ? "gray" : breaker.color}"></span>
            <div>
              <strong>${escapeHtml(row.name)}</strong>
              <small>${escapeHtml(row.model)} · приоритет ${row.priority}${row.enabled ? "" : " · выключен"}</small>
            </div>
            <span class="health-state">${row.pinned_out ? "снят вручную" : escapeHtml(breaker.title)}</span>
          </div>
          <dl class="health-facts">
            <div><dt>Запросов за час</dt><dd>${requests}${failures ? ` · ошибок ${failures}` : ""}</dd></div>
            <div><dt>Задержка p95</dt><dd>${row.p95_latency_ms == null ? "нет данных" : `${row.p95_latency_ms} мс`}</dd></div>
            <div><dt>Потрачено сегодня</dt><dd>${money(row.spent_today_micro)}${row.daily_budget_micro ? ` из ${money(row.daily_budget_micro)}` : " · без лимита"}</dd></div>
            <div><dt>Потрачено за месяц</dt><dd>${money(row.spent_month_micro)}${row.monthly_budget_micro ? ` из ${money(row.monthly_budget_micro)}` : " · без лимита"}</dd></div>
            ${row.last_error_code ? `<div><dt>Последняя ошибка</dt><dd>${escapeHtml(row.last_error_code)}</dd></div>` : ""}
            ${row.probe_after ? `<div><dt>Пробный запрос после</dt><dd>${escapeHtml(localDate(row.probe_after))}</dd></div>` : ""}
          </dl>
          ${editable ? `<div class="card-actions">
            ${row.breaker_state === "closed" ? "" : `<button class="button tiny secondary" data-breaker-reset="${escapeHtml(row.id)}">Вернуть в строй</button>`}
            <button class="button tiny ghost" data-pin="${row.pinned_out ? "off" : "on"}" data-provider="${escapeHtml(row.id)}">${row.pinned_out ? "Вернуть автовозврат" : "Снять с автовозврата"}</button>
          </div>` : ""}
        </article>`;
    }).join("")
    : '<p class="muted">Роутер ещё не обслуживал запросы.</p>';
}

/** Микроединицы валюты в доллары. */
function money(micro) {
  const value = Number(micro || 0) / 1_000_000;
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function renderRouterFailures() {
  const rows = state.router?.recent_failures || [];
  $("#router-failures").innerHTML = rows.length
    ? rows.map((row) => `
      <article class="compact-row">
        <span class="status-dot color-red"></span>
        <span>
          <strong>${escapeHtml(row.provider || "провайдер не выбран")}</strong>
          <small>${escapeHtml(SWITCH_REASONS[row.switch_reason] || row.switch_reason || "ошибка")}${row.http_status ? ` · HTTP ${row.http_status}` : ""} · ${escapeHtml(localDate(row.started_at))}</small>
        </span>
        <span class="failure-detail">${escapeHtml(row.error_summary || "")}</span>
      </article>`).join("")
    : '<p class="muted">Отказов не зафиксировано.</p>';
}

const SWITCH_REASONS = {
  rate_limited: "лимит запросов провайдера",
  server_error: "ошибка на стороне провайдера",
  connection_failed: "нет соединения",
  timeout: "таймаут",
  empty_response: "пустой ответ",
  invalid_response: "нечитаемый ответ",
  model_error: "модель отклонила запрос",
  quota_exhausted: "исчерпана квота или баланс",
  budget_exceeded: "превышен бюджет",
  json_contract_failed: "ответ не JSON",
  tool_calls_failed: "сломанный вызов инструмента",
  latency_exceeded: "слишком долгий ответ",
  breaker_open: "circuit breaker закрыт",
  incompatible: "не подходит по возможностям",
};

async function moveChain(routeCode, providerId, direction) {
  const route = (state.router?.routes || []).find((item) => item.code === routeCode);
  if (!route) return;
  const ids = (route.chain || []).map((link) => link.provider_id);
  const at = ids.indexOf(providerId);
  const to = direction === "up" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= ids.length) return;
  [ids[at], ids[to]] = [ids[to], ids[at]];
  await saveChain(routeCode, ids);
}

async function saveChain(routeCode, providerIds) {
  await request(`/llm/routes/${encodeURIComponent(routeCode)}/chain`, {
    method: "PUT",
    body: JSON.stringify({ providers: providerIds }),
  });
  toast("Цепочка сохранена");
  await loadProviders();
}

function providerCard(item) {
  const checkClass = item.last_check_ok === true
    ? "green"
    : item.last_check_ok === false
      ? "red"
      : "yellow";
  return `
    <article class="provider-card${item.is_active ? " active" : ""}">
      <div class="provider-title">
        <div><span class="status-dot color-${checkClass}"></span><div><h3>${escapeHtml(item.name)}</h3><span class="technical">${escapeHtml(item.protocol)}</span></div></div>
        ${item.is_active ? '<span class="status-pill">Активен</span>' : ""}
      </div>
      <div class="provider-details">
        <span>Base URL<strong>${escapeHtml(item.base_url)}</strong></span>
        <span>Модель<strong>${escapeHtml(item.model)}</strong></span>
        <span>Context<strong>${Number(item.context_window).toLocaleString("ru-RU")}</strong></span>
        <span>Последний тест<strong>${escapeHtml(localDate(item.last_checked_at))}</strong></span>
      </div>
      <p class="status-message">${escapeHtml(item.last_check_message || "Подключение ещё не проверялось")}</p>
      <div class="card-actions">
        <button class="button tiny ghost" data-provider-action="check" data-provider-id="${escapeHtml(item.id)}">Проверить</button>
        <button class="button tiny ghost" data-provider-action="models" data-provider-id="${escapeHtml(item.id)}">Получить модели</button>
        <button class="button tiny ghost" data-provider-action="edit" data-provider-id="${escapeHtml(item.id)}">Изменить</button>
        ${item.is_active ? "" : `<button class="button tiny secondary" data-provider-action="activate" data-provider-id="${escapeHtml(item.id)}">Сделать активным</button><button class="button tiny danger-outline" data-provider-action="delete" data-provider-id="${escapeHtml(item.id)}">Удалить</button>`}
      </div>
    </article>`;
}

function openProviderEditor(provider = null) {
  const form = $("#provider-form");
  form.reset();
  form.elements.id.value = provider?.id || "";
  form.elements.name.value = provider?.name || "";
  form.elements.protocol.value = provider?.protocol || "openai-compatible";
  form.elements.base_url.value = provider?.base_url || "";
  form.elements.model.value = provider?.model || "";
  form.elements.context_window.value = provider?.context_window || 32768;
  form.elements.timeout_ms.value =
    provider?.additional_parameters?.request_timeout_ms || 180000;
  form.elements.additional_parameters.value = JSON.stringify(
    provider?.additional_parameters || {},
    null,
    2,
  );

  // Поля маршрутизации живут в таблице роутера, а не в
  // additional_parameters: подставляем их из /llm/state.
  const routing = (state.router?.providers || []).find((item) => item.id === provider?.id);
  const full = ROUTER_DEFAULTS;
  const set = (name, value) => { if (form.elements[name]) form.elements[name].value = value; };
  const flag = (name, value) => { if (form.elements[name]) form.elements[name].checked = value; };
  set("priority", routing?.priority ?? full.priority);
  set("quality_tier", provider?.quality_tier ?? full.quality_tier);
  set("max_output_tokens", provider?.max_output_tokens ?? full.max_output_tokens);
  set("request_timeout_ms", provider?.additional_parameters?.request_timeout_ms ?? full.request_timeout_ms);
  set("max_retries", provider?.max_retries ?? full.max_retries);
  set("max_concurrency", provider?.max_concurrency ?? full.max_concurrency);
  set("max_rpm", provider?.max_rpm ?? "");
  set("max_tpm", provider?.max_tpm ?? "");
  set("price_in", microToUnits(provider?.price_in_micro));
  set("price_out", microToUnits(provider?.price_out_micro));
  set("daily_budget", provider?.daily_budget_micro == null ? "" : microToUnits(provider.daily_budget_micro));
  set("monthly_budget", provider?.monthly_budget_micro == null ? "" : microToUnits(provider.monthly_budget_micro));
  flag("supports_tools", provider?.supports_tools ?? true);
  flag("supports_json", provider?.supports_json ?? true);
  flag("supports_streaming", provider?.supports_streaming ?? true);
  flag("supports_vision", provider?.supports_vision ?? false);
  // Умолчание совпадает со схемой: провайдера заводит оператор, и это и
  // есть решение о доверии. Снятая галочка у нового провайдера означала
  // бы, что роутер отвергнет весь его трафик как чувствительный.
  flag("sensitive_data_allowed", provider?.sensitive_data_allowed ?? true);
  flag("enabled", provider?.enabled ?? true);
  form.elements.api_key.required = !provider;
  $("#provider-editor-title").textContent = provider
    ? `Изменить «${provider.name}»`
    : "Новый LLM-провайдер";
  $("#provider-editor").hidden = false;
  $("#provider-editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveProvider(form) {
  let additional;
  try {
    additional = JSON.parse(form.elements.additional_parameters.value || "{}");
  } catch {
    throw new Error("Дополнительные параметры должны быть JSON-объектом");
  }
  if (!additional || Array.isArray(additional) || typeof additional !== "object") {
    throw new Error("Дополнительные параметры должны быть JSON-объектом");
  }
  additional.request_timeout_ms = Number(form.elements.timeout_ms.value);
  const id = form.elements.id.value;
  const body = {
    name: form.elements.name.value.trim(),
    protocol: form.elements.protocol.value,
    base_url: form.elements.base_url.value.trim(),
    model: form.elements.model.value.trim(),
    context_window: Number(form.elements.context_window.value),
    additional_parameters: additional,
  };
  if (form.elements.api_key.value) body.api_key = form.elements.api_key.value;
  const saved = await request(id ? `/providers/${encodeURIComponent(id)}` : "/providers", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(body),
  });
  // Поля маршрутизации хранятся отдельно и требуют id, который у нового
  // провайдера появляется только сейчас.
  await saveRoutingFields(form, id || saved.payload?.id);

  form.elements.api_key.value = "";
  $("#provider-editor").hidden = true;
  toast(id ? "Провайдер обновлён" : "Провайдер создан");
  await loadProviders();
}

function microToUnits(micro) {
  return micro == null ? 0 : Number(micro) / 1_000_000;
}

function unitsToMicro(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num * 1_000_000) : 0;
}

/** Поля маршрутизации отправляются отдельным PATCH в API роутера. */
async function saveRoutingFields(form, providerId) {
  const nullableNumber = (name) => {
    const raw = form.elements[name]?.value;
    return raw === undefined || raw === "" ? null : Number(raw);
  };
  const body = {
    priority: Number(form.elements.priority.value),
    quality_tier: Number(form.elements.quality_tier.value),
    max_output_tokens: Number(form.elements.max_output_tokens.value),
    request_timeout_ms: Number(form.elements.request_timeout_ms.value),
    max_retries: Number(form.elements.max_retries.value),
    max_concurrency: Number(form.elements.max_concurrency.value),
    max_rpm: nullableNumber("max_rpm"),
    max_tpm: nullableNumber("max_tpm"),
    price_in_micro: unitsToMicro(form.elements.price_in.value),
    price_out_micro: unitsToMicro(form.elements.price_out.value),
    daily_budget_micro: form.elements.daily_budget.value === "" ? null : unitsToMicro(form.elements.daily_budget.value),
    monthly_budget_micro: form.elements.monthly_budget.value === "" ? null : unitsToMicro(form.elements.monthly_budget.value),
    supports_tools: form.elements.supports_tools.checked,
    supports_json: form.elements.supports_json.checked,
    supports_streaming: form.elements.supports_streaming.checked,
    supports_vision: form.elements.supports_vision.checked,
    sensitive_data_allowed: form.elements.sensitive_data_allowed.checked,
    enabled: form.elements.enabled.checked,
  };
  await request(`/llm/providers/${encodeURIComponent(providerId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function providerAction(action, id) {
  const provider = state.providers.find((item) => item.id === id);
  if (!provider) return;
  if (action === "edit") {
    openProviderEditor(provider);
    return;
  }
  if (action === "check") {
    const { payload } = await request(`/providers/${encodeURIComponent(id)}/check`, {
      method: "POST",
    });
    toast(payload.result?.message || "Проверка завершена", !payload.result?.ok);
    await loadProviders();
    return;
  }
  if (action === "models") {
    const { payload } = await request(`/providers/${encodeURIComponent(id)}/models/fetch`, {
      method: "POST",
    });
    const models = payload.result?.models || [];
    toast(models.length
      ? `Получено моделей: ${models.length}. Первые: ${models.slice(0, 5).map((item) => item.id).join(", ")}`
      : payload.result?.message || "Endpoint /models не вернул модели");
    await loadProviders();
    return;
  }
  if (action === "activate") {
    askSudo({
      scope: "providers:activate",
      title: "Переключить активную LLM",
      description: "Runtime проверит новую модель, обновит существующие агенты и выполнит rollback при ошибке.",
      action: async () => {
        toast("Переключение модели началось");
        await request(`/providers/${encodeURIComponent(id)}/activate`, { method: "POST" });
        toast("Новая модель активирована; агенты и память сохранены");
        await loadProviders();
      },
    });
    return;
  }
  if (action === "delete") {
    askConfirm({
      title: `Удалить «${provider.name}»?`,
      description: "Удалить можно только неактивную конфигурацию. Сохранённые агенты не изменятся.",
      expected: "DELETE",
      action: async () => {
        await request(`/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast("Неактивная конфигурация удалена");
        await loadProviders();
      },
    });
  }
}

function askConfirm({ title, description, expected, action }) {
  state.pendingConfirm = { expected, action };
  $("#confirm-title").textContent = title;
  $("#confirm-description").textContent = `${description} Введите ${expected}.`;
  $("#confirm-form").reset();
  $("#confirm-dialog").showModal();
}

async function loadOperations() {
  const [backups, updates] = await Promise.all([
    request("/backups"),
    request("/updates"),
  ]);
  const items = backups.payload.backups || [];
  const current = updates.payload.current || {};

  $("#backups-list").innerHTML = items.length
    ? items.map((item) => `
      <article class="compact-row">
        <span class="status-dot color-${escapeHtml(BACKUP_COLORS[item.status] || "blue")}"></span>
        <span><strong>${escapeHtml(item.archive_id)}</strong><small>${escapeHtml(localDate(item.created_at))} · ${bytes(item.size)}</small></span>
        <span class="tag ${item.encrypted ? "safe" : ""}">${item.encrypted ? "зашифрован" : "legacy"}</span>
      </article>`).join("")
    : '<p class="muted">Архивов пока нет. Первый можно создать кнопкой выше.</p>';

  // Значения без пояснения читаются неверно: «dirty» звучит как мелочь,
  // хотя блокирует обновление, а пустое «Доступно обновлений» означает
  // «никто ещё не спрашивал», а не «обновлений нет».
  $("#update-info").innerHTML = `
    <dl class="details-list">
      <div><dt>Ветка</dt><dd>${escapeHtml(current.branch || "неизвестна")}</dd></div>
      <div><dt>Развёрнутый commit</dt><dd class="technical">${escapeHtml(String(current.commit || "неизвестен").slice(0, 12))}</dd></div>
      <div><dt>Незакоммиченные правки на сервере</dt>
        <dd>${current.dirty
          ? '<span class="warn-value">есть — обновление будет заблокировано</span>'
          : "нет"}</dd></div>
      <div><dt>Доступно обновлений</dt>
        <dd>${current.update_available == null
          ? "неизвестно — нажмите «Проверить обновления»"
          : current.update_available
            ? escapeHtml(current.available_components || "есть")
            : "нет, установлена последняя версия"}</dd></div>
      <div><dt>Последняя проверка</dt>
        <dd>${updates.payload.last_checked_at ? escapeHtml(localDate(updates.payload.last_checked_at)) : "не выполнялась"}</dd></div>
    </dl>`;

  const history = updates.payload.history || [];
  $("#update-history").innerHTML = history.length
    ? history.map((item) => `
      <tr>
        <td>${escapeHtml(localDate(item.started_at))}</td>
        <td>${escapeHtml(item.component)}</td>
        <td>${escapeHtml(item.from_version || "—")} → ${escapeHtml(item.to_version || "—")}</td>
        <td><span class="result ${escapeHtml(item.status)}">${escapeHtml(UPDATE_RESULTS[item.status] || item.status)}</span></td>
        <td>${item.rolled_back ? "да" : "нет"}</td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="muted">Обновлений ещё не было.</td></tr>';
}

const BACKUP_COLORS = {
  ready: "green", failed: "red", creating: "blue", restoring: "blue", deleted: "gray",
};

const UPDATE_RESULTS = {
  running: "идёт", success: "успешно", failure: "ошибка", rolled_back: "откачено",
};

async function createBackup() {
  const key = `backup-${crypto.randomUUID()}`;
  const { payload } = await request("/backups", {
    method: "POST",
    headers: { "Idempotency-Key": key },
  });
  toast("Создание backup началось");
  await pollOperation(payload.operation_id);
}

async function checkUpdates() {
  const { payload } = await request("/updates/check", { method: "POST" });
  toast("Проверка обновлений началась");
  await pollOperation(payload.operation_id);
}

function installUpdate() {
  askConfirm({
    title: "Установить обновление?",
    description: "Будет создан backup, сервисы могут быть временно недоступны. Ошибка запускает автоматический rollback.",
    expected: "UPDATE",
    action: async () => {
      askSudo({
        scope: "operations:update",
        title: "Подтвердите установку обновления",
        description: "Операция изменяет код, миграции и контейнеры установки.",
        action: async () => {
          const { payload } = await request("/updates/install", {
            method: "POST",
            headers: { "Idempotency-Key": `update-${crypto.randomUUID()}` },
            body: JSON.stringify({ confirm: "UPDATE" }),
          });
          toast("Обновление запущено. Панель может кратковременно отключиться.");
          pollOperation(payload.operation_id).catch(() => {
            toast("Соединение прервано во время обновления; панель переподключится автоматически.");
          });
        },
      });
    },
  });
}

function inputFor(setting) {
  if (setting.type === "boolean") {
    return `<select data-key="${escapeHtml(setting.key)}"><option value="true"${setting.value === true ? " selected" : ""}>Включено</option><option value="false"${setting.value === false ? " selected" : ""}>Выключено</option></select>`;
  }
  if (setting.key === "runtime.log_level") {
    return `<select data-key="${escapeHtml(setting.key)}">${["debug", "info", "warn", "error"].map((value) => `<option${setting.value === value ? " selected" : ""}>${value}</option>`).join("")}</select>`;
  }
  const type = setting.type === "integer" ? "number" : "text";
  return `<input data-key="${escapeHtml(setting.key)}" type="${type}" value="${escapeHtml(setting.value)}"${setting.min !== undefined ? ` min="${setting.min}"` : ""}${setting.max !== undefined ? ` max="${setting.max}"` : ""} required>`;
}

async function loadSettings() {
  const { payload, response } = await request("/settings");
  state.settings = payload.settings;
  state.etag = response.headers.get("ETag");
  state.settingProfiles = payload.profiles || [];
  renderSettingProfiles();

  const main = payload.settings.filter((item) => !item.advanced);
  const advanced = payload.settings.filter((item) => item.advanced);
  $("#settings-form").innerHTML = main.map(settingCard).join("");
  $("#settings-form-advanced").innerHTML = advanced.map(settingCard).join("");
  $("#advanced-count").textContent = advanced.length
    ? `${advanced.length} параметра тонкой настройки`
    : "";
  $("#toggle-advanced").hidden = advanced.length === 0;
}

/**
 * Карточка параметра. Рекомендация стоит НАД полем ввода: администратор
 * читает её раньше, чем смотрит на текущее значение, и не гадает, что
 * туда положить.
 */
function settingCard(item) {
  const presets = item.presets?.length
    ? `<label class="preset-row">Готовое значение
        <select data-preset-for="${escapeHtml(item.key)}">
          <option value="">— выбрать —</option>
          ${item.presets.map((preset) => `<option value="${escapeHtml(JSON.stringify(preset.value))}"${JSON.stringify(preset.value) === JSON.stringify(item.value) ? " selected" : ""}>${escapeHtml(preset.title)}</option>`).join("")}
        </select>
      </label>`
    : "";
  return `
    <article class="setting-card">
      <div class="setting-head">
        <div><h3>${escapeHtml(item.title)}</h3><span class="technical">${escapeHtml(item.key)}</span></div>
        ${item.requires_restart ? '<span class="tag">нужен перезапуск</span>' : ""}
      </div>
      <p>${escapeHtml(item.description)}</p>
      ${item.recommended ? `<p class="recommended"><span>Рекомендуется</span>${escapeHtml(item.recommended)}</p>` : ""}
      ${presets}
      <label>Значение${inputFor(item)}</label>
      <div class="setting-actions">
        <span class="technical">Влияет: ${escapeHtml(item.affects.join(", "))}</span>
        <button class="reset" type="button" data-reset="${escapeHtml(item.key)}">По умолчанию</button>
      </div>
    </article>`;
}

function renderSettingProfiles() {
  const profiles = state.settingProfiles || [];
  $("#settings-profiles-card").hidden = profiles.length === 0;
  $("#settings-profiles").innerHTML = profiles.map((profile) => `
    <button class="profile-choice" type="button" data-profile="${escapeHtml(profile.code)}">
      <strong>${escapeHtml(profile.title)}</strong>
      <span>${escapeHtml(profile.description)}</span>
    </button>`).join("");
}

/** Подставляет значения набора в поля, не сохраняя их. */
function applySettingProfile(code) {
  const profile = (state.settingProfiles || []).find((item) => item.code === code);
  if (!profile) return;
  let filled = 0;
  for (const [key, value] of Object.entries(profile.values)) {
    const input = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!input) continue;
    input.value = typeof value === "boolean" ? String(value) : String(value);
    const preset = document.querySelector(`[data-preset-for="${CSS.escape(key)}"]`);
    if (preset) preset.value = JSON.stringify(value);
    input.closest(".setting-card")?.classList.add("is-touched");
    filled += 1;
  }
  document.querySelectorAll(".profile-choice").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.profile === code);
  });
  // Часть значений может лежать в свёрнутом блоке — сказать об этом,
  // иначе выглядит, будто набор применился не полностью.
  const hiddenBlock = $("#settings-form-advanced").hidden;
  toast(`Набор «${profile.title}» подставлен в ${filled} пол(я)${hiddenBlock ? ", часть — в свёрнутых настройках" : ""}. Нажмите «Сохранить».`);
}

async function saveSettings(restart = false) {
  if (!["owner", "admin"].includes(state.me.role)) {
    toast("Эта роль может только просматривать настройки", true);
    return;
  }
  const settings = {};
  document.querySelectorAll("[data-key]").forEach((input) => {
    const original = state.settings.find((item) => item.key === input.dataset.key);
    settings[input.dataset.key] = original.type === "boolean"
      ? input.value === "true"
      : original.type === "integer"
        ? Number(input.value)
        : input.value;
  });
  const { payload, response } = await request("/settings", {
    method: "PUT",
    headers: { "If-Match": state.etag },
    body: JSON.stringify({ settings }),
  });
  state.settings = payload.settings;
  state.etag = response.headers.get("ETag");
  toast("Настройки сохранены");
  await loadSettings();
  if (restart) {
    askSudo({
      scope: "services:restart",
      title: "Применить настройки перезапуском",
      description: "Agent Runtime будет перезапущен. Агенты, conversation и память сохранятся.",
      action: async () => await lifecycleService("restart", "agent-runtime"),
    });
  }
}

// =====================================================================
// Пользователи Евы
// =====================================================================

const USER_STATE_LABELS = {
  active: "Активен",
  paused: "На паузе",
  onboarding: "Знакомство",
  blocked: "Заблокирован",
};

function userTitle(user) {
  const name = [user.first_name, user.username ? `@${user.username}` : ""]
    .filter(Boolean).join(" ");
  return name || `id ${user.telegram_id}`;
}

async function loadUsers() {
  const form = $("#users-filter-form");
  const params = new URLSearchParams();
  const query = form.elements.query.value.trim();
  if (query) params.set("query", query);
  if (form.elements.state.value) params.set("state", form.elements.state.value);
  if (form.elements.blocked.value) params.set("blocked", form.elements.blocked.value);

  const { payload } = await request(`/users?${params.toString()}`);
  state.users = payload.users;

  $("#users-body").innerHTML = payload.users.length
    ? payload.users.map((user) => `
      <tr class="user-row" data-user="${escapeHtml(user.id)}">
        <td><strong>${escapeHtml(userTitle(user))}</strong><br><span class="muted">${escapeHtml(user.telegram_id)}</span></td>
        <td>${user.is_blocked
          ? '<span class="pill-blocked">Заблокирован</span>'
          : escapeHtml(USER_STATE_LABELS[user.state] || user.state)}</td>
        <td>${escapeHtml(user.plan)}<br><span class="muted">${escapeHtml(user.subscription_status)}</span></td>
        <td>${escapeHtml(user.message_count ?? 0)}</td>
        <td>${escapeHtml(localDate(user.last_seen_at || user.last_message_at))}</td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="muted">Ничего не найдено.</td></tr>';

  $("#users-total").textContent = payload.total
    ? `Показано ${payload.users.length} из ${payload.total}.`
    : "Пользователей пока нет.";
}

function quotaRows(quotas) {
  if (!quotas.length) return '<p class="muted">Квоты для тарифа не заданы.</p>';
  return `<table class="mini-table"><thead><tr><th>Метрика</th><th>Период</th><th>Использовано</th><th>Осталось</th></tr></thead><tbody>${
    quotas.map((q) => `<tr><td>${escapeHtml(q.metric)}</td><td>${escapeHtml(q.period)}</td><td>${escapeHtml(q.used)} из ${q.limit_value < 0 ? "∞" : escapeHtml(q.limit_value)}</td><td>${q.remaining === null ? "∞" : escapeHtml(q.remaining)}</td></tr>`).join("")
  }</tbody></table>`;
}

async function openUserCard(id) {
  const { payload } = await request(`/users/${id}`);
  const user = payload.user;
  state.currentUser = payload;

  $("#user-card").hidden = false;
  $("#user-card-title").textContent = userTitle(user);
  $("#user-card-subtitle").textContent =
    `telegram_id ${user.telegram_id} · ${user.timezone} · язык ${user.language_code}`;

  const canWrite = ["owner", "admin"].includes(state.me.role);
  const canNote = ["owner", "admin", "operator"].includes(state.me.role);

  $("#user-card-body").innerHTML = `
    <div class="user-grid">
      <div>
        <h4>Состояние</h4>
        <dl class="kv">
          <dt>Состояние</dt><dd>${escapeHtml(USER_STATE_LABELS[user.state] || user.state)}</dd>
          <dt>Доступ</dt><dd>${user.is_blocked ? "заблокирован" : "открыт"}</dd>
          <dt>Тариф</dt><dd>${escapeHtml(user.plan)} (${escapeHtml(user.subscription_status)})</dd>
          <dt>Оплачен до</dt><dd>${escapeHtml(localDate(user.current_period_end))}</dd>
          <dt>Регистрация</dt><dd>${escapeHtml(localDate(user.created_at))}</dd>
          <dt>Последняя активность</dt><dd>${escapeHtml(localDate(user.last_seen_at))}</dd>
          <dt>Сообщений</dt><dd>${escapeHtml(user.message_count ?? 0)}</dd>
          <dt>Обновлений Telegram</dt><dd>${escapeHtml(payload.activity?.updates_total ?? 0)} (сбоев ${escapeHtml(payload.activity?.updates_failed ?? 0)})</dd>
        </dl>
      </div>
      <div>
        <h4>Квоты на сегодня</h4>
        ${quotaRows(payload.quotas)}
        <h4>Настройки общения</h4>
        ${payload.preferences ? `<dl class="kv">
          <dt>Режим ответа</dt><dd>${escapeHtml(payload.preferences.response_mode)}</dd>
          <dt>Роль Евы</dt><dd>${escapeHtml(payload.preferences.agent_mode)}</dd>
          <dt>Инициативные сообщения</dt><dd>${payload.preferences.heartbeat_enabled ? "включены" : "выключены"}</dd>
        </dl>` : '<p class="muted">Пользователь ничего не настраивал.</p>'}
      </div>
    </div>

    ${payload.crisis_events.length ? `<div class="user-block">
      <h4>События безопасности</h4>
      <p class="block-caption">Только метаданные: severity и время. Текст обращения не показывается и не выгружается.</p>
      <table class="mini-table"><thead><tr><th>Когда</th><th>Уровень</th><th>Обработано</th></tr></thead><tbody>${
        payload.crisis_events.map((e) => `<tr><td>${escapeHtml(localDate(e.created_at))}</td><td>${escapeHtml(e.severity)}</td><td>${e.handled ? escapeHtml(localDate(e.handled_at)) : "нет"}</td></tr>`).join("")
      }</tbody></table>
    </div>` : ""}

    ${canWrite ? `<div class="user-block">
      <h4>Действия</h4>
      <div class="form-actions">
        ${user.is_blocked
          ? `<button class="button secondary" data-action="unblock" data-user="${escapeHtml(user.id)}" type="button">Разблокировать</button>`
          : `<button class="button ghost" data-action="block" data-user="${escapeHtml(user.id)}" type="button">Заблокировать</button>`}
        ${user.state === "paused"
          ? `<button class="button ghost" data-action="activate" data-user="${escapeHtml(user.id)}" type="button">Снять паузу</button>`
          : user.state === "active"
            ? `<button class="button ghost" data-action="pause" data-user="${escapeHtml(user.id)}" type="button">Поставить на паузу</button>`
            : ""}
        <button class="button ghost" data-action="conversation" data-user="${escapeHtml(user.id)}" type="button">Показать переписку</button>
      </div>
    </div>` : ""}

    <div class="user-block">
      <h4>Заметки оператора</h4>
      ${canNote ? `<form id="user-note-form" data-user="${escapeHtml(user.id)}">
        <label>Новая заметка<textarea name="note" rows="2" maxlength="4000" placeholder="Что важно помнить об этом пользователе"></textarea></label>
        <button class="button secondary" type="submit">Добавить</button>
      </form>` : ""}
      ${payload.notes.length ? `<ul class="note-list">${
        payload.notes.map((n) => `<li><span class="muted">${escapeHtml(localDate(n.created_at))} · ${escapeHtml(n.actor_name)}</span><p>${escapeHtml(n.note)}</p></li>`).join("")
      }</ul>` : '<p class="muted">Заметок пока нет.</p>'}
    </div>

    <div class="user-block" id="user-conversation"></div>
  `;
  $("#user-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * Переписка загружается только по явной кнопке и под sudo: открыть личный
 * разговор — осознанное действие, а не побочный эффект просмотра карточки.
 * Каждое открытие попадает в журнал (кто и чью, без текста).
 */
function showConversation(id) {
  askSudo({
    scope: "users:messages",
    title: "Открыть переписку",
    description: "Личный разговор пользователя с Евой. Факт открытия будет записан в журнал событий.",
    action: async () => {
      const { payload } = await request(`/users/${id}/conversation?limit=100`);
      const target = $("#user-conversation");
      const messages = payload.messages.map((message) => {
        const role = message.role === "user" ? "Пользователь" : "Ева";
        const text = typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? message);
        return `<li class="msg msg-${escapeHtml(message.role ?? "other")}"><span class="muted">${escapeHtml(role)} · ${escapeHtml(localDate(message.created_at || message.timestamp))}</span><p>${escapeHtml(text)}</p></li>`;
      }).join("");

      target.innerHTML = `
        <h4>Переписка</h4>
        ${payload.messages_error
          ? `<p class="warn-value">Сообщения недоступны: ${escapeHtml(payload.messages_error)}. Выдержки ниже читаются из базы и не зависят от Letta.</p>`
          : ""}
        ${messages ? `<ul class="msg-list">${messages}</ul>` : '<p class="muted">Сообщений нет.</p>'}
        ${payload.highlights.length ? `<h4>Выдержки</h4><ul class="note-list">${
          payload.highlights.map((h) => `<li><span class="muted">${escapeHtml(h.highlight_type)} · ${escapeHtml(localDate(h.occurred_at || h.created_at))}</span><p><strong>${escapeHtml(h.title)}</strong> ${escapeHtml(h.content)}</p></li>`).join("")
        }</ul>` : ""}`;
      target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
  });
}

function setUserBlocked(id, blocked) {
  askSudo({
    scope: "users:write",
    title: blocked ? "Заблокировать пользователя" : "Разблокировать пользователя",
    description: blocked
      ? "Ева перестанет отвечать и не будет писать сама. Выставляются оба признака сразу."
      : "Доступ вернётся, состояние станет «активен».",
    action: async () => {
      await request(`/users/${id}/${blocked ? "block" : "unblock"}`, { method: "POST" });
      toast(blocked ? "Пользователь заблокирован" : "Пользователь разблокирован");
      await loadUsers();
      await openUserCard(id);
    },
  });
}

async function setUserState(id, userState) {
  await request(`/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ state: userState }),
  });
  toast(userState === "paused" ? "Пользователь на паузе" : "Пауза снята");
  await loadUsers();
  await openUserCard(id);
}

async function addUserNote(form) {
  const note = form.elements.note.value.trim();
  if (!note) {
    toast("Заметка пустая", true);
    return;
  }
  await request(`/users/${form.dataset.user}/notes`, {
    method: "POST",
    headers: { "Idempotency-Key": `note-${form.dataset.user}-${Date.now()}` },
    body: JSON.stringify({ note }),
  });
  toast("Заметка добавлена");
  await openUserCard(form.dataset.user);
}

async function loadSecrets() {
  if (!["owner", "admin"].includes(state.me.role)) {
    $("#secrets-list").innerHTML = '<article class="secret-card">Для просмотра метаданных секретов нужна роль owner или admin.</article>';
    return;
  }
  const { payload } = await request("/secrets");
  state.secrets = payload.secrets;
  renderSecrets();
}

/**
 * Ключи, которые администратор действительно задаёт руками: внешние
 * токены и пароли внешних систем. Всё остальное — пароли базы, внутренние
 * секреты между контейнерами — создаёт установщик, и менять их из панели
 * значит развалить работающую установку.
 */
const ADMIN_FACING_SECRETS = new Set([
  "sec_eva_telegram_bot_token",
  "sec_todoist_api_token",
  "sec_media_asr_api_key",
  "sec_media_tts_api_key",
  "sec_lava_webhook_password",
  "sec_eva_llm_api_key",
  // Ключ эмбеддингов при установке копируется из ключа LLM, но провайдер
  // у них может быть разный — тогда его меняют отдельно.
  "sec_eva_embedding_api_key",
]);

function renderSecrets() {
  const all = state.secrets || [];
  const shown = state.showAllSecrets ? all : all.filter((item) => ADMIN_FACING_SECRETS.has(item.secret_ref));
  const hidden = all.length - shown.length;
  $("#toggle-all-secrets").textContent = state.showAllSecrets
    ? "Показать только основные"
    : `Показать все (${all.length})`;
  $("#toggle-all-secrets").hidden = all.length === 0;
  const notice = !state.showAllSecrets && hidden > 0
    ? `<p class="muted secrets-hint">Скрыто ${hidden} служебных ключ(ей): их создаёт установщик, и смена вручную ломает связь между контейнерами.</p>`
    : "";
  $("#secrets-list").innerHTML = notice + (shown.length
    ? shown.map((item) => `
      <article class="secret-card">
        <div class="secret-meta">
          <span class="status-pill">${item.configured ? "Настроен" : "Не настроен"}</span>
          <strong class="secret-ref">${escapeHtml(item.secret_ref)}</strong>
          <span>Создан: ${escapeHtml(localDate(item.created_at))}</span>
          <span>Ротация: ${escapeHtml(localDate(item.last_rotated_at))}</span>
          <span>Используют: ${escapeHtml(item.used_by.join(", ") || "не указано")}</span>
        </div>
        <form class="secret-form" data-secret="${escapeHtml(item.secret_ref)}">
          <label>Новое значение<input name="value" type="password" autocomplete="new-password" placeholder="Только новое значение" required></label>
          <label>Сервисы через запятую<input name="used_by" value="${escapeHtml(item.used_by.join(", "))}" required></label>
          <button class="button secondary" type="submit">Сменить ключ</button>
        </form>
      </article>`).join("")
    : '<article class="secret-card"><div><h3>Нет ключей для показа</h3><p class="muted">Либо секреты ещё не импортированы, либо все они служебные — нажмите «Показать все».</p></div></article>');
}

/** Пароль архива backup. Значение уходит на сервер и обратно не возвращается. */
async function setBackupPassword(password, form) {
  await new Promise((resolve, reject) => {
    askSudo({
      scope: "secrets:write",
      title: password ? "Задать пароль архива backup" : "Вернуться к мастер-ключу",
      description: password
        ? "Новые архивы будут шифроваться этим паролем. Без него восстановление станет невозможным — сохраните его вне сервера."
        : "Новые архивы снова будут шифроваться мастер-ключом Secret Store.",
      action: async () => {
        try {
          const { payload } = await request("/backups/password", {
            method: "PUT",
            body: JSON.stringify({ password }),
          });
          form.reset();
          toast(payload.configured
            ? "Пароль архива задан. Сохраните его вне сервера — восстановить его нельзя."
            : "Пароль снят, архивы шифруются мастер-ключом");
          resolve();
        } catch (error) {
          reject(error);
          throw error;
        }
      },
    });
  }).catch(handleError);
}

async function writeSecret(form) {
  const valueInput = form.elements.value;
  const usedBy = form.elements.used_by.value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  await request(`/secrets/${encodeURIComponent(form.dataset.secret)}`, {
    method: "PUT",
    body: JSON.stringify({ value: valueInput.value, used_by: usedBy }),
  });
  valueInput.value = "";
  toast("Секрет сохранён; его значение больше не доступно интерфейсу");
  await loadSecrets();
}

async function loadAudit() {
  const { payload } = await request("/audit?limit=150");
  $("#audit-body").innerHTML = payload.events.map((event) => `
    <tr>
      <td>${escapeHtml(localDate(event.at))}</td>
      <td>${escapeHtml(event.actor)}${event.role ? `<br><span class="technical">${escapeHtml(event.role)}</span>` : ""}</td>
      <td>${escapeHtml(event.operation)}</td>
      <td>${escapeHtml(event.target || "—")}</td>
      <td><span class="result ${escapeHtml(event.result)}">${escapeHtml(event.result)}</span></td>
      <td class="technical">${escapeHtml(event.request_id)}</td>
    </tr>`).join("");
}

function startLiveUpdates() {
  stopLiveUpdates();
  if ("EventSource" in window) {
    state.events = new EventSource(`${API}/events`);
    state.events.addEventListener("update", () => {
      clearTimeout(startLiveUpdates.debounce);
      startLiveUpdates.debounce = setTimeout(() => {
        if (["overview", "services", "operations"].includes(state.page)) {
          LOADERS[state.page]?.().catch(() => {});
        }
      }, 500);
    });
  }
  state.refreshTimer = setInterval(() => {
    if (["overview", "services", "operations"].includes(state.page)) {
      LOADERS[state.page]?.().catch(() => {});
    }
  }, 15_000);
}

function stopLiveUpdates() {
  state.events?.close();
  state.events = null;
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const form = new FormData(formElement);
    const { payload } = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
      }),
    });
    formElement.reset();
    showApp(payload.user);
    openPage("overview");
  } catch (error) {
    showLogin(error.message);
  } finally {
    if (submit) submit.disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  try {
    await request("/auth/logout", { method: "POST" });
  } catch {}
  state.me = null;
  showLogin();
});
$("#menu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]");
  if (button) openPage(button.dataset.page);
});
$("#reload-overview").addEventListener("click", () => loadOverview().catch(handleError));
$("#show-errors").addEventListener("click", () => showErrors().catch(handleError));
$("#verdict-action").addEventListener("click", () => showErrors().catch(handleError));
$("#close-errors").addEventListener("click", () => $("#errors-dialog").close());
// Клик по подложке закрывает диалог: у <dialog> нет этого поведения из коробки.
$("#errors-dialog").addEventListener("click", (event) => {
  if (event.target === $("#errors-dialog")) $("#errors-dialog").close();
});
$("#overview-groups").addEventListener("click", (event) => {
  if (event.target.closest("[data-goto-service]")) openPage("services");
});
$("#reload-services").addEventListener("click", () => loadServicesAndIntegrations().catch(handleError));
document.querySelector(".tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-service-tab]");
  if (!button) return;
  document.querySelectorAll("[data-service-tab]").forEach((item) => item.classList.toggle("active", item === button));
  $("#services-list").hidden = button.dataset.serviceTab !== "services";
  $("#integrations-list").hidden = button.dataset.serviceTab !== "integrations";
});
$("#page-services").addEventListener("click", (event) => {
  const check = event.target.closest("[data-check]");
  if (check) {
    startCheck(check.dataset.targetType, check.dataset.check).catch(handleError);
    return;
  }
  const configure = event.target.closest("[data-configure]");
  if (configure) {
    openIntegration(configure.dataset.configure).catch(handleError);
    return;
  }
  const lifecycle = event.target.closest("[data-lifecycle]");
  if (lifecycle) {
    const action = lifecycle.dataset.lifecycle;
    const labels = LIFECYCLE_LABELS[action];
    if (!labels) return;
    askSudo({
      scope: "services:restart",
      title: labels.title,
      description: labels.description,
      action: async () => await lifecycleService(action, lifecycle.dataset.service),
    });
  }
});
$("#close-integration").addEventListener("click", () => $("#integration-dialog").close());
$("#integration-dialog").addEventListener("click", (event) => {
  if (event.target === $("#integration-dialog")) $("#integration-dialog").close();
});
$("#integration-save").addEventListener("click", () => saveIntegration().catch(handleError));
$("#integration-check").addEventListener("click", () => {
  const id = state.integration?.id;
  if (!id) return;
  // У ASR и TTS есть настоящая проверка тракта; у остальных — только
  // плановая проверка доступности, которую ставит health-worker.
  if (["asr", "tts"].includes(id)) runIntegrationTest(id).catch(handleError);
  else startCheck("integration", id).catch(handleError);
});
$("#new-provider").addEventListener("click", () => openProviderEditor());
$("#close-provider").addEventListener("click", () => {
  $("#provider-editor").hidden = true;
});
$("#cancel-provider").addEventListener("click", () => {
  $("#provider-editor").hidden = true;
});
$("#provider-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  saveProvider(form).catch(handleError);
});
$("#reload-router").addEventListener("click", () => loadProviders().catch(handleError));

$("#router-routes").addEventListener("click", (event) => {
  const move = event.target.closest("[data-chain-move]");
  if (move) {
    moveChain(move.dataset.route, move.dataset.provider, move.dataset.chainMove).catch(handleError);
    return;
  }
  const remove = event.target.closest("[data-chain-remove]");
  if (remove) {
    const route = (state.router?.routes || []).find((item) => item.code === remove.dataset.route);
    const ids = (route?.chain || [])
      .map((link) => link.provider_id)
      .filter((id) => id !== remove.dataset.chainRemove);
    if (ids.length === 0) {
      // Сервер и так отклонит пустую цепочку, но сказать причину лучше
      // до запроса, чем показать 400.
      toast("В цепочке должен остаться хотя бы основной провайдер", true);
      return;
    }
    saveChain(remove.dataset.route, ids).catch(handleError);
    return;
  }
  const add = event.target.closest("[data-chain-add]");
  if (add) {
    const code = add.dataset.chainAdd;
    const select = document.querySelector(`[data-chain-add-select="${CSS.escape(code)}"]`);
    const route = (state.router?.routes || []).find((item) => item.code === code);
    const ids = (route?.chain || []).map((link) => link.provider_id);
    if (select?.value) saveChain(code, [...ids, select.value]).catch(handleError);
  }
});

$("#router-health").addEventListener("click", (event) => {
  const reset = event.target.closest("[data-breaker-reset]");
  if (reset) {
    request(`/llm/providers/${encodeURIComponent(reset.dataset.breakerReset)}/breaker/reset`, { method: "POST" })
      .then(() => { toast("Провайдер возвращён в строй"); return loadProviders(); })
      .catch(handleError);
    return;
  }
  const pin = event.target.closest("[data-pin]");
  if (pin) {
    const on = pin.dataset.pin === "on";
    request(`/llm/providers/${encodeURIComponent(pin.dataset.provider)}/pin`, {
      method: "POST",
      body: JSON.stringify({ pinned_out: on }),
    })
      .then(() => {
        toast(on ? "Провайдер снят с автовозврата" : "Автовозврат включён");
        return loadProviders();
      })
      .catch(handleError);
  }
});

$("#providers-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-provider-action]");
  if (button) {
    providerAction(button.dataset.providerAction, button.dataset.providerId).catch(handleError);
  }
});
$("#create-backup").addEventListener("click", () => createBackup().catch(handleError));
$("#check-updates").addEventListener("click", () => checkUpdates().catch(handleError));
$("#reload-backups").addEventListener("click", () => loadOperations().catch(handleError));
$("#install-update").addEventListener("click", installUpdate);
$("#toggle-advanced").addEventListener("click", () => {
  const form = $("#settings-form-advanced");
  form.hidden = !form.hidden;
  $("#toggle-advanced").textContent = form.hidden
    ? "Показать остальные настройки"
    : "Скрыть остальные настройки";
});
$("#settings-profiles").addEventListener("click", (event) => {
  const button = event.target.closest("[data-profile]");
  if (button) applySettingProfile(button.dataset.profile);
});
$("#reload-users").addEventListener("click", () => loadUsers().catch(handleError));
$("#users-filter-form").addEventListener("submit", (event) => {
  event.preventDefault();
  loadUsers().catch(handleError);
});
$("#users-body").addEventListener("click", (event) => {
  const row = event.target.closest(".user-row");
  if (row) openUserCard(row.dataset.user).catch(handleError);
});
$("#close-user-card").addEventListener("click", () => {
  $("#user-card").hidden = true;
});
$("#user-card-body").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action][data-user]");
  if (!button) return;
  const id = button.dataset.user;
  const actions = {
    block: () => setUserBlocked(id, true),
    unblock: () => setUserBlocked(id, false),
    pause: () => setUserState(id, "paused").catch(handleError),
    activate: () => setUserState(id, "active").catch(handleError),
    conversation: () => showConversation(id),
  };
  actions[button.dataset.action]?.();
});
$("#user-card-body").addEventListener("submit", (event) => {
  if (event.target.id !== "user-note-form") return;
  event.preventDefault();
  addUserNote(event.target).catch(handleError);
});
// Пресет поля подставляет значение в сам инпут: сохраняется всегда то,
// что в поле, поэтому выпадающий список не может разойтись с ним.
document.addEventListener("change", (event) => {
  const preset = event.target.closest("[data-preset-for]");
  if (!preset || !preset.value) return;
  const input = document.querySelector(`[data-key="${CSS.escape(preset.dataset.presetFor)}"]`);
  if (!input) return;
  input.value = String(JSON.parse(preset.value));
  input.closest(".setting-card")?.classList.add("is-touched");
});
$("#save-settings").addEventListener("click", () => saveSettings(false).catch(handleError));
$("#save-restart").addEventListener("click", () => saveSettings(true).catch(handleError));
$("#settings-form").addEventListener("click", (event) => {
  const button = event.target.closest("[data-reset]");
  if (!button) return;
  const item = state.settings.find((setting) => setting.key === button.dataset.reset);
  const input = document.querySelector(`[data-key="${CSS.escape(item.key)}"]`);
  input.value = String(item.default);
});
$("#reload-secrets").addEventListener("click", () => loadSecrets().catch(handleError));
$("#toggle-all-secrets").addEventListener("click", () => {
  state.showAllSecrets = !state.showAllSecrets;
  renderSecrets();
});
$("#backup-password-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = form.elements.password.value;
  // Пустая отправка означала бы снятие пароля — то же разрушительное
  // действие, что и кнопка рядом, но в обход её подтверждения.
  if (!password) {
    toast("Введите пароль или нажмите «Вернуться к мастер-ключу»", true);
    return;
  }
  if (password !== form.elements.confirm.value) {
    toast("Пароли не совпадают", true);
    return;
  }
  setBackupPassword(password, form);
});
$("#clear-backup-password").addEventListener("click", () => {
  askConfirm({
    title: "Вернуться к мастер-ключу?",
    description: "Новые архивы снова будут шифроваться мастер-ключом Secret Store. Уже созданные с паролем архивы останутся зашифрованными им — сохраните пароль, пока они нужны.",
    expected: "МАСТЕР-КЛЮЧ",
    action: async () => await setBackupPassword("", $("#backup-password-form")),
  });
});
$("#secrets-list").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  askSudo({
    scope: "secrets:write",
    title: "Сменить системный ключ",
    description: "Новое значение будет зашифровано; прежнее больше не будет доступно.",
    action: async () => await writeSecret(form),
  });
});
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
  if (form.elements.confirmation.value !== pending.expected) {
    toast(`Введите ${pending.expected} без изменений`, true);
    return;
  }
  $("#confirm-dialog").close();
  form.reset();
  state.pendingConfirm = null;
  Promise.resolve(pending.action()).catch(handleError);
});
$("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const data = new FormData(formElement);
  try {
    await request("/auth/password", {
      method: "POST",
      body: JSON.stringify({
        current_password: data.get("current_password"),
        new_password: data.get("new_password"),
      }),
    });
    formElement.reset();
    toast("Пароль изменён");
  } catch (error) {
    handleError(error);
  }
});
$("#reload-audit").addEventListener("click", () => loadAudit().catch(handleError));

request("/me").then(({ payload }) => {
  showApp(payload.user);
  openPage("overview");
}).catch(() => showLogin());
