/* ============================================================
   timeline.js —— 独立时间线页
   只读取 data/timeline.json；不改动知识库数据与用户本地数据
   ============================================================ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const state = { data: null, active: 'all', q: '' };

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

function cardHTML(it) {
  const approx = Boolean(it.approx);
  const href = `index.html?focus=${encodeURIComponent(it.id)}`;
  const where = [it.unitTitle, it.lessonTitle].filter(Boolean).join(' · ');
  return `<div class="tl-item" data-id="${esc(it.id)}">
    <div class="tl-year" aria-label="${esc(it.when + (approx ? '左右' : ''))}">
      ${yearBits(it.when, approx)}
    </div>
    <div class="tl-rail" aria-hidden="true"><span class="tl-dot"></span></div>
    <a class="tl-card" href="${href}" aria-label="打开知识点：${esc(it.title)}">
      <div class="card-top">
        <span class="era-chip">${esc(it.eraName || '')}</span>
        ${it.type ? `<span class="type-chip">${esc(it.type)}</span>` : ''}
      </div>
      <h3>${esc(it.title)}</h3>
      <p>${esc(it.content || '')}</p>
      <div class="card-meta">
        <span class="where">${esc(where)}</span>
        <span class="page">${it.page ? 'P.' + it.page : (it.pdfPage ? 'PDF P.' + it.pdfPage : '查看')}</span>
      </div>
    </a>
  </div>`;
}

function render() {
  const { eras, count } = state.data;
  const tabs = $('#eraTabs');
  const allCount = count;
  tabs.innerHTML = `<button class="era-tab all ${state.active === 'all' ? 'active' : ''}" data-era="all" aria-pressed="${state.active === 'all'}">全部 <em>${allCount}</em></button>` +
    eras.map((e, i) => `<button class="era-tab ${state.active === String(i) ? 'active' : ''}" data-era="${i}" aria-pressed="${state.active === String(i)}" style="--era:var(--c${i})">
      ${esc(e.name)} <em>${e.count}</em>
    </button>`).join('');

  const stream = $('#stream');
  stream.innerHTML = eras.map((e, i) => {
    const items = e.items.map((it, j) => ({
      ...it, eraName: e.name,
    })).map((it, j) => cardHTML(it).replace('class="tl-item"', `class="tl-item" style="--d:${Math.min(j, 10) * 32}ms"`)).join('');
    return `<section class="tl-era" data-era="${i}" id="era-${i}" style="--era:var(--c${i})">
      <header class="era-head">
        <span class="era-index">ERA ${String(i + 1).padStart(2, '0')}</span>
        <div class="era-name"><h2>${esc(e.name)}</h2><p>${esc(e.range)}</p></div>
        <span class="era-count">${e.count} 件</span>
      </header>
      <div class="tl-list">${items}</div>
    </section>`;
  }).join('');

  $('#totalCount').textContent = count;
  $('#statEvents').textContent = count;
  const years = state.data.eras.flatMap(e => e.items.map(x => x.year));
  $('#range').innerHTML = `${fmtRange(Math.min(...years))} <span>—</span> ${fmtRange(Math.max(...years))}`;
  $('#statLessons').textContent = new Set(state.data.eras.flatMap(e => e.items.map(x => x.lesson))).size;

  tabs.querySelectorAll('.era-tab').forEach(btn => {
    btn.onclick = () => {
      state.active = btn.dataset.era;
      if (state.q) { state.q = ''; $('#q').value = ''; $('#resetBtn').hidden = true; }
      applyFilter();
      const top = tabs.getBoundingClientRect().top + window.scrollY;
      if (window.scrollY > top) window.scrollTo({ top, behavior: 'smooth' });
    };
  });

  applyFilter();
}

function matches(it, q) {
  if (!q) return true;
  const hay = [it.title, it.content, it.when, it.unitTitle, it.lessonTitle, it.type, it.eraName]
    .join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t));
}

function applyFilter() {
  const q = state.q.trim();
  let visible = 0;
  const sections = [...document.querySelectorAll('.tl-era')];
  sections.forEach(sec => {
    const eraOK = state.active === 'all' || state.active === sec.dataset.era;
    let hit = 0;
    sec.querySelectorAll('.tl-item').forEach(item => {
      const it = findItem(item.dataset.id);
      const ok = eraOK && matches(it, q);
      item.hidden = !ok;
      if (ok) hit++;
    });
    sec.hidden = !(eraOK && hit > 0);
    visible += hit;
  });
  $('#empty').hidden = visible > 0;

  const eraName = state.active === 'all' ? '全部时间线' : state.data.eras[+state.active].name;
  if (q) {
    $('#status').innerHTML = `在 <b>${state.data.count}</b> 个纪年事件中，找到 <b>${visible}</b> 条与“${esc(q)}”相关`;
  } else if (state.active === 'all') {
    $('#status').innerHTML = `共 <b>${state.data.count}</b> 个纪年事件 · 6 个时代 · 点任意事件进入对应章节`;
  } else {
    $('#status').innerHTML = `${esc(eraName)} · <b>${visible}</b> 个事件 · ${esc(state.data.eras[+state.active].range)}`;
  }
  $('#resetBtn').hidden = !q;
  document.querySelectorAll('.era-tab').forEach(b => {
    const on = b.dataset.era === state.active;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

let itemMap = new Map();
function findItem(id) { return itemMap.get(id) || {}; }

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
  const rows = [['年份', '事件', '时代', '单元', '课次', '教材页', '知识点ID']];
  for (const e of state.data.eras) {
    for (const it of e.items) {
      rows.push([it.when, it.title, e.name, it.unitTitle, it.lessonTitle, it.page || '', it.id]);
    }
  }
  const csv = '\ufeff' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download('历史时间线-104个考点.csv', csv, 'text/csv;charset=utf-8');
}

function exportJSON() {
  download('历史时间线-104个考点.json', JSON.stringify(state.data, null, 2), 'application/json');
}

async function boot() {
  try {
    const res = await fetch('data/timeline.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.data = await res.json();
    state.data.eras.forEach(e => e.items.forEach(it => itemMap.set(it.id, { ...it, eraName: e.name })));
    render();

    const p = new URLSearchParams(location.search).get('era');
    if (p && state.data.eras[p]) { state.active = p; applyFilter(); }
  } catch (err) {
    $('#status').textContent = '时间线数据加载失败：' + err.message;
    $('#empty').hidden = false;
  }

  $('#q').addEventListener('input', e => {
    state.q = e.target.value;
    if (state.q) state.active = 'all';
    applyFilter();
  });
  $('#resetBtn').onclick = () => {
    state.q = ''; $('#q').value = ''; state.active = 'all'; applyFilter(); $('#q').focus();
  };
  $('#csvBtn').onclick = exportCSV;
  $('#jsonBtn').onclick = exportJSON;
  $('#printBtn').onclick = () => window.print();

  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape' && typing) {
      state.q = ''; $('#q').value = ''; state.active = 'all'; applyFilter(); $('#q').blur();
    }
  });

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
