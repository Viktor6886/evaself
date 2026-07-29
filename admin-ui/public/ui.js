const API = "/api/admin/v1";
const state = { me: null, settings: null, etag: null, pendingSecret: null };
const $ = (selector) => document.querySelector(selector);

function csrf() {
  const part = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("eva_admin_csrf="));
  return part ? decodeURIComponent(part.split("=").slice(1).join("=")) : "";
}

async function request(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (!["GET", "HEAD"].includes(options.method || "GET")) headers["X-CSRF-Token"] = csrf();
  const response = await fetch(`${API}${path}`, { credentials: "same-origin", ...options, headers });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "Административный API недоступен");
    error.code = payload?.error?.code;
    error.status = response.status;
    error.details = payload?.error?.details;
    throw error;
  }
  return { payload, response };
}

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.className = "toast", 3600);
}

function showLogin(message = "") {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-error").hidden = !message;
  $("#login-error").textContent = message;
}

function showApp(user) {
  state.me = user;
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#account-name").textContent = user.username;
  $("#account-role").textContent = user.role;
  document.body.dataset.role = user.role;
}

function localDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function openPage(name) {
  document.querySelectorAll(".page").forEach((item) => item.classList.toggle("active", item.id === `page-${name}`));
  document.querySelectorAll(".nav-item[data-page]").forEach((item) => item.classList.toggle("active", item.dataset.page === name));
  $(".sidebar").classList.remove("open");
  if (name === "settings") loadSettings().catch(handleError);
  if (name === "security") loadSecrets().catch(handleError);
  if (name === "audit") loadAudit().catch(handleError);
}

function handleError(error) {
  if (error.status === 401) {
    showLogin("Сессия завершена. Войдите снова.");
    return;
  }
  toast(error.message || "Не удалось выполнить действие", true);
}

function inputFor(setting) {
  if (setting.type === "boolean") {
    return `<select data-key="${escapeHtml(setting.key)}"><option value="true"${setting.value === true ? " selected" : ""}>Включено</option><option value="false"${setting.value === false ? " selected" : ""}>Выключено</option></select>`;
  }
  if (setting.key === "runtime.log_level") {
    return `<select data-key="${escapeHtml(setting.key)}">${["debug", "info", "warn", "error"].map((value) => `<option${setting.value === value ? " selected" : ""}>${value}</option>`).join("")}</select>`;
  }
  const type = setting.type === "integer" ? "number" : "text";
  return `<input data-key="${escapeHtml(setting.key)}" type="${type}" value="${escapeHtml(setting.value)}"${setting.min !== undefined ? ` min="${setting.min}"` : ""}${setting.max !== undefined ? ` max="${setting.max}"` : ""} required>`;
}

async function loadSettings() {
  const { payload, response } = await request("/settings");
  state.settings = payload.settings;
  state.etag = response.headers.get("ETag");
  $("#settings-meta").innerHTML = `<div class="stat"><strong>${payload.settings.length}</strong><span>параметров в реестре</span></div><div class="stat"><strong>${payload.missing_required}</strong><span>обязательных не заполнено</span></div><div class="stat"><strong>${payload.version}</strong><span>версия конфигурации</span></div>`;
  $("#settings-form").innerHTML = payload.settings.map((item) => `
    <article class="setting-card">
      <div class="setting-head"><div><h3>${escapeHtml(item.title)}</h3><span class="technical">${escapeHtml(item.key)}</span></div>${item.requires_restart ? '<span class="tag">нужен перезапуск</span>' : ""}</div>
      <p>${escapeHtml(item.description)}</p>
      <label>Значение${inputFor(item)}</label>
      <div class="setting-actions"><span class="technical">Влияет: ${escapeHtml(item.affects.join(", "))}</span><button class="reset" type="button" data-reset="${escapeHtml(item.key)}">По умолчанию</button></div>
    </article>`).join("");
}

