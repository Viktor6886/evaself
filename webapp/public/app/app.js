/* Eva Mini App.
 *
 * Every request carries the launch payload Telegram signed with the bot
 * token in `X-Telegram-Init-Data`; Eva Core verifies the HMAC and derives
 * the user from it. Nothing here trusts a user id sent by the client.
 *
 * The API lives on the same origin under /api (Caddy strips the prefix and
 * forwards to eva-core), so no domain is ever hard-coded in these assets.
 */
(() => {
	"use strict";

	const tg = window.Telegram && window.Telegram.WebApp;
	const METRIC_LABELS = {
		messages: "Сообщения",
		voice_minutes: "Голос, минут",
		web_search: "Поиск в интернете",
		tests: "Тесты",
	};

	if (tg) {
		tg.ready();
		tg.expand();
	}

	function showError(message) {
		const box = document.getElementById("error");
		box.textContent = message;
		box.hidden = false;
	}

	async function api(path, options = {}) {
		const initData = tg && tg.initData;
		if (!initData) {
			throw new Error(
				"Откройте это приложение из Telegram — за его пределами данные недоступны.",
			);
		}

		const response = await fetch(`/api${path}`, {
			...options,
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Init-Data": initData,
				...(options.headers || {}),
			},
		});

		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			const detail = body && body.error ? body.error.message : response.statusText;
			throw new Error(detail || "Не удалось получить данные");
		}
		return body;
	}

	function renderQuotas(quotas) {
		const host = document.getElementById("quotas");
		if (!quotas || quotas.length === 0) {
			host.innerHTML = '<div class="card small muted">Лимиты не настроены.</div>';
			return;
		}

		host.innerHTML = quotas
			.map((quota) => {
				const label = METRIC_LABELS[quota.metric] || quota.metric;
				const unlimited = quota.limit_value < 0;
				const used = Number(quota.used || 0);
				const limit = Number(quota.limit_value || 0);
				const percent = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
				const value = unlimited ? `${used} / без ограничений` : `${used} / ${limit}`;
				const full = !unlimited && used >= limit ? " is-full" : "";

				return `
					<div class="card">
						<div class="row">
							<strong>${escapeHtml(label)}</strong>
							<span class="small muted">${escapeHtml(value)}</span>
						</div>
						${unlimited ? "" : `<div class="meter${full}"><span style="width:${percent}%"></span></div>`}
					</div>`;
			})
			.join("");
	}

	function renderTasks(tasks) {
		const host = document.getElementById("tasks");
		if (!tasks || tasks.length === 0) {
			host.className = "card small muted";
			host.textContent = "Пока задач нет. Попросите Еву предложить небольшой шаг.";
			return;
		}

		host.className = "card";
		host.innerHTML = `<ul class="plain">${tasks
			.map((task) => {
				const done = task.status === "done";
				const due = task.due_at
					? new Date(task.due_at).toLocaleDateString("ru-RU", {
							day: "numeric",
							month: "short",
						})
					: "";
				return `
					<li class="row">
						<span style="${done ? "text-decoration: line-through; opacity: .55" : ""}">
							${escapeHtml(task.title)}
						</span>
						<span class="small muted">${escapeHtml(due)}</span>
					</li>`;
			})
			.join("")}</ul>`;
	}

	function escapeHtml(value) {
		return String(value == null ? "" : value).replace(
			/[&<>"']/g,
			(character) =>
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;",
				})[character],
		);
	}

	async function main() {
		try {
			const session = await api("/public/session", { method: "POST" });
			const name = (session.user && session.user.first_name) || "";
			document.getElementById("greeting").textContent = name
				? `Привет, ${name}`
				: "Привет";
			document.getElementById("plan").textContent = session.plan || "free";
			renderQuotas(session.quotas);
		} catch (error) {
			showError(error.message);
			document.getElementById("greeting").textContent = "Ева";
			document.getElementById("plan").textContent = "—";
			document.getElementById("quotas").innerHTML = "";
			document.getElementById("tasks").textContent = "";
			return;
		}

		try {
			const { tasks } = await api("/public/tasks");
			renderTasks(tasks);
		} catch (error) {
			renderTasks([]);
		}
	}

	main();
})();
