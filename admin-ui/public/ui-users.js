/**
 * Разделы «Пользователи», «Безопасность и ключи» и «Журнал событий».
 */
const USER_STATE_LABELS = {
  active: "Активен",
  paused: "На паузе",
  onboarding: "Знакомство",
  blocked: "Заблокирован",
};

function userTitle(user) {
  const name = [user.first_name, user.username ? `@${user.username}` : ""]
    .filter(Boolean).join(" ");
  return name || `id ${user.telegram_id}`;
}

async function loadUsers() {
  const form = $("#users-filter-form");
  const params = new URLSearchParams();
  const query = form.elements.query.value.trim();
  if (query) params.set("query", query);
  if (form.elements.state.value) params.set("state", form.elements.state.value);
  if (form.elements.blocked.value) params.set("blocked", form.elements.blocked.value);

  const { payload } = await request(`/users?${params.toString()}`);
  state.users = payload.users;

  $("#users-body").innerHTML = payload.users.length
    ? payload.users.map((user) => `
      <tr class="user-row" data-user="${escapeHtml(user.id)}">
        <td><strong>${escapeHtml(userTitle(user))}</strong><br><span class="muted">${escapeHtml(user.telegram_id)}</span></td>
        <td>${user.is_blocked
          ? '<span class="pill-blocked">Заблокирован</span>'
          : escapeHtml(USER_STATE_LABELS[user.state] || user.state)}</td>
        <td>${escapeHtml(user.plan)}<br><span class="muted">${escapeHtml(user.subscription_status)}</span></td>
        <td>${escapeHtml(user.message_count ?? 0)}</td>
        <td>${escapeHtml(localDate(user.last_seen_at || user.last_message_at))}</td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="muted">Ничего не найдено.</td></tr>';

  $("#users-total").textContent = payload.total
    ? `Показано ${payload.users.length} из ${payload.total}.`
    : "Пользователей пока нет.";
}

function quotaRows(quotas) {
  if (!quotas.length) return '<p class="muted">Квоты для тарифа не заданы.</p>';
  return `<table class="mini-table"><thead><tr><th>Метрика</th><th>Период</th><th>Использовано</th><th>Осталось</th></tr></thead><tbody>${
    quotas.map((q) => `<tr><td>${escapeHtml(q.metric)}</td><td>${escapeHtml(q.period)}</td><td>${escapeHtml(q.used)} из ${q.limit_value < 0 ? "∞" : escapeHtml(q.limit_value)}</td><td>${q.remaining === null ? "∞" : escapeHtml(q.remaining)}</td></tr>`).join("")
  }</tbody></table>`;
}

async function openUserCard(id) {
  const { payload } = await request(`/users/${id}`);
  const user = payload.user;
  state.currentUser = payload;

  $("#user-card").hidden = false;
  $("#user-card-title").textContent = userTitle(user);
  $("#user-card-subtitle").textContent =
    `telegram_id ${user.telegram_id} · ${user.timezone} · язык ${user.language_code}`;

  const canWrite = ["owner", "admin"].includes(state.me.role);
  const canNote = ["owner", "admin", "operator"].includes(state.me.role);

  $("#user-card-body").innerHTML = `
    <div class="user-grid">
      <div>
        <h4>Состояние</h4>
        <dl class="kv">
          <dt>Состояние</dt><dd>${escapeHtml(USER_STATE_LABELS[user.state] || user.state)}</dd>
          <dt>Доступ</dt><dd>${user.is_blocked ? "заблокирован" : "открыт"}</dd>
          <dt>Тариф</dt><dd>${escapeHtml(user.plan)} (${escapeHtml(user.subscription_status)})</dd>
          <dt>Оплачен до</dt><dd>${escapeHtml(localDate(user.current_period_end))}</dd>
          <dt>Регистрация</dt><dd>${escapeHtml(localDate(user.created_at))}</dd>
          <dt>Последняя активность</dt><dd>${escapeHtml(localDate(user.last_seen_at))}</dd>
          <dt>Сообщений</dt><dd>${escapeHtml(user.message_count ?? 0)}</dd>
          <dt>Обновлений Telegram</dt><dd>${escapeHtml(payload.activity?.updates_total ?? 0)} (сбоев ${escapeHtml(payload.activity?.updates_failed ?? 0)})</dd>
        </dl>
      </div>
      <div>
        <h4>Квоты на сегодня</h4>
        ${quotaRows(payload.quotas)}
        <h4>Настройки общения</h4>
        ${payload.preferences ? `<dl class="kv">
          <dt>Режим ответа</dt><dd>${escapeHtml(payload.preferences.response_mode)}</dd>
          <dt>Роль Евы</dt><dd>${escapeHtml(payload.preferences.agent_mode)}</dd>
          <dt>Инициативные сообщения</dt><dd>${payload.preferences.heartbeat_enabled ? "включены" : "выключены"}</dd>
        </dl>` : '<p class="muted">Пользователь ничего не настраивал.</p>'}
      </div>
    </div>

    ${payload.crisis_events.length ? `<div class="user-block">
      <h4>События безопасности</h4>
      <p class="block-caption">Только метаданные: severity и время. Текст обращения не показывается и не выгружается.</p>
      <table class="mini-table"><thead><tr><th>Когда</th><th>Уровень</th><th>Обработано</th></tr></thead><tbody>${
        payload.crisis_events.map((e) => `<tr><td>${escapeHtml(localDate(e.created_at))}</td><td>${escapeHtml(e.severity)}</td><td>${e.handled ? escapeHtml(localDate(e.handled_at)) : "нет"}</td></tr>`).join("")
      }</tbody></table>
    </div>` : ""}

    ${canWrite ? `<div class="user-block">
      <h4>Действия</h4>
      <div class="form-actions">
        ${user.is_blocked
          ? `<button class="button secondary" data-action="unblock" data-user="${escapeHtml(user.id)}" type="button">Разблокировать</button>`
          : `<button class="button ghost" data-action="block" data-user="${escapeHtml(user.id)}" type="button">Заблокировать</button>`}
        ${user.state === "paused"
          ? `<button class="button ghost" data-action="activate" data-user="${escapeHtml(user.id)}" type="button">Снять паузу</button>`
          : user.state === "active"
            ? `<button class="button ghost" data-action="pause" data-user="${escapeHtml(user.id)}" type="button">Поставить на паузу</button>`
            : ""}
        <button class="button ghost" data-action="conversation" data-user="${escapeHtml(user.id)}" type="button">Показать переписку</button>
      </div>
    </div>` : ""}

    <div class="user-block">
      <h4>Заметки оператора</h4>
      ${canNote ? `<form id="user-note-form" data-user="${escapeHtml(user.id)}">
        <label>Новая заметка<textarea name="note" rows="2" maxlength="4000" placeholder="Что важно помнить об этом пользователе"></textarea></label>
        <button class="button secondary" type="submit">Добавить</button>
      </form>` : ""}
      ${payload.notes.length ? `<ul class="note-list">${
        payload.notes.map((n) => `<li><span class="muted">${escapeHtml(localDate(n.created_at))} · ${escapeHtml(n.actor_name)}</span><p>${escapeHtml(n.note)}</p></li>`).join("")
      }</ul>` : '<p class="muted">Заметок пока нет.</p>'}
    </div>

    <div class="user-block" id="user-conversation"></div>
  `;
  $("#user-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * Переписка загружается только по явной кнопке и под sudo: открыть личный
 * разговор — осознанное действие, а не побочный эффект просмотра карточки.
 * Каждое открытие попадает в журнал (кто и чью, без текста).
 */
function showConversation(id) {
  askSudo({
    scope: "users:messages",
    title: "Открыть переписку",
    description: "Личный разговор пользователя с Евой. Факт открытия будет записан в журнал событий.",
    action: async () => {
      const { payload } = await request(`/users/${id}/conversation?limit=100`);
      const target = $("#user-conversation");
      const messages = payload.messages.map((message) => {
        const role = message.role === "user" ? "Пользователь" : "Ева";
        const text = typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? message);
        return `<li class="msg msg-${escapeHtml(message.role ?? "other")}"><span class="muted">${escapeHtml(role)} · ${escapeHtml(localDate(message.created_at || message.timestamp))}</span><p>${escapeHtml(text)}</p></li>`;
      }).join("");

      target.innerHTML = `
        <h4>Переписка</h4>
        ${payload.messages_error
          ? `<p class="warn-value">Сообщения недоступны: ${escapeHtml(payload.messages_error)}.</p>`
          : ""}
        ${messages ? `<ul class="msg-list">${messages}</ul>` : '<p class="muted">Сообщений нет.</p>'}`;
      target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
  });
}

function setUserBlocked(id, blocked) {
  askSudo({
    scope: "users:write",
    title: blocked ? "Заблокировать пользователя" : "Разблокировать пользователя",
    description: blocked
      ? "Ева перестанет отвечать и не будет писать сама. Выставляются оба признака сразу."
      : "Доступ вернётся, состояние станет «активен».",
    action: async () => {
      await request(`/users/${id}/${blocked ? "block" : "unblock"}`, { method: "POST" });
      toast(blocked ? "Пользователь заблокирован" : "Пользователь разблокирован");
      await loadUsers();
      await openUserCard(id);
    },
  });
}

async function setUserState(id, userState) {
  await request(`/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ state: userState }),
  });
  toast(userState === "paused" ? "Пользователь на паузе" : "Пауза снята");
  await loadUsers();
  await openUserCard(id);
}

