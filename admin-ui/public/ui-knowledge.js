/**
 * Раздел «База знаний»: общая база для всех пользователей.
 *
 * Здесь — коллекции общей базы, загрузка документов администратора,
 * статусы разбора и индексации, массовые удаление и переиндексация,
 * состояние векторного индекса. Личные базы людей видны только числами:
 * названий, содержимого и владельцев их документов панель не получает
 * вовсе (docs/knowledge-base.md).
 *
 * Тяжёлой работы в браузере нет: файл уходит на сервер, а разбор,
 * векторы и запись в индекс выполняет агент фоновыми заданиями. Поэтому
 * загрузка отвечает сразу «в очереди», а ход работы виден в списке
 * загрузок, который раздел обновляет, пока в нём есть незавершённое.
 */

const KNOWLEDGE_UPLOAD_LIMIT = 10 * 1024 * 1024;
const KNOWLEDGE_ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.html,.htm,.json";
const KNOWLEDGE_MIME_BY_EXT = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
};

const KNOWLEDGE_INDEX_STATUS = {
  pending: "ждёт индексации",
  indexing: "индексируется",
  ready: "готов",
  failed: "ошибка индексации",
};

const KNOWLEDGE_UPLOAD_STATUS = {
  queued: "в очереди",
  processing: "разбирается",
  ready: "готов",
  failed: "ошибка",
  cancelled: "отменён",
};

const KNOWLEDGE_OUTCOME = {
  new: "новый",
  duplicate: "дубликат",
  new_version: "новая версия",
};

function knowledgeEditable() {
  return ["owner", "admin"].includes(state.me?.role);
}

/** Документов на страницу и предел списка: дальше — фильтр или поиск. */
const KNOWLEDGE_PAGE = 50;
const KNOWLEDGE_PAGE_MAX = 200;

async function loadKnowledge() {
  state.knowledge = state.knowledge || { collection: "", uploadTarget: "", filter: "", selected: new Set(), limit: KNOWLEDGE_PAGE };
  const k = state.knowledge;
  const query = new URLSearchParams({ limit: String(k.limit) });
  if (k.collection) query.set("collection_id", k.collection);
  if (k.filter) query.set("index_status", k.filter);
  if (k.search) query.set("q", k.search);
  const uploadsQuery = new URLSearchParams(k.collection ? { collection_id: k.collection } : {});
  // Каждый запрос сам по себе: недоступное состояние индекса не должно
  // прятать коллекции и документы. Без коллекций раздел бесполезен —
  // их отказ, как и истёкшая сессия, идёт обычной ошибкой.
  const [collections, documents, uploads, index, embeddings, settings] = await Promise.allSettled([
    request("/knowledge/collections"),
    request(`/knowledge/documents?${query}`),
    request(`/knowledge/uploads?${uploadsQuery}`),
    request("/knowledge/index"),
    request("/knowledge/embeddings"),
    request("/settings"),
  ]);
  const expired = [collections, documents, uploads, index, embeddings, settings].find((item) => item.status === "rejected" && item.reason?.status === 401);
  if (expired) throw expired.reason;
  if (collections.status === "rejected") throw collections.reason;
  k.collections = collections.value.payload.collections || [];
  k.failed = { documents: documents.status === "rejected", uploads: uploads.status === "rejected", index: index.status === "rejected", embeddings: embeddings.status === "rejected", settings: settings.status === "rejected" };
  if (!k.failed.documents) {
    k.documents = documents.value.payload.documents || [];
    k.total = documents.value.payload.total || 0;
  }
  if (!k.failed.uploads) k.uploads = uploads.value.payload.uploads || [];
  if (!k.failed.index) k.index = index.value.payload;
  if (!k.failed.embeddings) k.embeddings = embeddings.value.payload;
  if (!k.failed.settings) k.runtime = { ...settings.value.payload, etag: settings.value.payload.etag || settings.value.response.headers.get("ETag") };
  if (k.collection && !k.collections.some((item) => item.id === k.collection)) k.collection = "";
  renderKnowledge();
  scheduleKnowledgeRefresh();
}

