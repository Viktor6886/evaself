/**
 * Разделы «Backup и обновления» и «Системные настройки».
 */
async function loadOperations() {
  const [backups, updates] = await Promise.all([
    request("/backups"),
    request("/updates"),
  ]);
  const items = backups.payload.backups || [];
  const current = updates.payload.current || {};

  $("#backups-list").innerHTML = items.length
    ? items.map((item) => `
      <article class="compact-row">
        <span class="status-dot color-${escapeHtml(BACKUP_COLORS[item.status] || "blue")}"></span>
        <span><strong>${escapeHtml(item.archive_id)}</strong><small>${escapeHtml(localDate(item.created_at))} · ${bytes(item.size)}</small></span>
        <span class="tag ${item.encrypted ? "safe" : ""}">${item.encrypted ? "зашифрован" : "legacy"}</span>
      </article>`).join("")
    : '<p class="muted">Архивов пока нет. Первый можно создать кнопкой выше.</p>';

  // Значения без пояснения читаются неверно: «dirty» звучит как мелочь,
  // хотя блокирует обновление, а пустое «Доступно обновлений» означает
  // «никто ещё не спрашивал», а не «обновлений нет».
  //
  // «Развёрнутый commit» — тот, на котором работают контейнеры, а не тот,
  // что лежит в рабочем дереве. Разница между ними и есть прерванное или
  // откаченное обновление: без неё панель уверяет, что исправление уже
  // на стенде, пока стенд отвечает прежним кодом.
  $("#update-info").innerHTML = `
    <dl class="details-list">
      <div><dt>Ветка</dt><dd>${escapeHtml(current.branch || "неизвестна")}</dd></div>
      <div><dt>Развёрнутый commit</dt><dd class="technical">${escapeHtml(String(current.deployed || "неизвестен").slice(0, 12))}</dd></div>
      ${current.deployed && current.commit && current.deployed !== current.commit ? `
      <div><dt>В рабочем дереве</dt>
        <dd><span class="warn-value technical">${escapeHtml(String(current.commit).slice(0, 12))}</span>
        — код скачан, но не развёрнут: выполните обновление</dd></div>` : ""}
      <div><dt>Незакоммиченные правки на сервере</dt>
        <dd>${current.dirty
          ? '<span class="warn-value">есть — обновление будет заблокировано</span>'
          : "нет"}</dd></div>
      <div><dt>Доступно обновлений</dt>
        <dd>${current.update_available == null
          ? "неизвестно — нажмите «Проверить обновления»"
          : current.update_available
            ? escapeHtml(current.available_components || "есть")
            : "нет, установлена последняя версия"}</dd></div>
      <div><dt>Последняя проверка</dt>
        <dd>${updates.payload.last_checked_at ? escapeHtml(localDate(updates.payload.last_checked_at)) : "не выполнялась"}</dd></div>
    </dl>`;

  const history = updates.payload.history || [];
  $("#update-history").innerHTML = history.length
    ? history.map((item) => `
      <tr>
        <td>${escapeHtml(localDate(item.started_at))}</td>
        <td>${escapeHtml(item.component)}</td>
        <td>${escapeHtml(item.from_version || "—")} → ${escapeHtml(item.to_version || "—")}</td>
        <td><span class="result ${escapeHtml(item.status)}">${escapeHtml(UPDATE_RESULTS[item.status] || item.status)}</span></td>
        <td>${item.rolled_back ? "да" : "нет"}</td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="muted">Обновлений ещё не было.</td></tr>';
}

const BACKUP_COLORS = {
  ready: "green", failed: "red", creating: "blue", restoring: "blue", deleted: "gray",
};

const UPDATE_RESULTS = {
  running: "идёт", success: "успешно", failure: "ошибка", rolled_back: "откачено",
};

async function createBackup() {
  const key = `backup-${crypto.randomUUID()}`;
  const { payload } = await request("/backups", {
    method: "POST",
    headers: { "Idempotency-Key": key },
  });
  toast("Создание backup началось");
  await pollOperation(payload.operation_id);
}

async function checkUpdates() {
  const { payload } = await request("/updates/check", { method: "POST" });
  toast("Проверка обновлений началась");
  await pollOperation(payload.operation_id);
}

function installUpdate() {
  askConfirm({
    title: "Установить обновление?",
    description: "Будет создан backup, сервисы могут быть временно недоступны. Ошибка запускает автоматический rollback.",
    expected: "UPDATE",
    action: async () => {
      const { payload } = await request("/updates/install", {
        method: "POST",
        headers: { "Idempotency-Key": `update-${crypto.randomUUID()}` },
        body: JSON.stringify({ confirm: "UPDATE" }),
      });
      toast("Обновление запущено. Панель может кратковременно отключиться.");
      pollOperation(payload.operation_id).catch(() => {
        toast("Соединение прервано во время обновления; панель переподключится автоматически.");
      });
    },
  });
}

function inputFor(setting) {
  if (setting.type === "boolean") {
    return `<select data-key="${escapeHtml(setting.key)}"><option value="true"${setting.value === true ? " selected" : ""}>Включено</option><option value="false"${setting.value === false ? " selected" : ""}>Выключено</option></select>`;
  }
  if (setting.key === "runtime.log_level") {
    return `<select data-key="${escapeHtml(setting.key)}">${["debug", "info", "warn", "error"].map((value) => `<option${setting.value === value ? " selected" : ""}>${value}</option>`).join("")}</select>`;
  }
  const type = setting.type === "integer" ? "number" : "text";
  return `<input data-key="${escapeHtml(setting.key)}" type="${type}" value="${escapeHtml(setting.value)}"${setting.min !== undefined ? ` min="${setting.min}"` : ""}${setting.max !== undefined ? ` max="${setting.max}"` : ""} required>`;
}

async function loadSettings() {
  const { payload, response } = await request("/settings");
  state.settings = payload.settings;
  state.etag = response.headers.get("ETag");
  state.settingProfiles = payload.profiles || [];
  renderSettingProfiles();

  const main = payload.settings.filter((item) => !item.advanced);
  const advanced = payload.settings.filter((item) => item.advanced);
  $("#settings-form").innerHTML = main.map(settingCard).join("");
  $("#settings-form-advanced").innerHTML = advanced.map(settingCard).join("");
  $("#advanced-count").textContent = advanced.length
    ? `${advanced.length} параметра тонкой настройки`
    : "";
  $("#toggle-advanced").hidden = advanced.length === 0;
}

/**
 * Предпросмотр политик хранения.
 *
 * Считается по требованию, а не при каждом открытии страницы: запрос
 * пересчитывает объёмы по всем классам, и делать это на фоне каждого
 * входа в настройки незачем.
 *
 * В ответе нет ни одной строки пользовательских данных — только классы,
 * сроки и счётчики.
 */
async function loadRetentionPreview() {
  const box = $("#retention-preview");
  box.textContent = "Считаем…";
  try {
    const { payload } = await request("/retention/preview");
    const rows = (payload.classes || []).map((item) => {
      const term = item.days === null ? "по решению пользователя" : `${item.days} дн.`;
      const note = item.held
        ? "удаление приостановлено задержкой"
        : item.note || "";
      return `<tr>
        <td>${escapeHtml(item.title)}</td>
        <td>${escapeHtml(term)}</td>
        <td>${item.eligible}</td>
        <td class="muted">${escapeHtml(note)}</td>
      </tr>`;
    }).join("");
    box.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Класс данных</th><th>Срок</th><th>Подпадает сейчас</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="block-caption">Уже созданные резервные копии продолжают хранить удалённое ещё ${payload.backupRotationDays} дней: мгновенное физическое удаление из них не обещается.</p>`;
  } catch (error) {
    box.textContent = `Не удалось получить предпросмотр: ${error.message}`;
  }
}

