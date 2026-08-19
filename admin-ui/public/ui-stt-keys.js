/**
 * Ввод и замена ключей провайдера распознавания отдельным окном.
 */
// ---------------------------------------------------------------------
// Ввод ключа отдельным окном
// ---------------------------------------------------------------------
// Главный сценарий раздела: у преднастроенного провайдера всё уже
// заполнено, и остаётся вписать один ключ. Гонять оператора через
// полный редактор параметров ради этого незачем.
async function openSttKeyDialog(config) {
  if (!config) return;
  state.sttEditing = config;
  const isGoogleCloud = config.provider === "google";

  $("#stt-key-title").textContent = `Ключи — ${config.name}`;
  $("#stt-key-hint").textContent =
    "Ключи перебираются сверху вниз. Когда один упирается в лимит или "
    + "перестаёт работать, распознавание тут же продолжается следующим — "
    + "пользователь ничего не замечает. Значения не показываются обратно.";
  $("#stt-key-label").value = "";
  $("#stt-key-field").innerHTML = isGoogleCloud
    ? `<label class="field"><span>Service account JSON</span>
         <input type="file" id="stt-key-file" accept="application/json,.json">
         <small class="muted">Файл целиком уходит в Secret Store; в конфигурации
           останутся только project_id и маскированная почта.</small></label>`
    : `<label class="field"><span>API-ключ</span>
         <input type="password" id="stt-key-value" autocomplete="new-password"
                placeholder="Вставьте ключ">
         <small class="muted">${keyHint(config.provider)}</small></label>`;
  $("#stt-key-error").hidden = true;
  // Список первого ключа ещё нет — форма добавления раскрыта сразу,
  // чтобы не заставлять кликать по пустому месту.
  $("#stt-key-add").open = !(config.keys?.total > 0);
  $("#stt-key-dialog").showModal();
  await refreshSttKeys(config.id);
}

/**
 * Список ключей конфигурации.
 *
 * Значений здесь нет — только подписи, состояние и счётчики. Ошибка
 * загрузки не закрывает диалог: добавить ключ можно и не видя списка.
 */
async function refreshSttKeys(configId) {
  const host = $("#stt-key-list");
  host.innerHTML = `<p class="muted">Загружаю…</p>`;
  let keys = [];
  try {
    const { payload } = await request(`/stt/configs/${configId}/keys`);
    keys = payload.keys || [];
  } catch (error) {
    host.innerHTML = `<p class="integration-status error">${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</p>`;
    return;
  }
  state.sttKeys = keys;

  if (!keys.length) {
    host.innerHTML = `<p class="muted">Ключей пока нет. Пока их нет, распознавание
      этим провайдером не работает.</p>`;
    return;
  }

  host.innerHTML = keys.map((key, index) => {
    const [label, color] = STT_KEY_STATUS[key.status] || [key.status, "gray"];
    const cooldown = key.cooldown_until && new Date(key.cooldown_until) > new Date()
      ? ` до ${new Date(key.cooldown_until).toLocaleString("ru")}`
      : "";
    return `
      <article class="key-row${key.enabled ? "" : " muted"}" data-key-id="${key.id}">
        <span class="dot ${key.enabled ? color : "gray"}"></span>
        <div class="key-main">
          <strong>${escapeHtml(key.label)}</strong>
          <p class="muted">${index + 1}-й в очереди · ${key.enabled ? label + cooldown : "выключен"}
            · успешно ${key.success_count}, с ошибкой ${key.failure_count}</p>
          ${key.last_error_code
            ? `<p class="muted">Последняя ошибка: ${escapeHtml(key.last_error_code)}</p>` : ""}
        </div>
        <div class="key-actions">
          <button class="button ghost" data-key-action="toggle" data-key-id="${key.id}"
                  data-enabled="${key.enabled}">${key.enabled ? "Выключить" : "Включить"}</button>
          <button class="button ghost" data-key-action="remove" data-key-id="${key.id}">Удалить</button>
        </div>
      </article>`;
  }).join("");
}

const STT_KEY_STATUS = {
  active: ["работает", "green"],
  exhausted: ["лимит исчерпан", "yellow"],
  invalid: ["отвергнут провайдером", "red"],
};

/** Где взять ключ — вопрос, который возникает у каждого нового провайдера. */
function keyHint(provider) {
  return {
    deepgram: "console.deepgram.com → API Keys",
    google_ai_studio: "ai.google.dev → Get API key. Облачный проект и биллинг не нужны",
    openai: "platform.openai.com → API keys",
    openrouter: "openrouter.ai/keys",
  }[provider] ?? "";
}

async function saveSttKey() {
  const config = state.sttEditing;
  if (!config) return;

  const body = {};
  const label = $("#stt-key-label").value.trim();
  if (label) body.label = label;
  if (config.provider === "google") {
    const file = $("#stt-key-file")?.files?.[0];
    if (!file) throw new Error("Выберите файл service account JSON");
    if (file.size > 16 * 1024) throw new Error("Файл слишком велик — ожидается service account JSON");
    body.credentials_json = await file.text();
  } else {
    const value = $("#stt-key-value").value.trim();
    if (!value) throw new Error("Введите ключ");
    body.api_key = value;
  }

  sttAction(async () => {
      await request(`/stt/configs/${config.id}/keys`, {
        method: "POST", body: JSON.stringify(body),
      });
      // Диалог остаётся открытым: ключей обычно добавляют несколько
      // подряд, и закрывать его после каждого — лишний клик.
      if ($("#stt-key-value")) $("#stt-key-value").value = "";
      if ($("#stt-key-file")) $("#stt-key-file").value = "";
      $("#stt-key-label").value = "";
      $("#stt-key-error").hidden = true;
      toast("Ключ добавлен");
      await refreshSttKeys(config.id);
      await loadStt();
    });
}

/** Включение, выключение и удаление отдельного ключа. */
async function sttKeyAction(action, keyId) {
  const config = state.sttEditing;
  if (!config) return;
  const key = (state.sttKeys || []).find((item) => item.id === keyId);

  if (action === "toggle") {
    const enable = !key?.enabled;
    await request(`/stt/configs/${config.id}/keys/${keyId}`, {
      method: "PATCH", body: JSON.stringify({ enabled: enable }),
    });
    toast(enable ? "Ключ снова в очереди" : "Ключ выключен");
  } else if (action === "remove") {
    askConfirm({
      title: `Удалить ключ «${key?.label ?? ""}»?`,
      description: "Значение будет стёрто из Secret Store и восстановить его будет нечем.",
      action: async () => {
        await request(`/stt/configs/${config.id}/keys/${keyId}`, { method: "DELETE" });
        toast("Ключ удалён");
        await refreshSttKeys(config.id);
        await loadStt();
      },
    });
    return;
  } else {
    return;
  }
  await refreshSttKeys(config.id);
  await loadStt();
}

$("#stt-key-save")?.addEventListener("click", () => {
  saveSttKey().catch((error) => {
    const host = $("#stt-key-error");
    host.hidden = false;
    host.textContent = error instanceof Error ? error.message : String(error);
  });
});

$("#stt-key-list")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-key-action]");
  if (!button) return;
  // Изменение ключей — та же операция с секретами, что и добавление,
  // поэтому и подтверждение то же.
  sttAction(() => sttKeyAction(button.dataset.keyAction, button.dataset.keyId));
});
