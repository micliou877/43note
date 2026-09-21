// 43note 的 LINE 整合：
//   lineDailyDigest  每天早上 6:00 把「今天到期」與「已逾期」還沒完成的任務彙整成一則 LINE 訊息傳給自己
//   lineWebhook      接收自己傳給官方帳號的訊息，用「新增 標題 明天 15:00」建立任務、「今天」查清單、「規則」看說明
// 任務資料結構沿用 index.html：users/{uid}/tasks，欄位 title、dueDate、done、deleted、projectId 等。
const crypto = require('crypto');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { todayStr, buildDigest } = require('./lib');
const { parseCommand, addDays } = require('./parse');

admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const LINE_CHANNEL_TOKEN = defineSecret('LINE_CHANNEL_TOKEN');
const LINE_USER_ID = defineSecret('LINE_USER_ID');
const LINE_CHANNEL_SECRET = defineSecret('LINE_CHANNEL_SECRET'); // 驗證 Webhook 請求真的來自 LINE
const APP_UID = defineString('APP_UID'); // Firebase Auth 的使用者 UID（筆記資料存在 users/{uid}/ 底下）

const DEFAULT_PROJECT = 'line加入';        // 沒指定專案時，LINE 建立的任務都放這裡
const DEFAULT_PROJECT_ID = 'line-inbox';   // 固定文件 ID：同時來兩則訊息也不會重複建立專案

// 傳「規則」時回覆的完整說明（LINE 只支援純文字，所以不用表格）
const RULES_TEXT = [
  '📖 使用規則',
  '',
  '【新增任務】',
  '新增 標題 [日期] [時間] [@專案]',
  '（也可以用 + 代替「新增」）',
  '',
  '範例：',
  '新增 回覆業主圖面',
  '→ 建立任務，沒有日期',
  '',
  '新增 回覆業主圖面 明天 15:00',
  '→ 有到期日',
  '',
  '新增 送件補正 9/25 @行政',
  '→ 放到名稱含「行政」的專案',
  '',
  '【新增筆記】',
  '筆記 標題 [@專案]',
  '（第一行是標題，換行後的都是內文）',
  '',
  '範例：',
  '筆記 現場勘查 9/21',
  '外牆有裂縫，約 2 公尺',
  '下週請廠商處理',
  '',
  '【不確定的話】',
  '直接打一行文字，我會問你要加入任務還是筆記，點按鈕就好',
  '選任務時，如果文字裡沒有日期，會再問你要不要設定到期日',
  '',
  '【查詢】',
  '今天：列出今天到期加逾期的任務',
  '',
  '【日期寫法】',
  '今天、明天、後天、週三、下週三、9/25、9月25日、2026/12/31',
  '',
  '【時間寫法】',
  '15:00、下午3點、上午10點半',
  '',
  '【規則】',
  '• 只有日期沒時間：預設凌晨 03:00（當天 6:00 的彙整會列出）',
  '• 只有時間沒日期：算今天，時間已過則算明天',
  `• 沒指定專案：放進「${DEFAULT_PROJECT}」專案（不存在會自動建立）`,
  '• 日期、時間、@專案 都要用空白隔開',
  '',
  '【自動通知】',
  '每天早上 6:00 傳今日任務彙整',
].join('\n');

// 看不懂的訊息只回簡短提示
const HELP_TEXT = [
  '看不懂這則訊息 😅',
  '新增任務：新增 標題 明天 15:00',
  '新增筆記：筆記 標題（換行寫內文）',
  '查清單：今天',
  '完整說明：規則',
].join('\n');

const callLine = async (path, body) => {
  const res = await fetch(`https://api.line.me/v2/bot/message/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_CHANNEL_TOKEN.value().trim()}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LINE API ${res.status}: ${await res.text()}`);
};
const pushLine = (text) => callLine('push', { to: LINE_USER_ID.value().trim(), messages: [{ type: 'text', text }] });
// 回覆訊息不計入每月推播額度
// message 可以是純文字，或完整的 LINE 訊息物件（例如帶快速回覆按鈕的）
const replyLine = (replyToken, message) =>
  callLine('reply', { replyToken, messages: [typeof message === 'string' ? { type: 'text', text: message } : message] });

// 今天到期 + 已逾期且未完成的任務。逾期可能是很久以前，所以只設上限；done/deleted 在程式裡濾掉
async function todayDigestText() {
  const now = Date.now();
  const snap = await db
    .collection(`users/${APP_UID.value()}/tasks`)
    .where('dueDate', '<=', `${todayStr(now)}T23:59`)
    .get();
  return buildDigest(snap.docs.map((d) => d.data()), now);
}

exports.lineDailyDigest = onSchedule(
  {
    schedule: '0 6 * * *',
    timeZone: 'Asia/Taipei',
    region: 'asia-east1',
    secrets: [LINE_CHANNEL_TOKEN, LINE_USER_ID],
    maxInstances: 1,
    memory: '256MiB',
    timeoutSeconds: 60,
    retryCount: 2, // LINE 暫時失敗時重試，避免整天沒收到
  },
  async () => {
    const text = await todayDigestText();
    if (!text) {
      logger.info('今天沒有待處理任務，不發送');
      return;
    }
    await pushLine(text);
    logger.info('每日任務彙整已發送', { length: text.length });
  }
);

