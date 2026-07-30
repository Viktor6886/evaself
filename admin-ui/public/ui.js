const API = "/api/admin/v1";
const state = {
  me: null,
  page: "overview",
  overview: null,
  integration: null,
  settings: null,
  etag: null,
  providers: [],
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
  const { payload } = await request("/providers?kind=llm");
  state.providers = Array.isArray(payload.providers) ? payload.providers : [];
  const active = state.providers.find((item) => item.is_active);
  $("#ai-summary").innerHTML = `
    <div class="stat"><strong>${state.providers.length}</strong><span>LLM-конфигураций</span></div>
    <div class="stat"><strong>${active ? escapeHtml(active.name) : "—"}</strong><span>активный провайдер</span></div>
    <div class="stat"><strong>${active ? escapeHtml(active.model) : "—"}</strong><span>активная модель</span></div>`;
  $("#providers-list").innerHTML = state.providers.length
    ? state.providers.map(providerCard).join("")
    : '<article class="empty-card"><h3>LLM-провайдер ещё не добавлен</h3><p>Добавьте первую OpenAI-compatible конфигурацию.</p></article>';
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
  await request(id ? `/providers/${encodeURIComponent(id)}` : "/providers", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(body),
  });
  form.elements.api_key.value = "";
  $("#provider-editor").hidden = true;
  toast(id ? "Провайдер обновлён" : "Провайдер создан");
  await loadProviders();
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
  $("#settings-meta").innerHTML = `
    <div class="stat"><strong>${payload.settings.length}</strong><span>параметров в реестре</span></div>
    <div class="stat"><strong>${payload.missing_required}</strong><span>обязательных не заполнено</span></div>
    <div class="stat"><strong>${payload.version}</strong><span>версия конфигурации</span></div>`;
  $("#settings-form").innerHTML = payload.settings.map((item) => `
    <article class="setting-card">
      <div class="setting-head"><div><h3>${escapeHtml(item.title)}</h3><span class="technical">${escapeHtml(item.key)}</span></div>${item.requires_restart ? '<span class="tag">нужен перезапуск</span>' : ""}</div>
      <p>${escapeHtml(item.description)}</p>
      <label>Значение${inputFor(item)}</label>
      <div class="setting-actions"><span class="technical">Влияет: ${escapeHtml(item.affects.join(", "))}</span><button class="reset" type="button" data-reset="${escapeHtml(item.key)}">По умолчанию</button></div>
    </article>`).join("");
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
      action: async () => await restartService("agent-runtime"),
    });
  }
}

async function loadSecrets() {
  if (!["owner", "admin"].includes(state.me.role)) {
    $("#secrets-list").innerHTML = '<article class="secret-card">Для просмотра метаданных секретов нужна роль owner или admin.</article>';
    return;
  }
  const { payload } = await request("/secrets");
  $("#secrets-list").innerHTML = payload.secrets.length
    ? payload.secrets.map((item) => `
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
    : '<article class="secret-card"><div><h3>Секреты ещё не импортированы</h3><p class="muted">Запустите идемпотентный admin-bootstrap.</p></div></article>';
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