async function addUserNote(form) {
  const note = form.elements.note.value.trim();
  if (!note) {
    toast("Заметка пустая", true);
    return;
  }
  await request(`/users/${form.dataset.user}/notes`, {
    method: "POST",
    headers: { "Idempotency-Key": `note-${form.dataset.user}-${Date.now()}` },
    body: JSON.stringify({ note }),
  });
  toast("Заметка добавлена");
  await openUserCard(form.dataset.user);
}

async function loadSecrets() {
  if (!["owner", "admin"].includes(state.me.role)) {
    $("#secrets-list").innerHTML = '<article class="secret-card">Для просмотра метаданных секретов нужна роль owner или admin.</article>';
    $("#telegram-tokens-card").hidden = true;
    return;
  }
  const { payload } = await request("/secrets");
  state.secrets = payload.secrets;
  renderSecrets();
  await loadTelegramTokens();
}

/**
 * Боты Евы.
 *
 * Токен Telegram — это личность бота, а не взаимозаменяемый ключ: у
 * каждого свой @username, свои диалоги и свой вебхук. Поэтому здесь не
 * ротация, а выбор: сохранённых несколько, активен ровно один.
 *
 * Сами токены не показываются никогда — как и остальные секреты, они
 * write-only. Бот узнаётся по метке и @username, и ни то, ни другое
 * секретом не является.
 */
