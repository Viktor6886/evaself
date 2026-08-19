/**
 * Разделы «Сервисы и интеграции» и «Синтез речи».
 *
 * Синтез живёт здесь же: его значения читаются тем же маршрутом
 * интеграций, и второй источник тех же настроек означал бы расхождение.
 */
/**
 * Раздел синтеза речи.
 *
 * Значения читаются тем же маршрутом интеграций, что и в «Сервисах»:
 * второй источник тех же настроек означал бы расхождение между двумя
 * экранами. Раздел отвечает за место в меню и сводку, редактирование —
 * общий редактор интеграции.
 */
async function loadTts() {
  const { payload } = await request("/integrations/tts/config");
  state.integration = payload;
  const note = $("#tts-note");
  const parts = [];
  if (payload.note) parts.push(payload.note);
  if (payload.restart_required) {
    parts.push(`Изменения вступят в силу после перезапуска «${payload.restart_required}».`);
  }
  note.textContent = parts.join(" ");
  note.hidden = parts.length === 0;

  $("#tts-form").innerHTML = payload.editable
    ? payload.fields.map(integrationField).join("")
    : '<p class="muted">Настройки синтеза недоступны для этой роли.</p>';
  $("#tts-save").hidden = !payload.editable;

  const check = payload.last_check;
  const status = $("#tts-status");
  status.className = `integration-status color-${check ? check.color : "gray"}`;
  status.textContent = check
    ? `Последняя проверка: ${FIELD_STATE_LABELS[check.color] || check.state}`
      + `${check.checked_at ? ` · ${localDate(check.checked_at)}` : ""}`
      + `${check.message ? ` · ${check.message}` : ""}`
    : "Проверок ещё не было";
  const box = $("#tts-test-result");
  box.hidden = true;
  box.textContent = "";
}

async function loadServicesAndIntegrations() {
  const [services, integrations] = await Promise.all([
    request("/services"),
    request("/integrations"),
  ]);
  $("#services-list").innerHTML = services.payload.services
    .map((item) => statusCard(item))
    .join("");
  $("#integrations-list").innerHTML = integrations.payload.integrations
    .map((item) => statusCard(item))
    .join("");
  applyLettaLink(services.payload.services);
}

/**
 * Ссылка «Открыть Letta» в боковом меню. Раньше в разметке стоял домен
 * одной конкретной установки, поэтому у всех остальных кнопка вела в
 * никуда. Берём адрес оттуда же, откуда его берут карточки сервисов.
 */
