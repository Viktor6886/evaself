/**
 * Раздел «Распознавание речи» → вкладка «Файлы из Telegram».
 *
 * Здесь собрано всё, что нужно для расшифровки присланных аудиофайлов:
 * флаг «Разбор аудиофайлов» (общая настройка runtime.audio_file_transcripts,
 * тот же путь записи, что в разделе «Настройки»), ключи приложения
 * my.telegram.org (форма интеграции Telegram) и переход на свой сервер
 * Bot API. Облачный Bot API отдаёт ботам файлы только до 20 МБ — больше
 * получает только свой сервер (docs/telegram-bot-api.md).
 *
 * Своих хранилищ у вкладки нет: ключи уходят в ту же форму интеграции,
 * флаг — в те же настройки, а переключение делает сервис операций тем
 * же скриптом, что и на сервере руками.
 */

const AUDIO_FILES_SETTING = "runtime.audio_file_transcripts";

function sttTelegramCanWrite() {
  return ["owner", "admin"].includes(state.me?.role);
}

async function loadSttTelegram() {
  const [settings, integration, botApi] = await Promise.all([
    request("/settings"),
    request("/integrations/telegram/config"),
    request("/telegram/bot-api").catch((error) => ({ payload: null, error })),
  ]);
  const flag = (settings.payload.settings || []).find((item) => item.key === AUDIO_FILES_SETTING);
  state.sttTelegram = {
    audioFiles: flag ? flag.value === true : false,
    // Версия настроек: без неё сохранение отвергается как устаревшее.
    etag: settings.payload.etag || settings.response.headers.get("ETag"),
    fields: Object.fromEntries((integration.payload.fields || []).map((field) => [field.name, field])),
    botApi: botApi.payload,
    botApiError: botApi.error ? String(botApi.error.message || "") : null,
  };
  renderSttTelegram();
}

function sttTelegramServerLine(botApi) {
  if (!botApi) return "";
  if (botApi.mode === "cloud") {
    return `<p class="integration-status color-gray">Сейчас: облачный Bot API — Ева принимает
      файлы до ${botApi.cloud_file_limit_mb} МБ.</p>`;
  }
  const server = botApi.server;
  const running = server?.running === true;
  const serverState = !server
    ? `состояние сервера неизвестно: ${escapeHtml(botApi.server_error || "сервис операций не ответил")}`
    : running ? "сервер работает" : server.exists ? "контейнер не запущен" : "контейнер не создан";
  return `<p class="integration-status ${running ? "color-green" : "color-red"}">Сейчас: свой сервер
    Bot API — файлы до 350 МБ; ${serverState}.</p>`;
}

function renderSttTelegram() {
  const data = state.sttTelegram;
  const writable = sttTelegramCanWrite();
  const disabled = writable ? "" : " disabled";
  const apiId = data.fields.api_id?.value || "";
  const hashConfigured = data.fields.api_hash?.configured === true;
  const botApi = data.botApi;
  const local = botApi?.mode === "local";
  const keysReady = Boolean(apiId) && hashConfigured;

  $("#stt-telegram").innerHTML = `
    <article class="status-card">
      <header><div><h4>Аудиофайлы из Telegram</h4>
        <p class="muted">Аудиофайл, присланный файлом (MP3, M4A, WAV и др.), Ева расшифровывает,
          присылает текстом в DOCX и по просьбе переделывает — например, в тезисы.</p></div></header>
      <label class="field"><span>Разбор аудиофайлов</span>
        <select id="stt-audio-files"${disabled}>
          <option value="true"${data.audioFiles ? " selected" : ""}>Включено</option>
          <option value="false"${data.audioFiles ? "" : " selected"}>Выключено</option>
        </select></label>
      <small class="muted">Действует со следующего сообщения, перезапуск не нужен. Выключено —
        аудиофайл распознаётся как голосовое, без документа.</small>
    </article>

    <article class="status-card">
      <header><div><h4>Файлы больше 20 МБ</h4>
        <p class="muted">Облачный Bot API отдаёт ботам файлы только до 20 МБ. Файлы больше
          (до 350 МБ) бот получает через свой сервер Bot API. Для него нужны API ID и API Hash
          приложения: <a href="https://my.telegram.org" target="_blank" rel="noopener">my.telegram.org</a>
          → API development tools. Это ключи приложения, а не вход в аккаунт: бот по-прежнему
          работает своим токеном.</p></div></header>
      ${sttTelegramServerLine(botApi)}
      ${data.botApiError ? `<p class="integration-status error">Состояние сервера Bot API недоступно:
        ${escapeHtml(data.botApiError)}</p>` : ""}
      <form id="stt-telegram-keys" class="integration-form" autocomplete="off">
        <label>API ID
          <input name="api_id" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12"
                 placeholder="1234567" value="${escapeHtml(apiId)}"${disabled}></label>
        <label>API Hash
          <input name="api_hash" type="password" pattern="[0-9a-fA-F]{32}" maxlength="32"
                 placeholder="${hashConfigured ? "задан — оставьте пустым, чтобы не менять" : "32 символа 0–9 и a–f"}"${disabled}></label>
      </form>
      <div class="card-actions">
        <button class="button ghost" id="stt-telegram-save" type="button"${disabled}>Сохранить ключи</button>
        ${local
          ? `<button class="button ghost" data-stt-bot-api="local" type="button"${writable && keysReady ? "" : " disabled"}>Применить ключи на сервере</button>
             <button class="button ghost" data-stt-bot-api="cloud" type="button"${disabled}>Вернуться в облако</button>`
          : `<button class="button primary" data-stt-bot-api="local" type="button"${writable && keysReady ? "" : " disabled"}>Перейти на свой сервер</button>`}
      </div>
      ${keysReady || local ? "" : `<small class="muted">Кнопка перехода станет доступна, когда оба ключа сохранены.</small>`}
      <p id="stt-telegram-progress" class="integration-status color-blue" hidden></p>
    </article>`;
}

