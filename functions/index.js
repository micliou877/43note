// 任務到期 LINE 提醒：每分鐘檢查一次，把「該提醒了」的任務用 LINE 官方帳號推播給自己。
// 任務資料結構沿用 index.html：dueDate（台灣當地時間 "YYYY-MM-DDTHH:mm"）、reminderOffset（提前幾分鐘）。
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { MAX_OFFSET_MIN, GRACE_MS, toLocalStr, parseDue, buildMessage } = require('./lib');

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

exports.lineTaskReminder = onSchedule(
  {
    schedule: 'every 1 minutes',
    timeZone: 'Asia/Taipei',
    region: 'asia-east1',
    secrets: [LINE_CHANNEL_TOKEN, LINE_USER_ID],
    maxInstances: 1,
    memory: '256MiB',
    timeoutSeconds: 60,
  },
  async () => {
    const now = Date.now();
    // 只讀「到期時間落在 [15 分鐘前, 1 天後] 」的任務，避免每分鐘掃全部任務浪費讀取次數
    const snap = await db
      .collection(`users/${APP_UID.value()}/tasks`)
      .where('dueDate', '>=', toLocalStr(now - GRACE_MS))
      .where('dueDate', '<=', toLocalStr(now + (MAX_OFFSET_MIN + 5) * 60 * 1000))
      .get();

    for (const docSnap of snap.docs) {
      const t = docSnap.data();
      if (t.done || t.deleted || !t.dueDate || t.reminderOffset == null) continue;
      // 用「到期時間|提前分鐘」當標記：改了到期時間或提醒設定，會自動重新提醒一次
      const key = `${t.dueDate}|${t.reminderOffset}`;
      if (t.lineRemindedFor === key) continue;
      const alertAt = parseDue(t.dueDate) - t.reminderOffset * 60000;
      if (now < alertAt || now >= alertAt + GRACE_MS) continue;

      // 先標記再發送，避免標記寫入失敗造成每分鐘重複轟炸；發送失敗就取消標記，下一分鐘重試
      await docSnap.ref.update({ lineRemindedFor: key });
      try {
        await pushLine(buildMessage(t));
        logger.info('LINE 提醒已發送', { id: docSnap.id, title: t.title });
      } catch (err) {
        await docSnap.ref.update({ lineRemindedFor: admin.firestore.FieldValue.delete() });
        logger.error('LINE 提醒發送失敗', { id: docSnap.id, err: String(err) });
      }
    }
  }
);
