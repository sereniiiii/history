/* ============================================================
   app.js —— 单页应用主逻辑
   静态数据：data/books.json、knowledge.json、aliases.json、pinyin.json
   用户数据：localStorage（见 store.js），不与静态数据混写
   ============================================================ */

import {
  loadUser, saveUser, takeSnapshot, listSnapshots, restoreSnapshot,
  exportPayload, validateImport, mergeUser, overwriteUser,
  download, stamp, mistakesToCSV, knowledgeToMD, emptyUser,
} from './store.js';

/* ---------------- 基础工具 ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const ITEM_H = 104;
const CARD_H = 96;
const TODAY = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtTime = ts => {
  if (!ts) return '从未';
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function hl(text, q) {
  const s = String(text ?? '');
  if (!q || !q.trim()) return esc(s);
  const terms = q.trim().split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
  let out = '', i = 0;
  while (i < s.length) {
    let best = -1, bt = '';
    for (const t of terms) {
      const idx = s.toLowerCase().indexOf(t.toLowerCase(), i);
      if (idx >= 0 && (best < 0 || idx < best)) { best = idx; bt = t; }
    }
    if (best < 0) { out += esc(s.slice(i)); break; }
    out += esc(s.slice(i, best)) + '<mark>' + esc(s.slice(best, best + bt.length)) + '</mark>';
    i = best + bt.length;
  }
  return out;
}

/* ---------------- 运行状态 ---------------- */
const S = {
  points: [], customs: [], all: [],
  books: [], book: null,
  units: new Map(), lessons: new Map(), counts: new Map(),
  user: loadUser(),
  view: 'browse',
  scope: { type: 'all', code: null },
  query: '',
  searchItems: [],
  searchNearest: [],
  searchMs: 0,
  list: [],
  selected: null,
  perfMode: false,
  synthetic: [],
  expanded: { vols: {}, units: {} },
  worker: null,
  workerReady: false,
  lastBackup: null,
  initMs: 0,
};

/* ---------------- 数据加载 ---------------- */
async function boot() {
  const t0 = performance.now();
  const [booksRes, knRes, aliasRes, pyRes] = await Promise.all([
    fetch('data/books.json').then(r => r.json()),
    fetch('data/knowledge.json').then(r => r.json()),
    fetch('data/aliases.json').then(r => r.json()),
    fetch('data/pinyin.json').then(r => r.json()),
  ]);

  S.books = booksRes.books || [];
  S.book = S.books[0] || null;
  S.points = knRes || [];
  S.customs = [];

  // 章节索引
  for (const v of (S.book?.volumes || [])) {
    for (const p of v.parts) {
      for (const u of p.units) {
        S.units.set(u.code, u);
        for (const l of u.lessons) S.lessons.set(l.code, { ...l, unit: u.code, unitTitle: u.title });
      }
    }
  }
  rebuildAll();

  // 用户数据
  S.user = loadUser();
  S.customs = S.user.customs || [];
  S.expanded.vols = {};
  for (const v of (S.book?.volumes || [])) S.expanded.vols[v.code] = true;

  setupWorker(aliasRes.groups || [], pyRes);
  renderTree();
  renderHome();
  renderList();
  bindEvents();
  renderDetail();
  S.initMs = +(performance.now() - t0).toFixed(1);

  // 恢复上次选中
  const last = S.user.config?.lastSel;
  if (last && itemById(last)) select(last, false);

  if (new URLSearchParams(location.search).get('selftest') === '1') runSelfTest();
  if (new URLSearchParams(location.search).get('perf') === '1000') enablePerfMode();
}

function rebuildAll() {
  const customs = (S.user?.customs || S.customs || []).map(c => ({
    ...c, kind: 'custom', book: 'MY', page: null, pdfPage: null,
    lessonTitle: S.units.get(c.unit)?.title || '',
  }));
  S.customs = customs;
  S.all = [...S.points.map(p => ({
    ...p, kind: 'point',
    lessonTitle: S.lessons.get(p.lesson)?.title || '',
  })), ...customs].map(p => {
    const u = S.units.get(p.unit);
    return { ...p, unitTitle: u ? u.title : '' };
  });
  // 计数
  S.counts.clear();
  for (const p of S.all) {
    if (p.lesson) S.counts.set(p.lesson, (S.counts.get(p.lesson) || 0) + 1);
    if (p.unit) S.counts.set(p.unit, (S.counts.get(p.unit) || 0) + 1);
  }
}

function itemById(id) {
  return S.all.find(p => p.id === id) || null;
}

/* ---------------- 检索 Worker ---------------- */
function setupWorker(aliasGroups, pinyin) {
  S.aliasGroups = aliasGroups; S.pinyin = pinyin;
  try {
    S.worker = new Worker(new URL('./search-worker.js', import.meta.url));
    S.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { S.workerReady = true; return; }
      if (m.type === 'results') {
        S.searchMs = m.ms;
        S.searchItems = m.items.map(it => {
          const p = itemById(it.id);
          return p ? { ...p, _score: it.score, _field: it.field, kind: 'point' } : null;
        }).filter(Boolean);
        // 笔记与错题（本地小数据，直接扫）
        appendUserMatches(m.q);
        S.searchNearest = (m.nearest || []).map(n => itemById(n.id)).filter(Boolean);
        if (S.view === 'search') renderList();
      }
    };
    const slim = S.all.filter(p => p.kind === 'point').map(p => ({
      id: p.id, title: p.title, content: p.content, excerpt: p.excerpt,
      keywords: p.keywords, lessonTitle: p.lessonTitle,
    }));
    S.worker.postMessage({ type: 'init', points: slim, aliasGroups, pinyin });
  } catch (e) {
    console.warn('Worker 不可用，回退主线程', e);
    S.worker = null;
  }
}

function appendUserMatches(q) {
  const nq = q.toLowerCase();
  // 自定义知识点
  for (const c of S.customs) {
    const hay = `${c.title} ${c.content} ${(c.keywords || []).join('')}`.toLowerCase();
    if (hay.includes(nq) && !S.searchItems.some(x => x.id === c.id)) {
      S.searchItems.push({ ...c, kind: 'custom', _score: 45 });
    }
  }
  const notes = Object.entries(S.user.notes || {});
  for (const [kid, n] of notes) {
    if (!n?.text || !n.text.toLowerCase().includes(nq)) continue;
    const p = itemById(kid);
    if (p && !S.searchItems.some(x => x.id === kid)) {
      S.searchItems.push({ ...p, kind: p.kind || 'point', _noteHit: true, _score: 25 });
    } else if (p && S.searchItems.some(x => x.id === kid)) {
      const hit = S.searchItems.find(x => x.id === kid);
      hit._noteHit = true;
    }
  }
  for (const m of (S.user.mistakes || [])) {
    const hay = `${m.stem} ${m.myAnswer} ${m.correctAnswer}`.toLowerCase();
    if (!hay.includes(nq)) continue;
    S.searchItems.push({
      kind: 'mistake', id: m.id, mistake: m,
      title: m.stem || '未命名错题',
      content: `错因：${m.reason || '未分类'}｜错误 ${m.count || 1} 次｜下次 ${m.nextReview || '—'}`,
      source: '错题本', _score: 20,
    });
  }
  S.searchItems.sort((a, b) => (b._score || 0) - (a._score || 0));
}

function doSearch(q) {
  S.query = q.trim();
  if (!S.query) {
    S.view = 'browse';
    S.searchItems = [];
    renderList();
    updateScopeUI();
    return;
  }
  S.view = 'search';
  if (S.workerReady && S.worker) {
    S.worker.postMessage({ type: 'search', q: S.query });
  } else {
    // 兜底：主线程简单匹配
    const nq = q.toLowerCase();
    S.searchItems = S.all.filter(p =>
      (p.title + p.content + p.excerpt + (p.keywords || []).join('')).toLowerCase().includes(nq)
    ).map(p => ({ ...p, kind: 'point', _score: 1 }));
    appendUserMatches(S.query);
    S.searchNearest = [];
    renderList();
  }
}