async function saveSttAudioFiles(enabled) {
  const data = state.sttTelegram;
  const { payload, response } = await request("/settings", {
    method: "PUT",
    headers: { "If-Match": data.etag },
    body: JSON.stringify({ settings: { [AUDIO_FILES_SETTING]: enabled } }),
  });
  data.etag = payload.etag || response.headers.get("ETag");
  data.audioFiles = enabled;
  toast(enabled ? "Разбор аудиофайлов включён" : "Разбор аудиофайлов выключен");
}

async function saveSttTelegramKeys() {
  const form = $("#stt-telegram-keys");
  const apiId = form.elements.api_id.value.trim();
  const apiHash = form.elements.api_hash.value.trim();
  // Пустой API Hash — «оставить как было»: сохранённое значение форма не
  // показывает, и стирать его пустым полем нельзя.
  const body = { api_id: apiId };
  if (apiHash) body.api_hash = apiHash;
  await request("/integrations/telegram/config", { method: "PUT", body: JSON.stringify(body) });
  toast("Ключи сохранены");
  await loadSttTelegram();
}

/**
 * Дождаться, пока admin-api вернётся после пересоздания.
 *
 * Переключение пересоздаёт и сам admin-api: какое-то время панель
 * получает отказы. Ждём ответа уже с новым режимом, а не первого
 * попавшегося — прежний процесс может ещё успеть ответить.
 */
async function waitSttBotApiMode(mode) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    try {
      const { payload } = await request("/telegram/bot-api");
      if (payload?.mode === mode) return true;
    } catch {
      // admin-api ещё поднимается.
    }
  }
  return false;
}

function switchSttBotApi(mode) {
  const toLocal = mode === "local";
  const alreadyLocal = state.sttTelegram?.botApi?.mode === "local";
  askConfirm({
    eyebrow: "СЕРВЕР BOT API",
    title: toLocal
      ? (alreadyLocal ? "Применить ключи на своём сервере" : "Перейти на свой сервер Bot API")
      : "Вернуть бота в облачный Bot API",
    description: toLocal
      ? (alreadyLocal
        ? "Сервер Bot API будет пересоздан с сохранёнными ключами. Агент, media-service и панель перезапустятся — панель на полминуты потеряет связь."
        : "Бот выйдет из облачного Bot API и переедет на свой сервер: файлы до 350 МБ. Вернуться в облако Telegram позволит не раньше чем через 10 минут. Агент, media-service и панель перезапустятся — панель на полминуты потеряет связь, а первый запуск сервера займёт до пары минут.")
      : "Файлы больше 20 МБ снова перестанут приниматься. Агент, media-service и панель перезапустятся — панель на полминуты потеряет связь.",
    action: async () => {
      const progress = $("#stt-telegram-progress");
      document.querySelectorAll("[data-stt-bot-api], #stt-telegram-save").forEach((node) => { node.disabled = true; });
      progress.hidden = false;
      progress.textContent = "Переключаю сервер Bot API… это займёт до пары минут, не закрывайте страницу.";
      try {
        await request("/telegram/bot-api/mode", { method: "POST", body: JSON.stringify({ mode }) });
      } catch (error) {
        progress.hidden = true;
        await loadSttTelegram().catch(() => {});
        throw error;
      }
      progress.textContent = "Готово. Панель перезапускается с новым адресом Bot API…";
      const back = await waitSttBotApiMode(mode);
      toast(back
        ? (toLocal ? "Бот работает через свой сервер Bot API" : "Бот вернулся в облачный Bot API")
        : "Переключение выполнено, но панель ещё не ответила — обновите страницу через минуту", !back);
      await loadSttTelegram().catch(handleError);
    },
  });
}

// Вкладка раздела. Общий обработчик вкладок (ui-stt-editor.js) прячет
// остальные три по их id; эту — прячет и показывает этот.
document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-stt-tab]");
  if (tab) {
    const active = tab.dataset.sttTab === "telegram";
    $("#stt-telegram").hidden = !active;
    if (active) loadSttTelegram().catch(handleError);
    return;
  }
  if (event.target.closest("#stt-telegram-save")) {
    saveSttTelegramKeys().catch(handleError);
    return;
  }
  const button = event.target.closest("[data-stt-bot-api]");
  if (button) switchSttBotApi(button.dataset.sttBotApi);
});

document.addEventListener("change", (event) => {
  if (event.target.id !== "stt-audio-files") return;
  saveSttAudioFiles(event.target.value === "true").catch(async (error) => {
    handleError(error);
    // Устаревшая версия настроек или отказ — показываем то, что в базе.
    await loadSttTelegram().catch(() => {});
  });
});
