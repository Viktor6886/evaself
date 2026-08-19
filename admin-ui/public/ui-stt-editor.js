/**
 * Редактор конфигурации распознавания речи, запись голоса и проверка
 * тракта.
 */
// ---------------------------------------------------------------------
// редактор
// ---------------------------------------------------------------------
function sttField(spec, value, capabilities) {
  // Поле, которого адаптер не поддерживает, не показывается вовсе —
  // предлагать настройку, которую провайдер отвергнет, хуже, чем не
  // предлагать ничего.
  if (spec.requires_capability && !capabilities[spec.requires_capability]) return "";
  const name = spec.name;
  const hint = spec.hint ? `<small class="muted">${escapeHtml(spec.hint)}</small>` : "";
  const current = value ?? spec.default ?? "";

  if (spec.kind === "boolean") {
    return `<label class="switch"><input type="checkbox" data-stt-field="${name}" ${current ? "checked" : ""}>
      <span>${escapeHtml(spec.label)}</span></label>${hint}`;
  }
  if (spec.kind === "select") {
    const options = (spec.options || [])
      .map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === String(current) ? "selected" : ""}>${escapeHtml(option.label)}</option>`)
      .join("");
    return `<label class="field"><span>${escapeHtml(spec.label)}</span>
      <select data-stt-field="${name}">${options}</select>${hint}</label>`;
  }
  if (spec.kind === "multiselect") {
    const selected = Array.isArray(current) ? current : [];
    return `<fieldset class="field"><legend>${escapeHtml(spec.label)}</legend>${
      (spec.options || []).map((option) => `<label class="switch">
        <input type="checkbox" data-stt-multi="${name}" value="${escapeHtml(option.value)}" ${selected.includes(option.value) ? "checked" : ""}>
        <span>${escapeHtml(option.label)}</span></label>`).join("")}${hint}</fieldset>`;
  }
  if (spec.kind === "string_list") {
    const text = Array.isArray(current) ? current.join(", ") : String(current);
    return `<label class="field"><span>${escapeHtml(spec.label)}</span>
      <input type="text" data-stt-field="${name}" data-list="1" value="${escapeHtml(text)}"
        placeholder="через запятую">${hint}</label>`;
  }
  if (spec.kind === "json") {
    const text = typeof current === "object" ? JSON.stringify(current, null, 2) : String(current || "");
    return `<label class="field"><span>${escapeHtml(spec.label)}</span>
      <textarea data-stt-field="${name}" data-json="1" rows="4">${escapeHtml(text)}</textarea>${hint}</label>`;
  }
  const type = spec.kind === "number" ? "number" : "text";
  const bounds = `${spec.minimum !== undefined ? ` min="${spec.minimum}"` : ""}${spec.maximum !== undefined ? ` max="${spec.maximum}"` : ""}`;
  return `<label class="field"><span>${escapeHtml(spec.label)}</span>
    <input type="${type}" data-stt-field="${name}"${bounds} value="${escapeHtml(String(current))}"
      placeholder="${escapeHtml(spec.placeholder || "")}">${hint}</label>`;
}

function openSttEditor(config) {
  state.sttEditing = config || null;
  const providers = state.sttSchemas || [];
  const provider = config?.provider || providers[0]?.provider;
  const schema = sttSchema(provider);
  if (!schema) return toast("Схемы провайдеров недоступны — media-service не отвечает", true);

  $("#stt-dialog-title").textContent = config ? config.name : "Новая конфигурация";
  $("#stt-dialog-hint").textContent = `${schema.summary} Параметры сверены ${schema.verified_on}.`;
  $("#stt-form-error").hidden = true;
  renderSttForm(schema, config);
  $("#stt-dialog").showModal();
}

function renderSttForm(schema, config) {
  const caps = schema.capabilities || {};
  const params = config?.public_config || {};
  const mode = config?.mode || "batch";
  const providerSelect = (state.sttSchemas || [])
    .map((item) => `<option value="${item.provider}" ${item.provider === schema.provider ? "selected" : ""}>${escapeHtml(item.label)}</option>`)
    .join("");

  // Модель: список проверенных пресетов плюс «Указать вручную».
  // Неизвестная модель не должна требовать правки frontend-кода.
  const presets = (schema.model_presets || [])
    .map((preset) => `<option value="${escapeHtml(preset.value)}" ${preset.value === config?.model ? "selected" : ""}>${escapeHtml(preset.label)}${preset.hint ? ` — ${escapeHtml(preset.hint)}` : ""}</option>`)
    .join("");
  const custom = config?.model && !(schema.model_presets || []).some((preset) => preset.value === config.model);

  const baseUrl = config?.base_url
    || (mode === "streaming" && schema.default_streaming_base_url) || schema.default_base_url;

  const bySection = new Map(STT_SECTIONS.map(([key]) => [key, []]));
  for (const spec of schema.fields || []) {
    if (spec.only_mode && spec.only_mode !== mode) continue;
    const rendered = sttField(spec, params[spec.name], caps);
    if (rendered) bySection.get(spec.section || "advanced")?.push(rendered);
  }

  const secretBlock = schema.provider === "google"
    ? `<label class="field"><span>Service account JSON</span>
         <input type="file" id="stt-credentials" accept="application/json,.json">
         <small class="muted">Файл загружается один раз и целиком уходит в Secret Store.
           В конфигурации остаются только project_id и маскированная почта.</small></label>
       <p class="muted">${config?.secret?.configured ? "Учётные данные настроены." : "Учётные данные не заданы."}</p>`
    : `<label class="field"><span>API-ключ</span>
         <input type="password" id="stt-api-key" autocomplete="new-password" placeholder="${
           config?.secret?.configured ? "Настроен — оставьте пустым, чтобы сохранить" : "Введите ключ"}">
         <small class="muted">Показывается только признак «настроен». Просмотреть сохранённый ключ нельзя.</small></label>`;

  $("#stt-form").innerHTML = `
    <fieldset class="field"><legend>Основные настройки</legend>
      <label class="field"><span>Название</span>
        <input type="text" id="stt-name" value="${escapeHtml(config?.name || "")}" maxlength="120"></label>
      <label class="field"><span>Провайдер</span>
        <select id="stt-provider" ${config ? "disabled" : ""}>${providerSelect}</select>
        ${config ? '<small class="muted">Провайдера существующей конфигурации менять нельзя — параметры несовместимы.</small>' : ""}</label>
      <label class="field"><span>Режим</span>
        <select id="stt-mode">
          <option value="batch" ${mode === "batch" ? "selected" : ""}>batch — запись целиком</option>
          ${caps.streaming ? `<option value="streaming" ${mode === "streaming" ? "selected" : ""}>streaming — поток</option>` : ""}
        </select>${caps.streaming ? "" : '<small class="muted">Провайдер не поддерживает потоковое распознавание.</small>'}</label>
      <label class="field"><span>Base URL</span>
        <input type="text" id="stt-base-url" value="${escapeHtml(baseUrl)}"></label>
      <label class="switch"><input type="checkbox" id="stt-allow-private">
        <span>Разрешить адрес во внутренней сети (self-hosted)</span></label>
      ${bySection.get("basic").join("")}
    </fieldset>

    <fieldset class="field"><legend>Модель и язык</legend>
      <label class="field"><span>Модель</span>
        <select id="stt-model-preset">${presets}<option value="__custom__" ${custom ? "selected" : ""}>Указать вручную…</option></select></label>
      <label class="field" id="stt-model-custom-wrap" ${custom ? "" : "hidden"}><span>Своя модель</span>
        <input type="text" id="stt-model-custom" value="${escapeHtml(custom ? config.model : "")}">
        <small class="muted">Произвольное имя допустимо, но работоспособность подтверждает только кнопка «Проверить».</small></label>
      ${bySection.get("model").join("")}
    </fieldset>

    ${["formatting", "features", "advanced"].map((key) => {
      const items = bySection.get(key);
      if (!items.length) return "";
      const title = STT_SECTIONS.find(([code]) => code === key)[1];
      return `<fieldset class="field"><legend>${title}</legend>${items.join("")}</fieldset>`;
    }).join("")}

    <fieldset class="field"><legend>Секрет</legend>${secretBlock}</fieldset>`;
}

function collectSttForm() {
  const params = {};
  for (const input of document.querySelectorAll("#stt-form [data-stt-field]")) {
    const name = input.dataset.sttField;
    if (input.type === "checkbox") { params[name] = input.checked; continue; }
    const raw = input.value.trim();
    if (!raw) continue;
    if (input.dataset.list) {
      params[name] = raw.split(",").map((item) => item.trim()).filter(Boolean);
    } else if (input.dataset.json) {
      try { params[name] = JSON.parse(raw); }
      catch { throw new Error(`Поле «${name}» не разбирается как JSON`); }
    } else if (input.type === "number") {
      params[name] = Number(raw);
    } else {
      params[name] = raw;
    }
  }
  const multi = {};
  for (const input of document.querySelectorAll("#stt-form [data-stt-multi]")) {
    const name = input.dataset.sttMulti;
    multi[name] = multi[name] || [];
    if (input.checked) multi[name].push(input.value);
  }
  for (const [name, values] of Object.entries(multi)) {
    if (values.length) params[name] = values;
  }

  const preset = $("#stt-model-preset").value;
  const model = preset === "__custom__" ? $("#stt-model-custom").value.trim() : preset;

  return {
    name: $("#stt-name").value.trim(),
    provider: $("#stt-provider").value,
    mode: $("#stt-mode").value,
    base_url: $("#stt-base-url").value.trim(),
    model,
    public_config: params,
    allow_private_endpoint: $("#stt-allow-private").checked,
  };
}

async function readCredentialsFile() {
  const input = $("#stt-credentials");
  const file = input?.files?.[0];
  if (!file) return null;
  if (file.size > 16 * 1024) throw new Error("Файл слишком велик — ожидается service account JSON");
  return await file.text();
}

async function saveSttConfig() {
  const body = collectSttForm();
  const editing = state.sttEditing;

  if (body.provider === "google") {
    const credentials = await readCredentialsFile();
    if (credentials) body.credentials_json = credentials;
    else if (!editing) throw new Error("Загрузите service account JSON");
  } else {
    const key = $("#stt-api-key").value.trim();
    // Пустое поле при редактировании означает «оставить прежний ключ».
    if (key) body.api_key = key;
    else if (!editing) throw new Error("Введите API-ключ");
  }

  const send = async () => {
    if (editing) {
      body.config_version = editing.config_version;
      await request(`/stt/configs/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
    } else {
      await request("/stt/configs", { method: "POST", body: JSON.stringify(body) });
    }
    $("#stt-dialog").close();
    toast("Конфигурация сохранена");
    await loadStt();
  };

  sttAction(send);
}

