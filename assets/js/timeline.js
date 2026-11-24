/* ============================================================
   timeline.js —— 全球纪年时间线
   - 内置 data/timeline.json（104 条，只读）
   - 自定义事件存 localStorage['hs.timeline.custom.v1']
   - 一条总览线按年份排序；可按地区 / 阶段 / 关键词筛选
   ============================================================ */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const CUSTOM_KEY = 'hs.timeline.custom.v1';
const STAGES = [
  { name: '中国古代', range: '先秦 — 1840 年前', region: 'china', color: 'var(--c0)' },
  { name: '中国近代', range: '1840 — 1949', region: 'china', color: 'var(--c1)' },
  { name: '中国现代', range: '1949 — 至今', region: 'china', color: 'var(--c2)' },
  { name: '世界古代', range: '上古 — 1500 年前', region: 'world', color: 'var(--c3)' },
  { name: '世界近代', range: '1500 — 1900', region: 'world', color: 'var(--c4)' },
  { name: '世界现代', range: '1900 — 至今', region: 'world', color: 'var(--c5)' },
];
const REGIONS = {
  china: { label: '中国', color: 'var(--c1)' },
  world: { label: '世界', color: 'var(--c4)' },
  other: { label: '其他', color: 'var(--c5)' },
};

const state = {
  data: null,
  items: [],
  custom: [],
  era: 'all',
  region: 'all',
  q: '',
  mode: 'all',
  editId: null,
};

function loadCustom() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(x => x && x.id && x.title).map(x => ({
      ...x,
      era: Number.isFinite(+x.era) ? Math.max(0, Math.min(5, +x.era)) : 0,
      region: REGIONS[x.region] ? x.region : 'other',
      year: Number.isFinite(+x.year) ? +x.year : 0,
      custom: true,
      source: '自定义',
    }));
  } catch (e) { return []; }
}

function parseYear(when) {
  const s = String(when || '').trim();
  if (!s) return 0;
  const neg = /^(前|公元前|BC|bc)/.test(s) || s.startsWith('-');
  const m = s.match(/(\d{1,4})/);
  const n = m ? Number(m[1]) : 0;
  return neg && n > 0 ? -n : n;
}

function whenLabel(when, year) {
  const s = String(when || '').trim();
  if (s) {
    if (/年|世纪|朝代|时期/.test(s)) return s;
    return (year < 0 ? '前 ' : '') + s.replace(/^-/, '') + ' 年';
  }
  return year < 0 ? `前 ${-year} 年` : `${year} 年`;
}

function fmtRange(y) {
  return y < 0 ? `前 ${-y}` : String(y);
}

function yearBits(when, approx) {
  const m = String(when).match(/^(前)?(\d+)(.*)$/);
  const neg = m?.[1] ? '<small class="pre">前</small>' : '';
  const num = m?.[2] ?? esc(when);
  const suffix = m?.[3] ? `<small class="suf">${esc(m[3])}</small>` : '';
  const mark = approx ? '<span class="approx">约</span>' : '';
  const cls = String(when).length >= 5 ? ' class="long"' : '';
  return `<b${cls}>${neg}${num}${suffix}</b>${mark}`;
}

function stageOf(it) {
  return STAGES[it.era] || STAGES[0];
}
function regionOf(it) {
  return REGIONS[it.region] || REGIONS.other;
}

function cardHTML(it) {
  const stage = stageOf(it);
  const region = regionOf(it);
  const style = `--era:${stage.color};--region:${region.color};--d:${Math.min(it._order || 0, 10) * 26}ms`;
  const where = [it.unitTitle, it.lessonTitle].filter(Boolean).join(' · ');
  const badges = `
    <span class="era-chip">${esc(stage.name)}</span>
    <span class="region-chip">${esc(region.label)}</span>
    ${it.custom ? '<span class="custom-chip">自定义</span>' : ''}
    ${it.type ? `<span class="type-chip">${esc(it.type)}</span>` : ''}`;
  const meta = `<span class="where">${esc(where || (it.custom ? '我添加的事件' : ''))}</span>
    <span class="page">${it.custom ? `<button class="tl-edit" data-edit="${esc(it.id)}">编辑</button><button class="tl-del" data-del="${esc(it.id)}">删除</button>` : '解析页 ↗'}</span>`;
  const inner = `
    <div class="card-top">${badges}</div>
    <h3>${esc(it.title)}</h3>
    <p>${esc(it.content || '')}</p>
    ${it.note ? `<p class="tl-note"><b>标注</b>${esc(it.note)}</p>` : ''}
    <div class="card-meta">${meta}</div>`;

  if (it.custom) {
    return `<div class="tl-item" data-id="${esc(it.id)}" style="${style}">
      <div class="tl-year">${yearBits(it.when, it.approx)}</div>
      <div class="tl-rail" aria-hidden="true"><span class="tl-dot"></span></div>
      <div class="tl-card tl-custom">${inner}</div>
    </div>`;
  }
  return `<div class="tl-item" data-id="${esc(it.id)}" style="${style}">
    <div class="tl-year">${yearBits(it.when, it.approx)}</div>
    <div class="tl-rail" aria-hidden="true"><span class="tl-dot"></span></div>
    <a class="tl-card" href="detail.html?id=${encodeURIComponent(it.id)}" aria-label="打开解析：${esc(it.title)}">${inner}<span class="tl-open" aria-hidden="true">↗</span></a>
  </div>`;
}

