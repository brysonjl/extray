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
