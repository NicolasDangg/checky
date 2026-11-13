// Background service worker: turns a click (floating button, right-click menu or
// Alt+Shift+S) into a trace. The trace runs in an offscreen document (offscreen/), so it
// doesn't depend on the side panel being open; results go to the on-page card and to
// the side panel whenever it's open.

const DEFAULTS = { apiKey: '', openAlexKey: '', useResearch: true, useAgent: true, useScholar: true, showCard: true, theme: 'light', researchMode: 'deep', maxHops: 5 };

// Cached so the click handlers can decide synchronously (sidePanel.open needs the user's click).
let showCard = true;
chrome.storage.local.get({ showCard: true }).then((s) => (showCard = s.showCard));
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.showCard) showCard = ch.showCard.newValue !== false;
});

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.create({ id: 'trace', title: 'Check the source of “%s”', contexts: ['selection'] });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  if (details.reason === 'install') {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!apiKey) chrome.runtime.openOptionsPage();
  }
});

/** Asks the page for the selection plus its sentence, nearby links and date. */
async function collectContext(tabId, fallback) {
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'sh:getContext' });
  try {
    const r = await ask();
    if (r?.claim) return r;
  } catch {}
  // Pages opened before the extension was installed have no content script yet.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js', 'content/card.js'] });
    const r = await ask();
    if (r?.claim) return r;
  } catch {}
  return fallback;
}

async function ensureRunner() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctxs.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Runs claim traces in the background: fetches and parses the source pages a claim cites.',
    });
  } catch (e) {
    if (!/single offscreen|already exists/i.test(e?.message || '')) throw e;
  }
}

function toCard(tabId, card) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'sh:card', card }).catch(() => {});
}

/** Starts a trace for this request. */
async function run(req) {
  // `request`: the newest check; `focus`: the check the side panel shows; `req:<tab>`: each
  // tab's own last check, so "Try again" on a card re-runs that card's claim.
  await chrome.storage.session.set({ request: req, focus: req.id, ...(req.tabId != null ? { [`req:${req.tabId}`]: req } : {}) });
  const settings = await chrome.storage.local.get(DEFAULTS);
  if (!settings.apiKey) {
    toCard(req.tabId, { id: req.id, claim: req.claim, status: 'error', error: 'Add your TinyFish API key in Settings to start checking.', needsKey: true, steps: [] });
    return;
  }
  await ensureRunner();
  const send = () => chrome.runtime.sendMessage({ target: 'offscreen', type: 'run', req, settings });
  try {
    await send();
  } catch {
    // The runner was still loading: try once more.
    await new Promise((r) => setTimeout(r, 300));
    await send().catch((e) => toCard(req.tabId, { id: req.id, claim: req.claim, status: 'error', error: `Couldn't start the check: ${e.message}`, steps: [] }));
  }
}

/** Runs a check again: the given one (from the card or panel), else this tab's last one. */
async function rerun(id, tabId) {
  let req = null;
  if (id) req = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'getState', id }).catch(() => null))?.req;
  if (req && id && req.id !== id) req = null; // the runner no longer has it
  if (!req && tabId != null) req = (await chrome.storage.session.get(`req:${tabId}`))[`req:${tabId}`];
  if (!req) req = (await chrome.storage.session.get('request')).request;
  if (req) run({ ...req, id: crypto.randomUUID(), at: Date.now() });
}

function submit(ctx, tabId) {
  if (!ctx?.claim) return;
  return run({ ...ctx, tabId, id: crypto.randomUUID(), at: Date.now() });
}

// The side panel is only opened automatically when the on-page card is turned off.
// sidePanel.open() must run synchronously inside the user's click, before any await.
function maybeOpenPanel(windowId) {
  if (!showCard) chrome.sidePanel.open({ windowId }).catch(() => {});
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'trace' || !tab) return;
  maybeOpenPanel(tab.windowId);
  collectContext(tab.id, { claim: info.selectionText, url: tab.url, title: tab.title, links: [] }).then((ctx) => submit(ctx, tab.id));
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'trace-selection' || !tab) return;
  maybeOpenPanel(tab.windowId);
  collectContext(tab.id, null).then((ctx) => submit(ctx, tab.id));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return; // for the runner, not us
  if (msg?.type === 'sh:trace' && sender.tab) {
    maybeOpenPanel(sender.tab.windowId);
    submit(msg.payload, sender.tab.id);
  } else if (msg?.type === 'sh:card') {
    toCard(msg.tabId, msg.card); // from the runner, on to the page
  } else if (msg?.type === 'sh:rerun') {
    rerun(msg.id, sender.tab?.id);
  } else if (msg?.type === 'sh:openPanel' && sender.tab) {
    const windowId = sender.tab.windowId;
    // Show this card's own check in the panel (the open call must come first: user gesture).
    const opening = chrome.sidePanel.open({ windowId });
    if (msg.id) chrome.storage.session.set({ focus: msg.id });
    opening.catch(() => {
      // If Chrome won't open the side panel from here, show the full trail in a small window.
      chrome.windows.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html'), type: 'popup', width: 440, height: 820 });
    });
  } else if (msg?.type === 'sh:openOptions') {
    chrome.runtime.openOptionsPage();
  } else if (msg?.type === 'sh:ensureRunner') {
    ensureRunner().then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
});
