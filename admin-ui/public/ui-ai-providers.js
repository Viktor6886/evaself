/**
 * Единая карточка LLM-провайдера: кто это, работает ли, где используется,
 * что с ним происходило — и все действия над ним.
 *
 * Раньше сведения об одном провайдере лежали в трёх местах длинной
 * страницы: карточка показывала итог проверки модели, отдельный список
 * «Состояние провайдеров» ниже — circuit breaker и расход, а место в
 * маршрутах приходилось искать в третьем разделе. Оператор, у которого
 * одна модель ведёт себя странно, собирал её состояние по всей странице —
 * на телефоне это несколько экранов прокрутки в обе стороны.
 *
 * Теперь провайдер встречается ровно один раз. Итоговый статус, маршруты
 * и членство в них считает сервер (`/llm/state`): два места, вычислявшие
 * одно и то же по-своему, — это два места, где они могут разойтись.
 */

/** Микроединицы валюты в доллары. */
function money(micro) {
  const value = Number(micro || 0) / 1_000_000;
  // Ноль показывается нулём: «$0.0000» занимает место значащего числа и
  // читается как результат измерения, хотя измерять было нечего.
  if (value === 0) return "$0";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/**
 * Что модель умеет — по фактической пробе, а не по галочкам оператора.
 * Показываем только подтверждённое: отсутствие возможности закрывает
 * модели соответствующие маршруты, и это важнее списка галочек.
 */
function capabilityChips(item) {
  const chips = [
    { on: item.supports_tools !== false, text: "инструменты" },
    { on: item.supports_streaming !== false, text: "поток" },
    { on: item.supports_vision === true, text: "изображения" },
    { on: item.supports_json !== false, text: "строгий JSON" },
  ];
  return `<div class="capability-chips">${chips.map((chip) =>
    `<span class="chip${chip.on ? "" : " chip-off"}">${escapeHtml(chip.text)}</span>`).join("")}</div>`;
}

/**
 * Место провайдера в маршрутах — прямо в карточке.
 *
 * Позиция приходит с сервера (`position` цепочки, 0 — основной), а не
 * вычисляется пересканированием всех цепочек на каждого провайдера: так
 * это делали две разные функции, и трактовали по-разному.
 *
 * В режиме одной модели сохранённые цепочки показываются как сохранённые,
 * но неработающие. Иначе карточка обещала бы маршрутизацию, которой
 * сейчас нет.
 */
function providerRoutes(item, editable) {
  const single = state.router?.routing_settings?.mode === "single";
  // Маршрут `single` в списке не показывается. В режиме одной модели
  // роутер берёт провайдера из настроек режима, а не из этой цепочки:
  // запись в ней ни на что не влияет, и «Сделать основным» на ней —
  // кнопка, которая ничего не делает. Выбор единой модели живёт в блоке
  // «Режим моделей Евы», и второго места для него быть не должно.
  const memberships = (item.routes || []).filter((route) => route.code !== "single");
  const rank = (position) => position === 0 ? "основной" : `резерв ${position}`;
  const title = (code, fallback) => ROUTE_TITLES[code] || fallback || code;

  const rows = memberships.length
    ? memberships.map((route) => `
        <li class="provider-route">
          <span class="provider-route-name">${escapeHtml(title(route.code, route.title))}</span>
          <span class="provider-route-rank${route.position === 0 ? " is-primary" : ""}">${escapeHtml(rank(route.position))}</span>
          ${editable ? `<span class="provider-route-actions">
            ${route.position === 0 ? "" : `<button class="button tiny ghost" data-provider-action="route-primary" data-provider-id="${escapeHtml(item.id)}" data-route="${escapeHtml(route.code)}">Сделать основным</button>`}
            <button class="button tiny danger-outline" data-provider-action="route-remove" data-provider-id="${escapeHtml(item.id)}" data-route="${escapeHtml(route.code)}">Убрать</button>
          </span>` : ""}
        </li>`).join("")
    : '<li class="provider-route muted">Не назначен ни одному маршруту.</li>';

  const free = assignableRoutes().filter(
    (route) => !memberships.some((member) => member.code === route.code));

  return `
    <div class="provider-routes">
      <div class="provider-block-head">
        <span>Маршруты</span>
        ${single ? '<span class="status-pill state-gray">цепочки сохранены, но не используются</span>' : ""}
      </div>
      <ul class="provider-route-list">${rows}</ul>
      ${editable && free.length ? `<div class="provider-route-add">
        <select data-provider-route-select="${escapeHtml(item.id)}">
          ${free.map((route) => `<option value="${escapeHtml(route.code)}">${escapeHtml(title(route.code, route.title))}</option>`).join("")}
        </select>
        <button class="button tiny secondary" data-provider-action="route-add" data-provider-id="${escapeHtml(item.id)}">Добавить</button>
      </div>` : ""}
    </div>`;
}

/**
 * Эксплуатационные симптомы: то, что видно сразу, и то, что по требованию.
 *
 * Наверху — четыре числа, из-за которых сюда и приходят: сколько работы
 * прошло, сколько сорвалось, как долго и сколько стоило. Остальное —
 * бюджеты, последняя ошибка, срок пробного запроса, адрес и протокол —
 * в `<details>`: на телефоне постоянно раскрытая техническая справка
 * превращает карточку в три экрана, и найти в ней ничего нельзя.
 */
function providerOperations(item) {
  const requests = Number(item.requests_1h || 0);
  const failures = Number(item.failures_1h || 0);
  const facts = [
    ["За час", `${requests}${failures ? ` · ошибок ${failures}` : ""}`],
    ["Задержка p95", item.p95_latency_ms == null ? "нет данных" : `${item.p95_latency_ms} мс`],
    ["Сегодня", money(item.spent_today_micro)],
    ["За месяц", money(item.spent_month_micro)],
  ];
  const details = [
    item.daily_budget_micro ? ["Дневной бюджет", `${money(item.spent_today_micro)} из ${money(item.daily_budget_micro)}`] : null,
    item.monthly_budget_micro ? ["Месячный бюджет", `${money(item.spent_month_micro)} из ${money(item.monthly_budget_micro)}`] : null,
    item.last_error_code ? ["Последняя ошибка", String(item.last_error_code)] : null,
    item.probe_after ? ["Пробный запрос после", localDate(item.probe_after)] : null,
    // Два источника статуса названы отдельно: проверка возможностей
    // спрашивает модель, breaker знает, что было в работе. Смешивать их
    // в одну фразу — значит объяснять отказ не той причиной.
    ["Проверка модели", CHECK_DETAIL[item.status?.detail?.check] || "не проверялась"],
    ["Router", ROUTER_DETAIL[item.status?.detail?.router] || "в работе"],
    ["Последняя проверка", localDate(item.last_checked_at)],
    ["Протокол", String(item.protocol || "—")],
    ["Base URL", String(item.base_url || "—")],
    ["Контекст", Number(item.context_window || 0).toLocaleString("ru-RU")],
    ["Приоритет", String(item.priority ?? "—")],
  ].filter(Boolean);
  const message = item.last_check_message || "";

  return `
    <dl class="provider-facts">${facts.map(([term, value]) =>
      `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
    <details class="provider-diagnostics">
      <summary>${escapeHtml(message ? shortMessage(message) : "Подробнее")}</summary>
      ${message ? `<p class="status-message">${escapeHtml(message)}</p>` : ""}
      <dl class="details-list">${details.map(([term, value]) =>
        `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
    </details>`;
}

const CHECK_DETAIL = {
  ok: "возможности подтверждены",
  limited: "часть возможностей недоступна",
  unavailable: "провайдер не ответил на пробу",
  config_error: "конфигурация отклонена провайдером",
};

const ROUTER_DETAIL = {
  closed: "в работе",
  open: "исключён после ошибок",
  half_open: "ждёт пробного запроса",
  pinned_out: "снят с автовозврата вручную",
};

function providerCard(item) {
  const editable = ["owner", "admin"].includes(state.me.role);
  // Проверка провайдера разрешена и оператору — так же, как на сервере
  // (`providers/:id/check`). Кнопки, которых роль не может выполнить,
  // карточка не рисует: раньше viewer видел «Проверить» и «Изменить» и
  // получал 403 уже после нажатия.
  const canCheck = ["owner", "admin", "operator"].includes(state.me.role);
  // Не `state`: глобальная `state` — состояние страницы, и затенять её
  // внутри карточки нельзя.
  const status = item.status || { code: "unchecked", label: "не проверялся", color: "gray" };
  const breakerOpen = item.status?.detail?.router === "open"
    || item.status?.detail?.router === "half_open";
  return `
    <article class="provider-card" data-provider-card="${escapeHtml(item.id)}">
      <div class="provider-title">
        <span class="status-dot color-${escapeHtml(status.color)}"></span>
        <div class="provider-name">
          <h3>${escapeHtml(item.name)}${item.single_selected ? ' <span class="status-pill state-green">Единая модель</span>' : ""}</h3>
          <small>${escapeHtml(item.model)}</small>
        </div>
        <span class="status-pill state-${escapeHtml(status.color)}">${escapeHtml(status.label)}</span>
      </div>
      ${capabilityChips(item)}
      ${providerRoutes(item, editable)}
      ${providerOperations(item)}
      <div class="card-actions">
        ${canCheck ? `<button class="button tiny ghost" data-provider-action="check" data-provider-id="${escapeHtml(item.id)}">Проверить</button>` : ""}
        ${editable ? `<button class="button tiny ghost" data-provider-action="edit" data-provider-id="${escapeHtml(item.id)}">Изменить</button>` : ""}
        ${editable && breakerOpen ? `<button class="button tiny secondary" data-provider-action="breaker-reset" data-provider-id="${escapeHtml(item.id)}">Вернуть в строй</button>` : ""}
        ${editable ? `<details class="card-more">
          <summary>Ещё</summary>
          <div class="card-more-body">
            <button class="button tiny ghost" data-provider-action="models" data-provider-id="${escapeHtml(item.id)}">Получить модели</button>
            <button class="button tiny ghost" data-provider-action="pin" data-provider-id="${escapeHtml(item.id)}" data-pin="${item.pinned_out ? "off" : "on"}">${item.pinned_out ? "Вернуть автовозврат" : "Снять с автовозврата"}</button>
            <button class="button tiny danger-outline" data-provider-action="delete" data-provider-id="${escapeHtml(item.id)}">Удалить</button>
          </div>
        </details>` : ""}
      </div>
    </article>`;
}

function assignableRoutes() {
  return (state.router?.routes || []).filter((route) => route.code !== "single");
}

/**
 * Первая фраза сообщения — она и объясняет положение дел. Полный текст
 * раскрывается по требованию: раньше он обрезался вёрсткой, и понять, что
 * именно ответил провайдер, было нельзя.
 */
function shortMessage(message) {
  const first = (String(message).split(/(?<=[.;])\s/)[0] || String(message))
    // Точка или точка с запятой на конце — след разреза, а не часть
    // фразы: «Подключение работает;» выглядит как оборванный текст.
    .replace(/[.;,\s]+$/u, "");
  return first.length > 90 ? `${first.slice(0, 90)}…` : first;
}

function openProviderEditor(provider = null) {
  const form = $("#provider-form");
  form.reset();
  form.elements.id.value = provider?.id || "";
  form.elements.name.value = provider?.name || "";
  form.elements.protocol.value = provider?.protocol || "openai-compatible";
  form.elements.base_url.value = provider?.base_url || "";
  form.elements.model.value = provider?.model || "";
  form.elements.context_window.value = provider?.context_window || 131072;
  form.elements.timeout_ms.value =
    provider?.additional_parameters?.request_timeout_ms || 180000;
  form.elements.additional_parameters.value = JSON.stringify(
    provider?.additional_parameters || {},
    null,
    2,
  );

  // Поля маршрутизации живут в таблице роутера, а не в
  // additional_parameters: подставляем их из /llm/state.
  // Приоритет берётся из самой записи: `/llm/state` отдаёт провайдера
  // целиком, и отдельный поиск по состоянию роутера искал бы тот же
  // объект.
  const full = ROUTER_DEFAULTS;
  const set = (name, value) => { if (form.elements[name]) form.elements[name].value = value; };
  const flag = (name, value) => { if (form.elements[name]) form.elements[name].checked = value; };
  // Скрытое поле переносит значение как текст: `checked` у него нет, и
  // прежнее чтение отправило бы false за каждую возможность.
  const capability = (name, value) => {
    if (form.elements[name]) form.elements[name].value = value === true ? "true" : "false";
  };
  set("priority", provider?.priority ?? full.priority);
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
  // Возможности выясняет проба, оператор их больше не проставляет. Поля
  // остались скрытыми и переносят уже выясненное: отправить сюда false
  // означало бы выключить провайдера из маршрутов, которым эта
  // возможность нужна, — и без единого действия человека.
  capability("supports_tools", provider?.supports_tools ?? true);
  capability("supports_json", provider?.supports_json ?? true);
  capability("supports_streaming", provider?.supports_streaming ?? true);
  capability("supports_vision", provider?.supports_vision ?? false);
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
    supports_tools: capabilityValue(form, "supports_tools"),
    supports_json: capabilityValue(form, "supports_json"),
    supports_streaming: capabilityValue(form, "supports_streaming"),
    supports_vision: capabilityValue(form, "supports_vision"),
    sensitive_data_allowed: form.elements.sensitive_data_allowed.checked,
    enabled: form.elements.enabled.checked,
  };
  await request(`/llm/providers/${encodeURIComponent(providerId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function capabilityValue(form, name) {
  const field = form.elements[name];
  if (!field) return undefined;
  // Поле может быть и скрытым (значение текстом), и галочкой — если
  // разметку когда-нибудь вернут обратно.
  return field.type === "checkbox" ? field.checked : field.value === "true";
}

async function providerAction(action, id, routeArg = null, pinArg = null) {
  const provider = (state.providers || []).find((item) => item.id === id);
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
    await refreshRoutingPage();
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
  // Маршруты правятся тем же `saveChain`, что и полная схема: второго
  // механизма маршрутизации не заводится, семантика позиции сохраняется
  // (0 — основной, дальше резервы).
  if (action === "route-primary" || action === "route-remove" || action === "route-add") {
    const routeCode = action === "route-add"
      ? document.querySelector(`[data-provider-route-select="${CSS.escape(id)}"]`)?.value
      : routeArg;
    const route = (state.router?.routes || []).find((item) => item.code === routeCode);
    if (!route) return;
    const current = (route.chain || []).map((link) => link.provider_id);
    if (action === "route-remove") {
      const ids = current.filter((providerId) => providerId !== id);
      if (ids.length === 0) {
        // Сервер и так отклонит пустую цепочку, но сказать причину лучше
        // до запроса, чем показать 400.
        toast("В цепочке должен остаться хотя бы основной провайдер", true);
        return;
      }
      await saveChain(routeCode, ids);
      return;
    }
    const rest = current.filter((providerId) => providerId !== id);
    await saveChain(routeCode, action === "route-primary"
      ? [id, ...rest].slice(0, 6)
      : [...rest, id].slice(0, 6));
    return;
  }
  if (action === "breaker-reset") {
    await request(`/llm/providers/${encodeURIComponent(id)}/breaker/reset`, { method: "POST" });
    toast("Провайдер возвращён в строй");
    await refreshRoutingPage();
    return;
  }
  if (action === "pin") {
    const on = pinArg === "on";
    await request(`/llm/providers/${encodeURIComponent(id)}/pin`, {
      method: "POST",
      body: JSON.stringify({ pinned_out: on }),
    });
    toast(on ? "Провайдер снят с автовозврата" : "Автовозврат включён");
    await refreshRoutingPage();
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
    providerAction(
      button.dataset.providerAction,
      button.dataset.providerId,
      button.dataset.route ?? null,
      button.dataset.pin ?? null,
    ).catch(handleError);
  }
});
