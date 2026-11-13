// TinyFish Fetch returns clean page text and a flat list of the page's links, but not
// where each link sits in the text. To know which links a passage actually cites,
// this module reads the page's raw HTML and records each link's position in the
// visible text, plus element ids so footnote markers like [19] can be resolved.
// No DOM needed, so it works in the extension and in Node.

const BLOCK = new Set(['p', 'div', 'li', 'ul', 'ol', 'br', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'blockquote', 'figcaption', 'dd', 'dt', 'table', 'header', 'footer', 'aside', 'nav']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', thinsp: ' ', ensp: ' ', emsp: ' ' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

function resolve(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/** Visible text of an HTML page, with link spans and id positions. */
export function buildLinkMap(html, baseUrl) {
  html = html
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  let text = '';
  const links = [];
  const ids = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let m;
  let open = null;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      const t = decode(m[4]).replace(/\s+/g, ' ');
      if (t === ' ' && text.endsWith(' ')) continue;
      text += t;
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (BLOCK.has(tag) && !text.endsWith('\n')) text = text.replace(/ $/, '') + '\n';
    if (!closing) {
      const id = attr(attrs, 'id');
      if (id) ids.push({ id, pos: text.length });
    }
    if (tag === 'a') {
      if (!closing) {
        const href = attr(attrs, 'href');
        open = href ? { url: resolve(href, baseUrl), rawHref: href, start: text.length } : null;
      } else if (open) {
        if (open.url) links.push({ ...open, end: text.length, text: text.slice(open.start).trim().slice(0, 140) });
        open = null;
      }
    }
  }
  return { text, links, ids };
}

const wordsOf = (s) => (s || '').toLowerCase().match(/[a-z0-9]+/g) || [];

/** Finds where a passage (from Fetch's text) sits in the link map's text. */
function findPassage(map, quote) {
  const w = wordsOf(quote);
  if (w.length < 3) return null;
  const lower = map.text.toLowerCase();
  for (const take of [8, 5, 3]) {
    for (const from of [0, Math.max(0, Math.floor(w.length / 2) - 2)]) {
      const part = w.slice(from, from + take);
      if (part.length < Math.min(3, w.length)) continue;
      const re = new RegExp(part.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]+'), 'g');
      const m = re.exec(lower);
      if (m) {
        const start = Math.max(0, m.index - (from ? quote.length / 2 : 0));
        return { start, end: Math.min(map.text.length, start + quote.length * 1.15 + 20) };
      }
    }
  }
  return null;
}

function samePage(url, pageUrl) {
  const n = (u) => (u || '').split('#')[0].replace(/\/$/, '');
  return n(url) === n(pageUrl);
}

/** The external links inside a footnote/reference entry that a same-page anchor points to. */
function footnoteLinks(map, hash, pageUrl, depth = 0) {
  const id = decodeURIComponent(hash.replace(/^#/, ''));
  const i = map.ids.findIndex((x) => x.id === id);
  if (i < 0 || depth > 1) return [];
  const pos = map.ids[i].pos;
  const prefix = id.replace(/[\d-:_.]+.*$/, '') || id;
  const next = map.ids.slice(i + 1).find((x) => x.pos > pos && x.id.startsWith(prefix));
  const end = Math.min(next ? next.pos : Infinity, pos + 1500);
  const out = [];
  for (const l of map.links) {
    if (l.start < pos || l.start >= end) continue;
    if (samePage(l.url, pageUrl)) {
      // Harvard-style citations: footnote → bibliography entry
      if (/CITEREF/i.test(l.url)) out.push(...footnoteLinks(map, new URL(l.url).hash, pageUrl, depth + 1));
      continue;
    }
    out.push({ url: l.url, text: l.text, via: 'footnote' });
  }
  return out;
}

/**
 * Links the passage cites: links inside the passage (weight 4), links in footnotes
 * the passage points to (4.5), and links in the rest of its paragraph (3).
 */
export function linksForPassage(map, quote, pageUrl) {
  const span = findPassage(map, quote);
  if (!span) return null;
  const paraStart = map.text.lastIndexOf('\n', span.start) + 1;
  let paraEnd = map.text.indexOf('\n', span.end);
  if (paraEnd < 0) paraEnd = map.text.length;
  // The paragraph before often introduces the source ("according to a new study from…").
  const prevStart = paraStart > 1 ? map.text.lastIndexOf('\n', paraStart - 2) + 1 : paraStart;
  const nextEnd = (() => {
    const i = map.text.indexOf('\n', paraEnd + 1);
    return i < 0 ? map.text.length : i;
  })();
  const out = [];
  for (const l of map.links) {
    if (l.start > nextEnd + 1 || l.end < prevStart - 1) continue;
    const inPara = l.start <= paraEnd + 1 && l.end >= paraStart - 1;
    const inside = l.start >= span.start - 40 && l.start <= span.end + 60;
    if (!inPara) {
      if (!samePage(l.url, pageUrl) && !/^#/.test(l.rawHref)) out.push({ url: l.url, text: l.text, weight: 2, via: 'nearby' });
      continue;
    }
    if (samePage(l.url, pageUrl) || /^#/.test(l.rawHref)) {
      if (!inside) continue;
      const hash = l.rawHref.startsWith('#') ? l.rawHref : (() => { try { return new URL(l.url).hash; } catch { return ''; } })();
      if (hash) for (const f of footnoteLinks(map, hash, pageUrl)) out.push({ ...f, weight: 4.5 });
      continue;
    }
    out.push({ url: l.url, text: l.text, weight: inside ? 4 : 3, via: inside ? 'inline' : 'paragraph' });
  }
  return out;
}

/** Downloads a page's raw HTML (best effort; returns null on failure or non-HTML). */
export async function getHtml(url, { timeout = 15000, signal } = {}) {
  if (/\.pdf(\?|#|$)/i.test(url)) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', credentials: 'omit', headers: { Accept: 'text/html,application/xhtml+xml' } });
    if (!res.ok || !/html|xml/i.test(res.headers.get('content-type') || '')) return null;
    const html = await res.text();
    return html.length > 6e6 ? html.slice(0, 6e6) : html;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- fallbacks when HTML can't be read

const GENERIC = /^(the|and|for|with|from|that|this|www|com|org|net|html|htm|php|aspx|index|news|article|articles|story|stories|blog|post|posts|page|pages|https?|research|report|reports|study|data|national|center|centre|institute|university|international|global|office|department|press|release|releases|media|about|content|uploads|files|default|en|us|uk)$/;

/**
 * When the HTML isn't available: DOIs and URLs written in the passage, and page links
 * whose address shares a distinctive word with the passage ("Science Advances" →
 * science.org/doi/…sciadv…).
 */
export function linksFromText(passageText, pageLinks, pageUrl) {
  const out = [];
  for (const m of passageText.matchAll(/\b(10\.\d{4,9}\/[^\s"<>,;]+[^\s"<>,;.)\]])/g)) out.push({ url: `https://doi.org/${m[1]}`, text: m[1], weight: 4 });
  for (const m of passageText.matchAll(/https?:\/\/[^\s"<>)\]]+/g)) out.push({ url: m[0].replace(/[.,;]+$/, ''), text: '', weight: 4 });
  const words = new Set(wordsOf(passageText).filter((w) => w.length >= 4 && !GENERIC.test(w)));
  let pageHost = '';
  try {
    pageHost = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {}
  for (const u of pageLinks || []) {
    let host = '';
    let path = '';
    try {
      const x = new URL(u);
      host = x.hostname.replace(/^www\./, '');
      path = x.pathname;
    } catch {
      continue;
    }
    if (!host || host === pageHost) continue;
    const toks = wordsOf(host.split('.').slice(0, -1).join(' ') + ' ' + path).filter((w) => w.length >= 4 && !GENERIC.test(w));
    const hits = toks.filter((t) => words.has(t) || [...words].some((w) => w.length >= 5 && (t.startsWith(w.slice(0, 5)) || w.startsWith(t.slice(0, 5)))));
    if (hits.length) out.push({ url: u, text: '', weight: 2 + Math.min(1, hits.length * 0.5), via: 'mention' });
  }
  return out;
}