/**
 * Карточка параметра. Рекомендация стоит НАД полем ввода: администратор
 * читает её раньше, чем смотрит на текущее значение, и не гадает, что
 * туда положить.
 */
function settingCard(item) {
  const presets = item.presets?.length
    ? `<label class="preset-row">Готовое значение
        <select data-preset-for="${escapeHtml(item.key)}">
          <option value="">— выбрать —</option>
          ${item.presets.map((preset) => `<option value="${escapeHtml(JSON.stringify(preset.value))}"${JSON.stringify(preset.value) === JSON.stringify(item.value) ? " selected" : ""}>${escapeHtml(preset.title)}</option>`).join("")}
        </select>
      </label>`
    : "";
  return `
    <article class="setting-card">
      <div class="setting-head">
        <div><h3>${escapeHtml(item.title)}</h3><span class="technical">${escapeHtml(item.key)}</span></div>
        ${item.requires_restart ? '<span class="tag">нужен перезапуск</span>' : ""}
      </div>
      <p>${escapeHtml(item.description)}</p>
      ${item.recommended ? `<p class="recommended"><span>Рекомендуется</span>${escapeHtml(item.recommended)}</p>` : ""}
      ${presets}
      <label>Значение${inputFor(item)}</label>
      <div class="setting-actions">
        <span class="technical">Влияет: ${escapeHtml(item.affects.join(", "))}</span>
        <button class="reset" type="button" data-reset="${escapeHtml(item.key)}">По умолчанию</button>
      </div>
    </article>`;
}

