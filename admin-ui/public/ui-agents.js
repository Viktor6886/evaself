/**
 * Раздел «Агенты»: список с поиском, карточка, создание, изменение и
 * подтверждаемое удаление.
 *
 * Всё изменяющее уходит в `/panel/agents*`, а оттуда — в
 * eva-agent-service тем же путём, каким агент заводится при первом
 * сообщении человека в Telegram. Панель не знает про Letta App Server и
 * не обращается к нему: второго механизма создания агентов нет.
 */
const AGENT_SYNC_LABELS = {
  ok: "доставлена",
  degraded: "отстала",
  unsupported: "недоступна",
};

function agentTitle(agent) {
  return agent.agentName || agent.agentId;
}

function ownerTitle(owner) {
  if (!owner) return "—";
  const name = [owner.firstName, owner.username ? `@${owner.username}` : ""]
    .filter(Boolean).join(" ");
  return name || `telegram ${owner.telegramId}`;
}

/**
 * Отметка доставки канонической персоны.
 *
 * Именно она отвечает на вопрос «этот агент уже говорит новой персоной
 * или ещё старой». Без неё раздел «Персона и промпт» показывал бы общий
 * счётчик, а к какому агенту он относится — оставалось бы гадать.
 */
function personaCell(agent) {
  if (!agent.canonicalSyncStatus) return '<span class="muted">нет отметки</span>';
  const label = AGENT_SYNC_LABELS[agent.canonicalSyncStatus] || agent.canonicalSyncStatus;
  const cls = agent.canonicalSyncStatus === "ok" ? "green" : "yellow";
  return `<span class="status-dot color-${cls}"></span> ${escapeHtml(label)}`
    + `<br><span class="technical">${escapeHtml(agent.personaVersion || "—")}</span>`;
}

async function loadAgents() {
  const form = $("#agents-filter-form");
  const params = new URLSearchParams();
  const query = form.elements.query.value.trim();
  if (query) params.set("query", query);
  if (form.elements.status.value) params.set("status", form.elements.status.value);

  const { payload } = await request(`/panel/agents?${params.toString()}`);
  state.agents = payload.agents;

  $("#agents-body").innerHTML = payload.agents.length
    ? payload.agents.map((agent) => `
      <tr class="agent-row" data-agent="${escapeHtml(agent.agentId)}">
        <td><strong>${escapeHtml(agentTitle(agent))}</strong><br><span class="technical">${escapeHtml(agent.agentId)}</span></td>
        <td>${escapeHtml(ownerTitle(agent.owner))}${agent.owner?.isBlocked ? '<br><span class="pill-blocked">Заблокирован</span>' : ""}</td>
        <td>${escapeHtml(agent.model || "по умолчанию")}</td>
        <td>${escapeHtml(agent.conversations)}</td>
        <td>${personaCell(agent)}</td>
        <td>${agent.activeTurns ? `<strong>${escapeHtml(agent.activeTurns)}</strong>` : "0"}</td>
      </tr>`).join("")
    : '<tr><td colspan="6" class="muted">Агентов не найдено.</td></tr>';

  $("#agents-total").textContent = payload.total
    ? `Показано ${payload.agents.length} из ${payload.total}.`
    : "Агентов пока нет.";
}