function buildItems() {
  const base = (state.data.eras || []).flatMap((e, i) => (e.items || []).map(x => ({
    ...x,
    era: i,
    region: i < 3 ? 'china' : 'world',
    custom: false,
  })));
  const custom = state.custom.map(x => ({
    ...x,
    era: Math.max(0, Math.min(5, +x.era || 0)),
    region: REGIONS[x.region] ? x.region : 'other',
  }));
  state.items = base.concat(custom).sort((a, b) => {
    if ((a.year ?? 0) !== (b.year ?? 0)) return (a.year ?? 0) - (b.year ?? 0);
    if (a.era !== b.era) return a.era - b.era;
    return String(a.title).localeCompare(String(b.title), 'zh');
  });
  state.items.forEach((it, i) => { it._order = i; });
  const map = new Map();
  state.items.forEach(it => map.set(it.id, it));
  return map;
}

function counts() {
  const stage = [0, 0, 0, 0, 0, 0];
  const region = { china: 0, world: 0, other: 0, custom: 0 };
  state.items.forEach(it => {
    stage[it.era] = (stage[it.era] || 0) + 1;
    region[it.region] = (region[it.region] || 0) + 1;
    if (it.custom) region.custom++;
  });
  return { stage, region };
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.items.filter(it => {
    if (state.era !== 'all' && it.era !== +state.era) return false;
    if (state.region === 'custom') {
      if (!it.custom) return false;
    } else if (state.region !== 'all' && it.region !== state.region) return false;
    if (!q) return true;
    const hay = [it.title, it.content, it.when, it.note, it.unitTitle, it.lessonTitle, it.type, stageOf(it).name, REGIONS[it.region]?.label]
      .join(' ').toLowerCase();
    return q.split(/\s+/).filter(Boolean).every(t => hay.includes(t));
  });
}

function renderTabs() {
  const c = counts();
  const tabs = $('#eraTabs');
  tabs.innerHTML = `<button class="era-tab all ${state.era === 'all' ? 'active' : ''}" data-era="all" aria-pressed="${state.era === 'all'}">全部 <em>${state.items.length}</em></button>` +
    STAGES.map((s, i) => `<button class="era-tab ${state.era === String(i) ? 'active' : ''}" data-era="${i}" aria-pressed="${state.era === String(i)}" style="--era:var(--c${i})">
      ${esc(s.name)} <em>${c.stage[i] || 0}</em>
    </button>`).join('');

  const regionTabs = $('#regionTabs');
  const defs = [
    ['all', '全部地区', state.items.length],
    ['china', '中国', c.region.china],
    ['world', '世界', c.region.world],
    ['custom', '自定义', c.region.custom],
  ];
  regionTabs.innerHTML = defs.map(([k, label, n]) =>
    `<button class="region-tab ${state.region === k ? 'active' : ''}" data-region="${k}" aria-pressed="${state.region === k}">${label} <em>${n}</em></button>`
  ).join('');

  $$('#viewToggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === state.mode);
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  });
}

