/**
 * Раздел «Персона и промпт»: правка настоящих production-источников
 * личности Евы.
 *
 * Второй копии конфигурации здесь нет. Значение по умолчанию — файлы
 * репозитория (`library/persona/eva.md` и
 * `library/system/letta_local_memfs.md`), правка живёт версией в реестре
 * артефактов, а действует ровно одна опубликованная версия.
 *
 * Состояния «сохранено, но не применено» в панели нет намеренно: оно
 * выглядит успешным и работает по-старому. Сохранение сразу применяется,
 * и ответ сервера рассказывает, что именно применилось: сколько агентов
 * приведено к версии, сколько отстало и почему.
 */
const PERSONA_TITLES = {
  persona: "Персона",
  system_prompt: "Системный промпт",
};

const PERSONA_CAPTIONS = {
  persona: "Текст memory block «persona». Его получает новый агент и к нему приводятся существующие.",
  system_prompt: "Raw system prompt агента Letta. Он общий для всей установки: у отдельных агентов своего промпта нет.",
};

const PERSONA_SYNC_LABELS = {
  ok: "все агенты на текущей версии",
  degraded: "часть агентов отстала",
  unsupported: "runtime не поддерживает синхронизацию",
  failed: "синхронизация не выполнена",
  never: "синхронизация ещё не запускалась",
};

function personaDocument() {
  return state.persona?.documents?.[state.personaTab] ?? null;
}

async function loadPersona() {
  const { payload } = await request("/panel/persona");
  state.persona = payload;
  renderPersonaApplyState();
  renderPersonaEditor();
  await loadPersonaHistory();
}

function renderPersonaApplyState() {
  const applyState = state.persona?.state ?? {};
  const cells = [
    ["Состояние", PERSONA_SYNC_LABELS[applyState.status] || applyState.status || "—"],
    ["Версия набора", applyState.version || "—"],
    ["Последний проход", applyState.lastRunAt ? localDate(applyState.lastRunAt) : "—"],
    ["Обновлено", String(applyState.updated ?? 0)],
    ["Уже на версии", String(applyState.upToDate ?? 0)],
    ["Отстало", String(applyState.staleAgents ?? applyState.failed ?? 0)],
  ];
  $("#persona-apply-body").innerHTML = `<div class="host-bar">${cells
    .map(([label, value]) => `
      <div class="host-cell"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("")}</div>`;
}

function renderPersonaEditor() {
  const document_ = personaDocument();
  $("#persona-editor-title").textContent = PERSONA_TITLES[state.personaTab];
  $("#persona-editor-caption").textContent = PERSONA_CAPTIONS[state.personaTab];
  document.querySelectorAll("[data-persona-tab]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.personaTab === state.personaTab);
  });

  if (!document_) {
    $("#persona-facts").innerHTML = "";
    $("#persona-text").value = "";
    $("#persona-hint").textContent = "Текст недоступен: Agent Runtime не ответил.";
    return;
  }

  const facts = [
    ["Источник", document_.origin === "registry" ? `версия ${document_.version}` : "файл репозитория"],
    ["Файл-умолчание", document_.defaultPath],
    ["Совпадает с файлом", document_.matchesDefault ? "да" : "нет"],
    ["Размер", bytes(document_.bytes)],
    ["Отпечаток", document_.checksum || "—"],
    ["Опубликовано", document_.publishedAt ? localDate(document_.publishedAt) : "—"],
  ];
  $("#persona-facts").innerHTML = facts
    .map(([label, value]) => `<span>${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong></span>`)
    .join("");
  $("#persona-text").value = document_.text ?? "";

  const canWrite = ["owner", "admin"].includes(state.me.role);
  $("#persona-text").readOnly = !canWrite;
  $("#persona-save").disabled = !canWrite;
  $("#persona-restore").disabled = !canWrite || document_.matchesDefault;
  $("#persona-rollback").disabled = !canWrite || !document_.rollbackAvailable;
  $("#persona-hint").textContent = canWrite
    ? "Сохранение применяется сразу: новый агент создаётся с новым текстом, существующие приводятся к нему тем же PersonaSync."
    : "Для правки нужна роль owner или admin.";
}

async function loadPersonaHistory() {
  const { payload } = await request(`/panel/persona/${state.personaTab}/history`);
  const history = payload.history ?? [];
  $("#persona-history-body").innerHTML = history.length
    ? history.map((row) => `
      <tr>
        <td>${escapeHtml(row.version)}${row.active ? " <span class=\"status-pill\">действует</span>" : ""}</td>
        <td>${escapeHtml(localDate(row.publishedAt))}</td>
        <td>${row.retiredAt ? escapeHtml(localDate(row.retiredAt)) : "—"}</td>
        <td>${escapeHtml(row.reason || "—")}</td>
        <td class="technical">${escapeHtml(row.checksum)}</td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="muted">Правок не было: действует текст файла.</td></tr>';
}

