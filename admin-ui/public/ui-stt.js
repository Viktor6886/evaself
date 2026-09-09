/**
 * Раздел «Распознавание речи»: список конфигураций, маршруты и расход.
 *
 * Панель не знает ни одного параметра провайдеров: форма строится по
 * GET /stt/provider-schemas.
 */
// =====================================================================
// Распознавание речи
// =====================================================================
// Панель не знает ни одного параметра провайдеров. Форма строится по
// GET /stt/provider-schemas, который admin-api проксирует из
// media-service — источник истины там же, где адаптеры. Поэтому новая
// модель или новый параметр Deepgram не требуют правки этого файла.

const STT_SECTIONS = [
  ["basic", "Основные настройки"],
  ["model", "Модель и язык"],
  ["formatting", "Форматирование"],
  ["features", "Дополнительные возможности"],
  ["secret", "Секрет"],
  ["advanced", "Расширенные настройки"],
];

const STT_STATUS = {
  draft: ["Черновик", "gray"],
  healthy: ["Работает", "green"],
  unhealthy: ["Ошибка", "red"],
  disabled: ["Выключено", "gray"],
  archived: ["В архиве", "gray"],
};

const STT_USE_CASE_LABELS = {
  telegram_voice: "Голосовые в Telegram",
  webapp_voice_message: "Голосовые в WebApp",
  webapp_live: "Живой режим (в разработке)",
};

async function loadStt() {
  // Конфигурации и маршруты лежат в PostgreSQL и доступны всегда.
  // Схемы форм приходят из media-service, и его недоступность не должна
  // превращать раздел в мёртвую страницу: ключ, активацию и выключение
  // можно сделать и без схемы, а редактор параметров подождёт.
  const [configs, routes] = await Promise.all([
    request("/stt/configs"),
    request("/stt/routes"),
  ]);
  state.sttConfigs = configs.payload.configs || [];
  state.sttRoutes = routes.payload.routes || [];
  state.sttSchemaError = null;

  try {
    const { payload } = await request("/stt/provider-schemas");
    state.sttSchemas = payload.providers || [];
    if (payload.stale) {
      state.sttSchemaError = "media-service не отвечает — показаны сохранённые схемы";
    }
  } catch (error) {
    state.sttSchemas = state.sttSchemas || [];
    // Сообщение называет причину, а не только следствие: «не отвечает»
    // и «отвечает 401» чинят по-разному, и гадать администратор не
    // должен.
    const reason = String(error?.message || "");
    state.sttSchemaError = /401|ключ|unauthor/i.test(reason)
      ? "media-service отклоняет запросы панели (HTTP 401): не совпадает "
        + "MEDIA_SERVICE_TOKEN. Проверьте переменную в .env и перезапустите "
        + "admin-api и media-service."
      : "media-service не отвечает: редактор параметров и проверка недоступны, "
        + "ключи и маршруты работают";
  }

  // Правки в базе применяются всегда, а вот распознавание пойдёт по ним
  // только после доставки снимка. Разницу надо показать: иначе
  // «сохранено» читается как «работает».
  try {
    const { payload } = await request("/stt/health");
    state.sttSnapshot = payload.snapshot || null;
  } catch {
    state.sttSnapshot = null;
  }

  renderSttConfigs();
  renderSttRoutes();
}

function sttSchema(provider) {
  return (state.sttSchemas || []).find((item) => item.provider === provider);
}

/**
 * Предупреждение о ненастроенном сценарии.
 *
 * Здесь закрывается разрыв, из-за которого «всё сделал, а не работает»:
 * ключ введён, проверка зелёная — и голосовые всё равно не
 * распознаются, потому что провайдера никто не поставил в цепочку.
 * Проверка обращается к провайдеру напрямую и про маршруты ничего не
 * знает, так что её успех ни о чём в этом смысле не говорит.
 *
 * Раньше единственным следом было слово «нигде» в строке
 * «Используется» — его легко прочесть как техническую подробность.
 */
