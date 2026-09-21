// 每日任務彙整的純邏輯（不依賴 Firebase，方便單獨測試）
// dueDate 是網頁 datetime-local 存的台灣當地時間字串 "YYYY-MM-DDTHH:mm"，沒有時區資訊，一律當作台灣時間 (UTC+8)。
const TZ_OFFSET_MS = 8 * 3600 * 1000;
const MAX_ITEMS = 30;    // 每個區塊最多列幾項，避免超過 LINE 單則訊息 5000 字上限
const MAX_TITLE = 60;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

const taipei = (ms) => new Date(ms + TZ_OFFSET_MS);
const todayStr = (ms) => taipei(ms).toISOString().slice(0, 10);

const cutTitle = (t) => {
  const s = (t || '').trim().replace(/\s+/g, ' ') || '(無標題)';
  return s.length > MAX_TITLE ? s.slice(0, MAX_TITLE) + '…' : s;
};

const byDue = (a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0);

const listLines = (items, fmt) => {
  const lines = items.slice(0, MAX_ITEMS).map(fmt);
  if (items.length > MAX_ITEMS) lines.push(`…另有 ${items.length - MAX_ITEMS} 項`);
  return lines;
};

// 回傳要傳給 LINE 的文字；今天沒有任何要處理的任務就回傳 null（不傳空訊息）
function buildDigest(tasks, nowMs) {
  const today = todayStr(nowMs);
  const open = tasks.filter((t) => !t.done && !t.deleted && t.dueDate);
  const overdue = open.filter((t) => t.dueDate.slice(0, 10) < today).sort(byDue);
  const todays = open.filter((t) => t.dueDate.slice(0, 10) === today).sort(byDue);
  if (!overdue.length && !todays.length) return null;

  const d = taipei(nowMs);
  const parts = [`📋 今日任務 ${d.getUTCMonth() + 1}/${d.getUTCDate()}（週${WEEK[d.getUTCDay()]}）`];
  if (todays.length) {
    parts.push('', `今天到期（${todays.length}）`,
      ...listLines(todays, (t) => `• ${t.dueDate.slice(11, 16) || '全天'} ${cutTitle(t.title)}`));
  }
  if (overdue.length) {
    parts.push('', `⚠️ 已逾期（${overdue.length}）`,
      ...listLines(overdue, (t) => `• ${Number(t.dueDate.slice(5, 7))}/${Number(t.dueDate.slice(8, 10))} ${cutTitle(t.title)}`));
  }
  return parts.join('\n');
}

module.exports = { TZ_OFFSET_MS, todayStr, buildDigest };
