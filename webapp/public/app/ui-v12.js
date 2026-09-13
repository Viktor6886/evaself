(function () {
  'use strict';

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return (root || document).querySelectorAll(selector);
  }

  function clickScreen(name) {
    var button = qs('.bottom-nav [data-target="' + name + '"]');
    if (button && typeof button.click === 'function') button.click();
  }

  function setJournalTab(name) {
    var notes = document.getElementById('journal-content');
    var plan = document.getElementById('ios-journal-plan');
    var buttons = qsa('[data-ios-journal-tab]');
    var i;
    for (i = 0; i < buttons.length; i += 1) {
      buttons[i].classList.toggle('is-active', buttons[i].getAttribute('data-ios-journal-tab') === name);
      buttons[i].setAttribute('aria-selected', buttons[i].getAttribute('data-ios-journal-tab') === name ? 'true' : 'false');
    }
    if (notes) notes.hidden = name !== 'notes';
    if (plan) plan.hidden = name !== 'plan';
  }

  function bindNavigationExtras() {
    var shortcuts = qsa('[data-ui-target]');
    var i;
    for (i = 0; i < shortcuts.length; i += 1) {
      if (shortcuts[i].getAttribute('data-ui-v13-bound') === '1') continue;
      shortcuts[i].setAttribute('data-ui-v13-bound', '1');
      shortcuts[i].addEventListener('click', function () {
        clickScreen(this.getAttribute('data-ui-target'));
      });
    }
  }

  function bindJournal() {
    var buttons = qsa('[data-ios-journal-tab]');
    var i;
    for (i = 0; i < buttons.length; i += 1) {
      if (buttons[i].getAttribute('data-ui-v13-bound') === '1') continue;
      buttons[i].setAttribute('data-ui-v13-bound', '1');
      buttons[i].addEventListener('click', function () {
        setJournalTab(this.getAttribute('data-ios-journal-tab'));
      });
    }

    var fab = document.getElementById('ios-journal-fab');
    if (fab && fab.getAttribute('data-ui-v13-bound') !== '1') {
      fab.setAttribute('data-ui-v13-bound', '1');
      fab.addEventListener('click', function () {
        var plan = document.getElementById('ios-journal-plan');
        var addGoal = plan ? qs('#add-goal', plan) : null;
        var addNote = document.getElementById('journal-add-top');
        if (plan && !plan.hidden && addGoal && typeof addGoal.click === 'function') {
          addGoal.click();
        } else if (addNote && typeof addNote.click === 'function') {
          addNote.click();
        }
      });
    }
    setJournalTab('plan');
  }

  function bindRewardCard() {
    var card = document.getElementById('reward-card');
    var action = document.getElementById('reward-action');
    if (!card || !action || card.getAttribute('data-ui-v13-bound') === '1') return;
    card.setAttribute('data-ui-v13-bound', '1');
    card.addEventListener('click', function (event) {
      if (event.target === action || action.contains(event.target)) return;
      if (typeof action.click === 'function') action.click();
    });
  }

  function iconSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3"></circle><path d="M6 20c.7-4 2.7-6 6-6s5.3 2 6 6"></path></svg>';
  }

  function createProfileRow(title, clickHandler) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-row ios-personal-row';
    button.innerHTML = '<span class="ios-row-icon">' + iconSvg() + '</span><span><strong>' + title + '</strong></span><em></em>';
    button.addEventListener('click', clickHandler);
    return button;
  }

  function makeProfileGroup(label, nodes) {
    var section = document.createElement('section');
    section.className = 'ios-profile-group';
    var heading = document.createElement('div');
    heading.className = 'ios-profile-label';
    heading.textContent = label;
    var list = document.createElement('div');
    list.className = 'ios-settings-group';
    var i;
    section.appendChild(heading);
    section.appendChild(list);
    for (i = 0; i < nodes.length; i += 1) {
      if (nodes[i]) list.appendChild(nodes[i]);
    }
    return section;
  }

  function decorateProfile() {
    var host = document.getElementById('profile-content');
    if (!host) return;
    var stack = qs('.profile-stack', host);
    var list = qs('.settings-list', host);
    if (!stack || !list || list.getAttribute('data-ui-v13-grouped') === '1') return;

    var personal = createProfileRow('Личные данные', function () {
      var current = document.getElementById('edit-profile');
      if (current && typeof current.click === 'function') current.click();
    });

    var rows = {};
    var settingRows = qsa('[data-setting]', list);
    var i;
    for (i = 0; i < settingRows.length; i += 1) {
      rows[settingRows[i].getAttribute('data-setting')] = settingRows[i];
    }

    var knownCard = qs('.profile-stack > .section-card', host);
    if (knownCard) knownCard.classList.add('ui-hidden');
    list.setAttribute('data-ui-v13-grouped', '1');
    list.className = 'ios-profile-groups';
    while (list.firstChild) list.removeChild(list.firstChild);
    list.appendChild(makeProfileGroup('Ева и данные', [personal, rows.conversations, rows.voice]));
    list.appendChild(makeProfileGroup('Приложение', [rows.notifications, rows.initiative, rows.privacy]));
    list.appendChild(makeProfileGroup('Подписка', [rows.subscription]));
  }

  function bindProfileObserver() {
    var host = document.getElementById('profile-content');
    if (!host) return;
    decorateProfile();
    if (host.getAttribute('data-ui-v13-observed') === '1') return;
    host.setAttribute('data-ui-v13-observed', '1');
    if (window.MutationObserver) {
      var observer = new MutationObserver(function () { decorateProfile(); });
      observer.observe(host, { childList: true });
    }
  }

  function install() {
    bindNavigationExtras();
    bindJournal();
    bindRewardCard();
    bindProfileObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, false);
  } else {
    install();
  }
})();
