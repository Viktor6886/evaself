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
		selectedConversation: null,
		tab: "overview",
		providers: [],
		sdk: null,
	};
	const $ = (id) => document.getElementById(id);

	async function api(path, options = {}) {
		const headers = { ...(options.headers || {}) };
		if (options.body) headers["Content-Type"] = "application/json";
		const response = await fetch(`/api${path}`, {
			...options,
			headers,
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
		else if (section === "sdk") renderSdk();
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
			const body = await api("/v1/sdk/agents");
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
				(agent.name || "").toLowerCase().includes(needle) ||
				(agent.id || "").toLowerCase().includes(needle) ||
				(agent.model || "").toLowerCase().includes(needle),
		);
		$("agent-count").textContent = `агентов: ${state.agents.length}`;
		$("agent-list").innerHTML = agents.length
			? agents
					.map(
						(agent) => `
						<button class="agent${state.selected === agent.id ? " active" : ""}"
						        data-id="${esc(agent.id)}">
							${esc(agent.name || "Без имени")}
							<small>${esc(agent.id)}</small>
							<small>${esc(agent.model || "модель по умолчанию")}</small>
						</button>`,
					)
					.join("")
			: '<div class="empty small">Совпадений нет.</div>';

		for (const button of $("agent-list").querySelectorAll(".agent")) {
			button.addEventListener("click", () => {
				state.selected = button.dataset.id;
				state.selectedConversation = null;
				state.tab = "overview";
				setSection("agents");
				renderAgentList();
			});
		}
	}

	async function renderAgent() {
		const agentId = state.selected;
		if (!agentId) return;
		const agent = state.agents.find((item) => item.id === agentId) || {};
		$("crumb").textContent = `Агент · ${agent.name || agentId}`;
		const tabs = {
			overview: "Обзор",
			conversations: "Диалоги",
			chat: "Чат",
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
			if (state.tab === "overview") await renderOverview(host, agentId);
			else if (state.tab === "conversations") await renderConversations(host, agentId);
			else await renderChat(host, agentId);
		} catch (error) {
			host.innerHTML = `<div class="error">${esc(error.message)}</div>`;
		}
	}

	async function renderOverview(host, agentId) {
		const { agent } = await api(`/v1/sdk/agents/${encodeURIComponent(agentId)}`);
		host.innerHTML = `
			<form class="card" id="agent-form">
				<h3>Параметры агента</h3>
				<div class="form-grid">
					<label>Имя<input name="name" required value="${esc(agent.name || "")}" /></label>
					<label>Модель<input name="model" value="${esc(agent.model || "")}" /></label>
					<label class="span-2">Описание<input name="description" value="${esc(agent.description || "")}" /></label>
					<label>Context window<input name="context_window" type="number" min="1024" value="${esc(agent.context_window_limit || "")}" /></label>
					<label>Теги через запятую<input name="tags" value="${esc((agent.tags || []).join(", "))}" /></label>
					<label class="span-2">System prompt<textarea name="system" rows="8">${esc(agent.system || "")}</textarea></label>
					<label class="check"><input name="hidden" type="checkbox" ${agent.hidden ? "checked" : ""} /> Скрытый агент</label>
				</div>
				<div class="toolbar">
					<button class="btn" type="submit">Сохранить</button>
					<button class="btn danger" type="button" id="delete-agent">Удалить агента</button>
					<span class="small muted" id="agent-status"></span>
				</div>
				<p class="small muted">Persona и Human являются блоками памяти: их содержимое задаётся при создании, а затем сохраняется самой Letta.</p>
			</form>
			<div class="card"><h3>Технические данные</h3><dl class="kv">
				<dt>agent_id</dt><dd>${esc(agent.id)}</dd>
				<dt>создан</dt><dd>${esc(when(agent.created_at))}</dd>
				<dt>последний запуск</dt><dd>${esc(when(agent.last_run_completion))}</dd>
				<dt>tools</dt><dd>${esc((agent.tools || []).map((tool) => tool.name).filter(Boolean).join(", ") || "—")}</dd>
			</dl></div>`;

		$("agent-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = new FormData(event.currentTarget);
			const payload = {
				name: form.get("name"),
				description: form.get("description"),
				tags: String(form.get("tags") || "").split(",").map((item) => item.trim()).filter(Boolean),
				system: form.get("system"),
				hidden: form.get("hidden") === "on",
			};
			if (String(form.get("model") || "").trim()) payload.model = form.get("model");
			if (String(form.get("context_window") || "").trim()) payload.context_window = Number(form.get("context_window"));
			try {
				await api(`/v1/sdk/agents/${encodeURIComponent(agentId)}`, {
					method: "PATCH",
					body: JSON.stringify(payload),
				});
				$("agent-status").textContent = "сохранено";
				await loadAgents();
			} catch (error) {
				$("agent-status").textContent = error.message;
			}
		});
		$("delete-agent").addEventListener("click", async () => {
			const confirmation = prompt(
				`Удаление необратимо удалит агента, его conversations и память.\nВведите agent_id для подтверждения:\n${agentId}`,
			);
			if (confirmation !== agentId) return;
			$("agent-status").textContent = "удаление…";
			try {
				await api(`/v1/sdk/agents/${encodeURIComponent(agentId)}?confirm=${encodeURIComponent(agentId)}`, {
					method: "DELETE",
				});
				state.selected = null;
				state.selectedConversation = null;
				await loadAgents();
				setSection("agents");
				notice($("main"), "Агент удалён.");
			} catch (error) {
				$("agent-status").textContent = error.message;
			}
		});
	}

	async function renderConversations(host, agentId) {
		const body = await api(`/v1/sdk/agents/${encodeURIComponent(agentId)}/conversations`);
		const conversations = body.conversations ?? [];
		host.innerHTML = `
			<div class="card">
				<h3>Новый диалог</h3>
				<div class="form-grid">
					<label>Название<input id="conversation-summary" value="Новый диалог" /></label>
					<label>Описание<input id="conversation-description" /></label>
				</div>
				<div class="toolbar"><button class="btn" id="create-conversation">Создать</button><span id="conversation-status" class="small muted"></span></div>
			</div>
			${conversations.length
			? `<div class="card"><table>
					<tr><th>conversation</th><th>название</th><th>последнее сообщение</th><th>действия</th></tr>
					${conversations
						.map(
							(conversation) => `<tr>
								<td><code>${esc(conversation.id)}</code></td>
								<td>${esc(conversation.summary || "—")}</td>
								<td>${esc(when(conversation.last_message_at))}</td>
								<td><button class="btn ghost" data-chat="${esc(conversation.id)}">Открыть чат</button>
									${conversation.archived ? '<span class="pill">архив</span>' : `<button class="btn ghost" data-archive="${esc(conversation.id)}">Архивировать</button>`}</td>
							</tr>`,
						)
						.join("")}
				</table></div>`
			: '<div class="empty">Диалогов пока нет.</div>'}`;
		$("create-conversation").addEventListener("click", async () => {
			$("conversation-status").textContent = "создание…";
			try {
				const result = await api(`/v1/sdk/agents/${encodeURIComponent(agentId)}/conversations`, {
					method: "POST",
					body: JSON.stringify({
						summary: $("conversation-summary").value,
						description: $("conversation-description").value,
					}),
				});
				state.selectedConversation = result.conversation.id;
				state.tab = "chat";
				await renderAgent();
			} catch (error) {
				$("conversation-status").textContent = error.message;
			}
		});
		for (const button of host.querySelectorAll("[data-chat]")) {
			button.addEventListener("click", () => {
				state.selectedConversation = button.dataset.chat;
				state.tab = "chat";
				renderAgent();
			});
		}
		for (const button of host.querySelectorAll("[data-archive]")) {
			button.addEventListener("click", async () => {
				if (!confirm("Архивировать диалог? Его история и память не удаляются.")) return;
				await api(`/v1/sdk/conversations/${encodeURIComponent(button.dataset.archive)}`, {
					method: "PATCH",
					body: JSON.stringify({ archived: true }),
				});
				await renderConversations(host, agentId);
			});
		}
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

	async function loadMessages(conversationId) {
		const body = await api(`/v1/sdk/conversations/${encodeURIComponent(conversationId)}/messages?limit=60`);
		const messages = Array.isArray(body) ? body : body.messages ?? [];
		$("chat-out").innerHTML = messages.length
			? messages.map(messageHtml).join("")
			: '<div class="empty">Сообщений пока нет.</div>';
	}

	async function renderChat(host, agentId) {
		const body = await api(`/v1/sdk/agents/${encodeURIComponent(agentId)}/conversations`);
		const conversations = (body.conversations ?? []).filter((item) => !item.archived);
		if (!state.selectedConversation || !conversations.some((item) => item.id === state.selectedConversation)) {
			state.selectedConversation = conversations[0]?.id || null;
		}
		host.innerHTML = `
			<div class="card">
				<h3>Чат через официальный Agent SDK</h3>
				<label>Диалог<select id="chat-conversation">
					${conversations.map((item) => `<option value="${esc(item.id)}" ${item.id === state.selectedConversation ? "selected" : ""}>${esc(item.summary || item.id)}</option>`).join("")}
				</select></label>
				<textarea id="chat-input" rows="3" placeholder="Введите сообщение…"></textarea>
				<div class="toolbar">
					<button class="btn" id="send" ${state.selectedConversation ? "" : "disabled"}>Отправить</button>
					<span class="small muted" id="chat-status"></span>
				</div>
				${state.selectedConversation ? "" : '<p class="error">Сначала создайте диалог на вкладке «Диалоги».</p>'}
			</div><div id="chat-out"></div>`;
		$("chat-conversation").addEventListener("change", async (event) => {
			state.selectedConversation = event.target.value;
			await loadMessages(state.selectedConversation);
		});
		if (state.selectedConversation) await loadMessages(state.selectedConversation);
		$("send").addEventListener("click", async () => {
			const input = $("chat-input");
			const text = input.value.trim();
			if (!text) return;
			$("send").disabled = true;
			$("chat-status").textContent = "ожидание ответа…";
			try {
				$("chat-out").insertAdjacentHTML("afterbegin", `<div class="msg user"><div class="role">Вы</div>${esc(text)}</div>`);
				const result = await api(`/v1/sdk/conversations/${encodeURIComponent(state.selectedConversation)}/messages`, {
					method: "POST",
					body: JSON.stringify({ text }),
				});
				$("chat-out").insertAdjacentHTML(
					"afterbegin",
					`<div class="msg"><div class="role">Агент · ${esc(result.durationMs)} мс</div>${esc(result.reply)}</div>`,
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

	function renderNewAgent() {
		$("crumb").textContent = "Новый агент";
		$("main").innerHTML = `
			<form class="card" id="new-agent-form">
				<h3>Создать агента через Letta Agent SDK</h3>
				<div class="form-grid">
					<label>Имя<input name="name" required /></label>
					<label>Модель (пусто = активная LLM)<input name="model" /></label>
					<label class="span-2">Описание<input name="description" /></label>
					<label class="span-2">Persona<textarea name="persona" rows="6" placeholder="Пусто = шаблон из настроек SDK"></textarea></label>
					<label class="span-2">Human memory<textarea name="human" rows="4"></textarea></label>
					<label class="span-2">Дополнительные memory blocks (JSON-массив)
						<textarea name="memory_json" rows="8" placeholder='[{"label":"project","value":"Контекст","description":"Описание","read_only":false,"limit":8000}]'></textarea>
					</label>
					<label>Теги через запятую<input name="tags" value="evaself" /></label>
					<label>Permission mode<select name="permission_mode"><option>unrestricted</option><option>standard</option><option>acceptEdits</option></select></label>
					<label class="check"><input name="memfs_enabled" type="checkbox" checked /> Memory filesystem</label>
					<label class="check"><input name="create_conversation" type="checkbox" checked /> Сразу создать диалог</label>
				</div>
				<div class="toolbar"><button class="btn" type="submit">Создать</button><span class="small muted" id="new-agent-status"></span></div>
			</form>`;
		$("new-agent-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = new FormData(event.currentTarget);
			const payload = {
				name: form.get("name"),
				description: form.get("description"),
				tags: String(form.get("tags") || "").split(",").map((item) => item.trim()).filter(Boolean),
				permission_mode: form.get("permission_mode"),
				memfs_enabled: form.get("memfs_enabled") === "on",
				create_conversation: form.get("create_conversation") === "on",
			};
			for (const field of ["model", "persona", "human"]) {
				if (String(form.get(field) || "").trim()) payload[field] = form.get(field);
			}
			$("new-agent-status").textContent = "создание…";
			try {
				const memoryRaw = String(form.get("memory_json") || "").trim();
				if (memoryRaw) {
					const memory = JSON.parse(memoryRaw);
					if (!Array.isArray(memory)) throw new Error("Memory blocks должны быть JSON-массивом");
					payload.memory = memory;
				}
				const result = await api("/v1/sdk/agents", { method: "POST", body: JSON.stringify(payload) });
				state.selected = result.agent.id;
				state.selectedConversation = result.conversation?.id || null;
				state.tab = state.selectedConversation ? "chat" : "overview";
				await loadAgents();
				await renderAgent();
			} catch (error) {
				$("new-agent-status").textContent = error.message;
			}
		});
	}

	$("new-agent").addEventListener("click", renderNewAgent);

	/* ------------------------------------------------------------ SDK */
	async function renderSdk() {
		$("crumb").textContent = "Настройки Letta Agent SDK";
		$("main").innerHTML = '<div class="empty small">Загрузка настроек SDK…</div>';
		try {
			const body = await api("/v1/sdk/settings");
			state.sdk = body.settings;
			renderSdkForm();
		} catch (error) {
			$("main").innerHTML = `<div class="error">${esc(error.message)}</div>`;
		}
	}

	function lines(value) {
		return Array.isArray(value) ? value.join("\n") : "";
	}

	function readLines(value) {
		return String(value || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
	}

	function parseJsonField(form, name) {
		const raw = String(form.get(name) || "{}").trim() || "{}";
		const value = JSON.parse(raw);
		if (!value || Array.isArray(value) || typeof value !== "object") {
			throw new Error(`${name}: нужен JSON-объект`);
		}
		return value;
	}

	function renderSdkForm() {
		const settings = state.sdk;
		$("main").innerHTML = `
			<div class="page-heading">
				<div><h2>Настройки Letta Agent SDK</h2>
					<p class="muted">Параметры применяются к новым агентам и новым SDK-сессиям без переустановки.</p></div>
				<button class="btn ghost" id="test-sdk">Проверить SDK</button>
			</div>
			<div class="card">
				<h3>Защищённое подключение</h3>
				<dl class="kv">
					<dt>backend</dt><dd>${esc(settings.backend)}</dd>
					<dt>transport</dt><dd>${esc(settings.transport)}</dd>
					<dt>App Server</dt><dd>${esc(settings.app_server_url)}</dd>
					<dt>capability token</dt><dd>${settings.app_server_auth_configured ? "настроен и скрыт" : "не задан"}</dd>
				</dl>
				<p class="small muted">URL и token относятся к инфраструктуре VPS: браузер может видеть URL, но никогда не получает token.</p>
				<div id="sdk-test-result" class="small muted"></div>
			</div>
			<form id="sdk-form">
				<div class="card">
					<h3>Шаблон новых агентов</h3>
					<div class="form-grid">
						<label>Префикс имени<input name="agent_name_prefix" value="${esc(settings.agent_name_prefix)}" required /></label>
						<label>Permission mode<select name="permission_mode">
							${["standard", "acceptEdits", "unrestricted"].map((value) => `<option ${settings.permission_mode === value ? "selected" : ""}>${value}</option>`).join("")}
						</select></label>
						<label class="span-2">Описание<input name="default_description" value="${esc(settings.default_description)}" /></label>
						<label class="span-2">Persona<textarea name="default_persona" rows="10">${esc(settings.default_persona)}</textarea></label>
						<label class="span-2">Human template<textarea name="default_human_template" rows="4">${esc(settings.default_human_template)}</textarea>
							<span>Подстановки: <code>{{display_name}}</code>, <code>{{telegram_id}}</code></span></label>
						<label class="span-2">System prompt (пусто = preset SDK)<textarea name="system_prompt" rows="7">${esc(settings.system_prompt || "")}</textarea></label>
						<label>Теги, по одному в строке<textarea name="default_tags">${esc(lines(settings.default_tags))}</textarea></label>
						<label>Skill sources<textarea name="skill_sources">${esc(lines(settings.skill_sources))}</textarea></label>
						<label>Base tools (пусто = defaults SDK)<textarea name="base_tools">${esc(lines(settings.base_tools))}</textarea></label>
						<label>Allowed tools (пусто = defaults SDK)<textarea name="allowed_tools">${esc(lines(settings.allowed_tools))}</textarea></label>
						<label>Context window<input name="default_context_window" type="number" min="1024" value="${esc(settings.default_context_window || "")}" placeholder="из активной LLM" /></label>
						<label class="span-2">Model settings JSON<textarea class="block" name="model_settings">${esc(JSON.stringify(settings.model_settings || {}, null, 2))}</textarea></label>
						<label class="span-2">Dreaming JSON<textarea class="block" name="dreaming">${esc(JSON.stringify(settings.dreaming || { trigger: "off" }, null, 2))}</textarea></label>
						<label class="check"><input name="memfs_enabled" type="checkbox" ${settings.memfs_enabled ? "checked" : ""} /> Включать memory filesystem</label>
						<p class="small muted span-2">Официальный SDK для self-hosted App Server пока не принимает <code>disallowedTools</code>, <code>systemInfoReminder</code> и <code>dreaming.behavior</code>. Для ограничения инструментов используйте Allowed tools; интерфейс не имитирует неподдерживаемые настройки.</p>
					</div>
				</div>
				<div class="card">
					<h3>Шаблон новых диалогов</h3>
					<div class="form-grid">
						<label>Название<input name="conversation_summary" value="${esc(settings.conversation_summary)}" /></label>
						<label>Описание<input name="conversation_description" value="${esc(settings.conversation_description)}" /></label>
						<label class="check"><input name="create_conversation" type="checkbox" ${settings.create_conversation ? "checked" : ""} /> Создавать диалог вместе с агентом</label>
						<label class="check"><input name="conversation_hidden" type="checkbox" ${settings.conversation_hidden ? "checked" : ""} /> Создавать скрытым</label>
					</div>
				</div>
				<div class="card">
					<h3>Сессии и таймауты</h3>
					<div class="form-grid">
						<label>Размер пула сессий<input name="session_pool_size" type="number" min="1" max="500" value="${esc(settings.session_pool_size)}" /></label>
						<label>Idle timeout, мс<input name="session_idle_ms" type="number" min="1000" value="${esc(settings.session_idle_ms)}" /></label>
						<label>Turn timeout, мс<input name="turn_timeout_ms" type="number" min="1000" value="${esc(settings.turn_timeout_ms)}" /></label>
						<label>App Server request timeout, мс<input name="app_server_request_timeout_ms" type="number" min="1000" value="${esc(settings.app_server_request_timeout_ms)}" /></label>
					</div>
				</div>
				<div class="toolbar sticky-actions">
					<button class="btn" type="submit">Сохранить настройки SDK</button>
					<span class="small muted" id="sdk-status">Последнее изменение: ${esc(when(settings.updated_at))}</span>
				</div>
			</form>`;

		$("test-sdk").addEventListener("click", async () => {
			$("sdk-test-result").textContent = "Проверка WebSocket и протокола…";
			try {
				const body = await api("/v1/sdk/test", { method: "POST" });
				$("sdk-test-result").textContent = `SDK доступен; моделей: ${body.result.models < 0 ? "endpoint не поддержан" : body.result.models}`;
			} catch (error) {
				$("sdk-test-result").textContent = error.message;
			}
		});

		$("sdk-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = new FormData(event.currentTarget);
			$("sdk-status").textContent = "проверка и сохранение…";
			try {
				const context = String(form.get("default_context_window") || "").trim();
				const payload = {
					agent_name_prefix: form.get("agent_name_prefix"),
					default_description: form.get("default_description"),
					default_persona: form.get("default_persona"),
					default_human_template: form.get("default_human_template"),
					default_tags: readLines(form.get("default_tags")),
					permission_mode: form.get("permission_mode"),
					memfs_enabled: form.get("memfs_enabled") === "on",
					system_prompt: String(form.get("system_prompt") || "").trim() || null,
					base_tools: readLines(form.get("base_tools")).length ? readLines(form.get("base_tools")) : null,
					allowed_tools: readLines(form.get("allowed_tools")).length ? readLines(form.get("allowed_tools")) : null,
					skill_sources: readLines(form.get("skill_sources")),
					dreaming: parseJsonField(form, "dreaming"),
					model_settings: parseJsonField(form, "model_settings"),
					default_context_window: context ? Number(context) : null,
					conversation_summary: form.get("conversation_summary"),
					conversation_description: form.get("conversation_description"),
					conversation_hidden: form.get("conversation_hidden") === "on",
					create_conversation: form.get("create_conversation") === "on",
					session_pool_size: Number(form.get("session_pool_size")),
					session_idle_ms: Number(form.get("session_idle_ms")),
					turn_timeout_ms: Number(form.get("turn_timeout_ms")),
					app_server_request_timeout_ms: Number(form.get("app_server_request_timeout_ms")),
				};
				const body = await api("/v1/sdk/settings", {
					method: "PATCH",
					body: JSON.stringify(payload),
				});
				state.sdk = body.settings;
				renderSdkForm();
				notice($("main"), "Настройки SDK сохранены и применены.");
			} catch (error) {
				$("sdk-status").textContent = error.message;
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
		else if (state.section === "sdk") await renderSdk();
		else {
			await loadAgents();
			if (state.selected) renderAgent();
		}
	});

	refreshHealth();
	loadAgents();
	setInterval(refreshHealth, 30000);
})();
