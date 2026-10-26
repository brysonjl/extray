chrome.i18n = chrome.i18n || {};
export async function customI18n(data, preferences) {
  const supportedLocales = [
    { code: 'ar', name: 'Arabic' },
    { code: 'zh_CN', name: 'Chinese (China)' },
    { code: 'zh_TW', name: 'Chinese (Taiwan)' },
    { code: 'cs', name: 'Czech' },
    { code: 'da', name: 'Danish' },
    { code: 'nl', name: 'Dutch' },
    { code: 'en', name: 'English' },
    { code: 'et', name: 'Estonian' },
    { code: 'fi', name: 'Finnish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'el', name: 'Greek' },
    { code: 'he', name: 'Hebrew' },
    { code: 'hu', name: 'Hungarian' },
    { code: 'id', name: 'Indonesian' },
    { code: 'it', name: 'Italian' },
    { code: 'ja', name: 'Japanese' },
    { code: 'ko', name: 'Korean' },
    { code: 'lt', name: 'Lithuanian' },
    { code: 'no', name: 'Norwegian' },
    { code: 'pl', name: 'Polish' },
    { code: 'pt_BR', name: 'Portuguese (Brazil)' },
    { code: 'pt_PT', name: 'Portuguese (Portugal)' },
    { code: 'ro', name: 'Romanian' },
    { code: 'ru', name: 'Russian' },
    { code: 'sr', name: 'Serbian' },
    { code: 'sk', name: 'Slovak' },
    { code: 'es', name: 'Spanish' },
    { code: 'sv', name: 'Swedish' },
    { code: 'tr', name: 'Turkish' },
    { code: 'uk', name: 'Ukrainian' },
    { code: 'vi', name: 'Vietnamese' },
  ];

  async function fetchFile(file) {
    try {
      const response = await fetch(chrome.runtime.getURL(file));
      if (!response.ok) throw new Error(`Failed to load: ${file}`);
      return await response.json();
    } catch (e) {
      return null;
    }
  }

  function parseString(msgData, args) {
    if (msgData.placeholders === undefined && args === undefined) return msgData.message.replace(/\$\$/g, '$');
    function safesub(txt, re, replacement) {
      const dollaRegex = /\$\$/g,
        dollaSub = '~~~I18N~~:';
      txt = txt.replace(dollaRegex, dollaSub);
      txt = txt.replace(re, replacement);
      const undollaRegex = /~~~I18N~~:/g,
        undollaSub = '$$$$';
      txt = txt.replace(undollaRegex, undollaSub);
      return txt;
    }
    const $n_re = /\$([1-9])/g;
    const $n_subber = function (_, num) {
      return args[num - 1];
    };
    const placeholders = {};
    for (var name in msgData.placeholders) {
      var content = msgData.placeholders[name].content;
      placeholders[name.toLowerCase()] = safesub(content, $n_re, $n_subber);
    }
    let message = safesub(msgData.message, $n_re, $n_subber);
    message = safesub(message, /\$(\w+?)\$/g, function (full, name) {
      const lowered = name.toLowerCase();
      if (lowered in placeholders) return placeholders[lowered];
      return full;
    });
    message = message.replace(/\$\$/g, '$');
    return message;
  }

  function _getL10nData() {
    const result = { locales: [] };
    if (preferences.useCustomLocale && preferences.customLocale) {
      result.locales.push(preferences.customLocale);
    }
    result.locales.push(navigator.language.replace('-', '_'));
    if (!result.locales.includes('en')) result.locales.push('en');

    result.messages = {};
    for (const locale of result.locales) {
      const messages = allLocales[locale];
      if (messages) result.messages[locale] = messages;
    }
    return result;
  }

  function getExistingLocales() {
    const existingLocales = [];
    const allSupportedLocales = Object.keys(allLocales);
    for (const locale of allSupportedLocales) {
      existingLocales.push(supportedLocales.find(({ code }) => code === locale));
    }
    return existingLocales;
  }

  const allLocales = {};
  for (const { code, name } of supportedLocales) {
    const file = `_locales/${code}/messages.json`;
    const messages = await fetchFile(file);
    if (messages) allLocales[code] = messages;
  }
  const l10nData = _getL10nData();
  return {
    getMessage(messageID, args) {
      if (typeof args === 'string') args = [args];
      for (const locale of l10nData.locales) {
        const map = l10nData.messages[locale];
        if (map && map[messageID]) {
          return parseString(map[messageID], args);
        }
      }
      return '';
    },
    existingLocales: getExistingLocales(),
  };
}
