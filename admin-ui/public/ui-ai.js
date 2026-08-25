/**
 * Раздел «Искусственный интеллект»: режим маршрутизации, цепочки
 * маршрутов, здоровье провайдеров и последние отказы.
 */
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
  renderRoutingSettings();
  renderRouterHealth();
  renderRouterFailures();

  $("#providers-list").innerHTML = state.providers.length
    ? state.providers.map(providerCard).join("")
    : '<article class="empty-card"><h3>LLM-провайдер ещё не добавлен</h3><p>Добавьте первую конфигурацию — до тех пор Ева не сможет ответить.</p></article>';
}

const ROUTE_TITLES = {
  chat: "Основная модель", deep: "Мощная модель",
  tools: "Инструменты", json: "Структурированные данные",
  fast: "Экономичная модель",
  research: "Исследования",
  vision: "Изображения", single: "Одна модель",
};

function renderRoutingSettings() {
  const node = $("#routing-settings");
  if (!node) return;
  const settings = state.router?.routing_settings || { mode: "adaptive" };
  const editable = ["owner", "admin"].includes(state.me.role);
  const providers = (state.router?.providers || []).filter((item) => item.enabled);
  node.innerHTML = `
    <div class="routing-mode-picker" role="group" aria-label="Режим моделей">
      <button class="button ${settings.mode !== "single" ? "primary" : "ghost"}" data-routing-mode="adaptive"${editable ? "" : " disabled"}>Адаптивный</button>
      <button class="button ${settings.mode === "single" ? "primary" : "ghost"}" data-routing-mode="single"${editable ? "" : " disabled"}>Одна модель</button>
    </div>
    ${settings.mode === "single" ? `
      <div class="routing-single-editor">
        <p class="muted">Автоматическая маршрутизация отключена. Цепочки сохранены, но сейчас не используются.</p>
        <label>Модель для всех запросов<select id="single-provider"${editable ? "" : " disabled"}>
          <option value="">Выберите модель</option>
          ${providers.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === settings.single_provider_id ? " selected" : ""}>${escapeHtml(item.name)} — ${escapeHtml(item.model)}</option>`).join("")}
        </select></label>
        <label class="switch"><input id="single-failover" type="checkbox" ${settings.single_failover_enabled ? "checked" : ""}${editable ? "" : " disabled"}><span>Аварийный резерв через цепочку разговора</span></label>
        ${singleProviderWarnings(providers.find((item) => item.id === settings.single_provider_id))}
        ${editable ? '<button class="button primary" data-save-routing>Сохранить</button>' : ""}
      </div>` : `
      <div class="routing-role-grid">${["chat", "deep", "fast", "json"].map((code) => {
        const route = (state.router?.routes || []).find((item) => item.code === code);
        const head = route?.chain?.[0];
        return `<article><span>${escapeHtml(ROUTE_TITLES[code])}</span><strong>${escapeHtml(head?.name || "не настроена")}</strong><small>${escapeHtml(head?.model || "Выберите основную модель в цепочке ниже")}</small></article>`;
      }).join("")}</div>
      <details class="routing-advanced"><summary>Резервная модель</summary>
        <div class="router-grid">
          <p class="muted">Маршрут выбирается технически: режим одной модели, явно запрошенная операция, изображение, строгий JSON, назначение диалога и выбранный человеком баланс качества. Содержание сообщения не разбирается — глубину анализа решает Letta.</p>
          <label>Модель для будущего single<select id="single-provider"${editable ? "" : " disabled"}>
            <option value="">Выберите модель</option>
            ${providers.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === settings.single_provider_id ? " selected" : ""}>${escapeHtml(item.name)} — ${escapeHtml(item.model)}</option>`).join("")}
          </select></label>
        </div>
        ${editable ? '<button class="button primary" data-save-routing>Сохранить</button>' : ""}
      </details>`}
    <small class="muted">Изменено: ${escapeHtml(localDate(settings.updated_at))}${settings.updated_by ? ` · ${escapeHtml(String(settings.updated_by))}` : ""}. Личный выбор economy/auto/quality учитывается только в adaptive.</small>
  `;
}

function singleProviderWarnings(provider) {
  if (!provider) return '<p class="form-error">Единая модель не выбрана.</p>';
  const warnings = [];
  if (!provider.supports_vision) warnings.push("изображения недоступны");
  if (!provider.supports_streaming) warnings.push("нет streaming");
  if (Number(provider.context_window) < 8192) warnings.push("контекст меньше 8192 токенов");
  return warnings.length ? `<p class="form-error">Предупреждение: ${escapeHtml(warnings.join("; "))}.</p>` : "";
}

async function saveRoutingSettings(body) {
  const { payload } = await request("/llm/routing-settings", {
    method: "PUT", body: JSON.stringify(body),
  });
  const warnings = payload.warnings || [];
  toast(warnings.length ? `Настройки сохранены. ${warnings.join(". ")}` : "Настройки маршрутизации сохранены");
  await refreshRoutingPage();
}