/* ---------------- 列表数据 ---------------- */
function dueMistakes() {
  const t = TODAY();
  return (S.user.mistakes || []).filter(m => m.nextReview && m.nextReview <= t);
}

function statusOf(id) {
  return S.user.status?.[id]?.state || 'none';
}

function inScope(p) {
  if (S.scope.type === 'all') return true;
  if (S.scope.type === 'unit') return p.unit === S.scope.code;
  if (S.scope.type === 'lesson') return p.lesson === S.scope.code;
  return true;
}

function passFilter(p) {
  const f = S.filters();
  if (f.type !== 'all' && p.type !== f.type) return false;
  const diff = Number(f.diff);
  if (diff && p.difficulty !== diff) return false;
  if (f.status !== 'all') {
    const st = statusOf(p.id);
    if (f.status === 'none' && st !== 'none') return false;
    if (f.status === 'mastered' && st !== 'mastered') return false;
    if (f.status === 'review' && st !== 'review') return false;
  }
  return true;
}

S.filters = () => ({
  type: $('#filterType')?.value || 'all',
  diff: $('#filterDiff')?.value || '0',
  status: $('#filterStatus')?.value || 'all',
});

function currentItems() {
  if (S.perfMode) return S.synthetic;
  if (S.view === 'search') return S.searchItems;
  if (S.view === 'due') {
    return dueMistakes().map(m => ({
      kind: 'mistake', id: m.id, mistake: m, title: m.stem,
      content: `错因：${m.reason || '未分类'}｜错误 ${m.count || 1} 次`,
      source: '错题本', nextReview: m.nextReview,
    }));
  }
  if (S.view === 'mistakes') {
    return (S.user.mistakes || []).slice().sort((a, b) => (a.nextReview || '').localeCompare(b.nextReview || ''))
      .map(m => ({
        kind: 'mistake', id: m.id, mistake: m, title: m.stem,
        content: `错因：${m.reason || '未分类'}｜错误 ${m.count || 1} 次｜下次 ${m.nextReview || '—'}`,
        source: '错题本', nextReview: m.nextReview,
      }));
  }
  // browse
  let arr = S.all.filter(p => inScope(p) && passFilter(p));
  const sort = $('#sortSelect')?.value || 'chapter';
  if (sort === 'difficulty') arr = arr.slice().sort((a, b) => (b.difficulty || 0) - (a.difficulty || 0));
  else if (sort === 'status') {
    const rank = { review: 0, none: 1, mastered: 2 };
    arr = arr.slice().sort((a, b) => (rank[statusOf(a.id)] ?? 1) - (rank[statusOf(b.id)] ?? 1));
  }
  return arr;
}

/* ---------------- 列表渲染（虚拟滚动） ---------------- */
let lastStart = -1, lastEnd = -1, scrollRaf = 0;

function renderList() {
  const items = currentItems();
  S.list = items;
  const canvas = $('#listCanvas');
  const viewport = $('#listViewport');
  $('#resultCount').textContent = items.length;
  const showEmpty = items.length === 0;
  $('#emptyState').hidden = !showEmpty;
  $('#nearestList').innerHTML = '';

  if (showEmpty) {
    const h = $('#emptyState h3');
    const p = $('#emptyState p');
    if (S.view === 'search') {
      h.textContent = '没有匹配的结果';
      p.textContent = '试试更短的关键词、拼音首字母，或清除筛选。';
      renderNearest();
    } else if (S.view === 'mistakes' || S.view === 'due') {
      h.textContent = S.view === 'due' ? '今天没有到期的错题' : '错题本还是空的';
      p.textContent = '录入错题后，会按 1 / 3 / 7 / 15 / 30 天自动排期。';
      $('#nearestList').innerHTML = '<div class="empty-actions"><button class="btn primary" id="emptyAddMistake">＋ 录入第一道错题</button></div>';
      $('#emptyAddMistake').onclick = () => openMistakeForm(null);
    } else {
      h.textContent = '这个范围还没有知识点';
      p.textContent = '本书目前只抽了第一单元（第 1–3 课）作为试点，其余章节待全量抽取。';
    }
    canvas.style.height = '0px';
    canvas.innerHTML = '';
    updateScopeUI();
    return;
  }
  canvas.style.height = `${items.length * ITEM_H}px`;
  lastStart = lastEnd = -1;
  viewport.scrollTop = 0;
  paintWindow(true);
  updateScopeUI();
}

function renderNearest() {
  const box = $('#nearestList');
  const list = S.searchNearest.length ? S.searchNearest : S.all.slice(0, 5);
  if (!list.length) return;
  box.innerHTML = `<h4 class="nearest-title">最相近的 ${list.length} 条</h4>` +
    list.map(p => `<button class="nearest-item" data-id="${esc(p.id)}">
      <span>${esc(p.title)}</span><span class="muted small">${esc(p.source)}</span>
    </button>`).join('');
  box.querySelectorAll('button').forEach(b => b.onclick = () => select(b.dataset.id));
}

function paintWindow(force = false) {
  const viewport = $('#listViewport');
  const items = S.list;
  if (!items.length) return;
  const st = viewport.scrollTop;
  const vh = viewport.clientHeight || 600;
  const start = Math.max(0, Math.floor(st / ITEM_H) - 10);
  const end = Math.min(items.length, Math.ceil((st + vh) / ITEM_H) + 10);
  if (!force && start === lastStart && end === lastEnd) return;
  lastStart = start; lastEnd = end;

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const it = items[i];
    const stt = statusOf(it.id);
    const card = document.createElement('div');
    card.className = `k-card ${S.selected === it.id ? 'selected' : ''} ${stt !== 'none' ? stt : ''}`;
    card.style.transform = `translate3d(0,${i * ITEM_H}px,0)`;
    card.dataset.id = it.id;
    card.dataset.index = i;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    let badge = '';
    if (it.kind === 'custom') badge = '<span class="badge custom">我创建</span>';
    else if (it.kind === 'mistake') badge = '<span class="badge bad">错题</span>';
    else badge = `<span class="badge type">${esc(it.type || '')}</span>`;
    const statusBadge = stt === 'mastered' ? '<span class="badge ok">已掌握</span>'
      : stt === 'review' ? '<span class="badge warn">待复习</span>' : '';
    const dueBadge = it.kind === 'mistake' && it.nextReview && it.nextReview <= TODAY()
      ? '<span class="badge due">今日到期</span>' : '';
    const noteBadge = it._noteHit ? '<span class="badge">有笔记</span>' : '';
    const diff = it.difficulty ? '★'.repeat(it.difficulty) : '';
    const meta = it.kind === 'mistake'
      ? esc(it.content)
      : `${esc(it.unitTitle || '')} · ${esc(it.lessonTitle || '')}`;

    card.innerHTML = `
      <div class="ct">${hl(it.title, S.view === 'search' ? S.query : '')}</div>
      <div class="cc">${hl(it.content || '', S.view === 'search' ? S.query : '')}</div>
      <div class="cm">
        <span class="badge book">${it.kind === 'custom' ? '自定义' : '清单'}</span>
        ${badge}${statusBadge}${dueBadge}${noteBadge}
        <span class="src">${meta}</span>
        <span>${esc(diff)}</span>
      </div>`;
    frag.appendChild(card);
  }
  const canvas = $('#listCanvas');
  canvas.innerHTML = '';
  canvas.appendChild(frag);
}

function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    paintWindow();
  });
}

