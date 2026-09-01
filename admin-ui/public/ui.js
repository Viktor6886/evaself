/**
 * Точка входа панели: загрузчики разделов, переключение страниц, живое
 * обновление, вход и выход.
 *
 * Подключается последним: `LOADERS` перечисляет функции загрузки всех
 * разделов, и до их объявления этот список собрать нельзя.
 */
const LOADERS = {
  overview: loadOverview,
  tariffs: loadTariffs,
  services: loadServicesAndIntegrations,
  ai: loadProviders,
  stt: loadStt,
  media: loadMedia,
  tts: loadTts,
  operations: loadOperations,
  users: loadUsers,
  subscriptions: loadSubscriptions,
  agents: loadAgents,
  persona: loadPersona,
  letta: loadLetta,
  monitoring: loadMonitoring,
  settings: loadSettings,
  security: loadSecrets,
  audit: loadAudit,
};

const isPage = (name) => Object.prototype.hasOwnProperty.call(LOADERS, name);

/**
 * Базовый путь панели и раздел, названный в адресе.
 *
 * Панель отдаётся с `/admin/` основного домена, и Caddy снимает этот
 * префикс до статики: `/admin/agents` приходит сюда как `/agents` и
 * попадает в index.html через try_files. Значит, адрес раздела —
 * настоящий адрес: его можно дать ссылкой, открыть в новой вкладке и
 * обновить страницей.
 *
 * Префикс вычисляется, а не зашит: браузерные тесты открывают ту же
 * статику с корня, и зашитое `/admin/` увело бы их в несуществующий путь.
 *
 * Считается он от последнего сегмента, а не отрезанием всего после
 * последнего слэша. Разница видна на двух адресах, которые иначе
 * неразличимы: `/admin/` — это база без раздела, а `/admin/agents/` —
 * раздел с хвостовым слэшем. Наивное отрезание принимало второй за базу,
 * показывало обзор и потом строило адреса вида `/admin/agents/letta`.
 *
 * Сегмент с точкой (`index.html` на стенде тестов) — файл, а не раздел, и
 * в базу не входит.
 */
function panelBase() {
  const parts = window.location.pathname.replace(/\/+$/, "").split("/");
  const last = parts[parts.length - 1] ?? "";
  if (isPage(last) || last.includes(".")) parts.pop();
  return `${parts.join("/")}/`.replace(/\/{2,}/g, "/");
}

const PANEL_BASE = panelBase();

/**
 * Неизвестный сегмент означает «раздел не назван» и открывает обзор:
 * чужая ссылка не должна давать пустой экран.
 */
function pageFromLocation() {
  const name = window.location.pathname.slice(PANEL_BASE.length).replace(/\/+$/, "");
  return isPage(name) ? name : "overview";
}

function openPage(name, options = {}) {
  state.page = name;
  document.querySelectorAll(".page").forEach((item) => {
    item.classList.toggle("active", item.id === `page-${name}`);
  });
  document.querySelectorAll(".nav-item[data-page]").forEach((item) => {
    item.classList.toggle("active", item.dataset.page === name);
  });
  // Адрес меняется без перезагрузки. `replaceState` — для первого
  // открытия и для кнопки «назад»: иначе один и тот же раздел копился бы
  // в истории и «назад» не выходило бы из панели вовсе.
  const target = `${PANEL_BASE}${name === "overview" ? "" : name}`;
  if (!options.fromHistory && window.location.pathname !== target) {
    try {
      window.history[options.replace ? "replaceState" : "pushState"]({ page: name }, "", target);
    } catch {
      // file:// и песочницы без истории: раздел всё равно открывается,
      // просто адрес остаётся прежним.
    }
  }
  setSidebar(false);
  LOADERS[name]?.().catch(handleError);
}

window.addEventListener("popstate", () => {
  openPage(pageFromLocation(), { fromHistory: true });
});

function startLiveUpdates() {
  stopLiveUpdates();
  if ("EventSource" in window) {
    state.events = new EventSource(`${API}/events`);
    state.events.addEventListener("update", () => {
      clearTimeout(startLiveUpdates.debounce);
      startLiveUpdates.debounce = setTimeout(() => {
        if (["overview", "services", "operations"].includes(state.page)) {
          LOADERS[state.page]?.().catch(() => {});
        }
      }, 500);
    });
  }
  state.refreshTimer = setInterval(() => {
    if (["overview", "services", "operations"].includes(state.page)) {
      LOADERS[state.page]?.().catch(() => {});
    }
  }, 15_000);
}

function stopLiveUpdates() {
  state.events?.close();
  state.events = null;
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const form = new FormData(formElement);
    const { payload } = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
      }),
    });
    formElement.reset();
    showApp(payload.user);
    openPage(pageFromLocation(), { replace: true });
  } catch (error) {
    // Блокировка — единственный отказ входа, у которого есть срок. Без
    // него «вход временно заблокирован» выглядит как «пароль больше не
    // работает», и человек начинает искать, где его сбросить.
    const retry = Number(error.details?.retry_after_seconds ?? 0);
    showLogin(retry > 0
      ? `${error.message}. Попробуйте снова через ${retryText(retry)}.`
      : error.message);
  } finally {
    if (submit) submit.disabled = false;
  }
});

function retryText(seconds) {
  if (seconds <= 90) return `${seconds} с`;
  return `${Math.ceil(seconds / 60)} мин`;
}

$("#logout").addEventListener("click", async () => {
  try {
    await request("/auth/logout", { method: "POST" });
  } catch {}
  state.me = null;
  showLogin();
});
/**
 * Боковое меню на телефоне.
 *
 * Открытое меню накрывает содержимое, поэтому у него должно быть три
 * способа закрыться: та же кнопка, тычок мимо и Escape. С одним только
 * первым промах по кнопке уводит в другой раздел вместо закрытия.
 */
function setSidebar(open) {
  $(".sidebar").classList.toggle("open", open);
  const scrim = $("#sidebar-scrim");
  if (!scrim) return;
  scrim.hidden = false;
  scrim.classList.toggle("show", open);
  // aria-expanded читают скринридеры, и без него кнопка «☰» не
  // сообщает, открыто меню или нет.
  $("#menu")?.setAttribute("aria-expanded", String(open));
}

$("#menu").addEventListener("click", () => {
  setSidebar(!$(".sidebar").classList.contains("open"));
});
$("#sidebar-scrim")?.addEventListener("click", () => setSidebar(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $(".sidebar")?.classList.contains("open")) setSidebar(false);
});
$("#nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]");
  if (button) openPage(button.dataset.page);
});

request("/me").then(({ payload }) => {
  showApp(payload.user);
  watchTables();
  openPage(pageFromLocation(), { replace: true });
}).catch(() => showLogin());
