// 任務提醒的純邏輯（不依賴 Firebase，方便單獨測試）
const TZ_OFFSET_MS = 8 * 3600 * 1000;     // dueDate 沒有時區資訊，一律當作台灣時間 (UTC+8)
const MAX_OFFSET_MIN = 1440;              // 介面最長可選「提前 1 天」
const GRACE_MS = 15 * 60 * 1000;          // 程式暫時中斷時，晚了 15 分鐘內仍會補發

const toLocalStr = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 16);
const parseDue = (s) => new Date(s + ':00+08:00').getTime();

const offsetLabel = (min) => {
  if (!min) return '到時提醒';
  if (min % 1440 === 0) return `提前 ${min / 1440} 天`;
  if (min % 60 === 0) return `提前 ${min / 60} 小時`;
  return `提前 ${min} 分鐘`;
};

const buildMessage = (task) => {
  const [date, time] = task.dueDate.split('T');
  const [, m, d] = date.split('-');
  return `⏰ 任務提醒\n${task.title}\n到期：${Number(m)}/${Number(d)} ${time}（${offsetLabel(task.reminderOffset)}）`;
};

module.exports = { TZ_OFFSET_MS, MAX_OFFSET_MIN, GRACE_MS, toLocalStr, parseDue, offsetLabel, buildMessage };
