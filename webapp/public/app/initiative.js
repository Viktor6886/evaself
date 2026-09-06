(() => {
  "use strict";

  /**
   * Окна, в которые Ева может писать первой.
   *
   * Человек называет промежуток — «с одиннадцати до двенадцати», — а
   * минуту внутри него выбирает сервер, один раз на сутки. Точное время
   * здесь не спрашивается намеренно: сообщение, приходящее ровно в 11:00
   * каждый день, читается как будильник, кем бы оно ни было подписано.
   *
   * Отдельным файлом, а не внутри `app.js`: тот уже перевалил за две с
   * половиной тысячи строк, и каждая сессия, которая его касается,
   * платит за чтение целиком.
   */

  const DAYS = [
    { value: 1, short: "пн" },
    { value: 2, short: "вт" },
    { value: 3, short: "ср" },
    { value: 4, short: "чт" },
    { value: 5, short: "пт" },
    { value: 6, short: "сб" },
    { value: 7, short: "вс" },
  ];

  const DEFAULT_WINDOW = { start_minute: 11 * 60, end_minute: 12 * 60 };

  const state = { loaded: null, draft: null };
  const app = () => window.EvaApp;

  function minutesToTime(minutes) {
    const value = Math.max(0, Math.min(1440, Number(minutes) || 0));
    const hours = String(Math.floor(value / 60) % 24).padStart(2, "0");
    return `${hours}:${String(value % 60).padStart(2, "0")}`;
  }

  function timeToMinutes(text) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
    if (!match) return null;
    const minutes = Number(match[1]) * 60 + Number(match[2]);
    return Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : null;
  }

  /** Краткое описание для строки настроек: сколько окон и когда ближайшее. */
  function summary() {
    if (!state.loaded) return "Открыть";
    if (!state.loaded.enabled) return "Выключено";
    const active = (state.loaded.windows || []).filter((item) => item.enabled !== false);
    if (active.length === 0) return "Не задано";
    const first = active.slice().sort((a, b) => a.start_minute - b.start_minute)[0];
    return active.length === 1
      ? `${minutesToTime(first.start_minute)}–${minutesToTime(first.end_minute)}`
      : `${active.length} окна`;
  }

  async function load() {
    const payload = await app().safeApi("/public/proactive-windows", {}, null);
    if (payload && payload.proactive) state.loaded = payload.proactive;
    return state.loaded;
  }

  function windowRow(window, index) {
    const escapeAttr = app().escapeAttr;
    const days = Array.isArray(window.weekdays) && window.weekdays.length
      ? window.weekdays.map(Number)
      : [1, 2, 3, 4, 5, 6, 7];
    return `<article class="section-card" data-window="${index}">
      <div class="form-grid">
        <label><span>Начало</span>
          <input type="time" data-field="start" value="${escapeAttr(minutesToTime(window.start_minute))}"></label>
        <label><span>Конец</span>
          <input type="time" data-field="end" value="${escapeAttr(minutesToTime(window.end_minute))}"></label>
      </div>
      <div class="chip-row" data-days>
        ${DAYS.map((day) => `<button type="button" class="choice-button${
          days.includes(day.value) ? " is-selected" : ""
        }" data-day="${day.value}">${day.short}</button>`).join("")}
      </div>
      <div class="action-row">
        <button class="secondary-action" type="button" data-remove="${index}">Убрать окно</button>
      </div>
    </article>`;
  }

  function render(host) {
    const draft = state.draft;
    const limit = state.loaded?.max_windows ?? 6;
    const minutes = state.loaded?.min_minutes ?? 15;
    host.innerHTML = `<div class="section-stack">
      <article class="section-card">
        <span class="eyebrow">СОГЛАСИЕ</span>
        <h3>${draft.enabled ? "Ева может писать первой" : "Ева пишет только в ответ"}</h3>
        <p>Внутри окна Ева выбирает минуту сама и пишет один раз. Точное
        время не спрашивается: сообщение ровно в одну и ту же минуту
        каждый день читается как будильник, а не как разговор.</p>
        <div class="action-row">
          <button class="${draft.enabled ? "secondary-action" : "primary-action"}"
                  type="button" id="initiative-toggle">
            ${draft.enabled ? "Выключить" : "Включить"}
          </button>
        </div>
      </article>

      <div id="initiative-windows">
        ${draft.windows.map((window, index) => windowRow(window, index)).join("")}
      </div>

      <article class="section-card">
        <p class="muted">Окно должно быть не короче ${minutes} минут, окон — не больше ${limit}.
        Между двумя сообщениями Ева выдерживает минимум сорок пять минут, поэтому
        окна вплотную друг к другу дадут одно сообщение, а не два.
        Часовой пояс: ${app().escapeHtml(state.loaded?.timezone || "не определён")}.</p>
        <div class="action-row">
          <button class="secondary-action" type="button" id="initiative-add"
                  ${draft.windows.length >= limit ? "disabled" : ""}>Добавить окно</button>
          <button class="primary-action" type="button" id="initiative-save">Сохранить</button>
        </div>
      </article>
    </div>`;
    bind(host);
  }

  function bind(host) {
    host.querySelector("#initiative-toggle").addEventListener("click", () => {
      state.draft.enabled = !state.draft.enabled;
      render(host);
    });
    host.querySelector("#initiative-add").addEventListener("click", () => {
      state.draft.windows.push({
        id: null, ...DEFAULT_WINDOW, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true,
      });
      render(host);
    });
    host.querySelector("#initiative-save").addEventListener("click", () => void save(host));

    host.querySelectorAll("[data-window]").forEach((card) => {
      const index = Number(card.dataset.window);
      card.querySelectorAll("input[data-field]").forEach((input) => {
        input.addEventListener("change", () => {
          const minutes = timeToMinutes(input.value);
          if (minutes === null) return;
          const key = input.dataset.field === "start" ? "start_minute" : "end_minute";
          state.draft.windows[index][key] = minutes;
        });
      });
      card.querySelectorAll("[data-day]").forEach((button) => {
        button.addEventListener("click", () => {
          const day = Number(button.dataset.day);
          const window = state.draft.windows[index];
          const days = new Set(window.weekdays);
          if (days.has(day)) days.delete(day);
          else days.add(day);
          // Окно без дней не сработает никогда, а выглядит рабочим.
          // Последний день не снимается — окно убирают целиком.
          if (days.size === 0) return;
          window.weekdays = [...days].sort((a, b) => a - b);
          render(host);
        });
      });
      card.querySelector("[data-remove]").addEventListener("click", () => {
        state.draft.windows.splice(index, 1);
        render(host);
      });
    });
  }

  async function save(host) {
    try {
      const result = await app().api("/public/proactive-windows", {
        method: "PUT",
        body: JSON.stringify({
          enabled: state.draft.enabled,
          windows: state.draft.windows.map((window) => ({
            id: window.id ?? null,
            start_minute: window.start_minute,
            end_minute: window.end_minute,
            weekdays: window.weekdays,
            enabled: window.enabled !== false,
          })),
        }),
      });
      state.loaded = result.proactive || state.loaded;
      app().closeSheet();
      app().toast(state.draft.enabled ? "Окна сохранены" : "Ева больше не пишет первой");
    } catch (error) {
      app().toast(app().friendlyError(error), true);
      // Черновик остаётся на экране: человек только что его набрал, и
      // терять его из-за отказа сети незачем.
      render(host);
    }
  }

  async function open() {
    const loaded = await load();
    if (!loaded) {
      app().openSheet({
        title: "Когда Ева пишет первой",
        html: app().emptyState(
          "Раздел пока недоступен",
          "Инициативные сообщения включает владелец установки.",
        ),
      });
      return;
    }
    state.draft = {
      enabled: loaded.enabled !== false,
      windows: (loaded.windows || []).map((window) => ({
        // Идентификатор — то, чем окно остаётся собой между
        // сохранениями. Без него сервер видел бы правку одного окна как
        // замену всего набора, и уже назначенная на сегодня минута
        // выбиралась бы заново.
        id: window.id ?? null,
        start_minute: Number(window.start_minute),
        end_minute: Number(window.end_minute),
        weekdays: Array.isArray(window.weekdays) && window.weekdays.length
          ? window.weekdays.map(Number)
          : [1, 2, 3, 4, 5, 6, 7],
        enabled: window.enabled !== false,
      })),
    };
    app().openSheet({
      title: "Когда Ева пишет первой",
      subtitle: "Промежутки называешь ты. Минуту внутри них выбирает Ева.",
      html: `<div id="initiative-host"></div>`,
      onMount(host) {
        render(host.querySelector("#initiative-host"));
      },
    });
  }

  window.EvaInitiative = { open, load, summary };
})();