/**
 * Blob → base64 без рекурсии по стеку.
 *
 * `String.fromCharCode(...bytes)` на записи в несколько сотен килобайт
 * падает с «too many arguments»: аргументы кладутся на стек, и он
 * кончается. Поэтому кусками.
 */
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 8 * 1024;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/**
 * Запись голоса прямо в окне проверки.
 *
 * Встроенный сигнал подтверждает, что провайдер отвечает и ключ принят.
 * Это не то же самое, что «распознавание работает»: язык, акцент,
 * микрофон и шум комнаты проверяются только собственным голосом. Ради
 * этого запись и добавлена — раньше для неё приходилось искать
 * стороннее приложение, сохранять файл и подкладывать его через
 * «выбрать файл».
 */
const recorder = {
  media: null,
  chunks: [],
  blob: null,
  stream: null,
  startedAt: 0,
  timer: null,
};

/** Ставит запись на паузу и отпускает микрофон. */
function stopRecording() {
  clearInterval(recorder.timer);
  recorder.timer = null;
  if (recorder.media?.state === "recording") recorder.media.stop();
  // Поток закрывается всегда: иначе индикатор микрофона в браузере
  // горит и после того, как окно закрыли.
  recorder.stream?.getTracks().forEach((track) => track.stop());
  recorder.stream = null;
}

