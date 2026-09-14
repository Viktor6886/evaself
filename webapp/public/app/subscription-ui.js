(function () {
  "use strict";

  var PLAN_NAMES = {
    free: "Free",
    plus: "Plus",
    max: "Max",
    pro: "Max"
  };

  var QUOTA_DEFINITIONS = [
    { metric: "messages", label: "Сообщения Еве", core: true },
    { metric: "voice_minutes", label: "Голос", unit: "мин", core: true },
    { metric: "web_search", label: "Поиск в интернете", core: true },
    { metric: "documents", label: "Документы", secondary: true },
    { metric: "images", label: "Изображения", secondary: true }
  ];

  var PERIOD_LABELS = {
    day: "Обновляется ежедневно",
    week: "Обновляется каждую неделю",
    month: "Обновляется каждый месяц",
    total: "За весь период"
  };

  var PERIOD_RANK = { day: 1, week: 2, month: 3, total: 4 };

  function session() {
    if (!window.EvaApp || !window.EvaApp.state) return {};
    return window.EvaApp.state.session || {};
  }

  function planName(value) {
    var key = String(value || "free").toLowerCase();
    if (PLAN_NAMES[key]) return PLAN_NAMES[key];
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    var number = Number(value);
    return isFinite(number) ? number : null;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeQuota(row) {
    row = row || {};
    var rawLimit = row.limit_value;
    if (rawLimit === null || rawLimit === undefined) rawLimit = row.limit;

    var limit = finiteNumber(rawLimit);
    var used = finiteNumber(row.used);
    var remaining = finiteNumber(row.remaining);
    var unlimited = row.unlimited === true || (limit !== null && limit < 0);

    if (unlimited) {
      return {
        metric: String(row.metric || row.name || row.type || ""),
        period: String(row.period || ""),
        limit: null,
        used: Math.max(0, used || 0),
        remaining: null,
        unlimited: true,
        percentUsed: 0
      };
    }

    if (limit === null && used !== null && remaining !== null) {
      limit = Math.max(0, used + remaining);
    }
    if (limit !== null && used === null && remaining !== null) {
      used = Math.max(0, limit - remaining);
    }
    if (limit !== null && remaining === null && used !== null) {
      remaining = Math.max(0, limit - used);
    }

    limit = limit === null ? null : Math.max(0, limit);
    used = used === null ? 0 : Math.max(0, used);
    remaining = remaining === null ? null : Math.max(0, remaining);

    return {
      metric: String(row.metric || row.name || row.type || ""),
      period: String(row.period || ""),
      limit: limit,
      used: used,
      remaining: remaining,
      unlimited: false,
      percentUsed: limit && limit > 0 ? clamp(Math.round((used / limit) * 100), 0, 100) : 0
    };
  }

  function restrictiveness(quota) {
    if (quota.unlimited || quota.limit === null) return 2;
    if (quota.limit <= 0) return -1;
    var remaining = quota.remaining === null ? quota.limit : quota.remaining;
    return clamp(remaining / quota.limit, 0, 1);
  }

  function selectQuota(rows, metric) {
    var matches = [];
    for (var index = 0; index < rows.length; index += 1) {
      var quota = normalizeQuota(rows[index]);
      if (quota.metric === metric) matches.push(quota);
    }
    if (!matches.length) return null;

    var finite = matches.filter(function (quota) {
      return !quota.unlimited && quota.limit !== null;
    });
    if (!finite.length) return matches[0];

    finite.sort(function (left, right) {
      var ratio = restrictiveness(left) - restrictiveness(right);
      if (ratio !== 0) return ratio;
      return (PERIOD_RANK[left.period] || 9) - (PERIOD_RANK[right.period] || 9);
    });
    return finite[0];
  }

  function usageRows(quotas) {
    var result = [];
    for (var index = 0; index < QUOTA_DEFINITIONS.length; index += 1) {
      var definition = QUOTA_DEFINITIONS[index];
      var quota = selectQuota(quotas, definition.metric);
      if (!quota) continue;
      // Документы и изображения выводим только когда для них действительно
      // задан конечный пользовательский лимит. Служебный безлимит не должен
      // превращаться в длинный технический отчёт.
      if (definition.secondary && (quota.unlimited || quota.limit === null)) continue;
      result.push({ definition: definition, quota: quota });
    }
    return result;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function numberLabel(value) {
    var number = finiteNumber(value);
    if (number === null) return "—";
    try {
      return new Intl.NumberFormat("ru-RU").format(number);
    } catch (_) {
      return String(number);
    }
  }

  function usageItemHtml(item) {
    var definition = item.definition;
    var quota = item.quota;
    var period = PERIOD_LABELS[quota.period] || "Лимит тарифа";

    if (quota.unlimited) {
      return '<article class="subscription-usage-item" data-quota-metric="' + escapeHtml(definition.metric) + '">' +
        '<div class="subscription-usage-top">' +
          '<div><strong>' + escapeHtml(definition.label) + '</strong><span>' + escapeHtml(period) + '</span></div>' +
          '<b class="subscription-unlimited">Без лимита</b>' +
        '</div>' +
      '</article>';
    }

    if (quota.limit === 0) {
      return '<article class="subscription-usage-item" data-quota-metric="' + escapeHtml(definition.metric) + '">' +
        '<div class="subscription-usage-top">' +
          '<div><strong>' + escapeHtml(definition.label) + '</strong><span>' + escapeHtml(period) + '</span></div>' +
          '<b class="subscription-zero">Не включено</b>' +
        '</div>' +
      '</article>';
    }

    var remaining = quota.remaining === null ? Math.max(0, quota.limit - quota.used) : quota.remaining;
    var unit = definition.unit ? " " + definition.unit : "";
    var usedText = numberLabel(quota.used) + " из " + numberLabel(quota.limit) + unit + " использовано";

    return '<article class="subscription-usage-item" data-quota-metric="' + escapeHtml(definition.metric) + '">' +
      '<div class="subscription-usage-top">' +
        '<div><strong>' + escapeHtml(definition.label) + '</strong><span>' + escapeHtml(period) + '</span></div>' +
        '<div class="subscription-remaining"><span>Осталось</span><b>' + numberLabel(remaining) + (definition.unit ? " " + escapeHtml(definition.unit) : "") + '</b></div>' +
      '</div>' +
      '<div class="subscription-progress" role="progressbar" aria-label="Использовано ' + quota.percentUsed + '%" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + quota.percentUsed + '">' +
        '<span style="width:' + quota.percentUsed + '%"></span>' +
      '</div>' +
      '<div class="subscription-usage-foot"><span>' + escapeHtml(usedText) + '</span><b>' + quota.percentUsed + '%</b></div>' +
    '</article>';
  }

  function overviewHtml(data) {
    var plan = planName(data.plan);
    var quotas = Array.isArray(data.quotas) ? data.quotas : [];
    var rows = usageRows(quotas);
    var usage = rows.length
      ? rows.map(usageItemHtml).join("")
      : '<div class="subscription-empty"><strong>Отдельных лимитов нет</strong><span>Для этого тарифа пользовательские ограничения не заданы.</span></div>';

    return '<div class="subscription-overview">' +
      '<section class="subscription-plan-card">' +
        '<span class="subscription-kicker">ТЕКУЩИЙ ТАРИФ</span>' +
        '<div class="subscription-plan-row"><h3>' + escapeHtml(plan) + '</h3><span class="subscription-current-badge">Текущий</span></div>' +
        '<p>Доступ и лимиты применяются автоматически по вашему тарифу.</p>' +
      '</section>' +
      '<section class="subscription-usage-card">' +
        '<div class="subscription-section-head"><div><h3>Использование</h3></div></div>' +
        '<div class="subscription-usage-list">' + usage + '</div>' +
      '</section>' +
    '</div>';
  }

  function enhanceSubscriptionSheet() {
    var sheet = document.getElementById("sheet");
    var title = document.getElementById("sheet-title");
    var subtitle = document.getElementById("sheet-subtitle");
    var content = document.getElementById("sheet-content");
    if (!sheet || !title || !content || !sheet.open) return;
    if (title.textContent.indexOf("Подписка") !== 0) return;

    var firstCard = content.querySelector("article.section-card");
    if (!firstCard || firstCard.id === "subscription-offers") return;

    var wrapper = document.createElement("div");
    wrapper.innerHTML = overviewHtml(session());
    var overview = wrapper.firstElementChild;
    firstCard.parentNode.replaceChild(overview, firstCard);

    title.textContent = "Подписка";
    if (subtitle) subtitle.textContent = "Тариф и использование";
    sheet.classList.add("subscription-sheet");
    content.classList.add("subscription-sheet-content");

    var offers = document.getElementById("subscription-offers");
    if (offers) offers.classList.add("subscription-offers-card");
  }

  function subscriptionSettingTarget(node) {
    var current = node;
    while (current && current !== document) {
      if (current.getAttribute && current.getAttribute("data-setting") === "subscription") return current;
      current = current.parentNode;
    }
    return null;
  }

  function syncProfileSummary() {
    var row = document.querySelector('[data-setting="subscription"]');
    var summary = row ? row.querySelector("em") : null;
    if (!summary) return;
    var desired = planName(session().plan);
    if (summary.textContent !== desired) summary.textContent = desired;
  }

  function init() {
    document.addEventListener("click", function (event) {
      if (!subscriptionSettingTarget(event.target)) return;
      // app.js открывает стандартный sheet на самой строке настроек.
      // На bubble-фазе он уже существует, поэтому меняем только его
      // представление, не вмешиваясь в оплату и обработчики Telegram Stars.
      enhanceSubscriptionSheet();
      syncProfileSummary();
    }, false);

    syncProfileSummary();

    var profile = document.getElementById("profile-content");
    if (profile && window.MutationObserver) {
      var observer = new MutationObserver(function () {
        syncProfileSummary();
      });
      observer.observe(profile, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
