/**
 * Раздел «Инструменты»: реестр, поиск по каталогу, MCP discovery,
 * браузер и субагенты.
 *
 * Всё приходит одним ответом `/panel/tools`, который панель получает у
 * eva-agent-service фиксированным маршрутом. Изменяющее действие здесь
 * одно — опросить MCP-сервер заново; оно трогает только кэш discovery.
 */
const TOOL_SOURCE_TITLES = { product: "продукт", bridge: "мост", mcp: "MCP", browser: "браузер" };
const TOOL_RISK_TITLES = {
  read: "чтение", low_risk_write: "запись", sensitive_write: "чувствительная запись",
  external_side_effect: "внешнее действие", destructive: "удаление",
};

function toolsCell(label, value) {
  return `<div class="host-cell"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function toolsMs(value) {
  return value === null || value === undefined ? "—" : `${Math.round(Number(value))} мс`;
}

async function loadTools() {
  const { payload } = await request("/panel/tools");
  state.tools = payload;
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const direct = tools.filter((tool) => tool.exposure === "direct").length;
  const deferred = tools.length - direct;
  $("#tools-summary").innerHTML = [
    toolsCell("Поиск инструментов", payload.tool_search?.enabled ? "включён" : "выключен"),
    toolsCell("Прямых", String(direct)),
    toolsCell("В каталоге", String(deferred)),
    toolsCell("MCP-серверов", String(payload.mcp?.servers?.length ?? 0)),
    toolsCell("Браузер", payload.browser?.enabled ? (payload.browser?.health ? "работает" : "недоступен") : "выключен"),
    toolsCell("Субагенты", payload.delegation?.enabled ? "включены" : "выключены"),
    toolsCell("Хуки", (payload.hooks || []).join(", ") || "—"),
  ].join("");

  $("#tools-catalog-body").innerHTML = tools.length
    ? tools.map((tool) => `
      <tr>
        <td><strong class="technical">${escapeHtml(tool.name)}</strong><div class="muted">${escapeHtml(tool.description || "")}</div></td>
        <td>${escapeHtml(TOOL_SOURCE_TITLES[tool.source] || tool.source)}<div class="muted technical">${escapeHtml(tool.group)}</div></td>
        <td>${tool.exposure === "deferred" ? '<span class="chip">каталог</span>' : "прямой"}</td>
        <td>${escapeHtml(TOOL_RISK_TITLES[tool.risk] || tool.risk)}</td>
        <td>${tool.approval_required ? "спрашивается" : "нет"}</td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="muted">Реестр пуст.</td></tr>';
  const rejected = Array.isArray(payload.rejected) ? payload.rejected : [];
  $("#tools-rejected").innerHTML = rejected.length
    ? `<p class="block-caption">Отклонены реестром: ${rejected.map((item) => `<span class="pill-blocked">${escapeHtml(item.name)} — ${escapeHtml(item.reason)}</span>`).join(" ")}</p>`
    : "";

  renderToolsMcp(payload.mcp || {});
  renderToolsBrowser(payload.browser || {});
  renderToolsDelegation(payload.delegation || {});

  const latency = Array.isArray(payload.latency) ? payload.latency : [];
  $("#tools-latency-body").innerHTML = latency.length
    ? latency.map((row) => `
      <tr>
        <td class="technical">${escapeHtml(row.name)}</td><td>${escapeHtml(TOOL_SOURCE_TITLES[row.source] || row.source)}</td>
        <td>${escapeHtml(String(row.calls))}</td><td>${escapeHtml(String(row.errors))}</td>
        <td>${toolsMs(row.p50Ms)}</td><td>${toolsMs(row.p95Ms)}</td><td>${toolsMs(row.maxMs)}</td>
      </tr>`).join("")
    : '<tr><td colspan="7" class="muted">Вызовов с запуска сервиса ещё не было.</td></tr>';
}

function renderToolsMcp(mcp) {
  if (!mcp.configured) {
    $("#tools-mcp").innerHTML = '<p class="muted">MCP-серверы недоступны: мастер-ключ секретов не настроен.</p>';
    return;
  }
  const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
  $("#tools-mcp").innerHTML = servers.length
    ? servers.map((server) => {
      const effective = new Set(server.effective || []);
      const discovered = (server.discovered || []).map((tool) => `<span class="${effective.has(tool.name) ? "chip" : "chip chip-off"}" title="${escapeHtml(tool.description || "")}">${escapeHtml(tool.name)}</span>`).join(" ");
      const missing = (server.missing || []).map((name) => `<span class="pill-blocked">${escapeHtml(name)}</span>`).join(" ");
      return `
        <article class="provider-card" data-mcp-server="${escapeHtml(server.server)}">
          <div class="section-heading">
            <div><h4 class="technical">${escapeHtml(server.server)}</h4>
              <p class="block-caption">Состояние: ${escapeHtml(server.state)}${server.error ? ` (${escapeHtml(server.error)})` : ""} · опрошен: ${escapeHtml(server.checked_at || "—")} · ${toolsMs(server.duration_ms)}</p></div>
            <button class="button ghost" data-mcp-discover="${escapeHtml(server.server)}">Опросить заново</button>
          </div>
          <p>Объявлено сервером: ${discovered || '<span class="muted">ничего</span>'}</p>
          <p>Разрешено политикой: <span class="technical">${escapeHtml((server.allowed || []).join(", ") || "—")}</span></p>
          ${missing ? `<p>Разрешено, но сервер не объявил: ${missing}</p>` : ""}
        </article>`;
    }).join("")
    : '<p class="muted">Включённых MCP-серверов нет.</p>';
}

