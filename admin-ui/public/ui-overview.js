/**
 * Раздел «Обзор»: вердикт, сервер одной строкой, группы состояния и
 * список последних ошибок.
 */
async function loadOverview() {
  const [{ payload }, routing] = await Promise.all([
    request("/overview"),
    request("/llm/state").catch(() => ({ payload: null })),
  ]);
  state.overview = payload;
  if (routing.payload) state.router = routing.payload;
  // Версия — украшение шапки, а не смысл страницы. Её отсутствие не
  // должно уносить с собой вердикт, состояние сервисов и загрузку
  // сервера: именно за ними сюда и заходят.
  $("#system-version").textContent = payload.installation?.version ?? "—";
  renderVerdict(payload);
  renderHostBar(payload);
  renderOverviewGroups(payload);
  renderRoutingOverview();
}

function renderRoutingOverview() {
  const node = $("#overview-model-routing");
  if (!node) return;
  const settings = state.router?.routing_settings || {};
  const mode = settings.mode || "adaptive";
  const editable = ["owner", "admin"].includes(state.me.role);
  const roles = ["chat", "deep", "fast", "json"];
  const selected = mode === "single"
    ? (state.router?.providers || []).find((provider) => provider.id === settings.single_provider_id)
    : null;
  node.innerHTML = `
    <div class="routing-mode-line">
      <label class="switch"><input type="checkbox" data-overview-routing-toggle ${mode === "adaptive" ? "checked" : ""}${editable ? "" : " disabled"}>
        <span>Автоматический выбор моделей</span></label>
      <span class="status-pill">${mode === "single" ? "Одна модель" : "Адаптивный"}</span>
    </div>
    ${mode === "single" ? `<article class="routing-single-card">
      <span>Единая модель Евы</span><strong>${escapeHtml(selected?.name || "не настроена")}</strong>
      <small>${escapeHtml(selected?.model || "Выберите provider на странице ИИ")} · аварийный резерв ${settings.single_failover_enabled ? "включён" : "выключен"}</small>
    </article>` : '<div class="overview-route-chains"></div>'}`;
  if (mode === "adaptive") renderRouteChains(node.querySelector(".overview-route-chains"), roles, true);
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
