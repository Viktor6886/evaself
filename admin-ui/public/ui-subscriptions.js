/**
 * Раздел «Подписки»: свод по установке и карточка доступа одного
 * человека — назначить, сменить тариф, продлить, отменить, снять ручное
 * решение.
 *
 * Оплата и ручное решение всюду названы по имени. Это не украшение: цена
 * ошибки у них разная. «Снять ручное решение» возвращает человека к тому,
 * за что он заплатил; «Отменить» отбирает доступ целиком и потому требует
 * подтверждения идентификатором.
 */
const SUBSCRIPTION_SOURCES = {
  payment: "оплата",
  manual: "ручное решение",
  promo: "промо",
  trial: "пробный период",
};

const ACCESS_LEVELS = {
  blocked: "заблокирован",
  suspended: "приостановлен",
  manual_override: "ручное решение",
  paid: "оплачено",
  promo: "промо",
  trial: "пробный период",
  free: "бесплатная квота",
};

const SUBSCRIPTION_ACTIONS = {
  assign: "назначена",
  change_plan: "смена тарифа",
  extend: "продление",
  cancel: "отмена",
  clear_manual: "ручное решение снято",
};

function sourceLabel(source) {
  return SUBSCRIPTION_SOURCES[source] || source || "—";
}

async function loadSubscriptions() {
  const { payload } = await request("/panel/subscriptions");
  $("#subscriptions-summary-body").innerHTML = payload.by_plan.length
    ? payload.by_plan.map((row) => `
      <tr>
        <td><strong>${escapeHtml(row.plan)}</strong></td>
        <td>${escapeHtml(sourceLabel(row.source))}</td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.total)}</td>
      </tr>`).join("")
    : '<tr><td colspan="4" class="muted">Действующих подписок нет.</td></tr>';

  $("#subscriptions-expiring-body").innerHTML = payload.expiring.length
    ? payload.expiring.map((row) => `
      <tr class="subscription-row" data-user="${escapeHtml(row.user_id)}">
        <td><strong>${escapeHtml(row.username ? `@${row.username}` : `telegram ${row.telegram_id}`)}</strong><br><span class="technical">id ${escapeHtml(row.user_id)}</span></td>
        <td>${escapeHtml(row.plan)}</td>
        <td>${escapeHtml(sourceLabel(row.source))}</td>
        <td>${escapeHtml(localDate(row.current_period_end))}</td>
      </tr>`).join("")
    : '<tr><td colspan="4" class="muted">В ближайшие две недели ничего не истекает.</td></tr>';
}

function subscriptionRow(row) {
  return `<tr>
    <td>${escapeHtml(row.plan)}</td>
    <td>${escapeHtml(sourceLabel(row.source))}</td>
    <td>${escapeHtml(row.status)}</td>
    <td>${escapeHtml(localDate(row.current_period_start))}</td>
    <td>${row.current_period_end ? escapeHtml(localDate(row.current_period_end)) : "бессрочно"}</td>
    <td>${escapeHtml(row.actor_name || "—")}</td>
  </tr>`;
}

