/**
 * Вкладка «Тарифы».
 *
 * Своего состояния здесь нет: лимиты приходят из `quotas`, расход — из
 * `usage_counters`, цена — из `plan_prices`. Панель их правит и
 * показывает, но не пересчитывает: второе место, знающее, сколько
 * положено на тарифе, разошлось бы с первым на первой же правке.
 */

const PLAN_TITLES = { free: "Бесплатный", plus: "Plus", max: "Max" };
const PERIOD_TITLES = { day: "сутки", week: "неделя", month: "месяц", quarter: "три месяца" };

async function loadTariffs() {
  const { payload } = await request("/tariffs");
  state.tariffs = payload;
  renderTariffPrices();
  renderTariffLimits();
  renderTariffUsage();
}

function tariffEditable() {
  return ["owner", "admin"].includes(state.me.role);
}

/** Цена: тариф × срок → звёзды. Бесплатный тариф не продаётся. */
function renderTariffPrices() {
  const data = state.tariffs;
  const editable = tariffEditable();
  const paid = data.plans.filter((plan) => plan !== "free");
  const priceOf = (plan, period) =>
    data.prices.find((row) => row.plan === plan && row.period === period);

  $("#tariff-prices").innerHTML = `
    <div class="tariff-grid">
      ${paid.map((plan) => `
        <article class="tariff-card">
          <h4>${escapeHtml(PLAN_TITLES[plan] || plan)}</h4>
          ${data.price_periods.map((period) => {
            const row = priceOf(plan, period);
            return `
              <label class="tariff-field">
                <span>${escapeHtml(PERIOD_TITLES[period] || period)}</span>
                <input type="number" min="1" step="1" inputmode="numeric"
                  value="${row ? escapeHtml(String(row.stars)) : ""}"
                  placeholder="не задана"
                  data-price-plan="${escapeHtml(plan)}" data-price-period="${escapeHtml(period)}"
                  ${editable ? "" : "disabled"}>
                <small>★</small>
              </label>`;
          }).join("")}
          ${editable ? `<button class="button tiny secondary" data-save-prices="${escapeHtml(plan)}">Сохранить цены</button>` : ""}
        </article>`).join("")}
    </div>`;
}

/** Лимиты: тариф × расходник × период, плюс пробные. */
function renderTariffLimits() {
  const data = state.tariffs;
  const editable = tariffEditable();
  const limitOf = (plan, metric, period) =>
    data.limits.find((row) => row.plan === plan && row.metric === metric && row.period === period);

  $("#tariff-limits").innerHTML = data.plans.map((plan) => `
    <details class="advanced-block" ${plan === "plus" ? "open" : ""}>
      <summary>${escapeHtml(PLAN_TITLES[plan] || plan)} — ${escapeHtml(String(
        (data.subscribers.find((row) => row.plan === plan) || {}).people ?? 0,
      ))} чел.</summary>
      <div class="advanced-body">
        <div class="table-wrap"><table>
          <thead><tr><th>Расходник</th>${data.limit_periods.map((period) =>
            `<th>${escapeHtml(PERIOD_TITLES[period] || period)}</th>`).join("")}<th>Пробные (сутки)</th></tr></thead>
          <tbody>${data.metrics.map((entry) => `
            <tr>
              <td data-label="Расходник">${escapeHtml(entry.title)}</td>
              ${data.limit_periods.map((period) => {
                const row = limitOf(plan, entry.metric, period);
                return `<td data-label="${escapeHtml(PERIOD_TITLES[period] || period)}">
                  <input type="number" step="1" min="-1" inputmode="numeric" class="tariff-limit-input"
                    value="${row ? escapeHtml(String(row.limit_value)) : ""}"
                    placeholder="∞"
                    data-limit-plan="${escapeHtml(plan)}" data-limit-metric="${escapeHtml(entry.metric)}"
                    data-limit-period="${escapeHtml(period)}" ${editable ? "" : "disabled"}>
                </td>`;
              }).join("")}
              <td data-label="Пробные">
                <input type="number" step="1" min="0" inputmode="numeric" class="tariff-limit-input"
                  value="${escapeHtml(String((limitOf(plan, entry.metric, "day") || {}).free_value ?? 0))}"
                  data-free-plan="${escapeHtml(plan)}" data-free-metric="${escapeHtml(entry.metric)}"
                  ${editable ? "" : "disabled"}>
              </td>
            </tr>`).join("")}</tbody>
        </table></div>
        ${editable ? `<button class="button tiny secondary" data-save-limits="${escapeHtml(plan)}">Сохранить лимиты</button>` : ""}
      </div>
    </details>`).join("");
}

