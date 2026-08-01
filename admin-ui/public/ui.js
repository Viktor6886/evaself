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
  stt: loadStt,
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
  setSidebar(false);
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
  // Версия — украшение шапки, а не смысл страницы. Её отсутствие не
  // должно уносить с собой вердикт, состояние сервисов и загрузку
  // сервера: именно за ними сюда и заходят.
  $("#system-version").textContent = payload.installation?.version ?? "—";
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
          ${chain.length ? `<ol class="chain${route.rotation_enabled === false ? " is-pinned" : ""}">${chain.map((link, index) => `
            <li class="chain-link${link.enabled && (route.rotation_enabled !== false || index === 0) ? "" : " is-off"}">
              <span class="chain-rank">${index === 0 ? "основной"
                : route.rotation_enabled === false ? "не используется" : `резерв ${index}`}</span>
              <span class="chain-name"><strong>${escapeHtml(link.name)}</strong><small>${escapeHtml(link.model)} · ${escapeHtml(link.protocol)}</small></span>
              ${editable ? `<span class="chain-move">
                <button class="button tiny ghost" data-chain-move="up" data-route="${escapeHtml(route.code)}" data-provider="${escapeHtml(link.provider_id)}"${index === 0 ? " disabled" : ""}>↑</button>
                <button class="button tiny ghost" data-chain-move="down" data-route="${escapeHtml(route.code)}" data-provider="${escapeHtml(link.provider_id)}"${index === chain.length - 1 ? " disabled" : ""}>↓</button>
                <button class="button tiny danger-outline" data-chain-remove="${escapeHtml(link.provider_id)}" data-route="${escapeHtml(route.code)}">Убрать</button>
              </span>` : ""}
            </li>`).join("")}</ol>`
            : '<p class="muted">Цепочка пуста — маршрут не обслуживается.</p>'}
          ${editable ? chainAdder(route, chain) : ""}
          <label class="switch route-rotation">
            <input type="checkbox" data-route-rotation="${escapeHtml(route.code)}"
                   ${route.rotation_enabled === false ? "" : "checked"}${editable ? "" : " disabled"}>
            <span>Ротация провайдеров</span>
          </label>
          <small class="muted">${route.code === "chat"
            ? "Этим маршрутом отвечает Ева. Выключите, если подмена на резервную модель "
              + "недопустима: стиль ответа у моделей разный."
            : "Выключенная ротация оставляет в работе только основного, а отказ остаётся отказом."}</small>
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
/**
 * Боковое меню на телефоне.
 *
 * Открытое меню накрывает содержимое, поэтому у него должно быть три
 * способа закрыться: та же кнопка, тычок мимо и Escape. С одним только
 * первым промах по кнопке уводит в другой раздел вместо закрытия.
 */
function setSidebar(open) {
  $(".sidebar").classList.toggle("open", open);
  const scrim = $("#sidebar-scrim");
  if (!scrim) return;
  scrim.hidden = false;
  scrim.classList.toggle("show", open);
  // aria-expanded читают скринридеры, и без него кнопка «☰» не
  // сообщает, открыто меню или нет.
  $("#menu")?.setAttribute("aria-expanded", String(open));
}

$("#menu").addEventListener("click", () => {
  setSidebar(!$(".sidebar").classList.contains("open"));
});
$("#sidebar-scrim")?.addEventListener("click", () => setSidebar(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $(".sidebar")?.classList.contains("open")) setSidebar(false);
});
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

// Переключатель — это change, а не click: клавиатурное переключение
// пробелом click не порождает, и настройка осталась бы недоступной.
$("#router-routes").addEventListener("change", (event) => {
  const toggle = event.target.closest("[data-route-rotation]");
  if (!toggle) return;
  const code = toggle.dataset.routeRotation;
  request(`/llm/routes/${encodeURIComponent(code)}`, {
    method: "PATCH",
    body: JSON.stringify({ rotation_enabled: toggle.checked }),
  })
    .then(() => {
      toast(toggle.checked
        ? "Ротация включена: при отказе основного ответит резерв"
        : "Ротация выключена: работает только основной провайдер");
      return loadProviders();
    })
    .catch(handleError);
});

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

// =====================================================================
// Распознавание речи
// =====================================================================
// Панель не знает ни одного параметра провайдеров. Форма строится по
// GET /stt/provider-schemas, который admin-api проксирует из
// media-service — источник истины там же, где адаптеры. Поэтому новая
// модель или новый параметр Deepgram не требуют правки этого файла.

const STT_SECTIONS = [
  ["basic", "Основные настройки"],
  ["model", "Модель и язык"],
  ["formatting", "Форматирование"],
  ["features", "Дополнительные возможности"],
  ["secret", "Секрет"],
  ["advanced", "Расширенные настройки"],
];

const STT_STATUS = {
  draft: ["Черновик", "gray"],
  healthy: ["Работает", "green"],
  unhealthy: ["Ошибка", "red"],
  disabled: ["Выключено", "gray"],
  archived: ["В архиве", "gray"],
};

const STT_USE_CASE_LABELS = {
  telegram_voice: "Голосовые в Telegram",
  webapp_voice_message: "Голосовые в WebApp",
  webapp_live: "Живой режим (в разработке)",
};

async function loadStt() {
  // Конфигурации и маршруты лежат в PostgreSQL и доступны всегда.
  // Схемы форм приходят из media-service, и его недоступность не должна
  // превращать раздел в мёртвую страницу: ключ, активацию и выключение
  // можно сделать и без схемы, а редактор параметров подождёт.
  const [configs, routes] = await Promise.all([
    request("/stt/configs"),
    request("/stt/routes"),
  ]);
  state.sttConfigs = configs.payload.configs || [];
  state.sttRoutes = routes.payload.routes || [];
  state.sttSchemaError = null;

  try {
    const { payload } = await request("/stt/provider-schemas");
    state.sttSchemas = payload.providers || [];
    if (payload.stale) {
      state.sttSchemaError = "media-service не отвечает — показаны сохранённые схемы";
    }
  } catch (error) {
    state.sttSchemas = state.sttSchemas || [];
    // Сообщение называет причину, а не только следствие: «не отвечает»
    // и «отвечает 401» чинят по-разному, и гадать администратор не
    // должен.
    const reason = String(error?.message || "");
    state.sttSchemaError = /401|ключ|unauthor/i.test(reason)
      ? "media-service отклоняет запросы панели (HTTP 401): не совпадает "
        + "MEDIA_SERVICE_TOKEN. Проверьте переменную в .env и перезапустите "
        + "admin-api и media-service."
      : "media-service не отвечает: редактор параметров и проверка недоступны, "
        + "ключи и маршруты работают";
  }

  // Правки в базе применяются всегда, а вот распознавание пойдёт по ним
  // только после доставки снимка. Разницу надо показать: иначе
  // «сохранено» читается как «работает».
  try {
    const { payload } = await request("/stt/health");
    state.sttSnapshot = payload.snapshot || null;
  } catch {
    state.sttSnapshot = null;
  }

  renderSttConfigs();
  renderSttRoutes();
}