function sttRouteWarning() {
  const routes = state.sttRoutes || [];
  if (!routes.length) return "";
  const broken = routes.filter(
    (route) => route.enabled && !(route.chain || []).length);
  if (!broken.length) return "";
  const names = broken
    .map((route) => STT_USE_CASE_LABELS[route.use_case] || route.use_case)
    .join(", ");
  return `<p class="integration-status error">Не распознаётся: ${escapeHtml(names)}.
    Для сценария не назначен ни один провайдер — введите ключ и нажмите
    «Активировать». Успешная проверка сама по себе провайдера в работу не
    вводит: она обращается к нему напрямую, минуя маршруты.</p>`;
}

function renderSttConfigs() {
  const host = $("#stt-configs");
  const undelivered = state.sttSnapshot && state.sttSnapshot.delivered === false
    ? `<p class="integration-status error">Настройки сохранены, но не применены:
        media-service не принял снимок${state.sttSnapshot.error
          ? ` (${escapeHtml(String(state.sttSnapshot.error).slice(0, 160))})` : ""}.
        Распознавание работает по прежним настройкам; панель повторит попытку сама.</p>`
    : "";
  const notice = (state.sttSchemaError
    ? `<p class="integration-status error">${escapeHtml(state.sttSchemaError)}</p>`
    : "") + undelivered + sttRouteWarning();
  if (!state.sttConfigs.length) {
    host.innerHTML = `${notice}<p class="muted">Конфигураций пока нет. Пока их нет, распознавание
      работает по устаревшим переменным MEDIA_ASR_* из .env.</p>`;
    return;
  }
  host.innerHTML = notice + state.sttConfigs.map((config) => {
    const [label, color] = STT_STATUS[config.status] || [config.status, "gray"];
    const schema = sttSchema(config.provider);
    const test = config.last_test || {};
    const activePlacements = sttActivePlacements(config.id);
    const isActive = activePlacements.length > 0;
    const isTelegramPrimary = activePlacements.some(
      (item) => item.useCase === "telegram_voice" && item.position === 0);
    const usedBy = (config.used_by || [])
      .map((useCase) => STT_USE_CASE_LABELS[useCase] || useCase)
      .join(", ");
    return `
      <article class="status-card${isActive ? " is-active" : ""}" data-stt-id="${config.id}">
        <header>
          <span class="dot ${color}"></span>
          <div>
            <h4>${escapeHtml(config.name)}</h4>
            <p class="muted">${escapeHtml(schema?.label || config.provider)} · ${escapeHtml(config.model)} · ${config.mode}</p>
          </div>
          <div class="stt-card-badges">
            ${isActive ? '<span class="status-pill stt-active-pill">Активен</span>' : ""}
            <span class="pill">${label}</span>
          </div>
        </header>
        <dl class="status-meta">
          <div><dt>Ключи</dt><dd>${sttKeySummary(config)}</dd></div>
          <div><dt>Используется</dt><dd>${usedBy ? escapeHtml(usedBy) : "нигде"}</dd></div>
          ${isActive ? `<div><dt>Активен как</dt><dd>${activePlacements.map((item) =>
            escapeHtml(`${STT_USE_CASE_LABELS[item.useCase] || item.useCase} — ${
              item.position === 0 ? "основной" : `резерв ${item.position}`
            }`)).join("<br>")}</dd></div>` : ""}
          <div><dt>Последняя проверка</dt><dd>${
            test.at ? `${new Date(test.at).toLocaleString("ru")} · ${test.ok ? "успешно" : "ошибка"}` : "не проводилась"
          }</dd></div>
          ${test.latency_ms ? `<div><dt>Задержка</dt><dd>${test.latency_ms} мс</dd></div>` : ""}
        </dl>
        ${test.ok === false && test.error_message
          ? `<p class="integration-status error">${escapeHtml(String(test.error_message).slice(0, 200))}</p>` : ""}
        <div class="card-actions">
          <button class="button ${config.secret?.configured ? "ghost" : "primary"}"
                  data-stt-action="key" data-id="${config.id}">
            ${config.secret?.configured ? "Ключи" : "Ввести ключ"}
          </button>
          <button class="button ghost" data-stt-action="test" data-id="${config.id}"
                  ${config.secret?.configured ? "" : "disabled"}>Проверить</button>
          <button class="button ${config.secret?.configured && !config.archived
                    && !isActive ? "primary" : "ghost"}"
                  data-stt-action="activate" data-id="${config.id}"
                  data-active="${isTelegramPrimary}"
                  ${config.secret?.configured && !config.archived && !isTelegramPrimary ? "" : "disabled"}>
            ${isTelegramPrimary ? "Активен" : "Активировать"}</button>
          <button class="button ghost" data-stt-action="toggle" data-id="${config.id}"
                  data-enabled="${config.status !== "disabled"}">
            ${config.status === "disabled" ? "Включить" : "Выключить"}
          </button>
          <button class="button ghost" data-stt-action="edit" data-id="${config.id}">Параметры</button>
          ${config.archived
            ? `<button class="button ghost" data-stt-action="restore" data-id="${config.id}">Вернуть из архива</button>`
            : `<button class="button ghost" data-stt-action="archive" data-id="${config.id}">В архив</button>`}
        </div>
      </article>`;
  }).join("");
}

