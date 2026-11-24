/* 顶栏主题切换与日期：不参与知识点逻辑 */
(function () {
  'use strict';
  const root = document.documentElement;
  const btn = document.getElementById('themeToggle');
  const dateEl = document.getElementById('heroDate');
  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  function apply(theme, save) {
    root.dataset.theme = theme;
    if (save) {
      try { localStorage.setItem('hs.theme', theme); } catch (e) {}
    }
    if (btn) {
      btn.textContent = theme === 'dark' ? '日' : '夜';
      btn.setAttribute('aria-label', theme === 'dark' ? '切换到日间模式' : '切换到夜间模式');
      btn.title = btn.getAttribute('aria-label');
    }
  }

  let saved = null;
  try { saved = localStorage.getItem('hs.theme'); } catch (e) {}
  apply(saved || (mq.matches ? 'dark' : 'light'), false);

  if (btn) {
    btn.addEventListener('click', function () {
      apply(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
    });
  }

  if (!saved) {
    const onChange = function (e) { apply(e.matches ? 'dark' : 'light', false); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  const hero = document.querySelector('.hero');
  if (hero) {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    const syncHero = () => {
      let u = {};
      try { u = JSON.parse(localStorage.getItem('hs.user.v1') || '{}') || {}; } catch (e) {}
      const status = u.status && typeof u.status === 'object' ? u.status : {};
      const mastered = Object.values(status).filter(x => x && x.state === 'mastered').length;
      set('#heroMastered', mastered);
      set('#heroMistakes', Array.isArray(u.mistakes) ? u.mistakes.length : 0);
      const dueEl = document.getElementById('dueCount');
      set('#heroDue', dueEl ? (dueEl.textContent || '0').trim() : 0);
    };

    syncHero();
    window.setInterval(syncHero, 1500);
    window.addEventListener('storage', syncHero);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncHero(); });

    fetch('data/knowledge.json')
      .then(r => r.json())
      .then(arr => {
        if (Array.isArray(arr)) {
          set('#heroTotal', arr.length);
        }
      })
      .catch(() => {});
  }

  if (dateEl) {
    const d = new Date();
    const week = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][d.getDay()];
    dateEl.textContent =
      d.getFullYear() + '.' +
      String(d.getMonth() + 1).padStart(2, '0') + '.' +
      String(d.getDate()).padStart(2, '0') + ' · ' + week;
  }
})();