function renderRecorderIdle(message) {
  $("#stt-record").classList.remove("is-recording");
  $("#stt-record-label").textContent = recorder.blob ? "Записать заново" : "Записать голос";
  if (message) $("#stt-record-state").textContent = message;
}

async function toggleRecording() {
  const button = $("#stt-record");
  if (button.classList.contains("is-recording")) {
    stopRecording();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("Браузер не умеет записывать звук — подложите файл");
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    // NotAllowedError приходит и когда отказал человек, и когда запретил
    // сервер заголовком Permissions-Policy. Второе однажды уже случилось
    // и выглядело как «кнопка не работает»: браузер даже не спрашивал
    // разрешения. Поэтому названы обе причины — гадать не должен никто.
    if (error?.name === "NotFoundError") {
      throw new Error("Микрофон не найден. Подложите готовый файл в «Других способах»");
    }
    throw new Error(
      "Микрофон недоступен. Проверьте разрешение для сайта в настройках браузера. "
      + "Если разрешение выдано, а запись не идёт — доступ закрыт заголовком "
      + "Permissions-Policy на сервере. Пока можно подложить готовый файл "
      + "в «Других способах».",
    );
  }

  // Тип оставляем на усмотрение браузера: Chrome пишет webm/opus,
  // Safari — mp4/aac, и навязывать им чужой контейнер значит получить
  // пустую запись. Распаковкой занимается ffmpeg в media-service.
  recorder.media = new MediaRecorder(stream);
  recorder.stream = stream;
  recorder.chunks = [];
  recorder.blob = null;
  recorder.startedAt = Date.now();

  recorder.media.ondataavailable = (event) => {
    if (event.data.size) recorder.chunks.push(event.data);
  };
  recorder.media.onstop = () => {
    recorder.blob = new Blob(recorder.chunks, { type: recorder.media.mimeType });
    const preview = $("#stt-record-preview");
    preview.src = URL.createObjectURL(recorder.blob);
    preview.hidden = false;
    const seconds = Math.round((Date.now() - recorder.startedAt) / 1000);
    renderRecorderIdle(`Записано ${seconds} с. Нажмите «Запустить проверку».`);
  };

  recorder.media.start();
  button.classList.add("is-recording");
  $("#stt-record-label").textContent = "Остановить";
  $("#stt-record-preview").hidden = true;

  recorder.timer = setInterval(() => {
    const seconds = Math.round((Date.now() - recorder.startedAt) / 1000);
    $("#stt-record-state").textContent = `Идёт запись… ${seconds} с`;
    // Тридцати секунд хватает любому провайдеру, чтобы показать себя, а
    // забытая включённой запись не должна превратиться в счёт за минуты.
    if (seconds >= 30) stopRecording();
  }, 250);
}