async function openSubscriptionCard(userId) {
  const { payload } = await request(`/panel/subscriptions/${encodeURIComponent(userId)}`);
  state.currentSubscription = payload;
  const current = payload.current;
  const access = payload.access;
  const canWrite = ["owner", "admin"].includes(state.me.role);

  $("#subscription-card").hidden = false;
  $("#subscription-card-title").textContent =
    payload.user.username ? `@${payload.user.username}` : `telegram ${payload.user.telegram_id}`;
  $("#subscription-card-subtitle").textContent =
    `user_id ${payload.user.id} · доступ: ${ACCESS_LEVELS[access.level] || access.level}`;

  $("#subscription-card-body").innerHTML = `
    <div class="user-grid">
      <div>
        <h4>Действующий доступ</h4>
        <dl class="kv">
          <dt>Уровень</dt><dd>${escapeHtml(ACCESS_LEVELS[access.level] || access.level)}</dd>
          <dt>Почему</dt><dd>${escapeHtml(access.reason)}</dd>
          <dt>Тариф</dt><dd>${escapeHtml(current?.plan || "—")}</dd>
          <dt>Происхождение</dt><dd>${escapeHtml(sourceLabel(current?.source))}</dd>
          <dt>Статус</dt><dd>${escapeHtml(current?.status || "нет подписки")}</dd>
          <dt>Действует до</dt><dd>${current ? (current.current_period_end ? escapeHtml(localDate(current.current_period_end)) : "бессрочно") : "—"}</dd>
          <dt>Кто менял</dt><dd>${escapeHtml(current?.actor_name || "—")}</dd>
          <dt>Причина</dt><dd>${escapeHtml(current?.note || "—")}</dd>
        </dl>
      </div>
      <div>
        <h4>Оплаты</h4>
        ${payload.payments.length ? `<table class="mini-table">
          <thead><tr><th>Когда</th><th>Провайдер</th><th>Сумма</th><th>Статус</th></tr></thead>
          <tbody>${payload.payments.map((row) => `<tr>
            <td>${escapeHtml(localDate(row.paid_at))}</td>
            <td>${escapeHtml(row.provider)}</td>
            <td>${escapeHtml((Number(row.amount_minor) / 100).toFixed(2))} ${escapeHtml(row.currency)}</td>
            <td>${escapeHtml(row.status)}</td>
          </tr>`).join("")}</tbody>
        </table>` : '<p class="muted">Оплат не было.</p>'}
      </div>
    </div>

    ${canWrite ? `<div class="user-block">
      <h4>Назначить или изменить</h4>
      <form id="subscription-assign-form" data-user="${escapeHtml(payload.user.id)}">
        <div class="field-row">
          <label>Тариф<input name="plan" value="${escapeHtml(current?.plan || "plus")}" pattern="[a-z][a-z0-9_-]*" required></label>
          <label>Срок<select name="term">
            <option value="30">30 дней</option>
            <option value="90">90 дней</option>
            <option value="365">365 дней</option>
            <option value="date">до даты…</option>
            <option value="none">бессрочно</option>
          </select></label>
          <label class="date-field" hidden>Дата окончания<input name="period_end" type="date"></label>
        </div>
        <label>Причина<input name="reason" maxlength="500" placeholder="Зачем выдаётся доступ" required></label>
        <div class="form-actions">
          <button class="button primary" value="assign" type="submit">Назначить</button>
          <button class="button secondary" value="plan" type="submit"${current ? "" : " disabled"}>Сменить тариф</button>
          <button class="button secondary" value="extend" type="submit"${current ? "" : " disabled"}>Продлить</button>
        </div>
      </form>
      <p class="block-caption">Назначение создаёт ручную подписку. Прежняя уходит в историю и может вернуться, когда ручное решение снимут.</p>
    </div>

    <div class="user-block">
      <h4>Снять доступ</h4>
      <div class="form-actions">
        <button class="button ghost" data-subscription-action="clear" data-user="${escapeHtml(payload.user.id)}" type="button"${current?.source === "manual" ? "" : " disabled"}>Снять ручное решение</button>
        <button class="button ghost" data-subscription-action="cancel" data-user="${escapeHtml(payload.user.id)}" type="button"${current ? "" : " disabled"}>Отменить подписку</button>
      </div>
      <p class="block-caption">«Снять ручное решение» вернёт человека к оплаченному доступу, если его период ещё идёт. «Отменить» отбирает доступ целиком.</p>
    </div>` : ""}

    <div class="user-block">
      <h4>История подписок</h4>
      ${payload.history.length ? `<table class="mini-table">
        <thead><tr><th>Тариф</th><th>Происхождение</th><th>Статус</th><th>Начало</th><th>Конец</th><th>Кто</th></tr></thead>
        <tbody>${payload.history.map(subscriptionRow).join("")}</tbody>
      </table>` : '<p class="muted">Подписок не было.</p>'}
    </div>

    <div class="user-block">
      <h4>Решения администраторов</h4>
      ${payload.events.length ? `<table class="mini-table">
        <thead><tr><th>Когда</th><th>Действие</th><th>Тариф</th><th>Кто</th><th>Причина</th></tr></thead>
        <tbody>${payload.events.map((row) => `<tr>
          <td>${escapeHtml(localDate(row.created_at))}</td>
          <td>${escapeHtml(SUBSCRIPTION_ACTIONS[row.action] || row.action)}</td>
          <td>${escapeHtml(row.plan || "—")}</td>
          <td>${escapeHtml(row.actor_name)}</td>
          <td>${escapeHtml(row.reason)}</td>
        </tr>`).join("")}</tbody>
      </table>` : '<p class="muted">Ручных решений не было.</p>'}
    </div>
  `;
  $("#subscription-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Срок из формы: дни, дата или бессрочно — ровно одно из трёх. */
function subscriptionTerm(form) {
  const term = form.elements.term.value;
  if (term === "none") return { no_expiry: true };
  if (term === "date") {
    const value = form.elements.period_end.value;
    if (!value) throw new Error("Укажите дату окончания");
    return { period_end: new Date(`${value}T23:59:59`).toISOString() };
  }
  return { days: Number(term) };
}

function submitSubscription(form, action) {
  const userId = form.dataset.user;
  const reason = form.elements.reason.value.trim();
  if (!reason) {
    toast("Причина обязательна", true);
    return;
  }
  let term;
  try {
    term = subscriptionTerm(form);
  } catch (error) {
    toast(error.message, true);
    return;
  }
  const path = { assign: "assign", plan: "plan", extend: "extend" }[action];
  const bodyPayload = action === "plan"
    ? { plan: form.elements.plan.value.trim(), reason }
    : { plan: form.elements.plan.value.trim(), reason, ...term };

  askSudo({
    scope: "users:write",
    title: { assign: "Назначить подписку", plan: "Сменить тариф", extend: "Продлить подписку" }[action],
    description: "Изменение доступа человека. Будет записано в журнал событий и в историю решений.",
    action: async () => {
      await request(`/panel/subscriptions/${encodeURIComponent(userId)}/${path}`, {
        method: "POST",
        body: JSON.stringify(bodyPayload),
      });
      toast("Подписка изменена");
      await loadSubscriptions();
      await openSubscriptionCard(userId);
    },
  });
}

function cancelSubscription(userId) {
  askConfirm({
    title: "Отменить подписку?",
    description: "Человек потеряет доступ, в том числе оплаченный. Строка останется в истории со статусом canceled.",
    expected: String(userId),
    action: () => new Promise((resolve, reject) => {
      const reason = "Отмена из административной панели";
      askSudo({
        scope: "users:write",
        title: "Отмена подписки",
        description: "Повторите пароль: доступ будет снят немедленно.",
        action: async () => {
          try {
            await request(`/panel/subscriptions/${encodeURIComponent(userId)}/cancel`, {
              method: "POST",
              body: JSON.stringify({ reason, confirm: String(userId) }),
            });
            toast("Подписка отменена");
            await loadSubscriptions();
            await openSubscriptionCard(userId);
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

function clearManualSubscription(userId) {
  askSudo({
    scope: "users:write",
    title: "Снять ручное решение",
    description: "Ручная подписка перестанет действовать. Если у человека идёт оплаченный период, он вернётся.",
    action: async () => {
      const { payload } = await request(
        `/panel/subscriptions/${encodeURIComponent(userId)}/clear-manual`,
        {
          method: "POST",
          body: JSON.stringify({ reason: "Снятие ручного решения из панели" }),
        },
      );
      toast(payload.restored_payment
        ? "Ручное решение снято, оплаченная подписка возвращена"
        : "Ручное решение снято");
      await loadSubscriptions();
      await openSubscriptionCard(userId);
    },
  });
}

$("#reload-subscriptions").addEventListener("click", () => loadSubscriptions().catch(handleError));
$("#subscriptions-expiring-body").addEventListener("click", (event) => {
  const row = event.target.closest(".subscription-row");
  if (row) openSubscriptionCard(row.dataset.user).catch(handleError);
});
$("#subscription-open-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = event.currentTarget.elements.user_id.value.trim();
  if (!/^\d+$/.test(id)) {
    toast("user_id — целое число", true);
    return;
  }
  openSubscriptionCard(id).catch(handleError);
});
$("#close-subscription-card").addEventListener("click", () => {
  $("#subscription-card").hidden = true;
});
$("#subscription-card-body").addEventListener("change", (event) => {
  if (event.target.name !== "term") return;
  const field = event.target.closest("form").querySelector(".date-field");
  if (field) field.hidden = event.target.value !== "date";
});
$("#subscription-card-body").addEventListener("submit", (event) => {
  if (event.target.id !== "subscription-assign-form") return;
  event.preventDefault();
  submitSubscription(event.target, event.submitter?.value || "assign");
});
$("#subscription-card-body").addEventListener("click", (event) => {
  const button = event.target.closest("[data-subscription-action]");
  if (!button) return;
  if (button.dataset.subscriptionAction === "cancel") cancelSubscription(button.dataset.user);
  if (button.dataset.subscriptionAction === "clear") clearManualSubscription(button.dataset.user);
});