/**
 * Обновлять раз в 5 секунд, только пока что-то действительно идёт:
 * разбор загрузки, индексация документа, построение версии. «Ждёт
 * индексации» при выключенном индексе не меняется само — по нему не
 * опрашиваем. Вкладка в фоне не опрашивает вовсе.
 */
function scheduleKnowledgeRefresh() {
  clearTimeout(scheduleKnowledgeRefresh.timer);
  const k = state.knowledge;
  const busy = (k.uploads || []).some((item) => ["queued", "processing"].includes(item.status))
    || (k.documents || []).some((item) => item.index_status === "indexing")
    || (k.index?.versions || []).some((item) => item.building);
  if (!busy) return;
  scheduleKnowledgeRefresh.timer = setTimeout(() => {
    if (state.page !== "knowledge") return;
    if (document.hidden) { scheduleKnowledgeRefresh(); return; }
    loadKnowledge().catch(() => {});
  }, 5_000);
}

function knowledgeUnavailable(what) {
  return `<p class="warn-value">${what} сейчас недоступны — нажмите «Обновить» позже.</p>`;
}

/**
 * Почему документы не попадают в Qdrant. Без ключа, при выключенной
 * индексации и без построенной модели задание индексации ничего не
 * делает, и «ждёт индексации» висело вечно — хотя Ева уже находит
 * документ поиском по PostgreSQL. null — индексировать есть куда.
 */
function knowledgeIndexBlocker() {
  const k = state.knowledge;
  if (k.failed?.index || !k.index) return null;
  if (k.index.qdrant === false) return { reason: "Qdrant не настроен", hint: "Задайте QDRANT_API_KEY и перезапустите сервисы." };
  if (knowledgeSetting("index_enabled") === false) {
    return { reason: "индексация выключена", hint: "Включите «Индексацию» в параметрах поиска выше и нажмите «Сверить с Qdrant сейчас»; если активной версии эмбеддингов нет — «Построить индекс» и «Активировать»." };
  }
  const versions = knowledgeVersions();
  if (!versions.length && k.failed?.embeddings) return null;
  if (!versions.some((v) => ["building", "ready", "active"].includes(v.status))) {
    return { reason: "нет построенной модели эмбеддингов", hint: "В блоке «Embedding-модель» проверьте и сохраните модель, затем «Построить индекс» и «Активировать»." };
  }
  return null;
}

function renderKnowledge() {
  renderKnowledgeEmbedding();
  renderKnowledgeCollections();
  renderKnowledgeUploads();
  renderKnowledgeDocuments();
  renderKnowledgeIndex();
}

