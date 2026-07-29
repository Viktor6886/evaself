/* Eva Mini App: identity always comes from Telegram-signed initData. */
(() => {
	"use strict";

	const tg = window.Telegram && window.Telegram.WebApp;
	const state = {
		screen: "today",
		loaded: new Set(),
		session: null,
		today: null,
		goals: [],
		profile: null,
		progress: null,
		profileTimer: null,
	};
	const titles = {
		today: "Сегодня",
		goals: "Цели",
		progress: "Прогресс",
		profile: "Профиль",
	};

	if (tg) {
		tg.ready();
		tg.expand();
		tg.enableClosingConfirmation?.();
	}

	document.querySelectorAll(".nav-item").forEach((button) => {
		button.addEventListener("click", () => void openScreen(button.dataset.target));
	});
	document.getElementById("add-goal").addEventListener("click", showGoalForm);
	document.getElementById("close-goal-form").addEventListener("click", hideGoalForm);
	document.getElementById("goal-form").addEventListener("submit", createGoal);

	async function api(path, options = {}) {
		const initData = tg && tg.initData;
		if (!initData) {
			throw new Error("Откройте приложение из Telegram, чтобы увидеть свои данные.");
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
			throw new Error(body?.error?.message || "Не удалось выполнить действие");
		}
		return body;
	}

	async function bootstrap() {
		try {
			state.session = await api("/public/session", { method: "POST" });
			const firstName = state.session.user?.first_name;
			document.getElementById("header-kicker").textContent = firstName
				? `Ева рядом, ${firstName}`
				: "Ева рядом";
			await loadToday();
		} catch (error) {
			showNotice(error.message, true, false);
			renderUnavailable("today");
		}
	}

	async function openScreen(screen) {
		if (!titles[screen] || screen === state.screen) return;
		state.screen = screen;
		document.querySelectorAll(".screen").forEach((node) => {
			const active = node.dataset.screen === screen;
			node.hidden = !active;
			node.classList.toggle("is-active", active);
		});
		document.querySelectorAll(".nav-item").forEach((node) => {
			node.classList.toggle("is-active", node.dataset.target === screen);
		});
		document.getElementById("screen-title").textContent = titles[screen];
		document.getElementById("local-time").hidden = screen !== "today";
		window.scrollTo({ top: 0, behavior: "smooth" });
		if (!state.loaded.has(screen)) {
			const loaders = {
				goals: loadGoals,
				progress: loadProgress,
				profile: loadProfile,
			};
			try {
				await loaders[screen]?.();
			} catch (error) {
				showNotice(error.message, true);
				renderUnavailable(screen);
			}
		}
	}

	async function loadToday() {
		const { today } = await api("/public/today");
		state.today = today;
		state.loaded.add("today");
		document.getElementById("local-time").textContent = today.local_time || "—";
		renderToday(today);
	}

	function renderToday(today) {
		const host = document.getElementById("today-content");
		const hasAction = Boolean(today.main_action);
		const status = today.work_block_id
			? "Ваш ближайший шаг"
			: today.goal_id
				? "Фокус по активной цели"
				: "Спокойный день";
		const button = today.work_block_id
			? `<button class="primary-action" id="today-action" type="button">
					${today.work_block_status === "active" ? "Готово" : "Начать"}
				</button>`
			: "";
		host.innerHTML = `
			<article class="hero-card">
				<p class="app-kicker">${escapeHtml(status)}</p>
				<h2>${escapeHtml(today.main_action || "Выберите то, что сейчас действительно важно")}</h2>
				${today.goal_title ? `<p class="card-caption">${escapeHtml(today.goal_title)}</p>` : ""}
				<div class="hero-meta">
					${today.expected_result ? metaLine("→", "Ожидаемый результат", today.expected_result) : ""}
					${today.first_step ? metaLine("1", "Первый шаг", today.first_step) : ""}
				</div>
				${button}
			</article>
			${today.continuation ? `
				<div class="continuation">
					<strong>Точка продолжения</strong><br />
					${escapeHtml(today.continuation)}
				</div>` : ""}
			<section>
				<div class="section-heading">
					<div><p class="app-kicker">Рядом с главным</p><h2>Ещё на сегодня</h2></div>
				</div>
				${renderTasks(today.tasks || [])}
			</section>`;
		const action = document.getElementById("today-action");
		action?.addEventListener("click", () => void changeWorkBlock(action));
		if (!hasAction && !today.tasks?.length) {
			host.querySelector(".hero-card")?.classList.add("is-empty");
		}
	}

	function metaLine(symbol, label, value) {
		return `<div class="meta-line">
			<span class="meta-symbol">${escapeHtml(symbol)}</span>
			<span><span class="card-caption">${escapeHtml(label)}</span><br />${escapeHtml(value)}</span>
		</div>`;
	}

	function renderTasks(tasks) {
		if (!tasks.length) {
			return `<div class="empty-state">
				<strong>Дополнительных задач нет</strong>
				<span class="empty-copy">Можно сосредоточиться на главном шаге.</span>
			</div>`;
		}
		return `<div class="content-card">${tasks
			.slice(0, 3)
			.map(
				(task, index) => `<div class="task-row">
					<span class="task-index">${index + 1}</span>
					<span class="task-title">${escapeHtml(task.title)}</span>
					<span class="task-date">${formatDate(task.due_at)}</span>
				</div>`,
			)
			.join("")}</div>`;
	}

	async function changeWorkBlock(button) {
		if (!state.today?.work_block_id) return;
		const isActive = state.today.work_block_status === "active";
		const operation = isActive ? "complete" : "start";
		const previous = button.textContent;
		button.disabled = true;
		button.textContent = isActive ? "Сохраняю…" : "Начинаем…";
		try {
			await api(`/public/work-blocks/${state.today.work_block_id}/${operation}`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			if (!isActive) {
				state.today.work_block_status = "active";
				button.textContent = "Готово";
				button.disabled = false;
				showNotice("Шаг начат. Ева сохранит точку продолжения.");
			} else {
				showNotice("Готово — прогресс сохранён.");
				state.loaded.delete("progress");
				await loadToday();
			}
			tg?.HapticFeedback?.notificationOccurred("success");
		} catch (error) {
			button.disabled = false;
			button.textContent = previous;
			showNotice(error.message, true);
		}
	}

	async function loadGoals() {
		const { goals } = await api("/public/goals");
		state.goals = goals || [];
		state.loaded.add("goals");
		renderGoals();
	}

	function renderGoals() {
		const host = document.getElementById("goals-content");
		if (!state.goals.length) {
			host.innerHTML = `<div class="empty-state">
				<strong>Целей пока нет</strong>
				<span class="empty-copy">Добавьте одну цель, которую хочется приблизить.</span>
			</div>`;
			return;
		}
		host.innerHTML = state.goals.map((goal) => {
			const progress = Math.max(0, Math.min(100, Number(goal.progress_percent || 0)));
			return `<article class="goal-card" data-goal-id="${escapeHtml(goal.id)}">
				<div class="goal-topline">
					<div>
						<h3>${escapeHtml(goal.title)}</h3>
						<p class="card-caption">${goal.target_date ? `до ${formatDate(goal.target_date)}` : "без жёсткого срока"}</p>
					</div>
					<span class="status-chip">${goalStatus(goal.status)}</span>
				</div>
				<div>
					<div class="goal-topline card-caption"><span>Прогресс</span><span>${progress}%</span></div>
					<div class="progress-track"><span style="width:${progress}%"></span></div>
				</div>
				${goal.next_result ? `<div>
					<p class="app-kicker">Ближайший результат</p>
					<strong>${escapeHtml(goal.next_result)}</strong>
					${goal.next_step ? `<p class="card-caption">Следом: ${escapeHtml(goal.next_step)}</p>` : ""}
				</div>` : ""}
				<details class="goal-details">
					<summary>Подробнее</summary>
					${goal.why_it_matters ? `<p>${escapeHtml(goal.why_it_matters)}</p>` : "<p>Смысл цели пока не уточнён.</p>"}
					${goal.status === "active" ? `<button type="button" class="secondary-action pause-goal" data-id="${escapeHtml(goal.id)}">Поставить на паузу</button>` : ""}
				</details>
			</article>`;
		}).join("");
		host.querySelectorAll(".pause-goal").forEach((button) => {
			button.addEventListener("click", () => void pauseGoal(button));
		});
	}

	function showGoalForm() {
		document.getElementById("goal-form").hidden = false;
		document.getElementById("goals-content").hidden = true;
		document.getElementById("add-goal").hidden = true;
		document.querySelector('#goal-form input[name="title"]')?.focus();
	}

	function hideGoalForm() {
		document.getElementById("goal-form").hidden = true;
		document.getElementById("goals-content").hidden = false;
		document.getElementById("add-goal").hidden = false;
	}

	async function createGoal(event) {
		event.preventDefault();
		const form = event.currentTarget;
		const submit = form.querySelector('button[type="submit"]');
		const payload = Object.fromEntries(new FormData(form).entries());
		submit.disabled = true;
		try {
			const { goal } = await api("/public/goals", {
				method: "POST",
				body: JSON.stringify(payload),
			});
			state.goals.unshift({ ...goal, progress_percent: 0 });
			state.loaded.delete("today");
			renderGoals();
			form.reset();
			hideGoalForm();
			showNotice("Цель добавлена.");
			tg?.HapticFeedback?.notificationOccurred("success");
		} catch (error) {
			showNotice(error.message, true);
		} finally {
			submit.disabled = false;
		}
	}

	async function pauseGoal(button) {
		const id = button.dataset.id;
		const goal = state.goals.find((item) => String(item.id) === id);
		if (!goal) return;
		goal.status = "paused";
		renderGoals();
		try {
			await api(`/public/goals/${id}`, {
				method: "PATCH",
				body: JSON.stringify({ status: "paused" }),
			});
			state.loaded.delete("today");
			showNotice("Цель поставлена на паузу.");
		} catch (error) {
			goal.status = "active";
			renderGoals();
			showNotice(error.message, true);
		}
	}

	async function loadProgress() {
		const { progress } = await api("/public/progress");
		state.progress = progress;
		state.loaded.add("progress");
		renderProgress(progress);
	}

	function renderProgress(progress) {
		const results = progress.completed_results || [];
		const blocks = progress.work_blocks || [];
		const artifacts = blocks.filter((item) => item.artifact);
		const strategies = progress.strategies || [];
		const timeline = [
			...results.map((item) => ({
				title: item.title,
				text: item.result_artifact || `Цель: ${item.goal_title}`,
				date: item.completed_at,
			})),
			...blocks.map((item) => ({
				title: item.actual_result || item.intention,
				text: item.artifact || item.helpful_factor || item.goal_title,
				date: item.completed_at,
			})),
		].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 20);
		document.getElementById("progress-content").innerHTML = `
			<div class="stats-grid">
				<div class="stat-card"><span class="stat-number">${results.length}</span><span class="card-caption">результатов завершено</span></div>
				<div class="stat-card"><span class="stat-number">${artifacts.length}</span><span class="card-caption">артефактов создано</span></div>
			</div>
			${renderGoalProgress(progress.goals || [])}
			<section>
				<div class="section-heading"><div><p class="app-kicker">История движения</p><h2>Последние шаги</h2></div></div>
				${timeline.length ? `<div class="content-card timeline">${timeline.map((item) => `
					<div class="timeline-item">
						<h3>${escapeHtml(item.title)}</h3>
						<p class="card-caption">${escapeHtml(item.text || "")}${item.date ? ` · ${formatDate(item.date)}` : ""}</p>
					</div>`).join("")}</div>` : emptyProgress()}
			</section>
			${strategies.length ? `<section>
				<div class="section-heading"><div><p class="app-kicker">То, что помогает</p><h2>Работающие стратегии</h2></div></div>
				<div class="content-card">${strategies.map((item) => `<div class="task-row">
					<span class="task-index">✓</span><span><strong>${escapeHtml(item.title)}</strong><br /><span class="card-caption">${escapeHtml(item.description)}</span></span><span></span>
				</div>`).join("")}</div>
			</section>` : ""}`;
	}

	function renderGoalProgress(goals) {
		if (!goals.length) return "";
		return `<section>
			<div class="section-heading"><div><p class="app-kicker">Общая картина</p><h2>Цели</h2></div></div>
			<div class="content-card">${goals.map((goal) => {
				const value = Math.max(0, Math.min(100, Number(goal.progress_percent || 0)));
				return `<div class="task-row">
					<span class="task-index">${value}</span>
					<span><span class="task-title">${escapeHtml(goal.title)}</span><div class="progress-track"><span style="width:${value}%"></span></div></span>
					<span class="task-date">%</span>
				</div>`;
			}).join("")}</div>
		</section>`;
	}

	function emptyProgress() {
		return `<div class="empty-state"><strong>Прогресс появится здесь</strong><span class="empty-copy">Начните первый рабочий блок — Ева сохранит результат.</span></div>`;
	}

	async function loadProfile() {
		const { profile } = await api("/public/profile");
		state.profile = profile;
		state.loaded.add("profile");
		renderProfile(profile);
	}

	function renderProfile(profile) {
		const user = profile.user || {};
		const interests = profileValue(profile, "interests") || user.interests || [];
		const style = profileValue(profile, "communication_style") || user.communication_style || "";
		const summary = profileValue(profile, "important_life_areas") || [];
		document.getElementById("profile-content").innerHTML = `
			<div class="profile-score">
				<div class="score-row">
					<div><p class="app-kicker">Профиль заполнен</p><strong>Ева лучше понимает контекст</strong></div>
					<span class="score-number">${Math.round(Number(profile.completeness || 0) * 100)}%</span>
				</div>
				<div class="progress-track"><span style="width:${Math.round(Number(profile.completeness || 0) * 100)}%"></span></div>
			</div>
			${renderCandidates(profile.candidates || [])}
			<form class="profile-form" id="profile-form">
				<label><span>Как к вам обращаться</span><input name="preferred_name" maxlength="120" value="${escapeAttribute(user.preferred_name || "")}" placeholder="Ваше имя" /></label>
				<label><span>Город</span><input name="city" maxlength="200" value="${escapeAttribute(user.city || "")}" placeholder="Например, Екатеринбург" /></label>
				<label><span>Часовой пояс</span><input name="timezone" maxlength="100" value="${escapeAttribute(user.timezone || "")}" placeholder="Asia/Yekaterinburg" /><small class="field-help">Можно указать город или точный часовой пояс.</small></label>
				<label><span>Язык</span><select name="preferred_language">
					<option value="" ${!user.preferred_language ? "selected" : ""}>Автоматически</option>
					<option value="ru" ${user.preferred_language === "ru" ? "selected" : ""}>Русский</option>
					<option value="en" ${user.preferred_language === "en" ? "selected" : ""}>English</option>
				</select></label>
				<label><span>Интересы</span><input name="interests" value="${escapeAttribute(asList(interests).join(", "))}" placeholder="Технологии, спорт, книги" /></label>
				<label><span>Предпочтительный стиль общения</span><input name="communication_style" maxlength="500" value="${escapeAttribute(style)}" placeholder="Например, кратко и по делу" /></label>
				<label><span>Что сейчас особенно важно</span><textarea name="important_life_areas" rows="3" placeholder="Работа, отношения, здоровье…">${escapeHtml(asList(summary).join(", "))}</textarea></label>
				<div class="autosave-state" id="autosave-state">Изменения сохраняются автоматически</div>
				<button class="primary-action" type="submit">Сохранить профиль</button>
			</form>`;
		const form = document.getElementById("profile-form");
		form.addEventListener("input", scheduleProfileSave);
		form.addEventListener("change", scheduleProfileSave);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			void saveProfile(true);
		});
		document.querySelectorAll(".candidate-action").forEach((button) => {
			button.addEventListener("click", () => void decideCandidate(button));
		});
	}

	function renderCandidates(candidates) {
		if (!candidates.length) return "";
		return `<section>
			<div class="section-heading"><div><p class="app-kicker">Нужна ваша проверка</p><h2>Сведения для подтверждения</h2></div></div>
			${candidates.map((field) => `<div class="candidate-card" data-field="${escapeAttribute(field.field_key)}">
				<strong>${escapeHtml(profileLabel(field.field_key))}</strong>
				<p class="card-caption">${escapeHtml(displayValue(field.value))}</p>
				<div class="candidate-actions">
					<button class="text-action candidate-action" type="button" data-action="confirm" data-field="${escapeAttribute(field.field_key)}">Подтвердить</button>
					<button class="text-action candidate-action" type="button" data-action="decline" data-field="${escapeAttribute(field.field_key)}">Не сохранять</button>
				</div>
			</div>`).join("")}
		</section>`;
	}

	function scheduleProfileSave() {
		clearTimeout(state.profileTimer);
		document.getElementById("autosave-state").textContent = "Есть несохранённые изменения…";
		state.profileTimer = setTimeout(() => void saveProfile(false), 800);
	}

	async function saveProfile(showSuccess) {
		clearTimeout(state.profileTimer);
		const form = document.getElementById("profile-form");
		if (!form) return;
		const data = Object.fromEntries(new FormData(form).entries());
		const fields = {};
		for (const key of ["preferred_name", "city", "timezone", "communication_style"]) {
			if (String(data[key] || "").trim()) fields[key] = String(data[key]).trim();
		}
		for (const key of ["interests", "important_life_areas"]) {
			const values = String(data[key] || "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
			if (values.length) fields[key] = values;
		}
		const status = document.getElementById("autosave-state");
		status.textContent = "Сохраняю…";
		try {
			const { profile } = await api("/public/profile", {
				method: "PATCH",
				body: JSON.stringify({
					fields,
					preferred_language: data.preferred_language || null,
				}),
			});
			state.profile = profile;
			status.textContent = "Сохранено";
			if (showSuccess) showNotice("Профиль обновлён.");
		} catch (error) {
			status.textContent = "Не удалось сохранить";
			showNotice(error.message, true);
		}
	}

	async function decideCandidate(button) {
		const field = button.dataset.field;
		const action = button.dataset.action;
		const card = button.closest(".candidate-card");
		card.style.opacity = "0.45";
		try {
			const { profile } = await api("/public/profile", {
				method: "PATCH",
				body: JSON.stringify({ [action]: [field] }),
			});
			state.profile = profile;
			renderProfile(profile);
			showNotice(action === "confirm" ? "Сведение подтверждено." : "Сведение удалено.");
		} catch (error) {
			card.style.opacity = "";
			showNotice(error.message, true);
		}
	}

	function profileValue(profile, key) {
		const item = (profile.confirmed || []).find((field) => field.field_key === key);
		return item?.value;
	}

	function profileLabel(key) {
		return {
			preferred_name: "Как обращаться",
			city: "Город",
			timezone: "Часовой пояс",
			interests: "Интересы",
			important_life_areas: "Важные области жизни",
			communication_style: "Стиль общения",
			recovery_methods: "Способы восстановления",
			typical_obstacles: "Типичные препятствия",
		}[key] || "Сведение профиля";
	}

	function renderUnavailable(screen) {
		const host = document.getElementById(`${screen}-content`);
		if (!host) return;
		host.innerHTML = `<div class="empty-state">
			<strong>Не получилось загрузить данные</strong>
			<span class="empty-copy">Проверьте соединение и откройте раздел ещё раз.</span>
		</div>`;
	}

	let noticeTimer;
	function showNotice(message, error = false, autoHide = true) {
		clearTimeout(noticeTimer);
		const notice = document.getElementById("notice");
		notice.textContent = message;
		notice.classList.toggle("is-error", error);
		notice.hidden = false;
		if (autoHide) {
			noticeTimer = setTimeout(() => {
				notice.hidden = true;
			}, 3600);
		}
	}

	function goalStatus(status) {
		return {
			active: "Активна",
			draft: "Черновик",
			paused: "Пауза",
			completed: "Готово",
		}[status] || "Цель";
	}

	function formatDate(value) {
		if (!value) return "";
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "";
		return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
	}

	function displayValue(value) {
		if (Array.isArray(value)) return value.join(", ");
		if (value && typeof value === "object") return Object.values(value).join(", ");
		return value == null ? "" : String(value);
	}

	function asList(value) {
		if (Array.isArray(value)) return value;
		return value ? [String(value)] : [];
	}

	function escapeHtml(value) {
		return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		})[character]);
	}

	function escapeAttribute(value) {
		return escapeHtml(value).replace(/`/g, "&#96;");
	}

	void bootstrap();
})();
