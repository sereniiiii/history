/* ============================================================
   review.js —— 复习记录与月视图（主站 / 解析页共用）
   数据：hs.user.v1.reviews[kid] = ['YYYY-MM-DD', ...]
   ============================================================ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function todayKey() {
  return dateKey(new Date());
}

export function isDateKey(value) {
  return typeof value === 'string' && DATE_RE.test(value);
}

export function getReviewDates(user, id) {
  const raw = user?.reviews?.[id];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isDateKey))].sort();
}

export function isReviewedToday(user, id, day = todayKey()) {
  return getReviewDates(user, id).includes(day);
}

export function toggleReviewToday(user, id, day = todayKey()) {
  if (!user) return { reviewed: false, dates: [] };
  user.reviews = user.reviews && typeof user.reviews === 'object' ? user.reviews : {};
  const dates = getReviewDates(user, id);
  const had = dates.includes(day);
  const next = had ? dates.filter(d => d !== day) : [...dates, day].sort();
  if (next.length) user.reviews[id] = next;
  else delete user.reviews[id];
  user.updatedAt = Date.now();
  return { reviewed: !had, dates: next };
}

export function monthReviewCount(dates, year, month) {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  return (dates || []).filter(d => d.startsWith(prefix)).length;
}

export function reviewStats(user, id, now = new Date()) {
  const dates = getReviewDates(user, id);
  return {
    total: dates.length,
    month: monthReviewCount(dates, now.getFullYear(), now.getMonth()),
    last: dates.length ? dates[dates.length - 1] : '',
  };
}

export function monthLabel(year, month) {
  return `${year} 年 ${month + 1} 月`;
}

export function calendarMarkup(year, month, dates = [], today = todayKey()) {
  const reviewed = new Set(dates);
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push('<span class="review-cell empty" aria-hidden="true"></span>');
  for (let d = 1; d <= days; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cls = ['review-cell', reviewed.has(key) ? 'reviewed' : '', key === today ? 'today' : ''].filter(Boolean).join(' ');
    cells.push(`<span class="${cls}" data-date="${key}" title="${key}${reviewed.has(key) ? ' · 已复习' : ''}">${d}</span>`);
  }
  while (cells.length % 7) cells.push('<span class="review-cell empty" aria-hidden="true"></span>');

  return `<div class="review-cal-head">
      <button type="button" class="review-nav" data-cal-shift="-1" aria-label="上个月">‹</button>
      <strong>${monthLabel(year, month)}</strong>
      <button type="button" class="review-nav" data-cal-shift="1" aria-label="下个月">›</button>
    </div>
    <div class="review-week" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
    <div class="review-grid">${cells.join('')}</div>
    <div class="review-legend"><i></i><span>深色 = 已复习</span></div>`;
}
