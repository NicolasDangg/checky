// Side panel: shows the full trail of the running (or last) trace.
import { traceToMarkdown } from '../lib/tracer.js';
import { parseNumbers, fragmentLink } from '../lib/claims.js';
import { fmtDate } from '../lib/carddata.js';

const app = document.getElementById('app');
const footer = document.getElementById('usage');
document.getElementById('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());


const VIA = {
  page: 'Where you highlighted it',
  cited: 'Cited link',
  internal: 'Linked page on the same site',
  footnote: 'Footnote',
  named: 'Named source, found by search',
  search: 'Found by search, not linked',
  agent: 'Read with TinyAgent',
  research: 'Found by TinyResearch, verified',
  scholar: 'Found in scholarly databases, not linked',
};
const PAPER_STATUS = {
  checking: 'Reading…',
  verified: 'Claim found in full text',
  abstract: 'Claim found in abstract',
  'not-found': 'Doesn’t state the claim',
  'no-figure': 'On topic, but doesn’t state the figure',
  later: 'Published after the page; not the source',
};
const KIND = { primary: 'Primary source', press: 'Press release', publisher: 'Named publisher', document: 'Original document', secondary: 'Secondary', reference: 'Reference work', social: 'Social media' };
const STATUS = {
  match: 'Matches the claim',
  supported: 'Supports the claim',
  rounded: 'Rounded',
  changed: 'Changed',
  misquoted: 'Misquoted',
  partial: 'Figure not stated',
  unsupported: 'Does not support',
};

const TONE = { match: 'ok', supported: 'ok', rounded: 'warn', partial: 'warn', changed: 'bad', misquoted: 'bad', unsupported: 'bad', none: 'none' };
const nothingBehind = (v) => v?.status === 'none' && /nothing behind/i.test(v.headline || '');
function toneOf(s) {
  if (s.status === 'error') return 'bad';
  if (s.status === 'cancelled') return 'none';
  if (!s.verdict) return 'run';
  if (nothingBehind(s.verdict)) return 'warn';
  return TONE[s.verdict.status] || 'none';
}
const favicon = (u) => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(u)}&size=32`);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');

// ------------------------------------------------------------------ following the running trace
// Traces run in the background (offscreen/offscreen.js); the panel only draws them.

let current = null; // { req, state }
// The check this panel follows: the newest one, or the one whose card's "Full trail" was
// clicked. Several tabs can be checking at once; updates for the others are ignored.
let focusId = null;

function show(req, state) {
  current = { req, state };
  if (state) render(state);
  else renderStarting(req);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'sh:state' && (!focusId || msg.req?.id === focusId)) show(msg.req, msg.state);
});

async function init() {
  ({ focus: focusId = null } = await chrome.storage.session.get('focus'));
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'getState', id: focusId }).catch(() => null);
  if (r?.state && (!focusId || r.req.id === focusId)) return show(r.req, r.state);
  const { request } = await chrome.storage.session.get('request');
  const { apiKey } = await chrome.storage.local.get({ apiKey: '' });
  if (request && !apiKey) return renderNoKey(request);
  if (request && Date.now() - (request.at || 0) < 15000) return renderStarting(request);
  renderEmpty();
}
init();

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'session' && ch.focus?.newValue && ch.focus.newValue !== current?.req?.id) {
    focusId = ch.focus.newValue;
    const req = ch.request?.newValue;
    if (req?.id === focusId) renderStarting(req);
    else init(); // "Full trail" on another card: show that check
  }
  // Key added while a request was waiting for it: start that request now.
  if (area === 'local' && ch.apiKey?.newValue && !current?.state) chrome.runtime.sendMessage({ type: 'sh:rerun' }).catch(() => {});
});

function renderStarting(req) {
  footer.textContent = '';
  app.className = 't-run';
  app.innerHTML = `
    <section class="verdict"><div class="vt"><span class="spinner"></span>Checking the source…</div><div class="status-line">Starting</div></section>
    ${claimBlock({ claim: req.claim, page: { url: req.url, title: req.title } })}`;
}

// ------------------------------------------------------------------ rendering

function renderEmpty() {
  footer.textContent = '';
  app.className = '';
  app.innerHTML = `
    <div class="empty">
      <h1>Where did that number come from?</h1>
      <p>Checky follows a claim back through the pages that repeat it to the original study, report, filing or interview, and flags where it changed along the way.</p>
      <ol>
        <li>Highlight a statistic, claim or quote on any page.</li>
        <li>Click <b>Check source</b>, right-click → <b>Check the source of…</b>, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>.</li>
        <li>Read the trail here. Every step has a link, a date and the exact wording.</li>
      </ol>
    </div>`;
}

function renderNoKey(req) {
  footer.textContent = '';
  app.className = '';
  app.innerHTML = `
    ${claimBlock({ claim: req.claim, page: { url: req.url, title: req.title } })}
    <div class="notice">
      <p style="margin-top:0">Checky needs a TinyFish API key to read and search the web.</p>
      <button class="primary" id="go-settings" type="button">Add API key</button>
    </div>`;
  document.getElementById('go-settings').onclick = () => chrome.runtime.openOptionsPage();
}

function claimBlock(s) {
  const host = (() => {
    try {
      return new URL(s.page.url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  return `
    <section class="claim">
      <blockquote>“${esc(s.claim)}”</blockquote>
      <div class="from">on <a href="${esc(safeUrl(s.page.url))}" target="_blank" rel="noopener">${esc(host)}</a></div>
    </section>`;
}

/** Quote text with figures coloured by how they compare with the claim. */
function highlightQuote(step, claim, isPage) {
  const q = step.quote || '';
  if (isPage) {
    const i = q.indexOf(claim);
    if (i >= 0) return esc(q.slice(0, i)) + '<mark>' + esc(claim) + '</mark>' + esc(q.slice(i + claim.length));
    return esc(q);
  }
  const statusAt = new Map();
  for (const n of step.cmp?.numbers || []) if (n.source) statusAt.set(n.source.index, n.status);
  let out = '';
  let pos = 0;
  for (const n of parseNumbers(q)) {
    if (!statusAt.has(n.index)) continue;
    const end = n.index + n.raw.length;
    if (n.index < pos || q.slice(n.index, end) !== n.raw) continue;
    out += esc(q.slice(pos, n.index)) + `<span class="num ${statusAt.get(n.index)}">${esc(n.raw)}</span>`;
    pos = end;
  }
  return out + esc(q.slice(pos));
}

function diffHtml(diff) {
  return diff
    .map((d) => (d.op === '=' ? esc(d.w) : d.op === '-' ? `<del>${esc(d.w)}</del>` : `<ins>${esc(d.w)}</ins>`))
    .join(' ');
}

function stepCard(st, i, s) {
  const isPage = i === 0;
  const isOrigin = s.verdict?.originIndex === i;
  const status = isPage ? null : st.cmp?.status;
  const date = fmtDate(st.date);
  const link = fragmentLink(st.url, st.quote);
  const flags = [...(st.drift || []).map((f) => `<li class="drift${/^Rounded/.test(f) ? ' warn' : ''}">${esc(f)}</li>`), ...(isPage ? [] : (st.cmp?.flags || []).map((f) => `<li>${esc(f)}</li>`))];
  const checked = st.checked?.length
    ? `<details><summary>${st.checked.length} other cited page${st.checked.length > 1 ? 's' : ''} checked</summary><ul class="checked">${st.checked
        .map((c) => `<li><a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener">${esc(c.title || c.url)}</a> <span class="why">· ${esc(c.recovered ? (typeof c.recovered === 'string' ? c.recovered : 'read with TinyAgent') : c.reason)}</span></li>`)
        .join('')}</ul></details>`
    : '';
  const quoteDiff = !isPage && st.cmp?.quote?.diff && st.cmp.quote.sim < 0.97 && st.cmp.quote.sim >= 0.6
    ? `<div class="diff"><div class="label">Claimed vs. source wording</div>${diffHtml(st.cmp.quote.diff)}</div>`
    : '';
  return `
    <li class="step">
      <span class="dot ${status ? 's-' + status : ''} ${isOrigin ? 'origin' : ''}"></span>
      <div class="card ${isOrigin ? 'origin' : ''}">
        <div class="meta">
          <span class="no">${i + 1}</span>
          <span>${esc(VIA[st.via] || st.via)}</span>
          ${isOrigin ? '<span class="tag origin-tag">Earliest source</span>' : ''}
          ${st.kind && st.kind !== 'secondary' ? `<span class="tag k-${st.kind}">${esc(KIND[st.kind])}</span>` : ''}
          ${st.researchConfirmed ? '<span class="tag k-primary">TinyResearch agrees</span>' : ''}
          ${st.archived ? '<span class="tag">Archived copy</span>' : ''}
          ${st.abstractOnly ? '<span class="tag">Abstract only</span>' : ''}
        </div>
        <a class="title" href="${esc(safeUrl(st.abstractOnly ? st.url : link))}" target="_blank" rel="noopener"><img src="${esc(favicon(st.originalUrl || st.url))}" alt="">${esc(st.title || st.site)}</a>
        <div class="sub">${esc(st.site)} · ${date ? esc(date) : 'no date found'}</div>
        ${st.paper ? `<div class="paper">${paperMeta(st.paper)}</div>` : ''}
        <blockquote class="quote">${highlightQuote(st, s.claim, isPage)}</blockquote>
        ${status ? `<span class="chip s-${status}">${esc(STATUS[status] || status)}</span>` : ''}
        ${quoteDiff}
        ${flags.length ? `<ul class="flags">${flags.join('')}</ul>` : ''}
        ${checked}
      </div>
    </li>
    ${i < s.steps.length - 1 ? `<div class="connector">${esc(connectorText(s.steps[i + 1]))}</div>` : ''}`;
}

function paperMeta(p) {
  const authors = p.authors?.length ? `${p.authors.slice(0, 3).join(', ')}${p.authors.length > 2 ? ' et al.' : ''}` : '';
  return [
    authors && esc(authors),
    p.venue && `<i>${esc(p.venue)}</i>`,
    p.citedBy != null && `cited ${Number(p.citedBy).toLocaleString()}×`,
    p.doi && `<a href="https://doi.org/${esc(encodeURI(p.doi))}" target="_blank" rel="noopener">doi:${esc(p.doi)}</a>`,
    p.db && `via ${esc(p.db)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function papersBlock(s) {
  if (!s.papers?.length) return '';
  return `
    <section class="papers">
      <h2>Papers checked · scholarly databases</h2>
      <ul>${s.papers
        .map(
          (p) => `<li>
            <a href="${esc(safeUrl(p.link))}" target="_blank" rel="noopener">${esc(p.title)}</a>
            <div class="sub">${[p.date && esc(String(p.date).slice(0, 4)), paperMeta({ ...p, authors: p.authors?.slice(0, 1) })].filter(Boolean).join(' · ')}</div>
            <span class="pstat ps-${esc(p.status)}">${esc(PAPER_STATUS[p.status] || p.status)}</span>
          </li>`,
        )
        .join('')}</ul>
    </section>`;
}

function connectorText(next) {
  if (next.via === 'scholar') return '↓ no link given; found in scholarly databases';
  if (next.via === 'cited' || next.via === 'footnote') return '↓ cites';
  if (next.via === 'internal') return '↓ links to (same site)';
  if (next.via === 'agent') return '↓ cites (page read with TinyAgent)';
  if (next.via === 'research') return '↓ TinyResearch traced it further';
  return '↓ no link given; search found';
}

function figuresBlock(s) {
  if (!s.figures?.length || s.steps.length < 2) return '';
  return `<div class="figs">${s.figures
    .map((f) => {
      const chain = f.chain
        .slice(1)
        .map((c, i) => `<span class="arrow">←</span><span class="pill ${c.status}" title="Step ${i + 2}">${esc(c.raw || 'not stated')}</span>`)
        .join('');
      return `<div class="fig"><span class="pill">${esc(f.claim)}</span>${chain}</div>`;
    })
    .join('')}</div>`;
}

function verdictBlock(s) {
  const running = s.status === 'running';
  if (s.status === 'error') return `<section class="verdict"><div class="vt"><span class="vdot"></span>Check failed</div><div class="vd">${esc(s.error)}</div></section>`;
  if (s.status === 'cancelled')
    return `<section class="verdict"><div class="vt"><span class="vdot"></span>Check stopped</div><div class="vd">This check was stopped before it finished, so the trail below is incomplete.</div></section>`;
  const v = s.verdict;
  if (!v)
    return `<section class="verdict"><div class="vt"><span class="spinner"></span>Checking the source…</div><div class="status-line">${esc(s.phase)}</div></section>`;
  return `
    <section class="verdict">
      <div class="vt">${running ? '<span class="spinner"></span>' : '<span class="vdot"></span>'}${esc(v.headline)}</div>
      <div class="vd">${esc(v.detail)}</div>
      ${v.research ? `<div class="vr"><span class="label">TinyResearch found</span>${esc(v.research)}</div>` : ''}
      ${figuresBlock(s)}
      ${running || s.status === 'researching' ? `<div class="status-line">${s.status === 'running' ? '' : '<span class="spinner"></span>'}${esc(s.phase)}</div>` : ''}
    </section>`;
}

function mdToHtml(md) {
  const inline = (t) =>
    esc(t)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, a, u) => `<a href="${u}" target="_blank" rel="noopener">${a}</a>`)
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  const out = [];
  let list = false;
  for (const line of (md || '').split('\n')) {
    const l = line.trim();
    if (/^[-*]\s+/.test(l)) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (list) {
      out.push('</ul>');
      list = false;
    }
    if (!l) continue;
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) out.push(`<h4>${inline(h[2])}</h4>`);
    else out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

