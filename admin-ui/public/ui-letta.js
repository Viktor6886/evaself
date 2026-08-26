/**
 * Раздел «Letta»: runtime, диалоги, расход контекста и журнал операций.
 *
 * Прежняя консоль жила на своём поддомене за HTTP Basic Auth и ходила в
 * те же внутренние маршруты мимо ролей, sudo и аудита. Здесь тот же набор
 * операций работает под сессией панели: чтение доступно всем вошедшим,
 * правка настроек SDK — owner и admin под sudo, а личная переписка — под
 * отдельным грантом и с записью в журнал событий.
 *
 * Стриминговый чат от лица агента сюда не переехал намеренно: человеку
 * такое сообщение неотличимо от самой Евы.
 */
const LETTA_TABS = ["runtime", "conversations", "context", "audit"];

function showLettaTab(name) {
  state.lettaTab = name;
  document.querySelectorAll("[data-letta-tab]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.lettaTab === name);
  });
  for (const tab of LETTA_TABS) {
    const node = $(`#letta-tab-${tab}`);
    if (node) node.hidden = tab !== name;
  }
  if (name === "context") loadLettaContext().catch(handleError);
  if (name === "audit") loadLettaAudit().catch(handleError);
}

async function loadLetta() {
  const { payload } = await request("/panel/letta");
  state.letta = payload;

  const system = payload.system || {};
  const stats = payload.stats || {};
  const cells = [
    ["Версия", system.version || "—"],
    ["Runtime", system.runtime || "—"],
    ["Настройка", system.setup_complete ? "завершена" : "неполная"],
    ["Агентов", String((payload.agents || []).length)],
    ["Пользователей", String(stats.users ?? "—")],
    ["Сообщений", String(stats.messages ?? "—")],
  ];
  $("#letta-summary").innerHTML = cells
    .map(([label, value]) => `
      <div class="host-cell"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");

  renderLettaSettings(payload.settings);
  $("#letta-agents-body").innerHTML = (payload.agents || []).length
    ? payload.agents.map((agent) => `
      <tr>
        <td class="technical">${escapeHtml(agent.id ?? "—")}</td>
        <td>${escapeHtml(agent.name ?? "—")}</td>
        <td>${escapeHtml(agent.model ?? agent.model_handle ?? "—")}</td>
        <td>${agent.hidden ? "да" : "нет"}</td>
      </tr>`).join("")
    : '<tr><td colspan="4" class="muted">App Server не вернул агентов.</td></tr>';

  if (payload.errors?.length) {
    toast(`Часть данных Letta недоступна: ${payload.errors.join(", ")}`, true);
  }
}

/**
 * Настройки SDK показываются как список «поле — значение», а не формой с
 * тремя десятками полей: правится здесь только то, что администратор
 * действительно меняет, остальное читается.
 */
function renderLettaSettings(settings) {
  const node = $("#letta-settings");
  if (!settings) {
    node.innerHTML = '<p class="muted">Настройки SDK недоступны.</p>';
    return;
  }
  const canWrite = ["owner", "admin"].includes(state.me.role);
  const rows = [
    ["Режим разрешений", settings.permissionMode ?? settings.permission_mode ?? "—"],
    ["MemFS", (settings.memfs_enabled ?? settings.memfsEnabled) ? "включён" : "выключен"],
    ["Рефлексия", JSON.stringify(settings.dreaming ?? null)],
    ["Уровень reasoning", settings.reasoning_effort ?? "—"],
    ["Окно контекста", settings.default_context_window ?? "по умолчанию модели"],
    ["Размер пула сессий", settings.session_pool_size ?? "—"],
    ["Таймаут хода, мс", settings.turn_timeout_ms ?? "—"],
    ["Таймаут App Server, мс", settings.app_server_request_timeout_ms ?? "—"],
  ];
  node.innerHTML = `
    <dl class="kv">${rows
      .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`)
      .join("")}</dl>
    ${canWrite ? `<form id="letta-settings-form">
      <div class="field-row">
        <label>Окно контекста<input name="default_context_window" inputmode="numeric" value="${escapeHtml(settings.default_context_window ?? "")}" placeholder="пусто — по умолчанию"></label>
        <label>Таймаут хода, мс<input name="turn_timeout_ms" inputmode="numeric" value="${escapeHtml(settings.turn_timeout_ms ?? "")}"></label>
        <label>Пул сессий<input name="session_pool_size" inputmode="numeric" value="${escapeHtml(settings.session_pool_size ?? "")}"></label>
      </div>
      <div class="form-actions"><button class="button secondary" type="submit">Сохранить настройки SDK</button></div>
    </form>` : '<p class="block-caption">Для правки настроек SDK нужна роль owner или admin.</p>'}`;
}

function saveLettaSettings(form) {
  const patch = {};
  for (const field of ["default_context_window", "turn_timeout_ms", "session_pool_size"]) {
    const raw = form.elements[field].value.trim();
    if (raw === "") continue;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) {
      toast(`${field}: нужно целое число`, true);
      return;
    }
    patch[field] = value;
  }
  if (Object.keys(patch).length === 0) {
    toast("Нечего менять", true);
    return;
  }
  askSudo({
    scope: "settings:write",
    title: "Настройки SDK",
    description: "Новые значения применяются к сессиям, которые откроются после сохранения.",
    action: async () => {
      await request("/panel/letta/settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      toast("Настройки SDK сохранены");
      await loadLetta();
    },
  });
}

async function loadLettaConversations(agentId) {
  const { payload } = await request(
    `/panel/letta/agents/${encodeURIComponent(agentId)}/conversations`,
  );
  const conversations = payload.conversations ?? [];
  state.lettaAgentId = agentId;
  $("#letta-conversations-body").innerHTML = conversations.length
    ? conversations.map((row) => {
      const id = row.id ?? row.conversation_id ?? "";
      return `<tr>
        <td class="technical">${escapeHtml(id)}<br>${escapeHtml(row.summary ?? row.title ?? "")}</td>
        <td>${row.archived ? "архив" : "активен"}</td>
        <td>${escapeHtml(row.message_count ?? row.messageCount ?? "—")}</td>
        <td class="row-actions">
          <button class="button tiny ghost" data-letta-messages="${escapeHtml(id)}" type="button">История</button>
          <button class="button tiny ghost" data-letta-abort="${escapeHtml(id)}" type="button">Остановить ход</button>
          <button class="button tiny ghost" data-letta-archive="${escapeHtml(id)}" data-archived="${row.archived ? "1" : "0"}" type="button">${row.archived ? "Вернуть" : "В архив"}</button>
        </td>
      </tr>`;
    }).join("")
    : '<tr><td colspan="4" class="muted">У агента нет диалогов.</td></tr>';
}

/**
 * История диалога.
 *
 * Личная переписка: открывается только по явной кнопке и под отдельным
 * подтверждением, каждое открытие попадает в журнал событий (кто и чью,
 * без текста).
 */
function showLettaMessages(conversationId) {
  askSudo({
    scope: "users:messages",
    title: "Открыть переписку",
    description: "Личный разговор человека с Евой. Факт открытия будет записан в журнал событий.",
    action: async () => {
      const { payload } = await request(
        `/panel/letta/conversations/${encodeURIComponent(conversationId)}/messages?limit=60`,
      );
      const messages = payload.messages ?? [];
      $("#letta-messages-card").hidden = false;
      $("#letta-messages").innerHTML = messages.length
        ? `<ul class="msg-list">${messages.map((message) => {
          const role = message.role === "user" ? "Пользователь" : "Ева";
          const text = typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? message);
          return `<li class="msg msg-${escapeHtml(message.role ?? "other")}">
            <span class="muted">${escapeHtml(role)} · ${escapeHtml(localDate(message.created_at || message.timestamp))}</span>
            <p>${escapeHtml(text)}</p></li>`;
        }).join("")}</ul>`
        : '<p class="muted">Сообщений нет.</p>';
      $("#letta-messages-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
  });
}

function abortLettaTurn(conversationId) {
  askConfirm({
    title: "Остановить ход?",
    description: "Идущий ответ прервётся. Человек увидит, что Ева замолчала на середине.",
    expected: conversationId,
    action: async () => {
      await request(`/panel/letta/conversations/${encodeURIComponent(conversationId)}/abort`, {
        method: "POST",
        body: JSON.stringify({ confirm: conversationId }),
      });
      toast("Ход остановлен");
    },
  });
}

function archiveLettaConversation(conversationId, archived) {
  const run = async () => {
    await request(`/panel/letta/conversations/${encodeURIComponent(conversationId)}/archive`, {
      method: "POST",
      body: JSON.stringify({ archived, ...(archived ? { confirm: conversationId } : {}) }),
    });
    toast(archived ? "Диалог архивирован" : "Диалог возвращён");
    if (state.lettaAgentId) await loadLettaConversations(state.lettaAgentId);
  };
  if (!archived) {
    run().catch(handleError);
    return;
  }
  askConfirm({
    title: "Архивировать диалог?",
    description: "Архивный диалог перестаёт быть действующим для своего назначения. Обратимо.",
    expected: conversationId,
    action: run,
  });
}

async function loadLettaContext() {
  const { payload } = await request("/panel/letta/context");
  const rows = payload.conversations ?? [];
  $("#letta-context-body").innerHTML = rows.length
    ? rows.map((row) => `
      <tr>
        <td class="technical">${escapeHtml(row.agent_id)}</td>
        <td class="technical">${escapeHtml(row.conversation_id)}</td>
        <td>${escapeHtml(row.message_count)}</td>
        <td>${escapeHtml(row.context_window_limit || "по умолчанию")}</td>
      </tr>`).join("")
    : '<tr><td colspan="4" class="muted">Диалогов нет.</td></tr>';
}

async function loadLettaAudit() {
  const { payload } = await request("/panel/letta/audit?limit=100");
  const events = payload.events ?? [];
  $("#letta-audit-body").innerHTML = events.length
    ? events.map((event) => `
      <tr>
        <td>${escapeHtml(localDate(event.at ?? event.created_at))}</td>
        <td>${escapeHtml(event.action)}</td>
        <td class="technical">${escapeHtml(event.target_id ?? event.targetId ?? "—")}</td>
        <td>${escapeHtml(event.status ?? "ok")}</td>
      </tr>`).join("")
    : '<tr><td colspan="4" class="muted">Операций не было.</td></tr>';
}

$("#reload-letta").addEventListener("click", () => loadLetta().catch(handleError));
$("#letta-test").addEventListener("click", () => {
  request("/panel/letta/test", { method: "POST" })
    .then(({ payload }) => toast(payload.result?.result?.ok === false
      ? "App Server не отвечает"
      : "App Server отвечает", payload.result?.result?.ok === false))
    .catch(handleError);
});
document.querySelectorAll("[data-letta-tab]").forEach((tab) => {
  tab.addEventListener("click", () => showLettaTab(tab.dataset.lettaTab));
});
$("#letta-settings").addEventListener("submit", (event) => {
  if (event.target.id !== "letta-settings-form") return;
  event.preventDefault();
  saveLettaSettings(event.target);
});
$("#letta-conversations-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const agentId = event.currentTarget.elements.agent_id.value.trim();
  if (!agentId) {
    toast("Укажите agent_id", true);
    return;
  }
  loadLettaConversations(agentId).catch(handleError);
});
$("#letta-conversations-body").addEventListener("click", (event) => {
  const messages = event.target.closest("[data-letta-messages]");
  if (messages) {
    showLettaMessages(messages.dataset.lettaMessages);
    return;
  }
  const abort = event.target.closest("[data-letta-abort]");
  if (abort) {
    abortLettaTurn(abort.dataset.lettaAbort);
    return;
  }
  const archive = event.target.closest("[data-letta-archive]");
  if (archive) {
    // Состояние берётся из атрибута, а не из подписи кнопки: сравнение с
    // текстом ломается от любой правки формулировки, и ломается молча —
    // «Вернуть» начинает архивировать.
    archiveLettaConversation(archive.dataset.lettaArchive, archive.dataset.archived !== "1");
  }
});
