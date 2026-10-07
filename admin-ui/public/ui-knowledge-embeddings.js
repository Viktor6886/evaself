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
 *
 * Здесь — состояние шагов и их отрисовка; действия — в ui-knowledge-setup.js.
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

/** Отказы построения — словами администратора; код остаётся в скобках, прочие коды — как есть. */
const KNOWLEDGE_BUILD_ERRORS = {
  knowledge_index_disabled: "индексация была выключена",
  knowledge_index_failed: "ошибка индексации",
  job_publish_failed: "задание не попало в очередь",
  job_deadline_exceeded: "задание не дождалось очереди",
  embedding_auth: "провайдер эмбеддингов отклонил ключ",
  embedding_not_found: "провайдер не нашёл модель",
  embedding_bad_request: "провайдер отклонил запрос",
  embedding_rate_limited: "провайдер ограничил частоту запросов",
  embedding_timeout: "провайдер не ответил вовремя",
  embedding_unavailable: "провайдер эмбеддингов недоступен",
  embedding_incomplete: "провайдер вернул неполный ответ",
  embedding_dimension_mismatch: "модель вернула векторы другой размерности",
  embedding_provider_missing: "провайдер модели выключен или удалён",
  qdrant_unavailable: "Qdrant недоступен",
  qdrant_timeout: "Qdrant не ответил вовремя",
  qdrant_unauthorized: "Qdrant отклонил ключ",
  qdrant_server_error: "ошибка на стороне Qdrant",
};

function knowledgeBuildError(code) {
  return KNOWLEDGE_BUILD_ERRORS[code] ? `${KNOWLEDGE_BUILD_ERRORS[code]} (${code})` : code;
}

/** Попытка построения не удалась, но версия ещё строится: очередь повторит её сама. */
function knowledgeBuildRetrying(version) {
  return version?.status === "building" && !!version.error_code && version.error_code !== "knowledge_index_disabled";
}

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

function knowledgeActiveVersion() {
  return knowledgeVersions().find((v) => v.status === "active") || null;
}

/**
 * Qdrant обслуживает поиск по включённой версии: она построена и Qdrant
 * доступен. Неполный индекс (новые документы ещё индексируются) поиску не
 * мешает — недостающее Ева находит по словам; при расхождении aliases
 * поиск идёт по физическим коллекциям версии из PostgreSQL.
 */
function knowledgeQdrantServing() {
  const k = state.knowledge;
  if (k.failed?.index || k.failed?.embeddings || k.failed?.settings) return false;
  return !!knowledgeActiveVersion()?.built_at && k.index?.qdrant_status === "ready";
}

/**
 * Почему Qdrant пока нельзя сделать источником поиска; null — можно.
 * Полноту индекса проверяет сервер (`verify_only`) и сам называет, чего не
 * хватает: счётчик точек в обзоре учитывает и документы, которые ещё
 * индексируются, и отказ по нему звучал бы как «индекс не построен».
 */
