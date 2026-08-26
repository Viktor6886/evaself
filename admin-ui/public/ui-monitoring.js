/**
 * Раздел «Мониторинг»: состояние сервисов, последние проверки и ошибки.
 *
 * Данные собственные. health-worker уже опрашивает каждый сервис
 * каталога, `service_statuses` держит текущее состояние, `health_checks` —
 * историю, а `audit_log` — неудавшиеся операции. Внешняя статусная
 * страница видела бы то же самое снаружи и с опозданием, поэтому
 * отдельного публичного Uptime Kuma больше нет.
 *
 * От «Обзора» раздел отличается горизонтом: обзор отвечает на вопрос
 * «всё ли в порядке сейчас», мониторинг — «что происходило за окно».
 */
const CHECK_STATUS_LABELS = {
  pending: "в очереди",
  running: "выполняется",
  success: "успешно",
  failure: "ошибка",
};

const ERROR_SOURCE_LABELS = {
  operation: "операция",
  check: "проверка",
  status: "состояние",
};

async function loadMonitoring() {
  const hours = $("#monitoring-hours").value || "24";
  const { payload } = await request(`/panel/monitoring?hours=${encodeURIComponent(hours)}&limit=50`);
  state.monitoring = payload;

  const failing = payload.failing || [];
  $("#monitoring-verdict").className = `verdict color-${payload.overall_status}`;
  $("#monitoring-title").textContent = failing.length
    ? `Требует внимания: ${failing.map((item) => item.title).slice(0, 3).join(", ")}`
    : "Все сервисы работают";
  $("#monitoring-detail").textContent = [
    `в норме ${payload.summary?.healthy ?? 0} из ${payload.summary?.services ?? 0}`,
    `предупреждений ${payload.summary?.warnings ?? 0}`,
    `критических ${payload.summary?.critical ?? 0}`,
    `сбоев за сутки ${payload.summary?.critical_events_24h ?? 0}`,
  ].join(" · ");

  renderHostBarInto($("#monitoring-host"), payload.host || {});
  renderMonitoringGroups(payload.groups || {});
  renderMonitoringChecks(payload.recent_checks || []);
  renderMonitoringErrors(payload.errors?.items || []);
}

/**
 * Строка сервера. Общая с «Обзором» по содержанию, но пишет в свой узел:
 * два раздела показывают одно и то же и расходиться им незачем.
 */
function renderHostBarInto(node, host) {
  if (!node) return;
  const usedMemory = Number(host.memory_total_bytes) - Number(host.memory_free_bytes);
  const usedDisk = Number(host.disk_total_bytes) - Number(host.disk_free_bytes);
  const load = Array.isArray(host.load_average) ? Number(host.load_average[0]) : null;
  const cpus = Number(host.cpu_count) || 1;
  const cells = [
    ["CPU", load === null ? "—" : `${Math.round((load / cpus) * 100)}%`],
    ["RAM", monitoringPercent(usedMemory, host.memory_total_bytes)],
    ["Диск", monitoringPercent(usedDisk, host.disk_total_bytes)],
    ["Uptime", duration(host.uptime_seconds)],
    ["Хост", host.hostname || "сервер"],
  ];
  node.innerHTML = cells
    .map(([label, value]) => `
      <div class="host-cell"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");
}

function monitoringPercent(used, total) {
  const value = Number(total);
  if (!Number.isFinite(value) || value <= 0) return "—";
  return `${Math.round((Number(used) / value) * 100)}%`;
}

function renderMonitoringGroups(groups) {
  const names = {
    core: "Основное ядро",
    storage: "Хранилища",
    ai: "Внутренние AI-сервисы",
    external: "Внешние интеграции",
    infrastructure: "Инфраструктура",
  };
  $("#monitoring-groups").innerHTML = Object.entries(groups)
    .map(([name, items]) => `
      <section class="overview-group">
        <div class="section-heading">
          <div><h3>${escapeHtml(names[name] || name)}</h3></div>
          <span class="group-count">${items.filter((item) => item.status.color === "green").length} из ${items.length} в норме</span>
        </div>
        <div class="mini-status-list">${items.map((item) => `
          <div class="monitor-row">
            <span class="status-dot color-${escapeHtml(item.status.color)}"></span>
            <strong>${escapeHtml(item.title)}</strong>
            <span class="mini-hint">${escapeHtml(statusName(item.status))}</span>
            <span class="technical">${escapeHtml(item.status.last_check_at ? localDate(item.status.last_check_at) : "нет снимка")}</span>
            <button class="button tiny ghost" data-check="${escapeHtml(item.id)}" data-target-type="${escapeHtml(item.type)}" type="button">Проверить</button>
          </div>`).join("")}</div>
      </section>`)
    .join("");
}

function renderMonitoringChecks(checks) {
  $("#monitoring-checks-body").innerHTML = checks.length
    ? checks.map((row) => `
      <tr>
        <td>${escapeHtml(localDate(row.finished_at || row.requested_at))}</td>
        <td>${escapeHtml(row.title)}</td>
        <td><span class="result ${row.ok === false ? "failure" : "success"}">${escapeHtml(CHECK_STATUS_LABELS[row.status] || row.status)}</span></td>
        <td>${row.duration_ms == null ? "—" : `${escapeHtml(row.duration_ms)} мс`}</td>
        <td>${escapeHtml(row.error_message_short || row.error_code || "—")}</td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="muted">Проверок ещё не было.</td></tr>';
}

function renderMonitoringErrors(items) {
  $("#monitoring-errors-body").innerHTML = items.length
    ? items.map((item) => `
      <tr>
        <td>${escapeHtml(localDate(item.at))}</td>
        <td>${escapeHtml(ERROR_SOURCE_LABELS[item.source] || item.source)}</td>
        <td>${escapeHtml(item.title)}</td>
        <td>${escapeHtml(item.message)}</td>
      </tr>`).join("")
    : '<tr><td colspan="4" class="muted">За это окно ошибок не зафиксировано.</td></tr>';
}

$("#reload-monitoring").addEventListener("click", () => loadMonitoring().catch(handleError));
$("#monitoring-hours").addEventListener("change", () => loadMonitoring().catch(handleError));
/*
 * Ручная проверка запускается тем же маршрутом, что и в разделе
 * «Сервисы»: очередь одна, результат один, и второго пути запуска
 * проверки заводить незачем.
 */
$("#monitoring-groups").addEventListener("click", (event) => {
  const button = event.target.closest("[data-check]");
  if (!button) return;
  const kind = button.dataset.targetType === "integration" ? "integrations" : "services";
  request(`/${kind}/${encodeURIComponent(button.dataset.check)}/check`, { method: "POST" })
    .then(() => toast("Проверка поставлена в очередь"))
    .catch(handleError);
});