function sttSchema(provider) {
  return (state.sttSchemas || []).find((item) => item.provider === provider);
}

function renderSttConfigs() {
  const host = $("#stt-configs");
  const undelivered = state.sttSnapshot && state.sttSnapshot.delivered === false
    ? `<p class="integration-status error">Настройки сохранены, но не применены:
        media-service не принял снимок${state.sttSnapshot.error
          ? ` (${escapeHtml(String(state.sttSnapshot.error).slice(0, 160))})` : ""}.
        Распознавание работает по прежним настройкам; панель повторит попытку сама.</p>`
    : "";
  const notice = (state.sttSchemaError
    ? `<p class="integration-status error">${escapeHtml(state.sttSchemaError)}</p>`
    : "") + undelivered;
  if (!state.sttConfigs.length) {
    host.innerHTML = `${notice}<p class="muted">Конфигураций пока нет. Пока их нет, распознавание
      работает по устаревшим переменным MEDIA_ASR_* из .env.</p>`;
    return;
  }
  host.innerHTML = notice + state.sttConfigs.map((config) => {
    const [label, color] = STT_STATUS[config.status] || [config.status, "gray"];
    const schema = sttSchema(config.provider);
    const test = config.last_test || {};
    const usedBy = (config.used_by || [])
      .map((useCase) => STT_USE_CASE_LABELS[useCase] || useCase)
      .join(", ");
    return `
      <article class="status-card" data-stt-id="${config.id}">
        <header>
          <span class="dot ${color}"></span>
          <div>
            <h4>${escapeHtml(config.name)}</h4>
            <p class="muted">${escapeHtml(schema?.label || config.provider)} · ${escapeHtml(config.model)} · ${config.mode}</p>
          </div>
          <span class="pill">${label}</span>
        </header>
        <dl class="status-meta">
          <div><dt>Ключи</dt><dd>${sttKeySummary(config)}</dd></div>
          <div><dt>Используется</dt><dd>${usedBy ? escapeHtml(usedBy) : "нигде"}</dd></div>
          <div><dt>Последняя проверка</dt><dd>${
            test.at ? `${new Date(test.at).toLocaleString("ru")} · ${test.ok ? "успешно" : "ошибка"}` : "не проводилась"
          }</dd></div>
          ${test.latency_ms ? `<div><dt>Задержка</dt><dd>${test.latency_ms} мс</dd></div>` : ""}
        </dl>
        ${test.ok === false && test.error_message
          ? `<p class="integration-status error">${escapeHtml(String(test.error_message).slice(0, 200))}</p>` : ""}
        <div class="card-actions">
          <button class="button ${config.secret?.configured ? "ghost" : "primary"}"
                  data-stt-action="key" data-id="${config.id}">
            ${config.secret?.configured ? "Ключи" : "Ввести ключ"}
          </button>
          <button class="button ghost" data-stt-action="test" data-id="${config.id}"
                  ${config.secret?.configured ? "" : "disabled"}>Проверить</button>
          <button class="button ghost" data-stt-action="activate" data-id="${config.id}"
                  ${config.secret?.configured && !config.archived ? "" : "disabled"}>Активировать</button>
          <button class="button ghost" data-stt-action="toggle" data-id="${config.id}"
                  data-enabled="${config.status !== "disabled"}">
            ${config.status === "disabled" ? "Включить" : "Выключить"}
          </button>
          <button class="button ghost" data-stt-action="edit" data-id="${config.id}">Параметры</button>
          ${config.archived
            ? `<button class="button ghost" data-stt-action="restore" data-id="${config.id}">Вернуть из архива</button>`
            : `<button class="button ghost" data-stt-action="archive" data-id="${config.id}">В архив</button>`}
        </div>
      </article>`;
  }).join("");
}

/**
 * Ключи одной строкой для карточки.
 *
 * Важно не число ключей само по себе, а сколько из них сейчас можно
 * пробовать: «5 ключей» при четырёх исчерпанных — повод зайти внутрь.
 */
function sttKeySummary(config) {
  const keys = config.keys || {};
  const total = Number(keys.total || 0);
  if (!total) return config.secret?.configured ? "1 (основной)" : "не настроены";
  const parts = [`${total}`];
  if (keys.exhausted) parts.push(`${keys.exhausted} с исчерпанным лимитом`);
  if (keys.invalid) parts.push(`${keys.invalid} отвергнут провайдером`);
  if (!keys.usable) parts.push("рабочих нет");
  return escapeHtml(parts.join(" · "));
}

/**
 * Действие раздела распознавания речи.
 *
 * Без подтверждения паролем — по решению владельца. Ключи провайдеров
 * вводят, меняют и проверяют часто, и пароль на каждом шаге превращал
 * настройку в пытку: за одну сессию его приходилось вводить десяток
 * раз. Защита осталась там, где работает по-настоящему: вход в панель,
 * роль owner или admin и запись каждого действия в аудит.
 *
 * Хелпер существует, чтобы это решение было видно в одном месте, а не
 * растворилось в десятке мест, где раньше стоял askSudo.
 */
function sttAction(action) {
  Promise.resolve().then(action).catch(handleError);
}

/** Предел цепочки. Тот же, что у сервера и у LLM Router. */
const STT_MAX_CHAIN = 6;

