/**
 * «Поиск по смыслу» на экране «База знаний»: модель эмбеддингов, индекс в
 * Qdrant и включение — три шага в одном блоке, у каждого одна кнопка.
 *
 * Сервер здесь ничего не решает сам: шаги — те же маршруты, что и раньше
 * (проверка модели, версия, построение, активация, параметры поиска), с
 * теми же серверными проверками. Панель выполняет их по порядку и
 * говорит, какой шаг следующий и почему он пока недоступен. Раньше
 * «Построить индекс» и «Активировать» стояли в самом низу страницы, далеко
 * от сохранения модели: версия оставалась черновиком, и в Qdrant не
 * попадало ничего. Ручные параметры поиска свёрнуты в «Состоянии базы
 * знаний», версии и обслуживание индекса — в блоке «Векторный индекс».
 */
const KNOWLEDGE_RECOMMENDED = {
  "runtime.knowledge_index_enabled": true,
  "runtime.knowledge_search_enabled": true,
  "runtime.knowledge_search_mode": "hybrid",
  "runtime.knowledge_vector_backend": "qdrant",
  "runtime.knowledge_private_enabled": true,
  "runtime.knowledge_global_enabled": true,
};
const KNOWLEDGE_VERSION_STATUS = { draft: "черновик (проверен)", building: "строится", ready: "готов", active: "активен", retired: "выведен, доступен откат", failed: "ошибка" };

/** Отказы построения — словами администратора; прочие коды показываются как есть. */
const KNOWLEDGE_BUILD_ERRORS = {
  knowledge_index_disabled: "индексация была выключена",
  job_publish_failed: "задание не попало в очередь",
  job_deadline_exceeded: "задание не дождалось очереди",
};

function knowledgeVersions() {
  const k = state.knowledge;
  const indexed = new Map((k.index?.versions || []).map((v) => [v.version, v]));
  const versions = k.embeddings?.versions?.length ? k.embeddings.versions : k.index?.versions || [];
  return versions.map((v) => ({ ...v, ...indexed.get(v.version) }));
}

function knowledgeSetting(key) {
  if (state.knowledge.failed?.settings) return undefined;
  return state.knowledge.runtime?.settings?.find((s) => s.key === `runtime.knowledge_${key}`)?.value;
}

function knowledgeQdrantReady() {
  if (state.knowledge.failed?.index || state.knowledge.failed?.embeddings || state.knowledge.failed?.settings) return false;
  const active = knowledgeVersions().find((v) => v.status === "active");
  return !!(active?.built_at && !active.building && !active.error_code
    && typeof active.points === "number" && active.progress === 1
    && state.knowledge.index?.qdrant_status === "ready" && state.knowledge.index?.aliases_match_active === true);
}

/**
 * Поиск по базе вообще идёт: включён, и открыта хотя бы одна база. Без
 * баз сервер отвечает «поиск выключен» при любом режиме и источнике.
 */
function knowledgeSearchEnabled() {
  return knowledgeSetting("search_enabled") === true
    && (knowledgeSetting("private_enabled") === true || knowledgeSetting("global_enabled") === true);
}

/** Ева уже ищет через Qdrant: поиск идёт, режим с векторами, источник — Qdrant. */
function knowledgeSearchOnQdrant() {
  return knowledgeSearchEnabled()
    && ["hybrid", "vector"].includes(knowledgeSetting("search_mode"))
    && knowledgeSetting("vector_backend") === "qdrant";
}

/**
 * Где сейчас настройка. `candidate` — самая новая ещё не включённая
 * версия (черновик, строится, построена или с ошибкой), `active` —
 * включённая. Состояние шага: done, current (ждёт кнопки), busy (идёт на
 * сервере), error, off (индексация выключена), todo (ждёт прошлого шага).
 */
