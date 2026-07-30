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
		firstName: "",
	};

	const titles = {
		today: "Сегодня",
		goals: "Развитие",
		organizer: "Органайзер",
		pult: "Пульт",
		progress: "Отчёты",
		profile: "Профиль",
	};

	const subtitles = {
		goals: "Цели и движение к важному",
		organizer: "Заметки, задачи и связи",
		pult: "Все возможности Evaself",
		progress: "Результаты и работающие стратегии",
		profile: "Настройки и контекст Евы",
	};

	const modules = [
		{ code: "journal", title: "Дневник", note: "Жизнь и мысли" },
		{ code: "state", title: "Состояние", note: "Настроение и энергия" },
		{ code: "compatibility", title: "Совместимость", note: "Люди и общение" },
		{ code: "budget", title: "Бюджет", note: "Доходы и расходы" },
		{ code: "practices", title: "Практики", note: "Перезагрузка" },
		{ code: "tests", title: "Тесты", note: "Понять себя" },
		{ code: "reports", title: "Отчёты", note: "Итоги и динамика", screen: "progress" },
		{ code: "goals", title: "Цели", note: "Направление и шаги", screen: "goals" },
		{ code: "life", title: "Карта жизни", note: "Важные сферы" },
		{ code: "programs", title: "Программы", note: "7, 14 и 30 дней" },
		{ code: "habits", title: "Привычки", note: "Поддерживающие ритмы" },
		{ code: "focus", title: "Фокус", note: "5, 15 или 25 минут", action: "focus" },
		{ code: "decisions", title: "Решения", note: "Факты и варианты" },
		{ code: "astro", title: "Астрорефлексия", note: "Символический взгляд" },
	];

	if (tg) {
		tg.ready();
		tg.expand();
		tg.enableClosingConfirmation?.();
	}

	document.querySelectorAll(".nav-item").forEach((button) => {
		button.addEventListener("click", () => void openScreen(button.dataset.target));
	});
	document.getElementById("add-goal")?.addEventListener("click", showGoalForm);
	document.getElementById("close-goal-form")?.addEventListener("click", hideGoalForm);
	document.getElementById("goal-form")?.addEventListener("submit", createGoal);
	document.getElementById("eva-fab")?.addEventListener("click", toggleEvaPanel);
	document.getElementById("eva-panel-close")?.addEventListener("click", closeEvaPanel);
	document.querySelectorAll("[data-eva-action]").forEach((button) => {
		button.addEventListener("click", () => handleEvaAction(button.dataset.evaAction));
	});
	document.querySelectorAll("[data-placeholder]").forEach((button) => {
		button.addEventListener("click", () => showFrontendNotice(button.dataset.placeholder));
	});

	renderPult();

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
			state.firstName = state.session.user?.preferred_name || state.session.user?.first_name || "";
			updateHeader("today");
			await loadToday();
		} catch (error) {
			showNotice(error.message, true, false);
			state.loaded.add("today");
			renderToday({
				local_time: "",
				main_action: "Выберите главный результат дня",
				expected_result: "Один понятный результат, который можно увидеть",
				first_step: "Начните с самого маленького действия",
				tasks: [],
			});
		}
	}

	function updateHeader(screen) {
		const title = document.getElementById("screen-title");
		const subtitle = document.getElementById("screen-subtitle");
		const localTime = document.getElementById("local-time");
		if (screen === "today") {
			const greeting = greetingForHour(new Date().getHours());
			title.textContent = state.firstName ? `${greeting}, ${state.firstName}` : greeting;
			subtitle.textContent = "Как ты себя чувствуешь сегодня?";
			localTime.hidden = false;
			return;
		}
		title.textContent = titles[screen] || "Ева";
		subtitle.textContent = subtitles[screen] || "Ева рядом";
		localTime.hidden = true;
	}

	function greetingForHour(hour) {
		if (hour < 5) return "Доброй ночи";
		if (hour < 12) return "Доброе утро";
		if (hour < 18) return "Добрый день";
		return "Добрый вечер";
	}

	async function openScreen(screen) {
		if (!titles[screen] || screen === state.screen) return;
		state.screen = screen;
		closeEvaPanel();
		document.querySelectorAll(".screen").forEach((node) => {
			const active = node.dataset.screen === screen;
			node.hidden = !active;
			node.classList.toggle("is-active", active);
		});
		document.querySelectorAll(".nav-item").forEach((node) => {
			node.classList.toggle("is-active", node.dataset.target === screen);
		});
		updateHeader(screen);
		window.scrollTo({ top: 0, behavior: "smooth" });
		if (!state.loaded.has(screen)) {
			const loaders = {
				goals: loadGoals,
				progress: loadProgress,
				profile: loadProfile,
			};
			try {
				await loaders[screen]?.();
				if (!loaders[screen]) state.loaded.add(screen);
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
				: "Главный результат дня";
		const button = today.work_block_id
			? `<button class="primary-action" id="today-action" type="button">${today.work_block_status === "active" ? "Готово" : "Начать"}</button>`
			: "";

		host.innerHTML = `
			<article class="checkin-card">
				<div class="checkin-copy">
					<h2>Как я сейчас?</h2>
					<div class="checkin-grid">
						<button class="checkin-pill" type="button" data-placeholder="Состояние"><span class="checkin-symbol">☺</span><strong>Настроение</strong><span>Отметить</span></button>
						<button class="checkin-pill" type="button" data-placeholder="Состояние"><span class="checkin-symbol">ϟ</span><strong>Энергия</strong><span>— / 10</span></button>
						<button class="checkin-pill" type="button" data-placeholder="Состояние"><span class="checkin-symbol">◎</span><strong>Фокус</strong><span>— / 10</span></button>
					</div>
				</div>
				<div class="eva-balloon" aria-hidden="true">
					<i class="balloon-brow left"></i><i class="balloon-brow right"></i>
					<i class="balloon-eye left"></i><i class="balloon-eye right"></i>
					<i class="balloon-smile"></i><i class="balloon-knot"></i>
				</div>
			</article>

			<article class="result-card" id="main-result-card">
				<span class="result-star" aria-hidden="true">★</span>
				<p class="app-kicker">${escapeHtml(status)}</p>
				<h2>${escapeHtml(today.goal_title || "Сегодня важно")}</h2>
				<p class="main-action-copy">${escapeHtml(today.main_action || "Выберите то, что сейчас действительно важно")}</p>
				<span class="result-underline" aria-hidden="true"></span>
				<div class="result-meta">
					${today.expected_result ? metaLine("→", "Ожидаемый результат", today.expected_result) : ""}
					${today.first_step ? metaLine("1", "Первый шаг", today.first_step) : ""}
				</div>
				${button}
			</article>

			<div class="quick-actions" aria-label="Быстрые действия">
				<button class="quick-action is-primary" type="button" data-quick-action="record"><span class="quick-action-icon">✎</span><span>Записать</span></button>
				<button class="quick-action" type="button" data-quick-action="focus"><span class="quick-action-icon">◎</span><span>Фокус</span></button>
				<button class="quick-action" type="button" data-quick-action="eva"><span class="quick-action-icon">♡</span><span>Ева</span></button>
				<button class="quick-action" type="button" data-quick-action="practice"><span class="quick-action-icon">♧</span><span>Практика</span></button>
			</div>

			<article class="today-feature">
				<h2>Сегодня</h2>
				<p>Твой день — твои решения</p>
				<button type="button" id="open-main-result">Открыть план →</button>
				<span class="feature-sun" aria-hidden="true"><i class="feature-smile"></i></span>
				<span class="feature-note" aria-hidden="true"></span>
			</article>

			<div class="module-section-heading"><h2>Модули Евы</h2><span>Всё важное рядом</span></div>
			${renderModuleGrid()}

			${today.continuation ? `<div class="continuation"><strong>Точка продолжения</strong><br />${escapeHtml(today.continuation)}</div>` : ""}
			<section>
				<div class="section-heading"><div><p class="app-kicker">Рядом с главным</p><h2>Ещё на сегодня</h2></div></div>
				${renderTasks(today.tasks || [])}
			</section>`;

		const action = document.getElementById("today-action");
		action?.addEventListener("click", () => void changeWorkBlock(action));
		document.getElementById("open-main-result")?.addEventListener("click", () => {
			document.getElementById("main-result-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
		});
		host.querySelectorAll("[data-placeholder]").forEach((button) => {
			button.addEventListener("click", () => showFrontendNotice(button.dataset.placeholder));
		});
		host.querySelectorAll("[data-quick-action]").forEach((button) => {
			button.addEventListener("click", () => handleQuickAction(button.dataset.quickAction));
		});
		bindModuleActions(host);
		if (!hasAction && !today.tasks?.length) {
			host.querySelector(".result-card")?.classList.add("is-empty");
		}
	}

	function renderModuleGrid() {
		return `<div class="module-grid">${modules.map((module) => `
			<button class="module-card" type="button" data-module="${escapeAttribute(module.code)}"${module.screen ? ` data-screen-target="${escapeAttribute(module.screen)}"` : ""}${module.action ? ` data-module-action="${escapeAttribute(module.action)}"` : ""}>
				<span class="module-icon" aria-hidden="true">${moduleIcon(module.code)}</span>
				<strong>${escapeHtml(module.title)}</strong>
				<small>${escapeHtml(module.note)}</small>
			</button>`).join("")}</div>`;
	}

	function renderPult() {
		const host = document.getElementById("pult-content");
		if (!host) return;
		host.innerHTML = `
			<article class="pult-intro"><h2>Пульт Евы</h2><p>Все направления собраны в одном месте. Доступные backend-модули продолжат работать, остальные пока представлены как готовый интерфейс.</p></article>
			<div class="module-section-heading"><h2>Все модули</h2><span>${modules.length} направлений</span></div>
			${renderModuleGrid()}`;
		bindModuleActions(host);
	}

	function bindModuleActions(host) {
		host.querySelectorAll(".module-card").forEach((button) => {
			button.addEventListener("click", () => {
				if (button.dataset.screenTarget) {
					void openScreen(button.dataset.screenTarget);
					return;
				}
				if (button.dataset.moduleAction === "focus") {
					handleQuickAction("focus");
					return;
				}
				const module = modules.find((item) => item.code === button.dataset.module);
				showFrontendNotice(module?.title || "Модуль");
			});
		});
	}

	function moduleIcon(code) {
		const icons = {
			journal: `<svg viewBox="0 0 48 48"><path d="M8 9c8-3 13-2 17 2v29c-4-4-9-5-17-2V9Zm32 0c-8-3-13-2-15 2v29c4-4 9-5 15-2V9Z"/><path class="fill-orange" d="m32 30 8-8 3 3-8 8-5 2 2-5Z"/></svg>`,
			state: `<svg viewBox="0 0 48 48"><path class="fill-orange" d="M24 40S7 31 7 18c0-6 4-10 10-10 4 0 6 2 7 5 2-3 4-5 8-5 6 0 10 4 10 10 0 13-18 22-18 22Z"/><path d="M16 22h3m10 0h3m-14 6c4 4 8 4 12 0"/></svg>`,
			compatibility: `<svg viewBox="0 0 48 48"><path class="fill-peach" d="M17 39S5 31 5 20c0-5 3-8 8-8 3 0 5 2 6 4 1-2 3-4 6-4 5 0 8 3 8 8 0 11-16 19-16 19Z"/><path class="fill-peach" d="M33 39S22 32 22 23c0-4 3-7 7-7 3 0 4 1 5 3 1-2 3-3 5-3 4 0 7 3 7 7 0 9-13 16-13 16Z"/><path d="M12 23h2m3 0h2m-6 5c2 2 4 2 6 0m10-2h2m3 0h2m-6 4c2 2 4 2 6 0"/></svg>`,
			budget: `<svg viewBox="0 0 48 48"><path d="M7 13h29c3 0 5 2 5 5v21H7V13Z"/><path class="fill-orange" d="M7 18h31c3 0 5 2 5 5v16H7V18Z"/><path d="M34 25h10v8H34c-2 0-4-2-4-4s2-4 4-4Z"/><circle cx="35" cy="29" r="1"/></svg>`,
			practices: `<svg viewBox="0 0 48 48"><path d="M24 40c-7-8-8-15 0-26 8 11 7 18 0 26Z"/><path d="M24 40c-11-3-15-9-13-20 10 5 14 11 13 20Zm0 0c11-3 15-9 13-20-10 5-14 11-13 20Z"/><path d="M24 40c-10 2-17-1-21-9 10-2 17 1 21 9Zm0 0c10 2 17-1 21-9-10-2-17 1-21 9Z"/></svg>`,
			tests: `<svg viewBox="0 0 48 48"><path d="M13 7h22v36H13V7Z"/><path d="M19 5h10v6H19V5Zm-1 14 3 3 5-6m-8 14 3 3 5-6m5-7h5m-5 11h5"/></svg>`,
			reports: `<svg viewBox="0 0 48 48"><path d="M7 40h35M11 35V24h7v11m5 0V13h7v22m5 0V7h7v28"/><path class="fill-orange" d="M11 24h7v11h-7zm12-11h7v22h-7z"/></svg>`,
			goals: `<svg viewBox="0 0 48 48"><circle cx="22" cy="25" r="16"/><circle cx="22" cy="25" r="10"/><circle cx="22" cy="25" r="4"/><path d="m25 22 15-15m-8 0h8v8"/></svg>`,
			life: `<svg viewBox="0 0 48 48"><path d="M5 16 17 9l14 6 12-7v27l-12 7-14-6-12 7V16Z"/><path d="M17 9v27m14-21v27"/><path class="fill-orange" d="M27 14c0 5-6 11-6 11s-6-6-6-11a6 6 0 1 1 12 0Z"/><circle cx="21" cy="14" r="2"/></svg>`,
			programs: `<svg viewBox="0 0 48 48"><path d="M7 38c8-2 5-12 14-13s4-12 15-13"/><path d="M34 5v16m0-16h10l-3 5 3 5H34"/><circle cx="7" cy="38" r="2"/></svg>`,
			habits: `<svg viewBox="0 0 48 48"><rect x="6" y="9" width="36" height="32" rx="3"/><path d="M14 5v8m20-8v8M6 17h36M13 25h7m8 0h7M13 33h7m8 0h7"/><path class="fill-orange" d="m28 31 3 3 7-8"/></svg>`,
			focus: `<svg viewBox="0 0 48 48"><path d="m4 39 13-19 8 10 7-13 12 22H4Z"/><path class="fill-orange" d="M31 10v14m0-14h10l-3 4 3 4H31"/></svg>`,
			decisions: `<svg viewBox="0 0 48 48"><path d="M23 43V10m0 7H7l-4 5 4 5h16m0-14h15l5-5-5-5H23m0 26h12l5 5-5 5H23"/><path class="fill-orange" d="M23 13h15l5-5-5-5H23v10Z"/></svg>`,
			astro: `<svg viewBox="0 0 48 48"><circle class="fill-orange" cx="23" cy="25" r="10"/><path d="M5 30c6 5 17 5 26 1 10-4 15-10 12-14-2-3-8-3-14-1M8 10l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Zm31 25 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/></svg>`,
		};
		return icons[code] || icons.journal;
	}

	function handleQuickAction(action) {
		if (action === "eva") {
			toggleEvaPanel();
			return;
		}
		if (action === "focus") {
			const workButton = document.getElementById("today-action");
			if (workButton) {
				workButton.scrollIntoView({ behavior: "smooth", block: "center" });
				return;
			}
			showFrontendNotice("Фокус");
			return;
		}
		showFrontendNotice(action === "record" ? "Дневник" : "Практики");
	}

	function showFrontendNotice(name) {
		showNotice(`${name}: главный экран готов. Функциональный backend будет подключён следующим этапом.`);
		tg?.HapticFeedback?.impactOccurred?.("light");
	}

	function toggleEvaPanel() {
		const panel = document.getElementById("eva-panel");
		const button = document.getElementById("eva-fab");
		const willOpen = panel.hidden;
		panel.hidden = !willOpen;
		button.setAttribute("aria-expanded", String(willOpen));
		tg?.HapticFeedback?.impactOccurred?.("light");
	}

	function closeEvaPanel() {
		const panel = document.getElementById("eva-panel");
		const button = document.getElementById("eva-fab");
		if (!panel) return;
		panel.hidden = true;
		button?.setAttribute("aria-expanded", "false");
	}

	function handleEvaAction(action) {
		closeEvaPanel();
		const labels = {
			message: "Диалог с Евой",
			voice: "Голосовой ввод",
			context: "Обсуждение текущего экрана",
			note: "Создание заметки",
		};
		showFrontendNotice(labels[action] || "Ева");
	}

	function metaLine(symbol, label, value) {
		return `<div class="meta-line"><span class="meta-symbol">${escapeHtml(symbol)}</span><span><span class="card-caption">${escapeHtml(label)}</span><br />${escapeHtml(value)}</span></div>`;
	}

	function renderTasks(tasks) {
		if (!tasks.length) {
			return `<div class="empty-state"><strong>Дополнительных задач нет</strong><span class="empty-copy">Можно сосредоточиться на главном шаге.</span></div>`;
		}
		return `<div class="content-card">${tasks.slice(0, 3).map((task, index) => `<div class="task-row"><span class="task-index">${index + 1}</span><span class="task-title">${escapeHtml(task.title)}</span><span class="task-date">${formatDate(task.due_at)}</span></div>`).join("")}</div>`;
	}

	async function changeWorkBlock(button) {
		if (!state.today?.work_block_id) return;
		const isActive = state.today.work_block_status === "active";
		const operation = isActive ? "complete" : "start";
		const previous = button.textContent;
		button.disabled = true;
		button.textContent = isActive ? "Сохраняю…" : "Начинаем…";
		try {
			await api(`/public/work-blocks/${state.today.work_block_id}/${operation}`, { method: "POST", body: JSON.stringify({}) });
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
			host.innerHTML = `<div class="empty-state"><strong>Целей пока нет</strong><span class="empty-copy">Добавьте одну цель, которую хочется приблизить.</span></div>`;
			return;
		}
		host.innerHTML = state.goals.map((goal) => {
			const progress = Math.max(0, Math.min(100, Number(goal.progress_percent || 0)));
			return `<article class="goal-card" data-goal-id="${escapeHtml(goal.id)}"><div class="goal-topline"><div><h3>${escapeHtml(goal.title)}</h3><p class="card-caption">${goal.target_date ? `до ${formatDate(goal.target_date)}` : "без жёсткого срока"}</p></div><span class="status-chip">${goalStatus(goal.status)}</span></div><div><div class="goal-topline card-caption"><span>Прогресс</span><span>${progress}%</span></div><div class="progress-track"><span style="width:${progress}%"></span></div></div>${goal.next_result ? `<div><p class="app-kicker">Ближайший результат</p><strong>${escapeHtml(goal.next_result)}</strong>${goal.next_step ? `<p class="card-caption">Следом: ${escapeHtml(goal.next_step)}</p>` : ""}</div>` : ""}<details class="goal-details"><summary>Подробнее</summary>${goal.why_it_matters ? `<p>${escapeHtml(goal.why_it_matters)}</p>` : "<p>Смысл цели пока не уточнён.</p>"}${goal.status === "active" ? `<button type="button" class="secondary-action pause-goal" data-id="${escapeHtml(goal.id)}">Поставить на паузу</button>` : ""}</details></article>`;
		}).join("");
		host.querySelectorAll(".pause-goal").forEach((button) => button.addEventListener("click", () => void pauseGoal(button)));
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
			const { goal } = await api("/public/goals", { method: "POST", body: JSON.stringify(payload) });
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
			await api(`/public/goals/${id}`, { method: "PATCH", body: JSON.stringify({ status: "paused" }) });
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
			...results.map((item) => ({ title: item.title, text: item.result_artifact || `Цель: ${item.goal_title}`, date: item.completed_at })),
			...blocks.map((item) => ({ title: item.actual_result || item.intention, text: item.artifact || item.helpful_factor || item.goal_title, date: item.completed_at })),
		].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 20);
		document.getElementById("progress-content").innerHTML = `<div class="stats-grid"><div class="stat-card"><span class="stat-number">${results.length}</span><span class="card-caption">результатов завершено</span></div><div class="stat-card"><span class="stat-number">${artifacts.length}</span><span class="card-caption">артефактов создано</span></div></div>${renderGoalProgress(progress.goals || [])}<section><div class="section-heading"><div><p class="app-kicker">История движения</p><h2>Последние шаги</h2></div></div>${timeline.length ? `<div class="content-card timeline">${timeline.map((item) => `<div class="timeline-item"><h3>${escapeHtml(item.title)}</h3><p class="card-caption">${escapeHtml(item.text || "")}${item.date ? ` · ${formatDate(item.date)}` : ""}</p></div>`).join("")}</div>` : emptyProgress()}</section>${strategies.length ? `<section><div class="section-heading"><div><p class="app-kicker">То, что помогает</p><h2>Работающие стратегии</h2></div></div><div class="content-card">${strategies.map((item) => `<div class="task-row"><span class="task-index">✓</span><span><strong>${escapeHtml(item.title)}</strong><br /><span class="card-caption">${escapeHtml(item.description)}</span></span><span></span></div>`).join("")}</div></section>` : ""}`;
	}

	function renderGoalProgress(goals) {
		if (!goals.length) return "";
		return `<section><div class="section-heading"><div><p class="app-kicker">Общая картина</p><h2>Цели</h2></div></div><div class="content-card">${goals.map((goal) => { const value = Math.max(0, Math.min(100, Number(goal.progress_percent || 0))); return `<div class="task-row"><span class="task-index">${value}</span><span><span class="task-title">${escapeHtml(goal.title)}</span><div class="progress-track"><span style="width:${value}%"></span></div></span><span class="task-date">%</span></div>`; }).join("")}</div></section>`;
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
		document.getElementById("profile-content").innerHTML = `<div class="profile-score"><div class="score-row"><div><p class="app-kicker">Профиль заполнен</p><strong>Ева лучше понимает контекст</strong></div><span class="score-number">${Math.round(Number(profile.completeness || 0) * 100)}%</span></div><div class="progress-track"><span style="width:${Math.round(Number(profile.completeness || 0) * 100)}%"></span></div></div>${renderCandidates(profile.candidates || [])}<form class="profile-form" id="profile-form"><label><span>Как к вам обращаться</span><input name="preferred_name" maxlength="120" value="${escapeAttribute(user.preferred_name || "")}" placeholder="Ваше имя" /></label><label><span>Город</span><input name="city" maxlength="200" value="${escapeAttribute(user.city || "")}" placeholder="Например, Екатеринбург" /></label><label><span>Часовой пояс</span><input name="timezone" maxlength="100" value="${escapeAttribute(user.timezone || "")}" placeholder="Asia/Yekaterinburg" /><small class="field-help">Можно указать город или точный часовой пояс.</small></label><label><span>Язык</span><select name="preferred_language"><option value="" ${!user.preferred_language ? "selected" : ""}>Автоматически</option><option value="ru" ${user.preferred_language === "ru" ? "selected" : ""}>Русский</option><option value="en" ${user.preferred_language === "en" ? "selected" : ""}>English</option></select></label><label><span>Интересы</span><input name="interests" value="${escapeAttribute(asList(interests).join(", "))}" placeholder="Технологии, спорт, книги" /></label><label><span>Предпочтительный стиль общения</span><input name="communication_style" maxlength="500" value="${escapeAttribute(style)}" placeholder="Например, кратко и по делу" /></label><label><span>Что сейчас особенно важно</span><textarea name="important_life_areas" rows="3" placeholder="Работа, отношения, здоровье…">${escapeHtml(asList(summary).join(", "))}</textarea></label><div class="autosave-state" id="autosave-state">Изменения сохраняются автоматически</div><button class="primary-action" type="submit">Сохранить профиль</button></form>`;
		const form = document.getElementById("profile-form");
		form.addEventListener("input", scheduleProfileSave);
		form.addEventListener("change", scheduleProfileSave);
		form.addEventListener("submit", (event) => { event.preventDefault(); void saveProfile(true); });
		document.querySelectorAll(".candidate-action").forEach((button) => button.addEventListener("click", () => void decideCandidate(button)));
	}

	function renderCandidates(candidates) {
		if (!candidates.length) return "";
		return `<section><div class="section-heading"><div><p class="app-kicker">Нужна ваша проверка</p><h2>Сведения для подтверждения</h2></div></div>${candidates.map((field) => `<div class="candidate-card" data-field="${escapeAttribute(field.field_key)}"><strong>${escapeHtml(profileLabel(field.field_key))}</strong><p class="card-caption">${escapeHtml(displayValue(field.value))}</p><div class="candidate-actions"><button class="text-action candidate-action" type="button" data-action="confirm" data-field="${escapeAttribute(field.field_key)}">Подтвердить</button><button class="text-action candidate-action" type="button" data-action="decline" data-field="${escapeAttribute(field.field_key)}">Не сохранять</button></div></div>`).join("")}</section>`;
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
			const { profile } = await api("/public/profile", { method: "PATCH", body: JSON.stringify({ fields, preferred_language: data.preferred_language || null }) });
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
			const { profile } = await api("/public/profile", { method: "PATCH", body: JSON.stringify({ [action]: [field] }) });
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
		host.innerHTML = `<div class="empty-state"><strong>Не получилось загрузить данные</strong><span class="empty-copy">Проверьте соединение и откройте раздел ещё раз.</span></div>`;
	}

	let noticeTimer;
	function showNotice(message, error = false, autoHide = true) {
		clearTimeout(noticeTimer);
		const notice = document.getElementById("notice");
		notice.textContent = message;
		notice.classList.toggle("is-error", error);
		notice.hidden = false;
		if (autoHide) {
			noticeTimer = setTimeout(() => { notice.hidden = true; }, 4200);
		}
	}

	function goalStatus(status) {
		return { active: "Активна", draft: "Черновик", paused: "Пауза", completed: "Готово" }[status] || "Цель";
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
		return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
	}

	function escapeAttribute(value) {
		return escapeHtml(value).replace(/`/g, "&#96;");
	}

	void bootstrap();
})();