function renderSttRoutes() {
  $("#stt-routes").innerHTML = state.sttRoutes.map((route) => {
    const chain = route.chain || [];
    return `
    <article class="status-card" data-route="${route.use_case}">
      <header>
        <span class="dot ${route.enabled && chain.length ? "green" : "gray"}"></span>
        <div><h4>${STT_USE_CASE_LABELS[route.use_case] || route.use_case}</h4>
          <p class="muted">${route.use_case}</p></div>
      </header>

      <p class="muted">Провайдеры перебираются сверху вниз. Порядок — это и есть
        приоритет: когда первый не отвечает или у него кончились ключи,
        распознавание продолжает следующий.</p>

      ${chain.length ? `<ol class="chain">${chain.map((link, index) => `
        <li class="chain-link">
          <span class="chain-rank">${index === 0 ? "основной" : `резерв ${index}`}</span>
          <span class="chain-name"><strong>${escapeHtml(link.name)}</strong>
            <small>${escapeHtml(link.model)} · ${escapeHtml(link.provider)}</small></span>
          <span class="chain-move">
            <button class="button tiny ghost" data-stt-chain="up" data-route="${route.use_case}"
                    data-config="${link.config_id}"${index === 0 ? " disabled" : ""}>↑</button>
            <button class="button tiny ghost" data-stt-chain="down" data-route="${route.use_case}"
                    data-config="${link.config_id}"${index === chain.length - 1 ? " disabled" : ""}>↓</button>
            <button class="button tiny danger-outline" data-stt-chain="remove"
                    data-route="${route.use_case}" data-config="${link.config_id}">Убрать</button>
          </span>
        </li>`).join("")}</ol>`
      : `<p class="muted">Провайдер не назначен — распознавание для этого сценария не работает.</p>`}

      ${sttChainAdder(route, chain)}

      <label class="switch"><input type="checkbox" data-route-field="rotation_enabled"
             ${route.rotation_enabled ? "checked" : ""}>
        <span>Ротация провайдеров</span></label>
      <small class="muted">Выключите, если резервный провайдер не устраивает по цене
        или качеству: тогда работает только основной, а отказ остаётся отказом.</small>

      <label class="field"><span>Таймаут, мс</span>
        <input type="number" data-route-field="timeout_ms" value="${route.timeout_ms}" min="5000" max="600000"></label>
      <label class="field"><span>Предел длительности, с</span>
        <input type="number" data-route-field="max_audio_seconds" value="${route.max_audio_seconds ?? ""}" min="1" max="7200"></label>
      <label class="switch"><input type="checkbox" data-route-field="enabled" ${route.enabled ? "checked" : ""}>
        <span>Сценарий включён</span></label>
      <div class="card-actions">
        <button class="button primary" data-stt-action="save-route" data-id="${route.use_case}">Применить</button>
      </div>
    </article>`;
  }).join("");
}

/** Выпадающий список того, кого ещё можно поставить в цепочку. */
function sttChainAdder(route, chain) {
  if (chain.length >= STT_MAX_CHAIN) {
    return `<p class="muted">Цепочка заполнена: ${STT_MAX_CHAIN} провайдеров — предел.</p>`;
  }
  const used = new Set(chain.map((link) => link.config_id));
  const free = state.sttConfigs.filter(
    (config) => !config.archived && config.secret?.configured && !used.has(config.id));
  if (!free.length) {
    return `<p class="muted">Свободных настроенных провайдеров нет.</p>`;
  }
  return `<div class="chain-add">
    <select data-stt-chain-pick="${route.use_case}">
      ${free.map((config) => `<option value="${config.id}">${escapeHtml(config.name)}</option>`).join("")}
    </select>
    <button class="button ghost" data-stt-chain="add" data-route="${route.use_case}">Добавить в цепочку</button>
  </div>`;
}

/**
 * Перестановка и удаление звеньев.
 *
 * Цепочка отправляется целиком: «поставить вторым» — это про позиции
 * всех, а не одного, и спорить с сервером о том, как выглядит
 * результат, незачем.
 */
function sttChainAction(action, useCase, configId) {
  const route = state.sttRoutes.find((item) => item.use_case === useCase);
  if (!route) return;
  const ids = (route.chain || []).map((link) => link.config_id);

  if (action === "add") {
    const picked = document.querySelector(`[data-stt-chain-pick="${useCase}"]`)?.value;
    if (!picked) return;
    ids.push(picked);
  } else {
    const index = ids.indexOf(configId);
    if (index < 0) return;
    if (action === "remove") ids.splice(index, 1);
    else {
      const target = action === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
    }
  }

  sttAction(async () => {
      await request(`/stt/routes/${encodeURIComponent(useCase)}`, {
        method: "PUT", body: JSON.stringify({ chain: ids }),
      });
      toast("Цепочка обновлена");
      await loadStt();
    });
}

