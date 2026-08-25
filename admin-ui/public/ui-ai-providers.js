/**
 * Карточка провайдера и её редактор: создание, изменение, проверка,
 * список моделей и поля маршрутизации.
 */
/**
 * Состояние провайдера одним словом.
 *
 * Раньше состояний было два — прошёл проверку или нет, — и лимит запросов
 * выглядел так же, как отклонённый ключ: красная точка и текст про
 * несовместимость модели. Действия оператора при этом разные, поэтому
 * состояний теперь четыре, и у каждого свой цвет и своя подсказка.
 */
const CHECK_STATES = {
  ok: { color: "green", label: "работает" },
  limited: { color: "yellow", label: "работает с ограничениями" },
  unavailable: { color: "yellow", label: "временно недоступен" },
  config_error: { color: "red", label: "ошибка конфигурации" },
};

function checkState(item) {
  const known = CHECK_STATES[item.last_check_status];
  if (known) return known;
  // Провайдер, проверенный прежней версией: статуса нет, остаётся булево.
  if (item.last_check_ok === true) return CHECK_STATES.ok;
  if (item.last_check_ok === false) return CHECK_STATES.config_error;
  return { color: "gray", label: "не проверялся" };
}

/**
 * Что модель умеет — по фактической пробе, а не по галочкам оператора.
 * Показываем только подтверждённое: отсутствие возможности закрывает
 * модели соответствующие маршруты, и это важнее списка галочек.
 */
function capabilityChips(item) {
  const chips = [
    item.supports_tools === false ? null : { on: true, text: "инструменты" },
    { on: item.supports_streaming !== false, text: "поток" },
    { on: item.supports_vision === true, text: "изображения" },
    { on: item.supports_json !== false, text: "строгий JSON" },
  ].filter(Boolean);
  return `<div class="capability-chips">${chips.map((chip) =>
    `<span class="chip${chip.on ? "" : " chip-off"}">${escapeHtml(chip.text)}</span>`).join("")}</div>`;
}

function providerCard(item) {
  // Не `state`: глобальная `state` — состояние страницы, и затенять её
  // внутри карточки нельзя.
  const check = checkState(item);
  const message = item.last_check_message || "";
  const placement = providerRouteLabel(item.id);
  return `
    <article class="provider-card">
      <div class="provider-title">
        <span class="status-dot color-${check.color}"></span>
        <div class="provider-name">
          <h3>${escapeHtml(item.name)}</h3>
          <small>${escapeHtml(item.model)}</small>
        </div>
        <span class="status-pill state-${check.color}">${escapeHtml(check.label)}</span>
      </div>
      ${capabilityChips(item)}
      ${placement === "не назначен"
        ? '<p class="muted small">Не назначен ни одному маршруту.</p>'
        : `<p class="muted small">${escapeHtml(placement)}</p>`}
      ${message ? `<details class="provider-diagnostics">
        <summary>${escapeHtml(shortMessage(message))}</summary>
        <p class="status-message">${escapeHtml(message)}</p>
        <dl class="details-list">
          <div><dt>Протокол</dt><dd>${escapeHtml(item.protocol)}</dd></div>
          <div><dt>Base URL</dt><dd>${escapeHtml(item.base_url)}</dd></div>
          <div><dt>Контекст</dt><dd>${Number(item.context_window).toLocaleString("ru-RU")}</dd></div>
          <div><dt>Последний тест</dt><dd>${escapeHtml(localDate(item.last_checked_at))}</dd></div>
        </dl>
      </details>` : '<p class="muted small">Подключение ещё не проверялось.</p>'}
      <div class="card-actions">
        <button class="button tiny ghost" data-provider-action="check" data-provider-id="${escapeHtml(item.id)}">Проверить</button>
        <button class="button tiny ghost" data-provider-action="edit" data-provider-id="${escapeHtml(item.id)}">Изменить</button>
        <details class="card-more">
          <summary>Ещё</summary>
          <div class="card-more-body">
            <button class="button tiny ghost" data-provider-action="models" data-provider-id="${escapeHtml(item.id)}">Получить модели</button>
            <div class="route-assign">
              <select data-provider-route-select>${assignableRoutes().map((route) => `<option value="${escapeHtml(route.code)}">${escapeHtml(ROUTE_TITLES[route.code] || route.code)}</option>`).join("")}</select>
              <button class="button tiny secondary" data-provider-action="route-primary" data-provider-id="${escapeHtml(item.id)}">Сделать основным</button>
            </div>
            <button class="button tiny danger-outline" data-provider-action="delete" data-provider-id="${escapeHtml(item.id)}">Удалить</button>
          </div>
        </details>
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
  const first = String(message).split(/(?<=[.;])\s/)[0] || String(message);
  return first.length > 110 ? `${first.slice(0, 110)}…` : first;
}

/**
 * Где провайдер стоит в маршрутах.
 *
 * Раньше строка перечисляла маршруты через « · » и на телефоне налезала на
 * соседний текст. Считаем: как основной — назвать маршруты, как резерв —
 * назвать число.
 */
function providerRouteLabel(providerId) {
  const primary = [];
  let backup = 0;
  for (const route of (state.router?.routes || [])) {
    const index = (route.chain || []).findIndex((link) => link.provider_id === providerId);
    if (index < 0) continue;
    if (index === 0) primary.push(ROUTE_TITLES[route.code] || route.code);
    else backup += 1;
  }
  if (primary.length === 0 && backup === 0) return "не назначен";
  const parts = [];
  if (primary.length) {
    parts.push(primary.length > 2
      ? `основной для ${primary.length} маршрутов`
      : `основной: ${primary.join(", ")}`);
  }
  if (backup) parts.push(`резерв в ${backup}`);
  return parts.join(" · ");
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
  const routing = (state.router?.providers || []).find((item) => item.id === provider?.id);
  const full = ROUTER_DEFAULTS;
  const set = (name, value) => { if (form.elements[name]) form.elements[name].value = value; };
  const flag = (name, value) => { if (form.elements[name]) form.elements[name].checked = value; };
  // Скрытое поле переносит значение как текст: `checked` у него нет, и
  // прежнее чтение отправило бы false за каждую возможность.
  const capability = (name, value) => {
    if (form.elements[name]) form.elements[name].value = value === true ? "true" : "false";
  };
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
  if (action === "route-primary") {
    const card = document.querySelector(`[data-provider-id="${CSS.escape(id)}"]`)?.closest(".provider-card");
    const routeCode = card?.querySelector("[data-provider-route-select]")?.value;
    const route = (state.router?.routes || []).find((item) => item.code === routeCode);
    if (!route) return;
    const ids = [id, ...(route.chain || []).map((link) => link.provider_id).filter((providerId) => providerId !== id)].slice(0, 6);
    await saveChain(routeCode, ids);
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
    providerAction(button.dataset.providerAction, button.dataset.providerId).catch(handleError);
  }
});
