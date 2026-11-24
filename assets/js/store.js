/* ============================================================
   store.js —— 用户数据、快照、导入导出
   静态数据（data/*.json）与用户数据（localStorage）严格分离。
   ============================================================ */

const KEY_USER = 'hs.user.v1';
const KEY_SNAP = 'hs.snapshots.v1';
const SCHEMA = 'history-study-hub/v1';
export const MAX_SNAPSHOTS = 5;

export function emptyUser() {
  return {
    version: 1,
    notes: {},        // kid -> {text, updatedAt}
    reviews: {},      // kid -> ['YYYY-MM-DD', ...]
    status: {},       // kid -> {state:'mastered'|'review', updatedAt}
    customs: [],      // 自定义知识点
    mistakes: [],     // 错题
    config: { lastBackup: null, expanded: {} },
    updatedAt: Date.now(),
  };
}

function safeParse(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

export function loadUser() {
  const u = safeParse(localStorage.getItem(KEY_USER), null);
  if (!u || typeof u !== 'object') return emptyUser();
  const base = emptyUser();
  return {
    ...base,
    ...u,
    notes: u.notes && typeof u.notes === 'object' ? u.notes : {},
    reviews: u.reviews && typeof u.reviews === 'object' ? u.reviews : {},
    status: u.status && typeof u.status === 'object' ? u.status : {},
    customs: Array.isArray(u.customs) ? u.customs : [],
    mistakes: Array.isArray(u.mistakes) ? u.mistakes : [],
    config: { ...base.config, ...(u.config || {}) },
  };
}

export function saveUser(u) {
  u.updatedAt = Date.now();
  try {
    localStorage.setItem(KEY_USER, JSON.stringify(u));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('hs:user-saved', { detail: { updatedAt: u.updatedAt } }));
    }
    return true;
  } catch (e) {
    console.warn('保存失败', e);
    return false;
  }
}

/* ---------- 快照 ---------- */
export function listSnapshots() {
  const arr = safeParse(localStorage.getItem(KEY_SNAP), []);
  return Array.isArray(arr) ? arr : [];
}

export function takeSnapshot(u, reason) {
  const arr = listSnapshots();
  const snap = {
    id: 'S' + Date.now() + Math.random().toString(36).slice(2, 6),
    at: Date.now(),
    reason: reason || '手动快照',
    counts: {
      notes: Object.keys(u.notes || {}).length,
      customs: (u.customs || []).length,
      mistakes: (u.mistakes || []).length,
      reviewDays: new Set(Object.values(u.reviews || {}).flatMap(arr => Array.isArray(arr) ? arr : [])).size,
    },
    data: JSON.parse(JSON.stringify({
      notes: u.notes, reviews: u.reviews, status: u.status, customs: u.customs,
      mistakes: u.mistakes, config: u.config, version: 1,
    })),
  };
  arr.unshift(snap);
  const keep = arr.slice(0, MAX_SNAPSHOTS);
  // 配额不足时，从最旧的开始丢
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      localStorage.setItem(KEY_SNAP, JSON.stringify(keep));
      return snap;
    } catch {
      keep.pop();
      if (!keep.length) return null;
    }
  }
  return null;
}

export function restoreSnapshot(id) {
  const arr = listSnapshots();
  const snap = arr.find(s => s.id === id);
  return snap ? JSON.parse(JSON.stringify(snap.data)) : null;
}

/* ---------- 导入 / 导出 ---------- */
export function exportPayload(u) {
  return {
    schema: SCHEMA,
    app: '历史知识库',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      notes: u.notes, reviews: u.reviews, status: u.status, customs: u.customs,
      mistakes: u.mistakes, config: u.config,
    },
  };
}