async function changeRoutingMode(mode) {
  const current = state.router?.routing_settings || {};
  if (mode === current.mode) return;
  const providerId = current.single_provider_id || $("#single-provider")?.value || null;
  if (mode === "single" && !providerId) {
    toast("Сначала выберите модель для режима одной модели", true);
    if (state.page !== "ai") openPage("ai");
    return;
  }
  const selected = (state.router?.providers || []).find((item) => item.id === providerId);
  const message = mode === "single"
    ? `Автоматический выбор будет отключён. Все сообщения, напоминания, инструменты и анализ пойдут через ${selected?.name || "выбранную модель"} / ${selected?.model || "provider"}. Настроенные цепочки сохранятся.`
    : "Снова будут использованы сохранённые цепочки основной, мощной, экономичной и классифицирующей моделей.";
  askConfirm({
    title: mode === "single" ? "Перевести всё на одну модель?" : "Вернуть автоматический выбор?",
    description: message,
    action: async () => await saveRoutingSettings({
      mode,
      ...(mode === "single" ? { single_provider_id: providerId } : {}),
    }),
  });
}

/**
 * Цепочка маршрута. Позиция 0 — основной, дальше резервы. Порядок
 * меняется стрелками и уходит одним PUT: сервер принимает список
 * целиком, поэтому перестановка не может оставить дыру в нумерации.
 */
function renderRouterRoutes() {
  renderRouteChains($("#router-routes"));
}

/**
 * Маршруты.
 *
 * Раньше каждый из восьми маршрутов разворачивался в полный редактор:
 * список цепочки, кнопки перестановки, добавление и переключатель ротации.
 * Провайдеров при этом три, и страница показывала одни и те же три имени
 * восемь раз подряд — на телефоне это несколько экранов прокрутки, в
 * которых ничего не найти.
 *
 * Теперь по умолчанию видно одно: какая модель обслуживает каждый маршрут.
 * Полный редактор цепочки открывается для того маршрута, который правят, —
 * и только он.
 */
function renderRouteChains(target, routeCodes = null, compact = false) {
  if (!target) return;
  const allowed = routeCodes ? new Set(routeCodes) : null;
  const routes = (state.router?.routes || [])
    .filter((route) => !allowed || allowed.has(route.code))
    .sort((left, right) => routeCodes
      ? routeCodes.indexOf(left.code) - routeCodes.indexOf(right.code)
      : 0);
  if (!routes.length) {
    target.innerHTML = '<p class="muted">Маршруты появятся после применения миграций роутера.</p>';
    return;
  }
  const editable = ["owner", "admin"].includes(state.me.role);
  // Маршруты, запрошенные явно (страница медиа просит один), показываются
  // раскрытыми: свёрнутая строка там прячет ровно то, ради чего раздел и
  // открыли. Общий список остаётся свёрнутым.
  const focused = Boolean(routeCodes) && routes.length <= 2;
  target.innerHTML = `<div class="route-summary">${routes.map((route) => {
    const chain = route.chain || [];
    const head = chain[0];
    const backups = Math.max(0, chain.length - 1);
    return `
      <details class="route-item route-block${compact ? " compact" : ""}"
               data-route="${escapeHtml(route.code)}"${focused ? " open" : ""}>
        <summary>
          <span class="route-name">${escapeHtml(ROUTE_TITLES[route.code] || route.title || route.code)}</span>
          <span class="route-head-model">${head ? escapeHtml(head.name) : "не настроен"}</span>
          <span class="route-backups">${backups ? `+${backups}` : ""}</span>
        </summary>
        <div class="route-body">
          ${routeRequirements(route)}
          ${chain.length ? `<ol class="chain${route.rotation_enabled === false ? " is-pinned" : ""}">${chain.map((link, index) => `
            <li class="chain-link${link.enabled && (route.rotation_enabled !== false || index === 0) ? "" : " is-off"}">
              <span class="chain-rank">${index === 0 ? "основной"
                : route.rotation_enabled === false ? "не используется" : `резерв ${index}`}</span>
              <span class="chain-name"><strong>${escapeHtml(link.name)}</strong><small>${escapeHtml(link.model)}</small></span>
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
        </div>
      </details>`;
  }).join("")}</div>`;
}

/** Требования маршрута — то, по чему роутер отбирает провайдеров. */
function routeRequirements(route) {
  const requires = [
    route.requires_tools ? "инструменты" : "",
    route.requires_json ? "строгий JSON" : "",
    route.requires_streaming ? "поток" : "",
    `контекст от ${Number(route.min_context_window).toLocaleString("ru-RU")}`,
  ].filter(Boolean).join(" · ");
  return `<p class="route-requires">Требует: ${escapeHtml(requires)}</p>`;
}

function chainAdder(route, chain) {
  const used = new Set(chain.map((link) => link.provider_id));
  const candidates = state.page === "overview"
    ? (state.router?.providers || [])
    : (state.providers.length ? state.providers : (state.router?.providers || []));
  const free = candidates.filter((item) => item.enabled !== false && !used.has(item.id));
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

/**
 * Последние отказы, сведённые по провайдеру и причине.
 *
 * Лента показывала каждый отказ отдельной строкой: десять подряд «лимит
 * запросов провайдера» вытесняли всё остальное, а описание ошибки во
 * третьей колонке на телефоне налезало на заголовок. Теперь одинаковые
 * отказы — одна строка со счётчиком и временем последнего, а техническая
 * подробность раскрывается по требованию.
 */
function renderRouterFailures() {
  const rows = state.router?.recent_failures || [];
  if (!rows.length) {
    $("#router-failures").innerHTML = '<p class="muted">Отказов не было.</p>';
    return;
  }
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.provider || ""}|${row.switch_reason || ""}|${row.http_status || ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (String(row.started_at) > String(existing.started_at)) existing.started_at = row.started_at;
      if (row.error_summary && !existing.details.includes(row.error_summary)) {
        existing.details.push(row.error_summary);
      }
      continue;
    }
    groups.set(key, {
      provider: row.provider,
      switch_reason: row.switch_reason,
      http_status: row.http_status,
      started_at: row.started_at,
      count: 1,
      details: row.error_summary ? [row.error_summary] : [],
    });
  }
  const list = [...groups.values()].sort((left, right) =>
    String(right.started_at).localeCompare(String(left.started_at)));

  $("#router-failures").innerHTML = list.map((row) => `
    <article class="failure-row">
      <div class="failure-head">
        <span class="status-dot color-red"></span>
        <div class="failure-title">
          <strong>${escapeHtml(row.provider || "провайдер не выбран")}</strong>
          <small>${escapeHtml(SWITCH_REASONS[row.switch_reason] || row.switch_reason || "ошибка")}${row.http_status ? ` · HTTP ${row.http_status}` : ""}</small>
        </div>
        ${row.count > 1 ? `<span class="failure-count">${row.count}×</span>` : ""}
      </div>
      <small class="muted">Последний: ${escapeHtml(localDate(row.started_at))}</small>
      ${row.details.length ? `<details class="failure-more">
        <summary>Подробности провайдера</summary>
        ${row.details.map((detail) => `<p class="failure-detail">${escapeHtml(detail)}</p>`).join("")}
      </details>` : ""}
    </article>`).join("");
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
  await refreshRoutingPage();
}