function knowledgeSetup() {
  const k = state.knowledge;
  if (k.failed?.index || k.failed?.embeddings || k.failed?.settings || !k.index) return { blocker: "unknown" };
  if (k.index.qdrant === false) return { blocker: "qdrant" };
  const versions = knowledgeVersions();
  const active = versions.find((v) => v.status === "active") || null;
  const candidate = versions.filter((v) => ["draft", "building", "ready", "failed"].includes(v.status))
    .sort((a, b) => b.version - a.version)[0] || null;
  const built = (v) => v.status === "ready" && !!v.built_at && !v.building && !v.error_code;
  let index = "todo";
  if (candidate) {
    index = candidate.building ? "busy"
      : built(candidate) ? "done"
      : candidate.error_code || candidate.status === "failed" ? "error"
      : "current";
  } else if (active) {
    index = knowledgeSetting("index_enabled") === false ? "off" : "done";
  }
  const live = candidate ? (index === "done" ? "current" : "todo")
    : active ? (knowledgeSearchOnQdrant() ? "done" : "current")
    : "todo";
  return {
    blocker: null,
    active,
    candidate,
    model: candidate || active ? "done" : "current",
    index,
    live,
  };
}

function knowledgeEmbeddingInput() {
  const form = $("#knowledge-embedding-form");
  const value = (name) => form.elements.namedItem(name).value.trim();
  return {
    provider_id: value("provider_id"), model: value("model"),
    dimension: value("dimension") ? Number(value("dimension")) : null,
    request_dimensions: form.elements.request_dimensions.checked,
    distance: value("distance"), hnsw_m: Number(value("hnsw_m")),
    hnsw_ef_construct: Number(value("hnsw_ef_construct")), on_disk: form.elements.on_disk.checked,
    fallback_provider_id: value("fallback_provider_id") || null,
    fallback_model: value("fallback_model") || null,
  };
}

/** Проверка пройдена: модель ответила, а запасной провайдер (если задан) — в том же пространстве. */
function knowledgeProbePassed(probe) {
  return probe?.ok === true && (!probe.compare || probe.compare.ok === true && probe.compare.same_space === true);
}

function renderKnowledgeEmbedding() {
  const k = state.knowledge;
  const versions = knowledgeVersions();
  const active = versions.find((v) => v.status === "active");
  const field = (label, value) => `<div><dt>${label}</dt><dd>${escapeHtml(value ?? "неизвестно")}</dd></div>`;
  const mode = knowledgeSetting("search_mode");
  const backend = knowledgeSetting("vector_backend");
  const source = mode === "lexical" ? "FTS / pg_trgm" : mode === "legacy" ? "pgvector (режим legacy)" : backend;
  const flag = (value) => value === undefined ? "неизвестно" : value ? "включено" : "выключено";
  const qdrant = k.failed?.index ? "состояние недоступно" : { not_configured: "не настроен", ready: "доступен", unavailable: "недоступен — lexical fallback" }[k.index?.qdrant_status] || "неизвестно";
  $("#knowledge-status").innerHTML = `<dl class="knowledge-summary">
    ${field("Поиск по базе", flag(knowledgeSetting("search_enabled")))}
    ${field("Индексация", flag(knowledgeSetting("index_enabled")))}
    ${field("Режим поиска", mode)}${field("Источник векторов", source)}${field("Qdrant", qdrant)}
    ${field("Личная / общая база", `${flag(knowledgeSetting("private_enabled"))} / ${flag(knowledgeSetting("global_enabled"))}`)}
    ${field("Загрузка документов", k.failed?.index || k.index?.uploads_enabled === undefined ? "неизвестно" : k.index.uploads_enabled ? "доступна" : k.index.uploads_worker_enabled === false ? "обработка файлов выключена" : "выключена — включите в блоке «Загрузка»")}
  </dl>${k.index?.aliases_match_active === false ? '<p class="warn-value">Aliases Qdrant расходятся с активной версией PostgreSQL. Повторите активацию текущей версии для восстановления. Поиск обращается к её физическим коллекциям.</p>' : ""}`;
  // Подробности включённой модели; что её нет, уже говорит «Поиск по смыслу».
  $("#knowledge-active-embedding").innerHTML = active ? `<dl class="knowledge-summary">
    ${field("Модель поиска по смыслу", `v${active.version} · ${active.model} · ${active.dimension} · ${active.provider_name || active.provider_id}`)}
    ${field("Состояние модели", `${KNOWLEDGE_VERSION_STATUS[active.status]}${active.building ? " · перестраивается" : ""}`)}
  </dl>` : "";
  const editable = knowledgeEditable();
  $("#knowledge-runtime-editor").hidden = !editable;
  $("#knowledge-manual").hidden = !editable;
  renderKnowledgeSetup();
  if (!editable) {
    $("#knowledge-embedding-editor").hidden = true;
    return;
  }
  renderKnowledgeRuntime();
  renderKnowledgeModelForm();
}

