// Runs traces in the background, independent of the side panel, so a trace keeps going
// whether or not the panel is open (TinyResearch can take 5–20 minutes).
//
// One trace per tab: a new check in the same tab replaces that tab's previous one, but
// checks in other tabs keep running (so they don't lose their TinyResearch run).
//
// An offscreen document can only use chrome.runtime messaging, so:
//   background → here:  { target: 'offscreen', type: 'run' | 'stop' | 'getState', id? }
//   here → everyone:    { type: 'sh:state', req, state }  (the side panel draws it)
//                       { type: 'sh:card', tabId, card }  (background relays it to the page)

import { runTrace } from '../lib/tracer.js';
import { cardData } from '../lib/carddata.js';

const runs = new Map(); // id → { req, settings, abort, state }
let latestId = null;

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // nobody listening (panel closed) is fine
}

/** Keeps the last few finished runs so "Full trail" and "Try again" still find them. */
function prune() {
  const done = [...runs.values()].filter((r) => r.state && !['running', 'researching'].includes(r.state.status));
  for (const r of done.slice(0, Math.max(0, done.length - 8))) runs.delete(r.req.id);
}

function start(req, settings) {
  for (const r of runs.values())
    if (req.tabId != null && r.req.tabId === req.tabId && r.req.id !== req.id && !r.abort.signal.aborted) {
      r.replaced = true;
      r.abort.abort();
    }
  const run = { req, settings, abort: new AbortController(), state: null };
  runs.set(req.id, run);
  latestId = req.id;
  prune();
  let timer = null;
  let pending = null;
  const flushCard = () => {
    timer = null;
    if (!pending || settings.showCard === false || req.tabId == null) return;
    broadcast({ type: 'sh:card', tabId: req.tabId, card: cardData(req, pending) });
    pending = null;
  };
  runTrace(
    req,
    settings,
    (st) => {
      run.state = st;
      broadcast({ type: 'sh:state', req, state: st });
      // A run replaced by a newer check in the same tab: its card has moved on already.
      if (run.replaced) return;
      // The page card is throttled to ~4 updates a second; final states go at once.
      pending = st;
      if (!['running', 'researching'].includes(st.status)) {
        clearTimeout(timer);
        flushCard();
      } else if (!timer) timer = setTimeout(flushCard, 250);
    },
    run.abort.signal,
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'run') {
    start(msg.req, msg.settings);
    sendResponse({ ok: true });
  } else if (msg.type === 'stop') {
    const r = runs.get(msg.id || latestId);
    r?.abort.abort();
    sendResponse({ ok: true });
  } else if (msg.type === 'getState') {
    const r = runs.get(msg.id || latestId) || runs.get(latestId);
    sendResponse(r ? { req: r.req, state: r.state } : null);
  }
});
