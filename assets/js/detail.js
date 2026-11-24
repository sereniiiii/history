/* ============================================================
   detail.js —— 单条考点解析页
   只读 data/*.json；不写入知识库数据
   ============================================================ */
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const TYPE_HINTS = {
  '概念': '选择题多考“是什么、何时、主体是谁”；材料题要求用一句话概括内涵，再用史实佐证。',
  '机制': '常考“为什么能运转、如何运作、产生什么影响”；按背景—内容—作用三层作答。',
  '结论': '常考结论与史实的对应关系；特别留意“主要 / 根本 / 开始 / 完成”等程度词。',
  '对比': '常考异同点；先列比较维度，再分栏写相同点与不同点，最后落到影响。',
  '政策工具': '常考目的、内容、实施效果；先判断政策要解决什么问题，再看手段与结果。',
  '公式': '常考适用条件与计算步骤；先写公式，再代数据，最后检查单位与方向。',
};
const GENERIC_HINT = '选择题先抓时间、主体、程度词；材料题按“背景—内容—影响”作答。';

const ATTENTION_MARKS = ['最早', '首先', '标志', '开始', '完成', '主要', '根本', '直接', '间接', '不是', '并非', '唯一', '彻底', '转折', '取代', '奠定'];
const USER_KEY = 'hs.user.v1';

function readUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    const u = raw ? JSON.parse(raw) : null;
    return u && typeof u === 'object' ? u : { version: 1, notes: {} };
  } catch (e) {
    return null;
  }
}

function readNote(id) {
  const u = readUser();
  return u?.notes?.[id]?.text || '';
}

function persistNote(id, text) {
  const u = readUser();
  if (!u) return false;
  u.version = u.version || 1;
  u.notes = u.notes && typeof u.notes === 'object' ? u.notes : {};
  const clean = String(text || '');
  if (clean.trim()) u.notes[id] = { text: clean, updatedAt: Date.now() };
  else delete u.notes[id];
  u.updatedAt = Date.now();
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    return true;
  } catch (e) {
    return false;
  }
}


function fmtPage(p) {
  if (p.page && p.pdfPage) return `书页 ${p.page} · PDF ${p.pdfPage}`;
  if (p.page) return `书页 ${p.page}`;
  if (p.pdfPage) return `PDF ${p.pdfPage}`;
  return '未定位';
}

function yearLabel(y) {
  if (y == null) return '未标年份';
  return y < 0 ? `前 ${-y} 年` : `${y} 年`;
}

function findPath(books, p) {
  const roots = books?.books?.[0]?.volumes || books?.volumes || [];
  for (const v of roots) {
    for (const part of v.parts || []) {
      for (const u of part.units || []) {
        for (const l of u.lessons || []) {
          if (l.code === p.lesson || l.code === p.unit) {
            return {
              vol: v.title || '',
              part: part.title || '',
              unit: u.title || '',
              lesson: l.title || '',
              lessonNo: l.no || '',
              lessonCode: l.code || p.lesson || '',
              page: l.page || p.page || '',
              pdfPage: l.pdfPage || p.pdfPage || '',
            };
          }
        }
      }
    }
  }
  return { vol: '', part: '', unit: p.unitTitle || p.unit || '', lesson: p.lessonTitle || p.lesson || '', lessonNo: '', lessonCode: p.lesson || '', page: p.page || '', pdfPage: p.pdfPage || '' };
}

function attentionItems(p) {
  const text = String(p.content || '');
  const found = text.split(/[；。]/).map(s => s.trim()).filter(Boolean)
    .filter(s => ATTENTION_MARKS.some(m => s.includes(m)));
  const uniq = [];
  for (const s of found) {
    if (!uniq.some(x => x.replace(/\s/g, '') === s.replace(/\s/g, ''))) uniq.push(s);
  }
  const items = uniq.slice(0, 3).map(s => `原文强调“${s}”，注意把时间、主体和程度词对应准确，不要互换。`);
  if (items.length < 3) {
    items.push('题干出现“最早 / 标志 / 开始 / 完成”时，先回原文核对，不要凭印象。');
  }
  if (items.length < 3) {
    items.push('把本条放回它所在的单元与课次里记：先记前后事件，再记本条在中间的作用。');
  }
  return items.slice(0, 3);
}

function highlight(text, keywords) {
  let html = esc(text);
  for (const k of (keywords || []).slice().sort((a, b) => b.length - a.length)) {
    if (!k || k.length < 2) continue;
    const safe = esc(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(safe, 'g'), `<span class="mark">${esc(k)}</span>`);
  }
  return html;
}

