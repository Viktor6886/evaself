(() => {
  "use strict";

  const state = { available: null, entries: [], people: [], review: null };
  const app = () => window.EvaApp;

  async function probe() {
    if (state.available !== null) return state.available;
    try {
      const result = await app().api("/public/v2/journal?limit=30");
      state.entries = result.entries || [];
      state.available = true;
    } catch {
      state.available = false;
    }
    return state.available;
  }

  async function refresh() {
    if (!state.available) return;
    const [entries, people, review] = await Promise.all([
      app().safeApi("/public/v2/journal?limit=30", {}, null),
      app().safeApi("/public/v2/journal/people", {}, null),
      app().safeApi("/public/v2/journal/weekly-review", {}, null),
    ]);
    if (entries) state.entries = entries.entries || [];
    if (people) state.people = people.people || [];
    if (review) state.review = review;
  }

  async function render() {
    const host = document.getElementById("journal-content");
    if (!host) return;
    if (!state.available) {
      host.innerHTML = app().emptyState(
        "Дневник пока недоступен",
        "Раздел появится только когда серверное хранение дневника включено.",
      );
      return;
    }
    host.innerHTML = '<div class="section-stack"><div class="loading-skeleton"></div><div class="loading-skeleton"></div></div>';
    await refresh();
    host.innerHTML = `
      <div class="journal-toolbar">
        <button class="primary-action" id="journal-add" type="button">Новая запись</button>
        <button class="secondary-action" id="journal-ask" type="button">Обсудить неделю</button>
      </div>
      ${reviewCard(state.review)}
      <div class="section-stack">
        ${state.entries.length
          ? state.entries.map(entryCard).join("")
          : app().emptyState(
              "Записей пока нет",
              "Сохраняй события, мысли и эмоции. Ева не читает запись, пока ты сам не попросишь обсудить её.",
            )}
      </div>
      ${peopleCard(state.people)}
    `;
    host.querySelector("#journal-add")?.addEventListener("click", () => openEntrySheet(null));
    host.querySelector("#journal-ask")?.addEventListener("click", () => {
      app().openEvaHandoff(
        "Подведи итог моих записей за неделю: что повторяется, что меняется и на что стоит обратить внимание. Отделяй наблюдения от предположений.",
      );
    });
    host.querySelectorAll("[data-journal-entry]").forEach((button) => {
      button.addEventListener("click", () => {
        const entry = state.entries.find((item) => String(item.id) === button.dataset.journalEntry);
        openEntrySheet(entry || null);
      });
    });
  }

  function reviewCard(review) {
    if (!review) return "";
    if (!review.sufficient) {
      return `<article class="section-card">
        <span class="eyebrow">НЕДЕЛЬНЫЙ ОБЗОР</span>
        <h3>Данных пока мало</h3>
        <p>${app().escapeHtml(review.summary || "Нужно больше записей для честного вывода.")}</p>
      </article>`;
    }
    const findings = Array.isArray(review.sections)
      ? review.sections.filter((section) => section.finding)
      : [];
    return `<article class="section-card">
      <span class="eyebrow">НЕДЕЛЬНЫЙ ОБЗОР</span>
      <h3>${app().escapeHtml(review.from || "")}${review.to ? ` — ${app().escapeHtml(review.to)}` : ""}</h3>
      ${findings.map((section) => `
        <p class="review-finding"><strong>${app().escapeHtml(section.title || "Наблюдение")}.</strong>
        ${app().escapeHtml(section.finding)}</p>`).join("")}
    </article>`;
  }

  function entryCard(entry) {
    const mood = {
      very_low: "Тяжёлое",
      low: "Сниженное",
      neutral: "Спокойное",
      good: "Хорошее",
      great: "Отличное",
    }[entry.mood] || "";
    return `<button class="section-card journal-entry" type="button" data-journal-entry="${app().escapeAttr(entry.id)}">
      <span class="eyebrow">${app().escapeHtml(entry.local_date || app().formatDate(entry.created_at || ""))}${mood ? ` · ${mood}` : ""}</span>
      <h3>${app().escapeHtml(entry.title || "Без заголовка")}</h3>
      <p>${app().escapeHtml(String(entry.content || "").slice(0, 220))}</p>
      <footer class="journal-meta">
        <span>${entry.share_state === "shared_with_eva" ? "Обсуждалось с Евой" : "Только в дневнике"}</span>
        ${Array.isArray(entry.people) && entry.people.length
          ? `<span>${entry.people.map((person) => app().escapeHtml(person.display_name)).join(", ")}</span>`
          : ""}
      </footer>
    </button>`;
  }

  function peopleCard(people) {
    if (!people?.length) return "";
    return `<article class="section-card">
      <span class="eyebrow">ЛЮДИ В ЗАПИСЯХ</span>
      <p>Хранятся только те имена и роли, которые указал ты сам. Ева не строит скрытые профили других людей.</p>
      <div class="chip-row">${people.map((person) => `
        <span class="chip">${app().escapeHtml(person.display_name)}${person.mentions ? `<small>${Number(person.mentions)}</small>` : ""}</span>
      `).join("")}</div>
    </article>`;
  }

  function openEntrySheet(entry, preset = null) {
    const goals = (app().state.goals || []).slice(0, 20);
    app().openSheet({
      title: entry ? "Запись дневника" : "Новая запись",
      subtitle: "Сохранение не отправляет запись Еве. Обсуждение — отдельное действие.",
      html: `<form class="form-grid" id="journal-form">
        <label><span>Что важно сохранить?</span><textarea name="content" maxlength="20000" rows="6" required placeholder="Событие, мысль, чувство или вывод…">${app().escapeHtml(entry?.content || preset?.content || "")}</textarea></label>
        <label><span>Заголовок, необязательно</span><input name="title" maxlength="300" value="${app().escapeAttr(entry?.title || preset?.title || "")}"></label>
        <fieldset>
          <legend>Настроение</legend>
          <div class="choice-grid">${[
            ["very_low","Тяжёлое"],["low","Сниженное"],["neutral","Спокойное"],["good","Хорошее"],["great","Отличное"],
          ].map(([value,label]) => `<button class="choice-button ${entry?.mood === value ? "is-selected" : ""}" type="button" data-mood="${value}">${label}</button>`).join("")}</div>
        </fieldset>
        <input type="hidden" name="mood" value="${app().escapeAttr(entry?.mood || "")}">
        <label><span>Кто был рядом? Через запятую</span><input name="people" maxlength="500" value="${app().escapeAttr((entry?.people || []).map((person) => person.display_name).join(", "))}"></label>
        ${goals.length ? `<label><span>Связать с целью</span><select name="goal_id"><option value="">Не связано</option>${goals.map((goal) => `<option value="${app().escapeAttr(goal.id)}">${app().escapeHtml(goal.title)}</option>`).join("")}</select></label>` : ""}
        <button class="primary-action" type="submit">${entry ? "Сохранить изменения" : "Сохранить в дневник"}</button>
        <button class="secondary-action" id="journal-discuss" type="button">Сохранить и обсудить с Евой</button>
        ${entry ? '<button class="danger-action" id="journal-delete" type="button">Удалить запись</button>' : ""}
      </form>`,
      onMount(host) {
        const form = host.querySelector("#journal-form");
        host.querySelectorAll("[data-mood]").forEach((button) => button.addEventListener("click", () => {
          const selected = form.elements.mood.value === button.dataset.mood;
          form.elements.mood.value = selected ? "" : button.dataset.mood;
          host.querySelectorAll("[data-mood]").forEach((item) => {
            item.classList.toggle("is-selected", !selected && item === button);
          });
        }));
        form.addEventListener("submit", (event) => void save(event, entry, false));
        host.querySelector("#journal-discuss")?.addEventListener("click", () => void save(
          { preventDefault() {}, currentTarget: form },
          entry,
          true,
        ));
        host.querySelector("#journal-delete")?.addEventListener("click", () => void remove(entry));
      },
    });
  }

  async function save(event, entry, discuss) {
    event.preventDefault();
    const form = event.currentTarget;
    const content = form.elements.content.value.trim();
    if (!content) return app().toast("Запись пуста", true);

    const goalId = form.elements.goal_id?.value || "";
    const payload = {
      content,
      title: form.elements.title.value.trim() || null,
      mood: form.elements.mood.value || null,
      people: form.elements.people.value.split(",").map((value) => value.trim()).filter(Boolean),
      links: goalId ? [{ target_type: "goal", target_id: Number(goalId) }] : [],
    };

    try {
      const result = entry
        ? await app().api(`/public/v2/journal/${encodeURIComponent(entry.id)}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : await app().api("/public/v2/journal", {
            method: "POST",
            body: JSON.stringify(payload),
          });
      const saved = result.entry || { ...entry, ...payload };
      const id = saved.id || entry?.id;

      window.EvaRetention?.markInvestmentCompleted?.("journal_entry", {
        has_mood: Boolean(payload.mood),
        linked_goal: Boolean(goalId),
      });

      if (discuss && id != null) {
        const discussion = await app().api(`/public/v2/journal/${encodeURIComponent(id)}/discuss`, {
          method: "POST",
          body: "{}",
        });
        app().closeSheet();
        await render();
        return app().openEvaHandoff(discussion.discussion?.prompt || content);
      }

      app().closeSheet();
      app().toast("Запись сохранена. Ева её не читала.");
      await render();
    } catch (error) {
      app().toast(app().friendlyError(error), true);
    }
  }

  async function remove(entry) {
    if (!entry) return;
    const confirmed = await app().confirmDanger({
      title: "Удалить запись?",
      detail: "Запись и её связи будут удалены без возможности восстановления.",
      confirmLabel: "Удалить запись",
    });
    if (!confirmed) return;
    try {
      await app().api(`/public/v2/journal/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      state.entries = state.entries.filter((item) => String(item.id) !== String(entry.id));
      app().closeSheet();
      app().toast("Запись удалена");
      await render();
    } catch (error) {
      app().toast(app().friendlyError(error), true);
    }
  }

  window.EvaJournal = {
    state,
    probe,
    render,
    refresh,
    openNew: (preset = null) => openEntrySheet(null, preset),
  };
})();
