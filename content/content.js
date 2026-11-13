// Runs inside every web page. When you select text it shows a small "Trace source"
// button, and it gathers what the tracer needs from the page itself: the full
// sentence, the links cited next to the claim (including footnotes) and the page date.

(() => {
  if (window.__checkyLoaded) return;
  window.__checkyLoaded = true;

  const BLOCK_TAGS = /^(P|LI|BLOCKQUOTE|TD|TH|DD|DT|FIGCAPTION|H[1-6]|CAPTION)$/;
  let lastCtx = null;
  let lastRange = null;
  /** A trace is starting from this selection: the result card (card.js) anchors to it. */
  const commit = (ctx) => {
    if (ctx?.claim && lastRange) {
      window.__shPendingRange = lastRange;
      window.__shCardPending?.(); // the "Checking…" pill, straight away
    }
    return ctx;
  };
  let showButton = true;
  let theme = 'light';
  chrome.storage.local
    .get({ showButton: true, theme: 'light' })
    .then((s) => {
      showButton = s.showButton;
      theme = s.theme;
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.showButton) showButton = ch.showButton.newValue;
    if (ch.theme) theme = ch.theme.newValue;
  });

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function blockOf(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== document.body) {
      if (BLOCK_TAGS.test(el.tagName)) return el;
      const d = getComputedStyle(el).display;
      if ((d === 'block' || d === 'list-item' || d === 'table-cell') && norm(el.innerText).length > 30) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  /** The sentence(s) around the selection, word for word as shown on the page. */
  function sentenceAround(blockText, sel) {
    const i = blockText.indexOf(sel);
    if (i < 0) return sel;
    const before = blockText.slice(0, i);
    const after = blockText.slice(i + sel.length);
    const startM = before.match(/[\s\S]*[.!?…]["”’)\]]?\s+(?=["“‘(\[]?[A-Z0-9])/);
    const start = startM ? startM[0].length : 0;
    const endM = after.match(/[.!?…]["”’)\]]?(?=\s+["“‘(\[]?[A-Z0-9]|\s*$)/);
    const end = i + sel.length + (endM ? endM.index + endM[0].length : after.length);
    return norm(blockText.slice(start, end));
  }

  function textOffset(block, node) {
    try {
      const r = document.createRange();
      r.setStart(block, 0);
      r.setEndBefore(node);
      return r.toString().length;
    } catch {
      return 0;
    }
  }

  function isSamePageAnchor(a) {
    try {
      const u = new URL(a.href, location.href);
      return u.hash && u.origin === location.origin && u.pathname === location.pathname;
    } catch {
      return false;
    }
  }

  /** Links in a footnote/reference entry that a same-page anchor (e.g. [12]) points to. */
  function footnoteLinks(a, depth = 0) {
    if (depth > 1) return [];
    let id;
    try {
      id = decodeURIComponent(new URL(a.href, location.href).hash.slice(1));
    } catch {
      return [];
    }
    const target = id && document.getElementById(id);
    if (!target) return [];
    const box = target.closest('li, p, dd, aside, .footnote, .reference, [role="doc-endnote"], [role="doc-footnote"]') || target;
    const out = [];
    for (const b of box.querySelectorAll('a[href]')) {
      if (isSamePageAnchor(b)) {
        if (/^#?(CITEREF|cite_ref|fnref)/i.test(new URL(b.href).hash.slice(1))) {
          if (/CITEREF/i.test(b.href)) out.push(...footnoteLinks(b, depth + 1));
        }
        continue;
      }
      out.push(b);
    }
    return out;
  }

  function collectLinks(range, block, sentence) {
    const out = [];
    const seen = new Set();
    const blockText = block.innerText || '';
    const selStart = textOffset(block, range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement) || 0;
    const sentEnd = selStart + (sentence?.length || 200) + 40;
    const add = (a, weight, via) => {
      const url = a.href;
      if (!/^https?:/i.test(url) || seen.has(url)) return;
      seen.add(url);
      out.push({ url, text: norm(a.innerText || a.title || '').slice(0, 140), weight, via });
    };
    const consider = (a, weight) => {
      if (isSamePageAnchor(a)) {
        for (const b of footnoteLinks(a)) add(b, weight + 0.5, 'footnote');
      } else add(a, weight);
    };
    for (const a of block.querySelectorAll('a[href]')) {
      let w = 2;
      if (range.intersectsNode(a)) w = 4;
      else {
        const off = textOffset(block, a);
        if (off >= selStart - 300 && off <= sentEnd) w = 3;
      }
      consider(a, w);
    }
    if (block !== document.body && blockText.length < 4000) {
      // Neighbouring paragraphs in reading order. Sites often wrap each paragraph in its
      // own <div> (TIME does), so plain DOM siblings miss the link one paragraph up that a
      // claim often relies on ("…a new study [link] … Microsoft found that…").
      const [before, after] = neighbourBlocks(block);
      before.forEach((b, i) => b.querySelectorAll('a[href]').forEach((a) => consider(a, i === 0 ? 2.5 : 1.5)));
      after.forEach((b, i) => b.querySelectorAll('a[href]').forEach((a) => consider(a, i === 0 ? 2 : 1)));
    }
    return out.slice(0, 40);
  }

  /** Up to 2 text blocks before and 1 after this one, nearest first, within the article. */
  function neighbourBlocks(block) {
    const scope = block.closest('article, main, [role="main"]') || document.body;
    const all = [...scope.querySelectorAll('p, li, blockquote, dd, h2, h3, h4')].filter(
      (b) => !b.contains(block) && !block.contains(b) && norm(b.innerText).length > 20,
    );
    const before = [];
    const after = [];
    for (const b of all) {
      if (block.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING) before.push(b);
      else after.push(b);
    }
    // Stop at a heading: a new section's links aren't about this claim.
    const upTo = (list) => {
      const out = [];
      for (const b of list) {
        if (/^H\d$/.test(b.tagName)) break;
        out.push(b);
      }
      return out;
    };
    return [upTo(before.reverse()).slice(0, 2), upTo(after).slice(0, 1)];
  }

  function pageDate() {
    const metas = [
      'meta[property="article:published_time"]',
      'meta[name="article:published_time"]',
      'meta[name="citation_publication_date"]',
      'meta[name="citation_date"]',
      'meta[name="dc.date"]',
      'meta[name="DC.date.issued"]',
      'meta[name="date"]',
      'meta[name="pubdate"]',
      'meta[itemprop="datePublished"]',
    ];
    for (const sel of metas) {
      const v = document.querySelector(sel)?.getAttribute('content');
      if (v) return v;
    }
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      const m = s.textContent.match(/"datePublished"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return document.querySelector('time[datetime]')?.getAttribute('datetime') || null;
  }

  function getContext() {
    const sel = window.getSelection();
    const claim = norm(sel?.toString());
    // Nothing selected now: don't fall back to an earlier claim (Alt+Shift+S with no
    // selection, or a selection inside a frame, would silently re-check the old one).
    if (!claim || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    lastRange = range.cloneRange();
    const block = blockOf(range.commonAncestorContainer);
    const blockText = norm(block.innerText || block.textContent);
    const sentence = block === document.body ? claim : sentenceAround(blockText, claim);
    const i = sentence.indexOf(claim);
    const inQuotes = i > 0 && /["“]\s*$/.test(sentence.slice(0, i)) && /^\s*["”]/.test(sentence.slice(i + claim.length));
    lastCtx = {
      claim,
      sentence,
      inQuotes,
      context: blockText.slice(0, 1500),
      url: location.href.split('#:~:')[0],
      title: document.title,
      pageDate: pageDate(),
      links: collectLinks(range, block, sentence),
    };
    return lastCtx;
  }

  // ---------------------------------------------------------------- floating button

  let host = null;
  let btn = null;
  function ensureButton() {
    if (host) return;
    window.__checkyPageStyle?.();
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;display:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        button{all:unset;cursor:pointer;display:flex;align-items:center;gap:7px;
          font:550 12.5px/1 "Checky Geist","Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:-.005em;
          background:#17171a;color:#f7f6f2;padding:8px 12px 8px 10px;border-radius:999px;
          box-shadow:0 1px 2px rgba(20,20,24,.12),0 6px 18px rgba(20,20,24,.22);-webkit-font-smoothing:antialiased}
        button:hover{background:#2a2a2e}
        button.dark{background:#ededea;color:#17171a;box-shadow:0 1px 2px rgba(0,0,0,.4),0 6px 18px rgba(0,0,0,.5)}
        button.dark:hover{background:#ffffff}
        svg{width:14px;height:14px}
      </style>
      <button type="button" title="Trace this back to its original source (Alt+Shift+S)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M5.4 8.2l1.8 1.8 3.5-3.7"/></svg>
        Check source
      </button>`;
    btn = root.querySelector('button');
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const ctx = commit(getContext() || lastCtx);
      hide();
      if (ctx?.claim) chrome.runtime.sendMessage({ type: 'sh:trace', payload: ctx });
    });
    document.documentElement.appendChild(host);
  }
  function hide() {
    if (host) host.style.display = 'none';
  }

  document.addEventListener('mouseup', (e) => {
    if (!showButton || (host && e.composedPath().includes(host))) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = norm(sel?.toString());
      const editable = document.activeElement?.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]');
      if (!text || text.length < 3 || text.length > 800 || editable || !sel.rangeCount) return hide();
      getContext();
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      ensureButton();
      btn.classList.toggle('dark', theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches));
      host.style.display = 'block';
      const x = Math.min(window.innerWidth - 140, Math.max(8, rect.right - 60));
      const y = rect.bottom + 8 > window.innerHeight - 40 ? rect.top - 38 : rect.bottom + 8;
      host.style.transform = `translate(${x}px, ${y}px)`;
    }, 10);
  });
  document.addEventListener('selectionchange', () => {
    if (!norm(window.getSelection()?.toString())) hide();
  });
  window.addEventListener('scroll', hide, { passive: true });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'sh:getContext') sendResponse(commit(getContext()));
    else if (msg?.type === 'sh:card') window.__shCard?.(msg.card);
  });
})();