function renderError(message) {
  $('#detailTitle').textContent = '这条考点没有找到';
  $('#detailLede').textContent = message;
  $('#detailBadges').innerHTML = '';
  $('#detailPaper').innerHTML = `<div class="no-quote">可能是链接里的知识点 ID 不完整。回到知识库重新选一条，或从时间线点事件进入。</div>
    <div class="side-actions" style="margin-top:14px"><a class="btn primary" href="index.html">回知识库</a></div>`;
  $('#detailSide').innerHTML = '';
  ['#fileVol', '#fileUnit', '#fileLesson'].forEach(id => { const el = $(id); if (el) el.textContent = '—'; });
}

async function boot() {
  const id = new URLSearchParams(location.search).get('id') || '';
  let knowledge = [];
  let timeline = { eras: [] };
  let books = {};
  try {
    const [k, t, b] = await Promise.all([
      fetch('data/knowledge.json').then(r => { if (!r.ok) throw new Error('知识点 HTTP ' + r.status); return r.json(); }),
      fetch('data/timeline.json').then(r => r.ok ? r.json() : { eras: [] }).catch(() => ({ eras: [] })),
      fetch('data/books.json').then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]);
    knowledge = Array.isArray(k) ? k : [];
    timeline = t || { eras: [] };
    books = b || {};
  } catch (err) {
    renderError('数据加载失败：' + err.message);
    return;
  }

  let p = knowledge.find(x => x.id === id);
  if (!p) {
    try {
      const last = JSON.parse(localStorage.getItem('hs.user.v1') || '{}')?.config?.lastSel;
      p = knowledge.find(x => x.id === last);
    } catch (e) {}
  }
  if (!p) p = knowledge[0];
  if (!p) { renderError('知识点数据为空。'); return; }

  const path = findPath(books, p);
  const allEvents = (timeline.eras || []).flatMap(e => (e.items || []).map(it => ({ ...it, eraName: e.name })));
  const events = allEvents.filter(it => it.id === p.id).concat(
    allEvents.filter(it => it.id !== p.id && it.lesson === p.lesson)
  ).sort((a, b) => (a.year || 0) - (b.year || 0)).slice(0, 5);
  const related = knowledge.filter(x => x.lesson === p.lesson && x.id !== p.id).slice(0, 8);
  const keywords = p.keywords || [];

  document.title = `${p.title} · 知识点解析`;
  $('#detailTitle').textContent = p.title;
  $('#detailLede').innerHTML = highlight(p.content || '', keywords);
  $('#fileVol').textContent = path.vol || '高中三年历史知识清单';
  $('#fileUnit').textContent = path.unit || '—';
  $('#fileLesson').textContent = path.lesson ? `${path.lessonNo ? '第 ' + path.lessonNo + ' 课 · ' : ''}${path.lesson}` : '—';
  $('#detailBadges').innerHTML = `
    <span class="badge gold">${p.excerpt ? '原文摘录' : '考点归纳'}</span>
    <span class="badge">${esc(p.type || '考点')}</span>
    <span class="badge">难度 ${'★'.repeat(p.difficulty || 0) || '未标'}</span>
    <span class="badge">${esc(path.unit || '未归单元')}</span>`;

  const exam = p.commonq || TYPE_HINTS[p.type] || GENERIC_HINT;
  const notes = attentionItems(p);
  const myNote = readNote(p.id);

  const relatedHTML = related.length
    ? related.map(x => `<a class="network-card" href="detail.html?id=${encodeURIComponent(x.id)}">
        <strong>${esc(x.title)}</strong><span>${esc(x.content || '')}</span>
      </a>`).join('')
    : '<div class="side-empty">本课暂时没有其他知识点。</div>';

  const eventsHTML = events.length
    ? events.map(e => `<a href="timeline.html?q=${encodeURIComponent(e.title)}">
        <span class="y">${e.when || yearLabel(e.year)}</span>
        <span class="t">${esc(e.title)}</span>
      </a>`).join('')
    : '<div class="side-empty">这条考点没有单独列入纪年事件；它更像一条需要理解的结论。</div>';

  $('#detailPaper').innerHTML = `
    <section class="paper-section">
      <div class="sec-head"><span class="sec-no">01</span><h2>原文依据</h2><span class="rule"></span></div>
      ${p.excerpt ? `<div class="quote">${esc(p.excerpt)}<span class="quote-src">—— ${esc((p.source || '高中三年历史知识清单').replace(/[·,，]\s*p\d+\s*$/i, ''))}</span></div>`
        : `<div class="no-quote">这条是“考点归纳”，原页是扫描件，没有可逐字引用的正文。下面用清单里的要点与关键词展开，不虚构原文。</div>`}
    </section>

    <section class="paper-section">
      <div class="sec-head"><span class="sec-no">02</span><h2>展开解析</h2><span class="rule"></span></div>
      <p class="paper-text">${highlight(p.content || '', keywords)}</p>
      <p class="paper-text" style="margin-top:12px">它在体系里的位置：${esc(path.part || '本册')} · ${esc(path.unit || '本单元')} · ${esc(path.lesson || '本课')}。记这条时，先把它前后的时间线事件串起来，再记它在中间起的作用。</p>
      <div class="kw-row" style="margin-top:14px">${keywords.map(k => `<span class="kw">${esc(k)}</span>`).join('') || '<span class="kw">暂无关键词</span>'}</div>
    </section>

    <section class="paper-section">
      <div class="sec-head"><span class="sec-no">03</span><h2>可能怎么考</h2><span class="rule"></span></div>
      <div class="exam-box"><span class="label">EXAM ANGLE · 出题角度</span>${esc(exam)}</div>
      ${p.commonq ? '' : '<div class="note-line">本条没有单独标注题型；先按上面的通用角度准备，遇到具体材料再补。</div>'}
    </section>

    <section class="paper-section">
      <div class="sec-head"><span class="sec-no">04</span><h2>注意点</h2><span class="rule"></span></div>
      <ul class="attention-list">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
    </section>

    <section class="paper-section">
      <div class="sec-head"><span class="sec-no">05</span><h2>同课知识网络</h2><span class="rule"></span></div>
      <div class="network-grid">${relatedHTML}</div>
    </section>

    <section class="paper-section note-section" id="myNote">
      <div class="sec-head"><span class="sec-no">06</span><h2>我的笔记</h2><span class="rule"></span></div>
      <div class="note-editor">
        <textarea id="noteInput" rows="7" placeholder="写下你的理解、易错点、联想法…">${esc(myNote)}</textarea>
        <div class="note-foot">
          <span class="note-state" id="noteState">${myNote ? '已保存' : '自动保存到本机'}</span>
          <button class="note-clear" id="noteClear" type="button">清空笔记</button>
        </div>
      </div>
      <p class="note-help">这条笔记只保存在本机浏览器，并与知识库主站的「我的笔记」共用同一份数据；导出备份时会一起带走。</p>
    </section>
  `;

  $('#detailSide').innerHTML = `
    <section class="side-card">
      <h3>速览</h3>
      <div class="side-list">
        <div class="side-row"><span>类型</span><b>${esc(p.type || '—')}</b></div>
        <div class="side-row"><span>难度</span><b>${'★'.repeat(p.difficulty || 0) || '未标'}</b></div>
        <div class="side-row"><span>关键词</span><b>${keywords.length} 个</b></div>
      </div>
    </section>
    <section class="side-card">
      <h3>时间线坐标</h3>
      <div class="timeline-mini">${eventsHTML}</div>
    </section>
    <section class="side-card">
      <h3>操作</h3>
      <div class="side-actions">
        <a class="btn primary" href="index.html?focus=${encodeURIComponent(p.id)}">回知识库定位</a>
        <button class="btn" id="jumpNote" type="button">写 / 看我的笔记</button>
        <a class="btn" href="timeline.html?q=${encodeURIComponent(p.title)}">在时间线里看</a>
        <button class="btn" id="copyLink">复制本页链接</button>
      </div>
    </section>
  `;

  $('#backIndex').href = 'index.html?focus=' + encodeURIComponent(p.id);
  $('#backToList').href = 'index.html?focus=' + encodeURIComponent(p.id);
  $('#detailUpdated').textContent = new Date().toLocaleDateString('zh-CN');

  $('#copyLink')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      showToast('已复制本页链接');
    } catch (e) {
      showToast('复制失败，请手动复制地址栏');
    }
  });

  const noteInput = $('#noteInput');
  const noteState = $('#noteState');
  if (noteInput) {
    let noteTimer = 0;
    const saveNote = () => {
      clearTimeout(noteTimer);
      const ok = persistNote(p.id, noteInput.value);
      if (noteState) noteState.textContent = ok ? '已保存' : '保存失败，请检查浏览器存储';
      return ok;
    };
    noteInput.addEventListener('input', () => {
      if (noteState) noteState.textContent = '输入中…';
      clearTimeout(noteTimer);
      noteTimer = setTimeout(saveNote, 600);
    });
    window.addEventListener('beforeunload', saveNote);
    $('#noteClear')?.addEventListener('click', () => {
      if (!noteInput.value) return;
      if (!confirm('清空这条笔记？')) return;
      noteInput.value = '';
      saveNote();
      showToast('笔记已清空');
    });
    $('#jumpNote')?.addEventListener('click', () => {
      $('#myNote')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => noteInput.focus(), 260);
    });
  }
}

let toastTimer = 0;
function showToast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

boot();