export function validateImport(obj) {
  if (!obj || typeof obj !== 'object') return '文件不是 JSON 对象';
  if (obj.schema !== SCHEMA) return '不是本工具导出的备份（schema 不匹配）';
  const d = obj.data;
  if (!d || typeof d !== 'object') return '备份缺少 data 字段';
  if (d.notes && typeof d.notes !== 'object') return 'notes 字段格式错误';
  if (d.status && typeof d.status !== 'object') return 'status 字段格式错误';
  if (d.reviews && typeof d.reviews !== 'object') return 'reviews 字段格式错误';
  if (d.customs && !Array.isArray(d.customs)) return 'customs 字段格式错误';
  if (d.mistakes && !Array.isArray(d.mistakes)) return 'mistakes 字段格式错误';
  for (const c of (d.customs || [])) {
    if (!c || typeof c.id !== 'string' || typeof c.title !== 'string') return '自定义知识点缺少 id/title';
  }
  for (const m of (d.mistakes || [])) {
    if (!m || typeof m.id !== 'string' || typeof m.stem !== 'string') return '错题缺少 id/stem';
  }
  return '';
}

function newer(a, b) {
  return (a?.updatedAt || 0) >= (b?.updatedAt || 0) ? a : b;
}

export function mergeUser(local, incoming) {
  const out = JSON.parse(JSON.stringify(local));
  const inc = incoming || {};
  out.notes = out.notes || {};
  for (const [k, v] of Object.entries(inc.notes || {})) {
    if (!/^[\w\-:.]+$/.test(k)) continue;
    out.notes[k] = newer(out.notes[k], v);
  }
  out.reviews = out.reviews || {};
  for (const [k, arr] of Object.entries(inc.reviews || {})) {
    if (!/^[\w\-:.]+$/.test(k) || !Array.isArray(arr)) continue;
    const dates = new Set([...(out.reviews[k] || []), ...arr.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x))]);
    if (dates.size) out.reviews[k] = [...dates].sort();
  }
  out.status = out.status || {};
  for (const [k, v] of Object.entries(inc.status || {})) {
    if (!/^[\w\-:.]+$/.test(k)) continue;
    out.status[k] = newer(out.status[k], v);
  }
  const mergeList = (cur, add) => {
    const map = new Map(cur.map(x => [x.id, x]));
    for (const x of add) {
      if (!x || typeof x.id !== 'string') continue;
      map.set(x.id, map.has(x.id) ? newer(map.get(x.id), x) : x);
    }
    return [...map.values()];
  };
  out.customs = mergeList(out.customs || [], inc.customs || []);
  out.mistakes = mergeList(out.mistakes || [], inc.mistakes || []);
  out.config = { ...(out.config || {}), ...(inc.config || {}) };
  out.config.lastBackup = Math.max(out.config.lastBackup || 0, inc.config?.lastBackup || 0) || null;
  out.updatedAt = Date.now();
  return out;
}

export function overwriteUser(incoming) {
  const out = emptyUser();
  out.notes = incoming.notes || {};
  out.reviews = incoming.reviews || {};
  out.status = incoming.status || {};
  out.customs = incoming.customs || [];
  out.mistakes = incoming.mistakes || [];
  out.config = { ...out.config, ...(incoming.config || {}) };
  return out;
}

/* ---------- 下载 ---------- */
export function download(filename, content, mime = 'application/octet-stream') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ---------- CSV / Markdown ---------- */
const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function mistakesToCSV(mistakes, resolveTitle) {
  const head = ['id', '题干', '我的答案', '正确答案', '错因分类', '关联知识点', '错误次数', '上次复习日', '下次复习日'];
  const rows = mistakes.map(m => [
    m.id, m.stem, m.myAnswer, m.correctAnswer, m.reason,
    resolveTitle(m.kid) || '', m.count, m.lastReview, m.nextReview,
  ]);
  return '\ufeff' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}

export function knowledgeToMD(points, notes) {
  const groups = new Map();
  for (const p of points) {
    const k = p.source.split('·').slice(0, 3).join('·');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  let md = '# 历史知识点导出\n\n';
  md += `导出时间：${new Date().toLocaleString('zh-CN')}\n\n`;
  for (const [g, arr] of groups) {
    md += `## ${g}\n\n`;
    for (const p of arr) {
      md += `### ${p.title}\n\n${p.content}\n\n`;
      md += `> ${p.excerpt}\n>\n> —— ${p.source}\n\n`;
      md += `标签：${(p.keywords || []).join(' / ')}　类型：${p.type}　难度：${p.difficulty}\n\n`;
      if (notes?.[p.id]?.text) md += `我的笔记：${notes[p.id].text}\n\n`;
    }
  }
  return md;
}