async function loadSttUsage() {
  const { payload } = await request("/stt/usage?days=30");
  const totals = payload.totals || {};
  const day = payload.last_24h || {};
  const rate = Number(totals.requests) > 0
    ? Math.round((Number(totals.successes) / Number(totals.attempts)) * 100) : null;

  $("#stt-usage").innerHTML = `
    <div class="status-grid">
      <article class="status-card"><header><div><h4>За 24 часа</h4></div></header>
        <dl class="status-meta">
          <div><dt>Распознаваний</dt><dd>${day.requests ?? 0}</dd></div>
          <div><dt>Ошибок</dt><dd>${day.failures ?? 0}</dd></div>
        </dl></article>
      <article class="status-card"><header><div><h4>За 30 дней</h4></div></header>
        <dl class="status-meta">
          <div><dt>Распознаваний</dt><dd>${totals.requests ?? 0}</dd></div>
          <div><dt>Попыток к провайдерам</dt><dd>${totals.attempts ?? 0}</dd></div>
          <div><dt>Уходов на резерв</dt><dd>${totals.fallbacks ?? 0}</dd></div>
          <div><dt>Минут аудио</dt><dd>${(Number(totals.audio_seconds || 0) / 60).toFixed(1)}</dd></div>
          <div><dt>Успешность</dt><dd>${rate === null ? "—" : `${rate}%`}</dd></div>
          <div><dt>Задержка p50 / p95</dt><dd>${totals.p50_latency_ms ?? "—"} / ${totals.p95_latency_ms ?? "—"} мс</dd></div>
        </dl></article>
    </div>
    <h3 class="section-title">По провайдерам</h3>
    <table class="table"><thead><tr><th>Провайдер</th><th>Модель</th><th>Запросов</th><th>Минут</th><th>p95, мс</th></tr></thead>
      <tbody>${(payload.by_provider || []).map((row) => `<tr>
        <td>${escapeHtml(row.provider)}</td><td>${escapeHtml(row.model)}</td>
        <td>${row.requests}</td><td>${(Number(row.audio_seconds || 0) / 60).toFixed(1)}</td>
        <td>${row.p95_latency_ms ?? "—"}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">Пока нет данных</td></tr>'}
      </tbody></table>
    <h3 class="section-title">Последние ошибки</h3>
    <table class="table"><thead><tr><th>Когда</th><th>Сценарий</th><th>Провайдер</th><th>Код</th><th>Резерв</th></tr></thead>
      <tbody>${(payload.recent_errors || []).map((row) => `<tr>
        <td>${new Date(row.at).toLocaleString("ru")}</td>
        <td>${escapeHtml(row.use_case)}</td><td>${escapeHtml(row.provider)}</td>
        <td>${escapeHtml(row.error_code || "")}</td><td>${row.is_fallback ? "да" : "нет"}</td></tr>`).join("")
        || '<tr><td colspan="5" class="muted">Ошибок нет</td></tr>'}
      </tbody></table>`;
}

// ---------------------------------------------------------------------
// редактор
// ---------------------------------------------------------------------
function sttField(spec, value, capabilities) {
  // Поле, которого адаптер не поддерживает, не показывается вовсе —
  // предлагать настройку, которую провайдер отвергнет, хуже, чем не
  // предлагать ничего.
  if (spec.requires_capability && !capabilities[spec.requires_capability]) return "";
  const name = spec.name;
  const hint = spec.hint ? `<small class="muted">${escapeHtml(spec.hint)}</small>` : "";
  const current = value ?? spec.default ?? "";

  if (spec.kind === "boolean") {
    return `<label class="switch"><input type="checkbox" data-stt-field="${name}" ${current ? "checked" : ""}>
      <span>${escapeHtml(spec.label)}</span></label>${hint}`;
  }
  if (spec.kind === "select") {
    const options = (spec.options || [])
      .map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === String(current) ? "selected" : ""}>${escapeHtml(option.label)}</option>`)
      .join("");
    return `<label class="field"><span>${escapeHtml(spec.label)}</span>
      <select data-stt-field="${name}">${options}</select>${hint}</label>`;
  }
  if (spec.kind === "multiselect") {
    const selected = Array.isArray(current) ? current : [];
    return `<fieldset class="field"><legend>${escapeHtml(spec.label)}</legend>${
      (spec.options || []).map((option) => `<label class="switch">
        <input type="checkbox" data-stt-multi="${name}" value="${escapeHtml(option.value)}" ${selected.includes(option.value) ? "checked" : ""}>
        <span>${escapeHtml(option.label)}</span></label>`).join("")}${hint}</fieldset>`;
  }
  if (spec.kind === "string_list") {
    const text = Array.isArray(current) ? current.join(", ") : String(current);
    return `<label class="field"><span>${escapeHtml(spec.label)}</span>
      <input type="text" data-stt-field="${name}" data-list="1" value="${escapeHtml(text)}"
        placeholder="через запятую">${hint}</label>`;
  }
  if (spec.kind === "json") {
    const text = typeof current === "object" ? JSON.stringify(current, null, 2) : String(current || "");
    return `<label class="field"><span>${escapeHtml(spec.label)}</span>
      <textarea data-stt-field="${name}" data-json="1" rows="4">${escapeHtml(text)}</textarea>${hint}</label>`;
  }
  const type = spec.kind === "number" ? "number" : "text";
  const bounds = `${spec.minimum !== undefined ? ` min="${spec.minimum}"` : ""}${spec.maximum !== undefined ? ` max="${spec.maximum}"` : ""}`;
  return `<label class="field"><span>${escapeHtml(spec.label)}</span>
    <input type="${type}" data-stt-field="${name}"${bounds} value="${escapeHtml(String(current))}"
      placeholder="${escapeHtml(spec.placeholder || "")}">${hint}</label>`;
}

function openSttEditor(config) {
  state.sttEditing = config || null;
  const providers = state.sttSchemas || [];
  const provider = config?.provider || providers[0]?.provider;
  const schema = sttSchema(provider);
  if (!schema) return toast("Схемы провайдеров недоступны — media-service не отвечает", true);

  $("#stt-dialog-title").textContent = config ? config.name : "Новая конфигурация";
  $("#stt-dialog-hint").textContent = `${schema.summary} Параметры сверены ${schema.verified_on}.`;
  $("#stt-form-error").hidden = true;
  renderSttForm(schema, config);
  $("#stt-dialog").showModal();
}

function renderSttForm(schema, config) {
  const caps = schema.capabilities || {};
  const params = config?.public_config || {};
  const mode = config?.mode || "batch";
  const providerSelect = (state.sttSchemas || [])
    .map((item) => `<option value="${item.provider}" ${item.provider === schema.provider ? "selected" : ""}>${escapeHtml(item.label)}</option>`)
    .join("");

  // Модель: список проверенных пресетов плюс «Указать вручную».
  // Неизвестная модель не должна требовать правки frontend-кода.
  const presets = (schema.model_presets || [])
    .map((preset) => `<option value="${escapeHtml(preset.value)}" ${preset.value === config?.model ? "selected" : ""}>${escapeHtml(preset.label)}${preset.hint ? ` — ${escapeHtml(preset.hint)}` : ""}</option>`)
    .join("");
  const custom = config?.model && !(schema.model_presets || []).some((preset) => preset.value === config.model);

  const baseUrl = config?.base_url
    || (mode === "streaming" && schema.default_streaming_base_url) || schema.default_base_url;

  const bySection = new Map(STT_SECTIONS.map(([key]) => [key, []]));
  for (const spec of schema.fields || []) {
    if (spec.only_mode && spec.only_mode !== mode) continue;
    const rendered = sttField(spec, params[spec.name], caps);
    if (rendered) bySection.get(spec.section || "advanced")?.push(rendered);
  }

  const secretBlock = schema.provider === "google"
    ? `<label class="field"><span>Service account JSON</span>
         <input type="file" id="stt-credentials" accept="application/json,.json">
         <small class="muted">Файл загружается один раз и целиком уходит в Secret Store.
           В конфигурации остаются только project_id и маскированная почта.</small></label>
       <p class="muted">${config?.secret?.configured ? "Учётные данные настроены." : "Учётные данные не заданы."}</p>`
    : `<label class="field"><span>API-ключ</span>
         <input type="password" id="stt-api-key" autocomplete="new-password" placeholder="${
           config?.secret?.configured ? "Настроен — оставьте пустым, чтобы сохранить" : "Введите ключ"}">
         <small class="muted">Показывается только признак «настроен». Просмотреть сохранённый ключ нельзя.</small></label>`;

  $("#stt-form").innerHTML = `
    <fieldset class="field"><legend>Основные настройки</legend>
      <label class="field"><span>Название</span>
        <input type="text" id="stt-name" value="${escapeHtml(config?.name || "")}" maxlength="120"></label>
      <label class="field"><span>Провайдер</span>
        <select id="stt-provider" ${config ? "disabled" : ""}>${providerSelect}</select>
        ${config ? '<small class="muted">Провайдера существующей конфигурации менять нельзя — параметры несовместимы.</small>' : ""}</label>
      <label class="field"><span>Режим</span>
        <select id="stt-mode">
          <option value="batch" ${mode === "batch" ? "selected" : ""}>batch — запись целиком</option>
          ${caps.streaming ? `<option value="streaming" ${mode === "streaming" ? "selected" : ""}>streaming — поток</option>` : ""}
        </select>${caps.streaming ? "" : '<small class="muted">Провайдер не поддерживает потоковое распознавание.</small>'}</label>
      <label class="field"><span>Base URL</span>
        <input type="text" id="stt-base-url" value="${escapeHtml(baseUrl)}"></label>
      <label class="switch"><input type="checkbox" id="stt-allow-private">
        <span>Разрешить адрес во внутренней сети (self-hosted)</span></label>
      ${bySection.get("basic").join("")}
    </fieldset>

    <fieldset class="field"><legend>Модель и язык</legend>
      <label class="field"><span>Модель</span>
        <select id="stt-model-preset">${presets}<option value="__custom__" ${custom ? "selected" : ""}>Указать вручную…</option></select></label>
      <label class="field" id="stt-model-custom-wrap" ${custom ? "" : "hidden"}><span>Своя модель</span>
        <input type="text" id="stt-model-custom" value="${escapeHtml(custom ? config.model : "")}">
        <small class="muted">Произвольное имя допустимо, но работоспособность подтверждает только кнопка «Проверить».</small></label>
      ${bySection.get("model").join("")}
    </fieldset>

    ${["formatting", "features", "advanced"].map((key) => {
      const items = bySection.get(key);
      if (!items.length) return "";
      const title = STT_SECTIONS.find(([code]) => code === key)[1];
      return `<fieldset class="field"><legend>${title}</legend>${items.join("")}</fieldset>`;
    }).join("")}

    <fieldset class="field"><legend>Секрет</legend>${secretBlock}</fieldset>`;
}