/** Что именно применилось — одним сообщением, без пересказа. */
function reportApply(payload) {
  const sync = payload.sync;
  if (payload.sync_error) {
    toast(`Текст сохранён, но синхронизация не выполнена (${payload.sync_error}). Нажмите «Синхронизировать».`, true);
    return;
  }
  if (!sync) {
    toast("Текст сохранён");
    return;
  }
  const failed = Number(sync.failed ?? 0);
  toast(
    failed
      ? `Применено: обновлено ${sync.updated}, отстало ${failed}`
      : `Применено: обновлено ${sync.updated}, уже на версии ${sync.up_to_date}`,
    failed > 0,
  );
}

function savePersona() {
  const source = state.personaTab;
  const text = $("#persona-text").value;
  if (!text.trim()) {
    toast("Текст пуст", true);
    return;
  }
  askConfirm({
    title: `Сохранить и применить: ${PERSONA_TITLES[source].toLowerCase()}`,
    description: "Изменится то, чем Ева говорит с людьми. Новый текст получат и новые агенты, и существующие.",
    expected: source,
    action: () => new Promise((resolve, reject) => {
      askSudo({
        scope: "settings:write",
        title: "Применение канонического текста",
        description: "Повторите пароль: изменение применяется сразу ко всем агентам.",
        action: async () => {
          try {
            const { payload } = await request(`/panel/persona/${source}`, {
              method: "PUT",
              body: JSON.stringify({
                text,
                reason: `правка из панели: ${PERSONA_TITLES[source]}`,
                confirm: source,
              }),
            });
            reportApply(payload);
            await loadPersona();
            resolve();
          } catch (error) {
            reject(error);
            throw error;
          }
        },
      });
    }),
  });
}

function personaAction(kind) {
  const source = state.personaTab;
  const titles = {
    rollback: "Откатить версию",
    "restore-default": "Вернуть текст файла",
  };
  askSudo({
    scope: "settings:write",
    title: titles[kind],
    description: kind === "rollback"
      ? "Вернётся версия, действовавшая до текущей. История не переписывается: откат — ещё одна публикация."
      : "Действующим станет текст файла репозитория, каким бы ни был путь правок до него.",
    action: async () => {
      const { payload } = await request(`/panel/persona/${source}/${kind}`, {
        method: "POST",
        body: JSON.stringify({ reason: `${titles[kind]} из панели` }),
      });
      reportApply(payload);
      await loadPersona();
    },
  });
}

async function syncPersona() {
  const { payload } = await request("/panel/persona/sync", { method: "POST" });
  reportApply(payload);
  await loadPersona();
}

/**
 * Полноэкранная правка.
 *
 * Персона — тридцать шесть килобайт markdown, системный промпт — почти
 * пятьдесят. В поле на четверть экрана телефона такой текст правят,
 * прокручивая страницу вокруг поля: кнопка «Сохранить» уезжает, место
 * правки теряется. В развёрнутом виде поле занимает экран целиком, а
 * действия прибиты к нижнему краю.
 *
 * Выход — той же кнопкой и Escape: одного способа мало, когда режим
 * закрывает собой всё остальное.
 */
function setPersonaFullscreen(on) {
  const editor = $("#persona-editor");
  editor.classList.toggle("is-fullscreen", on);
  document.body.classList.toggle("editor-open", on);
  $("#persona-expand").textContent = on ? "Свернуть" : "На весь экран";
  $("#persona-expand").setAttribute("aria-expanded", String(on));
  if (on) $("#persona-text").focus();
}

$("#persona-expand").addEventListener("click", () => {
  setPersonaFullscreen(!$("#persona-editor").classList.contains("is-fullscreen"));
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#persona-editor")?.classList.contains("is-fullscreen")) {
    setPersonaFullscreen(false);
  }
});
// Переход в другой раздел не оставляет за собой развёрнутый редактор:
// иначе он накрывал бы новую страницу, которую никто не открывал.
$("#nav").addEventListener("click", () => setPersonaFullscreen(false));

$("#reload-persona").addEventListener("click", () => loadPersona().catch(handleError));
$("#persona-sync").addEventListener("click", () => syncPersona().catch(handleError));
$("#persona-save").addEventListener("click", () => savePersona());
$("#persona-rollback").addEventListener("click", () => personaAction("rollback"));
$("#persona-restore").addEventListener("click", () => personaAction("restore-default"));
$("#persona-reset").addEventListener("click", () => {
  $("#persona-text").value = personaDocument()?.text ?? "";
  toast("Правка отменена");
});
document.querySelectorAll("[data-persona-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.personaTab = tab.dataset.personaTab;
    renderPersonaEditor();
    loadPersonaHistory().catch(handleError);
  });
});
