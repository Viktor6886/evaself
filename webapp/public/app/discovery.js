(() => {
  "use strict";

  // This is the entry point for self-discovery, not a psychometric engine.
  // Reuse the existing conversation handoff until licensed assessments exist.
  const topics = [
    { id: "personality", icon: "user", name: "Характер и сильные стороны",
      question: "В чём моя опора?",
      benefit: "Заметь свои привычные способы действовать и качества, на которые можно опереться.",
      prompt: "Хочу лучше понять свои сильные стороны и привычные реакции. Помоги разобрать один конкретный пример из моей жизни." },
    { id: "emotions", icon: "smile", name: "Эмоции и реакции",
      question: "Почему я так реагирую?",
      benefit: "Разберись, что стоит за чувствами и что помогает тебе возвращать равновесие.",
      prompt: "Хочу лучше понимать свои эмоции. Помоги разобрать недавнюю ситуацию: что я почувствовал, что повлияло на реакцию и что можно попробовать в следующий раз." },
    { id: "relationships", icon: "chat", name: "Отношения и границы",
      question: "Как мне быть собой рядом с другими?",
      benefit: "Уточни, что тебе важно в близости, общении и личных границах.",
      prompt: "Хочу разобраться в своих потребностях и границах в отношениях. Давай начнём с одной ситуации, которая меня волнует, без анализа личности другого человека." },
    { id: "direction", icon: "sprout", name: "Ценности и направление",
      question: "Чего я хочу на самом деле?",
      benefit: "Отдели собственные желания от ожиданий и найди следующий шаг.",
      prompt: "Хочу разобраться в своих ценностях и желаниях. Помоги отличить важное для меня от чужих ожиданий и выбрать один небольшой шаг." },
  ];

  function render({ host, icon, openSheet, openEvaHandoff }) {
    host.innerHTML = `<div class="discovery-stack">
      <article class="discovery-intro">
        <span class="eyebrow">ТВОЯ КАРТА СЕБЯ</span>
        <h2>За каждой реакцией —<br>что-то важное о тебе</h2>
        <p>Начни с темы, которая откликается. Вместе с Евой можно заметить свои особенности и выбрать, что развивать дальше.</p>
        <button class="primary-action" id="discovery-start" type="button">С чего начать?</button>
        <span class="discovery-note">Сейчас — разговор с Евой. Опросники появятся позже.</span>
      </article>
      <div class="discovery-heading"><h2>Что хочется понять?</h2><span>4 направления</span></div>
      <div class="discovery-topics">
        ${topics.map((topic) => `<button class="discovery-topic" data-discovery-topic="${topic.id}" type="button">
          <span class="discovery-icon" aria-hidden="true">${icon(topic.icon)}</span>
          <span class="discovery-topic-copy"><small>${topic.name}</small><strong>${topic.question}</strong></span>
          <span class="discovery-arrow" aria-hidden="true">›</span>
        </button>`).join("")}
      </div>
      <article class="discovery-coming">
        <span class="eyebrow">СЛЕДУЮЩИЙ ШАГ · СКОРО</span>
        <h3>Узнавать себя через опросники</h3>
        <p>Здесь появятся методики с понятным описанием, временем прохождения и разбором результатов. Пока они недоступны.</p>
      </article>
    </div>`;

    host.querySelector("#discovery-start").addEventListener("click", () => {
      openEvaHandoff("Хочу лучше узнать себя, но пока не знаю, с чего начать. Задай один вопрос о том, что сейчас для меня важно, и помоги выбрать тему для самопознания. Не проводи психологическое тестирование и не придумывай баллы.");
    });
    host.querySelectorAll("[data-discovery-topic]").forEach((button) => {
      button.addEventListener("click", () => {
        const topic = topics.find((item) => item.id === button.dataset.discoveryTopic);
        openSheet({
          title: topic.question,
          subtitle: topic.name,
          html: `<article class="section-card"><p>${topic.benefit}</p><p>Можно начать с разговора о своём опыте. Это саморефлексия, без тестовых баллов и оценок.</p></article>
            <div class="action-row"><button class="primary-action" id="discovery-discuss" type="button">Обсудить с Евой</button></div>`,
          onMount(sheetHost) {
            sheetHost.querySelector("#discovery-discuss").addEventListener("click", () => {
              openEvaHandoff(`${topic.prompt} Задавай по одному вопросу. Не проводи психологическое тестирование и не придумывай баллы.`);
            });
          },
        });
      });
    });
  }

  window.EvaDiscovery = { render };
})();