function collectSttForm() {
  const params = {};
  for (const input of document.querySelectorAll("#stt-form [data-stt-field]")) {
    const name = input.dataset.sttField;
    if (input.type === "checkbox") { params[name] = input.checked; continue; }
    const raw = input.value.trim();
    if (!raw) continue;
    if (input.dataset.list) {
      params[name] = raw.split(",").map((item) => item.trim()).filter(Boolean);
    } else if (input.dataset.json) {
      try { params[name] = JSON.parse(raw); }
      catch { throw new Error(`Поле «${name}» не разбирается как JSON`); }
    } else if (input.type === "number") {
      params[name] = Number(raw);
    } else {
      params[name] = raw;
    }
  }
  const multi = {};
  for (const input of document.querySelectorAll("#stt-form [data-stt-multi]")) {
    const name = input.dataset.sttMulti;
    multi[name] = multi[name] || [];
    if (input.checked) multi[name].push(input.value);
  }
  for (const [name, values] of Object.entries(multi)) {
    if (values.length) params[name] = values;
  }

  const preset = $("#stt-model-preset").value;
  const model = preset === "__custom__" ? $("#stt-model-custom").value.trim() : preset;

  return {
    name: $("#stt-name").value.trim(),
    provider: $("#stt-provider").value,
    mode: $("#stt-mode").value,
    base_url: $("#stt-base-url").value.trim(),
    model,
    public_config: params,
    allow_private_endpoint: $("#stt-allow-private").checked,
  };
}

async function readCredentialsFile() {
  const input = $("#stt-credentials");
  const file = input?.files?.[0];
  if (!file) return null;
  if (file.size > 16 * 1024) throw new Error("Файл слишком велик — ожидается service account JSON");
  return await file.text();
}