/* ---------------- 章节树 ---------------- */
function renderTree() {
  const tree = $('#tree');
  if (!S.book) { tree.innerHTML = '<p class="muted small">没有书籍数据</p>'; return; }
  let html = '';
  for (const v of S.book.volumes) {
    const open = S.expanded.vols[v.code] !== false;
    html += `<div class="tree-vol">
      <button class="tree-toggle" data-vol="${esc(v.code)}" aria-expanded="${open}">
        <span class="caret">▾</span><span class="tree-vol-title">${esc(v.title)}</span>
      </button>
      <div class="vol-body" ${open ? '' : 'hidden'}>`;
    for (const part of v.parts) {
      html += `<div class="tree-part">${esc(part.title)}</div>`;
      for (const t of (part.topics || [])) {
        html += `<div class="tree-topic" data-topic="1" data-page="${t.page}" title="书页 ${t.page}">${esc(t.title)}</div>`;
      }
      for (const u of part.units) {
        const cnt = S.counts.get(u.code) || 0;
        const uOpen = !!S.expanded.units[u.code];
        html += `<div class="tree-unit ${S.scope.code === u.code ? 'active' : ''}" data-unit="${esc(u.code)}">
          <span class="caret" style="width:12px;color:#9aa3b2">${uOpen ? '▾' : '▸'}</span>
          <span>${esc(u.title.replace(/^第.单元\s*/, ''))}</span>
          <span class="cnt">${cnt || ''}</span>
        </div>
        <div class="unit-lessons" ${uOpen ? '' : 'hidden'}>`;
        for (const l of u.lessons) {
          const c = S.counts.get(l.code) || 0;
          html += `<div class="tree-lesson ${S.scope.code === l.code ? 'active' : ''}" data-lesson="${esc(l.code)}" title="书页 ${l.page}">
            <span class="dot"></span><span class="num">${l.no}</span>
            <span>${esc(l.title)}</span>
            ${c ? `<span class="cnt">${c}</span>` : ''}
          </div>`;
        }
        html += `</div>`;
      }
    }
    html += `</div></div>`;
  }
  tree.innerHTML = html;

  tree.querySelectorAll('.tree-toggle').forEach(b => {
    b.onclick = () => {
      const code = b.dataset.vol;
      S.expanded.vols[code] = S.expanded.vols[code] === false;
      renderTree();
    };
  });
  tree.querySelectorAll('.tree-unit').forEach(el => {
    el.onclick = () => {
      const code = el.dataset.unit;
      S.expanded.units[code] = !S.expanded.units[code];
      S.scope = S.expanded.units[code] ? { type: 'unit', code } : { type: 'all', code: null };
      S.view = 'browse';
      renderTree(); renderList();
      onMobileTab('list');
    };
  });
  tree.querySelectorAll('.tree-lesson').forEach(el => {
    el.onclick = () => {
      S.scope = { type: 'lesson', code: el.dataset.lesson };
      S.view = 'browse';
      renderTree(); renderList();
      onMobileTab('list');
    };
  });
  tree.querySelectorAll('.tree-topic').forEach(el => {
    el.onclick = () => showToast(`「${el.textContent}」在书页 ${el.dataset.page}，可从右侧详情跳转书源`);
  });
  updateTreeDots();
}

function updateTreeDots() {
  $$('.tree-lesson').forEach(el => {
    const st = statusOf(el.dataset.lesson);
    // 课程点：聚合本课所有点的状态
    const pts = S.all.filter(p => p.lesson === el.dataset.lesson);
    const hasReview = pts.some(p => statusOf(p.id) === 'review');
    const allMastered = pts.length && pts.every(p => statusOf(p.id) === 'mastered');
    const dot = el.querySelector('.dot');
    dot.className = 'dot' + (allMastered ? ' mastered' : hasReview ? ' review' : '');
  });
}

/* ---------------- 顶部与范围 ---------------- */
function updateScopeUI() {
  const label = $('#scopeLabel');
  if (S.view === 'search') label.textContent = `搜索「${S.query}」`;
  else if (S.view === 'mistakes') label.textContent = '错题本';
  else if (S.view === 'due') label.textContent = '今日待复习';
  else if (S.perfMode) label.textContent = '性能测试（1000 条）';
  else if (S.scope.type === 'lesson') label.textContent = S.lessons.get(S.scope.code)?.title || '本课';
  else if (S.scope.type === 'unit') label.textContent = S.units.get(S.scope.code)?.title || '本单元';
  else label.textContent = '全部知识点';

  const sub = $('#scopeSub');
  if (S.view === 'search') sub.textContent = `${S.searchMs} ms`;
  else if (S.view === 'mistakes') sub.textContent = `${(S.user.mistakes || []).length} 道`;
  else if (S.view === 'due') sub.textContent = `${dueMistakes().length} 道今天到期`;
  else if (S.scope.type === 'lesson') {
    const l = S.lessons.get(S.scope.code);
    sub.textContent = l ? `书页 ${l.page} · PDF ${l.pdfPage}` : '';
  } else if (S.scope.type === 'unit') {
    const u = S.units.get(S.scope.code);
    sub.textContent = u ? `书页 ${u.page} 起` : '';
  } else {
    sub.textContent = S.perfMode ? '合成数据，仅用于帧率测试' : `${S.all.length} 条 · ${S.units.size} 单元 · ${S.lessons.size} 课`;
  }
  $('#viewToggle').hidden = !(S.view === 'search' || S.view === 'mistakes' || S.view === 'due');
  $('#addMistakeBtn').hidden = !(S.view === 'mistakes' || S.view === 'due');
}

function renderHome() {
  const u = S.user;
  const last = u.config?.lastBackup || null;
  S.lastBackup = last;
  $('#backupInfo').textContent = `上次备份：${fmtTime(last)}`;
  const days = last ? (Date.now() - last) / 86400000 : Infinity;
  $('#backupWarn').hidden = days <= 7;
  $('#backupInfo').classList.toggle('warn-line', days > 7);
  $('#dueCount').textContent = dueMistakes().length;
  $('#dueCount').className = 'count ' + (dueMistakes().length ? 'bad' : '');
  $('#mistakeCount').textContent = (u.mistakes || []).length;
}

/* ---------------- 详情 ---------------- */
function select(id, openSheet = true) {
  S.selected = id;
  S.user.config.lastSel = id;
  saveUser(S.user);
  const it = itemById(id) || S.list.find(x => x.id === id && x.kind === 'mistake');
  if (it?.kind === 'mistake' || (S.list.find(x => x.id === id)?.kind === 'mistake')) {
    const m = it?.mistake || S.list.find(x => x.id === id)?.mistake;
    if (m) renderMistakeDetail(m);
    paintWindow(true);
    if (openSheet) onMobileTab('detail');
    return;
  }
  renderDetail();
  paintWindow(true);
  if (openSheet) onMobileTab('detail');
}