/**
 * Три шага. Кнопка есть только у шага, который можно сделать сейчас;
 * у остальных — что произойдёт и чего он ждёт. Шаги стоят в разметке,
 * здесь меняются их состояние и текст: форма модели внутри первого шага
 * при этом не пересоздаётся и введённое в неё не теряется.
 */
function renderKnowledgeSetup() {
  const k = state.knowledge;
  const status = $("#knowledge-setup-status");
  const steps = $("#knowledge-setup-steps");
  const editable = knowledgeEditable();
  const setup = knowledgeSetup();
  $("#knowledge-setup-busy").textContent = k.setupBusy || "";
  if (setup.blocker) {
    steps.hidden = true;
    status.innerHTML = setup.blocker === "unknown" ? knowledgeUnavailable("Сведения о поиске по смыслу")
      : '<p class="warn-value">Qdrant не подключён к серверу: задайте QDRANT_API_KEY в .env и выполните sudo make update. До этого Ева ищет только по словам.</p>';
    return;
  }
  const { active, candidate } = setup;
  const auto = !!k.setupAuto && candidate?.version === k.setupAuto;
  const button = (id, label) => editable ? `<button class="button primary" type="button" id="${id}" ${k.setupBusy ? "disabled" : ""}>${label}</button>` : "";
  const modelLine = (v) => `${escapeHtml(v.model)} <small>(${escapeHtml(String(v.dimension))}, v${v.version}${v.provider_name ? ` · ${escapeHtml(v.provider_name)}` : ""})</small>`;
  const model = candidate || active;
  const modelBody = model
    ? `<p>✓ ${modelLine(model)}</p>${editable && !k.setupChangeModel ? '<button class="button ghost" type="button" id="knowledge-setup-change">Сменить модель</button>' : ""}`
    : `<p>Нейросеть, которая превращает текст в векторы.${editable ? "" : " Её выбирает администратор."}</p>`;
  let indexBody;
  if (setup.index === "busy") {
    const percent = Math.round((candidate.progress ?? 0) * 100);
    indexBody = `<p>Строится… ${percent}%</p><progress max="100" value="${percent}" aria-label="Построение индекса"></progress>
      <p class="block-caption">${auto ? "Оставьте страницу открытой — поиск по смыслу включится сам. Если закроете, вернитесь позже и нажмите «Включить поиск по смыслу»." : "Построение идёт на сервере — страницу можно закрыть и вернуться позже."}</p>`;
  } else if (setup.index === "done") {
    const v = candidate || active;
    indexBody = `<p>✓ Построен${typeof v.points === "number" ? `: ${v.points} фрагментов в Qdrant` : ""}${active?.building && !candidate ? " · перестраивается" : ""}</p>`;
  } else if (setup.index === "error") {
    const code = candidate.error_code || "build_failed";
    indexBody = `<p class="warn-value">Построение не удалось: ${escapeHtml(KNOWLEDGE_BUILD_ERRORS[code] || code)}.</p>${button("knowledge-setup-build", "Построить заново")}`;
  } else if (setup.index === "current") {
    indexBody = `<p>Векторы всех документов посчитаются и запишутся в Qdrant${knowledgeSetting("index_enabled") === false ? "; индексация включится сама" : ""}.</p>${button("knowledge-setup-build", "Построить индекс")}`;
  } else if (setup.index === "off") {
    indexBody = `<p class="warn-value">Индексация выключена: новые документы не попадают в Qdrant.</p>${button("knowledge-setup-indexing", "Включить индексацию")}`;
  } else {
    indexBody = "<p>Начнётся после подключения модели.</p>";
  }
  let liveBody;
  if (setup.live === "done") {
    liveBody = knowledgeQdrantReady()
      ? "<p>✓ Включено: Ева ищет и по словам, и по смыслу.</p>"
      : '<p class="warn-value">Включено, но Qdrant сейчас недоступен или индекс расходится с базой — Ева ищет только по словам. Подробности — в блоке «Векторный индекс».</p>';
  } else if (setup.live === "current") {
    const label = candidate && active ? "Переключить на новую модель" : "Включить поиск по смыслу";
    liveBody = `<p>${candidate && active ? "Новая модель построена. Прежняя работает, пока вы не переключите." : "Индекс готов. Включите — и Ева начнёт искать и по смыслу."}</p>${button("knowledge-use-qdrant", label)}`;
  } else {
    liveBody = `<p>${auto ? "Включится само, когда индекс построится." : "Станет доступно, когда индекс построится."}</p>`;
  }
  const working = !!active && knowledgeSearchOnQdrant() && knowledgeQdrantReady();
  const meanwhile = knowledgeSearchEnabled() ? "Пока Ева ищет только по словам." : "Поиск по базе знаний выключен — Ева не ищет в документах.";
  status.innerHTML = working
    ? `<span class="status-pill state-green">работает</span> Ева ищет по словам и по смыслу.${setup.index === "off" ? " Новые документы в Qdrant не попадают — включите индексацию." : candidate ? " Новая модель готовится рядом." : ""}`
    : active && knowledgeSearchOnQdrant() ? '<span class="status-pill state-red">не работает</span> Qdrant недоступен или индекс расходится с базой — Ева ищет только по словам.'
    : setup.index === "busy" ? `<span class="status-pill state-yellow">строится индекс</span> ${meanwhile}`
    : `<span class="status-pill state-yellow">не настроен</span> ${meanwhile}`;
  const states = { 1: [setup.model, modelBody], 2: [setup.index, indexBody], 3: [setup.live, liveBody] };
  for (const [n, [mode, body]] of Object.entries(states)) {
    const step = steps.querySelector(`[data-setup-step="${n}"]`);
    step.dataset.state = mode;
    step.querySelector(".knowledge-step-mark").textContent = mode === "done" ? "✓" : n;
    step.querySelector("[data-step-body]").innerHTML = body;
  }
  steps.hidden = false;
  // Первая настройка доводится до конца сама: после «Подключить модель» и
  // построения больше нечего решать. Смену модели включает человек.
  if (auto && setup.index === "done" && !active && !k.setupBusy) {
    queueMicrotask(() => knowledgeGoLive({ auto: true }));
  } else if (auto && setup.index === "error") {
    k.setupAuto = null;
  }
}

