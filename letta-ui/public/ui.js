/* Evaself Letta console.
 *
 * Reads through eva-agent-service (this container's own /api prefix; Caddy
 * adds the internal API key). eva-agent-service owns
 * @letta-ai/letta-agent-sdk and is the only thing that speaks to the Letta
 * App Server — the App Server's WebSocket protocol cannot be driven from a
 * browser, and it is never routed from the internet.
 *
 * Endpoints used:
 *   GET  /health                                   service + App Server state
 *   GET  /v1/agents                                user -> agent -> conversation
 *   GET  /v1/agents/live                           agents as the App Server sees them
 *   GET  /v1/conversations/{telegramId}            conversations of one user
 *   POST /v1/conversations/{telegramId}            start a fresh conversation
 *   GET  /v1/conversations/{telegramId}/messages   history
 *   POST /v1/messages                              run a turn
 *   POST /v1/locks/{telegramId}/release            clear a stuck turn lock
 *   GET  /v1/models                                models the App Server offers
 */
(() => {
	"use strict";

	const state = { agents: [], filter: "", selected: null, tab: "overview" };
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
					? `${body.error.code}: ${body.error.message}`
					: response.statusText;
			throw new Error(`${response.status} ${detail}`);
		}
		return body;
	}

	const esc = (value) =>
		String(value == null ? "" : value).replace(
			/[&<>"']/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
		);

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
			const health = await api("/health");
			const appServer = health.checks?.app_server ?? {};
			const ok = health.status === "ok";
			$("health-dot").className = `dot ${ok ? "ok" : "bad"}`;
			$("health-text").textContent = appServer.ok
				? `app server up · ${appServer.models ?? "?"} models`
				: `app server: ${appServer.error ?? "unreachable"}`;
			$("server-version").textContent = `sdk v${health.version ?? "?"}`;
		} catch (error) {
			$("health-dot").className = "dot bad";
			$("health-text").textContent = "agent service unreachable";
			$("server-version").textContent = "offline";
		}
	}

	/* ------------------------------------------------------------ agents */
	async function loadAgents() {
		try {
			const body = await api("/v1/agents");
			state.agents = body.agents ?? [];
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
				String(agent.telegram_id).includes(needle) ||
				(agent.agent_id || "").toLowerCase().includes(needle) ||
				(agent.conversation_id || "").toLowerCase().includes(needle),
		);

		$("agent-count").textContent = `${state.agents.length} agents`;

		$("agent-list").innerHTML = agents.length
			? agents
					.map(
						(agent) => `
						<button class="agent${state.selected === String(agent.telegram_id) ? " active" : ""}"
						        data-id="${esc(agent.telegram_id)}">
							tg:${esc(agent.telegram_id)}
							<small>${esc(agent.agent_id)}</small>
							<small>${esc(agent.conversation_id || "no conversation")}</small>
						</button>`,
					)
					.join("")
			: '<div class="empty small">No agents match.</div>';

		for (const button of $("agent-list").querySelectorAll(".agent")) {
			button.addEventListener("click", () => {
				state.selected = button.dataset.id;
				state.tab = "overview";
				renderAgentList();
				renderAgent();
			});
		}
	}

	/* ------------------------------------------------------------ detail */
	async function renderAgent() {
		const telegramId = state.selected;
		if (!telegramId) return;

		const agent = state.agents.find((a) => String(a.telegram_id) === telegramId) || {};
		$("crumb").textContent = `tg:${telegramId}`;

		$("main").innerHTML = `
			<div class="tabs">
				${["overview", "conversations", "messages", "chat"]
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
			if (state.tab === "overview") renderOverview(body, telegramId, agent);
			else if (state.tab === "conversations") await renderConversations(body, telegramId);
			else if (state.tab === "messages") await renderMessages(body, telegramId);
			else if (state.tab === "chat") renderChat(body, telegramId);
		} catch (error) {
			body.innerHTML = `<div class="error">${esc(error.message)}</div>`;
		}
	}

	function renderOverview(host, telegramId, agent) {
		host.innerHTML = `
			<div class="grid">
				<div class="card">
					<h3>Mapping</h3>
					<dl class="kv">
						<dt>telegram_id</dt><dd>${esc(agent.telegram_id)}</dd>
						<dt>agent_id</dt><dd>${esc(agent.agent_id)}</dd>
						<dt>conversation_id</dt><dd>${esc(agent.conversation_id || "—")}</dd>
						<dt>runtime</dt><dd>${esc(agent.runtime)}</dd>
					</dl>
					<p class="small muted" style="margin-top:10px">
						This mapping lives in PostgreSQL (<code>agent_links</code>) and is
						what a restart or a restore resumes from.
					</p>
				</div>
				<div class="card">
					<h3>Activity</h3>
					<dl class="kv">
						<dt>messages</dt><dd>${esc(agent.message_count ?? 0)}</dd>
						<dt>last message</dt><dd>${esc(when(agent.last_message_at))}</dd>
						<dt>status</dt><dd>${esc(agent.status)}</dd>
					</dl>
				</div>
			</div>
			<div class="card">
				<h3>Operations</h3>
				<div class="toolbar">
					<button class="btn ghost" id="new-conv">Start a new conversation</button>
					<button class="btn ghost" id="release-lock">Release turn lock</button>
					<span class="small muted" id="op-status"></span>
				</div>
				<p class="small muted" style="margin-top:10px">
					A new conversation keeps the agent and its memory; only the thread
					restarts. Releasing the lock is for a turn that died mid-flight.
				</p>
			</div>`;

		$("new-conv").addEventListener("click", async () => {
			$("op-status").textContent = "creating…";
			try {
				const result = await api(`/v1/conversations/${encodeURIComponent(telegramId)}`, {
					method: "POST",
				});
				$("op-status").textContent = `now on ${result.conversation_id}`;
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
				$("op-status").textContent = result.released ? "lock released" : "no lock was held";
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
					<tr><th style="width:220px">conversation</th><th>created</th><th>last message</th><th></th></tr>
					${conversations
						.map(
							(conversation) => `
							<tr>
								<td><code>${esc(conversation.id)}</code></td>
								<td class="muted small">${esc(when(conversation.created_at))}</td>
								<td class="muted small">${esc(when(conversation.last_message_at))}</td>
								<td>${conversation.id === body.active_conversation_id ? '<span class="pill">active</span>' : ""}</td>
							</tr>`,
						)
						.join("")}
				</table></div>`
			: '<div class="empty">No conversations yet.</div>';
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
		const messages = Array.isArray(body) ? body : (body.messages ?? []);
		host.innerHTML = messages.length
			? messages.map(messageHtml).join("")
			: '<div class="empty">No messages yet.</div>';
	}

	function renderChat(host, telegramId) {
		host.innerHTML = `
			<div class="card">
				<h3>Send a message as this user</h3>
				<p class="small muted">
					Runs a real turn through the Agent SDK — the same path Telegram
					uses. Useful for testing without a Telegram client.
				</p>
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
				const result = await api("/v1/messages", {
					method: "POST",
					body: JSON.stringify({ telegram_id: Number(telegramId), text, count_usage: false }),
				});
				$("chat-out").insertAdjacentHTML(
					"afterbegin",
					`<div class="msg"><div class="role">eva · ${esc(result.durationMs)} ms</div>${esc(result.reply)}</div>`,
				);
				const usage = result.usage || {};
				$("chat-status").textContent = `done · stop:${result.stopReason ?? "?"} · ${
					usage.total_tokens ?? "?"
				} tokens`;
				input.value = "";
			} catch (error) {
				$("chat-status").textContent = error.message;
			} finally {
				$("send").disabled = false;
			}
		});
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
