(() => {
  "use strict";

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

  function create(tag, className, html = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html) node.innerHTML = html;
    return node;
  }

  function activateScreen(name) {
    qs(`.bottom-nav [data-target="${name}"]`)?.click();
  }

  function installHome() {
    const screen = qs('[data-screen="today"]');
    if (!screen || qs('.ios-home-head', screen)) return;

    qs('.utility-bar', screen)?.classList.add('ui-hidden');

    const head = create('header', 'ios-home-head', `
      <h1>Сегодня</h1>
      <button class="ios-profile-shortcut" type="button" aria-label="Открыть профиль">
        <span data-icon="user"></span>
      </button>
    `);
    screen.prepend(head);
    qs('.ios-profile-shortcut', head)?.addEventListener('click', () => activateScreen('profile'));

    const hero = qs('#main-focus-card', screen);
    const reward = qs('#reward-card', screen);
    const path = qs('#profile-investment', screen);

    qs('.hero-badge', hero)?.replaceChildren(document.createTextNode('Фокус на сегодня'));

    if (reward) {
      const title = create('h2', 'ios-section-title', 'О тебе сегодня');
      reward.before(title);
    }

    if (path) {
      const title = create('h2', 'ios-section-title', 'Твой путь');
      path.before(title);
    }

    const resumeTitle = create('h2', 'ios-section-title ios-resume-title', 'Можно продолжить');
    const resume = create('button', 'ios-resume-card', `
      <span class="ios-resume-icon" aria-hidden="true"><span data-icon="brain"></span></span>
      <span class="ios-resume-copy">
        <strong>Перейти к тестам</strong>
        <small>Продолжи самопознание, когда будет удобно.</small>
      </span>
      <span class="ios-chevron" aria-hidden="true">›</span>
    `);
    resume.type = 'button';
    resume.addEventListener('click', () => activateScreen('discovery'));
    screen.append(resumeTitle, resume);

    try { window.dispatchEvent(new CustomEvent('eva:ui-v12-ready')); } catch {}
  }

  function installDiscovery() {
    const screen = qs('[data-screen="discovery"]');
    if (!screen) return;
    const header = qs('.screen-header', screen);
    if (header) {
      qs('.screen-kicker', header)?.classList.add('ui-hidden');
      const title = qs('h1', header);
      if (title) title.textContent = 'Узнай себя';
      const lead = qs('p', header);
      if (lead) lead.textContent = 'Короткие тесты помогают Еве точнее понимать твои реакции и цели.';
    }
  }

  function installProfile() {
    const screen = qs('[data-screen="profile"]');
    if (!screen) return;
    const header = qs('.screen-header', screen);
    qs('.screen-kicker', header)?.classList.add('ui-hidden');
    qs('p', header)?.classList.add('ui-hidden');
  }

  function showJournalTab(name) {
    const notes = qs('#journal-content');
    const planHost = qs('#ios-journal-plan');
    const buttons = qsa('[data-ios-journal-tab]');
    buttons.forEach((button) => button.classList.toggle('is-active', button.dataset.iosJournalTab === name));
    if (notes) notes.hidden = name !== 'notes';
    if (planHost) planHost.hidden = name !== 'plan';
  }

  function installJournal() {
    const screen = qs('[data-screen="journal"]');
    if (!screen || qs('.ios-journal-tabs', screen)) return;

    const header = qs('.screen-header', screen);
    qs('.screen-kicker', header)?.classList.add('ui-hidden');
    qs('p', header)?.classList.add('ui-hidden');
    const oldAdd = qs('#journal-add-top');
    if (oldAdd) oldAdd.classList.add('ui-hidden');

    const tabs = create('div', 'ios-journal-tabs', `
      <button type="button" data-ios-journal-tab="notes">Записи</button>
      <button type="button" data-ios-journal-tab="plan" class="is-active">План</button>
    `);
    header.after(tabs);

    const planHost = create('div', 'ios-journal-plan');
    planHost.id = 'ios-journal-plan';
    const developmentContent = qs('#development-content');
    if (developmentContent) planHost.append(developmentContent);
    tabs.after(planHost);

    qsa('[data-ios-journal-tab]', tabs).forEach((button) => {
      button.addEventListener('click', () => showJournalTab(button.dataset.iosJournalTab));
    });
    showJournalTab('plan');

    const fab = create('button', 'ios-journal-fab', '+');
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Добавить');
    fab.addEventListener('click', () => {
      const planVisible = !planHost.hidden;
      if (!planVisible) {
        oldAdd?.click();
        return;
      }
      const addGoal = qs('#add-goal', planHost);
      if (addGoal) {
        addGoal.click();
        return;
      }
      oldAdd?.click();
    });
    screen.append(fab);
  }

  function installNavigation() {
    const development = qs('.bottom-nav [data-target="development"]');
    if (development) development.hidden = true;
    const discovery = qs('.bottom-nav [data-target="discovery"] b');
    if (discovery) discovery.textContent = 'Тесты';
    const today = qs('.bottom-nav [data-target="today"] b');
    if (today) today.textContent = 'Главная';
  }

  function install() {
    installNavigation();
    installHome();
    installDiscovery();
    installJournal();
    installProfile();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }

  const observer = new MutationObserver(() => {
    installNavigation();
    installDiscovery();
    installProfile();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });
})();