function renderDetail() {
  const box = $('#detailBody');
  const empty = $('#detailEmpty');
  const p = itemById(S.selected);
  if (!p) { box.hidden = true; empty.hidden = false; return; }
  empty.hidden = true; box.hidden = false;
  const st = statusOf(p.id);
  const note = S.user.notes?.[p.id]?.text || '';
  const isCustom = p.kind === 'custom';
  const canPdf = p.pdfPage && !isCustom;

  box.innerHTML = `
    <h1 class="detail-title">${esc(p.title)}</h1>
    <div class="detail-badges">
      <span class="badge book">${esc(p.kind === 'custom' ? '我创建' : '知识清单')}</span>
      <span class="badge type">${esc(p.type || '')}</span>
      <span class="badge">难度 ${esc('★'.repeat(p.difficulty || 0))}</span>
      ${st === 'mastered' ? '<span class="badge ok">已掌握</span>' : st === 'review' ? '<span class="badge warn">待复习</span>' : '<span class="badge">未标记</span>'}
    </div>

    <section class="detail-section">
      <h3>要点</h3>
      <div class="detail-content">${esc(p.content || '')}</div>
    </section>

    ${p.excerpt ? `<section class="detail-section">
      <h3>原文摘录（一字未改）</h3>
      <div class="quote">${esc(p.excerpt)}
        <span class="quote-src">—— ${esc(p.source)}</span>
      </div>
    </section>` : ''}

    <section class="detail-section">
      <h3>关键词</h3>
      <div class="kw-row">${(p.keywords || []).map(k => `<span class="kw">${esc(k)}</span>`).join('') || '<span class="muted small">无</span>'}</div>
    </section>

    ${p.commonq ? `<section class="detail-section">
      <h3>可能考法</h3>
      <div class="commonq">${esc(p.commonq)}</div>
    </section>` : ''}

    <section class="detail-section">
      <h3>我的笔记</h3>
      <div class="note-box">
        <textarea id="noteInput" placeholder="写下你的理解、易错点、联想法…">${esc(note)}</textarea>
        <div class="note-actions">
          <span class="hint" id="noteState">${note ? '已保存' : '自动保存到本机'}</span>
          <button class="link-btn" id="noteClear">清空笔记</button>
        </div>
      </div>
    </section>

    <div class="detail-source">
      <span>${esc(p.source || '我创建')}</span>
      ${canPdf ? `<button class="btn small" id="openPdf">跳转书源 p${p.pdfPage}</button>` : ''}
    </div>

    <div class="detail-actions">
      <button class="btn ${st === 'mastered' ? 'primary' : ''}" data-mark="mastered">已掌握</button>
      <button class="btn ${st === 'review' ? 'primary' : ''}" data-mark="review">待复习</button>
      <button class="btn" data-mark="none">清除标记</button>
      ${isCustom ? '<button class="btn" id="editCustom">编辑</button><button class="btn danger" id="delCustom">删除</button>' : ''}
      <button class="btn ghost" id="copyPoint">复制</button>
    </div>
  `;

  // 笔记自动保存（500ms 防抖）
  const ta = $('#noteInput');
  let timer = 0;
  ta?.addEventListener('input', () => {
    $('#noteState').textContent = '输入中…';
    clearTimeout(timer);
    timer = setTimeout(() => {
      const txt = ta.value.trim();
      const id = p.id;
      if (txt) S.user.notes[id] = { text: txt, updatedAt: Date.now() };
      else delete S.user.notes[id];
      saveUser(S.user);
      $('#noteState').textContent = txt ? '已保存' : '已清空';
      const card = S.list.find(x => x.id === id);
      if (card) card._noteHit = !!txt;
    }, 500);
  });
  $('#noteClear')?.addEventListener('click', () => {
    if (!ta.value) return;
    ta.value = '';
    delete S.user.notes[p.id];
    saveUser(S.user);
    $('#noteState').textContent = '已清空';
    toast('笔记已清空');
  });

  box.querySelectorAll('[data-mark]').forEach(b => {
    b.onclick = () => setStatus(p.id, b.dataset.mark === 'none' ? null : b.dataset.mark);
  });
  $('#openPdf')?.addEventListener('click', () => openPdf(p));
  $('#editCustom')?.addEventListener('click', () => openPointForm(p));
  $('#delCustom')?.addEventListener('click', () => {
    if (!confirm(`删除自定义知识点「${p.title}」？`)) return;
    takeSnapshot(S.user, '删除自定义知识点');
    S.user.customs = S.user.customs.filter(c => c.id !== p.id);
    delete S.user.notes[p.id];
    delete S.user.status[p.id];
    saveUser(S.user);
    rebuildAll(); S.selected = null;
    renderTree(); renderList(); renderDetail(); renderHome();
    toast('已删除');
  });
  $('#copyPoint')?.addEventListener('click', async () => {
    const txt = `${p.title}\n${p.content}\n${p.excerpt ? '原文：' + p.excerpt + '\n' : ''}${p.source}`;
    try { await navigator.clipboard.writeText(txt); toast('已复制'); }
    catch { toast('复制失败，请手动选择'); }
  });
}

function renderMistakeDetail(m) {
  const box = $('#detailBody'), empty = $('#detailEmpty');
  empty.hidden = true; box.hidden = false;
  const linked = itemById(m.kid);
  const due = m.nextReview && m.nextReview <= TODAY();
  box.innerHTML = `
    <h1 class="detail-title">${esc(m.stem || '错题')}</h1>
    <div class="detail-badges">
      <span class="badge bad">错题</span>
      <span class="badge">${esc(m.reason || '未分类')}</span>
      <span class="badge">错误 ${esc(m.count || 1)} 次</span>
      ${due ? '<span class="badge due">今日到期</span>' : ''}
    </div>

    <section class="detail-section">
      <h3>我的答案</h3>
      <div class="detail-content">${esc(m.myAnswer || '（未填写）')}</div>
    </section>
    <section class="detail-section">
      <h3>正确答案</h3>
      <div class="detail-content">${esc(m.correctAnswer || '（未填写）')}</div>
    </section>
    <section class="detail-section">
      <h3>复习排期</h3>
      <div class="detail-content">上次复习：${esc(m.lastReview || '—')}　下次复习：${esc(m.nextReview || '—')}　当前阶段：${esc((m.stage || 0) + 1)}/5</div>
    </section>
    ${linked ? `<section class="detail-section"><h3>关联知识点</h3>
      <div class="quote" style="border-left-color:var(--primary)">
        <button class="link-btn" id="jumpLinked">${esc(linked.title)}</button>
        <span class="quote-src">${esc(linked.source)}</span>
      </div></section>` : ''}

    <div class="detail-actions">
      <button class="btn primary" id="reviewOk">答对了，推进排期</button>
      <button class="btn" id="reviewBad">又错了，重置到 1 天</button>
      <button class="btn" id="editMistake">编辑</button>
      <button class="btn danger" id="delMistake">删除</button>
    </div>
  `;
  $('#reviewOk').onclick = () => reviewMistake(m, true);
  $('#reviewBad').onclick = () => reviewMistake(m, false);
  $('#editMistake').onclick = () => openMistakeForm(m);
  $('#delMistake').onclick = () => {
    if (!confirm('删除这道错题？')) return;
    takeSnapshot(S.user, '删除错题');
    S.user.mistakes = S.user.mistakes.filter(x => x.id !== m.id);
    saveUser(S.user);
    S.selected = null;
    renderList(); renderDetail(); renderHome();
    toast('已删除');
  };
  $('#jumpLinked')?.addEventListener('click', () => select(linked.id));
}

function setStatus(id, state) {
  if (state) S.user.status[id] = { state, updatedAt: Date.now() };
  else delete S.user.status[id];
  saveUser(S.user);
  renderDetail(); paintWindow(true); updateTreeDots();
  toast(state === 'mastered' ? '已标记为已掌握' : state === 'review' ? '已标记为待复习' : '已清除标记');
}

/* ---------------- 错题排期 ---------------- */
const INTERVALS = [1, 3, 7, 15, 30];

function reviewMistake(m, correct) {
  const t = TODAY();
  if (correct) {
    m.stage = Math.min(INTERVALS.length - 1, (m.stage || 0) + 1);
    m.nextReview = addDays(INTERVALS[m.stage]);
  } else {
    m.stage = 0;
    m.count = (m.count || 1) + 1;
    m.nextReview = addDays(1);
  }
  m.lastReview = t;
  m.updatedAt = Date.now();
  saveUser(S.user);
  renderMistakeDetail(m); renderList(); renderHome();
  toast(correct ? `答对，下次 ${m.nextReview} 复习` : `已重置，明天再复习（累计错 ${m.count} 次）`);
}

/* ---------------- 表单：自定义知识点 ---------------- */
function unitOptions(selected) {
  let out = '<option value="">不关联章节</option>';
  for (const [code, u] of S.units) {
    out += `<option value="${esc(code)}" ${selected === code ? 'selected' : ''}>${esc(u.title)}</option>`;
  }
  return out;
}