function renderSettingProfiles() {
  const profiles = state.settingProfiles || [];
  $("#settings-profiles-card").hidden = profiles.length === 0;
  $("#settings-profiles").innerHTML = profiles.map((profile) => `
    <button class="profile-choice" type="button" data-profile="${escapeHtml(profile.code)}">
      <strong>${escapeHtml(profile.title)}</strong>
      <span>${escapeHtml(profile.description)}</span>
    </button>`).join("");
}

/** Подставляет значения набора в поля, не сохраняя их. */
function applySettingProfile(code) {
  const profile = (state.settingProfiles || []).find((item) => item.code === code);
  if (!profile) return;
  let filled = 0;
  for (const [key, value] of Object.entries(profile.values)) {
    const input = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!input) continue;
    input.value = typeof value === "boolean" ? String(value) : String(value);
    const preset = document.querySelector(`[data-preset-for="${CSS.escape(key)}"]`);
    if (preset) preset.value = JSON.stringify(value);
    input.closest(".setting-card")?.classList.add("is-touched");
    filled += 1;
  }
  document.querySelectorAll(".profile-choice").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.profile === code);
  });
  // Часть значений может лежать в свёрнутом блоке — сказать об этом,
  // иначе выглядит, будто набор применился не полностью.
  const hiddenBlock = $("#settings-form-advanced").hidden;
  toast(`Набор «${profile.title}» подставлен в ${filled} пол(я)${hiddenBlock ? ", часть — в свёрнутых настройках" : ""}. Нажмите «Сохранить».`);
}

async function saveSettings(restart = false) {
  if (!["owner", "admin"].includes(state.me.role)) {
    toast("Эта роль может только просматривать настройки", true);
    return;
  }
  const settings = {};
  document.querySelectorAll("[data-key]").forEach((input) => {
    const original = state.settings.find((item) => item.key === input.dataset.key);
    settings[input.dataset.key] = original.type === "boolean"
      ? input.value === "true"
      : original.type === "integer"
        ? Number(input.value)
        : input.value;
  });
  const { payload, response } = await request("/settings", {
    method: "PUT",
    headers: { "If-Match": state.etag },
    body: JSON.stringify({ settings }),
  });
  state.settings = payload.settings;
  state.etag = response.headers.get("ETag");
  toast("Настройки сохранены");
  await loadSettings();
  // Настройки уже сохранены. Перезапуск — отдельное последствие: он
  // рвёт живые соединения, поэтому спрашивается отдельно. Пароля здесь
  // нет: подтверждается последствие, а не личность.
  if (restart) {
    askConfirm({
      title: "Применить настройки перезапуском",
      description: "Agent Runtime будет перезапущен. Агенты, conversation и память сохранятся.",
      action: async () => await lifecycleService("restart", "agent-runtime"),
    });
  }
}

// =====================================================================
// Пользователи Евы
// =====================================================================

$("#create-backup").addEventListener("click", () => createBackup().catch(handleError));
$("#check-updates").addEventListener("click", () => checkUpdates().catch(handleError));
$("#reload-backups").addEventListener("click", () => loadOperations().catch(handleError));
$("#install-update").addEventListener("click", installUpdate);
$("#toggle-advanced").addEventListener("click", () => {
  const form = $("#settings-form-advanced");
  form.hidden = !form.hidden;
  $("#toggle-advanced").textContent = form.hidden
    ? "Показать остальные настройки"
    : "Скрыть остальные настройки";
});
$("#settings-profiles").addEventListener("click", (event) => {
  const button = event.target.closest("[data-profile]");
  if (button) applySettingProfile(button.dataset.profile);
});
// Пресет поля подставляет значение в сам инпут: сохраняется всегда то,
// что в поле, поэтому выпадающий список не может разойтись с ним.
document.addEventListener("change", (event) => {
  // Выбор с готовым набором значений: провайдер синтеза и распознавания.
  // Обработчик общий, потому что форма интеграции живёт и на странице
  // синтеза, и в модальном редакторе.
  if (event.target.matches("#tts-form select, #integration-form select")) {
    applyFieldPreset(event.target);
  }
  const preset = event.target.closest("[data-preset-for]");
  if (!preset || !preset.value) return;
  const input = document.querySelector(`[data-key="${CSS.escape(preset.dataset.presetFor)}"]`);
  if (!input) return;
  input.value = String(JSON.parse(preset.value));
  input.closest(".setting-card")?.classList.add("is-touched");
});
$("#save-settings").addEventListener("click", () => saveSettings(false).catch(handleError));
$("#save-restart").addEventListener("click", () => saveSettings(true).catch(handleError));
$("#settings-form").addEventListener("click", (event) => {
  const button = event.target.closest("[data-reset]");
  if (!button) return;
  const item = state.settings.find((setting) => setting.key === button.dataset.reset);
  const input = document.querySelector(`[data-key="${CSS.escape(item.key)}"]`);
  input.value = String(item.default);
});
