/* Административная консоль Evaself.
 *
 * Браузер обращается только к /api, а внутренний Caddy добавляет X-API-Key
 * при проксировании в eva-agent-service. API Key LLM никогда не возвращается
 * сервером: форма принимает новый ключ, после отправки поле очищается.
 */
(() => {
	"use strict";

	const state = {
		section: "agents",
		agents: [],
		filter: "",
		selected: null,
		tab: "overview",
		providers: [],
	};
	const $ = (id) => document.getElementById(id);

	async function api(path, options = {}) {
		const response = await fetch(`/api${path}`, {
			headers: { "Content-Type": "application/json" },
			...options,
		});
		const text = await response.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		if (!response.ok) {
			const detail =
				body && typeof body === "object" && body.error
					? body.error.message
					: response.statusText;
			throw new Error(`${response.status}: ${detail}`);
		}
		return body;
	}

	const esc = (value) =>
		String(value == null ? "" : value).replace(
			/[&<>"']/g,
			(character) =>
				({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
					character
				],
		);

	function when(value) {
		if (!value) return "—";
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ru-RU");
	}

	function notice(host, message, kind = "success") {
		const element = document.createElement("div");
		element.className = kind === "error" ? "error" : "notice";
		element.textContent = message;
		host.prepend(element);
		setTimeout(() => element.remove(), 8000);
	}

	/* ------------------------------------------------------------ health */
	async function refreshHealth() {
		try {
			const health = await api("/health");
			const appServer = health.checks?.app_server ?? {};
			const ok = health.status === "ok";
			$("health-dot").className = `dot ${ok ? "ok" : "bad"}`;
			$("health-text").textContent = appServer.ok
				? `App Server доступен · моделей: ${appServer.models < 0 ? "неизвестно" : appServer.models}`
				: `App Server: ${appServer.error ?? "недоступен"}`;
			$("server-version").textContent = `SDK v${health.version ?? "?"}`;
		} catch {
			$("health-dot").className = "dot bad";
			$("health-text").textContent = "eva-agent-service недоступен";
			$("server-version").textContent = "нет связи";
		}
	}

	/* ------------------------------------------------------------ navigation */
	function setSection(section) {
		state.section = section;
		for (const button of document.querySelectorAll(".nav-item")) {
			button.classList.toggle("active", button.dataset.section === section);
		}
		$("agent-panel").hidden = section !== "agents";
		$("agent-count").hidden = section !== "agents";
		if (section === "llm") renderLlm();
		else if (state.selected) renderAgent();
		else {
			$("crumb").textContent = "Агенты";
			$("main").innerHTML =
				'<div class="empty">Выберите агента слева, чтобы открыть его данные.</div>';
		}
	}

	for (const button of document.querySelectorAll(".nav-item")) {
		button.addEventListener("click", () => setSection(button.dataset.section));
	}

	/* ------------------------------------------------------------ agents */
	async function loadAgents() {
		try {
			const body = await api("/v1/agents");
			state.agents = body.agents ?? [];
		} catch (error) {
			state.agents = [];
			notice($("main"), `Не удалось получить агентов: ${error.message}`, "error");
		}
		renderAgentList();
	}

	function renderAgentList() {
		const needle = state.filter.trim().toLowerCase();
		const agents = state.agents.filter(
			(agent) =>
				!needle ||
				String(agent.telegram_id).includes(needle) ||
				(agent.agent_id || "").toLowerCase().includes(needle) ||
				(agent.conversation_id || "").toLowerCase().includes(needle),
		);
		$("agent-count").textContent = `агентов: ${state.agents.length}`;
		$("agent-list").innerHTML = agents.length
			? agents
					.map(
						(agent) => `
						<button class="agent${state.selected === String(agent.telegram_id) ? " active" : ""}"
						        data-id="${esc(agent.telegram_id)}">
							tg:${esc(agent.telegram_id)}
							<small>${esc(agent.agent_id)}</small>
							<small>${esc(agent.conversation_id || "conversation отсутствует")}</small>
						</button>`,
					)
					.join("")
			: '<div class="empty small">Совпадений нет.</div>';

		for (const button of $("agent-list").querySelectorAll(".agent")) {
			button.addEventListener("click", () => {
				state.selected = button.dataset.id;
				state.tab = "overview";
				setSection("agents");
				renderAgentList();
			});
		}
	}

	async function renderAgent() {
		const telegramId = state.selected;
		if (!telegramId) return;
		const agent = state.agents.find((item) => String(item.telegram_id) === telegramId) || {};
		$("crumb").textContent = `Агент tg:${telegramId}`;
		const tabs = {
			overview: "Обзор",
			conversations: "Диалоги",
			messages: "Сообщения",
			chat: "Проверка",
		};
		$("main").innerHTML = `
			<div class="tabs">
				${Object.entries(tabs)
					.map(
						([id, label]) =>
							`<button class="tab${state.tab === id ? " active" : ""}" data-tab="${id}">${label}</button>`,
					)
					.join("")}
			</div>
			<div id="tab-body"><div class="empty small">Загрузка…</div></div>`;
		for (const button of $("main").querySelectorAll(".tab")) {
			button.addEventListener("click", () => {
				state.tab = button.dataset.tab;
				renderAgent();
			});
		}
		const host = $("tab-body");
		try {
			if (state.tab === "overview") renderOverview(host, telegramId, agent);
			else if (state.tab === "conversations") await renderConversations(host, telegramId);
			else if (state.tab === "messages") await renderMessages(host, telegramId);
			else renderChat(host, telegramId);
		} catch (error) {
			host.innerHTML = `<div class="error">${esc(error.message)}</div>`;
		}
	}

	function renderOverview(host, telegramId, agent) {
		host.innerHTML = `
			<div class="grid">
				<div class="card">
					<h3>Связь объектов</h3>
					<dl class="kv">
						<dt>telegram_id</dt><dd>${esc(agent.telegram_id)}</dd>
						<dt>agent_id</dt><dd>${esc(agent.agent_id)}</dd>
						<dt>conversation_id</dt><dd>${esc(agent.conversation_id || "—")}</dd>
						<dt>runtime</dt><dd>${esc(agent.runtime)}</dd>
						<dt>model</dt><dd>${esc(agent.model || "—")}</dd>
					</dl>
					<p class="small muted">Связь хранится в PostgreSQL и восстанавливается после перезапуска.</p>
				</div>
				<div class="card">
					<h3>Активность</h3>
					<dl class="kv">
						<dt>сообщений</dt><dd>${esc(agent.message_count ?? 0)}</dd>
						<dt>последнее</dt><dd>${esc(when(agent.last_message_at))}</dd>
						<dt>статус</dt><dd>${esc(agent.status)}</dd>
					</dl>
				</div>
			</div>
			<div class="card">
				<h3>Операции</h3>
				<div class="toolbar">
					<button class="btn ghost" id="new-conv">Начать новый диалог</button>
					<button class="btn ghost" id="release-lock">Снять блокировку хода</button>
					<span class="small muted" id="op-status"></span>
				</div>
				<p class="small muted">Новый диалог не удаляет агента и его память.</p>
			</div>`;

		$("new-conv").addEventListener("click", async () => {
			$("op-status").textContent = "создание…";
			try {
				const result = await api(`/v1/conversations/${encodeURIComponent(telegramId)}`, {
					method: "POST",
				});
				$("op-status").textContent = `активен ${result.conversation_id}`;
				await loadAgents();
			} catch (error) {
				$("op-status").textContent = error.message;
			}
		});
		$("release-lock").addEventListener("click", async () => {
			try {
				const result = await api(`/v1/locks/${encodeURIComponent(telegramId)}/release`, {
					method: "POST",
				});
				$("op-status").textContent = result.released
					? "блокировка снята"
					: "активной блокировки не было";
			} catch (error) {
				$("op-status").textContent = error.message;
			}
		});
	}

	async function renderConversations(host, telegramId) {
		const body = await api(`/v1/conversations/${encodeURIComponent(telegramId)}`);
		const conversations = body.conversations ?? [];
		host.innerHTML = conversations.length
			? `<div class="card"><table>
					<tr><th>conversation</th><th>создан</th><th>последнее сообщение</th><th></th></tr>
					${conversations
						.map(
							(conversation) => `<tr>
								<td><code>${esc(conversation.id)}</code></td>
								<td>${esc(when(conversation.created_at))}</td>
								<td>${esc(when(conversation.last_message_at))}</td>
								<td>${conversation.id === body.active_conversation_id ? '<span class="pill">активен</span>' : ""}</td>
							</tr>`,
						)
						.join("")}
				</table></div>`
			: '<div class="empty">Диалогов пока нет.</div>';
	}

	function messageHtml(message) {
		const kind = message.message_type || message.role || message.type || "message";
		const raw = message.content ?? message.text ?? message.reasoning ?? "";
		const content =
			typeof raw === "string"
				? raw
				: Array.isArray(raw)
					? raw.map((part) => (typeof part === "string" ? part : part.text || "")).join("\n")
					: JSON.stringify(raw);
		const cls = String(kind).includes("user")
			? "user"
			: String(kind).includes("reasoning")
				? "reasoning"
				: String(kind).includes("tool")
					? "tool"
					: "";
		return `<div class="msg ${cls}"><div class="role">${esc(kind)} · ${esc(
			when(message.date || message.created_at),
		)}</div>${esc(content)}</div>`;
	}

	async function renderMessages(host, telegramId) {
		const body = await api(`/v1/conversations/${encodeURIComponent(telegramId)}/messages?limit=60`);
		const messages = Array.isArray(body) ? body : body.messages ?? [];
		host.innerHTML = messages.length
			? messages.map(messageHtml).join("")
			: '<div class="empty">Сообщений пока нет.</div>';
	}

	function renderChat(host, telegramId) {
		host.innerHTML = `
			<div class="card">
				<h3>Проверочный ход от имени пользователя</h3>
				<p class="small muted">Запрос проходит тем же путём через Agent SDK, что и Telegram.</p>
				<textarea id="chat-input" rows="3" placeholder="Введите сообщение…"></textarea>
				<div class="toolbar">
					<button class="btn" id="send">Отправить</button>
					<span class="small muted" id="chat-status"></span>
				</div>
			</div><div id="chat-out"></div>`;
		$("send").addEventListener("click", async () => {
			const input = $("chat-input");
			const text = input.value.trim();
			if (!text) return;
			$("send").disabled = true;
			$("chat-status").textContent = "ожидание ответа…";
			try {
				const result = await api("/v1/messages", {
					method: "POST",
					body: JSON.stringify({ telegram_id: Number(telegramId), text, count_usage: false }),
				});
				$("chat-out").insertAdjacentHTML(
					"afterbegin",
					`<div class="msg"><div class="role">Ева · ${esc(result.durationMs)} мс</div>${esc(result.reply)}</div>`,
				);
				$("chat-status").textContent = "готово";
				input.value = "";
			} catch (error) {
				$("chat-status").textContent = error.message;
			} finally {
				$("send").disabled = false;
			}
		});
	}

	/* ------------------------------------------------------------ LLM */
	async function renderLlm() {
		$("crumb").textContent = "Настройки LLM";
		$("main").innerHTML = '<div class="empty small">Загрузка конфигураций…</div>';
		try {
			const body = await api("/v1/llm/providers");
			state.providers = body.providers ?? [];
			renderLlmList();
		} catch (error) {
			$("main").innerHTML = `<div class="error">${esc(error.message)}</div>`;
		}
	}

	function renderLlmList() {
		const active = state.providers.find((provider) => provider.is_active);
		$("main").innerHTML = `
			<div class="page-heading">
				<div>
					<h2>Настройки LLM</h2>
					<p class="muted">OpenAI-compatible провайдеры для существующих агентов и диалогов.</p>
				</div>
				<button class="btn" id="add-provider">Добавить провайдера</button>
			</div>
			${
				active
					? `<div class="card active-provider">
							<span class="pill">Активная конфигурация</span>
							<h3>${esc(active.name)}</h3>
							<div><code>${esc(active.model_handle)}</code> · context ${esc(active.context_window)}</div>
							<div class="small muted">${esc(active.base_url)}</div>
							<div class="small ${active.last_check_ok === false ? "danger-text" : "muted"}">
								Последняя проверка: ${esc(active.last_check_message || "ещё не выполнялась")}
								${active.last_checked_at ? ` · ${esc(when(active.last_checked_at))}` : ""}
							</div>
						</div>`
					: '<div class="error">Активная LLM-конфигурация не выбрана.</div>'
			}
			<div id="provider-form"></div>
			<div id="provider-list">
				${
					state.providers.length
						? state.providers.map(providerCard).join("")
						: '<div class="empty">Добавьте первую конфигурацию.</div>'
				}
			</div>`;

		$("add-provider").addEventListener("click", () => renderProviderForm(null));
		for (const button of $("main").querySelectorAll("[data-action]")) {
			button.addEventListener("click", () =>
				handleProviderAction(button.dataset.action, button.dataset.id),
			);
		}
	}

	function providerCard(provider) {
		return `<div class="card provider-card" data-provider="${esc(provider.id)}">
			<div class="provider-title">
				<div>
					<h3>${esc(provider.name)} ${provider.is_active ? '<span class="pill">активна</span>' : ""}</h3>
					<div><code>${esc(provider.model_handle)}</code></div>
				</div>
				<div class="small muted">${esc(provider.protocol)}</div>
			</div>
			<dl class="kv">
				<dt>Base URL</dt><dd>${esc(provider.base_url)}</dd>
				<dt>Context window</dt><dd>${esc(provider.context_window)}</dd>
				<dt>API Key</dt><dd>${provider.api_key_configured ? "сохранён и скрыт" : "не задан"}</dd>
				<dt>Проверка</dt><dd class="${provider.last_check_ok === false ? "danger-text" : ""}">
					${esc(provider.last_check_message || "не выполнялась")}
				</dd>
			</dl>
			<div class="toolbar">
				<button class="btn ghost" data-action="edit" data-id="${esc(provider.id)}">Изменить</button>
				<button class="btn ghost" data-action="test" data-id="${esc(provider.id)}">Проверить</button>
				<button class="btn ghost" data-action="models" data-id="${esc(provider.id)}">Получить модели</button>
				${
					provider.is_active
						? ""
						: `<button class="btn" data-action="activate" data-id="${esc(provider.id)}">Сделать активной</button>
						   <button class="btn danger" data-action="delete" data-id="${esc(provider.id)}">Удалить</button>`
				}
			</div>
			<div class="provider-result small" id="result-${esc(provider.id)}"></div>
		</div>`;
	}

	function renderProviderForm(provider) {
		const editing = Boolean(provider);
		$("provider-form").innerHTML = `
			<form class="card provider-form" id="llm-form">
				<h3>${editing ? `Изменить «${esc(provider.name)}»` : "Новый LLM-провайдер"}</h3>
				<div class="form-grid">
					<label>Название<input name="name" required value="${esc(provider?.name || "")}" /></label>
					<label>Протокол<input value="openai-compatible" disabled /></label>
					<label class="span-2">Base URL<input name="base_url" type="url" required placeholder="https://provider.example/v1" value="${esc(provider?.base_url || "")}" /></label>
					<label class="span-2">API Key
						<input name="api_key" type="password" ${editing ? "" : "required"}
						       autocomplete="new-password"
						       placeholder="${editing ? "Оставьте пустым, чтобы сохранить текущий ключ" : "Введите API Key"}" />
					</label>
					<label>Модель<input name="model" required list="model-options" value="${esc(provider?.model || "")}" /></label>
					<label>Context window<input name="context_window" type="number" min="1024" required value="${esc(provider?.context_window || 32768)}" /></label>
					<label class="span-2">Дополнительные параметры JSON
						<textarea name="additional_parameters" class="block">${esc(
							JSON.stringify(provider?.additional_parameters || { request_timeout_ms: 180000 }, null, 2),
						)}</textarea>
					</label>
				</div>
				<datalist id="model-options"></datalist>
				<div class="toolbar">
					<button class="btn" type="submit">Сохранить</button>
					<button class="btn ghost" type="button" id="cancel-form">Отмена</button>
					<span class="small muted" id="form-status"></span>
				</div>
				<p class="small muted">После сохранения API Key больше не отображается и не возвращается браузеру.</p>
			</form>`;
		$("cancel-form").addEventListener("click", () => {
			$("provider-form").innerHTML = "";
		});
		$("llm-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			const formElement = event.currentTarget;
			const form = new FormData(formElement);
			let additional;
			try {
				additional = JSON.parse(form.get("additional_parameters") || "{}");
				if (!additional || Array.isArray(additional) || typeof additional !== "object") {
					throw new Error("нужен JSON-объект");
				}
			} catch (error) {
				$("form-status").textContent = `Некорректный JSON: ${error.message}`;
				return;
			}
			const payload = {
				name: form.get("name"),
				protocol: "openai-compatible",
				base_url: form.get("base_url"),
				model: form.get("model"),
				context_window: Number(form.get("context_window")),
				additional_parameters: additional,
			};
			const key = String(form.get("api_key") || "");
			if (key) payload.api_key = key;
			$("form-status").textContent = provider?.is_active
				? "сохранение и безопасное переключение…"
				: "сохранение…";
			try {
				await api(
					editing ? `/v1/llm/providers/${encodeURIComponent(provider.id)}` : "/v1/llm/providers",
					{ method: editing ? "PATCH" : "POST", body: JSON.stringify(payload) },
				);
				formElement.reset();
				await renderLlm();
				notice($("main"), "LLM-конфигурация сохранена.");
			} catch (error) {
				$("form-status").textContent = error.message;
			}
		});
		$("llm-form").scrollIntoView({ behavior: "smooth", block: "start" });
	}

	async function handleProviderAction(action, id) {
		const provider = state.providers.find((item) => item.id === id);
		if (!provider) return;
		const result = $(`result-${id}`);
		if (action === "edit") {
			renderProviderForm(provider);
			return;
		}
		if (action === "delete") {
			if (!confirm(`Удалить неактивную конфигурацию «${provider.name}»?`)) return;
			try {
				await api(`/v1/llm/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
				await renderLlm();
				notice($("main"), "Конфигурация удалена.");
			} catch (error) {
				result.textContent = error.message;
			}
			return;
		}
		if (action === "activate") {
			if (
				!confirm(
					`Переключить всех существующих agents и conversations на ${provider.model_handle}?`,
				)
			)
				return;
			result.textContent = "Проверка, переконфигурация App Server и healthcheck…";
			try {
				await api(`/v1/llm/providers/${encodeURIComponent(id)}/activate`, { method: "POST" });
				await renderLlm();
				notice($("main"), "Модель переключена. Идентификаторы и память сохранены.");
			} catch (error) {
				result.textContent = `${error.message} Предыдущая конфигурация сохранена активной.`;
			}
			return;
		}

		result.textContent = action === "models" ? "Получение /models…" : "Проверка подключения…";
		try {
			const body = await api(
				action === "models"
					? `/v1/llm/providers/${encodeURIComponent(id)}/models`
					: `/v1/llm/providers/${encodeURIComponent(id)}/test`,
				{ method: action === "models" ? "GET" : "POST" },
			);
			const probe = body.result;
			const models = probe.models || [];
			result.innerHTML = `${esc(probe.message)}${
				models.length
					? `<div class="model-list">${models
							.map((model) => `<code>${esc(model.id)}</code>`)
							.join(" ")}</div>`
					: probe.models_supported
						? ""
						: "<div>Endpoint не поддержан: модель можно ввести вручную.</div>"
			}`;
		} catch (error) {
			result.textContent = error.message;
		}
	}

	/* ------------------------------------------------------------ boot */
	$("filter").addEventListener("input", (event) => {
		state.filter = event.target.value;
		renderAgentList();
	});
	$("refresh").addEventListener("click", async () => {
		await refreshHealth();
		if (state.section === "llm") await renderLlm();
		else {
			await loadAgents();
			if (state.selected) renderAgent();
		}
	});

	refreshHealth();
	loadAgents();
	setInterval(refreshHealth, 30000);
})();