/** Active route placements for a provider, including its primary/fallback role. */
function sttActivePlacements(configId) {
  const placements = [];
  for (const route of state.sttRoutes || []) {
    if (!route.enabled) continue;
    for (const [position, link] of (route.chain || []).entries()) {
      if (link.config_id === configId) {
        placements.push({ useCase: route.use_case, position });
      }
    }
  }
  return placements;
}

/**
 * Ключи одной строкой для карточки.
 *
 * Важно не число ключей само по себе, а сколько из них сейчас можно
 * пробовать: «5 ключей» при четырёх исчерпанных — повод зайти внутрь.
 */
function sttKeySummary(config) {
  const keys = config.keys || {};
  const total = Number(keys.total || 0);
  if (!total) return config.secret?.configured ? "1 (основной)" : "не настроены";
  const parts = [`${total}`];
  if (keys.exhausted) parts.push(`${keys.exhausted} с исчерпанным лимитом`);
  if (keys.invalid) parts.push(`${keys.invalid} отвергнут провайдером`);
  if (!keys.usable) parts.push("рабочих нет");
  return escapeHtml(parts.join(" · "));
}

/**
 * Действие раздела распознавания речи.
 *
 * Без подтверждения паролем — сначала по решению владельца для этого
 * раздела, теперь по общему правилу панели: пароль вводится один раз при
 * входе. Защита осталась там, где работает по-настоящему: вход в панель,
 * роль owner или admin и запись каждого действия в аудит.
 *
 * Хелпер существует, чтобы это решение было видно в одном месте, а не
 * растворилось в десятке мест, где раньше стоял askSudo.
 */
function sttAction(action) {
  Promise.resolve().then(action).catch(handleError);
}

/** Предел цепочки. Тот же, что у сервера и у LLM Router. */
const STT_MAX_CHAIN = 6;