function knowledgeQdrantBlocker() {
  const k = state.knowledge;
  if (k.failed?.index || k.failed?.embeddings || k.failed?.settings) return "Состояние индекса сейчас недоступно — нажмите «Обновить» и повторите.";
  if (k.index?.qdrant === false) return "Qdrant не подключён к серверу: задайте QDRANT_API_KEY в .env и выполните sudo make update.";
  const active = knowledgeActiveVersion();
  if (!active?.built_at) return "Сначала постройте и включите индекс в блоке «Поиск по смыслу» вверху страницы — тогда Qdrant станет источником векторов.";
  if (active.building) return "Индекс перестраивается — Qdrant можно будет включить, когда построение закончится.";
  if (active.error_code) return `Последнее построение индекса не удалось: ${knowledgeBuildError(active.error_code)}. Перестройте включённую версию в блоке «Векторный индекс».`;
  if (k.index?.qdrant_status !== "ready") return "Qdrant сейчас недоступен — сделать его источником поиска нельзя.";
  if (k.index?.aliases_match_active === false) return "Aliases Qdrant расходятся с включённой версией — нажмите «Восстановить aliases» в блоке «Векторный индекс».";
  if (k.index?.aliases_match_active !== true) return "Qdrant не сообщил, на какую версию указывают aliases, — нажмите «Обновить» и повторите.";
  return null;
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

/** Как Ева ищет, пока поиск по смыслу через Qdrant не включён: прежний режим — это ещё и pgvector. */
function knowledgeMeanwhile() {
  if (!knowledgeSearchEnabled()) return "Поиск по базе знаний выключен — Ева не ищет в документах.";
  return knowledgeSetting("search_mode") === "lexical" ? "Пока Ева ищет только по словам." : "Пока поиск идёт по-старому: по словам и через pgvector.";
}

/** Перерисовать, только если содержимое изменилось: опрос раз в 5 секунд не сбивает фокус и экранного диктора. */
function knowledgeRender(node, html) {
  if (node.renderedHtml === html) return;
  node.innerHTML = html;
  node.renderedHtml = html;
}

/**
 * Где сейчас настройка. `active` — включённая версия, `candidate` — самая
 * новая версия новее всех, что уже включались (включённой и выведенных):
 * черновик, строится, построена или с ошибкой. Черновики и неудачи
 * прошлых попыток, оставшиеся позади, к настройке не относятся — они
 * видны в «Векторном индексе». Состояние шага: done, current (ждёт
 * кнопки), busy (идёт на сервере), error, off (индексация выключена), todo
 * (ждёт прошлого шага или условия); `retrying` — ошибка попытки, которую
 * очередь ещё повторит; `liveReason` — почему включение сейчас невозможно.
 */
function knowledgeSetup() {
  const k = state.knowledge;
  if (k.failed?.index || k.failed?.embeddings || k.failed?.settings || !k.index) return { blocker: "unknown" };
  if (k.index.qdrant === false) return { blocker: "qdrant" };
  const versions = knowledgeVersions();
  const active = versions.find((v) => v.status === "active") || null;
  // После отката включённая версия старше выведенной: всё, что старше
  // выведенной, — тоже прошлое, а не следующий шаг.
  const floor = Math.max(0, ...versions.filter((v) => ["active", "retired"].includes(v.status)).map((v) => v.version));
  const candidate = versions.filter((v) => ["draft", "building", "ready", "failed"].includes(v.status) && v.version > floor)
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
  // Включение, которое сейчас откажет, кнопкой не предлагается: шаг
  // говорит, чего ждёт.
  let live = "todo";
  let liveReason = null;
  if (candidate && index === "done") {
    liveReason = k.index.qdrant_status === "ready" ? null : "Qdrant сейчас недоступен — включить новую модель нельзя. Нажмите «Обновить», когда он вернётся.";
    live = liveReason ? "error" : "current";
  } else if (!candidate && active) {
    liveReason = knowledgeSearchOnQdrant() ? null : knowledgeQdrantBlocker();
    live = knowledgeSearchOnQdrant() ? "done" : !liveReason ? "current" : active.building ? "todo" : "error";
  }
  return {
    blocker: null,
    active,
    candidate,
    model: candidate || active ? "done" : "current",
    index,
    live,
    liveReason,
    retrying: index === "error" && knowledgeBuildRetrying(candidate),
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
  knowledgeRender($("#knowledge-status"), `<dl class="knowledge-summary">
    ${field("Поиск по базе", flag(knowledgeSetting("search_enabled")))}
    ${field("Индексация", flag(knowledgeSetting("index_enabled")))}
    ${field("Режим поиска", mode)}${field("Источник векторов", source)}${field("Qdrant", qdrant)}
    ${field("Личная / общая база", `${flag(knowledgeSetting("private_enabled"))} / ${flag(knowledgeSetting("global_enabled"))}`)}
    ${field("Загрузка документов", k.failed?.index || k.index?.uploads_enabled === undefined ? "неизвестно" : k.index.uploads_enabled ? "доступна" : k.index.uploads_worker_enabled === false ? "обработка файлов выключена" : "выключена — включите в блоке «Загрузка»")}
  </dl>${k.index?.aliases_match_active === false ? '<p class="warn-value">Aliases Qdrant расходятся с активной версией PostgreSQL. Повторите активацию текущей версии для восстановления. Поиск обращается к её физическим коллекциям.</p>' : ""}`);
  // Подробности включённой модели; что её нет, уже говорит «Поиск по смыслу».
  knowledgeRender($("#knowledge-active-embedding"), active ? `<dl class="knowledge-summary">
    ${field("Модель поиска по смыслу", `v${active.version} · ${active.model} · ${active.dimension} · ${active.provider_name || active.provider_id}`)}
    ${field("Состояние модели", `${KNOWLEDGE_VERSION_STATUS[active.status]}${active.building ? " · перестраивается" : ""}`)}
  </dl>` : "");
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
  knowledgeRender($("#knowledge-setup-busy"), escapeHtml(k.setupBusy || ""));
  if (setup.blocker) {
    steps.hidden = true;
    knowledgeRender(status, setup.blocker === "unknown" ? knowledgeUnavailable("Сведения о поиске по смыслу")
      : `<p class="warn-value">Qdrant не подключён к серверу: задайте QDRANT_API_KEY в .env и выполните sudo make update. ${escapeHtml(knowledgeMeanwhile())}</p>`);
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
    indexBody = `<p>✓ Построен${typeof v.points === "number" ? ` — фрагментов в Qdrant: ${v.points}` : ""}${active?.building && !candidate ? " · перестраивается" : ""}</p>`;
  } else if (setup.index === "error") {
    const reason = escapeHtml(knowledgeBuildError(candidate.error_code || "build_failed"));
    indexBody = setup.retrying
      ? `<p class="warn-value">Попытка построения не удалась: ${reason}. Сервер повторит её сам — можно подождать или начать заново.</p>${button("knowledge-setup-build", "Построить заново")}`
      : `<p class="warn-value">Построение не удалось: ${reason}.</p>${button("knowledge-setup-build", "Построить заново")}`;
  } else if (setup.index === "current") {
    indexBody = `<p>Векторы всех документов посчитаются и запишутся в Qdrant${knowledgeSetting("index_enabled") === false ? "; индексация включится сама" : ""}.</p>${button("knowledge-setup-build", "Построить индекс")}`;
  } else if (setup.index === "off") {
    indexBody = `<p class="warn-value">Индексация выключена: новые документы не попадают в Qdrant.</p>${button("knowledge-setup-indexing", "Включить индексацию")}`;
  } else {
    indexBody = "<p>Начнётся после подключения модели.</p>";
  }
  let liveBody;
  if (setup.live === "done") {
    liveBody = knowledgeQdrantServing()
      ? "<p>✓ Включено: Ева ищет и по словам, и по смыслу.</p>"
      : '<p class="warn-value">Включено, но Qdrant сейчас недоступен — Ева ищет только по словам. Подробности — в блоке «Векторный индекс».</p>';
  } else if (setup.live === "current") {
    const label = candidate && active ? "Переключить на новую модель" : "Включить поиск по смыслу";
    liveBody = `<p>${candidate && active ? "Новая модель построена. Прежняя работает, пока вы не переключите." : "Индекс готов. Включите — и Ева начнёт искать и по смыслу."}</p>${button("knowledge-use-qdrant", label)}`;
  } else if (setup.liveReason) {
    liveBody = `<p${setup.live === "error" ? ' class="warn-value"' : ""}>${escapeHtml(setup.liveReason)}</p>`;
  } else {
    liveBody = `<p>${auto ? "Включится само, когда индекс построится." : "Станет доступно, когда индекс построится."}</p>`;
  }
  const working = !!active && knowledgeSearchOnQdrant() && knowledgeQdrantServing();
  const meanwhile = escapeHtml(knowledgeMeanwhile());
  const next = !candidate ? ""
    : setup.index === "busy" ? "Новая модель строится рядом."
    : setup.index === "error" ? "Построение новой модели не удалось — см. шаг «Индекс в Qdrant»."
    : setup.index === "done" ? "Новая модель построена — переключите её в шаге «Включение»."
    : "Новая модель ждёт построения.";
  // Неполный индекс и расхождение aliases поиск не останавливают, но о
  // них нужно знать: первое проходит само, второе чинит одна кнопка.
  const notes = working ? [
    typeof active.progress === "number" && active.progress < 1 ? "Часть документов ещё не в Qdrant — их Ева пока находит по словам." : "",
    state.knowledge.index?.aliases_match_active === false ? "Aliases Qdrant расходятся с включённой версией — «Восстановить aliases» в блоке «Векторный индекс»." : "",
    setup.index === "off" ? "Новые документы в Qdrant не попадают — включите индексацию." : next,
  ].filter(Boolean).map((note) => ` ${note}`).join("") : "";
  knowledgeRender(status, working
    ? `<span class="status-pill state-green">работает</span> Ева ищет по словам и по смыслу.${notes}`
    : active && knowledgeSearchOnQdrant() ? '<span class="status-pill state-red">не работает</span> Qdrant сейчас недоступен — Ева ищет только по словам.'
    : setup.index === "busy" ? `<span class="status-pill state-yellow">строится индекс</span> ${meanwhile}`
    : `<span class="status-pill state-yellow">не настроен</span> ${meanwhile}`);
  const states = { 1: [setup.model, modelBody], 2: [setup.index, indexBody], 3: [setup.live, liveBody] };
  // Текущий шаг — первый не выполненный: для экранного диктора, который не видит цвета.
  const current = Object.keys(states).find((n) => states[n][0] !== "done");
  for (const [n, [mode, body]] of Object.entries(states)) {
    const step = steps.querySelector(`[data-setup-step="${n}"]`);
    step.dataset.state = mode;
    if (n === current) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
    step.querySelector(".knowledge-step-mark").textContent = mode === "done" ? "✓" : n;
    knowledgeRender(step.querySelector("[data-step-body]"), body);
  }
  steps.hidden = false;
  // Первая настройка доводится до конца сама: после «Подключить модель» и
  // построения больше нечего решать. Смену модели включает человек. Пока
  // очередь повторяет неудавшуюся попытку, ожидание не снимается.
  if (auto && editable && setup.index === "done" && !active && !k.setupBusy) {
    queueMicrotask(() => knowledgeGoLive({ auto: true }));
  } else if (auto && setup.index === "error" && !setup.retrying) {
    k.setupAuto = null;
  }
}

/**
 * Форма модели в первом шаге: при первой настройке открыта, потом — по
 * «Сменить модель». Без реестра провайдеров шаги скрыты вместе с ней.
 * Опрос раз в 5 секунд форму не пересоздаёт: иначе поле теряло бы фокус
 * посреди ввода, а «Дополнительно» сворачивалось.
 */
function renderKnowledgeModelForm() {
  const k = state.knowledge;
  const editor = $("#knowledge-embedding-editor");
  const setup = knowledgeSetup();
  const open = !setup.blocker && (setup.model === "current" || k.setupChangeModel);
  editor.hidden = !open;
  if (!open) {
    editor.innerHTML = "";
    editor.dataset.form = "";
    return;
  }
  const providers = k.embeddings?.providers || [];
  const key = JSON.stringify([!!setup.active, !!k.setupChangeModel, providers.map((p) => [p.id, p.name])]);
  if (editor.dataset.form === key && $("#knowledge-embedding-form")) {
    renderKnowledgeProbe();
    return;
  }
  editor.dataset.form = key;
  if (!k.embeddingDraft) {
    // Размерность прежней модели переносится, только если её задавали
    // явно (dimensions провайдеру): другая модель узнаёт свою при проверке.
    const base = setup.candidate || setup.active;
    k.embeddingDraft = base ? { ...base, dimension: base.request_dimensions ? base.dimension : null } : { provider_id: providers[0]?.id || "", model: "", dimension: null };
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
      <p class="block-caption">${setup.active ? "Новая модель строит свой индекс рядом; Ева ищет по прежней, пока вы не переключите." : "«Подключить модель» проверит её на тестовой фразе, сохранит и сразу начнёт строить индекс. Когда он будет готов, поиск по смыслу включится сам — с рекомендуемыми параметрами поиска."}</p>
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