function applyLettaLink(services) {
  const link = $("#letta-link");
  if (!link) return;
  const letta = services.find((item) => item.id === "letta-ui");
  if (letta?.public_url) {
    link.href = letta.public_url;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

/* ---------------------------------------------------------------------
 * Редактор интеграции (2.3)
 * ------------------------------------------------------------------- */
const FIELD_STATE_LABELS = {
  green: "работает", yellow: "требует внимания", red: "ошибка",
  blue: "проверяется", gray: "выключено",
};

async function openIntegration(id) {
  const { payload } = await request(`/integrations/${encodeURIComponent(id)}/config`);
  state.integration = payload;
  $("#integration-title").textContent = payload.title;
  $("#integration-purpose").textContent = payload.purpose;

  const check = payload.last_check;
  const statusNode = $("#integration-status");
  statusNode.className = `integration-status color-${check ? check.color : "gray"}`;
  statusNode.textContent = check
    ? `Последняя проверка: ${FIELD_STATE_LABELS[check.color] || check.state}` +
      `${check.checked_at ? ` · ${localDate(check.checked_at)}` : ""}` +
      `${check.message ? ` · ${check.message}` : ""}`
    : "Проверок ещё не было";

  const note = $("#integration-note");
  const parts = [];
  if (payload.note) parts.push(payload.note);
  if (payload.restart_required) {
    // Значения читают контейнеры при старте — об этом надо сказать
    // прямо, иначе администратор ждёт мгновенного эффекта.
    parts.push(`Изменения вступят в силу после перезапуска «${payload.restart_required}».`);
  }
  note.textContent = parts.join(" ");
  note.hidden = parts.length === 0;

  $("#integration-form").innerHTML = payload.editable
    ? payload.fields.map(integrationField).join("")
    : '<p class="muted">У этой интеграции нет настраиваемых полей: она работает на внутренних значениях установки.</p>';
  $("#integration-save").hidden = !payload.editable;
  const testBox = $("#integration-test-result");
  testBox.hidden = true;
  testBox.textContent = "";
  $("#integration-check").textContent = ["asr", "tts"].includes(id)
    ? (id === "tts" ? "Проверить синтез" : "Проверить распознавание")
    : "Проверить соединение";
  $("#integration-dialog").showModal();
}

function integrationField(field) {
  const mark = field.configured
    ? '<span class="field-ok">настроен</span>'
    : (field.required ? '<span class="field-missing">не задан</span>' : "");
  if (field.kind === "select") {
    // Набор значений варианта едет в data-атрибуте: он приходит вместе с
    // формой, и панель не хранит собственную копию таблицы «провайдер →
    // его адрес и модель», которая разошлась бы с сервером.
    const options = (field.options || [])
      .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === field.value ? " selected" : ""}${
        option.preset ? ` data-preset="${escapeHtml(JSON.stringify(option.preset))}"` : ""
      }>${escapeHtml(option.title)}</option>`)
      .join("");
    return `<label><span>${escapeHtml(field.title)} ${mark}</span>
      <select name="${escapeHtml(field.name)}"><option value="">—</option>${options}</select>
      <small>${escapeHtml(field.hint)}</small></label>`;
  }
  if (field.kind === "textarea") {
    // Описание манеры речи — абзац, а не строка: в однострочном поле
    // его не прочитать и не отредактировать.
    return `<label><span>${escapeHtml(field.title)} ${mark}</span>
      <textarea name="${escapeHtml(field.name)}" rows="4"
        placeholder="${escapeHtml(field.placeholder || "")}">${escapeHtml(field.value || "")}</textarea>
      <small>${escapeHtml(field.hint)}</small></label>`;
  }
  // У секрета поле всегда пустое: текущее значение не показывается, а
  // пустое поле означает «оставить как есть».
  const type = field.kind === "secret" ? "password" : "text";
  const value = field.kind === "secret" ? "" : (field.value || "");
  const placeholder = field.kind === "secret"
    ? (field.configured ? "оставьте пустым, чтобы не менять" : "введите значение")
    : (field.placeholder || "");
  return `<label><span>${escapeHtml(field.title)} ${mark}</span>
    <input type="${type}" name="${escapeHtml(field.name)}" value="${escapeHtml(value)}"
      placeholder="${escapeHtml(placeholder)}"${field.kind === "secret" ? ' autocomplete="new-password"' : ""}>
    <small>${escapeHtml(field.hint)}</small></label>`;
}

/**
 * Проверка интеграции у провайдера.
 *
 * Одна на модальный редактор и на раздел синтеза: различаются только
 * узлы, куда писать. Две копии разбора ответа разъехались бы на первом
 * же новом поле в ответе `/test`.
 */
async function runIntegrationTest(id, nodes = {}) {
  const button = $(nodes.button ?? "#integration-check");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = id === "tts" ? "Синтезирую…" : "Распознаю…";
  const box = $(nodes.result ?? "#integration-test-result");
  box.hidden = false;
  box.className = "integration-test";
  box.textContent = "Идёт проверка у провайдера, это занимает несколько секунд…";
  try {
    const { payload } = await request(`/integrations/${encodeURIComponent(id)}/test`, {
      method: "POST",
    });
    box.className = `integration-test ${payload.ok ? "is-ok" : "is-fail"}`;
    box.textContent = payload.ok
      ? [
        payload.message,
        payload.latency_ms != null ? `${payload.latency_ms} мс` : "",
        payload.model ? `модель ${payload.model}` : "",
        payload.voice ? `голос ${payload.voice}` : "",
        // Пустая расшифровка тестового тона — нормальный результат, и об
        // этом надо сказать, иначе выглядит как поломка.
        id === "asr" ? `расшифровка: ${payload.transcript ? `«${payload.transcript}»` : "пусто, в тестовом сигнале нет речи"}` : "",
      ].filter(Boolean).join(" · ")
      : `Не прошло: ${payload.message || "провайдер не ответил"}`;
  } catch (error) {
    box.className = "integration-test is-fail";
    box.textContent = `Не прошло: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/**
 * Выбор провайдера подставляет остальные поля.
 *
 * Подсказка обещала это с самого начала, а подставлял значения человек:
 * набор существовал только в коде сервиса и никуда не применялся. Из-за
 * этого настройка синтеза собиралась вручную — включая формат ответа, на
 * котором она и ломалась.
 */
function applyFieldPreset(select) {
  const option = select.selectedOptions[0];
  const preset = option?.dataset.preset;
  if (!preset) return;
  const form = select.closest("form");
  if (!form) return;
  for (const [name, value] of Object.entries(JSON.parse(preset))) {
    const field = form.elements[name];
    // Заполняется только то, что в форме действительно есть: набор
    // общий для всех интеграций, а поля у них разные.
    if (field && field !== select) field.value = value;
  }
}

async function saveIntegration() {
  const id = state.integration?.id;
  if (!id) return;
  const form = $("#integration-form");
  const body = {};
  for (const [key, value] of new FormData(form).entries()) body[key] = String(value);
  await applyIntegrationConfig(id, body, async () => {
    await openIntegration(id);
    await loadServicesAndIntegrations();
  });
}

/** Интеграции речи. Тот же список, что у сервера. */
const MEDIA_INTEGRATIONS = new Set(["asr", "tts"]);

/**
 * Запись настроек интеграции.
 *
 * Общая и для модального редактора, и для раздела синтеза: два пути
 * записи одних и тех же значений разошлись бы на первой правке — в
 * подтверждении sudo, в разборе ответа или в тексте уведомления.
 */
async function applyIntegrationConfig(id, body, afterSave) {
  // У речи пароль не спрашивается — решение владельца: ключи ASR и TTS
  // вводят и проверяют десяток раз за настройку. У остальных интеграций
  // тем же запросом меняется Telegram bot_token или ключ Crawl4AI,
  // поэтому подтверждение остаётся — и его требует сервер, а не только
  // эта форма.
  if (!MEDIA_INTEGRATIONS.has(id)) {
    askSudo({
      scope: "secrets:write",
      title: "Сохранить настройки интеграции",
      description: "Запрос меняет учётные данные интеграции. Подтвердите паролем.",
      action: () => sendIntegrationConfig(id, body, afterSave),
    });
    return;
  }
  await sendIntegrationConfig(id, body, afterSave);
}

async function sendIntegrationConfig(id, body, afterSave) {
  const { payload } = await request(`/integrations/${encodeURIComponent(id)}/config`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  // Для ASR/TTS значения применяются на лету; если не доехали — сказать
  // прямо, а не оставить администратора в уверенности, что всё работает.
  if (payload.applied_live === false && payload.apply_error) {
    toast(`Сохранено, но сервис не принял значения: ${payload.apply_error}`, true);
  } else if (payload.applied_live) {
    toast("Настройки сохранены и применены без перезапуска");
  } else {
    toast("Настройки сохранены");
  }
  await afterSave();
}


async function startCheck(targetType, id) {
  const plural = targetType === "service" ? "services" : "integrations";
  const { payload } = await request(`/${plural}/${encodeURIComponent(id)}/check`, {
    method: "POST",
  });
  toast("Проверка поставлена в очередь");
  await pollCheck(payload.check_id);
}

async function pollCheck(id) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { payload } = await request(`/checks/${encodeURIComponent(id)}`);
    if (["success", "failure"].includes(payload.check.status)) {
      toast(
        payload.check.status === "success"
          ? "Проверка завершена успешно"
          : payload.check.error_message_short || "Проверка завершилась ошибкой",
        payload.check.status !== "success",
      );
      await loadServicesAndIntegrations();
      return;
    }
  }
  toast("Проверка продолжается в фоне");
}

const LIFECYCLE_LABELS = {
  start: { verb: "Запуск", title: "Запустить сервис",
    description: "Контейнер будет запущен. Данные и volumes не затрагиваются." },
  stop: { verb: "Остановка", title: "Остановить сервис",
    description: "Контейнер будет остановлен штатно. Данные сохраняются; функции, зависящие от сервиса, станут недоступны." },
  restart: { verb: "Перезапуск", title: "Перезапустить сервис",
    description: "Контейнер будет штатно перезапущен; его persistent volumes не удаляются." },
};

async function lifecycleService(action, id) {
  const { payload } = await request(`/services/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
  });
  toast(`${LIFECYCLE_LABELS[action].verb} принят. Состояние обновится автоматически.`);
  await pollOperation(payload.operation_id);
}

async function pollOperation(id) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const { payload } = await request(`/operations/${encodeURIComponent(id)}`);
    if (["success", "failure", "rolled_back"].includes(payload.operation.status)) {
      const ok = payload.operation.status === "success";
      toast(
        ok ? "Операция успешно завершена" : payload.operation.error_message || "Операция не выполнена",
        !ok,
      );
      LOADERS[state.page]?.().catch(handleError);
      return;
    }
  }
  toast("Операция продолжается в фоне");
}

$("#reload-services").addEventListener("click", () => loadServicesAndIntegrations().catch(handleError));
document.querySelector(".tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-service-tab]");
  if (!button) return;
  document.querySelectorAll("[data-service-tab]").forEach((item) => item.classList.toggle("active", item === button));
  $("#services-list").hidden = button.dataset.serviceTab !== "services";
  $("#integrations-list").hidden = button.dataset.serviceTab !== "integrations";
});
$("#page-services").addEventListener("click", (event) => {
  const check = event.target.closest("[data-check]");
  if (check) {
    startCheck(check.dataset.targetType, check.dataset.check).catch(handleError);
    return;
  }
  const configure = event.target.closest("[data-configure]");
  if (configure) {
    openIntegration(configure.dataset.configure).catch(handleError);
    return;
  }
  const lifecycle = event.target.closest("[data-lifecycle]");
  if (lifecycle) {
    const action = lifecycle.dataset.lifecycle;
    const labels = LIFECYCLE_LABELS[action];
    if (!labels) return;
    askSudo({
      scope: "services:restart",
      title: labels.title,
      description: labels.description,
      action: async () => await lifecycleService(action, lifecycle.dataset.service),
    });
  }
});
// Раздел синтеза редактируется на месте: форма и кнопки живут на самой
// странице, а не в модальном окне сервисов.
$("#tts-save")?.addEventListener("click", () => {
  const body = {};
  for (const [key, value] of new FormData($("#tts-form")).entries()) body[key] = String(value);
  applyIntegrationConfig("tts", body, async () => { await loadTts(); }).catch(handleError);
});
$("#tts-test")?.addEventListener("click", () => runIntegrationTest("tts", {
  button: "#tts-test", result: "#tts-test-result",
}).catch(handleError));
$("#close-integration").addEventListener("click", () => $("#integration-dialog").close());
$("#integration-dialog").addEventListener("click", (event) => {
  if (event.target === $("#integration-dialog")) $("#integration-dialog").close();
});
$("#integration-save").addEventListener("click", () => saveIntegration().catch(handleError));
$("#integration-check").addEventListener("click", () => {
  const id = state.integration?.id;
  if (!id) return;
  // У ASR и TTS есть настоящая проверка тракта; у остальных — только
  // плановая проверка доступности, которую ставит health-worker.
  if (["asr", "tts"].includes(id)) runIntegrationTest(id).catch(handleError);
  else startCheck("integration", id).catch(handleError);
});
