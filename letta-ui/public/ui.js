/* Административная консоль Evaself.
 *
 * Браузер обращается только к /api, а внутренний Caddy добавляет X-API-Key
 * при проксировании в eva-agent-service. API Key LLM никогда не возвращается
 * сервером: форма принимает новый ключ, после отправки поле очищается.
 */
(() => {
	"use strict";

	const state = {
		section: "dashboard",
		agents: [],
		filter: "",
		typeFilter: "",
		visibilityFilter: "",
		selected: null,
		selectedAgents: new Set(),
		selectedConversation: null,
		lastPrompt: "",
		tab: "overview",
		providers: [],
		sdk: null,
		system: null,
	};
	const $ = (id) => document.getElementById(id);
	const API_PREFIX = window.location.pathname.startsWith("/admin/")
		? "/admin-api"
		: "/api";

	async function api(path, options = {}) {
		const headers = { ...(options.headers || {}) };
		if (options.body) headers["Content-Type"] = "application/json";
		const response = await fetch(`${API_PREFIX}${path}`, {
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

	async function streamApi(path, payload, onEvent) {
		const response = await fetch(`${API_PREFIX}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
			body: JSON.stringify(payload),
		});
		if (!response.ok || !response.body) {
			const text = await response.text();
			throw new Error(`${response.status}: ${text || response.statusText}`);
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let finalResult = null;
		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
			const frames = buffer.split(/\r?\n\r?\n/);
			buffer = frames.pop() || "";
			for (const frame of frames) {
				let name = "message";
				const data = [];
				for (const line of frame.split(/\r?\n/)) {
					if (line.startsWith("event:")) name = line.slice(6).trim();
					if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
				}
				if (!data.length) continue;
				const value = JSON.parse(data.join("\n"));
				onEvent(name, value);
				if (name === "result") finalResult = value;
				if (name === "error") throw new Error(value.message || "Ошибка streaming turn");
			}
			if (done) break;
		}
		if (!finalResult) throw new Error("Поток завершился без итогового события");
		return finalResult;
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
		if (section === "dashboard") renderDashboard();
		else if (section === "audit") renderAudit();
		else if (section === "llm") renderLlm();
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

	/* --------------------------------------------------------- dashboard */
	async function renderDashboard() {
		$("crumb").textContent = "Обзор системы";
		$("main").innerHTML = '<div class="empty small">Загрузка состояния…</div>';
		try {
			const [system, health, stats] = await Promise.all([
				api("/v1/system"),
				api("/health"),
				api("/v1/stats"),
			]);
			state.system = system;
			const links = Object.entries(system.links || {}).filter(([, value]) => value);
			const integrations = Object.entries(system.integrations || {});
			const capabilities = system.sdk_capabilities || {};
			$("main").innerHTML = `
				<div class="page-heading">
					<div><h2>Evaself</h2><p class="muted">Self-hosted Letta App Server через официальный Agent SDK.</p></div>
					<span class="pill">${esc(system.runtime)} · ${esc(system.version)}</span>
				</div>
				${system.setup_complete
					? '<div class="notice">Первичная конфигурация завершена.</div>'
					: `<div class="error"><strong>Настройка не завершена:</strong> ${esc((system.incomplete_settings || []).join(", "))}.
					   Заполните через <code>make configure</code> или раздел LLM.</div>`}
				<div class="grid">
					<div class="card"><h3>Состояние</h3><dl class="kv">
						<dt>App Server</dt><dd>${health.checks?.app_server?.ok ? "доступен" : esc(health.checks?.app_server?.error || "недоступен")}</dd>
						<dt>PostgreSQL</dt><dd>${health.checks?.postgres?.ok ? "доступен" : "ошибка"}</dd>
						<dt>Valkey</dt><dd>${health.checks?.valkey?.ok ? "доступен" : "ошибка"}</dd>
						<dt>Агенты</dt><dd>${esc(stats.agents ?? state.agents.length)}</dd>
						<dt>Открытые сессии</dt><dd>${esc(health.sessions_open ?? 0)}</dd>
						<dt>Часовой пояс</dt><dd>${esc(system.timezone)}</dd>
					</dl></div>
					<div class="card"><h3>Интеграции</h3><dl class="kv">
						${integrations.map(([name, enabled]) => `<dt>${esc(name)}</dt><dd>${enabled ? "настроена" : "не настроена"}</dd>`).join("")}
					</dl></div>
					<div class="card"><h3>Адреса</h3>
						${links.map(([name, value]) => `<div><a href="${esc(value)}" target="_blank" rel="noopener">${esc(name)}</a> <span class="small muted">${esc(value)}</span></div>`).join("") || "—"}
					</div>
					<div class="card"><h3>Активная LLM</h3>
						${system.active_llm
							? `<strong>${esc(system.active_llm.name)}</strong><div><code>${esc(system.active_llm.model_handle)}</code></div><div class="small muted">${esc(system.active_llm.base_url)}</div>`
							: '<span class="danger-text">Не выбрана</span>'}
					</div>
				</div>
				<div class="card"><h3>Фактические возможности App Server SDK</h3>
					<div class="capability-grid">
						${capabilityRows(capabilities)}
					</div>
					<p class="small muted">Интерфейс не имитирует функции, которых нет в WebSocket management API установленной версии SDK.</p>
				</div>`;
		} catch (error) {
			$("main").innerHTML = `<div class="error">${esc(error.message)}</div>`;
		}
	}

	function capabilityRows(capabilities) {
		const rows = [];
		for (const [group, values] of Object.entries(capabilities || {})) {
			for (const [name, value] of Object.entries(values || {})) {
				if (name === "reason") continue;
				if (typeof value !== "boolean") continue;
				rows.push(`<div><span class="dot ${value ? "ok" : "bad"}"></span> ${esc(group)}.${esc(name)}</div>`);
			}
			if (values?.reason) rows.push(`<div class="small muted span-2">${esc(values.reason)}</div>`);
		}
		return rows.join("");
	}

	/* ------------------------------------------------------------- audit */
	async function renderAudit() {
		$("crumb").textContent = "Журнал аудита";
		$("main").innerHTML = '<div class="empty small">Загрузка журнала…</div>';
		try {
			const body = await api("/v1/audit?limit=200");
			const events = body.events || [];
			$("main").innerHTML = `
				<div class="page-heading"><div><h2>Журнал аудита</h2>
					<p class="muted">Изменения агентов и диалогов; содержимое чатов не записывается.</p></div></div>
				${events.length ? `<div class="card table-scroll"><table>
					<tr><th>время</th><th>действие</th><th>объект</th><th>статус</th><th>детали</th></tr>
					${events.map((event) => `<tr>
						<td>${esc(when(event.created_at))}</td>
						<td><code>${esc(event.action)}</code></td>
						<td>${esc(event.target_type)}<br><code>${esc(event.target_id || "—")}</code></td>
						<td>${esc(event.status)}</td>
						<td><details><summary>JSON</summary><pre>${esc(JSON.stringify(event.details || {}, null, 2))}</pre></details></td>
					</tr>`).join("")}
				</table></div>` : '<div class="empty">Событий пока нет.</div>'}`;
		} catch (error) {
			$("main").innerHTML = `<div class="error">${esc(error.message)}</div>`;
		}
	}

	/* ------------------------------------------------------------ agents */
	async function loadAgents() {
		try {
			const body = await api("/v1/sdk/agents");
			state.agents = body.agents ?? [];
			const types = [...new Set(state.agents.map((agent) => agent.agent_type).filter(Boolean))].sort();
			const currentType = $("type-filter").value;
			$("type-filter").innerHTML =
				'<option value="">Все типы</option>' +
				types.map((type) => `<option ${type === currentType ? "selected" : ""}>${esc(type)}</option>`).join("");
			const available = new Set(state.agents.map((agent) => agent.id));
			state.selectedAgents = new Set([...state.selectedAgents].filter((id) => available.has(id)));
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
				(!state.typeFilter || agent.agent_type === state.typeFilter) &&
				(!state.visibilityFilter ||
					(state.visibilityFilter === "hidden" ? agent.hidden : !agent.hidden)) &&
				(!needle ||
					(agent.name || "").toLowerCase().includes(needle) ||
					(agent.id || "").toLowerCase().includes(needle) ||
					(agent.model || "").toLowerCase().includes(needle) ||
					(agent.description || "").toLowerCase().includes(needle) ||
					(agent.project_id || "").toLowerCase().includes(needle) ||
					(agent.tags || []).some((tag) => String(tag).toLowerCase().includes(needle))),
		);
		$("agent-count").textContent = `агентов: ${state.agents.length}`;
		$("agent-list").innerHTML = agents.length
			? agents
					.map(
						(agent) => `
						<div class="agent-row">
							<input class="agent-select" type="checkbox" data-select-id="${esc(agent.id)}"
								${state.selectedAgents.has(agent.id) ? "checked" : ""} aria-label="Выбрать агента" />
							<button class="agent${state.selected === agent.id ? " active" : ""}"
							        data-id="${esc(agent.id)}">
								${esc(agent.name || "Без имени")}
								${agent.hidden ? '<span class="pill">hidden</span>' : ""}
								<small>${esc(agent.id)}</small>
								<small>${esc(agent.agent_type || "тип неизвестен")} · ${esc(agent.model || "модель по умолчанию")}</small>
							</button>
						</div>`,
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
		for (const input of $("agent-list").querySelectorAll("[data-select-id]")) {
			input.addEventListener("change", () => {
				if (input.checked) state.selectedAgents.add(input.dataset.selectId);
				else state.selectedAgents.delete(input.dataset.selectId);
				updateBulkControls();
			});
		}
		updateBulkControls();
	}

	function updateBulkControls() {
		const count = state.selectedAgents.size;
		$("bulk-edit").disabled = count === 0;
		$("bulk-edit").textContent = count ? `Изменить (${count})` : "Изменить";
		$("select-all").textContent =
			count === state.agents.length && state.agents.length ? "Снять выбор" : "Выбрать всё";
	}

	async function renderAgent() {
		const agentId = state.selected;
		if (!agentId) return;
		const agent = state.agents.find((item) => item.id === agentId) || {};
		$("crumb").textContent = `Агент · ${agent.name || agentId}`;
		const tabs = {
			overview: "Обзор",
			memory: "Память",
			tools: "Инструменты",
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
			else if (state.tab === "memory") await renderMemory(host, agentId);
			else if (state.tab === "tools") await renderTools(host, agentId);
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
					<label class="span-2">Model settings (JSON)<textarea name="model_settings" rows="5">${esc(JSON.stringify(agent.model_settings || {}, null, 2))}</textarea></label>
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
				<dt>обновлён</dt><dd>${esc(when(agent.updated_at))}</dd>
				<dt>тип</dt><dd>${esc(agent.agent_type || "—")}</dd>
				<dt>embedding</dt><dd>${esc(agent.embedding || "—")}</dd>
				<dt>template/entity</dt><dd>${esc(agent.template_id || "—")} / ${esc(agent.entity_id || "—")}</dd>
				<dt>project/deployment</dt><dd>${esc(agent.project_id || "—")} / ${esc(agent.deployment_id || "—")}</dd>
				<dt>последний запуск</dt><dd>${esc(when(agent.last_run_completion))}</dd>
				<dt>stop reason</dt><dd>${esc(agent.last_stop_reason || "—")}</dd>
				<dt>tools</dt><dd>${esc((agent.tools || []).map((tool) => tool.name).filter(Boolean).join(", ") || "—")}</dd>
			</dl><details><summary>Полное состояние (read-only)</summary><pre>${esc(JSON.stringify(agent, null, 2))}</pre></details></div>`;

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
				payload.model_settings = parseJsonField(form, "model_settings");
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

	async function renderMemory(host, agentId) {
		const { agent } = await api(`/v1/sdk/agents/${encodeURIComponent(agentId)}`);
		const blocks = Array.isArray(agent.blocks)
			? agent.blocks
			: Array.isArray(agent.memory?.blocks)
				? agent.memory.blocks
				: [];
		host.innerHTML = `
			<div class="notice"><strong>Память читается из состояния Letta.</strong>
				CRUD блоков существующего агента отсутствует в WebSocket management API текущего Agent SDK.
				Новые блоки можно точно задать при создании или импорте агента.</div>
			${blocks.length ? blocks.map((block) => `
				<div class="card memory-block">
					<div class="provider-title"><h3>${esc(block.label || "Без метки")}</h3>
						<div><code>${esc(block.id || "")}</code> ${block.read_only ? '<span class="pill">read-only</span>' : ""}</div></div>
					<p class="small muted">${esc(block.description || "Без описания")} · limit ${esc(block.limit || "—")}</p>
					<textarea rows="8" readonly>${esc(block.value || "")}</textarea>
					<details><summary>Метаданные</summary><pre>${esc(JSON.stringify(block, null, 2))}</pre></details>
				</div>`).join("") : '<div class="empty">App Server не вернул блоки памяти.</div>'}`;
	}

	async function renderTools(host, agentId) {
		const { agent } = await api(`/v1/sdk/agents/${encodeURIComponent(agentId)}`);
		const tools = Array.isArray(agent.tools) ? agent.tools : [];
		host.innerHTML = `
			<div class="notice">Список инструментов читается из Letta. Локальные инструменты Evaself,
				allowlist, permissions, skills и dreaming настраиваются в разделе «Настройки SDK».</div>
			${tools.length ? tools.map((tool) => `
				<div class="card"><div class="provider-title"><h3>${esc(tool.name || "Без имени")}</h3>
					<span class="pill">${esc(tool.tool_type || tool.source_type || "tool")}</span></div>
					<p>${esc(tool.description || "Без описания")}</p>
					<details><summary>JSON schema и состояние</summary><pre>${esc(JSON.stringify(tool, null, 2))}</pre></details>
				</div>`).join("") : '<div class="empty">Инструменты не прикреплены или не проецируются App Server.</div>'}`;
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
					<button class="btn danger" id="cancel-turn" disabled>Остановить</button>
					<button class="btn ghost" id="retry-turn" ${state.lastPrompt ? "" : "disabled"}>Повторить</button>
					<button class="btn ghost" id="new-chat" ${state.selectedConversation ? "" : "disabled"}>Очистить / новый диалог</button>
					<button class="btn ghost" id="session-status" ${state.selectedConversation ? "" : "disabled"}>Состояние сессии</button>
					<span class="small muted" id="chat-status"></span>
				</div>
				${state.selectedConversation ? "" : '<p class="error">Сначала создайте диалог на вкладке «Диалоги».</p>'}
			</div><div id="chat-out"></div>`;
		$("chat-conversation").addEventListener("change", async (event) => {
			state.selectedConversation = event.target.value;
			await loadMessages(state.selectedConversation);
		});
		if (state.selectedConversation) await loadMessages(state.selectedConversation);
		$("retry-turn").addEventListener("click", () => {
			$("chat-input").value = state.lastPrompt;
			$("send").click();
		});
		$("new-chat").addEventListener("click", async () => {
			if (!confirm("Создать новый диалог? Старая история и память сохранятся в предыдущем диалоге.")) return;
			try {
				const result = await api(`/v1/sdk/agents/${encodeURIComponent(agentId)}/conversations`, {
					method: "POST",
					body: JSON.stringify({ summary: "Новый диалог из WebUI" }),
				});
				state.selectedConversation = result.conversation.id;
				await renderChat(host, agentId);
			} catch (error) {
				$("chat-status").textContent = error.message;
			}
		});
		$("session-status").addEventListener("click", async () => {
			try {
				const body = await api(`/v1/sdk/conversations/${encodeURIComponent(state.selectedConversation)}/session`);
				$("chat-out").insertAdjacentHTML(
					"afterbegin",
					`<div class="card"><h3>Runtime session</h3><pre>${esc(JSON.stringify(body.session, null, 2))}</pre></div>`,
				);
			} catch (error) {
				$("chat-status").textContent = error.message;
			}
		});
		$("cancel-turn").addEventListener("click", async () => {
			const id = $("cancel-turn").dataset.conversation;
			if (!id) return;
			$("chat-status").textContent = "отмена запроса…";
			try {
				const result = await api(`/v1/sdk/conversations/${encodeURIComponent(id)}/abort`, { method: "POST" });
				$("chat-status").textContent = result.aborted ? "запрос остановлен" : "активный запрос уже завершён";
			} catch (error) {
				$("chat-status").textContent = error.message;
			}
		});
		$("send").addEventListener("click", async () => {
			const input = $("chat-input");
			const text = input.value.trim();
			if (!text) return;
			const conversationId = state.selectedConversation;
			state.lastPrompt = text;
			$("send").disabled = true;
			$("cancel-turn").disabled = false;
			$("cancel-turn").dataset.conversation = conversationId;
			$("chat-status").textContent = "ожидание ответа…";
			try {
				$("chat-out").insertAdjacentHTML("afterbegin", `<div class="msg user"><div class="role">Вы</div>${esc(text)}</div>`);
				const streamId = `stream-${Date.now()}`;
				$("chat-out").insertAdjacentHTML(
					"afterbegin",
					`<div class="msg" id="${streamId}"><div class="role">Агент · streaming</div><span></span></div>`,
				);
				let streamed = "";
				const result = await streamApi(
					`/v1/sdk/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
					{ text },
					(name, value) => {
						if (name !== "delta") return;
						streamed += String(value.text || "");
						const node = document.querySelector(`#${streamId} span`);
						if (node) node.textContent = streamed;
					},
				);
				const streamNode = $(streamId);
				if (streamNode) {
					streamNode.querySelector(".role").textContent = `Агент · ${result.durationMs} мс`;
					streamNode.querySelector("span").textContent = result.reply;
					streamNode.insertAdjacentHTML("afterend", turnTraceHtml(result));
				} else {
					$("chat-out").insertAdjacentHTML(
						"afterbegin",
						`<div class="msg"><div class="role">Агент · ${esc(result.durationMs)} мс</div>${esc(result.reply)}</div>
						 ${turnTraceHtml(result)}`,
					);
				}
				$("chat-status").textContent = "готово";
				input.value = "";
			} catch (error) {
				$("chat-status").textContent = error.message;
			} finally {
				$("send").disabled = false;
				$("cancel-turn").disabled = true;
				delete $("cancel-turn").dataset.conversation;
			}
		});
	}

	function turnTraceHtml(result) {
		const usage = result.usage ? JSON.stringify(result.usage, null, 2) : "нет данных";
		const usageObject = result.usage || {};
		const used = Number(
			usageObject.total_tokens ??
			usageObject.totalTokens ??
			(Number(usageObject.input_tokens || usageObject.prompt_tokens || 0) +
				Number(usageObject.output_tokens || usageObject.completion_tokens || 0)),
		);
		const selectedAgent = state.agents.find((agent) => agent.id === state.selected);
		const context = Number(
			selectedAgent?.context_window_limit ||
			state.system?.active_llm?.context_window ||
			0,
		);
		const percent = context > 0 && used > 0 ? Math.min(Math.round((used / context) * 100), 100) : 0;
		return `<details class="card trace">
			<summary>Trace · ${esc(result.messageCount)} событий · ${esc(result.stopReason || "без stop reason")}</summary>
			<dl class="kv">
				<dt>agent_id</dt><dd>${esc(result.agentId || "—")}</dd>
				<dt>conversation_id</dt><dd>${esc(result.conversationId || "—")}</dd>
				<dt>tools</dt><dd>${esc((result.toolCalls || []).join(", ") || "—")}</dd>
				<dt>reasoning</dt><dd>${esc((result.reasoning || []).join("\n") || "—")}</dd>
			</dl>
			${context > 0
				? `<div class="context-meter"><div style="width:${percent}%"></div></div>
				   <div class="small muted">Контекст: ${esc(used || "—")} / ${esc(context)} tokens (${esc(percent)}%)</div>`
				: ""}
			<h4>Usage</h4><pre>${esc(usage)}</pre>
			<h4>Raw SDK trace (секреты скрыты)</h4>
			<pre>${esc(JSON.stringify(result.trace || [], null, 2))}</pre>
		</details>`;
	}

	function renderNewAgent() {
		$("crumb").textContent = "Новый агент";
		$("main").innerHTML = `
			<form class="card" id="new-agent-form">
				<h3>Создать агента через Letta Agent SDK</h3>
				<div class="form-grid">
					<label>Имя<input name="name" required /></label>
					<label>Модель (пусто = активная LLM)<input name="model" /></label>
					<label>Embedding model<input name="embedding" /></label>
					<label>Context window<input name="context_window" type="number" min="1024" /></label>
					<label class="span-2">Описание<input name="description" /></label>
					<label>System prompt preset<select name="system_prompt_preset">
						<option value="">Собственный / из настроек SDK</option>
						<option>default</option><option>letta-claude</option><option>letta-codex</option>
						<option>letta-gemini</option><option>claude</option><option>codex</option><option>gemini</option>
					</select></label>
					<label>Personality preset<input name="personality" placeholder="например memo" /></label>
					<label class="span-2">System prompt / append к preset<textarea name="system_prompt" rows="6"></textarea></label>
					<label class="span-2">Persona<textarea name="persona" rows="6" placeholder="Пусто = шаблон из настроек SDK"></textarea></label>
					<label class="span-2">Human memory<textarea name="human" rows="4"></textarea></label>
					<label class="span-2">Дополнительные memory blocks (JSON-массив)
						<textarea name="memory_json" rows="8" placeholder='[{"label":"project","value":"Контекст","description":"Описание","read_only":false,"limit":8000}]'></textarea>
					</label>
					<label>Теги через запятую<input name="tags" value="evaself" /></label>
					<label>Permission mode<select name="permission_mode"><option>unrestricted</option><option>standard</option><option>acceptEdits</option><option>strict</option></select></label>
					<label class="span-2">Base tools, по одному в строке<textarea name="base_tools" rows="3"></textarea></label>
					<label>Allowed tools<textarea name="allowed_tools" rows="3"></textarea></label>
					<label>Disallowed tools<textarea name="disallowed_tools" rows="3"></textarea></label>
					<label>Skill sources<textarea name="skill_sources" rows="3">bundled
global
agent
project</textarea></label>
					<label>Dreaming (JSON)<textarea name="dreaming" rows="3">{"trigger":"off"}</textarea></label>
					<label class="span-2">Model settings (JSON)<textarea name="model_settings" rows="4">{}</textarea></label>
					<label class="check"><input name="memfs_enabled" type="checkbox" checked /> Memory filesystem</label>
					<label class="check"><input name="hidden" type="checkbox" /> Скрытый агент</label>
					<label class="check"><input name="system_info_reminder" type="checkbox" /> System info reminder</label>
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
				hidden: form.get("hidden") === "on",
				system_info_reminder: form.get("system_info_reminder") === "on",
				create_conversation: form.get("create_conversation") === "on",
				base_tools: readLines(form.get("base_tools")),
				allowed_tools: readLines(form.get("allowed_tools")),
				disallowed_tools: readLines(form.get("disallowed_tools")),
				skill_sources: readLines(form.get("skill_sources")),
			};
			for (const field of ["model", "embedding", "personality", "persona", "human"]) {
				if (String(form.get(field) || "").trim()) payload[field] = form.get(field);
			}
			const contextWindow = String(form.get("context_window") || "").trim();
			if (contextWindow) payload.context_window = Number(contextWindow);
			const prompt = String(form.get("system_prompt") || "");
			const preset = String(form.get("system_prompt_preset") || "");
			if (preset) {
				payload.system_prompt_preset = preset;
				if (prompt.trim()) payload.system_prompt_append = prompt;
			} else if (prompt.trim()) {
				payload.system_prompt = prompt;
			}
			$("new-agent-status").textContent = "создание…";
			try {
				payload.dreaming = parseJsonField(form, "dreaming");
				payload.model_settings = parseJsonField(form, "model_settings");
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
							${["standard", "acceptEdits", "unrestricted", "strict"].map((value) => `<option ${settings.permission_mode === value ? "selected" : ""}>${value}</option>`).join("")}
						</select></label>
						<label>Reasoning effort<select name="reasoning_effort">
							${["none", "minimal", "low", "medium", "high", "xhigh"].map((value) => `<option ${settings.reasoning_effort === value ? "selected" : ""}>${value}</option>`).join("")}
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
					reasoning_effort: form.get("reasoning_effort"),
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

	/* ----------------------------------------------------- bulk/export */
	$("select-all").addEventListener("click", () => {
		if (state.selectedAgents.size === state.agents.length) state.selectedAgents.clear();
		else state.selectedAgents = new Set(state.agents.map((agent) => agent.id));
		renderAgentList();
	});

	$("bulk-edit").addEventListener("click", renderBulkEditor);

	function renderBulkEditor() {
		const ids = [...state.selectedAgents];
		if (!ids.length) return;
		$("crumb").textContent = `Пакетное изменение · ${ids.length}`;
		$("main").innerHTML = `
			<form class="card" id="bulk-form">
				<h3>Изменить ${ids.length} агентов</h3>
				<p class="muted">Пустые поля не изменяются. При первой ошибке уже применённые изменения автоматически откатываются.</p>
				<div class="form-grid">
					<label>Модель<input name="model" /></label>
					<label>Context window<input name="context_window" type="number" min="1024" /></label>
					<label class="span-2">Теги через запятую<input name="tags" /></label>
					<label>Hidden<select name="hidden"><option value="">Не менять</option><option value="true">Да</option><option value="false">Нет</option></select></label>
					<label class="span-2">System prompt<textarea name="system" rows="8"></textarea></label>
					<label class="span-2">Model settings JSON (пусто = не менять)<textarea name="model_settings" rows="5"></textarea></label>
				</div>
				<details><summary>Выбранные agent_id</summary><pre>${esc(ids.join("\n"))}</pre></details>
				<div class="toolbar"><button class="btn" type="submit">Проверить и применить</button>
					<button class="btn ghost" type="button" id="cancel-bulk">Отмена</button>
					<span id="bulk-status" class="small muted"></span></div>
			</form>`;
		$("cancel-bulk").addEventListener("click", () => setSection("agents"));
		$("bulk-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = new FormData(event.currentTarget);
			const patch = {};
			for (const field of ["model", "system"]) {
				const value = String(form.get(field) || "");
				if (value.trim()) patch[field] = value;
			}
			const context = String(form.get("context_window") || "").trim();
			if (context) patch.context_window = Number(context);
			const tags = String(form.get("tags") || "").trim();
			if (tags) patch.tags = tags.split(",").map((item) => item.trim()).filter(Boolean);
			const hidden = String(form.get("hidden") || "");
			if (hidden) patch.hidden = hidden === "true";
			const settings = String(form.get("model_settings") || "").trim();
			try {
				if (settings) {
					patch.model_settings = JSON.parse(settings);
					if (!patch.model_settings || Array.isArray(patch.model_settings)) throw new Error("нужен JSON-объект");
				}
				if (!Object.keys(patch).length) throw new Error("Не выбрано ни одного изменения");
				const preview = ids.slice(0, 10).map((id) => {
					const before = state.agents.find((agent) => agent.id === id) || {};
					return { agent_id: id, before: Object.fromEntries(Object.keys(patch).map((key) => [key, before[key]])), after: patch };
				});
				if (!confirm(`Применить изменения к ${ids.length} агентам?\n\n${JSON.stringify(preview, null, 2)}`)) return;
				$("bulk-status").textContent = "применение…";
				const body = await api("/v1/sdk/agents/bulk", {
					method: "POST",
					body: JSON.stringify({ agent_ids: ids, patch }),
				});
				state.selectedAgents.clear();
				await loadAgents();
				setSection("agents");
				notice($("main"), `Обновлено агентов: ${body.count}.`);
			} catch (error) {
				$("bulk-status").textContent = error.message;
			}
		});
	}

	$("export-agents").addEventListener("click", async () => {
		const ids = [...state.selectedAgents];
		try {
			const query = ids.length ? `?ids=${encodeURIComponent(ids.join(","))}` : "";
			const body = await api(`/v1/sdk/agents/export${query}`);
			const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
			const link = document.createElement("a");
			link.href = URL.createObjectURL(blob);
			link.download = `evaself-agents-${new Date().toISOString().slice(0, 10)}.json`;
			link.click();
			URL.revokeObjectURL(link.href);
		} catch (error) {
			notice($("main"), error.message, "error");
		}
	});

	$("import-agents").addEventListener("click", () => $("import-file").click());
	$("import-file").addEventListener("change", async (event) => {
		const file = event.target.files?.[0];
		if (!file) return;
		try {
			const payload = JSON.parse(await file.text());
			if (payload.format !== "evaself-agent-export" || !Array.isArray(payload.agents)) {
				throw new Error("Файл не является экспортом Evaself");
			}
			if (!confirm(`Создать новых агентов из файла: ${payload.agents.length}? Существующие агенты не перезаписываются.`)) return;
			const body = await api("/v1/sdk/agents/import", {
				method: "POST",
				body: JSON.stringify({ agents: payload.agents }),
			});
			await loadAgents();
			setSection("agents");
			notice($("main"), `Импортировано агентов: ${body.count}.`);
		} catch (error) {
			notice($("main"), error.message, "error");
		} finally {
			event.target.value = "";
		}
	});

	/* ------------------------------------------------------------ theme */
	function applyTheme(theme) {
		document.documentElement.dataset.theme = theme;
		localStorage.setItem("evaself-theme", theme);
		$("theme-toggle").textContent = theme === "dark" ? "Светлая" : "Тёмная";
	}
	applyTheme(localStorage.getItem("evaself-theme") || "light");
	$("theme-toggle").addEventListener("click", () => {
		applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
	});

	/* ------------------------------------------------------------ boot */
	$("filter").addEventListener("input", (event) => {
		state.filter = event.target.value;
		renderAgentList();
	});
	$("type-filter").addEventListener("change", (event) => {
		state.typeFilter = event.target.value;
		renderAgentList();
	});
	$("visibility-filter").addEventListener("change", (event) => {
		state.visibilityFilter = event.target.value;
		renderAgentList();
	});
	$("refresh").addEventListener("click", async () => {
		await refreshHealth();
		if (state.section === "dashboard") await renderDashboard();
		else if (state.section === "audit") await renderAudit();
		else if (state.section === "llm") await renderLlm();
		else if (state.section === "sdk") await renderSdk();
		else {
			await loadAgents();
			if (state.selected) renderAgent();
		}
	});

	refreshHealth();
	loadAgents();
	setSection("dashboard");
	setInterval(refreshHealth, 30000);
})();