async function saveSettings() {
  if (!["owner", "admin"].includes(state.me.role)) return toast("Эта роль может только просматривать настройки", true);
  const settings = {};
  document.querySelectorAll("[data-key]").forEach((input) => {
    const original = state.settings.find((item) => item.key === input.dataset.key);
    settings[input.dataset.key] = original.type === "boolean" ? input.value === "true" : original.type === "integer" ? Number(input.value) : input.value;
  });
  const { payload, response } = await request("/settings", {
    method: "PUT",
    headers: { "If-Match": state.etag },
    body: JSON.stringify({ settings }),
  });
  state.settings = payload.settings;
  state.etag = response.headers.get("ETag");
  toast("Настройки сохранены");
  await loadSettings();
}

async function loadSecrets() {
  if (!["owner", "admin"].includes(state.me.role)) {
    $("#secrets-list").innerHTML = '<article class="secret-card">Для просмотра метаданных секретов нужна роль owner или admin.</article>';
    return;
  }
  const { payload } = await request("/secrets");
  $("#secrets-list").innerHTML = payload.secrets.length ? payload.secrets.map((item) => `
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
    </article>`).join("") : '<article class="secret-card"><div><h3>Секреты ещё не импортированы</h3><p class="muted">Запустите идемпотентный admin-bootstrap.</p></div></article>';
}

function askSudo(form) {
  state.pendingSecret = form;
  $("#sudo-form").reset();
  $("#sudo-dialog").showModal();
}

async function writeSecret(form) {
  const valueInput = form.elements.value;
  const usedBy = form.elements.used_by.value.split(",").map((item) => item.trim()).filter(Boolean);
  await request(`/secrets/${encodeURIComponent(form.dataset.secret)}`, {
    method: "PUT",
    body: JSON.stringify({ value: valueInput.value, used_by: usedBy }),
  });
  valueInput.value = "";
  state.pendingSecret = null;
  toast("Секрет сохранён; его значение больше не доступно интерфейсу");
  await loadSecrets();
}

async function confirmSudo(password) {
  await request("/sudo", { method: "POST", body: JSON.stringify({ password, scope: "secrets:write" }) });
  $("#sudo-dialog").close();
  if (state.pendingSecret) await writeSecret(state.pendingSecret);
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

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const form = new FormData(formElement);
    const { payload } = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
    });
    formElement.reset();
    showApp(payload.user);
    openPage("settings");
  } catch (error) {
    showLogin(error.message);
  } finally {
    if (submit) submit.disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  try { await request("/auth/logout", { method: "POST" }); } catch {}
  state.me = null;
  showLogin();
});
$("#menu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]");
  if (button) openPage(button.dataset.page);
});
$("#save-settings").addEventListener("click", () => saveSettings().catch(handleError));
$("#settings-form").addEventListener("click", (event) => {
  const button = event.target.closest("[data-reset]");
  if (!button) return;
  const item = state.settings.find((setting) => setting.key === button.dataset.reset);
  const input = document.querySelector(`[data-key="${CSS.escape(item.key)}"]`);
  input.value = String(item.default);
});
$("#reload-secrets").addEventListener("click", () => loadSecrets().catch(handleError));
$("#secrets-list").addEventListener("submit", (event) => {
  event.preventDefault();
  askSudo(event.target);
});
$("#sudo-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    state.pendingSecret = null;
    $("#sudo-dialog").close();
    return;
  }
  confirmSudo(new FormData(event.currentTarget).get("password")).catch(handleError);
});
$("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const data = new FormData(formElement);
  try {
    await request("/auth/password", {
      method: "POST",
      body: JSON.stringify({ current_password: data.get("current_password"), new_password: data.get("new_password") }),
    });
    formElement.reset();
    toast("Пароль изменён");
  } catch (error) { handleError(error); }
});
$("#reload-audit").addEventListener("click", () => loadAudit().catch(handleError));

request("/me").then(({ payload }) => {
  showApp(payload.user);
  openPage("settings");
}).catch(() => showLogin());