function renderKnowledgeCollections() {
  const k = state.knowledge;
  const editable = knowledgeEditable();
  const rows = k.collections;
  $("#knowledge-collections").innerHTML = `
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Коллекция</th><th>Код</th><th>Документы</th><th>В индексе</th><th>Ошибки</th><th>Включена</th>${editable ? "<th></th>" : ""}</tr></thead>
      <tbody>${rows.map((item) => `
        <tr data-collection-row="${escapeHtml(item.id)}">
          <td><strong>${escapeHtml(item.title)}</strong>${item.description ? `<br><small>${escapeHtml(item.description)}</small>` : ""}</td>
          <td><code>${escapeHtml(item.code)}</code></td>
          <td>${item.documents}</td>
          <td>${item.indexed}</td>
          <td>${item.failed ? `<span class="warn-value">${item.failed}</span>` : "0"}</td>
          <td>${editable
            ? `<input type="checkbox" data-collection-toggle="${escapeHtml(item.id)}" ${item.enabled ? "checked" : ""} aria-label="Коллекция включена">`
            : item.enabled ? "да" : "нет"}</td>
          ${editable ? `<td class="row-actions">
            <button class="button tiny ghost" data-collection-rename="${escapeHtml(item.id)}">Переименовать</button>
            <button class="button tiny ghost" data-collection-reindex="${escapeHtml(item.id)}">Переиндексировать</button>
            <button class="button tiny danger" data-collection-delete="${escapeHtml(item.id)}" ${item.documents ? "disabled title=\"Сначала удалите документы\"" : ""}>Удалить</button>
          </td>` : ""}
        </tr>`).join("")}
      </tbody></table></div>` : '<p class="knowledge-empty">Коллекций пока нет. Создайте первую — документы общей базы живут в коллекциях.</p>'}
    ${editable ? `<form id="knowledge-collection-form" class="inline-form">
      <input name="title" required maxlength="200" placeholder="Название, например «Методические материалы»" aria-label="Название коллекции">
      <input name="code" required pattern="[a-z0-9][a-z0-9_-]{0,62}" maxlength="63" placeholder="код: metodichka" aria-label="Код коллекции">
      <button class="button">Создать коллекцию</button>
    </form>` : ""}`;

  const select = $("#knowledge-collection-select");
  select.innerHTML = `<option value="">Все коллекции</option>${rows.map((item) =>
    `<option value="${escapeHtml(item.id)}" ${item.id === k.collection ? "selected" : ""}>${escapeHtml(item.title)}</option>`).join("")}`;
  // Коллекция загрузки — выбор администратора, а не фильтр списка: она
  // переживает перерисовку (после каждой загрузки и при опросе), иначе
  // следующий файл ушёл бы в первую коллекцию общей базы, видную всем.
  const chosen = [k.uploadTarget, k.collection].find((id) => id && rows.some((item) => item.id === id)) || rows[0]?.id || "";
  k.uploadTarget = chosen;
  const target = $("#knowledge-upload-collection");
  target.innerHTML = rows.length
    ? rows.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === chosen ? "selected" : ""}>${escapeHtml(item.title)}</option>`).join("")
    : '<option value="">Сначала создайте коллекцию</option>';
  $("#knowledge-upload").hidden = !editable;
  renderKnowledgeUploadAccess();
}

/** Причина отказа видна рядом с выбором файла, в том числе на телефоне. */
function renderKnowledgeUploadAccess() {
  const k = state.knowledge;
  const setting = k.runtime?.settings?.find((s) => s.key === "runtime.knowledge_uploads_enabled");
  const known = !k.failed?.index && typeof k.index?.uploads_enabled === "boolean";
  const enabled = known && k.index.uploads_enabled;
  const worker = k.index?.uploads_worker_enabled !== false;
  const message = k.uploadSettingsBusy ? "Сохраняем настройку загрузки…"
    : !known ? "Не удалось проверить доступность загрузки. Нажмите «Обновить»."
    : !worker ? "Обработка файлов выключена. Включите EVA_BULLMQ_JOBS и перезапустите сервис агента и admin-api."
    : !enabled && (!setting || k.failed?.settings) ? "Загрузка файлов выключена; настройка для включения недоступна. Нажмите «Обновить»."
    : !enabled ? "Загрузка файлов выключена. Нажмите «Включить загрузку» — настройка сохранится на сервере."
    : !k.collections.length ? "Сначала создайте коллекцию выше, затем выберите файлы."
    : "Загрузка включена. Файлы будут разобраны в фоне; состояние появится в списке ниже.";
  $("#knowledge-upload-availability").textContent = message;
  $("#knowledge-upload-button").disabled = !knowledgeEditable() || !enabled || !k.collections.length || !!k.uploadSettingsBusy;
  $("#knowledge-file").disabled = $("#knowledge-upload-button").disabled;
  const toggle = $("#knowledge-upload-toggle");
  toggle.hidden = !knowledgeEditable() || !setting || k.failed?.settings;
  toggle.textContent = enabled ? "Выключить загрузку" : "Включить загрузку";
  toggle.disabled = !known || !worker || !k.runtime?.etag || !!k.uploadSettingsBusy;
}

