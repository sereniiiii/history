/* ============================================================
   search-worker.js —— 倒排索引 + 同义词 + 拼音首字母 + 模糊兜底
   主线程只负责输入与渲染，检索计算全部在 Worker 内完成。
   ============================================================ */

let docs = [];
let aliasGroups = [];
let pinyinMap = {};
const aliasMap = new Map();     // 词 -> 同组全部词
const bigram = new Map();       // 二元组 -> doc 下标集合
let initialsCache = [];

const norm = s => String(s || '').toLowerCase()
  .replace(/[^\u4e00-\u9fffa-z0-9]/g, '');

function addBigrams(text, di) {
  const t = norm(text);
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    if (!bigram.has(g)) bigram.set(g, new Set());
    bigram.get(g).add(di);
  }
}

function initialsOf(text) {
  let out = '';
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) out += (pinyinMap[ch] || '');
    else if (/[a-z0-9]/.test(ch)) out += ch;
  }
  return out;
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    docs = msg.points || [];
    aliasGroups = msg.aliasGroups || [];
    pinyinMap = msg.pinyin || {};

    aliasMap.clear();
    for (const g of aliasGroups) {
      const arr = g.map(norm).filter(Boolean);
      for (const t of arr) {
        if (!aliasMap.has(t)) aliasMap.set(t, new Set());
        for (const o of arr) if (o !== t) aliasMap.get(t).add(o);
      }
    }

    bigram.clear();
    initialsCache = docs.map((d, di) => {
      const title = norm(d.title);
      const kws = norm((d.keywords || []).join(''));
      const body = norm(d.content) + norm(d.excerpt) + norm(d.lessonTitle);
      addBigrams(title, di);
      addBigrams(kws, di);
      addBigrams(body, di);
      return {
        title,
        kws,
        body,
        all: title + kws + body,
        ini: initialsOf(d.title),
        kwIni: initialsOf((d.keywords || []).join('')),
      };
    });
    self.postMessage({ type: 'ready', count: docs.length });
    return;
  }

  if (msg.type === 'search') {
    const raw = String(msg.q || '');
    const t0 = performance.now();
    const q = norm(raw);
    if (!q) {
      self.postMessage({ type: 'results', q: raw, items: [], nearest: [], ms: 0 });
      return;
    }

    // 同义词扩展：完全包含或互为别名
    const variants = new Set([q]);
    for (const [term, aliases] of aliasMap) {
      if (q.includes(term) || q === term) {
        for (const a of aliases) variants.add(q.split(term).join(a));
      }
    }

    const scores = new Map(); // di -> {score, field}
    const sourceTerms = variants.size > 1 ? [...variants] : [q];
    const terms = q.split(/\s+/).filter(Boolean);

    for (const di in docs) {
      const idx = initialsCache[di];
      let best = 0, field = '';
      for (const t of sourceTerms) {
        if (idx.title.includes(t)) {
          const s = 100 + (idx.title.startsWith(t) ? 25 : 0) + Math.min(20, t.length * 2);
          if (s > best) { best = s; field = 'title'; }
        }
        if (idx.kws.includes(t)) {
          const s = 62 + (idx.kws.startsWith(t) ? 8 : 0);
          if (s > best) { best = s; field = 'keywords'; }
        }
        if (idx.body.includes(t)) {
          const pos = idx.body.indexOf(t);
          const s = 40 - Math.min(15, pos / 40);
          if (s > best) { best = s; field = 'excerpt'; }
        }
        if (idx.ini.includes(t)) {
          const s = 58 + (idx.ini.startsWith(t) ? 10 : 0);
          if (s > best) { best = s; field = 'pinyin'; }
        }
        if (idx.kwIni && idx.kwIni.includes(t)) {
          const s = 30;
          if (s > best) { best = s; field = 'pinyin'; }
        }
      }
      // 多词：额外加权，要求至少命中一个
      if (terms.length > 1) {
        let hit = 0;
        for (const t of terms) if (idx.all.includes(t) || idx.ini.includes(t)) hit++;
        if (hit === 0) best = 0;
        else best += hit * 8;
      }
      if (best > 0) scores.set(Number(di), { score: best, field });
    }

    const items = [...scores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 60)
      .map(([di, s]) => ({ id: docs[di].id, score: +s.score.toFixed(2), field: s.field }));

    // 空结果：用二元组相似度找最相近 5 条
    let nearest = [];
    if (!items.length) {
      const qg = new Set();
      for (let i = 0; i < q.length - 1; i++) qg.add(q.slice(i, i + 2));
      const cand = new Map();
      for (const g of qg) for (const di of (bigram.get(g) || [])) {
        cand.set(di, (cand.get(di) || 0) + 1);
      }
      nearest = [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([di, hits]) => ({ id: docs[di].id, score: hits }));
      if (!nearest.length) {
        nearest = docs.slice(0, 5).map(d => ({ id: d.id, score: 0 }));
      }
    }

    self.postMessage({
      type: 'results', q: raw, items, nearest,
      ms: +(performance.now() - t0).toFixed(2),
    });
  }
};