async function openAgentCard(id) {
  const { payload } = await request(`/panel/agents/${encodeURIComponent(id)}`);
  const agent = payload.agent;
  state.currentAgent = payload;

  $("#agent-card").hidden = false;
  $("#agent-card-title").textContent = agentTitle(agent);
  $("#agent-card-subtitle").textContent =
    `${agent.agentId} · владелец ${ownerTitle(agent.owner)} · ${agent.messageCount} сообщений`;

  const canWrite = ["owner", "admin"].includes(state.me.role);
  const live = payload.live || {};

  $("#agent-card-body").innerHTML = `
    ${payload.live_error
      ? `<p class="warn-value">Живое состояние Letta недоступно (${escapeHtml(payload.live_error)}). Показано то, что знает PostgreSQL.</p>`
      : ""}
    <div class="user-grid">
      <div>
        <h4>Состояние</h4>
        <dl class="kv">
          <dt>Состояние связки</dt><dd>${escapeHtml(agent.status)}</dd>
          <dt>Модель</dt><dd>${escapeHtml(agent.model || "по умолчанию")}</dd>
          <dt>Модель эмбеддингов</dt><dd>${escapeHtml(agent.embeddingModel || "—")}</dd>
          <dt>Диалогов</dt><dd>${escapeHtml(agent.conversations)}</dd>
          <dt>Незакончившихся ходов</dt><dd>${escapeHtml(agent.activeTurns)}</dd>
          <dt>Последнее сообщение</dt><dd>${escapeHtml(localDate(agent.lastMessageAt))}</dd>
          <dt>Версия персоны</dt><dd>${escapeHtml(agent.personaVersion || "—")}</dd>
          <dt>Синхронизация</dt><dd>${escapeHtml(AGENT_SYNC_LABELS[agent.canonicalSyncStatus] || "нет отметки")} ${agent.canonicalSyncAt ? `· ${escapeHtml(localDate(agent.canonicalSyncAt))}` : ""}</dd>
        </dl>
      </div>
      <div>
        <h4>В Letta App Server</h4>
        ${payload.live ? `<dl class="kv">
          <dt>Имя</dt><dd>${escapeHtml(live.name ?? "—")}</dd>
          <dt>Описание</dt><dd>${escapeHtml(live.description ?? "—")}</dd>
          <dt>Модель</dt><dd>${escapeHtml(live.model ?? live.model_handle ?? "—")}</dd>
          <dt>Скрыт</dt><dd>${live.hidden ? "да" : "нет"}</dd>
          <dt>Теги</dt><dd>${escapeHtml(Array.isArray(live.tags) ? live.tags.join(", ") : "—")}</dd>
        </dl>` : '<p class="muted">Нет живого состояния.</p>'}
        <p class="block-caption">Значений memory block и текста переписки здесь нет: они принадлежат Letta и читаются отдельно, под отдельным подтверждением.</p>
      </div>
    </div>

    <div class="user-block">
      <h4>Диалоги</h4>
      ${payload.conversations.length ? `<table class="mini-table">
        <thead><tr><th>Диалог</th><th>Назначение</th><th>Состояние</th><th>Сообщений</th></tr></thead>
        <tbody>${payload.conversations.map((row) => `<tr>
          <td class="technical">${escapeHtml(row.conversationId)}</td>
          <td>${escapeHtml(row.purpose || "—")}</td>
          <td>${escapeHtml(row.status)}</td>
          <td>${escapeHtml(row.messageCount)}</td>
        </tr>`).join("")}</tbody>
      </table>` : '<p class="muted">Диалогов нет.</p>'}
    </div>

    ${canWrite ? `<div class="user-block">
      <h4>Изменить</h4>
      <form id="agent-edit-form" data-agent="${escapeHtml(agent.agentId)}">
        <label>Имя агента<input name="name" value="${escapeHtml(live.name ?? agent.agentName ?? "")}" maxlength="100"></label>
        <label>Описание<input name="description" value="${escapeHtml(live.description ?? "")}" maxlength="1000"></label>
        <label>Модель<input name="model" value="${escapeHtml(live.model ?? agent.model ?? "")}" maxlength="300" placeholder="пусто — модель по умолчанию"></label>
        <label class="switch"><input type="checkbox" name="hidden" ${live.hidden ? "checked" : ""}><span>Скрыть агента в списках Letta</span></label>
        <div class="form-actions">
          <button class="button primary" type="submit">Сохранить</button>
        </div>
      </form>
      <p class="block-caption">Системный промпт здесь не правится: он общий для всех агентов и живёт в разделе «Персона и промпт».</p>
    </div>

    <div class="user-block">
      <h4>Удаление</h4>
      <p class="block-caption">Необратимо: вместе с агентом уходят его диалоги, история и блоки памяти. Отклоняется, пока идёт незакончившийся ход.</p>
      <div class="form-actions">
        <button class="button ghost" data-agent-action="delete" data-agent="${escapeHtml(agent.agentId)}" type="button">Удалить агента</button>
      </div>
    </div>` : ""}
  `;
  $("#agent-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function saveAgent(form) {
  const id = form.dataset.agent;
  // Пустые имя и модель не отправляются вовсе: у Letta это поля с
  // минимальной длиной, и пустая строка вернулась бы отказом «name должно
  // быть от 1 до 100» — то есть очистка поля выглядела бы поломкой
  // панели. Описание пустым быть может: им его и очищают.
  const patch = {
    description: form.elements.description.value.trim(),
    hidden: form.elements.hidden.checked,
  };
  const name = form.elements.name.value.trim();
  if (name) patch.name = name;
  const model = form.elements.model.value.trim();
  if (model) patch.model = model;
  await request(`/panel/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  toast("Агент изменён");
  await loadAgents();
  await openAgentCard(id);
}

/**
 * Удаление в два шага: сначала панель спрашивает у сервера, что мешает
 * прямо сейчас, и только потом показывает окно подтверждения. Иначе
 * администратор набирал бы идентификатор агента ради отказа «идёт ход».
 */
async function deleteAgent(id) {
  const { payload } = await request(`/panel/agents/${encodeURIComponent(id)}/deletion-preview`);
  if (!payload.deletable) {
    toast(`Нельзя удалить: незакончившихся ходов ${payload.blockingTurns.length}`, true);
    return;
  }
  askConfirm({
    title: "Удалить агента?",
    description: "Необратимо. Вместе с агентом уходят его диалоги, история сообщений и блоки памяти.",
    expected: id,
    action: () => new Promise((resolve, reject) => {
      askSudo({
        scope: "users:write",
        title: "Удаление агента",
        description: "Повторите пароль: действие необратимо и будет записано в журнал событий.",
        action: async () => {
          try {
            await request(`/panel/agents/${encodeURIComponent(id)}`, {
              method: "DELETE",
              body: JSON.stringify({ confirm: id }),
            });
            toast("Агент удалён");
            $("#agent-card").hidden = true;
            await loadAgents();
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

function createAgent(form) {
  const data = new FormData(form);
  const telegramId = String(data.get("telegram_id") || "").trim();
  if (!/^\d{1,19}$/.test(telegramId)) {
    toast("Telegram ID — целое число", true);
    return;
  }
  askSudo({
    scope: "users:write",
    title: "Создать агента",
    description: "Агент создаётся тем же путём Letta Agent SDK, что и при первом сообщении человека. Если агент уже есть, ничего не создастся.",
    action: async () => {
      const { payload } = await request("/panel/agents", {
        method: "POST",
        body: JSON.stringify({
          telegram_id: Number(telegramId),
          first_name: String(data.get("first_name") || "").trim() || undefined,
          username: String(data.get("username") || "").trim() || undefined,
        }),
      });
      $("#agent-create-dialog").close();
      form.reset();
      toast(payload.created ? "Агент создан" : "У этого человека агент уже был");
      await loadAgents();
      await openAgentCard(payload.agent_id);
    },
  });
}

$("#reload-agents").addEventListener("click", () => loadAgents().catch(handleError));
$("#agents-filter-form").addEventListener("submit", (event) => {
  event.preventDefault();
  loadAgents().catch(handleError);
});
$("#agents-body").addEventListener("click", (event) => {
  const row = event.target.closest(".agent-row");
  if (row) openAgentCard(row.dataset.agent).catch(handleError);
});
$("#close-agent-card").addEventListener("click", () => {
  $("#agent-card").hidden = true;
});
$("#agent-card-body").addEventListener("submit", (event) => {
  if (event.target.id !== "agent-edit-form") return;
  event.preventDefault();
  saveAgent(event.target).catch(handleError);
});
$("#agent-card-body").addEventListener("click", (event) => {
  const button = event.target.closest('[data-agent-action="delete"]');
  if (button) deleteAgent(button.dataset.agent).catch(handleError);
});
$("#new-agent").addEventListener("click", () => $("#agent-create-dialog").showModal());
$("#close-agent-create").addEventListener("click", () => $("#agent-create-dialog").close());
$("#agent-create-dialog").addEventListener("click", (event) => {
  if (event.target === $("#agent-create-dialog")) $("#agent-create-dialog").close();
});
$("#agent-create-form").addEventListener("submit", (event) => {
  event.preventDefault();
  createAgent(event.currentTarget);
});