function openPointForm(existing) {
  const isEdit = !!existing;
  const body = `
    <div class="form-grid">
      <label class="form-field full"><span>标题（≤20 字，陈述句）</span>
        <input id="pfTitle" maxlength="20" value="${esc(existing?.title || '')}" placeholder="例：秦朝推行郡县制">
        <span class="counter" id="cTitle">0/20</span>
      </label>
      <label class="form-field full"><span>内容（≤120 字）</span>
        <textarea id="pfContent" maxlength="120" placeholder="用自己的话写成一个可独立提问的命题">${esc(existing?.content || '')}</textarea>
        <span class="counter" id="cContent">0/120</span>
      </label>
      <label class="form-field"><span>标签（逗号分隔，3–6 个）</span>
        <input id="pfKeywords" value="${esc((existing?.keywords || []).join('，'))}" placeholder="郡县制，中央集权">
      </label>
      <label class="form-field"><span>关联章节</span>
        <select id="pfUnit">${unitOptions(existing?.unit || S.scope.code || '')}</select>
      </label>
      <label class="form-field"><span>类型</span>
        <select id="pfType">${['概念','机制','结论','对比','政策工具'].map(t =>
          `<option ${existing?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </label>
      <label class="form-field"><span>难度</span>
        <select id="pfDiff">${[1,2,3].map(d =>
          `<option value="${d}" ${existing?.difficulty === d ? 'selected' : ''}>${'★'.repeat(d)}</option>`).join('')}</select>
      </label>
      <label class="form-field full"><span>可能考法（一句话）</span>
        <input id="pfQ" value="${esc(existing?.commonq || '')}" placeholder="例：材料题常考郡县制与分封制的区别">
      </label>
      <div class="full info-note">来源会标记为「我创建」，与书内知识点区分；可随时编辑或删除。</div>
    </div>`;
  const modal = openModal(isEdit ? '编辑自定义知识点' : '新建自定义知识点', body,
    `<button class="btn" data-close>取消</button><button class="btn primary" id="pfSave">保存</button>`);

  const title = $('#pfTitle'), content = $('#pfContent');
  const upd = () => {
    $('#cTitle').textContent = `${title.value.length}/20`;
    $('#cContent').textContent = `${content.value.length}/120`;
    $('#cTitle').classList.toggle('over', title.value.length > 20);
    $('#cContent').classList.toggle('over', content.value.length > 120);
  };
  title.addEventListener('input', upd); content.addEventListener('input', upd); upd();

  $('#pfSave').onclick = () => {
    const t = title.value.trim();
    const c = content.value.trim();
    if (!t || !c) { toast('标题和内容不能为空'); return; }
    if (t.length > 20 || c.length > 120) { toast('超出字数上限'); return; }
    const kw = $('#pfKeywords').value.split(/[，,、\s]+/).map(x => x.trim()).filter(Boolean).slice(0, 6);
    if (kw.length < 3) { toast('请填 3–6 个标签'); return; }
    const now = Date.now();
    if (isEdit) {
      Object.assign(existing, {
        title: t, content: c, keywords: kw, unit: $('#pfUnit').value || null,
        type: $('#pfType').value, difficulty: Number($('#pfDiff').value),
        commonq: $('#pfQ').value.trim(), updatedAt: now,
      });
    } else {
      const newId = 'MY-' + now;
      S.user.customs.push({
        id: newId, title: t, content: c, excerpt: '', source: '我创建',
        keywords: kw, type: $('#pfType').value, difficulty: Number($('#pfDiff').value),
        commonq: $('#pfQ').value.trim(), unit: $('#pfUnit').value || null,
        lesson: null, page: null, pdfPage: null, createdAt: now, updatedAt: now,
      });
    }
    saveUser(S.user);
    rebuildAll(); renderTree(); renderList(); renderHome();
    S.selected = isEdit ? existing.id : newId;
    S.user.config.lastSel = S.selected;
    saveUser(S.user);
    renderDetail();
    closeModal(modal);
    toast(isEdit ? '已保存修改' : '已创建，来源标记为「我创建」');
  };
}

/* ---------------- 表单：错题 ---------------- */
function openMistakeForm(existing) {
  const isEdit = !!existing;
  const m = existing || {};
  const pointOpts = S.all.filter(p => p.kind === 'point').map(p =>
    `<option value="${esc(p.id)}" ${m.kid === p.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('');
  const body = `
    <div class="form-grid">
      <label class="form-field full"><span>题干</span>
        <textarea id="mfStem" placeholder="粘贴或摘录题干">${esc(m.stem || '')}</textarea>
      </label>
      <label class="form-field"><span>我的答案</span><textarea id="mfMy">${esc(m.myAnswer || '')}</textarea></label>
      <label class="form-field"><span>正确答案</span><textarea id="mfRight">${esc(m.correctAnswer || '')}</textarea></label>
      <label class="form-field"><span>错因分类</span>
        <select id="mfReason">${['概念不清','审题失误','计算错','记忆偏差'].map(r =>
          `<option ${m.reason === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
      </label>
      <label class="form-field"><span>关联知识点</span>
        <select id="mfKid"><option value="">不关联</option>${pointOpts}</select>
      </label>
      <label class="form-field"><span>错误次数</span>
        <input id="mfCount" type="number" min="1" value="${esc(m.count || 1)}">
      </label>
      <label class="form-field"><span>下次复习日</span>
        <input id="mfNext" type="date" value="${esc(m.nextReview || addDays(1))}">
      </label>
      <div class="full info-note">排期间隔为 1 / 3 / 7 / 15 / 30 天：答对推进一档，答错重置到 1 天。</div>
    </div>`;
  const modal = openModal(isEdit ? '编辑错题' : '录入错题', body,
    `<button class="btn" data-close>取消</button><button class="btn primary" id="mfSave">保存</button>`);
  $('#mfSave').onclick = () => {
    const stem = $('#mfStem').value.trim();
    if (!stem) { toast('题干不能为空'); return; }
    const now = Date.now();
    if (isEdit) {
      Object.assign(m, {
        stem, myAnswer: $('#mfMy').value.trim(), correctAnswer: $('#mfRight').value.trim(),
        reason: $('#mfReason').value, kid: $('#mfKid').value || null,
        count: Math.max(1, Number($('#mfCount').value) || 1),
        nextReview: $('#mfNext').value || addDays(1), updatedAt: now,
      });
    } else {
      S.user.mistakes.push({
        id: 'MK-' + now, stem, myAnswer: $('#mfMy').value.trim(),
        correctAnswer: $('#mfRight').value.trim(), reason: $('#mfReason').value,
        kid: $('#mfKid').value || null, count: 1, stage: 0,
        lastReview: null, nextReview: $('#mfNext').value || addDays(1),
        createdAt: now, updatedAt: now,
      });
    }
    saveUser(S.user);
    S.view = 'mistakes';
    renderList(); renderHome(); renderDetail();
    closeModal(modal);
    toast(isEdit ? '错题已更新' : '已录入，明天开始按 1/3/7/15/30 天排期');
  };
}

/* ---------------- 备份面板 ---------------- */
function openBackupPanel() {
  const snaps = listSnapshots();
  const u = S.user;
  const snapHtml = snaps.length ? snaps.map(s => `
    <div class="row">
      <div>
        <div>${esc(new Date(s.at).toLocaleString('zh-CN'))}</div>
        <div class="snap-meta">${esc(s.reason)} · 笔记 ${s.counts?.notes || 0} / 自定义 ${s.counts?.customs || 0} / 错题 ${s.counts?.mistakes || 0}</div>
      </div>
      <button class="btn small" data-rollback="${esc(s.id)}">回滚</button>
    </div>`).join('') : '<p class="muted small">还没有快照。导入、批量操作前会自动生成。</p>';

  const body = `
    <div class="detail-section" style="margin-top:0">
      <h3>一键备份</h3>
      <div class="list-mini">
        <div class="row"><div>完整数据（笔记 / 自定义 / 错题 / 配置）</div><button class="btn small primary" id="bkExport">导出 JSON</button></div>
        <div class="row"><div>知识点（含原文摘录与页码）</div><button class="btn small" id="bkMD">导出 Markdown</button></div>
        <div class="row"><div>错题本（可直接进 Excel）</div><button class="btn small" id="bkCSV">导出 CSV</button></div>
        <div class="row"><div>恢复备份</div><button class="btn small" id="bkImport">选择 JSON</button></div>
      </div>
      <p class="hint" style="margin-top:8px">上次备份：${esc(fmtTime(u.config?.lastBackup))}${!u.config?.lastBackup ? '（建议现在导出一次）' : ''}</p>
    </div>

    <div class="detail-section">
      <h3>自动快照（保留最近 ${listSnapshots().length}/5 份）</h3>
      <div class="list-mini">${snapHtml}</div>
    </div>

    <div class="detail-section">
      <h3>批量操作（执行前自动快照）</h3>
      <div class="list-mini">
        <div class="row"><div>把当前列表全部标为「已掌握」</div><button class="btn small" data-bulk="mastered">执行</button></div>
        <div class="row"><div>把当前列表全部标为「待复习」</div><button class="btn small" data-bulk="review">执行</button></div>
        <div class="row"><div>清除当前列表的标记</div><button class="btn small" data-bulk="clear">执行</button></div>
        <div class="row"><div class="danger-note">删除全部「我创建」的知识点（书内知识点不受影响）</div><button class="btn small danger" data-bulk="delcustom">删除</button></div>
      </div>
    </div>

    <div class="detail-section">
      <h3>数据存放</h3>
      <p class="hint">笔记、错题、快照只存在本机浏览器 localStorage；静态知识点在 data/ 下，重新部署不会覆盖你的数据。清空浏览器数据前请先导出。</p>
    </div>
  `;
  const modal = openModal('备份 · 导入导出 · 快照', body, `<button class="btn" data-close>关闭</button>`);

  $('#bkExport').onclick = () => {
    const payload = exportPayload(S.user);
    download(`history-backup-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
    S.user.config.lastBackup = Date.now();
    saveUser(S.user); renderHome();
    toast('已导出完整备份');
    openBackupPanel();
  };
  $('#bkMD').onclick = () => {
    download(`history-knowledge-${stamp()}.md`, knowledgeToMD(S.all.filter(p => p.kind === 'point'), S.user.notes), 'text/markdown');
    toast('已导出 Markdown');
  };
  $('#bkCSV').onclick = () => {
    const resolve = id => itemById(id)?.title || '';
    download(`history-mistakes-${stamp()}.csv`, mistakesToCSV(S.user.mistakes || [], resolve), 'text/csv');
    toast('已导出 CSV');
  };
  $('#bkImport').onclick = () => pickImportFile();

  modal.querySelectorAll('[data-rollback]').forEach(b => {
    b.onclick = () => {
      if (!confirm('回滚会覆盖当前笔记、自定义知识点与错题，确定？')) return;
      const data = restoreSnapshot(b.dataset.rollback);
      if (!data) { toast('快照不存在'); return; }
      S.user = overwriteUser(data);
      saveUser(S.user);
      S.customs = S.user.customs; rebuildAll();
      S.selected = null;
      renderTree(); renderList(); renderDetail(); renderHome();
      closeModal(modal);
      toast('已回滚到该快照');
    };
  });

  modal.querySelectorAll('[data-bulk]').forEach(b => {
    b.onclick = () => {
      const kind = b.dataset.bulk;
      const items = S.list.filter(x => x.id);
      if (kind === 'delcustom') {
        if (!confirm('确定删除全部「我创建」的知识点？此操作可通过快照恢复。')) return;
        takeSnapshot(S.user, '批量删除自定义知识点');
        S.user.customs = [];
        for (const c of S.customs) { delete S.user.notes[c.id]; delete S.user.status[c.id]; }
      } else {
        takeSnapshot(S.user, '批量标记：' + kind);
        for (const it of items) {
          if (kind === 'clear') delete S.user.status[it.id];
          else S.user.status[it.id] = { state: kind, updatedAt: Date.now() };
        }
      }
      saveUser(S.user);
      S.customs = S.user.customs; rebuildAll();
      renderTree(); renderList(); renderHome(); renderDetail();
      closeModal(modal);
      toast('已执行，可在此面板回滚');
    };
  });
}

/* ---------------- 导入 ---------------- */
let importPayload = null;

function pickImportFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const obj = JSON.parse(text);
      const err = validateImport(obj);
      if (err) { toast('导入失败：' + err); return; }
      importPayload = obj;
      openImportChoice(obj, f.name);
    } catch (e) {
      toast('文件不是合法 JSON');
    } finally {
      input.remove();
    }
  };
  input.click();
}

