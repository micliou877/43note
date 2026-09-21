// LINE 訊息指令解析（純邏輯，不依賴 Firebase）。
// 支援：新增 標題 [日期] [時間] [@專案]、筆記 標題\n內文、搜尋 關鍵字、今天、規則。日期/時間必須是「以空白隔開的獨立詞」才會被辨識。
const { taipeiNow, todayStr } = require('./lib');

const pad = (n) => String(n).padStart(2, '0');
const addDays = (dateStr, n) => new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const DEFAULT_TIME = '03:00';
const WD = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

const validDate = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

// 回傳 YYYY-MM-DD 或 null
function parseDateToken(tok, today) {
  const wd = new Date(today + 'T00:00:00Z').getUTCDay();
  if (/^(今天|今日)$/.test(tok)) return today;
  if (/^(明天|明日)$/.test(tok)) return addDays(today, 1);
  if (tok === '後天') return addDays(today, 2);
  if (tok === '大後天') return addDays(today, 3);

  let m = tok.match(/^(下)?(?:週|周|星期|禮拜)([一二三四五六日天])$/);
  if (m) {
    const target = WD[m[2]];
    if (m[1]) {
      const toNextMon = (8 - wd) % 7 || 7;              // 距離下週一幾天
      return addDays(today, toNextMon + ((target + 6) % 7));
    }
    return addDays(today, (target - wd + 7) % 7 || 7);  // 「週三」= 之後最近的週三（不含今天）
  }

  m = tok.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (m) return validDate(+m[1], +m[2], +m[3]) ? `${m[1]}-${pad(+m[2])}-${pad(+m[3])}` : null;

  m = tok.match(/^(\d{1,2})[\/-](\d{1,2})$/) || tok.match(/^(\d{1,2})月(\d{1,2})[日號]?$/);
  if (m) {
    const mo = +m[1], d = +m[2];
    let y = +today.slice(0, 4);
    if (!validDate(y, mo, d)) return null;
    let s = `${y}-${pad(mo)}-${pad(d)}`;
    if (s < today) { y += 1; if (!validDate(y, mo, d)) return null; s = `${y}-${pad(mo)}-${pad(d)}`; } // 已過的日期視為明年
    return s;
  }
  return null;
}

// 回傳 "HH:mm" 或 null
function parseTimeToken(tok) {
  const m = tok.match(/^(上午|早上|中午|下午|晚上)?(\d{1,2})(?::(\d{2})|點(半|(\d{1,2})分?)?)$/);
  if (!m) return null;
  let h = +m[2];
  const min = m[3] != null ? +m[3] : m[4] === '半' ? 30 : m[5] != null ? +m[5] : 0;
  if ((m[1] === '下午' || m[1] === '晚上') && h < 12) h += 12;
  if (m[1] === '中午' && h < 11) h += 12;
  if ((m[1] === '上午' || m[1] === '早上') && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

function parseCommand(rawText, nowMs) {
  const text = (rawText || '').replace(/\u3000/g, ' ').trim();
  if (/^(今天|今日|清單|list|today)$/i.test(text)) return { cmd: 'today' };
  if (/^(規則|說明|幫助|help|\?|？)$/i.test(text)) return { cmd: 'rules' };

  // 搜尋筆記：搜尋 關鍵字1 [關鍵字2 ...]（只打「搜尋」沒有關鍵字 → 用法提示）
  const sm = text.match(/^(?:搜尋|搜索|查詢|找|search|find)\s+(\S[\s\S]*)$/i);
  if (sm) return { cmd: 'search', keyword: sm[1].trim() };

  // 筆記：第一行是標題（可含 @專案），其餘各行是內文
  const nm = text.match(/^(?:筆記|note)\s+([\s\S]+)$/i);
  if (nm) {
    const lines = nm[1].replace(/\r\n?/g, '\n').split('\n');
    let project = null;
    const title = lines[0].split(/\s+/).filter((tok) => {
      if (/^[@＠]./.test(tok) && project == null) { project = tok.slice(1); return false; }
      return true;
    }).join(' ').trim();
    if (!title) return { cmd: 'help' };
    return { cmd: 'note', title, body: lines.slice(1).join('\n').trim(), project };
  }

  const m = text.match(/^(?:新增|add)\s+([\s\S]+)$/i) || text.match(/^[+＋]\s*([\s\S]+)$/);
  if (!m) {
    // 只打了指令關鍵字沒有內容 → 給用法提示；其他認不出的文字 → 讓呼叫端問使用者要當任務還是筆記
    if (!text || /^(新增|add|筆記|note|搜尋|搜索|查詢|找|search|find|[+＋])$/i.test(text)) return { cmd: 'help' };
    return { cmd: 'ask', text };
  }

  const today = todayStr(nowMs);
  let date = null, time = null, project = null;
  const rest = [];
  // 「明天下午3點」「週三15:00」這種日期加時間連寫的詞，先拆成兩個詞再辨識
  const tokens = m[1].split(/\s+/).flatMap((tok) => {
    const j = tok.match(/^(今天|今日|明天|明日|後天|大後天|下?(?:週|周|星期|禮拜)[一二三四五六日天])(.+)$/);
    return j && parseTimeToken(j[2]) ? [j[1], j[2]] : [tok];
  });
  for (const tok of tokens) {
    if (/^[@＠]./.test(tok) && project == null) { project = tok.slice(1); continue; }
    if (date == null) { const d = parseDateToken(tok, today); if (d) { date = d; continue; } }
    if (time == null) { const t = parseTimeToken(tok); if (t) { time = t; continue; } }
    rest.push(tok);
  }
  const title = rest.join(' ').trim();
  if (!title) return { cmd: 'help' };

  let dueDate = null;
  if (date || time) {
    let d = date, t = time;
    if (!d) {
      // 只給時間：今天，若已經過了就當作明天
      const hhmm = taipeiNow(nowMs).toISOString().slice(11, 16);
      d = t <= hhmm ? addDays(today, 1) : today;
    }
    dueDate = `${d}T${t || DEFAULT_TIME}`; // 只有日期沒時間：凌晨 3 點，確保當天早上 6:00 的彙整一定會列出來
  }
  return { cmd: 'add', title, dueDate, project };
}

module.exports = { parseCommand, parseDateToken, parseTimeToken, addDays };
