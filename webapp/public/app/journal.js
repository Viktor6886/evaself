/**
 * Дневник, недельный обзор и «Спросить Еву» в Mini App.
 *
 * Отдельный файл, а не ещё триста строк в app.js: тот и так велик, и
 * читать его целиком приходится при любой правке интерфейса.
 *
 * Что здесь важно и легко потерять:
 *
 *   • «Сохранить» и «Обсудить с Евой» — РАЗНЫЕ кнопки. Сохранение
 *     никуда не отправляет запись; обсуждение — отдельное действие,
 *     и человек видит разницу до нажатия, а не после;
 *   • раздел появляется, только если сервер его отдаёт. Выключенный
 *     дневник отвечает 404, и тогда карточки в Пульте нет вовсе —
 *     пустой список выглядел бы как «дневник есть, но он пуст»;
 *   • ответ «Спросить Еву» показывается ЧЕТЫРЬМЯ разделами. Вывод
 *     модели никогда не сливается с записями и памятью в один абзац.
 */

(() => {
  "use strict";

  const app = window.EvaApp;
  if (!app) return;

  const MOODS = [
    ["very_low", "Тяжёлое"],
    ["low", "Сниженное"],
    ["neutral", "Спокойное"],
    ["good", "Хорошее"],
    ["great", "Отличное"],
  ];

  const SOURCE_NOTES = {
    personal_memory: "Что Ева помнит о вас",
    structured_records: "Ваши собственные записи",
    external_sources: "Проверенные внешние источники",
    model_conclusion: "Предположение, а не факт",
  };

  const state = { entries: [], people: [], review: null, available: null };

  /**
   * Доступность проверяется один раз за сессию и запоминается.
   * Отличать «выключено» от «пусто» обязан сервер: 404 — это первое,
   * пустой список — второе.
   */
  async function probe() {
    if (state.available !== null) return state.available;
    try {
      const result = await app.api("/public/v2/journal?limit=30");
      state.entries = result.entries || [];
      state.available = true;
    } catch (error) {
      state.available = error?.status !== 404 ? null : false;
      if (state.available === null) state.available = false;
    }
    return state.available;
  }

  async function refresh() {
    const [entries, people, review] = await Promise.all([
      app.safeApi("/public/v2/journal?limit=30", {}, null),
      app.safeApi("/public/v2/journal/people", {}, null),
      app.safeApi("/public/v2/journal/weekly-review", {}, null),
    ]);
    if (entries) state.entries = entries.entries || [];
    if (people) state.people = people.people || [];
    if (review) state.review = review;
  }

  function open() {
    app.openModule({
      code: "journal",
      title: "Дневник",
      kicker: "ЗАПИСИ ДНЯ",
      html: '<div class="module-cards" id="journal-host"><article class="section-card"><p>Загружаю…</p></article></div>',
      onMount() { void render(); },
    });
  }

  async function render() {
    await refresh();
    const host = document.getElementById("journal-host");
    if (!host) return;
    host.innerHTML = `
      <div class="action-row">
        <button class="primary-action" id="journal-add" type="button">Новая запись</button>
        <button class="secondary-action" id="journal-ask" type="button">Спросить Еву</button>
      </div>
      ${reviewCard(state.review)}
      <div class="section-stack" id="journal-entries">
        ${state.entries.length
          ? state.entries.map(entryCard).join("")
          : app.emptyState("Записей пока нет", "Запись сохраняется без участия ИИ. Обсудить её можно отдельной кнопкой.")}
      </div>
      ${peopleCard(state.people)}`;
    host.querySelector("#journal-add").addEventListener("click", () => openEntrySheet(null));
    host.querySelector("#journal-ask").addEventListener("click", openAsk);
    host.querySelectorAll("[data-journal-entry]").forEach((button) => button.addEventListener(
      "click",
      () => openEntrySheet(state.entries.find((item) => String(item.id) === button.dataset.journalEntry)),
    ));
    host.querySelectorAll("[data-journal-person]").forEach((button) => button.addEventListener(
      "click",
      () => openPersonSheet(state.people.find((item) => String(item.id) === button.dataset.journalPerson)),
    ));
  }

  function reviewCard(review) {
    if (!review) return "";
    if (!review.sufficient) {
      // Честный отказ показывается как отказ, а не как пустая карточка:
      // человек должен понимать, что вывода нет, и почему.
      return `<article class="section-card"><span class="eyebrow">НЕДЕЛЬНЫЙ ОБЗОР</span>
        <h3>Данных пока мало</h3><p>${app.escapeHtml(review.summary)}</p></article>`;
    }
    return `<article class="section-card"><span class="eyebrow">НЕДЕЛЬНЫЙ ОБЗОР</span>
      <h3>${app.escapeHtml(review.from)} — ${app.escapeHtml(review.to)}</h3>
      ${review.sections.filter((section) => section.finding).map((section) => `
        <p><strong>${app.escapeHtml(section.title)}.</strong> ${app.escapeHtml(section.finding)}
        <small class="evidence-note">по ${section.observations} наблюдениям</small></p>`).join("")}
    </article>`;
  }

  function entryCard(entry) {
    const mood = MOODS.find(([value]) => value === entry.mood);
    const shared = entry.share_state === "shared_with_eva";
    return `<button class="section-card journal-entry" type="button" data-journal-entry="${app.escapeAttr(entry.id)}">
      <span class="eyebrow">${app.escapeHtml(entry.local_date)}${mood ? ` · ${app.escapeHtml(mood[1])}` : ""}</span>
      <h3>${app.escapeHtml(entry.title || "Без заголовка")}</h3>
      <p>${app.escapeHtml(String(entry.content).slice(0, 160))}</p>
      <footer class="journal-meta">
        <span>${shared ? "Обсуждалось с Евой" : "Только в дневнике"}</span>
        ${entry.people.length ? `<span>${entry.people.map((person) => app.escapeHtml(person.display_name)).join(", ")}</span>` : ""}
        ${entry.voice ? `<span>Голос: ${app.escapeHtml(voiceLabel(entry.voice))}</span>` : ""}
      </footer>
    </button>`;
  }

  function voiceLabel(voice) {
    if (voice.status === "expired") return "срок хранения истёк, расшифровка сохранена";
    if (voice.status === "transcribed") return "расшифрована";
    if (voice.status === "failed") return "не удалось обработать";
    return "сохранена";
  }

  function peopleCard(people) {
    if (!people.length) return "";
    return `<article class="section-card"><span class="eyebrow">ЛЮДИ В ЗАПИСЯХ</span>
      <p>Хранится только имя, которым вы их называете, и роль. Ева не строит скрытый профиль другого человека.</p>
      <div class="chip-row">${people.map((person) => `
        <button class="chip" type="button" data-journal-person="${app.escapeAttr(person.id)}">
          ${app.escapeHtml(person.display_name)}<small>${person.mentions}</small>
        </button>`).join("")}</div>
    </article>`;
  }

  function openEntrySheet(entry) {
    const goals = (app.state.goals || []).slice(0, 20);
    app.openSheet({
      title: entry ? "Запись дневника" : "Новая запись",
      subtitle: "Сохранение никуда не отправляет запись. Обсудить её с Евой — отдельная кнопка.",
      html: `<form class="form-grid" id="journal-form">
        <label><span>Что важно сохранить?</span><textarea name="content" maxlength="20000" rows="5" required placeholder="Событие, мысль, наблюдение или вывод…">${app.escapeHtml(entry?.content || "")}</textarea></label>
        <label><span>Заголовок, необязательно</span><input name="title" maxlength="300" value="${app.escapeAttr(entry?.title || "")}"></label>
        <fieldset><legend>Настроение</legend><div class="choice-grid">${MOODS.map(([value, label]) => `
          <button class="choice-button ${entry?.mood === value ? "is-selected" : ""}" type="button" data-mood="${value}">${label}</button>`).join("")}</div></fieldset>
        <input type="hidden" name="mood" value="${app.escapeAttr(entry?.mood || "")}">
        <label><span>Кто был рядом? Через запятую</span><input name="people" maxlength="500" value="${app.escapeAttr((entry?.people || []).map((person) => person.display_name).join(", "))}"></label>
        ${goals.length ? `<label><span>С какой целью связано?</span><select name="goal_id">
          <option value="">Не связано</option>
          ${goals.map((goal) => `<option value="${app.escapeAttr(goal.id)}" ${linkedGoal(entry) === String(goal.id) ? "selected" : ""}>${app.escapeHtml(goal.title)}</option>`).join("")}
        </select></label>` : ""}
        <button class="primary-action" type="submit">${entry ? "Сохранить изменения" : "Сохранить в дневник"}</button>
        <button class="secondary-action" id="journal-discuss" type="button">Обсудить с Евой</button>
        <button class="secondary-action" id="journal-voice" type="button">Надиктовать в чате</button>
        ${entry ? '<button class="danger-action" id="journal-delete" type="button">Удалить запись</button>' : ""}
      </form>`,
      onMount(host) {
        const form = host.querySelector("#journal-form");
        host.querySelectorAll("[data-mood]").forEach((button) => button.addEventListener("click", () => {
          const already = form.elements.mood.value === button.dataset.mood;
          form.elements.mood.value = already ? "" : button.dataset.mood;
          host.querySelectorAll("[data-mood]").forEach((item) => item.classList.toggle(
            "is-selected",
            !already && item === button,
          ));
        }));
        form.addEventListener("submit", (event) => void save(event, entry, { discuss: false }));
        host.querySelector("#journal-discuss").addEventListener("click", () => void save(
          { preventDefault() {}, currentTarget: form },
          entry,
          { discuss: true },
        ));
        host.querySelector("#journal-voice").addEventListener("click", () => app.openEvaHandoff(
          "Хочу надиктовать запись в дневник голосовым сообщением",
        ));
        host.querySelector("#journal-delete")?.addEventListener("click", () => void remove(entry));
      },
    });
  }

  function linkedGoal(entry) {
    const link = (entry?.links || []).find((item) => item.target_type === "goal");
    return link ? String(link.target_id) : "";
  }

  async function save(event, entry, { discuss }) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.elements.content.value.trim()) {
      app.toast("Запись пуста", true);
      return;
    }
    const goalId = form.elements.goal_id?.value;
    const payload = {
      content: form.elements.content.value.trim(),
      title: form.elements.title.value.trim() || null,
      mood: form.elements.mood.value || null,
      people: form.elements.people.value.split(",").map((name) => name.trim()).filter(Boolean),
      links: goalId ? [{ target_type: "goal", target_id: Number(goalId) }] : [],
    };
    try {
      const saved = entry
        ? await app.api(`/public/v2/journal/${encodeURIComponent(entry.id)}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
        : await app.api("/public/v2/journal", { method: "POST", body: JSON.stringify(payload) });
      const id = saved.entry?.id ?? entry?.id;
      if (!discuss) {
        app.closeSheet();
        app.toast("Запись сохранена. Ева её не читала.");
        return void render();
      }
      const discussion = await app.api(`/public/v2/journal/${encodeURIComponent(id)}/discuss`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      app.closeSheet();
      await render();
      app.openEvaHandoff(discussion.discussion?.prompt || payload.content);
    } catch (error) {
      app.toast(app.friendlyError(error), true);
    }
  }

  async function remove(entry) {
    const confirmed = await app.confirmDanger({
      title: "Удалить запись?",
      detail: "Вместе с записью исчезнут её связи с целями, упоминания людей и голосовая заметка. Отменить это нельзя.",
      confirmLabel: "Удалить запись",
    });
    if (!confirmed) return;
    try {
      await app.api(`/public/v2/journal/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      app.closeSheet();
      app.toast("Запись и всё производное от неё удалены");
      await render();
    } catch (error) {
      app.toast(app.friendlyError(error), true);
    }
  }

  function openPersonSheet(person) {
    if (!person) return;
    app.openSheet({
      title: app.escapeHtml(person.display_name),
      subtitle: "Карточка человека хранит только имя и роль. Оценок и выводов о нём здесь нет.",
      html: `<form class="form-grid" id="person-form">
        <label><span>Как вы его называете</span><input name="display_name" maxlength="200" required value="${app.escapeAttr(person.display_name)}"></label>
        <label><span>Кто это для вас, необязательно</span><input name="relation" maxlength="200" value="${app.escapeAttr(person.relation || "")}"></label>
        <button class="primary-action" type="submit">Сохранить</button>
        <button class="danger-action" id="person-delete" type="button">Удалить карточку</button>
      </form>`,
      onMount(host) {
        host.querySelector("#person-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const raw = Object.fromEntries(new FormData(event.currentTarget).entries());
          try {
            await app.api(`/public/v2/journal/people/${encodeURIComponent(person.id)}`, {
              method: "PATCH",
              body: JSON.stringify({
                display_name: raw.display_name.trim(),
                relation: raw.relation.trim() || null,
              }),
            });
            app.closeSheet();
            app.toast("Карточка обновлена");
            await render();
          } catch (error) { app.toast(app.friendlyError(error), true); }
        });
        host.querySelector("#person-delete").addEventListener("click", async () => {
          const confirmed = await app.confirmDanger({
            title: "Удалить карточку?",
            detail: `Упоминания «${person.display_name}» исчезнут из всех записей. Тексты записей останутся как есть.`,
            confirmLabel: "Удалить карточку",
          });
          if (!confirmed) return;
          try {
            await app.api(`/public/v2/journal/people/${encodeURIComponent(person.id)}`, { method: "DELETE" });
            app.closeSheet();
            app.toast("Карточка и упоминания удалены");
            await render();
          } catch (error) { app.toast(app.friendlyError(error), true); }
        });
      },
    });
  }

  // -------------------------------------------------------------------
  // «Спросить Еву»
  // -------------------------------------------------------------------

  function openAsk() {
    app.openSheet({
      title: "Спросить Еву",
      subtitle: "Ответ разделён по источникам: память, ваши записи, внешние источники и вывод Евы.",
      html: `<form class="form-grid" id="ask-form">
        <label><span>Вопрос</span><input name="question" maxlength="1000" required placeholder="Например: как менялось моё отношение к работе?"></label>
        <button class="primary-action" type="submit">Спросить</button>
      </form>
      <div class="section-stack" id="ask-answer"></div>`,
      onMount(host) {
        host.querySelector("#ask-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const question = event.currentTarget.elements.question.value.trim();
          const answerHost = host.querySelector("#ask-answer");
          answerHost.innerHTML = '<article class="section-card"><p>Собираю источники…</p></article>';
          try {
            const answer = await app.api("/public/v2/journal/ask", {
              method: "POST",
              body: JSON.stringify({ question }),
            });
            answerHost.innerHTML = renderAnswer(answer);
          } catch (error) {
            answerHost.innerHTML = `<article class="section-card"><p>${app.escapeHtml(app.friendlyError(error))}</p></article>`;
          }
        });
      },
    });
  }

  function renderAnswer(answer) {
    const crisis = answer.crisis
      ? `<article class="section-card is-priority"><p>${app.escapeHtml(answer.crisis.directive)}</p></article>`
      : "";
    return crisis + answer.sections.map((section) => {
      if (!section.available) {
        return `<article class="section-card"><span class="eyebrow">${app.escapeHtml(section.title)}</span>
          <p>${app.escapeHtml(section.unavailable_reason || "Раздел недоступен")}</p></article>`;
      }
      if (!section.items.length) {
        return `<article class="section-card"><span class="eyebrow">${app.escapeHtml(section.title)}</span>
          <p>Ничего не нашлось.</p></article>`;
      }
      return `<article class="section-card"><span class="eyebrow">${app.escapeHtml(section.title)}</span>
        <p class="muted">${app.escapeHtml(SOURCE_NOTES[section.kind] || "")}</p>
        ${section.items.map((item) => `
          <p>${app.escapeHtml(item.text)}
            <small class="evidence-note">уверенность ${Math.round(item.confidence * 100)}% · ${item.evidence.map((evidence) => app.escapeHtml(evidence.reference)).join(", ")}</small>
          </p>`).join("")}
      </article>`;
    }).join("");
  }

  window.EvaJournal = { probe, open, render };
})();