// 找專案：有指定 @名稱 就在現有專案裡找（完全相同優先，其次包含）；沒指定就用（必要時建立）預設專案
async function resolveProject(query) {
  const col = db.collection(`users/${APP_UID.value()}/projects`);
  const snap = await col.get();
  const projects = snap.docs.map((d) => ({ id: d.id, name: d.data().name || '', deleted: !!d.data().deleted })).filter((p) => !p.deleted);

  if (query) {
    const q = query.toLowerCase();
    return projects.find((p) => p.name.toLowerCase() === q) || projects.find((p) => p.name.toLowerCase().includes(q)) || null;
  }
  const existing = projects.find((p) => p.name === DEFAULT_PROJECT);
  if (existing) return existing;
  // created 一定要有：網頁的專案列表是 orderBy("created")，沒這個欄位就看不到
  await col.doc(DEFAULT_PROJECT_ID).set({ name: DEFAULT_PROJECT, created: FieldValue.serverTimestamp(), deleted: false, pinned: false, sortOrder: Date.now() });
  return { id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT };
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 網頁的筆記內文是 contentEditable 的 HTML：一行一個 <div>，空行是 <div><br></div>
const textToHtml = (text) => (text ? text.split('\n').map((l) => (l.trim() ? `<div>${escapeHtml(l)}</div>` : '<div><br></div>')).join('') : '');

async function addNote({ title, body, project: projectQuery }) {
  const project = await resolveProject(projectQuery);
  if (!project) return `找不到專案「${projectQuery}」，筆記沒有建立。\n（去掉 @專案 會放進「${DEFAULT_PROJECT}」）`;

  // 欄位與網頁 addNote 完全一致（updated 也要有，網頁列表依它排序）
  await db.collection(`users/${APP_UID.value()}/notes`).add({
    projectId: project.id, title, body: textToHtml(body), images: [], deleted: false, pinned: false, sortOrder: Date.now(),
    created: FieldValue.serverTimestamp(), updated: FieldValue.serverTimestamp(),
  });
  const lines = body ? body.split('\n').length : 0;
  return `📝 已加入「${project.name}」\n${title}\n${lines ? `內文 ${lines} 行` : '（只有標題）'}`;
}

async function addTask(cmd) {
  const project = await resolveProject(cmd.project);
  if (!project) return `找不到專案「${cmd.project}」，任務沒有建立。\n（去掉 @專案 會放進「${DEFAULT_PROJECT}」）`;

  // 欄位與網頁 addTask 完全一致
  await db.collection(`users/${APP_UID.value()}/tasks`).add({
    projectId: project.id, title: cmd.title, done: false, deleted: false, images: [], pinned: false, sortOrder: Date.now(),
    created: FieldValue.serverTimestamp(), dueDate: cmd.dueDate, reminderOffset: null, reminded: false, recur: null, recurInterval: null, noteIds: [],
  });

  const due = cmd.dueDate
    ? `到期：${Number(cmd.dueDate.slice(5, 7))}/${Number(cmd.dueDate.slice(8, 10))} ${cmd.dueDate.slice(11, 16)}`
    : '未設定日期';
  return `✅ 已加入「${project.name}」\n${cmd.title}\n${due}`;
}

// 認不出是指令的文字：先暫存起來，問使用者要當任務還是筆記（按鈕的 postback 只帶暫存 ID，文字可以很長）
async function askWhere(text) {
  const inbox = db.collection(`users/${APP_UID.value()}/lineInbox`);
  // 順手清掉超過一天沒處理的暫存
  const old = await inbox.where('created', '<', Date.now() - 24 * 3600 * 1000).limit(20).get();
  await Promise.all(old.docs.map((d) => d.ref.delete()));
  const ref = await inbox.add({ text, created: Date.now() });

  const preview = text.replace(/\s*\n\s*/g, ' ⏎ ');
  const btn = (label, act) => ({ type: 'action', action: { type: 'postback', label, data: `act=${act}&id=${ref.id}`, displayText: label } });
  return {
    type: 'text',
    text: `要把這則加到哪裡？\n「${preview.length > 60 ? preview.slice(0, 60) + '…' : preview}」`,
    quickReply: { items: [btn('加入任務', 'task'), btn('加入筆記', 'note'), btn('取消', 'cancel')] },
  };
}

// 選了「加入任務」但文字裡沒有日期時間 → 問要不要設定（datetimepicker 會在手機上跳出日期時間滾輪）
function askDue(id, title) {
  const now = Date.now();
  const today = todayStr(now);
  const btn = (label, when) => ({ type: 'action', action: { type: 'postback', label, data: `act=due&id=${id}&when=${when}`, displayText: label } });
  return {
    type: 'text',
    text: `「${title.length > 40 ? title.slice(0, 40) + '…' : title}」\n要設定到期日嗎？`,
    quickReply: {
      items: [
        // LINE 規定 initial/min 的格式是小寫 t：YYYY-MM-DDtHH:mm
        { type: 'action', action: { type: 'datetimepicker', label: '📅 選日期時間', data: `act=due&id=${id}`, mode: 'datetime', initial: `${addDays(today, 1)}t09:00`, min: `${today}t00:00` } },
        btn('今天', 'today'), btn('明天', 'tomorrow'), btn('不設定', 'none'),
      ],
    },
  };
}

// 認領暫存：先刪除再建立，連按兩次按鈕時只有一次會成功，不會重複建立
const claim = async (ref) => {
  try { await ref.delete({ exists: true }); return true; } catch { return false; }
};

// 使用者點了按鈕（params 是日期時間選擇器回傳的值）
async function handlePostback(data, params) {
  const p = new URLSearchParams(data || '');
  const act = p.get('act'), id = p.get('id');
  if (!id || !['task', 'note', 'cancel', 'due'].includes(act)) return HELP_TEXT;

  const ref = db.doc(`users/${APP_UID.value()}/lineInbox/${id}`);
  const snap = await ref.get();
  if (!snap.exists) return '這則已經處理過，或超過一天已過期了。';
  const text = snap.data().text;
  const done = '這則已經處理過了。';

  if (act === 'cancel') return (await claim(ref)) ? '已取消，沒有建立任何東西。' : done;

  if (act === 'note') {
    if (!(await claim(ref))) return done;
    const cmd = parseCommand(`筆記 ${text}`, Date.now());
    return cmd.cmd === 'note' ? addNote(cmd) : '這則沒有可用的標題，沒有建立。';
  }

  const cmd = parseCommand(`新增 ${text}`, Date.now());
  if (cmd.cmd !== 'add') {
    await claim(ref);
    return '這則沒有可用的標題（只有日期或時間？），沒有建立。';
  }

  if (act === 'task') {
    // 文字裡已經有日期時間就直接建立；沒有才問。這時候暫存要留著，等使用者選完
    if (cmd.dueDate) return (await claim(ref)) ? addTask(cmd) : done;
    return askDue(id, cmd.title);
  }

  // act === 'due'：日期時間選擇器 / 今天 / 明天 / 不設定
  let dueDate = null;
  const picked = (params?.datetime || '').toUpperCase(); // "2026-09-22T15:00"
  if (picked) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(picked)) return '日期時間格式我看不懂，沒有建立，請再選一次。';
    dueDate = picked;
  } else if (p.get('when') === 'today') dueDate = `${todayStr(Date.now())}T09:00`;
  else if (p.get('when') === 'tomorrow') dueDate = `${addDays(todayStr(Date.now()), 1)}T03:00`; // 凌晨 3 點：明早 6:00 的彙整一定會列出來
  return (await claim(ref)) ? addTask({ ...cmd, dueDate }) : done;
}

