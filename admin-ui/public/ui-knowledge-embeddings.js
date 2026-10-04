/** Embedding-модель и настройки поиска на том же экране «База знаний». */
const KNOWLEDGE_RECOMMENDED = {
  "runtime.knowledge_index_enabled": true,
  "runtime.knowledge_search_enabled": true,
  "runtime.knowledge_search_mode": "hybrid",
  "runtime.knowledge_vector_backend": "qdrant",
  "runtime.knowledge_private_enabled": true,
  "runtime.knowledge_global_enabled": true,
};
const KNOWLEDGE_VERSION_STATUS = { draft: "черновик (проверен)", building: "строится", ready: "готов", active: "активен", retired: "выведен, доступен откат", failed: "ошибка" };

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
    ${field("Загрузка документов", k.index?.uploads_enabled === undefined ? "неизвестно" : k.index.uploads_enabled ? "доступна" : "выключена (EVA_KNOWLEDGE_UPLOADS)")}
  </dl>${k.index?.aliases_match_active === false ? '<p class="warn-value">Aliases Qdrant расходятся с активной версией PostgreSQL. Повторите активацию текущей версии для восстановления. Поиск обращается к её физическим коллекциям.</p>' : ""}`;
  $("#knowledge-active-embedding").innerHTML = active ? `<dl class="knowledge-summary">
    ${field("Активная версия", `v${active.version}`)}${field("Провайдер", active.provider_name || active.provider_id)}
    ${field("Модель", active.model)}${field("Размерность", active.dimension)}
    ${field("Состояние", `${KNOWLEDGE_VERSION_STATUS[active.status]}${active.building ? " · перестраивается" : ""}`)}
  </dl>` : '<p class="knowledge-empty">Активной embedding-версии пока нет. Выберите модель, проверьте её, сохраните новую версию и постройте индекс.</p>';
  const editable = knowledgeEditable();
  $("#knowledge-embedding-editor").hidden = !editable;
  $("#knowledge-runtime-editor").hidden = !editable;
  if (!editable) return;
  renderKnowledgeRuntime();
  if (k.failed?.embeddings) {
    $("#knowledge-embedding-editor").innerHTML = knowledgeUnavailable("Провайдеры и версии embedding");
    return;
  }
  const providers = k.embeddings?.providers || [];
  if (!k.embeddingDraft) {
    const chosen = versions.find((v) => ["draft", "building", "ready", "failed"].includes(v.status)) || active || versions[0];
    k.embeddingSelection = chosen?.version || "";
    k.embeddingDraft = chosen ? { ...chosen } : { provider_id: providers[0]?.id || "", model: "", dimension: null };
  }
  const draft = k.embeddingDraft;
  const options = (selected, fallback = false) => `${fallback ? '<option value="">Не использовать</option>' : '<option value="">Выберите провайдера</option>'}${providers.map((p) =>
    `<option value="${escapeHtml(p.id)}" ${p.id === selected ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}${selected && !providers.some((p) => p.id === selected) ? `<option value="${escapeHtml(selected)}" selected disabled>Недоступный провайдер</option>` : ""}`;
  const input = (name, value, extra = "") => `<input name="${name}" value="${escapeHtml(value ?? "")}" ${extra}>`;
  // Перерисовка использует незаписанный черновик только пока панель
  // открыта; после reload конфигурация берётся исключительно с сервера.
  $("#knowledge-embedding-editor").innerHTML = `
    <label>Сохранённая конфигурация <select id="knowledge-embedding-configuration">
      <option value="">Новая модель</option>${versions.map((v) => `<option value="${v.version}" ${v.version === k.embeddingSelection ? "selected" : ""}>v${v.version}: ${escapeHtml(v.model)} — ${KNOWLEDGE_VERSION_STATUS[v.status] || escapeHtml(v.status)}</option>`).join("")}
    </select></label>
    <form id="knowledge-embedding-form">
      <div class="knowledge-fields">
        <label>Embedding-провайдер <select name="provider_id" required>${options(draft.provider_id)}</select></label>
        <label>Embedding-модель ${input("model", draft.model, 'required maxlength="200" placeholder="например, baai/bge-m3"')}</label>
        <label>Размерность (необязательно) ${input("dimension", draft.dimension, 'type="number" min="8" max="8192" placeholder="Узнать при проверке"')}</label>
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
        <button class="button ghost" id="knowledge-embedding-probe" type="button" ${!providers.length || k.embeddingBusy ? "disabled" : ""}>Проверить модель</button>
        <button class="button" id="knowledge-embedding-save" type="submit" disabled>Сохранить / Создать версию</button>
      </div>
      <p id="knowledge-embedding-probe-result" aria-live="polite"></p>
      <p class="block-caption">Изменение модели всегда создаёт новую версию. После сохранения: «Построить индекс» → «Активировать» в списке ниже. Активная модель продолжает работать во время построения.</p>
      ${!providers.length ? '<p class="warn-value">В реестре Router нет включённых OpenAI-совместимых провайдеров. Добавьте провайдера в разделе «Искусственный интеллект».</p>' : ""}
    </form>`;
  renderKnowledgeProbe();
}

function renderKnowledgeProbe() {
  const k = state.knowledge;
  const probe = k.embeddingProbe;
  const box = $("#knowledge-embedding-probe-result");
  if (!box) return;
  $("#knowledge-embedding-probe").disabled = !!k.embeddingBusy || !k.embeddings?.providers?.length;
  const valid = probe?.ok === true && probe.fingerprint === JSON.stringify(knowledgeEmbeddingInput())
    && (!probe.compare || probe.compare.ok === true && probe.compare.same_space === true);
  $("#knowledge-embedding-save").disabled = !valid || !!k.embeddingBusy;
  box.className = probe?.ok === false ? "warn-value" : "block-caption";
  box.textContent = k.embeddingBusy ? "Проверяем и сохраняем…" : !probe ? "" : probe.ok
    ? `Модель доступна. Фактическая размерность: ${probe.dimension}; latency: ${probe.latency_ms} мс.${probe.compare ? probe.compare.ok && probe.compare.same_space ? " Запасной провайдер совместим." : " Запасной провайдер несовместим: сохранение запрещено." : ""}`
    : `Модель недоступна: ${probe.message || "проверьте модель и настройки провайдера"}`;
}

function renderKnowledgeRuntime() {
  const k = state.knowledge;
  const settings = (k.runtime?.settings || []).filter((s) => Object.hasOwn(KNOWLEDGE_RECOMMENDED, s.key));
  const ready = settings.length === 6 && knowledgeQdrantReady();
  $("#knowledge-runtime-editor").innerHTML = settings.length === 6 && !k.failed?.settings ? `<form id="knowledge-runtime-form">
    <div class="knowledge-fields">${settings.map((s) => `<label>${escapeHtml(s.title)} <select data-knowledge-setting="${escapeHtml(s.key)}">${(s.presets || [{ value: true, title: "Включено" }, { value: false, title: "Выключено" }]).map((p) => `<option value="${escapeHtml(String(p.value))}" ${s.value === p.value ? "selected" : ""}>${escapeHtml(p.title)}</option>`).join("")}</select></label>`).join("")}</div>
    <div class="knowledge-actions"><button class="button ghost" type="submit" id="knowledge-runtime-save">Сохранить параметры поиска</button>
    <button class="button" type="button" id="knowledge-use-qdrant" ${ready ? "" : "disabled"}>Включить Hybrid + Qdrant</button></div>
    <p class="block-caption">Рекомендуется: индексация и поиск включены, hybrid + qdrant, личная и общая базы включены. Применение отдельно от активации версии, после проверки индекса. При отказе Qdrant остаётся поиск по словам.</p>
  </form>` : knowledgeUnavailable("Настройки поиска");
}

async function saveKnowledgeRuntime(settings, verify = false) {
  const k = state.knowledge;
  const previous = Object.fromEntries((k.runtime?.settings || []).map((s) => [s.key, s.value]));
  const usesQdrant = (s) => s["runtime.knowledge_search_enabled"] === true
    && ["hybrid", "vector"].includes(s["runtime.knowledge_search_mode"]) && s["runtime.knowledge_vector_backend"] === "qdrant";
  // Отказ индекса не мешает выключить поиск/индексацию или изменить
  // уже действующие параметры. Проверка нужна при включении Qdrant.
  if (settings["runtime.knowledge_vector_backend"] === "qdrant"
    && (verify || previous["runtime.knowledge_vector_backend"] !== "qdrant" || usesQdrant(settings) && !usesQdrant(previous))) {
    if (!knowledgeQdrantReady()) throw new Error("Сначала постройте и активируйте исправную версию Qdrant");
    // Повторная серверная проверка непосредственно перед включением:
    // готовность не доверяется DOM, счётчику точек или старому overview.
    const active = knowledgeVersions().find((v) => v.status === "active");
    await request(`/knowledge/embeddings/versions/${active.version}/activate`, { method: "POST", body: JSON.stringify({ verify_only: true }) });
  }
  await request("/settings", { method: "PUT", headers: { "If-Match": k.runtime.etag }, body: JSON.stringify({ settings }) });
  toast("Параметры базы знаний сохранены");
  await loadKnowledge();
}

function bindKnowledgeEmbeddings() {
  const page = $("#page-knowledge");
  page.addEventListener("change", (event) => {
    const k = state.knowledge;
    if (event.target.id === "knowledge-embedding-configuration") {
      const version = Number(event.target.value);
      k.embeddingSelection = version || "";
      k.embeddingDraft = version ? { ...knowledgeVersions().find((v) => v.version === version) }
        : { provider_id: k.embeddings?.providers?.[0]?.id || "", model: "", dimension: null };
      k.embeddingProbe = null;
      renderKnowledgeEmbedding();
    }
  });
  page.addEventListener("input", (event) => {
    if (!event.target.closest("#knowledge-embedding-form")) return;
    state.knowledge.embeddingDraft = knowledgeEmbeddingInput();
    state.knowledge.embeddingProbe = null;
    renderKnowledgeProbe();
  });
  page.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button?.id === "knowledge-embedding-probe") {
      const form = $("#knowledge-embedding-form");
      if (!form.reportValidity()) return;
      const k = state.knowledge;
      if (k.embeddingBusy) return;
      const input = knowledgeEmbeddingInput();
      k.embeddingDraft = input;
      const fingerprint = JSON.stringify(input);
      k.embeddingBusy = true;
      button.disabled = true;
      renderKnowledgeProbe();
      request("/knowledge/embeddings/probe", { method: "POST", body: JSON.stringify(input) }).then(({ payload }) => {
        if (JSON.stringify(knowledgeEmbeddingInput()) === fingerprint) k.embeddingProbe = { ...payload, fingerprint };
      }).catch((error) => {
        k.embeddingProbe = { ok: false, message: error.message };
        if (error.status === 401) handleError(error);
      }).finally(() => { k.embeddingBusy = false; button.disabled = false; renderKnowledgeProbe(); });
    } else if (button?.id === "knowledge-use-qdrant" && !button.disabled) {
      button.disabled = true;
      saveKnowledgeRuntime(KNOWLEDGE_RECOMMENDED, true).catch(handleError).finally(() => { button.disabled = false; });
    }
  });
  page.addEventListener("submit", (event) => {
    if (event.target.id === "knowledge-embedding-form") {
      event.preventDefault();
      const k = state.knowledge;
      const input = knowledgeEmbeddingInput();
      if (k.embeddingBusy || !k.embeddingProbe?.ok || k.embeddingProbe.fingerprint !== JSON.stringify(input)) return;
      k.embeddingBusy = true;
      renderKnowledgeProbe();
      request("/knowledge/embeddings/versions", { method: "POST", body: JSON.stringify(input) }).then(async ({ payload }) => {
        k.embeddingDraft = payload;
        k.embeddingSelection = payload.version;
        k.embeddingProbe = null;
        toast(`Версия v${payload.version} сохранена на сервере. Теперь постройте индекс.`);
        await loadKnowledge();
      }).catch(handleError).finally(() => { k.embeddingBusy = false; renderKnowledgeProbe(); });
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