function openImportChoice(obj, filename) {
  const d = obj.data;
  const body = `
    <div class="info-note">文件：${esc(filename)}<br>
      导出时间：${esc(obj.exportedAt || '未知')}<br>
      包含：笔记 ${Object.keys(d.notes || {}).length} 条 / 自定义 ${(d.customs || []).length} 条 / 错题 ${(d.mistakes || []).length} 条
    </div>
    <p style="margin:14px 0 6px">检测到现有数据：笔记 ${Object.keys(S.user.notes || {}).length} 条 / 自定义 ${(S.user.customs || []).length} 条 / 错题 ${(S.user.mistakes || []).length} 条。请选择处理方式：</p>
    <ul class="muted small" style="margin:0;padding-left:18px">
      <li><b>合并</b>：按 id 去重，保留修改时间较新的版本，不删除本机已有内容。</li>
      <li><b>覆盖</b>：用备份完全替换当前用户数据（执行前会自动快照）。</li>
    </ul>`;
  const modal = openModal('导入备份', body,
    `<button class="btn" data-close>取消</button>
     <button class="btn" id="impMerge">合并</button>
     <button class="btn primary" id="impOverwrite">覆盖</button>`);
  $('#impMerge').onclick = () => finishImport('merge', obj, modal);
  $('#impOverwrite').onclick = () => finishImport('overwrite', obj, modal);
}

function finishImport(mode, obj, modal) {
  takeSnapshot(S.user, '导入前快照（' + mode + '）');
  S.user = mode === 'merge' ? mergeUser(S.user, obj.data) : overwriteUser(obj.data);
  saveUser(S.user);
  S.customs = S.user.customs; rebuildAll();
  S.selected = null;
  renderTree(); renderList(); renderDetail(); renderHome();
  closeModal(modal);
  toast(mode === 'merge' ? '已合并导入' : '已覆盖导入');
}

