import { setApiKey, search } from '../lib/tinyfish.js';
import { friendlyError } from '../lib/tracer.js';

const DEFAULTS = { apiKey: '', openAlexKey: '', useResearch: true, useAgent: true, useScholar: true, showCard: true, showButton: true, theme: 'light', researchMode: 'deep', maxHops: 5 };
const $ = (id) => document.getElementById(id);
const status = (msg, cls = '') => {
  $('status').textContent = msg;
  $('status').className = cls;
  $('sdot').className = `sdot ${cls}`;
};

const s = await chrome.storage.local.get(DEFAULTS);
$('apiKey').value = s.apiKey;
status(s.apiKey ? 'Saved' : 'Not set', s.apiKey ? 'ok' : '');
for (const id of ['useResearch', 'useAgent', 'useScholar', 'showCard', 'showButton']) {
  $(id).checked = s[id];
  $(id).addEventListener('change', () => chrome.storage.local.set({ [id]: $(id).checked }));
}
$('openAlexKey').value = s.openAlexKey;
$('researchMode').value = s.researchMode;
$('maxHops').value = s.maxHops;

// Theme: Light / Dark / System
const themeBtns = [...document.querySelectorAll('[data-theme-opt]')];
const showTheme = (t) => themeBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeOpt === t)));
showTheme(s.theme);
for (const b of themeBtns)
  b.addEventListener('click', () => {
    showTheme(b.dataset.themeOpt);
    chrome.storage.local.set({ theme: b.dataset.themeOpt });
  });

$('openAlexKey').addEventListener('input', () => chrome.storage.local.set({ openAlexKey: $('openAlexKey').value.trim() }));
$('researchMode').addEventListener('change', () => chrome.storage.local.set({ researchMode: $('researchMode').value }));
$('maxHops').addEventListener('change', () => chrome.storage.local.set({ maxHops: Math.min(8, Math.max(1, parseInt($('maxHops').value, 10) || 5)) }));

$('save').addEventListener('click', async () => {
  const key = $('apiKey').value.trim();
  await chrome.storage.local.set({ apiKey: key });
  status(key ? 'Saved' : 'Not set', key ? 'ok' : '');
});

$('test').addEventListener('click', async () => {
  status('Testing…', 'busy');
  setApiKey($('apiKey').value.trim());
  try {
    const r = await search({ query: 'tinyfish' });
    status(`Key works · ${r.results?.length ?? 0} search results`, 'ok');
  } catch (e) {
    status(friendlyError(e), 'bad');
  }
});
