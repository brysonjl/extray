import { startData } from '/js/data.js';
async function start() {
  const { data, preferences } = await startData();
  if (preferences.showDevToolsPanel) chrome.devtools.panels.create('ExtRay Demo Cookie Manager', 'img/icon_32x32.png', 'devtools/panel.html');
}
window.addEventListener('load', start);
