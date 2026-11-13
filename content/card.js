// The on-page result card: a summary of the trace drawn next to the text you highlighted,
// joined to it by a connector line. It shows the verdict, the trail as a citation
// timeline (with each site's icon), and a short summary. The full trail stays in the
// side panel ("Full trail").
//
// Everything lives in a closed shadow root, so the page's styles can't reach it, and the
// highlight uses the CSS Custom Highlight API, so the page's HTML is never modified.
// Colours and type come from ui/tokens.css (shared with the side panel and Settings).

(() => {
  if (window.__checkyCard) return;
  window.__checkyCard = true;

  const W = 340;
  const GAP = 36;
  const TONE = {
    match: 'ok', supported: 'ok',
    rounded: 'warn', partial: 'warn',
    changed: 'bad', misquoted: 'bad', unsupported: 'bad',
    none: 'none',
  };
  const SHORT = { match: 'Matches', supported: 'Supported', rounded: 'Rounded', partial: 'Partly backed', changed: 'Changed', misquoted: 'Misquoted', unsupported: 'Not backed up', none: 'No source found' };
  const KIND = { primary: 'primary source', press: 'press release', publisher: 'publisher', document: 'document', reference: 'reference', social: 'social media', secondary: 'article' };
  const STEP_STATUS = { match: 'matches', supported: 'supports', rounded: 'rounded', changed: 'changed', misquoted: 'misquoted', partial: 'no figure', unsupported: 'doesn’t support' };
  const NUM_TONE = { exact: 'ok', approx: 'ok', rounded: 'warn', changed: 'bad', 'unit-changed': 'bad' };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
  const extUrl = (p) => {
    try {
      return chrome.runtime.getURL(p);
    } catch {
      return '';
    }
  };
  const favicon = (u) => extUrl(`/_favicon/?pageUrl=${encodeURIComponent(u)}&size=32`);

  // Shared design tokens, fetched once from the extension.
  let tokensCss = '';
  const tokensReady = fetch(extUrl('ui/tokens.css'))
    .then((r) => r.text())
    .then((t) => (tokensCss = t))
    .catch(() => '');

  let host = null;
  let root = null;
  let wrap = null;
  let cardEl = null;
  let svg = null;
  let anchor = null; // Range of the highlighted claim
  let currentId = null;
  let collapsed = false;
  // null: automatic (a "Checking" pill while the trace runs, the full card once there's a
  // verdict). 'expanded' / 'collapsed': the reader chose, and that sticks for this trace.
  let userMode = null;
  let raf = 0;
  let startTimer = 0;
  let enabled = true;
  let theme = 'light';
  chrome.storage.local
    .get({ showCard: true, theme: 'light' })
    .then((s) => {
      enabled = s.showCard !== false;
      theme = s.theme;
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.showCard) enabled = ch.showCard.newValue !== false;
    if (ch.theme) {
      theme = ch.theme.newValue;
      document.getElementById('checky-page')?.remove(); // re-made with the new highlight colours
      if (wrap) {
        wrap.dataset.theme = theme;
        if (lastCard) draw(lastCard);
      }
    }
  });

  // ---------------------------------------------------------------- page-level styles

  const HL = ['sh-run', 'sh-ok', 'sh-warn', 'sh-bad', 'sh-none'];
  /** Highlight colours and the bundled fonts, which can't be declared inside a shadow root. */
  function ensurePageStyle() {
    if (document.getElementById('checky-page')) return;
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    const a = dark ? [0.14, 0.22, 0.26, 0.24, 0.22] : [0.1, 0.18, 0.26, 0.18, 0.18];
    const st = document.createElement('style');
    st.id = 'checky-page';
    st.textContent = `
      @font-face{font-family:"Checky Geist";src:url("${extUrl('fonts/Geist-Variable.woff2')}") format("woff2");font-weight:100 900;font-display:swap}
      @font-face{font-family:"Checky Geist Mono";src:url("${extUrl('fonts/GeistMono-Variable.woff2')}") format("woff2");font-weight:100 900;font-display:swap}
      ::highlight(sh-run){background-color:rgba(${dark ? '237,237,234' : '23,23,26'},${a[0]})}
      ::highlight(sh-ok){background-color:rgba(${dark ? '98,207,146' : '22,121,74'},${a[1]})}
      ::highlight(sh-warn){background-color:rgba(${dark ? '240,185,82' : '214,150,20'},${a[2]})}
      ::highlight(sh-bad){background-color:rgba(${dark ? '255,139,125' : '179,38,30'},${a[3]})}
      ::highlight(sh-none){background-color:rgba(${dark ? '169,180,199' : '86,98,122'},${a[4]})}`;
    (document.head || document.documentElement).appendChild(st);
  }
  window.__checkyPageStyle = ensurePageStyle; // content.js: fonts for the "Check source" button

  function setHighlight(tone) {
    if (!window.CSS?.highlights || !anchor) return;
    ensurePageStyle();
    for (const n of HL) CSS.highlights.delete(n);
    CSS.highlights.set(`sh-${tone}`, new Highlight(anchor));
  }
  function clearHighlight() {
    if (window.CSS?.highlights) for (const n of HL) CSS.highlights.delete(n);
  }

  // ---------------------------------------------------------------- shell

  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ck {
      --font: "Checky Geist", "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --mono: "Checky Geist Mono", "Geist Mono", ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;
      font: 13px/1.5 var(--font); color: var(--ink); -webkit-font-smoothing: antialiased; letter-spacing: -0.003em;
    }
    .ck { --tone: var(--run); --tone-bg: var(--run-bg); --tone-line: var(--run-line); }
    .t-ok { --tone: var(--ok); --tone-bg: var(--ok-bg); --tone-line: var(--ok-line); }
    .t-warn { --tone: var(--warn); --tone-bg: var(--warn-bg); --tone-line: var(--warn-line); }
    .t-bad { --tone: var(--bad); --tone-bg: var(--bad-bg); --tone-line: var(--bad-line); }
    .t-none { --tone: var(--none); --tone-bg: var(--none-bg); --tone-line: var(--none-line); }
    .t-run { --tone: var(--run); --tone-bg: var(--run-bg); --tone-line: var(--run-line); }
    .m { font-family: var(--mono); font-size: 11px; letter-spacing: 0; color: var(--ink-3); }

    svg.link { position: fixed; inset: 0; width: 100vw; height: 100vh; overflow: visible; pointer-events: none; }
    svg.link path { fill: none; stroke-width: 1.25; }
    svg.link path.br { stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
    svg.link circle { stroke-width: 1.25; }

    .card {
      position: fixed; top: 0; left: 0; width: ${W}px; max-width: calc(100vw - 24px);
      background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
      box-shadow: var(--shadow); pointer-events: auto; overflow: hidden; animation: pop .16s ease-out;
    }
    @keyframes pop { from { opacity: 0; } }

    .head { display: flex; align-items: flex-start; gap: 9px; padding: 13px 8px 0 15px; }
    .head .vdot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone); flex: none; margin-top: 6px; }
    .head .h { flex: 1; font-size: 14.5px; font-weight: 560; line-height: 1.3; color: var(--tone); letter-spacing: -0.012em; padding-top: 1px; }
    .t-run .head .h { color: var(--ink); }
    .icon-btn { all: unset; cursor: pointer; width: 24px; height: 24px; border-radius: 6px; display: grid; place-items: center; color: var(--ink-3); flex: none; }
    .icon-btn:hover { background: var(--sunk); color: var(--ink); }
    .icon-btn svg { width: 14px; height: 14px; }

    .claim { margin: 10px 15px 0; padding: 1px 0 1px 10px; border-left: 2px solid var(--tone-line); color: var(--ink-2);
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .claim .fig { font-family: var(--mono); font-size: 12px; border-radius: 3px; padding: 0 3px; }
    .fig.ok { background: var(--ok-bg); color: var(--ok); }
    .fig.warn { background: var(--warn-bg); color: var(--warn); }
    .fig.bad { background: var(--bad-bg); color: var(--bad); }

    .tl { list-style: none; margin: 14px 15px 0 20px; padding: 0 0 0 15px; border-left: 1px solid var(--line-2); }
    .tl li { position: relative; padding-bottom: 10px; }
    .tl li:last-child { padding-bottom: 0; }
    .tl .d { position: absolute; left: -20px; top: 5px; width: 9px; height: 9px; border-radius: 50%; background: var(--surface); border: 1.5px solid var(--line-2); }
    .tl .d.ok { background: var(--ok); border-color: var(--ok); }
    .tl .d.warn { background: var(--warn); border-color: var(--warn); }
    .tl .d.bad { background: var(--bad); border-color: var(--bad); }
    .tl .d.origin { box-shadow: 0 0 0 3px var(--surface), 0 0 0 4px var(--line-2); }
    .tl .d.end { border-style: dashed; border-color: var(--tone); background: var(--surface); }
    .tl .d.spin { border-color: var(--line-2); border-top-color: var(--ink); animation: r .8s linear infinite; }
    .tl a { display: block; color: inherit; text-decoration: none; border-radius: 6px; margin: -2px -6px; padding: 2px 6px; }
    .tl a:hover { background: var(--sunk); }
    .tl .t { display: flex; align-items: center; gap: 6px; font-weight: 500; min-width: 0; }
    .tl .t img { width: 14px; height: 14px; border-radius: 3px; flex: none; }
    .tl .t span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tl .s { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
    .tl .s .ok { color: var(--ok); } .tl .s .warn { color: var(--warn); } .tl .s .bad { color: var(--bad); }
    .tl .end-t { color: var(--tone); font-weight: 500; }
    .t-run .tl .end-t { color: var(--ink-2); font-weight: 400; }

    .summary { margin: 13px 15px 0; color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
    .foot { display: flex; align-items: center; gap: 8px; margin-top: 13px; padding: 9px 12px 10px 15px; border-top: 1px solid var(--line); }
    .foot .m { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .open { all: unset; cursor: pointer; font-weight: 550; font-size: 12.5px; color: var(--ink); white-space: nowrap; border-radius: 6px; padding: 3px 6px; margin-right: -6px; }
    .open:hover { background: var(--sunk); }

    .spin { width: 11px; height: 11px; flex: none; border-radius: 50%; border: 1.5px solid var(--line-2); border-top-color: var(--ink); animation: r .8s linear infinite; }
    @keyframes r { to { transform: rotate(360deg); } }

    .pill { position: fixed; top: 0; left: 0; pointer-events: auto; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px 10px; border-radius: 999px;
      background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); font-weight: 550; font-size: 12.5px; color: var(--ink); white-space: nowrap; animation: pop .16s ease-out; }
    .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone); flex: none; }
    .pill:hover { border-color: var(--tone-line); }
    .pill .m { font-weight: 400; }
  `;

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style class="tokens">${tokensCss}</style>
      <style>${CSS_TEXT}</style>
      <div class="ck" data-theme="${esc(theme)}">
        <svg class="link"><path></path><circle r="3"></circle><circle r="3"></circle><path class="br"></path></svg>
        <div class="card" role="dialog" aria-label="Checky result"></div>
      </div>`;
    if (!tokensCss) tokensReady.then(() => root && (root.querySelector('style.tokens').textContent = tokensCss) && schedule());
    wrap = root.querySelector('.ck');
    svg = root.querySelector('svg.link');
    cardEl = root.querySelector('.card');
    cardEl.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const act = t.dataset.act;
      if (act === 'close') remove();
      else if (act === 'min') {
        userMode = 'collapsed';
        draw(lastCard);
      } else if (act === 'expand') {
        userMode = 'expanded';
        draw(lastCard);
      } else if (act === 'open') chrome.runtime.sendMessage({ type: 'sh:openPanel', id: currentId }).catch(() => {});
      else if (act === 'settings') chrome.runtime.sendMessage({ type: 'sh:openOptions' }).catch(() => {});
      else if (act === 'retry') {
        const id = currentId === PENDING ? null : currentId;
        window.__shCardPending?.(true);
        chrome.runtime.sendMessage({ type: 'sh:rerun', id }).catch(() => {});
      }
    });
    document.documentElement.appendChild(host);
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule, { passive: true });
    document.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape' && host && !collapsed) {
      userMode = 'collapsed';
      draw(lastCard);
    }
  }

  function remove() {
    clearTimeout(startTimer);
    clearHighlight();
    window.removeEventListener('scroll', schedule, { capture: true });
    window.removeEventListener('resize', schedule);
    document.removeEventListener('keydown', onKey);
    host?.remove();
    host = root = wrap = cardEl = svg = null;
    anchor = null;
    currentId = null;
  }

  // ---------------------------------------------------------------- content

  let lastCard = null;

  const nothingBehind = (v) => v?.status === 'none' && /nothing behind/i.test(v.headline || '');

  function toneOf(c) {
    if (c.status === 'error') return 'bad';
    if (c.status === 'cancelled') return 'none';
    if (!c.verdict || c.status === 'running') return 'run';
    if (nothingBehind(c.verdict)) return 'warn';
    return TONE[c.verdict.status] || 'none';
  }

  /** The claim, with any figure the source states differently marked in its tone. */
  function claimHtml(c) {
    let out = esc(c.claim);
    for (const f of c.figures || []) {
      const t = NUM_TONE[f.status];
      if (!t || !f.raw || t === 'ok') continue;
      const e = esc(f.raw);
      const i = out.indexOf(e);
      if (i >= 0) out = `${out.slice(0, i)}<span class="fig ${t}">${e}</span>${out.slice(i + e.length)}`;
    }
    return `“${out}”`;
  }

  function stepRow(st, i, c) {
    const isOrigin = c.verdict?.originIndex === i && i > 0;
    const tone = i === 0 ? '' : TONE[st.status] || '';
    const label = i === 0 ? 'this page' : STEP_STATUS[st.status] || KIND[st.kind] || '';
    const sub = [esc(st.venue || st.site), st.date && esc(st.date), label && (tone ? `<span class="${tone}">${esc(label)}</span>` : esc(label)), st.archived && 'archived', st.abstractOnly && 'abstract only']
      .filter(Boolean)
      .join(' · ');
    const fav = favicon(st.favUrl || st.url);
    return `
      <li><span class="d ${tone} ${isOrigin ? 'origin' : ''}"></span>
        <a href="${esc(safeUrl(st.url))}" target="_blank" rel="noopener" title="${esc(st.title || st.site)}">
          <div class="t">${fav ? `<img src="${esc(fav)}" alt="">` : ''}<span>${esc(st.title || st.site)}</span></div>
          <div class="s m">${sub}</div>
        </a></li>`;
  }

  function endRow(c) {
    const busy = c.status === 'running' || c.status === 'researching';
    if (c.status === 'cancelled') return '';
    if (busy) {
      const text = c.status === 'researching' ? 'TinyResearch is still digging' : c.phase || 'Working';
      return `<li><span class="d spin"></span><div class="end-t">${esc(text)}</div></li>`;
    }
    if (c.verdict?.status !== 'none') return '';
    const deep = c.research === 'done';
    const text = nothingBehind(c.verdict) ? 'No study or data behind it' : 'No earlier source found';
    return `<li><span class="d end"></span><div class="end-t">${esc(text)}</div><div class="s m">${deep ? 'checked with search and TinyResearch' : 'checked with search'}</div></li>`;
  }

  const ICON_MIN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h8"/></svg>';
  const ICON_X = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';

  function cardHtml(c) {
    const v = c.verdict;
    const busy = c.status === 'running' || c.status === 'researching';
    const stopped = c.status === 'cancelled';
    const headline = c.status === 'error' ? (c.needsKey ? 'API key needed' : 'Check failed') : stopped ? 'Check stopped' : v ? v.headline : 'Checking the source…';
    const summary = c.status === 'error' ? c.error : stopped ? 'This check was stopped before it finished, so the trail is incomplete.' : v ? v.research || v.detail : '';
    const n = c.steps.length;
    const meta = busy
      ? `${n} source${n === 1 ? '' : 's'} so far`
      : c.status === 'error' || stopped
        ? ''
        : [`${n} source${n === 1 ? '' : 's'}`, c.elapsed && `${c.elapsed < 90 ? `${c.elapsed} s` : `${Math.round(c.elapsed / 60)} min`}`].filter(Boolean).join(' · ');
    const action = c.needsKey
      ? '<button class="open" data-act="settings">Open settings →</button>'
      : c.status === 'error' || stopped
        ? '<button class="open" data-act="retry">Try again</button>'
        : '<button class="open" data-act="open">Full trail →</button>';
    return `
      <div class="head">
        ${busy ? '<span class="spin" style="margin-top:4px"></span>' : '<span class="vdot"></span>'}
        <div class="h">${esc(headline)}</div>
        <button class="icon-btn" data-act="min" title="Minimise (Esc)" aria-label="Minimise">${ICON_MIN}</button>
        <button class="icon-btn" data-act="close" title="Close" aria-label="Close">${ICON_X}</button>
      </div>
      <div class="claim">${claimHtml(c)}</div>
      ${n || busy ? `<ol class="tl">${c.steps.map((s, i) => stepRow(s, i, c)).join('')}${endRow(c)}</ol>` : ''}
      ${summary ? `<div class="summary">${esc(summary)}</div>` : ''}
      <div class="foot"><span class="m">${esc(meta)}</span>${action}</div>`;
  }

  function pillHtml(c) {
    if (c.status === 'running') {
      const n = c.steps?.length || 0;
      return `<span class="spin"></span><span>Checking</span>${n > 1 ? `<span class="m">· ${n} sources</span>` : ''}`;
    }
    const v = c.verdict;
    const text = c.status === 'error' ? (c.needsKey ? 'API key needed' : 'Check failed') : c.status === 'cancelled' ? 'Stopped' : nothingBehind(v) ? 'Nothing behind it' : SHORT[v?.status] || v?.headline || 'Done';
    return `<span class="dot"></span><span>${esc(text)}</span>`;
  }

  function draw(c) {
    if (!c || !cardEl) return;
    lastCard = c;
    const tone = toneOf(c);
    setHighlight(tone);
    wrap.className = `ck t-${tone}`;
    wrap.dataset.theme = theme;
    collapsed = userMode ? userMode === 'collapsed' : c.status === 'running';
    if (collapsed) {
      cardEl.className = 'pill';
      cardEl.innerHTML = pillHtml(c);
      cardEl.dataset.act = 'expand';
      cardEl.title = c.status === 'running' ? `${c.phase || 'Checking'} (click to see progress)` : 'Show the result';
      cardEl.setAttribute('role', 'button');
    } else {
      cardEl.className = 'card';
      cardEl.removeAttribute('data-act');
      cardEl.removeAttribute('title');
      cardEl.setAttribute('role', 'dialog');
      cardEl.innerHTML = cardHtml(c);
    }
    place(); // position now, so the card never shows at the corner for a frame
    const stroke = getComputedStyle(wrap).getPropertyValue('--tone').trim() || '#17171a';
    for (const p of svg.querySelectorAll('path')) p.style.stroke = stroke;
    for (const ci of svg.querySelectorAll('circle')) {
      ci.style.stroke = stroke;
      ci.style.fill = 'var(--surface)';
    }
    schedule();
  }

  // ---------------------------------------------------------------- placement + connector

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      place();
    });
  }

  function columnRect() {
    let el = anchor?.commonAncestorContainer;
    if (el && el.nodeType !== 1) el = el.parentElement;
    // The text column: the nearest ancestor that's reasonably wide.
    while (el && el !== document.body) {
      const r = el.getBoundingClientRect();
      if (r.width >= 280) return r;
      el = el.parentElement;
    }
    return anchor.getBoundingClientRect();
  }

  function place() {
    if (!anchor || !cardEl) return;
    const rects = [...anchor.getClientRects()].filter((r) => r.width > 0);
    const sel = anchor.getBoundingClientRect();
    if (!rects.length && !sel.width) return;
    const first = rects[0] || sel;
    const last = rects[rects.length - 1] || sel;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = cardEl.offsetWidth;
    const h = cardEl.offsetHeight;
    const col = columnRect();

    let x;
    let y;
    let side;
    if (vw - col.right >= w + GAP + 12) side = 'right';
    else if (col.left >= w + GAP + 12) side = 'left';
    else side = 'below';

    if (side === 'right') x = Math.min(vw - w - 12, col.right + GAP);
    else if (side === 'left') x = Math.max(12, col.left - GAP - w);
    else x = Math.min(vw - w - 12, Math.max(12, sel.left));

    if (side === 'below') {
      y = sel.bottom + GAP;
      if (y + h > vh - 12 && sel.top - GAP - h >= 12) y = sel.top - GAP - h;
      y = Math.max(12, Math.min(vh - h - 12, y));
    } else {
      // The pill sits level with the middle of the highlighted lines; the card a bit above.
      const target = collapsed ? (first.top + last.bottom) / 2 - h / 2 : sel.top - 24;
      y = Math.max(12, Math.min(vh - h - 12, target));
    }
    cardEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;

    // Connector: from the end of the highlighted text to the nearest edge of the card.
    let sx;
    let sy;
    let ex;
    let ey;
    let bracket = '';
    if (side === 'right' || side === 'left') {
      // Margin note: a bracket beside the highlighted lines (so the line never crosses the
      // text), then a connector from the bracket to the card.
      const bx = side === 'right' ? col.right + 10 : col.left - 10;
      const top = first.top + 2;
      const bot = last.bottom - 2;
      const tick = side === 'right' ? -5 : 5;
      bracket = `M${bx + tick},${top} L${bx},${top} L${bx},${bot} L${bx + tick},${bot}`;
      sx = bx;
      sy = (top + bot) / 2;
      ex = side === 'right' ? x : x + w;
      ey = collapsed ? y + h / 2 : Math.max(y + 16, Math.min(y + h - 16, sy));
    } else {
      const above = y < sel.top;
      sx = (above ? first.left : last.left) + Math.min(40, (above ? first.width : last.width) / 2);
      sy = above ? first.top - 3 : last.bottom + 3;
      ex = Math.max(x + 20, Math.min(x + w - 20, sx));
      ey = above ? y + h : y;
    }
    const offscreen = sel.bottom < 0 || sel.top > vh;
    const horiz = side !== 'below';
    const dx = (ex - sx) / 2;
    const dy = (ey - sy) / 2;
    const d = horiz ? `M${sx},${sy} C${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}` : `M${sx},${sy} C${sx},${sy + dy} ${ex},${ey - dy} ${ex},${ey}`;
    const [path, c1, c2, br] = svg.children;
    path.setAttribute('d', d);
    br.setAttribute('d', bracket);
    c1.setAttribute('cx', sx);
    c1.setAttribute('cy', sy);
    c2.setAttribute('cx', ex);
    c2.setAttribute('cy', ey);
    svg.style.opacity = offscreen ? '0.25' : '1';
  }

  // ---------------------------------------------------------------- updates from the runner

  const PENDING = '__pending';

  /**
   * Shown the instant a check is requested, before the runner has said anything, so
   * there's always a sign that something is happening.
   */
  window.__shCardPending = (keepAnchor = false) => {
    if (!enabled) return;
    const fresh = window.__shPendingRange;
    window.__shPendingRange = null;
    if (fresh && !keepAnchor) anchor = fresh;
    if (!anchor) return;
    currentId = PENDING;
    userMode = null;
    ensureHost();
    draw({ id: PENDING, claim: anchor.toString().replace(/\s+/g, ' ').trim(), status: 'running', phase: 'Starting', steps: [] });
    clearTimeout(startTimer);
    startTimer = setTimeout(() => {
      if (currentId !== PENDING) return;
      userMode = 'expanded';
      draw({ ...lastCard, status: 'error', error: 'The check didn’t start. Reload the extension in chrome://extensions, refresh this page, then try again.' });
    }, 20000);
  };

  window.__shCard = (c) => {
    if (!c?.id) return;
    if (c.id !== currentId) {
      // A new trace: anchor it to the selection that started it (kept by content.js), or
      // keep the current anchor (the pending pill, or the same claim traced again).
      const fresh = window.__shPendingRange;
      window.__shPendingRange = null;
      if (fresh) anchor = fresh;
      if (!anchor) return;
      if (currentId !== PENDING) userMode = null;
      currentId = c.id;
      clearTimeout(startTimer);
      ensureHost();
    }
    draw(c);
  };
})();
