/* Evaself Letta console.
 *
 * Talks to the Letta REST API through this container's own /api prefix.
 * Caddy adds `Authorization: Bearer $LETTA_SERVER_PASSWORD` on the way to
 * letta:8283, so the password never reaches the browser and the Letta API
 * is never published to the internet.
 *
 * Routes used (verified against Letta 0.16.8):
 *   GET    /v1/health/
 *   GET    /v1/agents/
 *   GET    /v1/agents/{id}
 *   GET    /v1/agents/{id}/core-memory/blocks
 *   PATCH  /v1/agents/{id}/core-memory/blocks/{label}
 *   GET    /v1/agents/{id}/messages
 *   POST   /v1/agents/{id}/messages
 *   GET    /v1/agents/{id}/archival-memory
 *   GET    /v1/agents/{id}/tools
 *   GET    /v1/agents/{id}/export
 */
(() => {
	"use strict";

	const state = {
		agents: [],
		filter: "",
		selected: null,
		tab: "overview",
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
		} catch (error) {
			body = text;
		}
		if (!response.ok) {
			const detail =
				body && typeof body === "object" && body.detail ? body.detail : response.statusText;
			throw new Error(`${response.status} ${detail}`);
		}
		return body;
	}

	function esc(value) {
		return String(value == null ? "" : value).replace(
			/[&<>"']/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
		);
	}

	function when(value) {
		if (!value) return "—";
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
	}

	function showError(message) {
		$("main").insertAdjacentHTML("afterbegin", `<div class="error">${esc(message)}</div>`);
	}

	/* ------------------------------------------------------------ health */
	async function refreshHealth() {
		try {
			const health = await api("/v1/health/");
			$("health-dot").className = "dot ok";
			$("health-text").textContent = "server up";
			$("server-version").textContent = health && health.version ? `v${health.version}` : "letta";
		} catch (error) {
			$("health-dot").className = "dot bad";
			$("health-text").textContent = "unreachable";
			$("server-version").textContent = "offline";
		}
	}

	/* ------------------------------------------------------------ agents */
	async function loadAgents() {
		try {
			state.agents = (await api("/v1/agents/?limit=200")) || [];
		} catch (error) {
			state.agents = [];
			showError(`Could not list agents: ${error.message}`);
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
				(agent.tags || []).some((tag) => tag.toLowerCase().includes(needle)),
		);

		$("agent-count").textContent = `${state.agents.length} agents`;

		$("agent-list").innerHTML = agents.length
			? agents
					.map(
						(agent) => `
						<button class="agent${state.selected === agent.id ? " active" : ""}" data-id="${esc(agent.id)}">
							${esc(agent.name || "(unnamed)")}
							<small>${esc(agent.id)}</small>
						</button>`,
					)
					.join("")
			: '<div class="empty small">No agents match.</div>';

		for (const button of $("agent-list").querySelectorAll(".agent")) {
			button.addEventListener("click", () => selectAgent(button.dataset.id));
		}
	}

	function selectAgent(id) {
		state.selected = id;
		state.tab = "overview";
		renderAgentList();
		renderAgent();
	}

	/* ------------------------------------------------------------ detail */
	async function renderAgent() {
		const id = state.selected;
		if (!id) return;

		const agent = state.agents.find((a) => a.id === id) || {};
		$("crumb").textContent = agent.name || id;

		$("main").innerHTML = `
			<div class="tabs">
				${["overview", "memory", "messages", "chat", "archival", "tools"]
					.map(
						(tab) =>
							`<button class="tab${state.tab === tab ? " active" : ""}" data-tab="${tab}">${tab}</button>`,
					)
					.join("")}
			</div>
			<div id="tab-body"><div class="empty small">Loading…</div></div>`;

		for (const button of $("main").querySelectorAll(".tab")) {
			button.addEventListener("click", () => {
				state.tab = button.dataset.tab;
				renderAgent();
			});
		}

		const body = $("tab-body");
		try {
			if (state.tab === "overview") await renderOverview(body, id);
			else if (state.tab === "memory") await renderMemory(body, id);
			else if (state.tab === "messages") await renderMessages(body, id);
			else if (state.tab === "chat") renderChat(body, id);
			else if (state.tab === "archival") await renderArchival(body, id);
			else if (state.tab === "tools") await renderTools(body, id);
		} catch (error) {
			body.innerHTML = `<div class="error">${esc(error.message)}</div>`;
		}
	}

	async function renderOverview(host, id) {
		const agent = await api(`/v1/agents/${encodeURIComponent(id)}`);
		host.innerHTML = `
			<div class="grid">
				<div class="card">
					<h3>Agent</h3>
					<dl class="kv">
						<dt>id</dt><dd>${esc(agent.id)}</dd>
						<dt>name</dt><dd>${esc(agent.name)}</dd>
						<dt>type</dt><dd>${esc(agent.agent_type)}</dd>
						<dt>created</dt><dd>${esc(when(agent.created_at))}</dd>
						<dt>updated</dt><dd>${esc(when(agent.updated_at))}</dd>
					</dl>
				</div>
				<div class="card">
					<h3>Model</h3>
					<dl class="kv">
						<dt>model</dt><dd>${esc(agent.model || (agent.llm_config && agent.llm_config.model) || "—")}</dd>
						<dt>embedding</dt><dd>${esc(agent.embedding || (agent.embedding_config && agent.embedding_config.embedding_model) || "—")}</dd>
						<dt>context</dt><dd>${esc(
							agent.context_window_limit || (agent.llm_config && agent.llm_config.context_window) || "—",
						)}</dd>
					</dl>
				</div>
				<div class="card">
					<h3>Tags</h3>
					<p>${(agent.tags || []).map((tag) => `<span class="pill">${esc(tag)}</span>`).join(" ") || '<span class="muted">none</span>'}</p>
					<h3 style="margin-top:14px">Description</h3>
					<p class="small muted">${esc(agent.description || "—")}</p>
				</div>
			</div>
			<div class="card">
				<h3>Export</h3>
				<p class="small muted">Downloads the agent (memory, messages, tools) as the JSON accepted by <code>POST /v1/agents/import</code>. <code>make backup</code> stores the same export for every agent.</p>
				<div class="toolbar"><button class="btn" id="export">Download export</button></div>
			</div>`;

		$("export").addEventListener("click", async (event) => {
			const button = event.currentTarget;
			button.disabled = true;
			button.textContent = "Exporting…";
			try {
				const data = await api(`/v1/agents/${encodeURIComponent(id)}/export`);
				const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
				const url = URL.createObjectURL(blob);
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = `${agent.name || id}.af.json`;
				anchor.click();
				URL.revokeObjectURL(url);
			} catch (error) {
				showError(error.message);
			} finally {
				button.disabled = false;
				button.textContent = "Download export";
			}
		});
	}

	async function renderMemory(host, id) {
		const blocks = (await api(`/v1/agents/${encodeURIComponent(id)}/core-memory/blocks`)) || [];
		host.innerHTML = blocks.length
			? blocks
					.map(
						(block) => `
						<div class="card">
							<h3>${esc(block.label)} <span class="muted small">limit ${esc(block.limit || "—")}</span></h3>
							<textarea class="block" data-label="${esc(block.label)}">${esc(block.value || "")}</textarea>
							<div class="toolbar">
								<button class="btn save" data-label="${esc(block.label)}">Save block</button>
								<span class="small muted saved" data-label="${esc(block.label)}"></span>
							</div>
						</div>`,
					)
					.join("")
			: '<div class="empty">This agent has no core memory blocks.</div>';

		for (const button of host.querySelectorAll(".save")) {
			button.addEventListener("click", async () => {
				const label = button.dataset.label;
				const value = host.querySelector(`textarea[data-label="${CSS.escape(label)}"]`).value;
				const note = host.querySelector(`.saved[data-label="${CSS.escape(label)}"]`);
				button.disabled = true;
				try {
					await api(
						`/v1/agents/${encodeURIComponent(id)}/core-memory/blocks/${encodeURIComponent(label)}`,
						{ method: "PATCH", body: JSON.stringify({ value }) },
					);
					note.textContent = "saved";
				} catch (error) {
					note.textContent = error.message;
				} finally {
					button.disabled = false;
				}
			});
		}
	}

	function messageHtml(message) {
		const kind = message.message_type || message.role || "message";
		const content = (() => {
			const raw = message.content ?? message.reasoning ?? message.tool_return ?? "";
			if (typeof raw === "string") return raw;
			if (Array.isArray(raw))
				return raw.map((part) => (typeof part === "string" ? part : part.text || "")).join("\n");
			if (message.tool_call) return `${message.tool_call.name}(${message.tool_call.arguments || ""})`;
			return JSON.stringify(raw);
		})();

		const cls = kind.includes("user")
			? "user"
			: kind.includes("reasoning")
				? "reasoning"
				: kind.includes("tool")
					? "tool"
					: "";

		return `<div class="msg ${cls}"><div class="role">${esc(kind)} · ${esc(when(message.date || message.created_at))}</div>${esc(content)}</div>`;
	}

	async function renderMessages(host, id) {
		const response = await api(`/v1/agents/${encodeURIComponent(id)}/messages?limit=60`);
		const messages = Array.isArray(response) ? response : response && response.messages;
		host.innerHTML = (messages || []).length
			? (messages || []).map(messageHtml).join("")
			: '<div class="empty">No messages yet.</div>';
	}

	function renderChat(host, id) {
		host.innerHTML = `
			<div class="card">
				<h3>Send a message to this agent</h3>
				<p class="small muted">Goes through the same <code>POST /v1/agents/{id}/messages</code> endpoint Eva Core uses. Useful for testing a user's agent without Telegram.</p>
				<textarea id="chat-input" rows="3" placeholder="Type a message…"></textarea>
				<div class="toolbar">
					<button class="btn" id="send">Send</button>
					<span class="small muted" id="chat-status"></span>
				</div>
			</div>
			<div id="chat-out"></div>`;

		$("send").addEventListener("click", async () => {
			const input = $("chat-input");
			const text = input.value.trim();
			if (!text) return;

			$("send").disabled = true;
			$("chat-status").textContent = "waiting for the agent…";
			$("chat-out").insertAdjacentHTML(
				"afterbegin",
				`<div class="msg user"><div class="role">you</div>${esc(text)}</div>`,
			);

			try {
				const response = await api(`/v1/agents/${encodeURIComponent(id)}/messages`, {
					method: "POST",
					body: JSON.stringify({
						messages: [{ role: "user", content: text }],
						max_steps: 20,
						streaming: false,
					}),
				});
				const rendered = (response.messages || []).map(messageHtml).join("");
				$("chat-out").insertAdjacentHTML("afterbegin", rendered);
				const usage = response.usage || {};
				$("chat-status").textContent = `done · ${usage.total_tokens ?? "?"} tokens · ${usage.step_count ?? "?"} steps`;
				input.value = "";
			} catch (error) {
				$("chat-status").textContent = error.message;
			} finally {
				$("send").disabled = false;
			}
		});
	}

	async function renderArchival(host, id) {
		const passages = (await api(`/v1/agents/${encodeURIComponent(id)}/archival-memory?limit=50`)) || [];
		host.innerHTML = passages.length
			? `<div class="card"><table>
					<tr><th style="width:170px">created</th><th>text</th></tr>
					${passages
						.map(
							(passage) =>
								`<tr><td class="muted small">${esc(when(passage.created_at))}</td><td>${esc(passage.text || "")}</td></tr>`,
						)
						.join("")}
				</table></div>`
			: '<div class="empty">Archival memory is empty.</div>';
	}

	async function renderTools(host, id) {
		const tools = (await api(`/v1/agents/${encodeURIComponent(id)}/tools`)) || [];
		host.innerHTML = tools.length
			? `<div class="card"><table>
					<tr><th style="width:220px">name</th><th>description</th></tr>
					${tools
						.map(
							(tool) =>
								`<tr><td><code>${esc(tool.name)}</code></td><td class="small muted">${esc(tool.description || "")}</td></tr>`,
						)
						.join("")}
				</table></div>`
			: '<div class="empty">No tools attached.</div>';
	}

	/* ------------------------------------------------------------ boot */
	$("filter").addEventListener("input", (event) => {
		state.filter = event.target.value;
		renderAgentList();
	});

	$("refresh").addEventListener("click", async () => {
		await refreshHealth();
		await loadAgents();
		if (state.selected) renderAgent();
	});

	refreshHealth();
	loadAgents();
	setInterval(refreshHealth, 30000);
})();