async function handleText(text) {
  const cmd = parseCommand(text, Date.now());
  if (cmd.cmd === 'today') return (await todayDigestText()) || '今天沒有待處理的任務 🎉';
  if (cmd.cmd === 'rules') return RULES_TEXT;
  if (cmd.cmd === 'note') return addNote(cmd);
  if (cmd.cmd === 'add') return addTask(cmd);
  if (cmd.cmd === 'ask') return askWhere(cmd.text);
  return HELP_TEXT;
}

const validSignature = (rawBody, signature) => {
  try {
    const expected = crypto.createHmac('sha256', LINE_CHANNEL_SECRET.value().trim()).update(rawBody).digest();
    const got = Buffer.from(signature || '', 'base64');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
};

exports.lineWebhook = onRequest(
  {
    region: 'asia-east1',
    secrets: [LINE_CHANNEL_TOKEN, LINE_USER_ID, LINE_CHANNEL_SECRET],
    maxInstances: 3,
    memory: '256MiB',
    timeoutSeconds: 30,
  },
  async (req, res) => {
    if (req.method !== 'POST' || !validSignature(req.rawBody, req.get('x-line-signature'))) {
      res.status(401).send('invalid signature');
      return;
    }
    for (const ev of req.body?.events || []) {
      try {
        const isText = ev.type === 'message' && ev.message?.type === 'text';
        if (!isText && ev.type !== 'postback') continue;
        // 只接受本人：別人加了官方帳號為好友也不能建立你的任務
        if (ev.source?.userId !== LINE_USER_ID.value().trim()) {
          logger.warn('忽略非本人的訊息');
          continue;
        }
        await replyLine(ev.replyToken, isText ? await handleText(ev.message.text) : await handlePostback(ev.postback?.data, ev.postback?.params));
      } catch (err) {
        logger.error('處理 LINE 訊息失敗', { err: String(err) });
      }
    }
    res.status(200).send('ok'); // 一律回 200，避免 LINE 重送造成重複建立任務
  }
);
