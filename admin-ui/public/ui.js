/**
 * Точка входа панели: загрузчики разделов, переключение страниц, живое
 * обновление, вход и выход.
 *
 * Подключается последним: `LOADERS` перечисляет функции загрузки всех
 * разделов, и до их объявления этот список собрать нельзя.
 */
const LOADERS = {
  overview: loadOverview,
  services: loadServicesAndIntegrations,
  ai: loadProviders,
  stt: loadStt,
  media: loadMedia,
  tts: loadTts,
  operations: loadOperations,
  users: loadUsers,
  settings: loadSettings,
  security: loadSecrets,
  audit: loadAudit,
};

function openPage(name) {
  state.page = name;
  document.querySelectorAll(".page").forEach((item) => {
    item.classList.toggle("active", item.id === `page-${name}`);
  });
  document.querySelectorAll(".nav-item[data-page]").forEach((item) => {
    item.classList.toggle("active", item.dataset.page === name);
  });
  setSidebar(false);
  LOADERS[name]?.().catch(handleError);
}

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
    openPage("overview");
  } catch (error) {
    showLogin(error.message);
  } finally {
    if (submit) submit.disabled = false;
  }
});

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
  openPage("overview");
}).catch(() => showLogin());