function renderToolsBrowser(browser) {
  if (!browser.enabled) {
    $("#tools-browser").innerHTML = '<p class="muted">Браузер выключен (EVA_BROWSER_ENABLED и профиль compose browser).</p>';
    return;
  }
  const health = browser.health || null;
  const sessions = Array.isArray(browser.sessions) ? browser.sessions : [];
  const limits = health?.limits || {};
  $("#tools-browser").innerHTML = `
    <div class="host-bar">
      ${toolsCell("Сервис", health ? "отвечает" : `недоступен${browser.error ? ` (${browser.error})` : ""}`)}
      ${toolsCell("Chromium", health?.browser || "—")}
      ${toolsCell("Сессий", `${sessions.length} из ${limits.max_sessions ?? "—"}`)}
      ${toolsCell("На владельца", String(limits.max_sessions_per_owner ?? "—"))}
      ${toolsCell("Простой", limits.session_idle_ms ? `${Math.round(limits.session_idle_ms / 60000)} мин` : "—")}
      ${toolsCell("Заблокировано запросов", String(health?.egress?.blocked ?? "—"))}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Сессия</th><th>Владелец</th><th>Возраст</th><th>Простой</th><th>Операций</th><th>Заблокировано</th></tr></thead>
      <tbody>${sessions.length
        ? sessions.map((session) => `
          <tr><td class="technical">${escapeHtml(String(session.id).slice(0, 12))}…</td><td class="technical">${escapeHtml(String(session.owner).slice(0, 12))}…</td>
          <td>${Math.round(Number(session.ageMs) / 1000)} с</td><td>${Math.round(Number(session.idleMs) / 1000)} с</td>
          <td>${escapeHtml(String(session.operations))}</td><td>${escapeHtml(String(session.blockedRequests))}</td></tr>`).join("")
        : '<tr><td colspan="6" class="muted">Активных сессий нет.</td></tr>'}</tbody>
    </table></div>`;
}

function renderToolsDelegation(delegation) {
  const stats = delegation.stats || {};
  const running = Array.isArray(delegation.running) ? delegation.running : [];
  $("#tools-delegation").innerHTML = `
    <div class="host-bar">
      ${toolsCell("Состояние", delegation.enabled ? "включены" : "выключены")}
      ${toolsCell("Параллельно", `${delegation.active ?? 0} из ${delegation.limits?.maxParallel ?? "—"}`)}
      ${toolsCell("В очереди", String(delegation.queued ?? 0))}
      ${toolsCell("Срок задания", delegation.limits?.timeoutMs ? `${Math.round(delegation.limits.timeoutMs / 1000)} с` : "—")}
      ${toolsCell("Завершено", String(stats.completed ?? 0))}
      ${toolsCell("Отказов", String((stats.failed ?? 0) + (stats.timeout ?? 0)))}
      ${toolsCell("Отменено", String(stats.cancelled ?? 0))}
      ${toolsCell("Не удалено", String(stats.cleanupFailed ?? 0))}
    </div>
    ${running.length ? `<p class="block-caption">Сейчас работают: ${running.map((item) => `<span class="chip">${escapeHtml(item.role)} · ${Math.round(Number(item.runningMs) / 1000)} с</span>`).join(" ")}</p>` : ""}`;
}

$("#reload-tools").addEventListener("click", () => loadTools().catch(handleError));
$("#tools-mcp").addEventListener("click", (event) => {
  const button = event.target.closest("[data-mcp-discover]");
  if (!button) return;
  button.disabled = true;
  request(`/panel/tools/mcp/${encodeURIComponent(button.dataset.mcpDiscover)}/discover`, { method: "POST" })
    .then(({ payload }) => {
      toast(payload?.state === "ok" ? `Сервер опрошен: инструментов ${payload.discovered}` : `Опрос не удался: ${payload?.error || "ошибка"}`, payload?.state !== "ok");
      return loadTools();
    })
    .catch(handleError)
    .finally(() => { button.disabled = false; });
});