/* ---------------- PDF 书源 ---------------- */
const DB_NAME = 'hs-files', DB_STORE = 'files', PDF_KEY = 'LS-pdf';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function putFile(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function getFile(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let pdfDoc = null, pdfPageNo = 1, pdfLibPromise = null;

async function openPdf(point) {
  const body = `
    <div class="pdf-wrap">
      <div class="pdf-toolbar">
        <button class="btn small" id="pdfPrev">上一页</button>
        <input id="pdfPageInput" type="number" min="1" style="width:70px;height:28px;border:1px solid var(--line-strong);border-radius:6px;padding:0 6px">
        <span id="pdfTotal">/ ?</span>
        <button class="btn small" id="pdfNext">下一页</button>
        <span id="pdfTarget" class="muted"></span>
        <button class="btn small ghost" id="pdfBind">重新绑定 PDF</button>
      </div>
      <div class="pdf-canvas-wrap" id="pdfStage"><p class="muted small">正在加载…</p></div>
    </div>`;
  const modal = openModal(`书源 · 第 ${point.page} 页`, body, `<button class="btn" data-close>关闭</button>`);
  $('#pdfTarget').textContent = `PDF 第 ${point.pdfPage} 页`;

  let file = null;
  try { file = await getFile(PDF_KEY); } catch { /* ignore */ }
  if (!file) {
    $('#pdfStage').innerHTML = `
      <div style="text-align:center">
        <p class="muted small">还没有绑定 PDF。选择本机的《高中三年历史知识清单.pdf》，只存在浏览器 IndexedDB，不会上传。</p>
        <input type="file" id="pdfFile" accept="application/pdf">
      </div>`;
    $('#pdfFile').onchange = async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const buf = await f.arrayBuffer();
      await putFile(PDF_KEY, buf);
      toast('已绑定 PDF，下次自动打开');
      closeModal(modal);
      openPdf(point);
    };
    $('#pdfBind').onclick = () => { closeModal(modal); openPdf(point); };
    return;
  }

  try {
    pdfLibPromise = pdfLibPromise || import(new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url).href);
    const pdfjsLib = await pdfLibPromise;
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    const data = file instanceof ArrayBuffer ? new Uint8Array(file.slice(0)) : new Uint8Array(file);
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    pdfPageNo = Math.min(point.pdfPage, pdfDoc.numPages);
    $('#pdfTotal').textContent = `/ ${pdfDoc.numPages}`;
    $('#pdfPageInput').value = pdfPageNo;
    await renderPdfPage(modal);
  } catch (err) {
    console.warn(err);
    $('#pdfStage').innerHTML = `<p class="muted small">PDF 加载失败：${esc(err.message || err)}</p>`;
  }

  $('#pdfPrev').onclick = async () => {
    if (pdfPageNo <= 1) return;
    pdfPageNo--; $('#pdfPageInput').value = pdfPageNo; await renderPdfPage(modal);
  };
  $('#pdfNext').onclick = async () => {
    if (!pdfDoc || pdfPageNo >= pdfDoc.numPages) return;
    pdfPageNo++; $('#pdfPageInput').value = pdfPageNo; await renderPdfPage(modal);
  };
  $('#pdfPageInput').onchange = async (e) => {
    const n = Math.max(1, Math.min(pdfDoc?.numPages || 1, Number(e.target.value) || 1));
    pdfPageNo = n; e.target.value = n; await renderPdfPage(modal);
  };
  $('#pdfBind').onclick = () => { closeModal(modal); openPdf(point); };
}

async function renderPdfPage(modal) {
  if (!pdfDoc) return;
  const page = await pdfDoc.getPage(pdfPageNo);
  const stage = $('#pdfStage', modal) || $('#pdfStage');
  const width = Math.min(900, stage.clientWidth - 16);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(0.5, width / base.width);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(vp.width * ratio);
  canvas.height = Math.floor(vp.height * ratio);
  canvas.style.width = vp.width + 'px';
  canvas.style.height = vp.height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  stage.innerHTML = '';
  stage.appendChild(canvas);
  stage.scrollTop = 0;
}

/* ---------------- 模态框 ---------------- */
let activeModal = null;