/**
 * Форма модели в первом шаге: при первой настройке открыта, потом — по
 * «Сменить модель». Без реестра провайдеров шаги скрыты вместе с ней.
 */
function renderKnowledgeModelForm() {
  const k = state.knowledge;
  const editor = $("#knowledge-embedding-editor");
  const setup = knowledgeSetup();
  const open = !setup.blocker && (setup.model === "current" || k.setupChangeModel);
  editor.hidden = !open;
  if (!open) {
    editor.innerHTML = "";
    return;
  }
  const providers = k.embeddings?.providers || [];
  if (!k.embeddingDraft) {
    const base = setup.candidate || setup.active;
    k.embeddingDraft = base ? { ...base } : { provider_id: providers[0]?.id || "", model: "", dimension: null };
  }
  const draft = k.embeddingDraft;
  const options = (selected, fallback = false) => `${fallback ? '<option value="">Не использовать</option>' : '<option value="">Выберите провайдера</option>'}${providers.map((p) =>
    `<option value="${escapeHtml(p.id)}" ${p.id === selected ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}${selected && !providers.some((p) => p.id === selected) ? `<option value="${escapeHtml(selected)}" selected disabled>Недоступный провайдер</option>` : ""}`;
  const input = (name, value, extra = "") => `<input name="${name}" value="${escapeHtml(value ?? "")}" ${extra}>`;
  editor.innerHTML = `
    <form id="knowledge-embedding-form">
      <div class="knowledge-fields">
        <label>Провайдер <select name="provider_id" required>${options(draft.provider_id)}</select></label>
        <label>Модель эмбеддингов ${input("model", draft.model, 'required maxlength="200" placeholder="например, openai/text-embedding-3-small"')}</label>
        <label>Размерность (необязательно) ${input("dimension", draft.dimension, 'type="number" min="8" max="8192" placeholder="Узнается при проверке"')}</label>
      </div>
      <details class="knowledge-advanced"><summary>Дополнительно</summary><div class="knowledge-fields">
        <label><input type="checkbox" name="request_dimensions" ${draft.request_dimensions ? "checked" : ""}> Передавать dimensions провайдеру</label>
        <label>Мера близости <select name="distance">${["Cosine", "Dot", "Euclid"].map((v) => `<option ${v === (draft.distance || "Cosine") ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label>HNSW m ${input("hnsw_m", draft.hnsw_m ?? 16, 'type="number" min="4" max="128" required')}</label>
        <label>HNSW ef_construct ${input("hnsw_ef_construct", draft.hnsw_ef_construct ?? 100, 'type="number" min="16" max="1024" required')}</label>
        <label><input type="checkbox" name="on_disk" ${draft.on_disk ? "checked" : ""}> Векторы и HNSW на диске</label>
        <label>Запасной провайдер <select name="fallback_provider_id">${options(draft.fallback_provider_id, true)}</select></label>
        <label>Запасная embedding-модель ${input("fallback_model", draft.fallback_model, 'maxlength="200"')}</label>
      </div><p class="block-caption">Запасной провайдер принимается только с совместимым векторным пространством. Ключи настраиваются в реестре провайдеров и здесь не передаются.</p></details>
      <div class="knowledge-actions">
        <button class="button primary" id="knowledge-embedding-connect" type="submit" ${!providers.length || k.embeddingBusy ? "disabled" : ""}>Подключить модель</button>
        <button class="button ghost" id="knowledge-embedding-probe" type="button" ${!providers.length || k.embeddingBusy ? "disabled" : ""}>Только проверить</button>
        ${k.setupChangeModel ? '<button class="button ghost" id="knowledge-setup-cancel" type="button">Отмена</button>' : ""}
      </div>
      <p id="knowledge-embedding-probe-result" aria-live="polite"></p>
      <p class="block-caption">${setup.active ? "Новая модель строит свой индекс рядом; Ева ищет по прежней, пока вы не переключите." : "«Подключить модель» проверит её на тестовой фразе, сохранит и сразу начнёт строить индекс."}</p>
      ${!providers.length ? '<p class="warn-value">В реестре Router нет включённых OpenAI-совместимых провайдеров. Добавьте провайдера в разделе «Искусственный интеллект».</p>' : ""}
    </form>`;
  renderKnowledgeProbe();
}

function renderKnowledgeProbe() {
  const k = state.knowledge;
  const probe = k.embeddingProbe;
  const box = $("#knowledge-embedding-probe-result");
  if (!box) return;
  const providers = !!k.embeddings?.providers?.length;
  $("#knowledge-embedding-probe").disabled = !!k.embeddingBusy || !providers;
  $("#knowledge-embedding-connect").disabled = !!k.embeddingBusy || !providers;
  box.className = probe && !knowledgeProbePassed(probe) ? "warn-value" : "block-caption";
  box.textContent = k.embeddingBusy ? k.embeddingBusy : !probe ? "" : probe.ok
    ? `Модель доступна. Фактическая размерность: ${probe.dimension}; latency: ${probe.latency_ms} мс.${probe.compare ? probe.compare.ok && probe.compare.same_space ? " Запасной провайдер совместим." : " Запасной провайдер несовместим: подключить нельзя." : ""}`
    : `Модель недоступна: ${probe.message || "проверьте модель и настройки провайдера"}`;
}

function renderKnowledgeRuntime() {
  const k = state.knowledge;
  const settings = (k.runtime?.settings || []).filter((s) => Object.hasOwn(KNOWLEDGE_RECOMMENDED, s.key));
  $("#knowledge-runtime-editor").innerHTML = settings.length === 6 && !k.failed?.settings ? `<form id="knowledge-runtime-form">
    <div class="knowledge-fields">${settings.map((s) => `<label>${escapeHtml(s.title)} <select data-knowledge-setting="${escapeHtml(s.key)}">${(s.presets || [{ value: true, title: "Включено" }, { value: false, title: "Выключено" }]).map((p) => `<option value="${escapeHtml(String(p.value))}" ${s.value === p.value ? "selected" : ""}>${escapeHtml(p.title)}</option>`).join("")}</select></label>`).join("")}</div>
    <div class="knowledge-actions"><button class="button ghost" type="submit" id="knowledge-runtime-save">Сохранить параметры поиска</button></div>
    <p class="block-caption">Обычно трогать не нужно: поиск по смыслу включается в блоке «Поиск по смыслу» вверху. Qdrant как источник векторов можно выбрать только после того, как индекс построен и включён.</p>
  </form>` : knowledgeUnavailable("Настройки поиска");
}

async function saveKnowledgeRuntime(settings, verify = false, { quiet = false } = {}) {
  const k = state.knowledge;
  const previous = Object.fromEntries((k.runtime?.settings || []).map((s) => [s.key, s.value]));
  const usesQdrant = (s) => s["runtime.knowledge_search_enabled"] === true
    && ["hybrid", "vector"].includes(s["runtime.knowledge_search_mode"]) && s["runtime.knowledge_vector_backend"] === "qdrant";
  // Отказ индекса не мешает выключить поиск/индексацию или изменить
  // уже действующие параметры. Проверка нужна при включении Qdrant.
  if (settings["runtime.knowledge_vector_backend"] === "qdrant"
    && (verify || previous["runtime.knowledge_vector_backend"] !== "qdrant" || usesQdrant(settings) && !usesQdrant(previous))) {
    // С кодом: без него общий обработчик принял бы отказ за поломку
    // отрисовки и показал «Раздел не отрисовался» вместо причины.
    if (!knowledgeQdrantReady()) {
      throw Object.assign(new Error("Сначала постройте и включите индекс в блоке «Поиск по смыслу» вверху страницы — тогда Qdrant станет источником векторов."), { code: "knowledge_qdrant_not_ready" });
    }
    // Повторная серверная проверка непосредственно перед включением:
    // готовность не доверяется DOM, счётчику точек или старому overview.
    const active = knowledgeVersions().find((v) => v.status === "active");
    await request(`/knowledge/embeddings/versions/${active.version}/activate`, { method: "POST", body: JSON.stringify({ verify_only: true }) });
  }
  await request("/settings", { method: "PUT", headers: { "If-Match": k.runtime.etag }, body: JSON.stringify({ settings }) });
  if (!quiet) toast("Параметры базы знаний сохранены");
  await loadKnowledge();
}

/** Построить версию; выключенную индексацию включить до этого, иначе построение остановится сразу. */
async function knowledgeStartBuild(version) {
  if (knowledgeSetting("index_enabled") === false) {
    await saveKnowledgeRuntime({ "runtime.knowledge_index_enabled": true }, false, { quiet: true });
  }
  await request(`/knowledge/embeddings/versions/${encodeURIComponent(version)}/build`, { method: "POST", body: JSON.stringify({ full: true }) });
}

/** «Подключить модель»: проверка, версия и построение — одним нажатием. */
async function knowledgeConnectModel() {
  const k = state.knowledge;
  const form = $("#knowledge-embedding-form");
  if (k.embeddingBusy || !form.reportValidity()) return;
  const input = knowledgeEmbeddingInput();
  const fingerprint = JSON.stringify(input);
  k.embeddingDraft = input;
  k.embeddingBusy = "Проверяем модель…";
  renderKnowledgeProbe();
  let probe;
  try {
    probe = (await request("/knowledge/embeddings/probe", { method: "POST", body: fingerprint })).payload;
  } catch (error) {
    k.embeddingBusy = false;
    if (error.status === 401) { handleError(error); return; }
    k.embeddingProbe = { ok: false, message: error.message, fingerprint };
    renderKnowledgeProbe();
    return;
  }
  k.embeddingProbe = { ...probe, fingerprint };
  if (!knowledgeProbePassed(probe)) {
    k.embeddingBusy = false;
    renderKnowledgeProbe();
    return;
  }
  const first = !knowledgeVersions().some((v) => v.status === "active");
  try {
    k.embeddingBusy = "Сохраняем модель…";
    renderKnowledgeProbe();
    const { payload: version } = await request("/knowledge/embeddings/versions", { method: "POST", body: fingerprint });
    k.embeddingBusy = "Запускаем построение индекса…";
    renderKnowledgeProbe();
    await knowledgeStartBuild(version.version);
    if (first) k.setupAuto = version.version;
    k.setupChangeModel = false;
    k.embeddingDraft = null;
    k.embeddingProbe = null;
    toast(first
      ? "Модель подключена, индекс строится. Поиск по смыслу включится сам, когда индекс будет готов."
      : `Модель v${version.version} подключена, индекс строится. Когда он будет готов, нажмите «Переключить на новую модель».`);
  } catch (error) {
    handleError(error);
  } finally {
    k.embeddingBusy = false;
  }
  await loadKnowledge().catch(handleError);
}

/** Шаг 2: построить черновик или повторить неудавшееся построение. */
async function knowledgeBuildCandidate() {
  const k = state.knowledge;
  const { candidate, active } = knowledgeSetup();
  if (!candidate || k.setupBusy) return;
  k.setupBusy = "Запускаем построение индекса…";
  renderKnowledgeSetup();
  try {
    await knowledgeStartBuild(candidate.version);
    if (!active) k.setupAuto = candidate.version;
    toast(active ? "Индекс строится" : "Индекс строится. Поиск по смыслу включится сам, когда он будет готов.");
  } catch (error) {
    handleError(error);
  } finally {
    k.setupBusy = false;
  }
  await loadKnowledge().catch(handleError);
}

/** Шаг 3: включить построенную версию и сделать Qdrant источником поиска. */
async function knowledgeGoLive({ auto = false } = {}) {
  const k = state.knowledge;
  if (k.setupBusy) return;
  const setup = knowledgeSetup();
  if (setup.blocker || setup.live !== "current") return;
  const { candidate, active } = setup;
  const run = async () => {
    k.setupBusy = auto ? "Индекс построен — включаем поиск по смыслу…" : "Включаем поиск по смыслу…";
    renderKnowledgeSetup();
    try {
      if (candidate) {
        await request(`/knowledge/embeddings/versions/${encodeURIComponent(candidate.version)}/activate`, {
          method: "POST", body: JSON.stringify({ expected_active_version: active?.version ?? null }),
        });
        // Готовность к Qdrant проверяется по свежему состоянию: точки,
        // aliases и активная версия — после переключения, а не до.
        await loadKnowledge();
      }
      if (!knowledgeSearchOnQdrant()) await saveKnowledgeRuntime(KNOWLEDGE_RECOMMENDED, true, { quiet: true });
      toast(candidate && active ? `Ева перешла на модель v${candidate.version}` : "Поиск по смыслу включён: Ева ищет и по словам, и по смыслу");
    } catch (error) {
      handleError(error);
    } finally {
      k.setupBusy = false;
      k.setupAuto = null;
    }
    await loadKnowledge().catch(handleError);
  };
  if (candidate && active && !auto) {
    askConfirm({
      eyebrow: "ПОИСК ПО СМЫСЛУ",
      title: `Переключить Еву на модель v${candidate.version}?`,
      description: "Сервер проверит каждый фрагмент по PostgreSQL и переключит индекс атомарно. Прежняя модель останется для отката в блоке «Векторный индекс».",
      action: run,
    });
    return;
  }
  await run();
}

/** Индексация выключена при включённой модели: включить и доиндексировать пропущенное. */
async function knowledgeEnableIndexing() {
  const k = state.knowledge;
  if (k.setupBusy) return;
  k.setupBusy = "Включаем индексацию…";
  renderKnowledgeSetup();
  try {
    await saveKnowledgeRuntime({ "runtime.knowledge_index_enabled": true }, false, { quiet: true });
    await request("/knowledge/index/reconcile", { method: "POST" });
    toast("Индексация включена: недостающие документы попадут в Qdrant в фоне");
  } catch (error) {
    handleError(error);
  } finally {
    k.setupBusy = false;
  }
  await loadKnowledge().catch(handleError);
}

function bindKnowledgeEmbeddings() {
  const page = $("#page-knowledge");
  page.addEventListener("input", (event) => {
    if (!event.target.closest("#knowledge-embedding-form")) return;
    state.knowledge.embeddingDraft = knowledgeEmbeddingInput();
    state.knowledge.embeddingProbe = null;
    renderKnowledgeProbe();
  });
  page.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const k = state.knowledge;
    if (button.id === "knowledge-embedding-probe") {
      const form = $("#knowledge-embedding-form");
      if (!form.reportValidity() || k.embeddingBusy) return;
      const input = knowledgeEmbeddingInput();
      k.embeddingDraft = input;
      const fingerprint = JSON.stringify(input);
      k.embeddingBusy = "Проверяем модель…";
      renderKnowledgeProbe();
      request("/knowledge/embeddings/probe", { method: "POST", body: fingerprint }).then(({ payload }) => {
        if (JSON.stringify(knowledgeEmbeddingInput()) === fingerprint) k.embeddingProbe = { ...payload, fingerprint };
      }).catch((error) => {
        k.embeddingProbe = { ok: false, message: error.message };
        if (error.status === 401) handleError(error);
      }).finally(() => { k.embeddingBusy = false; renderKnowledgeProbe(); });
    } else if (button.id === "knowledge-setup-change") {
      k.setupChangeModel = true;
      k.embeddingDraft = null;
      k.embeddingProbe = null;
      renderKnowledgeEmbedding();
    } else if (button.id === "knowledge-setup-cancel") {
      k.setupChangeModel = false;
      k.embeddingDraft = null;
      k.embeddingProbe = null;
      renderKnowledgeEmbedding();
    } else if (button.id === "knowledge-setup-build") {
      knowledgeBuildCandidate();
    } else if (button.id === "knowledge-setup-indexing") {
      knowledgeEnableIndexing();
    } else if (button.id === "knowledge-use-qdrant") {
      knowledgeGoLive();
    }
  });
  page.addEventListener("submit", (event) => {
    if (event.target.id === "knowledge-embedding-form") {
      event.preventDefault();
      knowledgeConnectModel();
    } else if (event.target.id === "knowledge-runtime-form") {
      event.preventDefault();
      const values = {};
      event.target.querySelectorAll("[data-knowledge-setting]").forEach((input) => {
        const key = input.dataset.knowledgeSetting;
        values[key] = typeof KNOWLEDGE_RECOMMENDED[key] === "boolean" ? input.value === "true" : input.value;
      });
      saveKnowledgeRuntime(values).catch(handleError);
    }
  });
}