async function loadTelegramTokens() {
  const card = $("#telegram-tokens-card");
  if (!card) return;
  card.hidden = false;
  const { payload } = await request("/telegram/tokens").catch(() => ({ payload: null }));
  if (!payload) {
    $("#telegram-tokens-list").innerHTML = '<p class="muted">Не удалось получить список ботов.</p>';
    return;
  }
  state.telegramTokens = payload.tokens || [];
  renderTelegramTokens(payload.limit || 5);
}

function renderTelegramTokens(limit) {
  const tokens = state.telegramTokens || [];
  $("#telegram-tokens-list").innerHTML = tokens.length
    ? tokens.map((token) => `
        <article class="failure-row" data-telegram-token="${escapeHtml(token.id)}">
          <div class="failure-head">
            <span class="status-dot color-${token.is_active ? "green" : "gray"}"></span>
            <div class="failure-title">
              <strong>${escapeHtml(token.label)}</strong>
              <small>@${escapeHtml(token.bot_username)} · добавлен ${escapeHtml(localDate(token.created_at))}</small>
            </div>
            <span class="status-pill state-${token.is_active ? "green" : "gray"}">${token.is_active ? "активен" : "сохранён"}</span>
          </div>
          ${token.is_active ? "" : `<div class="provider-route-actions">
            <button class="button tiny secondary" data-telegram-action="activate" data-telegram-id="${escapeHtml(token.id)}">Сделать активным</button>
            <button class="button tiny danger-outline" data-telegram-action="remove" data-telegram-id="${escapeHtml(token.id)}">Удалить</button>
          </div>`}
        </article>`).join("")
    : '<p class="muted">Ни одного бота не сохранено. Активный токен при этом может быть задан установщиком — он продолжает работать.</p>';
  const form = $("#telegram-token-form");
  // Предел объявлен сервером: форма просто перестаёт предлагать то,
  // что всё равно будет отвергнуто.
  if (form) form.hidden = tokens.length >= limit;
}