function renderKnowledgeUploads() {
  if (state.knowledge.failed?.uploads) {
    $("#knowledge-uploads").innerHTML = knowledgeUnavailable("Загрузки");
    return;
  }
  const rows = (state.knowledge.uploads || []).slice(0, 30);
  const titles = new Map((state.knowledge.collections || []).map((item) => [item.id, item.title]));
  $("#knowledge-uploads").innerHTML = rows.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Файл</th><th>Коллекция</th><th>Размер</th><th>Статус</th><th>Исход</th><th>Когда</th>${knowledgeEditable() ? "<th></th>" : ""}</tr></thead>
    <tbody>${rows.map((item) => `
      <tr data-upload-row="${escapeHtml(item.id)}">
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(titles.get(item.collection_id) || "—")}</td>
        <td>${bytes(item.size_bytes)}</td>
        <td><span class="status-pill ${item.status === "failed" || item.status === "cancelled" ? "state-red" : item.status === "ready" ? "state-green" : "state-yellow"}">${escapeHtml(KNOWLEDGE_UPLOAD_STATUS[item.status] || item.status)}</span>
          ${item.error_code ? `<br><small class="warn-value">${escapeHtml(item.error_code)}</small>` : ""}</td>
        <td>${escapeHtml(KNOWLEDGE_OUTCOME[item.outcome] || "—")}</td>
        <td>${localDate(item.created_at)}</td>
        ${knowledgeEditable() ? `<td class="row-actions">${["failed", "cancelled"].includes(item.status)
          ? `<button class="button tiny ghost" data-upload-retry="${escapeHtml(item.id)}">Повторить</button>
            <button class="button tiny danger" data-upload-delete="${escapeHtml(item.id)}">Удалить</button>` : ""}</td>` : ""}
      </tr>`).join("")}
    </tbody></table></div>` : '<p class="knowledge-empty">Загрузок пока не было.</p>';
}

function renderKnowledgeDocuments() {
  const k = state.knowledge;
  const editable = knowledgeEditable();
  if (k.failed?.documents) {
    $("#knowledge-documents").innerHTML = knowledgeUnavailable("Документы");
    $("#knowledge-more").hidden = true;
    return;
  }
  k.documents = k.documents || [];
  const titles = new Map((k.collections || []).map((item) => [item.id, item.title]));
  k.selected = new Set([...k.selected].filter((id) => k.documents.some((doc) => doc.id === id)));
  const blocker = knowledgeIndexBlocker();
  // «Ждёт индексации» — только когда индексация действительно впереди.
  const indexCell = (doc) => doc.index_status === "pending" && blocker
    ? `<span class="status-pill state-yellow">не в Qdrant</span><br><small>${escapeHtml(blocker.reason)} — Ева уже находит документ без Qdrant</small>`
    : `<span class="status-pill ${doc.index_status === "failed" ? "state-red" : doc.index_status === "ready" ? "state-green" : "state-yellow"}">${escapeHtml(KNOWLEDGE_INDEX_STATUS[doc.index_status] || doc.index_status)}</span>
            ${doc.index_error ? `<br><small class="warn-value">${escapeHtml(doc.index_error)}</small>` : ""}`;
  $("#knowledge-documents").innerHTML = k.documents.length ? `
    <p class="block-caption">Показано ${k.documents.length} из ${k.total}.${k.total > k.documents.length && k.limit >= KNOWLEDGE_PAGE_MAX ? " Остальные — через коллекцию, состояние или поиск." : ""}</p>
    <div class="table-wrap"><table>
      <thead><tr>
        ${editable ? '<th><input type="checkbox" id="knowledge-select-all" aria-label="Выбрать все"></th>' : ""}
        <th>Документ</th><th>Коллекция</th><th>Фрагменты</th><th>Индекс</th><th>Версия</th><th>Обновлён</th>${editable ? "<th></th>" : ""}
      </tr></thead>
      <tbody>${k.documents.map((doc) => `
        <tr data-document-row="${escapeHtml(doc.id)}">
          ${editable ? `<td><input type="checkbox" data-document-select="${escapeHtml(doc.id)}" ${k.selected.has(doc.id) ? "checked" : ""} aria-label="Выбрать документ"></td>` : ""}
          <td>${escapeHtml(doc.name)}<br><small>${bytes(doc.size_bytes)}</small></td>
          <td>${escapeHtml(titles.get(doc.collection_id) || "—")}</td>
          <td>${doc.chunk_count}</td>
          <td>${indexCell(doc)}</td>
          <td>${doc.revision > 1 ? `v${doc.revision}` : "v1"}</td>
          <td>${localDate(doc.updated_at)}</td>
          ${editable ? `<td class="row-actions"><button class="button tiny danger" data-document-delete="${escapeHtml(doc.id)}">Удалить</button></td>` : ""}
        </tr>`).join("")}
      </tbody></table></div>` : '<p class="knowledge-empty">Документов нет. Загрузите файлы в коллекцию выше.</p>';
  $("#knowledge-more").hidden = !(k.total > k.documents.length && k.limit < KNOWLEDGE_PAGE_MAX);
  $("#knowledge-bulk").hidden = !editable || !k.documents.length;
  $("#knowledge-bulk-count").textContent = k.selected.size ? `Выбрано: ${k.selected.size}` : "Ничего не выбрано";
  $("#knowledge-bulk-delete").disabled = !k.selected.size;
  $("#knowledge-bulk-reindex").disabled = !k.selected.size;
}

function renderKnowledgeIndex() {
  if (state.knowledge.failed?.index) {
    $("#knowledge-index").innerHTML = knowledgeUnavailable("Сведения об индексе");
    return;
  }
  const index = state.knowledge.index || {};
  const scopes = index.scopes || {};
  const blocker = knowledgeIndexBlocker();
  const scope = (name, title) => {
    const item = scopes[name] || { documents: 0, chunks: 0, by_status: {}, lag_seconds: 0 };
    return `<article class="knowledge-metric">
      <span>${title}</span>
      <strong>${item.documents}</strong>
      <small>документов, ${item.chunks} фрагментов</small>
      <small>готово ${item.by_status?.ready || 0}, ${blocker ? "не в Qdrant" : "в очереди"} ${(item.by_status?.pending || 0) + (item.by_status?.indexing || 0)}, ошибок ${item.by_status?.failed || 0}</small>
      ${item.lag_seconds && !blocker ? `<small>ждёт дольше всех: ${duration(item.lag_seconds)}</small>` : ""}
    </article>`;
  };
  const editable = knowledgeEditable();
  const versions = knowledgeVersions();
  const hasActive = versions.some((item) => item.status === "active");
  $("#knowledge-index").innerHTML = `
    ${index.qdrant ? "" : '<p class="warn-value">QDRANT_API_KEY не задан: векторного индекса нет, поиск идёт по словам. Документы при этом принимаются и хранятся.</p>'}
    ${blocker && index.qdrant ? `<p class="warn-value">Документы ищутся без Qdrant: ${escapeHtml(blocker.reason)}. ${escapeHtml(blocker.hint)}</p>` : ""}
    <div class="knowledge-metrics">
      ${scope("global", "Общая база")}
      ${scope("private", `Личные базы (людей: ${index.private_owners || 0})`)}
    </div>
    ${versions.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Версия</th><th>Модель</th><th>Состояние</th><th>Построено</th>${editable ? "<th></th>" : ""}</tr></thead>
      <tbody>${versions.map((item) => `
        <tr data-version-row="${item.version}">
          <td>v${item.version}</td>
          <td>${escapeHtml(item.model)} <small>(${item.dimension})</small></td>
          <td>${escapeHtml(item.status)}${item.building ? " · строится" : ""}${item.error_code ? `<br><small class="warn-value">${escapeHtml(item.error_code)}</small>` : ""}</td>
          <td>${item.progress === null || item.progress === undefined ? "—" : `${Math.round(item.progress * 100)}%`}</td>
          ${editable ? `<td class="row-actions">
            ${!item.building && ["draft", "building", "ready", "active", "retired", "failed"].includes(item.status)
              ? `<button class="button tiny ghost" data-version-build="${item.version}" ${knowledgeSetting("index_enabled") === false ? "disabled" : ""}>${item.status === "draft" ? "Построить индекс" : item.status === "failed" ? "Построить заново" : "Перестроить"}</button>` : ""}
            ${["ready", "retired"].includes(item.status) && !item.building && item.built_at && !item.error_code
              ? `<button class="button tiny" data-version-activate="${item.version}">${item.status === "retired" ? "Откатить на эту версию" : hasActive ? "Активировать новую модель" : "Активировать"}</button>` : ""}
            ${item.status === "active" && index.aliases_match_active === false ? `<button class="button tiny" data-version-activate="${item.version}">Восстановить aliases</button>` : ""}
          </td>` : ""}
        </tr>`).join("")}
      </tbody></table></div>` : '<p class="knowledge-empty">Версий эмбеддингов ещё нет: создайте её в блоке «Embedding-модель» выше.</p>'}
    ${editable && knowledgeSetting("index_enabled") === false ? '<p class="warn-value">Для построения сначала включите индексацию в параметрах базы выше. Поиск на Qdrant включается отдельно после активации.</p>' : ""}
    ${editable ? '<div class="knowledge-actions"><button class="button ghost" id="knowledge-reconcile">Сверить с Qdrant сейчас</button></div>' : ""}`;
}

function knowledgeMime(file) {
  if (file.type && Object.values(KNOWLEDGE_MIME_BY_EXT).includes(file.type)) return file.type;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  return KNOWLEDGE_MIME_BY_EXT[ext] || "";
}

/**
 * Загрузка по одному файлу: сервер принимает один файл на запрос, а
 * очередь в браузере показывает, какой файл уже ушёл и какой отказан и
 * почему. Разбор всё равно идёт на сервере по очереди заданий.
 */
async function uploadKnowledgeFiles(files) {
  if ($("#knowledge-upload-button").disabled) {
    toast($("#knowledge-upload-availability").textContent, true);
    return;
  }
  const collection = $("#knowledge-upload-collection").value;
  if (!collection) {
    toast("Сначала выберите коллекцию", true);
    return;
  }
  const list = [...files];
  const progress = $("#knowledge-upload-progress");
  let done = 0;
  let failed = 0;
  for (const file of list) {
    progress.textContent = `Загружается ${done + failed + 1} из ${list.length}: ${file.name}`;
    const mime = knowledgeMime(file);
    if (!mime) { failed += 1; toast(`${file.name}: этот формат пока не принимается`, true); continue; }
    if (file.size > KNOWLEDGE_UPLOAD_LIMIT) { failed += 1; toast(`${file.name}: файл больше 10 МБ`, true); continue; }
    const form = new FormData();
    form.append("file", new File([file], file.name, { type: mime }));
    try {
      const response = await fetch(`${API}/knowledge/uploads?collection_id=${encodeURIComponent(collection)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "X-CSRF-Token": csrf() },
        body: form,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw Object.assign(new Error(payload?.error?.message || `Отказ ${response.status}`), { status: response.status });
      }
      done += 1;
    } catch (error) {
      if (error.status === 401) { handleError(error); return; }
      failed += 1;
      toast(`${file.name}: ${error.message}`, true);
    }
  }
  progress.textContent = failed
    ? `Принято ${done} из ${list.length}; не принято: ${failed}`
    : `Принято ${done} из ${list.length}. Разбор и индексация идут в фоне.`;
  await loadKnowledge();
}

function bindKnowledge() {
  bindKnowledgeEmbeddings();
  $("#reload-knowledge").addEventListener("click", () => loadKnowledge().catch(handleError));
  $("#knowledge-collection-select").addEventListener("change", (event) => {
    state.knowledge.collection = event.target.value;
    // Выбрали коллекцию в списке — в неё же удобно и загружать; «Все
    // коллекции» выбор загрузки не трогает.
    if (event.target.value) state.knowledge.uploadTarget = event.target.value;
    state.knowledge.limit = KNOWLEDGE_PAGE;
    loadKnowledge().catch(handleError);
  });
  $("#knowledge-upload-collection").addEventListener("change", (event) => {
    state.knowledge.uploadTarget = event.target.value;
  });
  $("#knowledge-more").addEventListener("click", () => {
    state.knowledge.limit = Math.min(state.knowledge.limit + KNOWLEDGE_PAGE, KNOWLEDGE_PAGE_MAX);
    loadKnowledge().catch(handleError);
  });
  $("#knowledge-file").accept = KNOWLEDGE_ACCEPT;
  $("#knowledge-status-filter").addEventListener("change", (event) => {
    state.knowledge.filter = event.target.value;
    state.knowledge.limit = KNOWLEDGE_PAGE;
    loadKnowledge().catch(handleError);
  });
  $("#knowledge-search").addEventListener("change", (event) => {
    state.knowledge.search = event.target.value.trim();
    state.knowledge.limit = KNOWLEDGE_PAGE;
    loadKnowledge().catch(handleError);
  });
  $("#knowledge-upload-button").addEventListener("click", () => $("#knowledge-file").click());
  $("#knowledge-upload-toggle").addEventListener("click", async () => {
    const k = state.knowledge;
    if ($("#knowledge-upload-toggle").disabled) return;
    const enabled = k.index?.uploads_enabled === true;
    k.uploadSettingsBusy = true;
    renderKnowledgeUploadAccess();
    try {
      await saveKnowledgeRuntime({ "runtime.knowledge_uploads_enabled": !enabled });
    } catch (error) {
      handleError(error);
    } finally {
      k.uploadSettingsBusy = false;
      renderKnowledgeUploadAccess();
    }
  });
  $("#knowledge-file").addEventListener("change", (event) => {
    const files = event.target.files;
    if (files?.length) uploadKnowledgeFiles(files).catch(handleError).finally(() => { event.target.value = ""; });
  });
  const drop = $("#knowledge-drop");
  drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("dragging"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("dragging");
    if (event.dataTransfer?.files?.length) uploadKnowledgeFiles(event.dataTransfer.files).catch(handleError);
  });

  $("#page-knowledge").addEventListener("submit", (event) => {
    if (event.target.id !== "knowledge-collection-form") return;
    event.preventDefault();
    const form = event.target;
    request("/knowledge/collections", {
      method: "POST",
      body: JSON.stringify({ title: form.elements.title.value, code: form.elements.code.value }),
    }).then(() => { toast("Коллекция создана"); return loadKnowledge(); }).catch(handleError);
  });

  $("#page-knowledge").addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-collection-toggle]");
    if (toggle) {
      request(`/knowledge/collections/${encodeURIComponent(toggle.dataset.collectionToggle)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: toggle.checked }),
      }).then(() => loadKnowledge()).catch(handleError);
      return;
    }
    const select = event.target.closest("[data-document-select]");
    if (select) {
      if (select.checked) state.knowledge.selected.add(select.dataset.documentSelect);
      else state.knowledge.selected.delete(select.dataset.documentSelect);
      renderKnowledgeDocuments();
      return;
    }
    if (event.target.id === "knowledge-select-all") {
      state.knowledge.selected = new Set(event.target.checked ? state.knowledge.documents.map((doc) => doc.id) : []);
      renderKnowledgeDocuments();
    }
  });

  $("#page-knowledge").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const k = state.knowledge;
    if (button.dataset.collectionRename) {
      const current = k.collections.find((item) => item.id === button.dataset.collectionRename);
      const title = window.prompt("Новое название коллекции", current?.title || "");
      if (!title || title.trim() === current?.title) return;
      request(`/knowledge/collections/${encodeURIComponent(button.dataset.collectionRename)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      }).then(() => loadKnowledge()).catch(handleError);
    } else if (button.dataset.collectionReindex) {
      request("/knowledge/documents/reindex", {
        method: "POST",
        body: JSON.stringify({ collection_id: button.dataset.collectionReindex }),
      }).then(({ payload }) => { toast(`Поставлено в индексацию: ${payload.scheduled}`); return loadKnowledge(); }).catch(handleError);
    } else if (button.dataset.collectionDelete) {
      const current = k.collections.find((item) => item.id === button.dataset.collectionDelete);
      askConfirm({
        title: "Удалить коллекцию?",
        description: `Коллекция «${current?.title || ""}» пуста и будет удалена.`,
        action: async () => {
          await request(`/knowledge/collections/${encodeURIComponent(button.dataset.collectionDelete)}`, { method: "DELETE" });
          toast("Коллекция удалена");
          await loadKnowledge();
        },
      });
    } else if (button.dataset.uploadRetry) {
      request(`/knowledge/uploads/${encodeURIComponent(button.dataset.uploadRetry)}/retry`, { method: "POST" })
        .then(() => loadKnowledge()).catch(handleError);
    } else if (button.dataset.uploadDelete) {
      const upload = (k.uploads || []).find((item) => item.id === button.dataset.uploadDelete);
      askConfirm({
        title: "Удалить загрузку?",
        description: `«${upload?.name || ""}» не разобрался: запись и исходный файл будут удалены. В базу знаний и Qdrant он не попадал.`,
        action: async () => {
          await request(`/knowledge/uploads/${encodeURIComponent(button.dataset.uploadDelete)}/delete`, { method: "POST" });
          toast("Загрузка удалена");
          await loadKnowledge();
        },
      });
    } else if (button.dataset.documentDelete) {
      const doc = (k.documents || []).find((item) => item.id === button.dataset.documentDelete);
      askConfirm({
        title: "Удалить документ?",
        description: `«${doc?.name || ""}», его фрагменты и векторы в Qdrant будут удалены из базы знаний вместе с исходным файлом. Ева перестанет его находить.`,
        action: async () => {
          const { payload } = await request("/knowledge/documents/delete", { method: "POST", body: JSON.stringify({ ids: [button.dataset.documentDelete] }) });
          toast(payload.deleted.length ? "Документ удалён" : "Документ уже удалён");
          k.selected.delete(button.dataset.documentDelete);
          await loadKnowledge();
        },
      });
    } else if (button.id === "knowledge-bulk-delete") {
      const ids = [...k.selected];
      askConfirm({
        title: `Удалить документы: ${ids.length}?`,
        description: "Документы, их фрагменты и векторы будут удалены из общей базы. Ева перестанет находить их для всех пользователей.",
        action: async () => {
          const { payload } = await request("/knowledge/documents/delete", { method: "POST", body: JSON.stringify({ ids }) });
          toast(`Удалено: ${payload.deleted.length}`);
          k.selected.clear();
          await loadKnowledge();
        },
      });
    } else if (button.id === "knowledge-bulk-reindex") {
      request("/knowledge/documents/reindex", { method: "POST", body: JSON.stringify({ ids: [...k.selected] }) })
        .then(({ payload }) => { toast(`Поставлено в индексацию: ${payload.scheduled}`); return loadKnowledge(); })
        .catch(handleError);
    } else if (button.dataset.versionBuild) {
      askConfirm({
        eyebrow: "ИНДЕКС",
        title: `Перестроить индекс v${button.dataset.versionBuild}?`,
        description: "Все документы этой версии переиндексируются из PostgreSQL в фоне, включая пересчёт векторов. Поиск по активной версии продолжает работать.",
        action: async () => {
          await request(`/knowledge/embeddings/versions/${encodeURIComponent(button.dataset.versionBuild)}/build`, { method: "POST", body: JSON.stringify({ full: true }) });
          toast("Построение поставлено в очередь");
          await loadKnowledge();
        },
      });
    } else if (button.dataset.versionActivate) {
      const expectedActive = knowledgeVersions().find((v) => v.status === "active")?.version || null;
      askConfirm({
        eyebrow: "ИНДЕКС",
        title: `Активировать embedding-версию v${button.dataset.versionActivate}?`,
        description: "Сервер проверит каждый фрагмент по PostgreSQL и переведёт оба Qdrant alias атомарно. Прежняя версия останется для проверяемого отката. Режим поиска меняется отдельно кнопкой «Включить Hybrid + Qdrant».",
        action: async () => {
          await request(`/knowledge/embeddings/versions/${encodeURIComponent(button.dataset.versionActivate)}/activate`, {
            method: "POST", body: JSON.stringify({ expected_active_version: expectedActive }),
          });
          toast("Версия включена");
          await loadKnowledge();
        },
      });
    } else if (button.id === "knowledge-reconcile") {
      request("/knowledge/index/reconcile", { method: "POST" })
        .then(() => toast("Сверка поставлена в очередь"))
        .catch(handleError);
    }
  });
}

bindKnowledge();
