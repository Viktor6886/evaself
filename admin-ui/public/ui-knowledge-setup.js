/**
 * «Поиск по смыслу»: действия шагов — подключение модели (проверка,
 * версия, построение), построение индекса, включение и параметры поиска.
 * Состояние шагов и их отрисовка — в ui-knowledge-embeddings.js.
 *
 * Каждое действие — прежние маршруты с их серверными проверками: проверка
 * модели перед версией, `verify_only` перед Qdrant, ETag настроек,
 * `expected_active_version` при активации.
 */

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
    const blocker = knowledgeQdrantBlocker();
    if (blocker) throw Object.assign(new Error(blocker), { code: "knowledge_qdrant_not_ready" });
    // Повторная серверная проверка непосредственно перед включением:
    // готовность не доверяется DOM, счётчику точек или старому overview.
    const active = knowledgeActiveVersion();
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
  if (k.embeddingBusy || !knowledgeEditable() || !form.reportValidity()) return;
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
  if (!candidate || k.setupBusy || !knowledgeEditable()) return;
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
  if (k.setupBusy || !knowledgeEditable()) return;
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
      description: `Сервер проверит каждый фрагмент по PostgreSQL и переключит индекс атомарно. Прежняя модель останется для отката в блоке «Векторный индекс».${knowledgeSearchOnQdrant() ? "" : " Поиск по смыслу сейчас выключен — переключение включит и его, с рекомендуемыми параметрами поиска."}`,
      action: run,
    });
    return;
  }
  await run();
}

/** Индексация выключена при включённой модели: включить и доиндексировать пропущенное. */
async function knowledgeEnableIndexing() {
  const k = state.knowledge;
  if (k.setupBusy || !knowledgeEditable()) return;
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