function researchBlock(s) {
  const r = s.research;
  if (!r || r.status === 'off') return '';
  let head;
  if (r.status === 'starting' || r.status === 'running')
    head = `<div class="rs"><span class="spinner"></span>TinyResearch is investigating independently (usually 5–20 min). The fast trail above is already usable.</div>`;
  else if (r.status === 'done')
    head = `<div class="rs">${esc(r.originalLine ? `TinyResearch conclusion: ORIGINAL SOURCE: ${r.originalLine}` : 'TinyResearch report ready')}</div>`;
  else if (r.status === 'cancelled') head = `<div class="rs">TinyResearch cancelled.</div>`;
  else head = `<div class="notice error">TinyResearch: ${esc(r.error || 'failed')}</div>`;
  const notes = [
    r.agrees ? 'TinyResearch reached the same earliest source as the trail.' : '',
    r.addedStep ? 'TinyResearch reached further back; Checky verified that page with Fetch and added it as the last step.' : '',
    r.unverified || '',
  ].filter(Boolean);
  return `
    <section class="research">
      <h2>Deep check · TinyResearch</h2>
      ${head}
      ${notes.map((n) => `<p class="rs">${esc(n)}</p>`).join('')}
      ${r.progress?.length && r.status !== 'done' ? `<ul class="progress">${r.progress.slice(-5).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      ${r.report ? `<details><summary>Read the full report</summary><div class="report">${mdToHtml(r.report)}</div></details>` : ''}
    </section>`;
}

function render(s) {
  const steps = s.steps.map((st, i) => stepCard(st, i, s)).join('');
  const lastStep = s.steps[s.steps.length - 1];
  const deadEnd = ['done', 'researching'].includes(s.status) && s.steps.length && (!['primary', 'document', 'press', 'publisher'].includes(lastStep.kind) || nothingBehind(s.verdict))
    ? `<div class="deadend">${nothingBehind(s.verdict) ? 'No study or data behind it' : 'The trail ends here: no earlier citation could be found or verified'}</div>`
    : '';
  const busy = s.status === 'running' || s.status === 'researching';
  app.className = `t-${toneOf(s)}`;
  app.innerHTML = `
    ${verdictBlock(s)}
    ${claimBlock(s)}
    <section class="trail">
      <h2>Trail · this page back to the source</h2>
      <ol class="steps">${steps}</ol>
      ${deadEnd}
    </section>
    ${papersBlock(s)}
    ${researchBlock(s)}
    <div class="actions">
      ${busy ? '<button class="ghost" id="act-stop" type="button">Stop</button>' : ''}
      ${s.status !== 'running' ? '<button class="ghost" id="act-copy" type="button">Copy report</button>' : ''}
      ${!busy ? '<button class="ghost" id="act-rerun" type="button">Trace again</button>' : ''}
    </div>
    ${s.log.length ? `<details class="log"><summary>How this was checked · ${s.log.length} steps</summary><ul>${s.log.map((l) => `<li>${esc(l.msg)}</li>`).join('')}</ul></details>` : ''}`;
  const u = s.usage || {};
  const sc = u.scholar || {};
  const scholarCalls = (sc.openalex || 0) + (sc.pubmed || 0) + (sc.arxiv || 0);
  footer.textContent = `TinyFish · Search ${u.search || 0} · Fetch ${u.fetch || 0} · Agent ${u.agent || 0} · Research ${u.research || 0}${scholarCalls ? ` | Papers · OpenAlex ${sc.openalex || 0} · PubMed ${sc.pubmed || 0} · arXiv ${sc.arxiv || 0}` : ''}`;

  const stop = document.getElementById('act-stop');
  if (stop) stop.onclick = () => chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop', id: current?.req?.id }).catch(() => {});
  const copy = document.getElementById('act-copy');
  if (copy)
    copy.onclick = async () => {
      await navigator.clipboard.writeText(traceToMarkdown(s));
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy report'), 1500);
    };
  const rerun = document.getElementById('act-rerun');
  if (rerun) rerun.onclick = () => chrome.runtime.sendMessage({ type: 'sh:rerun', id: current?.req?.id }).catch(() => {});
}

