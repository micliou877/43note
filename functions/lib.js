// 每日任務彙整的純邏輯（不依賴 Firebase，方便單獨測試）
// dueDate 是網頁 datetime-local 存的台灣當地時間字串 "YYYY-MM-DDTHH:mm"，沒有時區資訊，一律當作台灣時間 (UTC+8)。
const TZ_OFFSET_MS = 8 * 3600 * 1000;
const MAX_ITEMS = 30;    // 每個區塊最多列幾項，避免超過 LINE 單則訊息 5000 字上限
const MAX_TITLE = 60;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

const taipei = (ms) => new Date(ms + TZ_OFFSET_MS);
const taipeiNow = taipei;
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

// 網頁筆記內文是 contentEditable 的 HTML（舊筆記可能是純文字），轉成一般文字以便搜尋
const htmlToText = (html) =>
  (html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{2,}/g, '\n')
    .trim();

const SNIPPET_RADIUS = 20;
const MAX_RESULTS = 8;

// 在筆記標題＋內文裡找關鍵字（多個關鍵字用空白隔開，必須全部出現；不分大小寫）
// notes: [{ title, body(HTML), projectName, updatedMs }]；回傳要傳給 LINE 的文字
function buildSearchResult(notes, keywordText) {
  const keywords = keywordText.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const n of notes) {
    const title = (n.title || '').replace(/\s+/g, ' ').trim();
    const body = htmlToText(n.body);
    const hay = `${title}\n${body}`.toLowerCase();
    if (!keywords.every((k) => hay.includes(k))) continue;

    // 摘要：優先取內文中第一個出現的關鍵字附近的文字；只有標題命中就不附摘要
    const flat = body.replace(/\s*\n\s*/g, ' ⏎ ');
    const flatLow = flat.toLowerCase();
    const pos = keywords.map((k) => flatLow.indexOf(k)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    let snippet = '';
    if (pos != null) {
      const from = Math.max(0, pos - SNIPPET_RADIUS);
      const to = Math.min(flat.length, pos + keywords[0].length + SNIPPET_RADIUS);
      snippet = `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
    }
    hits.push({ title: title || '(無標題)', project: n.projectName, snippet, updatedMs: n.updatedMs || 0 });
  }
  if (!hits.length) return `找不到包含「${keywords.join(' ')}」的筆記`;

  hits.sort((a, b) => b.updatedMs - a.updatedMs);
  const parts = [`🔍 「${keywords.join(' ')}」找到 ${hits.length} 則筆記`];
  for (const h of hits.slice(0, MAX_RESULTS)) {
    parts.push('', `📝 ${cutTitle(h.title)}`, `　專案：${h.project || '(未分類)'}`);
    if (h.snippet) parts.push(`　${h.snippet}`);
  }
  if (hits.length > MAX_RESULTS) parts.push('', `…另有 ${hits.length - MAX_RESULTS} 則，請加上更多關鍵字縮小範圍`);
  return parts.join('\n');
}

module.exports = { TZ_OFFSET_MS, taipeiNow, todayStr, buildDigest, htmlToText, buildSearchResult };