/**
 * Токен бота — секрет, и маршруты требуют sudo-грант.
 *
 * Прежде окно пароля не открывалось вовсе: форма отправляла запрос сразу
 * и получала «для операции требуется повторное подтверждение пароля».
 * Со стороны это выглядело так, будто токен не сохраняется, — и он
 * действительно не сохранялся.
 *
 * Окно sudo несёт и предупреждение: у переезда есть последствия, а
 * второе окно подряд к одному действию человек читать не станет.
 */
function telegramTokenAction(action, id) {
  const token = (state.telegramTokens || []).find((item) => item.id === id);
  if (!token) return;
  if (action === "remove") {
    askSudo({
      scope: "secrets:write",
      title: `Удалить бота «${token.label}»?`,
      description: `@${token.bot_username} исчезнет из списка. Сам бот в Telegram останется, но его токен придётся вводить заново.`,
      action: async () => {
        await request(`/telegram/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast("Бот удалён из списка");
        await loadTelegramTokens();
      },
    });
    return;
  }
  askSudo({
    scope: "secrets:write",
    title: `Перевести Еву на @${token.bot_username}?`,
    description: "Вебхук снимется у прежнего бота и встанет новому. Люди, писавшие прежнему, к новому"
      + " сами не перейдут: им придётся начать с ним диалог. Смена действует сразу — перезапускать"
      + " ничего не нужно.",
    action: async () => {
      const { payload } = await request(`/telegram/tokens/${encodeURIComponent(id)}/activate`, { method: "POST" });
      // Переезд состоялся в любом случае: вебхук переставлен, выбор
      // записан. Разница в том, дошёл ли токен до работающего сервиса —
      // и если нет, человеку нужно знать, что делать руками, иначе он
      // увидит бота, который принимает сообщения, но отвечает прежним.
      toast(payload.applied_live
        ? `Активен @${token.bot_username}. Смена уже действует.`
        : `Активен @${token.bot_username}, но применить не удалось: ${payload.apply_error || "сервис операций недоступен"}.`
          + ` Пропишите токен в .env и выполните: ${payload.restart_required || "docker compose up -d eva-agent-service"}`,
        !payload.applied_live);
      await loadTelegramTokens();
    },
  });
}

function saveTelegramToken(form) {
  const label = form.elements.label.value.trim();
  const token = form.elements.token.value.trim();
  if (!label || !token) {
    toast("Заполните метку и токен", true);
    return;
  }
  askSudo({
    scope: "secrets:write",
    title: "Сохранить бота",
    description: `«${label}» будет добавлен в список. Токен проверяется у Telegram до записи и наружу больше не выходит.`,
    action: async () => {
      await request("/telegram/tokens", {
        method: "POST",
        body: JSON.stringify({ label, token }),
      });
      // Поле очищается только после успеха: иначе отклонённый токен
      // пришлось бы искать и вводить заново.
      form.reset();
      toast("Бот сохранён. Чтобы перевести Еву на него, нажмите «Сделать активным».");
      await loadTelegramTokens();
    },
  });
}

/**
 * Ключи, которые администратор действительно задаёт руками: внешние
 * токены и пароли внешних систем. Всё остальное — пароли базы, внутренние
 * секреты между контейнерами — создаёт установщик, и менять их из панели
 * значит развалить работающую установку.
 */
const ADMIN_FACING_SECRETS = new Set([
  "sec_eva_telegram_bot_token",
  "sec_media_asr_api_key",
  "sec_media_tts_api_key",
  "sec_eva_llm_api_key",
  // Ключ эмбеддингов при установке копируется из ключа LLM, но провайдер
  // у них может быть разный — тогда его меняют отдельно.
  "sec_eva_embedding_api_key",
]);

function renderSecrets() {
  const all = state.secrets || [];
  const shown = state.showAllSecrets ? all : all.filter((item) => ADMIN_FACING_SECRETS.has(item.secret_ref));
  const hidden = all.length - shown.length;
  $("#toggle-all-secrets").textContent = state.showAllSecrets
    ? "Показать только основные"
    : `Показать все (${all.length})`;
  $("#toggle-all-secrets").hidden = all.length === 0;
  const notice = !state.showAllSecrets && hidden > 0
    ? `<p class="muted secrets-hint">Скрыто ${hidden} служебных ключ(ей): их создаёт установщик, и смена вручную ломает связь между контейнерами.</p>`
    : "";
  $("#secrets-list").innerHTML = notice + (shown.length
    ? shown.map((item) => `
      <article class="secret-card">
        <div class="secret-meta">
          <span class="status-pill">${item.configured ? "Настроен" : "Не настроен"}</span>
          <strong class="secret-ref">${escapeHtml(item.secret_ref)}</strong>
          <span>Создан: ${escapeHtml(localDate(item.created_at))}</span>
          <span>Ротация: ${escapeHtml(localDate(item.last_rotated_at))}</span>
          <span>Используют: ${escapeHtml(item.used_by.join(", ") || "не указано")}</span>
        </div>
        <form class="secret-form" data-secret="${escapeHtml(item.secret_ref)}">
          <label>Новое значение<input name="value" type="password" autocomplete="new-password" placeholder="Только новое значение" required></label>
          <label>Сервисы через запятую<input name="used_by" value="${escapeHtml(item.used_by.join(", "))}" required></label>
          <button class="button secondary" type="submit">Сменить ключ</button>
        </form>
      </article>`).join("")
    : '<article class="secret-card"><div><h3>Нет ключей для показа</h3><p class="muted">Либо секреты ещё не импортированы, либо все они служебные — нажмите «Показать все».</p></div></article>');
}

/** Пароль архива backup. Значение уходит на сервер и обратно не возвращается. */
async function setBackupPassword(password, form) {
  await new Promise((resolve, reject) => {
    askSudo({
      scope: "secrets:write",
      title: password ? "Задать пароль архива backup" : "Вернуться к мастер-ключу",
      description: password
        ? "Новые архивы будут шифроваться этим паролем. Без него восстановление станет невозможным — сохраните его вне сервера."
        : "Новые архивы снова будут шифроваться мастер-ключом Secret Store.",
      action: async () => {
        try {
          const { payload } = await request("/backups/password", {
            method: "PUT",
            body: JSON.stringify({ password }),
          });
          form.reset();
          toast(payload.configured
            ? "Пароль архива задан. Сохраните его вне сервера — восстановить его нельзя."
            : "Пароль снят, архивы шифруются мастер-ключом");
          resolve();
        } catch (error) {
          reject(error);
          throw error;
        }
      },
    });
  }).catch(handleError);
}

async function writeSecret(form) {
  const valueInput = form.elements.value;
  const usedBy = form.elements.used_by.value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  await request(`/secrets/${encodeURIComponent(form.dataset.secret)}`, {
    method: "PUT",
    body: JSON.stringify({ value: valueInput.value, used_by: usedBy }),
  });
  valueInput.value = "";
  toast("Секрет сохранён; его значение больше не доступно интерфейсу");
  await loadSecrets();
}

async function loadAudit() {
  const { payload } = await request("/audit?limit=150");
  $("#audit-body").innerHTML = payload.events.map((event) => `
    <tr>
      <td>${escapeHtml(localDate(event.at))}</td>
      <td>${escapeHtml(event.actor)}${event.role ? `<br><span class="technical">${escapeHtml(event.role)}</span>` : ""}</td>
      <td>${escapeHtml(event.operation)}</td>
      <td>${escapeHtml(event.target || "—")}</td>
      <td><span class="result ${escapeHtml(event.result)}">${escapeHtml(event.result)}</span></td>
      <td class="technical">${escapeHtml(event.request_id)}</td>
    </tr>`).join("");
}

$("#reload-users").addEventListener("click", () => loadUsers().catch(handleError));
$("#users-filter-form").addEventListener("submit", (event) => {
  event.preventDefault();
  loadUsers().catch(handleError);
});
$("#users-body").addEventListener("click", (event) => {
  const row = event.target.closest(".user-row");
  if (row) openUserCard(row.dataset.user).catch(handleError);
});
$("#close-user-card").addEventListener("click", () => {
  $("#user-card").hidden = true;
});
$("#user-card-body").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action][data-user]");
  if (!button) return;
  const id = button.dataset.user;
  const actions = {
    block: () => setUserBlocked(id, true),
    unblock: () => setUserBlocked(id, false),
    pause: () => setUserState(id, "paused").catch(handleError),
    activate: () => setUserState(id, "active").catch(handleError),
    conversation: () => showConversation(id),
  };
  actions[button.dataset.action]?.();
});
$("#user-card-body").addEventListener("submit", (event) => {
  if (event.target.id !== "user-note-form") return;
  event.preventDefault();
  addUserNote(event.target).catch(handleError);
});
$("#reload-secrets").addEventListener("click", () => loadSecrets().catch(handleError));
$("#reload-retention").addEventListener("click", () => loadRetentionPreview().catch(handleError));
$("#toggle-all-secrets").addEventListener("click", () => {
  state.showAllSecrets = !state.showAllSecrets;
  renderSecrets();
});
$("#backup-password-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = form.elements.password.value;
  // Пустая отправка означала бы снятие пароля — то же разрушительное
  // действие, что и кнопка рядом, но в обход её подтверждения.
  if (!password) {
    toast("Введите пароль или нажмите «Вернуться к мастер-ключу»", true);
    return;
  }
  if (password !== form.elements.confirm.value) {
    toast("Пароли не совпадают", true);
    return;
  }
  setBackupPassword(password, form);
});
$("#clear-backup-password").addEventListener("click", () => {
  askConfirm({
    title: "Вернуться к мастер-ключу?",
    description: "Новые архивы снова будут шифроваться мастер-ключом Secret Store. Уже созданные с паролем архивы останутся зашифрованными им — сохраните пароль, пока они нужны.",
    expected: "МАСТЕР-КЛЮЧ",
    action: async () => await setBackupPassword("", $("#backup-password-form")),
  });
});
$("#secrets-list").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  askSudo({
    scope: "secrets:write",
    title: "Сменить системный ключ",
    description: "Новое значение будет зашифровано; прежнее больше не будет доступно.",
    action: async () => await writeSecret(form),
  });
});
$("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const data = new FormData(formElement);
  try {
    await request("/auth/password", {
      method: "POST",
      body: JSON.stringify({
        current_password: data.get("current_password"),
        new_password: data.get("new_password"),
      }),
    });
    formElement.reset();
    toast("Пароль изменён");
  } catch (error) {
    handleError(error);
  }
});
$("#reload-audit").addEventListener("click", () => loadAudit().catch(handleError));

$("#telegram-tokens-list")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-telegram-action]");
  if (!button) return;
  telegramTokenAction(button.dataset.telegramAction, button.dataset.telegramId);
});
$("#telegram-token-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveTelegramToken(event.target);
});