/** Фактический расход по всей установке: только количества. */
function renderTariffUsage() {
  const rows = state.tariffs.usage || [];
  if (!rows.length) {
    $("#tariff-usage").innerHTML = '<p class="muted">За сегодня расхода ещё не было.</p>';
    return;
  }
  const used = (metric, period) =>
    Number((rows.find((row) => row.metric === metric && row.period === period) || {}).used ?? 0);
  $("#tariff-usage").innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Расходник</th><th>За сутки</th><th>За месяц</th></tr></thead>
      <tbody>${state.tariffs.metrics.map((entry) => `
        <tr>
          <td data-label="Расходник">${escapeHtml(entry.title)}</td>
          <td data-label="За сутки">${escapeHtml(String(used(entry.metric, "day")))}</td>
          <td data-label="За месяц">${escapeHtml(String(used(entry.metric, "month")))}</td>
        </tr>`).join("")}</tbody>
    </table></div>`;
}

/**
 * Сохранение идёт по одному тарифу целиком.
 *
 * Правка по клетке означала бы запрос на каждое нажатие клавиши, а
 * человек правит матрицу глазами: проставил столбец — сохранил.
 */
async function saveTariffLimits(plan) {
  const inputs = [...document.querySelectorAll(`[data-limit-plan="${CSS.escape(plan)}"]`)];
  let saved = 0;
  for (const input of inputs) {
    const raw = input.value.trim();
    // Пустое поле означает «безлимит»: так его и записываем, а не
    // пропускаем — иначе снять лимит было бы нечем.
    const limit = raw === "" ? -1 : Number(raw);
    const free = Number(
      document.querySelector(
        `[data-free-plan="${CSS.escape(plan)}"][data-free-metric="${CSS.escape(input.dataset.limitMetric)}"]`,
      )?.value ?? 0,
    );
    await request("/tariffs/limits", {
      method: "PUT",
      body: JSON.stringify({
        plan,
        metric: input.dataset.limitMetric,
        period: input.dataset.limitPeriod,
        limit_value: limit,
        // Пробные заданы на сутки: их поле в таблице одно.
        free_value: input.dataset.limitPeriod === "day" ? free : 0,
      }),
    });
    saved += 1;
  }
  toast(`Лимиты тарифа сохранены: ${saved}`);
  await loadTariffs();
}

async function saveTariffPrices(plan) {
  const inputs = [...document.querySelectorAll(`[data-price-plan="${CSS.escape(plan)}"]`)];
  for (const input of inputs) {
    const raw = input.value.trim();
    // Пустая цена — это «не задана», и её не отправляем: сервер такую
    // всё равно отвергнет, а стирать уже назначенную цену нужно явно.
    if (raw === "") continue;
    await request("/tariffs/prices", {
      method: "PUT",
      body: JSON.stringify({ plan, period: input.dataset.pricePeriod, stars: Number(raw) }),
    });
  }
  toast("Цены сохранены и применены ко всем");
  await loadTariffs();
}

$("#reload-tariffs")?.addEventListener("click", () => loadTariffs().catch(handleError));
$("#page-tariffs")?.addEventListener("click", (event) => {
  const limits = event.target.closest("[data-save-limits]");
  if (limits) return void saveTariffLimits(limits.dataset.saveLimits).catch(handleError);
  const prices = event.target.closest("[data-save-prices]");
  if (prices) return void saveTariffPrices(prices.dataset.savePrices).catch(handleError);
});