/**
 * Открывает окно проверки в чистом состоянии.
 *
 * Два режима, и разница между ними принципиальна. «config» обращается к
 * провайдеру напрямую: отвечает ли он и принят ли ключ. «route» идёт
 * той же дорогой, что голосовое из Telegram: назначен ли провайдер
 * сценарию, доехал ли снимок до media-service, работают ли ключи.
 * Зелёная проверка конфигурации ничего не говорит о втором — на этом
 * уже спотыкались.
 */
function openSttTestDialog(id, name, mode = "config") {
  state.sttTestingId = id;
  state.sttTestMode = mode;
  $("#stt-test-title").textContent = mode === "route"
    ? `Проверка сценария — ${name}`
    : (name ? `Проверка — ${name}` : "Проверка распознавания");
  $("#stt-test-hint").textContent = mode === "route"
    ? "Тот же путь, которым идёт голосовое из Telegram: маршрут, провайдеры, ключи. "
      + "Нужна запись — встроенного сигнала для этой проверки нет."
    : "Обращение к провайдеру напрямую. Проверка не активирует конфигурацию.";
  $("#stt-test-result").hidden = true;
  if ($("#stt-test-file")) $("#stt-test-file").value = "";
  recorder.blob = null;
  recorder.chunks = [];
  $("#stt-record-preview").hidden = true;
  renderRecorderIdle("Скажите несколько слов — их и будем распознавать.");
  $("#stt-test-dialog").showModal();
}

