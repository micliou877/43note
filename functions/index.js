// 每天早上 6:00 把「今天到期」與「已逾期」還沒完成的任務彙整成一則 LINE 訊息傳給自己。
// 任務資料結構沿用 index.html：users/{uid}/tasks，欄位 title、dueDate、done、deleted。
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { todayStr, buildDigest } = require('./lib');

admin.initializeApp();
const db = admin.firestore();

const LINE_CHANNEL_TOKEN = defineSecret('LINE_CHANNEL_TOKEN');
const LINE_USER_ID = defineSecret('LINE_USER_ID');
const APP_UID = defineString('APP_UID'); // Firebase Auth 的使用者 UID（筆記資料存在 users/{uid}/ 底下）

async function pushLine(text) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_CHANNEL_TOKEN.value().trim()}` },
    body: JSON.stringify({ to: LINE_USER_ID.value().trim(), messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) throw new Error(`LINE API ${res.status}: ${await res.text()}`);
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
    const now = Date.now();
    // 逾期可能是很久以前，所以只設上限（今天結束）；done/deleted 在程式裡濾掉。一天只讀一次，讀取量可忽略
    const snap = await db
      .collection(`users/${APP_UID.value()}/tasks`)
      .where('dueDate', '<=', `${todayStr(now)}T23:59`)
      .get();

    const text = buildDigest(snap.docs.map((d) => d.data()), now);
    if (!text) {
      logger.info('今天沒有待處理任務，不發送');
      return;
    }
    await pushLine(text);
    logger.info('每日任務彙整已發送', { length: text.length });
  }
);