function renderStream(list) {
  const stream = $('#stream');
  if (!list.length) { stream.innerHTML = ''; return; }

  if (state.mode === 'all') {
    const first = list[0], last = list[list.length - 1];
    stream.innerHTML = `<section class="tl-era tl-global" data-era="all" style="--era:var(--c4)">
      <header class="era-head">
        <span class="era-index">ERA ALL</span>
        <div class="era-name"><h2>全球纪年</h2><p>${esc(first.when)} — ${esc(last.when)} · 一条线读完</p></div>
        <span class="era-count">${list.length} 件</span>
      </header>
      <div class="tl-list">${list.map(cardHTML).join('')}</div>
    </section>`;
    return;
  }

  const sections = state.era === 'all' ? STAGES.map((_, i) => i) : [Number(state.era)];
  stream.innerHTML = sections.map(i => {
    const items = list.filter(it => it.era === i);
    if (!items.length) return '';
    return `<section class="tl-era" data-era="${i}" style="--era:var(--c${i})">
      <header class="era-head">
        <span class="era-index">ERA ${String(i + 1).padStart(2, '0')}</span>
        <div class="era-name"><h2>${esc(STAGES[i].name)}</h2><p>${esc(STAGES[i].range)}</p></div>
        <span class="era-count">${items.length} 件</span>
      </header>
      <div class="tl-list">${items.map(cardHTML).join('')}</div>
    </section>`;
  }).join('');
}

function renderStatus(list) {
  const c = counts();
  const modeText = state.mode === 'all' ? '全球总览' : '分时代';
  if (state.q) {
    $('#status').innerHTML = `在 <b>${state.items.length}</b> 个事件中，找到 <b>${list.length}</b> 条与“${esc(state.q)}”相关`;
  } else if (state.era !== 'all') {
    $('#status').innerHTML = `${esc(STAGES[+state.era].name)} · <b>${list.length}</b> 个事件 · ${esc(STAGES[+state.era].range)}`;
  } else if (state.region !== 'all') {
    const label = state.region === 'custom' ? '自定义' : REGIONS[state.region]?.label;
    $('#status').innerHTML = `${esc(label)} · <b>${list.length}</b> 个事件 · ${modeText}`;
  } else {
    $('#status').innerHTML = `共 <b>${state.items.length}</b> 个纪年事件 · 中国 ${c.region.china} · 世界 ${c.region.world} · 自定义 ${c.region.custom} · 点事件打开解析`;
  }
}

function render() {
  const c = counts();
  $('#totalCount').textContent = state.items.length;
  $('#statEvents').textContent = state.items.length;
  const customEl = $('#statCustom');
  if (customEl) customEl.textContent = c.region.custom;
  const lessons = new Set(state.items.filter(x => x.lesson).map(x => x.lesson));
  $('#statLessons').textContent = lessons.size;
  const years = state.items.map(x => x.year).filter(n => Number.isFinite(n));
  if (years.length) $('#range').innerHTML = `${fmtRange(Math.min(...years))} <span>—</span> ${fmtRange(Math.max(...years))}`;
  renderTabs();
  const list = filtered();
  renderStream(list);
  renderStatus(list);
  $('#empty').hidden = list.length > 0;
  $('#resetBtn').hidden = !state.q;
}

