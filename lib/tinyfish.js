// Thin client for the four TinyFish APIs Checky uses.
// Docs: https://docs.tinyfish.ai  (all calls authenticate with the X-API-Key header)

const AGENT = 'https://agent.tinyfish.ai';
const SEARCH = 'https://api.search.tinyfish.ai';
const FETCH = 'https://api.fetch.tinyfish.ai';

let apiKey = '';
/** Calls made per endpoint, shown in the panel footer. */
export const usage = { search: 0, fetch: 0, agent: 0, research: 0 };

export function setApiKey(k) {
  apiKey = (k || '').trim();
}

export function resetUsage() {
  for (const k of Object.keys(usage)) usage[k] = 0;
}

export class TinyFishError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(url, { method = 'GET', body, timeout = 60000, signal } = {}) {
  if (!apiKey) throw new TinyFishError('No TinyFish API key yet. Add one in Settings.', 0, 'NO_KEY');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), timeout);
  const onAbort = () => ctrl.abort('cancelled');
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = data?.error || {};
      throw new TinyFishError(err.message || `HTTP ${res.status}`, res.status, err.code || '');
    }
    return data;
  } catch (e) {
    if (e?.name === 'AbortError' || ctrl.signal.aborted) {
      throw new TinyFishError(signal?.aborted ? 'Cancelled' : 'Request timed out', 0, signal?.aborted ? 'CANCELLED' : 'TIMEOUT');
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Search API: ranked web, news or research-paper results. */
export function search(params, { signal } = {}) {
  usage.search++;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
  return call(`${SEARCH}/?${qs}`, { timeout: 20000, signal });
}

/** Fetch API: clean Markdown (plus the page's links) for up to 10 URLs at once. */
export function fetchUrls(urls, opts = {}, { signal } = {}) {
  usage.fetch++;
  return call(FETCH, {
    method: 'POST',
    body: { urls: urls.slice(0, 10), format: 'markdown', links: true, per_url_timeout_ms: 45000, ...opts },
    timeout: 150000,
    signal,
  });
}

/** TinyAgent: a real browser that reads a page and returns structured JSON. */
export function agentRun(body, { signal } = {}) {
  usage.agent++;
  return call(`${AGENT}/v1/automation/run`, { method: 'POST', body, timeout: 240000, signal });
}

/** TinyResearch: starts a deep, cited research run and returns its id. */
export function researchStart(body, { signal } = {}) {
  usage.research++;
  return call(`${AGENT}/v1/automation/run-research-async`, { method: 'POST', body, timeout: 60000, signal });
}

export function researchGet(id, { signal } = {}) {
  return call(`${AGENT}/v1/research-run/${encodeURIComponent(id)}`, { timeout: 30000, signal });
}

export function researchCancel(id) {
  return call(`${AGENT}/v1/research-run/${encodeURIComponent(id)}/cancel`, { method: 'POST', timeout: 20000 }).catch(() => null);
}

/**
 * Streams a research run's progress events (Server-Sent Events) until `done`.
 * Calls onEvent with each parsed event object.
 */
export async function researchEvents(id, onEvent, { signal } = {}) {
  if (!apiKey) throw new TinyFishError('No API key', 0, 'NO_KEY');
  const res = await fetch(`${AGENT}/v1/research-run/${encodeURIComponent(id)}/events`, {
    headers: { 'X-API-Key': apiKey, Accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) throw new TinyFishError(`Research events HTTP ${res.status}`, res.status);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf = (buf + value).replace(/\r\n/g, '\n');
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let name = '';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      let ev;
      try {
        ev = JSON.parse(data.join('\n'));
      } catch {
        continue;
      }
      if (!ev.event && name) ev.event = name;
      onEvent(ev);
      if (ev.event === 'done') {
        reader.cancel().catch(() => {});
        return;
      }
    }
  }
}