async function runSttTest() {
  const id = state.sttTestingId;
  const file = $("#stt-test-file")?.files?.[0];
  let audio;
  // Своя запись важнее подложенного файла: её только что сделали
  // именно для этой проверки.
  if (recorder.blob) audio = await blobToBase64(recorder.blob);
  else if (file) audio = await blobToBase64(file);

  const host = $("#stt-test-result");
  host.hidden = false;
  host.textContent = "Проверяю…";

  const path = state.sttTestMode === "route"
    ? `/stt/routes/${encodeURIComponent(id)}/test`
    : `/stt/configs/${id}/test`;
  const { payload } = await request(path, {
    method: "POST",
    body: JSON.stringify(audio ? { audio_base64: audio } : {}),
  });

  // Проверяются все ключи, а не только первый: список имеет смысл лишь
  // тогда, когда известно состояние каждого.
  const perKey = (payload.keys || []).length
    ? `<div class="key-list">${payload.keys.map((key) => `
        <article class="key-row">
          <span class="dot ${key.success ? "green" : "red"}"></span>
          <div class="key-main">
            <strong>${escapeHtml(key.label)}</strong>
            <p class="muted">${key.success
              ? `работает · ${key.latency_ms ?? "?"} мс`
              : escapeHtml(`${key.error_code || "ошибка"}${key.error_message ? ` — ${String(key.error_message).slice(0, 160)}` : ""}`)}</p>
          </div>
        </article>`).join("")}</div>`
    : "";

  if (payload.success) {
    // Поля, которых провайдер не вернул, не показываем вовсе: пустое
    // место честнее выдуманного числа.
    host.innerHTML = `<strong>Успешно.</strong>
      <dl class="status-meta">
        <div><dt>Провайдер</dt><dd>${escapeHtml(payload.provider)}</dd></div>
        <div><dt>Модель</dt><dd>${escapeHtml(payload.model)}</dd></div>
        ${payload.upstream_provider ? `<div><dt>Фактический upstream</dt><dd>${escapeHtml(payload.upstream_provider)}</dd></div>` : ""}
        <div><dt>Задержка</dt><dd>${payload.latency_ms} мс</dd></div>
        <div><dt>Длительность</dt><dd>${payload.audio_duration_ms} мс</dd></div>
        ${payload.language ? `<div><dt>Язык</dt><dd>${escapeHtml(payload.language)}</dd></div>` : ""}
        ${payload.confidence !== undefined ? `<div><dt>Уверенность</dt><dd>${payload.confidence}</dd></div>` : ""}
        ${payload.provider_request_id ? `<div><dt>Request ID</dt><dd>${escapeHtml(payload.provider_request_id)}</dd></div>` : ""}
      </dl>
      <p><em>Расшифровка:</em> ${escapeHtml(payload.transcript || "(пусто)")}</p>
      ${(payload.warnings || []).length ? `<p class="muted">${payload.warnings.map(escapeHtml).join("; ")}</p>` : ""}
      ${perKey}`;
  } else {
    host.innerHTML = `<strong>Не удалось.</strong>
      <p>${escapeHtml(payload.error?.message || "провайдер не ответил")}</p>
      <p class="muted">Код: ${escapeHtml(payload.error?.code || "неизвестен")}</p>
      ${perKey}`;
  }
  await loadStt();
}

async function saveSttRoute(useCase) {
  const card = document.querySelector(`[data-route="${useCase}"]`);
  const body = {};
  for (const input of card.querySelectorAll("[data-route-field]")) {
    const name = input.dataset.routeField;
    if (input.type === "checkbox") body[name] = input.checked;
    else body[name] = input.value === "" ? null : input.value;
  }
  sttAction(async () => {
      await request(`/stt/routes/${encodeURIComponent(useCase)}`, {
        method: "PUT", body: JSON.stringify(body),
      });
      toast("Маршрут применён");
      await loadStt();
    });
}

// ---------------------------------------------------------------------
// события раздела
// ---------------------------------------------------------------------
document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-stt-tab]");
  if (tab) {
    document.querySelectorAll("[data-stt-tab]").forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    const active = tab.dataset.sttTab;
    $("#stt-configs").hidden = active !== "configs";
    $("#stt-routes").hidden = active !== "routes";
    $("#stt-usage").hidden = active !== "usage";
    if (active === "usage") loadSttUsage().catch(handleError);
    return;
  }

  const link = event.target.closest("[data-stt-chain]");
  if (link) {
    sttChainAction(link.dataset.sttChain, link.dataset.route, link.dataset.config);
    return;
  }

  const action = event.target.closest("[data-stt-action]");
  if (!action) return;
  const id = action.dataset.id;
  const config = state.sttConfigs?.find((item) => item.id === id);

  switch (action.dataset.sttAction) {
    case "edit":
      openSttEditor(config);
      break;
    case "test":
      openSttTestDialog(id, config?.name);
      break;
    case "test-route":
      openSttTestDialog(id, STT_USE_CASE_LABELS[id] || id, "route");
      break;
    case "archive":
      sttAction(async () => {
          await request(`/stt/configs/${id}/archive`, { method: "POST" });
          toast("Конфигурация в архиве");
          await loadStt();
        });
      break;
    case "restore":
      sttAction(async () => {
          await request(`/stt/configs/${id}/restore`, { method: "POST" });
          await loadStt();
        });
      break;
    case "key":
      openSttKeyDialog(config).catch(handleError);
      break;
    case "activate":
      sttAction(async () => {
          await request(`/stt/configs/${id}/activate`, {
            method: "POST",
            body: JSON.stringify({ use_case: "telegram_voice", slot: "primary" }),
          });
          toast("Провайдер активирован для голосовых Telegram");
          await loadStt();
        });
      break;
    case "toggle": {
      const enable = action.dataset.enabled !== "true";
      sttAction(async () => {
          await request(`/stt/configs/${id}/enabled`, {
            method: "POST", body: JSON.stringify({ enabled: enable }),
          });
          await loadStt();
        });
      break;
    }
    case "save-route":
      saveSttRoute(id);
      break;
    default:
      break;
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "stt-model-preset") {
    $("#stt-model-custom-wrap").hidden = event.target.value !== "__custom__";
  }
  // Смена провайдера или режима перестраивает форму: у Deepgram и
  // Google нет ни одного общего поля, а streaming добавляет свои.
  if (event.target.id === "stt-provider" || event.target.id === "stt-mode") {
    const schema = sttSchema($("#stt-provider").value);
    if (schema) renderSttForm(schema, { ...(state.sttEditing || {}), mode: $("#stt-mode").value });
  }
});

