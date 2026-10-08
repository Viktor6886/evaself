/**
 * «Мои данные»: архив всех данных человека одним файлом Excel.
 *
 * Выгрузка уходит в чат с Евой документом — оттуда человек сохраняет
 * файл на телефон или компьютер. Ссылки на скачивание нет: архив — это
 * дневник и анкета, а пересылаемая ссылка хуже чата, где файл видит
 * только сам человек.
 *
 * Загрузка обратно — в два шага: сначала сервер показывает, что именно
 * добавится (та же запись с откатом), и только по второму нажатию пишет.
 * Загрузка только добавляет: существующие записи не меняются, повторы
 * пропускаются. Память Евы из файла сама в память не пишется — её можно
 * передать Еве в чате, и Ева решит, что запомнить.
 *
 * Отдельным файлом, а не внутри `app.js`: тот перевалил за две с
 * половиной тысячи строк. Раздела нет, пока сервер не включил функцию.
 */
(() => {
  "use strict";

  const app = () => window.EvaApp;
  const ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const state = {
    enabled: false,
    memory: false,
    maxBytes: 10 * 1024 * 1024,
    busy: false,
    file: null,
    preview: null,
    result: null,
    exported: null,
  };

  /** Включена ли функция; строка в профиле показывается только при «да». */
  async function probe() {
    try {
      const result = await app().api("/public/archive");
      state.enabled = result?.enabled === true;
      state.memory = result?.memory === true;
      state.maxBytes = Number(result?.max_bytes) || state.maxBytes;
    } catch {
      state.enabled = false;
    }
    return state.enabled;
  }

  function plural(count, one, few, many) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function records(count) {
    return `${count} ${plural(count, "запись", "записи", "записей")}`;
  }

  function open() {
    state.file = null;
    state.preview = null;
    state.result = null;
    state.exported = null;
    app().openSheet({
      title: "Мои данные",
      subtitle: "Все твои данные — одним файлом Excel.",
      html: '<div id="archive-host"></div>',
      onMount: paint,
    });
  }

  function paint() {
    const host = document.getElementById("archive-host");
    if (!host) return;
    if (state.result) host.innerHTML = resultHtml();
    else if (state.preview) host.innerHTML = previewHtml();
    else host.innerHTML = startHtml();
    bind(host);
  }

  function startHtml() {
    const { escapeHtml } = app();
    return `<div class="section-stack">
      <article class="section-card archive-card">
        <h3>Выгрузить в Excel</h3>
        <p>Цели, задачи и напоминания, дневник, заметки, анкета, самочувствие, бюджет, решения и история работы — в одном файле, по листу на раздел${state.memory ? ", и то, что Ева знает о тебе" : ""}.</p>
        <p class="archive-hint">Файл придёт в чат с Евой — оттуда его можно сохранить на телефон или компьютер.</p>
        ${state.exported ? `<p class="archive-done" id="archive-exported">Готово: «${escapeHtml(state.exported.filename)}» отправлен в чат.</p>
          <div class="action-row"><button class="secondary-action" id="archive-open-chat" type="button">Открыть чат</button></div>` : ""}
        <button class="primary-action" id="archive-export" type="button" ${state.busy ? "disabled" : ""}>
          ${state.busy === "export" ? "Собираю архив…" : state.exported ? "Выгрузить ещё раз" : "Выгрузить в Excel"}
        </button>
      </article>
      <article class="section-card archive-card">
        <h3>Загрузить архив</h3>
        <p>Загрузи файл, выгруженный отсюда раньше, — например, на новом аккаунте. Загрузка только добавляет: то, что уже есть у Евы, не меняется и не удаляется, повторы пропускаются.</p>
        <p class="archive-hint">Сначала покажу, что добавится, и только потом запишу. Файл .xlsx до ${Math.round(state.maxBytes / 1024 / 1024)} МБ.</p>
        <input type="file" id="archive-file" accept="${ACCEPT}" hidden>
        <button class="secondary-action" id="archive-pick" type="button" ${state.busy ? "disabled" : ""}>
          ${state.busy === "preview" ? "Читаю файл…" : "Выбрать файл"}
        </button>
      </article>
    </div>`;
  }

  function sheetList(sheets) {
    const { escapeHtml } = app();
    return `<ul class="archive-sheets">${sheets.map((sheet) => `<li>
      <span>${escapeHtml(sheet.name)}</span>
      <strong>${sheet.added > 0 ? `+${sheet.added}` : "—"}</strong>
      ${sheet.existing > 0 ? `<small>уже есть: ${sheet.existing}</small>` : ""}
    </li>`).join("")}</ul>`;
  }

  function notes(report) {
    const { escapeHtml } = app();
    const parts = [];
    if (report.paused_actions > 0) {
      parts.push(`<p class="archive-note">Поручений Еве: ${report.paused_actions}. Они придут выключенными — если они твои, попроси Еву включить их.</p>`);
    }
    for (const warning of report.warnings || []) parts.push(`<p class="archive-note">${escapeHtml(warning)}</p>`);
    if (report.error_count > 0) {
      const shown = (report.errors || []).map((error) =>
        `<li>«${escapeHtml(error.sheet)}», строка ${Number(error.row) || "—"}: ${escapeHtml(error.message)}</li>`).join("");
      const more = report.error_count > (report.errors || []).length
        ? `<li>…и ещё ${report.error_count - report.errors.length}</li>` : "";
      parts.push(`<details class="archive-errors"><summary>Строки с ошибками: ${report.error_count} — их пропущу</summary><ul>${shown}${more}</ul></details>`);
    }
    if ((report.read_only_sheets || []).length > 0) {
      parts.push(`<p class="archive-hint">Только для просмотра, не загружаются: ${report.read_only_sheets.map((name) => `«${escapeHtml(name)}»`).join(", ")}.</p>`);
    }
    return parts.join("");
  }

  /** Почему добавлять нечего: всё уже есть, строки с ошибками или записей нет. */
  function nothingToAdd(report) {
    if (report.error_count > 0) return "Добавить нечего: новые строки с ошибками — поправь их в файле и загрузи снова.";
    if (Number(report.existing_total) > 0) return "Новых записей нет — всё из файла уже есть у Евы.";
    return "В файле нет записей, которые можно загрузить.";
  }

  function previewHtml() {
    const { escapeHtml } = app();
    const report = state.preview;
    const added = Number(report.added_total) || 0;
    return `<article class="section-card archive-card" id="archive-preview">
      <h3>Что добавится</h3>
      <p class="archive-hint">Из файла «${escapeHtml(state.file?.name || "архив")}». Существующие записи не изменятся.</p>
      ${report.sheets?.length ? sheetList(report.sheets) : ""}
      ${added === 0 ? `<p class="archive-done">${nothingToAdd(report)}</p>` : ""}
      ${notes(report)}
      ${report.memory_handoff ? '<p class="archive-hint">Память Евы из файла сама в память не записывается — её можно передать Еве в чате.</p>' : ""}
      <div class="action-row">
        ${added > 0 ? `<button class="primary-action" id="archive-apply" type="button" ${state.busy ? "disabled" : ""}>
          ${state.busy === "apply" ? "Добавляю…" : `Добавить ${records(added)}`}</button>` : ""}
        ${added === 0 && report.memory_handoff ? '<button class="primary-action" id="archive-handoff" type="button">Передать память Еве</button>' : ""}
        <button class="secondary-action" id="archive-back" type="button">${added > 0 ? "Отмена" : "Назад"}</button>
      </div>
    </article>`;
  }

  function resultHtml() {
    const report = state.result;
    const added = Number(report.added_total) || 0;
    return `<article class="section-card archive-card" id="archive-result">
      <h3>Готово</h3>
      <p class="archive-done">Добавлено: ${records(added)}. То, что уже было, осталось как было.</p>
      ${report.sheets?.length ? sheetList(report.sheets) : ""}
      ${notes(report)}
      <div class="action-row">
        ${report.memory_handoff ? '<button class="primary-action" id="archive-handoff" type="button">Передать память Еве</button>' : ""}
        <button class="secondary-action" id="archive-back" type="button">Закрыть</button>
      </div>
    </article>`;
  }

  function bind(host) {
    host.querySelector("#archive-export")?.addEventListener("click", () => void exportArchive());
    host.querySelector("#archive-open-chat")?.addEventListener("click", openChat);
    const input = host.querySelector("#archive-file");
    host.querySelector("#archive-pick")?.addEventListener("click", () => input?.click());
    input?.addEventListener("change", () => {
      const file = input.files?.[0];
      input.value = "";
      if (file) void previewFile(file);
    });
    host.querySelector("#archive-apply")?.addEventListener("click", () => void applyFile());
    host.querySelector("#archive-handoff")?.addEventListener("click", () => {
      const text = (state.result || state.preview)?.memory_handoff;
      if (text) app().openEvaHandoff(text);
    });
    host.querySelector("#archive-back")?.addEventListener("click", () => {
      if (state.result) {
        app().closeSheet();
        return;
      }
      state.preview = null;
      state.file = null;
      paint();
    });
  }

  function openChat() {
    const tg = window.Telegram?.WebApp;
    const username = app().state?.bot?.username;
    if (username) tg?.openTelegramLink?.(`https://t.me/${String(username).replace(/^@/, "")}`);
    else tg?.close?.();
  }

  async function exportArchive() {
    if (state.busy) return;
    state.busy = "export";
    paint();
    try {
      const result = await app().api("/public/archive/export", { method: "POST", body: "{}" });
      state.exported = { filename: result?.filename || "архив.xlsx" };
      app().toast("Архив отправлен в чат с Евой");
    } catch (error) {
      app().toast(app().friendlyError(error), true);
    } finally {
      state.busy = false;
      paint();
    }
  }

  function upload(file) {
    const form = new FormData();
    form.append("file", new File([file], file.name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    return form;
  }

  async function previewFile(file) {
    if (!/\.xlsx$/i.test(file.name)) {
      app().toast("Нужен файл Excel (.xlsx) — тот, что Ева прислала при выгрузке", true);
      return;
    }
    if (file.size > state.maxBytes) {
      app().toast(`Файл больше ${Math.round(state.maxBytes / 1024 / 1024)} МБ`, true);
      return;
    }
    state.busy = "preview";
    paint();
    try {
      state.preview = await app().api("/public/archive/import/preview", { method: "POST", body: upload(file) });
      state.file = file;
    } catch (error) {
      app().toast(app().friendlyError(error), true);
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function applyFile() {
    if (state.busy || !state.file || !state.preview) return;
    state.busy = "apply";
    paint();
    try {
      const sha = encodeURIComponent(state.preview.file_sha256 || "");
      state.result = await app().api(`/public/archive/import?sha256=${sha}`, { method: "POST", body: upload(state.file) });
      state.preview = null;
      app().toast(`Добавлено: ${records(Number(state.result.added_total) || 0)}`);
    } catch (error) {
      app().toast(app().friendlyError(error), true);
    } finally {
      state.busy = false;
      paint();
    }
  }

  window.EvaArchive = { probe, open, state };
})();