function showToast(text) {
  const el = $('#tlToast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- 自定义事件 ---------- */
function openForm(item) {
  state.editId = item?.id || null;
  $('#eventModalTitle').textContent = item ? '编辑事件' : '添加事件';
  $('#efWhen').value = item?.when || '';
  $('#efTitle').value = item?.title || '';
  $('#efContent').value = item?.content || '';
  $('#efNote').value = item?.note || '';
  $('#efRegion').value = item?.region || 'china';
  $('#efEra').value = String(item?.era ?? 0);
  $('#efApprox').checked = Boolean(item?.approx);
  $('#eventModal').hidden = false;
  setTimeout(() => $('#efWhen').focus(), 40);
}

function closeForm() {
  $('#eventModal').hidden = true;
  state.editId = null;
}

function saveForm(e) {
  e.preventDefault();
  const when = $('#efWhen').value.trim();
  const title = $('#efTitle').value.trim();
  const content = $('#efContent').value.trim();
  const note = $('#efNote').value.trim();
  const region = $('#efRegion').value;
  const era = Number($('#efEra').value);
  if (!when || !title) { showToast('时间和事件标题不能为空'); return; }
  const year = parseYear(when);
  if (!Number.isFinite(year)) { showToast('时间格式无法识别，例：前2070、1911、1911年10月10日'); return; }

  let custom = loadCustom();
  const editing = state.editId;
  if (editing) {
    const i = custom.findIndex(x => x.id === editing);
    if (i >= 0) custom[i] = {
      ...custom[i], when, year, title, content, note, region, era,
      approx: $('#efApprox').checked, updatedAt: Date.now(),
    };
  } else {
    custom.push({
      id: 'CUSTOM-' + Date.now().toString(36),
      when, year, title, content, note, region, era,
      approx: $('#efApprox').checked,
      custom: true, source: '自定义', createdAt: Date.now(), updatedAt: Date.now(),
    });
  }
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
  state.custom = custom;
  buildItems();
  closeForm();
  state.editId = null;
  render();
  showToast(editing ? '事件已更新' : '事件已加入时间线');
}

function deleteItem(id) {
  const item = state.items.find(x => x.id === id);
  if (!item || !item.custom) return;
  if (!confirm(`删除自定义事件“${item.title}”？`)) return;
  const custom = loadCustom().filter(x => x.id !== id);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
  state.custom = custom;
  buildItems();
  render();
  showToast('事件已删除');
}

/* ---------- 导出 ---------- */
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function exportCSV() {
  const rows = [['年份', '时间', '事件', '说明', '地区', '阶段', '标注', '类型', '来源', '知识点ID']];
  for (const it of state.items) {
    rows.push([
      it.year ?? '', it.when || '', it.title, it.content || '',
      it.custom ? REGIONS[it.region]?.label || '其他' : (it.region === 'china' ? '中国' : '世界'),
      stageOf(it).name, it.note || '', it.type || '', it.custom ? '自定义' : '内置', it.id,
    ]);
  }
  const csv = '\ufeff' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(`历史时间线-${state.items.length}个事件.csv`, csv, 'text/csv;charset=utf-8');
}

function exportJSON() {
  download(`历史时间线-${state.items.length}个事件.json`, JSON.stringify({
    count: state.items.length,
    generatedAt: new Date().toISOString(),
    custom: state.custom,
    events: state.items,
  }, null, 2), 'application/json');
}

function bindEvents() {
  $('#eraTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-era]');
    if (!b) return;
    state.era = b.dataset.era;
    render();
  });
  $('#regionTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-region]');
    if (!b) return;
    state.region = b.dataset.region;
    render();
  });
  $('#viewToggle').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    state.mode = b.dataset.mode;
    render();
  });
  $('#q').addEventListener('input', e => {
    state.q = e.target.value;
    if (state.q) state.era = 'all';
    render();
  });
  $('#resetBtn').onclick = () => {
    state.q = ''; $('#q').value = ''; state.era = 'all'; state.region = 'all'; render(); $('#q').focus();
  };
  $('#csvBtn').onclick = exportCSV;
  $('#jsonBtn').onclick = exportJSON;
  $('#printBtn').onclick = () => window.print();
  $('#addBtn').onclick = () => openForm();
  $('#eventClose').onclick = closeForm;
  $('#eventCancel').onclick = closeForm;
  $('#eventModal').addEventListener('click', e => { if (e.target === $('#eventModal')) closeForm(); });
  $('#eventForm').addEventListener('submit', saveForm);
  $('#stream').addEventListener('click', e => {
    const edit = e.target.closest('[data-edit]');
    if (edit) { e.preventDefault(); e.stopPropagation(); openForm(state.items.find(x => x.id === edit.dataset.edit)); return; }
    const del = e.target.closest('[data-del]');
    if (del) { e.preventDefault(); e.stopPropagation(); deleteItem(del.dataset.del); }
  });
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape') {
      if (!$('#eventModal').hidden) closeForm();
      else if (typing) { state.q = ''; $('#q').value = ''; state.era = 'all'; render(); $('#q').blur(); }
    }
  });
  window.addEventListener('storage', e => {
    if (e.key !== CUSTOM_KEY) return;
    state.custom = loadCustom();
    buildItems();
    render();
  });
}

async function boot() {
  try {
    const res = await fetch('data/timeline.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.data = await res.json();
  } catch (err) {
    $('#status').textContent = '时间线数据加载失败：' + err.message;
    $('#empty').hidden = false;
    return;
  }
  state.custom = loadCustom();
  buildItems();
  render();
  bindEvents();

  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  if (q) { state.q = q; $('#q').value = q; state.era = 'all'; render(); }
  const region = params.get('region');
  if (region && (region === 'all' || REGIONS[region] || region === 'custom')) { state.region = region; render(); }

  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const h = document.documentElement.scrollHeight - innerHeight;
      $('#scrollProgress').style.width = h > 0 ? `${Math.min(100, scrollY / h * 100)}%` : '0';
      $('#toTop').hidden = scrollY < 700;
    });
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  $('#toTop').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
}

boot();