function renderSttRoutes() {
  $("#stt-routes").innerHTML = state.sttRoutes.map((route) => {
    const chain = route.chain || [];
    return `
    <article class="status-card" data-route="${route.use_case}">
      <header>
        <span class="dot ${route.enabled && chain.length ? "green" : "gray"}"></span>
        <div><h4>${STT_USE_CASE_LABELS[route.use_case] || route.use_case}</h4>
          <p class="muted">${route.use_case}</p></div>
      </header>

      <p class="muted">Провайдеры перебираются сверху вниз. Порядок — это и есть
        приоритет: когда первый не отвечает или у него кончились ключи,
        распознавание продолжает следующий.</p>

      ${chain.length ? `<ol class="chain">${chain.map((link, index) => `
        <li class="chain-link">
          <span class="chain-rank">${index === 0 ? "основной" : `резерв ${index}`}</span>
          <span class="chain-name"><strong>${escapeHtml(link.name)}</strong>
            <small>${escapeHtml(link.model)} · ${escapeHtml(link.provider)}</small></span>
          <span class="chain-move">
            <button class="button tiny ghost" data-stt-chain="up" data-route="${route.use_case}"
                    data-config="${link.config_id}"${index === 0 ? " disabled" : ""}>↑</button>
            <button class="button tiny ghost" data-stt-chain="down" data-route="${route.use_case}"
                    data-config="${link.config_id}"${index === chain.length - 1 ? " disabled" : ""}>↓</button>
            <button class="button tiny danger-outline" data-stt-chain="remove"
                    data-route="${route.use_case}" data-config="${link.config_id}">Убрать</button>
          </span>
        </li>`).join("")}</ol>`
      : `<p class="muted">Провайдер не назначен — распознавание для этого сценария не работает.</p>`}

      ${sttChainAdder(route, chain)}

      <label class="switch"><input type="checkbox" data-route-field="rotation_enabled"
             ${route.rotation_enabled ? "checked" : ""}>
        <span>Ротация провайдеров</span></label>
      <small class="muted">Выключите, если резервный провайдер не устраивает по цене
        или качеству: тогда работает только основной, а отказ остаётся отказом.</small>

      <label class="field"><span>Таймаут, мс</span>
        <input type="number" data-route-field="timeout_ms" value="${route.timeout_ms}" min="5000" max="600000"></label>
      <label class="field"><span>Предел длительности, с</span>
        <input type="number" data-route-field="max_audio_seconds" value="${route.max_audio_seconds ?? ""}" min="1" max="7200"></label>
      <label class="switch"><input type="checkbox" data-route-field="enabled" ${route.enabled ? "checked" : ""}>
        <span>Сценарий включён</span></label>
      <div class="card-actions">
        <button class="button primary" data-stt-action="save-route" data-id="${route.use_case}">Применить</button>
        <button class="button ghost" data-stt-action="test-route" data-id="${route.use_case}">Проверить сценарий</button>
      </div>
    </article>`;
  }).join("");
}

/** Выпадающий список того, кого ещё можно поставить в цепочку. */
function sttChainAdder(route, chain) {
  if (chain.length >= STT_MAX_CHAIN) {
    return `<p class="muted">Цепочка заполнена: ${STT_MAX_CHAIN} провайдеров — предел.</p>`;
  }
  const used = new Set(chain.map((link) => link.config_id));
  const free = state.sttConfigs.filter(
    (config) => !config.archived && config.secret?.configured && !used.has(config.id));
  if (!free.length) {
    return `<p class="muted">Свободных настроенных провайдеров нет.</p>`;
  }
  return `<div class="chain-add">
    <select data-stt-chain-pick="${route.use_case}">
      ${free.map((config) => `<option value="${config.id}">${escapeHtml(config.name)}</option>`).join("")}
    </select>
    <button class="button ghost" data-stt-chain="add" data-route="${route.use_case}">Добавить в цепочку</button>
  </div>`;
}

/**
 * Перестановка и удаление звеньев.
 *
 * Цепочка отправляется целиком: «поставить вторым» — это про позиции
 * всех, а не одного, и спорить с сервером о том, как выглядит
 * результат, незачем.
 */
function sttChainAction(action, useCase, configId) {
  const route = state.sttRoutes.find((item) => item.use_case === useCase);
  if (!route) return;
  const ids = (route.chain || []).map((link) => link.config_id);

  if (action === "add") {
    const picked = document.querySelector(`[data-stt-chain-pick="${useCase}"]`)?.value;
    if (!picked) return;
    ids.push(picked);
  } else {
    const index = ids.indexOf(configId);
    if (index < 0) return;
    if (action === "remove") ids.splice(index, 1);
    else {
      const target = action === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
    }
  }

  sttAction(async () => {
      await request(`/stt/routes/${encodeURIComponent(useCase)}`, {
        method: "PUT", body: JSON.stringify({ chain: ids }),
      });
      toast("Цепочка обновлена");
      await loadStt();
    });
}