async function refreshRoutingPage() {
  if (state.page === "overview") await loadOverview();
  // Цепочку vision правят с двух страниц. Перерисовать нужно ту, на
  // которой стоит человек, иначе кнопка сработала, а список остался
  // прежним, и правку делают второй раз.
  else if (state.page === "media") await loadMedia();
  else await loadProviders();
}

$("#reload-router").addEventListener("click", () => loadProviders().catch(handleError));
$("#overview-models").addEventListener("click", (event) => {
  if (event.target.closest("[data-open-ai-routing]")) return openPage("ai");
  handleRouteChainClick(event);
});
$("#overview-models").addEventListener("change", (event) => {
  const routing = event.target.closest("[data-overview-routing-toggle]");
  if (routing) {
    changeRoutingMode(routing.checked ? "adaptive" : "single").catch(handleError);
    return;
  }
  handleRouteChainChange(event);
});
$("#routing-settings").addEventListener("click", (event) => {
  const mode = event.target.closest("[data-routing-mode]")?.dataset.routingMode;
  if (mode) {
    changeRoutingMode(mode).catch(handleError);
    return;
  }
  if (event.target.closest("[data-save-routing]")) {
    const settings = state.router?.routing_settings || {};
    const body = settings.mode === "single"
      ? {
          mode: "single",
          single_provider_id: $("#single-provider")?.value || null,
          single_failover_enabled: $("#single-failover")?.checked === true,
        }
      : {
          mode: "adaptive",
          single_provider_id: $("#single-provider")?.value || null,
        };
    saveRoutingSettings(body).catch(handleError);
  }
});

// Переключатель — это change, а не click: клавиатурное переключение
// пробелом click не порождает, и настройка осталась бы недоступной.
function handleRouteChainChange(event) {
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
      return refreshRoutingPage();
    })
    .catch(handleError);
}
$("#router-routes").addEventListener("change", handleRouteChainChange);

function handleRouteChainClick(event) {
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
    const select = event.currentTarget.querySelector(`[data-chain-add-select="${CSS.escape(code)}"]`);
    const route = (state.router?.routes || []).find((item) => item.code === code);
    const ids = (route?.chain || []).map((link) => link.provider_id);
    if (select?.value) saveChain(code, [...ids, select.value]).catch(handleError);
  }
}
$("#router-routes").addEventListener("click", handleRouteChainClick);

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