async function saveSttConfig() {
  const body = collectSttForm();
  const editing = state.sttEditing;

  if (body.provider === "google") {
    const credentials = await readCredentialsFile();
    if (credentials) body.credentials_json = credentials;
    else if (!editing) throw new Error("Загрузите service account JSON");
  } else {
    const key = $("#stt-api-key").value.trim();
    // Пустое поле при редактировании означает «оставить прежний ключ».
    if (key) body.api_key = key;
    else if (!editing) throw new Error("Введите API-ключ");
  }

  const send = async () => {
    if (editing) {
      body.config_version = editing.config_version;
      await request(`/stt/configs/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
    } else {
      await request("/stt/configs", { method: "POST", body: JSON.stringify(body) });
    }
    $("#stt-dialog").close();
    toast("Конфигурация сохранена");
    await loadStt();
  };

  sttAction(send);
}

/**
 * Blob → base64 без рекурсии по стеку.
 *
 * `String.fromCharCode(...bytes)` на записи в несколько сотен килобайт
 * падает с «too many arguments»: аргументы кладутся на стек, и он
 * кончается. Поэтому кусками.
 */
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 8 * 1024;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/**
 * Запись голоса прямо в окне проверки.
 *
 * Встроенный сигнал подтверждает, что провайдер отвечает и ключ принят.
 * Это не то же самое, что «распознавание работает»: язык, акцент,
 * микрофон и шум комнаты проверяются только собственным голосом. Ради
 * этого запись и добавлена — раньше для неё приходилось искать
 * стороннее приложение, сохранять файл и подкладывать его через
 * «выбрать файл».
 */
const recorder = {
  media: null,
  chunks: [],
  blob: null,
  stream: null,
  startedAt: 0,
  timer: null,
};

/** Ставит запись на паузу и отпускает микрофон. */
function stopRecording() {
  clearInterval(recorder.timer);
  recorder.timer = null;
  if (recorder.media?.state === "recording") recorder.media.stop();
  // Поток закрывается всегда: иначе индикатор микрофона в браузере
  // горит и после того, как окно закрыли.
  recorder.stream?.getTracks().forEach((track) => track.stop());
  recorder.stream = null;
}

function renderRecorderIdle(message) {
  $("#stt-record").classList.remove("is-recording");
  $("#stt-record-label").textContent = recorder.blob ? "Записать заново" : "Записать голос";
  if (message) $("#stt-record-state").textContent = message;
}

async function toggleRecording() {
  const button = $("#stt-record");
  if (button.classList.contains("is-recording")) {
    stopRecording();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("Браузер не умеет записывать звук — подложите файл");
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    // NotAllowedError приходит и когда отказал человек, и когда запретил
    // сервер заголовком Permissions-Policy. Второе однажды уже случилось
    // и выглядело как «кнопка не работает»: браузер даже не спрашивал
    // разрешения. Поэтому названы обе причины — гадать не должен никто.
    if (error?.name === "NotFoundError") {
      throw new Error("Микрофон не найден. Подложите готовый файл в «Других способах»");
    }
    throw new Error(
      "Микрофон недоступен. Проверьте разрешение для сайта в настройках браузера. "
      + "Если разрешение выдано, а запись не идёт — доступ закрыт заголовком "
      + "Permissions-Policy на сервере. Пока можно подложить готовый файл "
      + "в «Других способах».",
    );
  }

  // Тип оставляем на усмотрение браузера: Chrome пишет webm/opus,
  // Safari — mp4/aac, и навязывать им чужой контейнер значит получить
  // пустую запись. Распаковкой занимается ffmpeg в media-service.
  recorder.media = new MediaRecorder(stream);
  recorder.stream = stream;
  recorder.chunks = [];
  recorder.blob = null;
  recorder.startedAt = Date.now();

  recorder.media.ondataavailable = (event) => {
    if (event.data.size) recorder.chunks.push(event.data);
  };
  recorder.media.onstop = () => {
    recorder.blob = new Blob(recorder.chunks, { type: recorder.media.mimeType });
    const preview = $("#stt-record-preview");
    preview.src = URL.createObjectURL(recorder.blob);
    preview.hidden = false;
    const seconds = Math.round((Date.now() - recorder.startedAt) / 1000);
    renderRecorderIdle(`Записано ${seconds} с. Нажмите «Запустить проверку».`);
  };

  recorder.media.start();
  button.classList.add("is-recording");
  $("#stt-record-label").textContent = "Остановить";
  $("#stt-record-preview").hidden = true;

  recorder.timer = setInterval(() => {
    const seconds = Math.round((Date.now() - recorder.startedAt) / 1000);
    $("#stt-record-state").textContent = `Идёт запись… ${seconds} с`;
    // Тридцати секунд хватает любому провайдеру, чтобы показать себя, а
    // забытая включённой запись не должна превратиться в счёт за минуты.
    if (seconds >= 30) stopRecording();
  }, 250);
}

/** Открывает окно проверки в чистом состоянии. */
function openSttTestDialog(id, name) {
  state.sttTestingId = id;
  $("#stt-test-title").textContent = name ? `Проверка — ${name}` : "Проверка распознавания";
  $("#stt-test-result").hidden = true;
  if ($("#stt-test-file")) $("#stt-test-file").value = "";
  recorder.blob = null;
  recorder.chunks = [];
  $("#stt-record-preview").hidden = true;
  renderRecorderIdle("Скажите несколько слов — их и будем распознавать.");
  $("#stt-test-dialog").showModal();
}

async function runSttTest() {
  const id = state.sttTestingId;
  const file = $("#stt-test-file")?.files?.[0];
  let audio;
  // Своя запись важнее подложенного файла: её только что сделали
  // именно для этой проверки.
  if (recorder.blob) audio = await blobToBase64(recorder.blob);
  else if (file) audio = await blobToBase64(file);

  const host = $("#stt-test-result");
  host.hidden = false;
  host.textContent = "Проверяю…";

  const { payload } = await request(`/stt/configs/${id}/test`, {
    method: "POST",
    body: JSON.stringify(audio ? { audio_base64: audio } : {}),
  });

  // Проверяются все ключи, а не только первый: список имеет смысл лишь
  // тогда, когда известно состояние каждого.
  const perKey = (payload.keys || []).length
    ? `<div class="key-list">${payload.keys.map((key) => `
        <article class="key-row">
          <span class="dot ${key.success ? "green" : "red"}"></span>
          <div class="key-main">
            <strong>${escapeHtml(key.label)}</strong>
            <p class="muted">${key.success
              ? `работает · ${key.latency_ms ?? "?"} мс`
              : escapeHtml(`${key.error_code || "ошибка"}${key.error_message ? ` — ${String(key.error_message).slice(0, 160)}` : ""}`)}</p>
          </div>
        </article>`).join("")}</div>`
    : "";

  if (payload.success) {
    // Поля, которых провайдер не вернул, не показываем вовсе: пустое
    // место честнее выдуманного числа.
    host.innerHTML = `<strong>Успешно.</strong>
      <dl class="status-meta">
        <div><dt>Провайдер</dt><dd>${escapeHtml(payload.provider)}</dd></div>
        <div><dt>Модель</dt><dd>${escapeHtml(payload.model)}</dd></div>
        ${payload.upstream_provider ? `<div><dt>Фактический upstream</dt><dd>${escapeHtml(payload.upstream_provider)}</dd></div>` : ""}
        <div><dt>Задержка</dt><dd>${payload.latency_ms} мс</dd></div>
        <div><dt>Длительность</dt><dd>${payload.audio_duration_ms} мс</dd></div>
        ${payload.language ? `<div><dt>Язык</dt><dd>${escapeHtml(payload.language)}</dd></div>` : ""}
        ${payload.confidence !== undefined ? `<div><dt>Уверенность</dt><dd>${payload.confidence}</dd></div>` : ""}
        ${payload.provider_request_id ? `<div><dt>Request ID</dt><dd>${escapeHtml(payload.provider_request_id)}</dd></div>` : ""}
      </dl>
      <p><em>Расшифровка:</em> ${escapeHtml(payload.transcript || "(пусто)")}</p>
      ${(payload.warnings || []).length ? `<p class="muted">${payload.warnings.map(escapeHtml).join("; ")}</p>` : ""}
      ${perKey}`;
  } else {
    host.innerHTML = `<strong>Не удалось.</strong>
      <p>${escapeHtml(payload.error?.message || "провайдер не ответил")}</p>
      <p class="muted">Код: ${escapeHtml(payload.error?.code || "неизвестен")}</p>
      ${perKey}`;
  }
  await loadStt();
}

async function saveSttRoute(useCase) {
  const card = document.querySelector(`[data-route="${useCase}"]`);
  const body = {};
  for (const input of card.querySelectorAll("[data-route-field]")) {
    const name = input.dataset.routeField;
    if (input.type === "checkbox") body[name] = input.checked;
    else body[name] = input.value === "" ? null : input.value;
  }
  sttAction(async () => {
      await request(`/stt/routes/${encodeURIComponent(useCase)}`, {
        method: "PUT", body: JSON.stringify(body),
      });
      toast("Маршрут применён");
      await loadStt();
    });
}

// ---------------------------------------------------------------------
// события раздела
// ---------------------------------------------------------------------
document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-stt-tab]");
  if (tab) {
    document.querySelectorAll("[data-stt-tab]").forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    const active = tab.dataset.sttTab;
    $("#stt-configs").hidden = active !== "configs";
    $("#stt-routes").hidden = active !== "routes";
    $("#stt-usage").hidden = active !== "usage";
    if (active === "usage") loadSttUsage().catch(handleError);
    return;
  }

  const link = event.target.closest("[data-stt-chain]");
  if (link) {
    sttChainAction(link.dataset.sttChain, link.dataset.route, link.dataset.config);
    return;
  }

  const action = event.target.closest("[data-stt-action]");
  if (!action) return;
  const id = action.dataset.id;
  const config = state.sttConfigs?.find((item) => item.id === id);

  switch (action.dataset.sttAction) {
    case "edit":
      openSttEditor(config);
      break;
    case "test":
      openSttTestDialog(id, config?.name);
      break;
    case "archive":
      sttAction(async () => {
          await request(`/stt/configs/${id}/archive`, { method: "POST" });
          toast("Конфигурация в архиве");
          await loadStt();
        });
      break;
    case "restore":
      sttAction(async () => {
          await request(`/stt/configs/${id}/restore`, { method: "POST" });
          await loadStt();
        });
      break;
    case "key":
      openSttKeyDialog(config).catch(handleError);
      break;
    case "activate":
      sttAction(async () => {
          await request(`/stt/configs/${id}/activate`, {
            method: "POST",
            body: JSON.stringify({ use_case: "telegram_voice", slot: "primary" }),
          });
          toast("Провайдер активирован для голосовых Telegram");
          await loadStt();
        });
      break;
    case "toggle": {
      const enable = action.dataset.enabled !== "true";
      sttAction(async () => {
          await request(`/stt/configs/${id}/enabled`, {
            method: "POST", body: JSON.stringify({ enabled: enable }),
          });
          await loadStt();
        });
      break;
    }
    case "save-route":
      saveSttRoute(id);
      break;
    default:
      break;
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "stt-model-preset") {
    $("#stt-model-custom-wrap").hidden = event.target.value !== "__custom__";
  }
  // Смена провайдера или режима перестраивает форму: у Deepgram и
  // Google нет ни одного общего поля, а streaming добавляет свои.
  if (event.target.id === "stt-provider" || event.target.id === "stt-mode") {
    const schema = sttSchema($("#stt-provider").value);
    if (schema) renderSttForm(schema, { ...(state.sttEditing || {}), mode: $("#stt-mode").value });
  }
});

// Кнопки диалогов раздела распознавания. Регистрируются один раз здесь,
// а не в разметке, чтобы обработчики жили рядом с логикой раздела.
$("#new-stt-config")?.addEventListener("click", () => openSttEditor(null));

/**
 * Закрытие любого диалога кнопкой «Назад».
 *
 * Обработчик один на всю страницу и работает по data-атрибуту: раньше
 * каждому окну полагалась своя строчка, и окно, добавленное без неё,
 * закрыть было нечем.
 */
document.addEventListener("click", (event) => {
  const back = event.target.closest("[data-close-dialog]");
  if (!back) return;
  document.querySelector(`#${back.dataset.closeDialog}`)?.close();
});

/**
 * Аппаратная кнопка «назад» на андроиде.
 *
 * Chrome закрывает по ней <dialog> не во всех версиях, а привычка
 * нажимать её — первое, что делает рука. Запись в истории на время
 * показа окна превращает «назад» в закрытие: браузер снимает запись,
 * мы ловим popstate и закрываем окно сами.
 */
function trackDialogHistory(dialog) {
  if (dialog.dataset.historyTracked) return;
  dialog.dataset.historyTracked = "1";
  const open = dialog.showModal.bind(dialog);
  dialog.showModal = () => {
    open();
    history.pushState({ dialog: dialog.id }, "");
  };
  dialog.addEventListener("close", () => {
    // Закрыли крестиком или Escape — лишнюю запись надо убрать, иначе
    // следующее «назад» ничего не сделает.
    if (history.state?.dialog === dialog.id) history.back();
  });
}
window.addEventListener("popstate", () => {
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
});
document.querySelectorAll("#page-stt dialog").forEach(trackDialogHistory);
$("#stt-save")?.addEventListener("click", () => {
  saveSttConfig().catch((error) => {
    const host = $("#stt-form-error");
    host.hidden = false;
    host.textContent = error instanceof Error ? error.message : String(error);
  });
});
$("#stt-test")?.addEventListener("click", () => {
  // Проверка из редактора имеет смысл только для сохранённой
  // конфигурации: у несохранённой ещё нет ключа в Secret Store.
  if (!state.sttEditing) {
    const host = $("#stt-form-error");
    host.hidden = false;
    host.textContent = "Сначала сохраните конфигурацию — проверка использует ключ из Secret Store";
    return;
  }
  openSttTestDialog(state.sttEditing.id, state.sttEditing.name);
});
$("#stt-test-run")?.addEventListener("click", () => {
  runSttTest().catch(handleError);
});
$("#stt-record")?.addEventListener("click", () => {
  toggleRecording().catch((error) => {
    renderRecorderIdle(error instanceof Error ? error.message : String(error));
  });
});
// Закрыли окно — микрофон отпускаем и запись забываем: чужой голос из
// прошлой проверки не должен уехать в следующую.
$("#stt-test-dialog")?.addEventListener("close", () => {
  stopRecording();
  recorder.blob = null;
  recorder.chunks = [];
  const preview = $("#stt-record-preview");
  if (preview) { preview.hidden = true; preview.removeAttribute("src"); }
});

// ---------------------------------------------------------------------
// Ввод ключа отдельным окном
// ---------------------------------------------------------------------
// Главный сценарий раздела: у преднастроенного провайдера всё уже
// заполнено, и остаётся вписать один ключ. Гонять оператора через
// полный редактор параметров ради этого незачем.
async function openSttKeyDialog(config) {
  if (!config) return;
  state.sttEditing = config;
  const isGoogleCloud = config.provider === "google";

  $("#stt-key-title").textContent = `Ключи — ${config.name}`;
  $("#stt-key-hint").textContent =
    "Ключи перебираются сверху вниз. Когда один упирается в лимит или "
    + "перестаёт работать, распознавание тут же продолжается следующим — "
    + "пользователь ничего не замечает. Значения не показываются обратно.";
  $("#stt-key-label").value = "";
  $("#stt-key-field").innerHTML = isGoogleCloud
    ? `<label class="field"><span>Service account JSON</span>
         <input type="file" id="stt-key-file" accept="application/json,.json">
         <small class="muted">Файл целиком уходит в Secret Store; в конфигурации
           останутся только project_id и маскированная почта.</small></label>`
    : `<label class="field"><span>API-ключ</span>
         <input type="password" id="stt-key-value" autocomplete="new-password"
                placeholder="Вставьте ключ">
         <small class="muted">${keyHint(config.provider)}</small></label>`;
  $("#stt-key-error").hidden = true;
  // Список первого ключа ещё нет — форма добавления раскрыта сразу,
  // чтобы не заставлять кликать по пустому месту.
  $("#stt-key-add").open = !(config.keys?.total > 0);
  $("#stt-key-dialog").showModal();
  await refreshSttKeys(config.id);
}

/**
 * Список ключей конфигурации.
 *
 * Значений здесь нет — только подписи, состояние и счётчики. Ошибка
 * загрузки не закрывает диалог: добавить ключ можно и не видя списка.
 */
async function refreshSttKeys(configId) {
  const host = $("#stt-key-list");
  host.innerHTML = `<p class="muted">Загружаю…</p>`;
  let keys = [];
  try {
    const { payload } = await request(`/stt/configs/${configId}/keys`);
    keys = payload.keys || [];
  } catch (error) {
    host.innerHTML = `<p class="integration-status error">${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</p>`;
    return;
  }
  state.sttKeys = keys;

  if (!keys.length) {
    host.innerHTML = `<p class="muted">Ключей пока нет. Пока их нет, распознавание
      этим провайдером не работает.</p>`;
    return;
  }

  host.innerHTML = keys.map((key, index) => {
    const [label, color] = STT_KEY_STATUS[key.status] || [key.status, "gray"];
    const cooldown = key.cooldown_until && new Date(key.cooldown_until) > new Date()
      ? ` до ${new Date(key.cooldown_until).toLocaleString("ru")}`
      : "";
    return `
      <article class="key-row${key.enabled ? "" : " muted"}" data-key-id="${key.id}">
        <span class="dot ${key.enabled ? color : "gray"}"></span>
        <div class="key-main">
          <strong>${escapeHtml(key.label)}</strong>
          <p class="muted">${index + 1}-й в очереди · ${key.enabled ? label + cooldown : "выключен"}
            · успешно ${key.success_count}, с ошибкой ${key.failure_count}</p>
          ${key.last_error_code
            ? `<p class="muted">Последняя ошибка: ${escapeHtml(key.last_error_code)}</p>` : ""}
        </div>
        <div class="key-actions">
          <button class="button ghost" data-key-action="toggle" data-key-id="${key.id}"
                  data-enabled="${key.enabled}">${key.enabled ? "Выключить" : "Включить"}</button>
          <button class="button ghost" data-key-action="remove" data-key-id="${key.id}">Удалить</button>
        </div>
      </article>`;
  }).join("");
}

const STT_KEY_STATUS = {
  active: ["работает", "green"],
  exhausted: ["лимит исчерпан", "yellow"],
  invalid: ["отвергнут провайдером", "red"],
};

/** Где взять ключ — вопрос, который возникает у каждого нового провайдера. */
function keyHint(provider) {
  return {
    deepgram: "console.deepgram.com → API Keys",
    google_ai_studio: "ai.google.dev → Get API key. Облачный проект и биллинг не нужны",
    openai: "platform.openai.com → API keys",
    openrouter: "openrouter.ai/keys",
  }[provider] ?? "";
}

async function saveSttKey() {
  const config = state.sttEditing;
  if (!config) return;

  const body = {};
  const label = $("#stt-key-label").value.trim();
  if (label) body.label = label;
  if (config.provider === "google") {
    const file = $("#stt-key-file")?.files?.[0];
    if (!file) throw new Error("Выберите файл service account JSON");
    if (file.size > 16 * 1024) throw new Error("Файл слишком велик — ожидается service account JSON");
    body.credentials_json = await file.text();
  } else {
    const value = $("#stt-key-value").value.trim();
    if (!value) throw new Error("Введите ключ");
    body.api_key = value;
  }

  sttAction(async () => {
      await request(`/stt/configs/${config.id}/keys`, {
        method: "POST", body: JSON.stringify(body),
      });
      // Диалог остаётся открытым: ключей обычно добавляют несколько
      // подряд, и закрывать его после каждого — лишний клик.
      if ($("#stt-key-value")) $("#stt-key-value").value = "";
      if ($("#stt-key-file")) $("#stt-key-file").value = "";
      $("#stt-key-label").value = "";
      $("#stt-key-error").hidden = true;
      toast("Ключ добавлен");
      await refreshSttKeys(config.id);
      await loadStt();
    });
}

/** Включение, выключение и удаление отдельного ключа. */
async function sttKeyAction(action, keyId) {
  const config = state.sttEditing;
  if (!config) return;
  const key = (state.sttKeys || []).find((item) => item.id === keyId);

  if (action === "toggle") {
    const enable = !key?.enabled;
    await request(`/stt/configs/${config.id}/keys/${keyId}`, {
      method: "PATCH", body: JSON.stringify({ enabled: enable }),
    });
    toast(enable ? "Ключ снова в очереди" : "Ключ выключен");
  } else if (action === "remove") {
    if (!confirm(`Удалить ключ «${key?.label ?? ""}»? Значение будет стёрто из Secret Store.`)) {
      return;
    }
    await request(`/stt/configs/${config.id}/keys/${keyId}`, { method: "DELETE" });
    toast("Ключ удалён");
  } else {
    return;
  }
  await refreshSttKeys(config.id);
  await loadStt();
}

$("#stt-key-save")?.addEventListener("click", () => {
  saveSttKey().catch((error) => {
    const host = $("#stt-key-error");
    host.hidden = false;
    host.textContent = error instanceof Error ? error.message : String(error);
  });
});

$("#stt-key-list")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-key-action]");
  if (!button) return;
  // Изменение ключей — та же операция с секретами, что и добавление,
  // поэтому и подтверждение то же.
  sttAction(() => sttKeyAction(button.dataset.keyAction, button.dataset.keyId));
});