// Кнопки диалогов раздела распознавания. Регистрируются один раз здесь,
// а не в разметке, чтобы обработчики жили рядом с логикой раздела.
$("#new-stt-config")?.addEventListener("click", () => openSttEditor(null));

/**
 * Закрытие любого диалога кнопкой «Назад».
 *
 * Обработчик один на всю страницу и работает по data-атрибуту: раньше
 * каждому окну полагалась своя строчка, и окно, добавленное без неё,
 * закрыть было нечем.
 */
document.addEventListener("click", (event) => {
  const back = event.target.closest("[data-close-dialog]");
  if (!back) return;
  document.querySelector(`#${back.dataset.closeDialog}`)?.close();
});

/**
 * Аппаратная кнопка «назад» на андроиде.
 *
 * Chrome закрывает по ней <dialog> не во всех версиях, а привычка
 * нажимать её — первое, что делает рука. Запись в истории на время
 * показа окна превращает «назад» в закрытие: браузер снимает запись,
 * мы ловим popstate и закрываем окно сами.
 */
function trackDialogHistory(dialog) {
  if (dialog.dataset.historyTracked) return;
  dialog.dataset.historyTracked = "1";
  const open = dialog.showModal.bind(dialog);
  dialog.showModal = () => {
    open();
    history.pushState({ dialog: dialog.id }, "");
  };
  dialog.addEventListener("close", () => {
    // Закрыли крестиком или Escape — лишнюю запись надо убрать, иначе
    // следующее «назад» ничего не сделает.
    if (history.state?.dialog === dialog.id) history.back();
  });
}
window.addEventListener("popstate", () => {
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
});
document.querySelectorAll("#page-stt dialog").forEach(trackDialogHistory);
$("#stt-save")?.addEventListener("click", () => {
  saveSttConfig().catch((error) => {
    const host = $("#stt-form-error");
    host.hidden = false;
    host.textContent = error instanceof Error ? error.message : String(error);
  });
});
$("#stt-test")?.addEventListener("click", () => {
  // Проверка из редактора имеет смысл только для сохранённой
  // конфигурации: у несохранённой ещё нет ключа в Secret Store.
  if (!state.sttEditing) {
    const host = $("#stt-form-error");
    host.hidden = false;
    host.textContent = "Сначала сохраните конфигурацию — проверка использует ключ из Secret Store";
    return;
  }
  openSttTestDialog(state.sttEditing.id, state.sttEditing.name);
});
$("#stt-test-run")?.addEventListener("click", () => {
  runSttTest().catch(handleError);
});
$("#stt-record")?.addEventListener("click", () => {
  toggleRecording().catch((error) => {
    renderRecorderIdle(error instanceof Error ? error.message : String(error));
  });
});
// Закрыли окно — микрофон отпускаем и запись забываем: чужой голос из
// прошлой проверки не должен уехать в следующую.
$("#stt-test-dialog")?.addEventListener("close", () => {
  stopRecording();
  recorder.blob = null;
  recorder.chunks = [];
  const preview = $("#stt-record-preview");
  if (preview) { preview.hidden = true; preview.removeAttribute("src"); }
});
