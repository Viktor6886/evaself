/**
 * Вкладка «База знаний»: личные документы человека.
 *
 * Человек загружает свои файлы, видит, что с каждым происходит (разбор,
 * индексация, дубликат, новая версия), и может удалить документ или
 * очистить базу целиком. Искать в документах Ева будет сама, когда это
 * нужно в разговоре: вкладка только ведёт список.
 *
 * Вкладка есть, только когда функция включена на сервере: `GET
 * /public/knowledge` отвечает `enabled: false` — кнопка в нижнем меню не
 * показывается вовсе. Сервер недоступен — вкладка тоже скрыта: пустой
 * раздел с ошибкой хуже, чем его отсутствие.
 *
 * Чужих документов здесь нет и быть не может: сервер отдаёт только
 * документы владельца сессии.
 */
(() => {
  "use strict";

  const app = () => window.EvaApp;
  const MAX_BYTES = 10 * 1024 * 1024;
  const ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.html,.htm,.json";
  const MIME_BY_EXT = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
  };

  /**
   * Причины отказа загрузки: сервер отдаёт короткий код, человеку нужна
   * фраза. Незнакомый код — общая фраза, а не код.
   */
  const REASONS = {
    document_empty: "файл пустой",
    document_too_large: "файл больше 10 МБ",
    document_type_unsupported: "такой формат пока не принимается",
    document_mime_mismatch: "содержимое не совпадает с форматом файла",
    document_pdf_malformed_or_encrypted: "PDF повреждён или защищён паролем",
    document_docx_malformed: "файл DOCX повреждён",
    document_docx_xml_invalid: "файл DOCX повреждён",
    document_html_invalid: "не удалось прочитать HTML",
    document_json_invalid: "не удалось прочитать JSON",
    document_pages_exceeded: "в документе слишком много страниц",
    document_paragraphs_exceeded: "в документе слишком много текста",
    document_sections_exceeded: "в документе слишком много разделов",
    document_replaces_missing: "обновляемого документа больше нет",
    document_replaces_invalid: "обновляемого документа больше нет",
    document_antivirus_infected: "антивирус нашёл угрозу",
    document_antivirus_unavailable: "антивирус недоступен, попробуй позже",
    cancelled: "загрузка отменена",
  };

  const state = { enabled: null, documents: [], total: 0, uploads: [], timer: null, uploading: false, picking: false };

  function reasonOf(code, fallback = "не удалось разобрать файл") {
    return REASONS[code] || fallback;
  }

  function errorText(error) {
    const code = String(error?.message || "");
    return REASONS[code] || app().friendlyError(error);
  }

  /** Включена ли функция; кнопка в меню показывается только при «да». */
  async function probe() {
    try {
      const result = await app().api("/public/knowledge");
      apply(result);
    } catch {
      state.enabled = false;
    }
    syncNav();
    return state.enabled;
  }

  function apply(result) {
    state.enabled = result?.enabled === true;
    state.documents = Array.isArray(result?.documents) ? result.documents : [];
    state.total = Number(result?.total) || state.documents.length;
    state.uploads = Array.isArray(result?.uploads) ? result.uploads : [];
  }

  function syncNav() {
    const nav = document.getElementById("knowledge-nav");
    if (nav) nav.hidden = !state.enabled;
    document.body.classList.toggle("has-knowledge", Boolean(state.enabled));
  }

  /** Состояние считает сервер: внутренних кодов индекса Mini App не видит. */
  function statusOf(doc) {
    if (doc.state === "failed") return { label: "Индексация не удалась", tone: "error" };
    if (doc.state === "indexing") return { label: "Индексируется", tone: "pending" };
    return { label: "Готов", tone: "ok" };
  }

  function uploadStatus(upload) {
    if (upload.status === "failed") return { label: "Ошибка", tone: "error" };
    if (upload.status === "cancelled") return { label: "Отменено", tone: "error" };
    if (upload.status === "queued") return { label: "В очереди", tone: "pending" };
    if (upload.status === "processing") return { label: "Обрабатывается", tone: "pending" };
    if (upload.outcome === "duplicate") return { label: "Дубликат: уже есть", tone: "muted" };
    if (upload.outcome === "new_version") return { label: "Новая версия", tone: "ok" };
    return { label: "Новый", tone: "ok" };
  }

  function size(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} Б`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
    return `${(value / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
  }

  function busy() {
    return state.uploads.some((item) => ["queued", "processing"].includes(item.status))
      || state.documents.some((item) => item.state === "indexing");
  }

  /** Пока идёт разбор или индексация и вкладка открыта — обновлять список. */
  function schedule() {
    clearTimeout(state.timer);
    if (!busy()) return;
    state.timer = setTimeout(async () => {
      if (document.querySelector('[data-screen="knowledge"]')?.hidden) return;
      // Открыт системный выбор файла: перерисовка заменила бы скрытое поле,
      // и на части WebView выбранный файл уже некуда было бы вернуть.
      if (state.picking) { schedule(); return; }
      await refresh();
      paint();
    }, 4_000);
  }

  async function refresh() {
    const result = await app().safeApi("/public/knowledge", {}, null);
    if (result) apply(result);
    syncNav();
  }

  async function render() {
    const host = document.getElementById("knowledge-content");
    if (!host) return;
    host.innerHTML = '<div class="section-stack"><div class="loading-skeleton"></div><div class="loading-skeleton"></div></div>';
    await refresh();
    paint();
  }

  function paint() {
    const host = document.getElementById("knowledge-content");
    if (!host) return;
    const { escapeHtml, escapeAttr, emptyState, formatDate } = app();
    if (!state.enabled) {
      host.innerHTML = emptyState("База знаний выключена", "Раздел появится, когда его включат.");
      return;
    }
    const pending = state.uploads.filter((item) => item.status !== "ready" || item.outcome === "duplicate").slice(0, 10);
    host.innerHTML = `
      <section class="knowledge-intro">
        <p>Загрузи свои документы — договоры, заметки, методички. Ева найдёт в них нужное, когда ты спросишь.</p>
        <p class="knowledge-hint">PDF, DOCX, TXT, Markdown, HTML, JSON — до 10 МБ. Документы видишь только ты.</p>
        <input type="file" id="knowledge-file" accept="${ACCEPT}" multiple hidden>
        <button class="primary-action" id="knowledge-upload" type="button" ${state.uploading ? "disabled" : ""}>
          ${state.uploading ? "Загружаю…" : "Загрузить документ"}
        </button>
      </section>
      ${pending.length ? `<h2 class="ios-section-title">Загрузки</h2>
      <div class="section-stack" id="knowledge-uploads">
        ${pending.map((upload) => {
          const status = uploadStatus(upload);
          return `<article class="knowledge-item" data-knowledge-upload="${escapeAttr(upload.id)}">
            <div class="knowledge-copy"><strong>${escapeHtml(upload.name)}</strong>
              <small>${size(upload.size_bytes)} · ${escapeHtml(formatDate(upload.created_at))}</small>
              ${["failed", "cancelled"].includes(upload.status) ? `<small class="knowledge-reason">${escapeHtml(reasonOf(upload.error_code))}</small>` : ""}</div>
            <span class="knowledge-status is-${status.tone}">${escapeHtml(status.label)}</span>
          </article>`;
        }).join("")}
      </div>` : ""}
      <h2 class="ios-section-title">Мои документы${state.total > state.documents.length ? ` · показаны ${state.documents.length} из ${state.total}` : ""}</h2>
      <div class="section-stack" id="knowledge-documents">
        ${state.documents.length ? state.documents.map((doc) => {
          const status = statusOf(doc);
          return `<article class="knowledge-item" data-knowledge-document="${escapeAttr(doc.id)}">
            <div class="knowledge-copy"><strong>${escapeHtml(doc.name)}</strong>
              <small>${size(doc.size_bytes)}${doc.revision > 1 ? ` · версия ${doc.revision}` : ""} · ${escapeHtml(formatDate(doc.updated_at || doc.created_at))}</small></div>
            <span class="knowledge-status is-${status.tone}">${escapeHtml(status.label)}</span>
            <div class="knowledge-actions">
              <button class="secondary-action" type="button" data-knowledge-replace="${escapeAttr(doc.id)}">Обновить</button>
              <button class="danger-link" type="button" data-knowledge-delete="${escapeAttr(doc.id)}" aria-label="Удалить документ ${escapeAttr(doc.name)}">Удалить</button>
            </div>
          </article>`;
        }).join("") : emptyState("Документов пока нет", "Загрузи первый — он появится здесь, когда Ева его разберёт.")}
      </div>
      ${state.documents.length ? '<button class="danger-link knowledge-clear" id="knowledge-clear" type="button">Очистить базу знаний</button>' : ""}
    `;
    bind(host);
    schedule();
  }

  function pick(input) {
    state.picking = true;
    // Окно выбора закрылось без файла: `change` не придёт, придёт фокус.
    window.addEventListener("focus", () => setTimeout(() => { state.picking = false; }, 500), { once: true });
    input.click();
  }

  function bind(host) {
    const input = host.querySelector("#knowledge-file");
    host.querySelector("#knowledge-upload")?.addEventListener("click", () => {
      input.dataset.replace = "";
      input.multiple = true;
      pick(input);
    });
    input?.addEventListener("change", () => {
      state.picking = false;
      const files = [...(input.files || [])];
      const replace = input.dataset.replace || "";
      input.value = "";
      if (files.length) void upload(files, replace);
    });
    host.querySelectorAll("[data-knowledge-replace]").forEach((button) => {
      button.addEventListener("click", () => {
        input.dataset.replace = button.dataset.knowledgeReplace;
        input.multiple = false;
        pick(input);
      });
    });
    host.querySelectorAll("[data-knowledge-delete]").forEach((button) => {
      button.addEventListener("click", () => void remove(button.dataset.knowledgeDelete));
    });
    host.querySelector("#knowledge-clear")?.addEventListener("click", () => void clear());
  }

  function mimeOf(file) {
    if (file.type && Object.values(MIME_BY_EXT).includes(file.type)) return file.type;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    return MIME_BY_EXT[ext] || "";
  }

  async function upload(files, replace) {
    state.uploading = true;
    paint();
    let accepted = 0;
    try {
      for (const file of files) {
        const mime = mimeOf(file);
        if (!mime) { app().toast(`${file.name}: такой формат пока не принимается`, true); continue; }
        if (file.size > MAX_BYTES) { app().toast(`${file.name}: файл больше 10 МБ`, true); continue; }
        const form = new FormData();
        form.append("file", new File([file], file.name, { type: mime }));
        try {
          await app().api(`/public/knowledge/uploads${replace ? `?replaces=${encodeURIComponent(replace)}` : ""}`, {
            method: "POST",
            body: form,
          });
          accepted += 1;
        } catch (error) {
          app().toast(`${file.name}: ${errorText(error)}`, true);
        }
      }
      if (accepted) app().toast(accepted === 1 ? "Документ принят — Ева его разбирает" : `Принято документов: ${accepted}`);
    } finally {
      state.uploading = false;
      await refresh();
      paint();
    }
  }

  async function remove(id) {
    const doc = state.documents.find((item) => item.id === id);
    const confirmed = await app().confirmDanger({
      title: "Удалить документ?",
      detail: `«${doc?.name || "Документ"}» исчезнет из базы знаний, и Ева больше не будет в нём искать.`,
    });
    if (!confirmed) return;
    try {
      await app().api(`/public/knowledge/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
      app().toast("Документ удалён");
    } catch (error) {
      // 404 здесь — документа уже нет (удалён в другом окне или очисткой),
      // а не «функция не подключена».
      app().toast(error?.status === 404 ? "Документ уже удалён" : app().friendlyError(error), true);
    }
    await refresh();
    paint();
  }

  async function clear() {
    const confirmed = await app().confirmDanger({
      title: "Очистить базу знаний?",
      // Очистка удаляет все документы, а не только показанные в списке.
      detail: `Все документы (${state.total}) будут удалены. Это нельзя отменить.`,
      confirmLabel: "Очистить",
    });
    if (!confirmed) return;
    try {
      const result = await app().api("/public/knowledge/documents", {
        method: "DELETE",
        body: JSON.stringify({ confirm: true }),
      });
      app().toast(`Удалено документов: ${result.deleted ?? 0}`);
    } catch (error) {
      app().toast(app().friendlyError(error), true);
    }
    await refresh();
    paint();
  }

  window.EvaKnowledge = { probe, render, state };
})();
