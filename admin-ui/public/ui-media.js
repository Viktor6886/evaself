/**
 * Раздел «Распознавание медиа».
 *
 * Второго реестра провайдеров здесь нет и быть не может: раздел
 * показывает и правит тот же маршрут `vision` LLM Router, что и раздел
 * «Искусственный интеллект», теми же обработчиками цепочки. Своё у него
 * одно — проверка: настоящее изображение уходит через production Router
 * ровно тем путём, каким идёт фотография из Telegram.
 *
 * Проверка провайдера в разделе «Искусственный интеллект» этого не
 * заменяет: она спрашивает у провайдера его возможности напрямую, минуя
 * маршрутизацию. Именно поэтому она не заметила, как картинка теряется
 * по дороге, а разговор при этом продолжал работать.
 */

async function loadMedia() {
  // Тот же /llm/state, что и у раздела моделей: один источник, одно
  // состояние. Побочно обновляется и страница «Искусственный интеллект» —
  // она читает из того же state.
  await loadProviders();
  renderMediaChain();
  renderMediaProviders();
}

function renderMediaChain() {
  renderRouteChains($("#media-chain"), ["vision"]);
}

/**
 * Кто из провайдеров вообще умеет смотреть на изображение.
 *
 * Признак `supports_vision` ставит проба возможностей, и роутер по нему
 * же отсеивает непригодных из цепочки. Поэтому список показывает всех, а
 * не только тех, кто уже стоит в маршруте: выбирать резерв придётся из
 * этого набора.
 */
function renderMediaProviders() {
  const providers = state.router?.providers || [];
  const chain = new Set(
    ((state.router?.routes || []).find((route) => route.code === "vision")?.chain || [])
      .map((link) => link.provider_id),
  );
  const capable = providers.filter((provider) => provider.supports_vision);
  $("#media-providers").innerHTML = capable.length
    ? capable.map((provider) => {
      const breaker = BREAKER_LABELS[provider.breaker_state] || BREAKER_LABELS.closed;
      return `
        <article class="health-row">
          <div class="health-head">
            <span class="status-dot color-${provider.pinned_out ? "gray" : breaker.color}"></span>
            <div>
              <strong>${escapeHtml(provider.name)}</strong>
              <small>${escapeHtml(provider.model)} · ${escapeHtml(provider.protocol)}${provider.enabled ? "" : " · выключен"}</small>
            </div>
            <span class="health-state">${chain.has(provider.id) ? "в цепочке vision" : "свободен"}</span>
          </div>
          <dl class="health-facts">
            <div><dt>Понимает изображения</dt><dd>да</dd></div>
            <div><dt>Задержка p95</dt><dd>${provider.p95_latency_ms == null ? "нет данных" : `${provider.p95_latency_ms} мс`}</dd></div>
            <div><dt>Состояние</dt><dd>${escapeHtml(breaker.title)}</dd></div>
          </dl>
        </article>`;
    }).join("")
    : `<p class="muted">Ни у одного провайдера нет признака «понимает изображения».
        Фотография в таком состоянии до модели не дойдёт: роутер пропустит всю
        цепочку. Признак ставит проба возможностей в разделе «Искусственный
        интеллект».</p>`;
}

/**
 * Проверка тракта распознавания.
 *
 * Ответ показывается целиком: словесный вердикт «узнал/не узнал»
 * получается детерминированным сравнением, но человеку важно видеть, что
 * именно ответила модель — «зелёный квадрат» и «я не вижу изображения»
 * различаются не кодом ответа, а текстом.
 */
async function runMediaCheck() {
  const button = $("#media-check");
  const host = $("#media-check-result");
  button.disabled = true;
  host.hidden = false;
  host.className = "integration-test";
  host.textContent = "Отправляем изображение через Router…";
  try {
    const { payload } = await request("/llm/vision/check", { method: "POST" });
    const result = payload.result || payload;
    host.className = `integration-test ${result.recognized ? "is-ok" : "is-fail"}`;
    host.innerHTML = mediaCheckReport(result);
  } catch (error) {
    host.className = "integration-test is-fail";
    host.textContent = error.message || "Проверка не удалась";
  } finally {
    button.disabled = false;
  }
}

function mediaCheckReport(result) {
  const rows = [
    ["Ответил", `${escapeHtml(result.provider || "—")} · ${escapeHtml(result.model || "—")}`],
    ["Маршрут", escapeHtml(result.route || "—")],
    ["Переключений", String(Number(result.switches) || 0)],
    ["Задержка", `${Math.round(Number(result.latency_ms) || 0)} мс`],
  ];
  const verdict = result.recognized
    ? "Изображение доехало до модели: она назвала цвет, который на нём нарисован."
    : result.ok
      ? "Модель ответила, но цвет не назвала. Так выглядит потерянная по дороге картинка — "
        + "проверьте, что провайдер действительно принимает изображения."
      : "Ответа нет.";
  return `<p><strong>${escapeHtml(verdict)}</strong></p>
    <dl class="health-facts">${rows.map(([term, value]) =>
      `<div><dt>${escapeHtml(term)}</dt><dd>${value}</dd></div>`).join("")}</dl>
    ${result.answer ? `<p class="technical">${escapeHtml(result.answer)}</p>` : ""}
    ${result.error ? `<p class="technical">${escapeHtml(result.error)}</p>` : ""}`;
}

$("#reload-media")?.addEventListener("click", () => loadMedia().catch(handleError));
$("#media-check")?.addEventListener("click", () => runMediaCheck().catch(handleError));
// Цепочка правится теми же обработчиками, что и на странице моделей:
// свой набор кнопок означал бы второй способ менять один и тот же
// маршрут.
$("#media-chain")?.addEventListener("click", handleRouteChainClick);
$("#media-chain")?.addEventListener("change", handleRouteChainChange);