function openModal(title, bodyHtml, footHtml) {
  const root = $('#modalRoot');
  root.hidden = false;
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="关闭">×</button></div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-foot">${footHtml || '<button class="btn" data-close>关闭</button>'}</div>
    </div>`;
  const modal = root.querySelector('.modal');
  modal.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeModal(modal));
  root.onclick = (e) => { if (e.target === root) closeModal(modal); };
  activeModal = modal;
  setTimeout(() => {
    const f = modal.querySelector('input,textarea,select,button:not([data-close])');
    f?.focus();
  }, 30);
  return modal;
}

function closeModal(modal) {
  if (!modal) return;
  $('#modalRoot').hidden = true;
  $('#modalRoot').innerHTML = '';
  activeModal = null;
  if (modal._cleanup) modal._cleanup();
}

/* ---------------- 帮助 / 快捷键 ---------------- */
function openHelp() {
  const body = `
    <table class="shortcut-table">
      <tr><td>全局搜索</td><td><kbd>/</kbd> 或 <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd></td></tr>
      <tr><td>清空搜索</td><td><kbd>Esc</kbd></td></tr>
      <tr><td>列表上下移动</td><td><kbd>J</kbd> / <kbd>K</kbd></td></tr>
      <tr><td>打开快捷键面板</td><td><kbd>?</kbd></td></tr>
      <tr><td>标记已掌握</td><td>选中后点详情里的「已掌握」</td></tr>
    </table>
    <div class="detail-section">
      <h3>检索说明</h3>
      <p class="hint">支持中文关键词、同义词（如「重农抑商」≈「重本抑末」）、拼音首字母（如「sybf」≈「商鞅变法」）。结果按标题、关键词、原文、正文分层打分；空结果会给最相近 5 条。</p>
    </div>
    <div class="detail-section">
      <h3>数据与离线</h3>
      <p class="hint">静态知识点在 data/ 目录；笔记、错题、快照在 localStorage；PDF 只在你本机 IndexedDB。三者互不覆盖。</p>
    </div>`;
  openModal('快捷键与使用说明', body);
}

/* ---------------- Toast ---------------- */
let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
const showToast = toast;

/* ---------------- 移动端 ---------------- */
function isMobile() { return window.matchMedia('(max-width: 980px)').matches; }
function onMobileTab(tab) {
  if (!isMobile()) return;
  const left = $('#leftPane'), right = $('#rightPane'), scrim = $('#drawerScrim');
  left.classList.toggle('open', tab === 'tree');
  right.classList.toggle('open', tab === 'detail');
  scrim.hidden = tab !== 'tree' && tab !== 'detail';
  $$('.mobile-tabs button').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  if (tab === 'list') { left.classList.remove('open'); right.classList.remove('open'); scrim.hidden = true; }
}
function closePanels() {
  $('#leftPane').classList.remove('open');
  $('#rightPane').classList.remove('open');
  $('#drawerScrim').hidden = true;
  $$('.mobile-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'list'));
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  $('#listViewport').addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { lastStart = lastEnd = -1; paintWindow(true); });

  // 卡片点击 / 键盘
  $('#listCanvas').addEventListener('click', (e) => {
    const card = e.target.closest('.k-card');
    if (card) select(card.dataset.id);
  });
  $('#listCanvas').addEventListener('keydown', (e) => {
    const card = e.target.closest('.k-card');
    if (!card) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(card.dataset.id); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = Number(card.dataset.index) + (e.key === 'ArrowDown' ? 1 : -1);
      const vp = $('#listViewport');
      const next = S.list[Math.max(0, Math.min(S.list.length - 1, i))];
      if (next) { select(next.id, false); paintWindow(true); }
    }
  });

  // 搜索
  let debounce = 0;
  const input = $('#searchInput');
  input.addEventListener('input', () => {
    $('#searchClear').hidden = !input.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => doSearch(input.value), 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; doSearch(''); input.blur(); }
  });
  $('#searchClear').onclick = () => { input.value = ''; doSearch(''); input.focus(); };

  // 筛选
  ['#filterType', '#filterDiff', '#filterStatus', '#sortSelect'].forEach(sel => {
    $(sel).addEventListener('change', () => { S.view = 'browse'; renderList(); });
  });
  $('#filterReset').onclick = () => {
    $('#filterType').value = 'all'; $('#filterDiff').value = '0'; $('#filterStatus').value = 'all';
    S.scope = { type: 'all', code: null };
    renderTree(); renderList();
  };

  // 视图切换
  $('#viewToggle').onclick = () => { S.view = 'browse'; S.query = ''; $('#searchInput').value = ''; renderList(); };
  $('#dueBtn').onclick = () => { S.view = 'due'; renderList(); onMobileTab('list'); };
  $('#mistakeBtn').onclick = () => {
    S.view = 'mistakes'; renderList(); onMobileTab('list');
    if (!(S.user.mistakes || []).length) toast('错题本是空的，点「录入错题」开始');
  };
  $('#customBtn').onclick = () => openPointForm(null);
  $('#addMistakeBtn').onclick = () => openMistakeForm(null);
  $('#backupBtn').onclick = openBackupPanel;
  $('#helpBtn').onclick = openHelp;
  $('#collapseAll').onclick = () => {
    const anyOpen = Object.values(S.expanded.vols).some(v => v !== false);
    for (const v of S.book.volumes) S.expanded.vols[v.code] = !anyOpen;
    S.expanded.units = {};
    renderTree();
  };
  $('#closeDetail').onclick = closePanels;
  $('#drawerScrim').onclick = closePanels;
  $$('.mobile-tabs button').forEach(b => b.onclick = () => onMobileTab(b.dataset.tab));

  // 全局快捷键
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); input.focus(); return;
    }
    if (e.key === '/' && !typing) { e.preventDefault(); input.focus(); return; }
    if (e.key === 'Escape') {
      if (activeModal) { closeModal(activeModal); return; }
      if (input.value) { input.value = ''; doSearch(''); }
      closePanels();
      return;
    }
    if (e.key === '?' && !typing) { e.preventDefault(); openHelp(); return; }
    if ((e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K') && !typing && !e.metaKey && !e.ctrlKey) {
      if (!S.list.length) return;
      const dir = e.key.toLowerCase() === 'j' ? 1 : -1;
      let idx = S.list.findIndex(x => x.id === S.selected);
      idx = idx < 0 ? 0 : Math.max(0, Math.min(S.list.length - 1, idx + dir));
      select(S.list[idx].id, false);
      const vp = $('#listViewport');
      const y = idx * ITEM_H;
      if (y < vp.scrollTop || y + CARD_H > vp.scrollTop + vp.clientHeight) {
        vp.scrollTop = Math.max(0, y - vp.clientHeight / 2);
      }
    }
  });

  // 移动端标签
  window.matchMedia('(max-width: 980px)').addEventListener('change', () => closePanels());
}

/* ---------------- 性能模式 ---------------- */
function enablePerfMode() {
  const base = S.all.filter(p => p.kind === 'point');
  const n = 1000;
  S.synthetic = Array.from({ length: n }, (_, i) => {
    const src = base[i % base.length];
    return {
      ...src,
      id: 'PERF-' + i,
      title: src.title + `（${i + 1}）`,
      kind: 'point',
      _perf: true,
    };
  });
  S.perfMode = true;
  S.view = 'browse';
  renderList();
  toast('性能模式：1000 条合成数据（不写入本地）');
}

/* ---------------- 自测 ---------------- */
async function runSelfTest() {
  const out = { ok: true, checks: [] };
  const ck = (name, pass, detail) => {
    out.checks.push({ name, pass, detail });
    if (!pass) out.ok = false;
  };

  ck('books.json 单元数=21', S.units.size === 21, S.units.size);
  ck('books.json 课数=66', S.lessons.size === 66, S.lessons.size);
  ck('knowledge.json 条数', S.points.length === 64, S.points.length);

  // 搜索
  const searchOnce = q => new Promise(res => {
    if (!S.worker) return res(null);
    const h = (e) => {
      if (e.data.type === 'results') { S.worker.removeEventListener('message', h); res(e.data); }
    };
    S.worker.addEventListener('message', h);
    S.worker.postMessage({ type: 'search', q });
  });
  const r1 = await searchOnce('商鞅');
  ck('搜索“商鞅”有结果', !!r1 && r1.items.length > 0, r1 ? r1.items.length : 'no worker');

  // 搜索延迟（30 次）
  let total = 0, max = 0;
  for (let i = 0; i < 30; i++) {
    const t = performance.now();
    const r = await searchOnce('变法');
    const d = performance.now() - t;
    total += d; max = Math.max(max, d);
  }
  ck('搜索往返 <100ms（平均）', total / 30 < 100, `avg ${(total / 30).toFixed(1)}ms / max ${max.toFixed(1)}ms`);

  // 导出 → 导入还原
  S.user.notes['LS-U01-001'] = { text: '自测笔记', updatedAt: Date.now() };
  const payload = exportPayload(S.user);
  const err = validateImport(payload);
  ck('导出 JSON 通过 schema 校验', !err, err || 'ok');
  const cloned = JSON.parse(JSON.stringify(payload));
  const restored = mergeUser(emptyUser(), cloned.data);
  ck('导入可还原笔记', restored.notes['LS-U01-001']?.text === '自测笔记', restored.notes['LS-U01-001']?.text);

  // 快照
  const snap = takeSnapshot(S.user, '自测快照');
  ck('快照写入成功', !!snap && listSnapshots().length > 0, listSnapshots().length);
  if (snap) restoreSnapshot(snap.id);

  // 1000 条检索延迟
  enablePerfMode();
  const waitReady = () => new Promise(res => {
    if (!S.worker) return res(false);
    const h = e => { if (e.data.type === 'ready') { S.worker.removeEventListener('message', h); res(true); } };
    S.worker.addEventListener('message', h);
    setTimeout(() => res(false), 3000);
  });
  S.worker?.postMessage({
    type: 'init',
    points: S.synthetic.map(p => ({ id: p.id, title: p.title, content: p.content, excerpt: p.excerpt, keywords: p.keywords, lessonTitle: p.lessonTitle })),
    aliasGroups: S.aliasGroups || [], pinyin: S.pinyin || {},
  });
  await waitReady();
  let t2 = 0, m2 = 0;
  for (let i = 0; i < 30; i++) {
    const t = performance.now();
    await searchOnce('变法');
    const d = performance.now() - t;
    t2 += d; m2 = Math.max(m2, d);
  }
  ck('1000 条检索 <100ms（平均）', t2 / 30 < 100, `avg ${(t2 / 30).toFixed(1)}ms / max ${m2.toFixed(1)}ms`);

  // 虚拟滚动
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const rendered = $('#listCanvas').children.length;
  ck('1000 条仅渲染视口 ±10', rendered > 0 && rendered <= 40, rendered);

  // 滚动帧率
  const vp = $('#listViewport');
  let frames = 0, maxGap = 0, last = performance.now();
  const start = performance.now();
  await new Promise(resolve => {
    const step = () => {
      frames++;
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      vp.scrollTop = Math.min(vp.scrollHeight - vp.clientHeight, vp.scrollTop + 28);
      if (now - start < 2000) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  const fps = frames / ((performance.now() - start) / 1000);
  ck('滚动 ≥55fps（本机实测）', fps >= 55, `fps ${fps.toFixed(1)} / maxGap ${maxGap.toFixed(1)}ms`);

  out.meta = {
    initMs: S.initMs,
    firstPaint: performance.getEntriesByName('first-contentful-paint')[0]?.startTime?.toFixed?.(1) || null,
    searchAvg: +(total / 30).toFixed(1),
    search1000Avg: +(t2 / 30).toFixed(1),
    searchMax: +max.toFixed(1),
    fps: +fps.toFixed(1),
    renderedCards: rendered,
    points: S.points.length,
  };

  const pre = $('#selftest');
  pre.hidden = false;
  pre.textContent = JSON.stringify(out, null, 2);
  window.__SELFTEST__ = out;
  console.log('SELFTEST', out);
}

/* ---------------- 离线缓存 ---------------- */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.log('SW 注册失败', e));
  });
}

/* ---------------- 启动 ---------------- */
boot().then(() => {
  window.HS = {
    S, doSearch, select, exportPayload, validateImport, mergeUser,
    takeSnapshot, listSnapshots, restoreSnapshot, enablePerfMode,
    renderList, currentItems,
  };
}).catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="position:fixed;inset:20px;background:#fff;border:1px solid #ddd;padding:20px;border-radius:12px">
      <h3>加载失败</h3><p>${esc(err.message)}</p>
      <p class="muted small">请通过本地服务器打开（不要直接双击 index.html）。</p></div>`);
});