async function loadSttUsage() {
  const { payload } = await request("/stt/usage?days=30");
  const allTime = payload.all_time || {};
  const totals = payload.totals || {};
  const day = payload.last_24h || {};
  const rate = Number(totals.requests) > 0
    ? Math.round((Number(totals.successes) / Number(totals.attempts)) * 100) : null;

  $("#stt-usage").innerHTML = `
    <div class="status-grid">
      <article class="status-card"><header><div><h4>За всё время</h4></div></header>
        <dl class="status-meta">
          <div><dt>Распознаваний</dt><dd>${allTime.requests ?? 0}</dd></div>
          <div><dt>Распознано секунд</dt><dd>${formatSttSeconds(allTime.audio_seconds)}</dd></div>
        </dl></article>
      <article class="status-card"><header><div><h4>За 24 часа</h4></div></header>
        <dl class="status-meta">
          <div><dt>Распознаваний</dt><dd>${day.requests ?? 0}</dd></div>
          <div><dt>Ошибок</dt><dd>${day.failures ?? 0}</dd></div>
        </dl></article>
      <article class="status-card"><header><div><h4>За 30 дней</h4></div></header>
        <dl class="status-meta">
          <div><dt>Распознаваний</dt><dd>${totals.requests ?? 0}</dd></div>
          <div><dt>Попыток к провайдерам</dt><dd>${totals.attempts ?? 0}</dd></div>
          <div><dt>Уходов на резерв</dt><dd>${totals.fallbacks ?? 0}</dd></div>
          <div><dt>Секунд аудио</dt><dd>${formatSttSeconds(totals.audio_seconds)}</dd></div>
          <div><dt>Успешность</dt><dd>${rate === null ? "—" : `${rate}%`}</dd></div>
          <div><dt>Задержка p50 / p95</dt><dd>${totals.p50_latency_ms ?? "—"} / ${totals.p95_latency_ms ?? "—"} мс</dd></div>
        </dl></article>
    </div>
    <h3 class="section-title">По провайдерам</h3>
    <table class="table"><thead><tr><th>Провайдер</th><th>Модель</th><th>Запросов</th><th>Секунд</th><th>p95, мс</th></tr></thead>
      <tbody>${(payload.by_provider || []).map((row) => `<tr>
        <td>${escapeHtml(row.provider)}</td><td>${escapeHtml(row.model)}</td>
        <td>${row.requests}</td><td>${formatSttSeconds(row.audio_seconds)}</td>
        <td>${row.p95_latency_ms ?? "—"}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">Пока нет данных</td></tr>'}
      </tbody></table>
    <h3 class="section-title">Последние ошибки</h3>
    <table class="table"><thead><tr><th>Когда</th><th>Сценарий</th><th>Провайдер</th><th>Код</th><th>Резерв</th></tr></thead>
      <tbody>${(payload.recent_errors || []).map((row) => `<tr>
        <td>${new Date(row.at).toLocaleString("ru")}</td>
        <td>${escapeHtml(row.use_case)}</td><td>${escapeHtml(row.provider)}</td>
        <td>${escapeHtml(row.error_code || "")}</td><td>${row.is_fallback ? "да" : "нет"}</td></tr>`).join("")
        || '<tr><td colspan="5" class="muted">Ошибок нет</td></tr>'}
      </tbody></table>`;
}

function formatSttSeconds(value) {
  const seconds = Number(value || 0);
  return Number.isFinite(seconds)
    ? seconds.toLocaleString("ru-RU", { maximumFractionDigits: 3 })
    : "0";
}
