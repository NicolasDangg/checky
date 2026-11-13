// Pure text utilities: parsing figures, locating passages and judging whether a
// source says what a claim says. No browser APIs here, so it runs in Node tests too.

const STOP = new Set(`a an the of to in on for and or but is are was were be been being by with as at
from that this these those it its their there which who whom whose what when where how than then so such
into over under about after before between during per via not no nor can could may might will would should
has have had do does did also most very just only said says say according percent cent one two three four
five six seven eight nine ten million billion thousand trillion new year years more less than other
they them he she his her our we you your all any some each many much unfortunately however since another rest
around approximately nearly almost still even while within among`.split(/\s+/));

export function normalizeSpace(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Removes reference markers that get selected along with a claim: Wikipedia's "[5]",
 * "[a]", "[note 2]" and "[citation needed]". Left in, the
 * "5" in "1.6 million km²[5]" reads as a figure and the claim looks changed.
 */
export function stripRefMarks(s) {
  return normalizeSpace(
    (s || '')
      .replace(/\[(?:\d{1,3}(?:[,–-]\s*\d{1,3})*|[a-z]{1,2}|(?:note|nb|n|lower-alpha)\s*\d{1,3}|citation needed|clarification needed|when\?|who\?|according to whom\?|better source needed|failed verification|dubious\s*[–-]\s*discuss|page needed)\]/gi, ''),
  ).replace(/\s+([.,;:])/g, '$1');
}

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function rawWords(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Content words (stemmed) used for overlap scoring. */
export function keywords(text) {
  return rawWords(text)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w))
    .map(stem);
}

/** Unstemmed content words in order of appearance, for building search queries. */
export function searchTerms(text, max = 8) {
  const seen = new Set();
  const out = [];
  for (const w of rawWords(text)) {
    if (w.length < 3 || /^\d/.test(w) || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out.slice(0, max);
}

/** Share of the claim's distinct keywords that appear in the text (0..1). */
export function overlap(claimKw, textKw) {
  const set = textKw instanceof Set ? textKw : new Set(textKw);
  const uniq = [...new Set(claimKw)];
  if (!uniq.length) return 0;
  let hit = 0;
  for (const k of uniq) if (set.has(k)) hit++;
  return hit / uniq.length;
}

// ---------------------------------------------------------------- numbers

const SCALES = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, mn: 1e6, billion: 1e9, b: 1e9, bn: 1e9, trillion: 1e12, tn: 1e12, kt: 1e3, mt: 1e6, gt: 1e9, bt: 1e9 };
const SMALL = { one: 1, a: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, hundred: 100 };
const QUAL_RE = /(more than|over|above|at least|upwards of|nearly|almost|close to|about|around|roughly|approximately|approx\.?|some|an estimated|estimated|up to|as many as|as much as|less than|under|fewer than|below|~)\s*$/i;
const NUM_RE = /(US\$|USD\s?|[$€£¥])?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(thousand|million|billion|trillion|bn|mn|tn)\b|\s?(kt|Mt|Gt|Bt)\b|([kmbKMB])(?![A-Za-z]))?(\s?(?:%|per\s?cent\b|percentage[- ]points?\b|pp\b))?/g;
const RATIO_RE = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:in|out of)\s+(\d+|two|three|four|five|six|seven|eight|nine|ten|a hundred|hundred)\b/gi;
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
const WORD_NUM_RE = new RegExp(`\\b(${Object.keys(WORDS).join('|')})(?:\\s+(thousand|million|billion))?\\s+(percent|per cent|seconds?|minutes?|hours?|days?|weeks?|months?|years?|times|people|adults|children|countries)\\b`, 'gi');
const FRACTIONS = [
  [/\btwo[- ]thirds\b/gi, 66.67],
  [/\bthree[- ]quarters\b/gi, 75],
  [/\b(?:one|a)[- ]third\b/gi, 33.33],
  [/\b(?:one|a)[- ]quarter\b/gi, 25],
  [/\b(?:one[- ])?half\b/gi, 50],
];

function qualifierBefore(text, index) {
  const m = text.slice(Math.max(0, index - 30), index).match(QUAL_RE);
  return m ? m[1].toLowerCase() : null;
}

function wordNum(w) {
  w = w.toLowerCase().replace(/^a /, '');
  return /^\d+$/.test(w) ? parseInt(w, 10) : SMALL[w];
}

/**
 * Extracts figures from text. Each figure has a value, a kind
 * (percent | pp | currency | count | year), the precision it was written with
 * (so "50%" can stand for anything from 45 to 55) and any qualifier ("more than").
 */
export function parseNumbers(text) {
  const t = text || '';
  const out = [];
  const spans = [];

  RATIO_RE.lastIndex = 0;
  let m;
  while ((m = RATIO_RE.exec(t))) {
    const x = wordNum(m[1]);
    const y = wordNum(m[2]);
    if (!x || !y || y > 1000 || x > y) continue;
    spans.push([m.index, m.index + m[0].length]);
    out.push({ raw: m[0], value: (x / y) * 100, kind: 'percent', currency: null, precision: 100 / y, qualifier: qualifierBefore(t, m.index), index: m.index, ratio: true });
  }
  for (const [re, val] of FRACTIONS) {
    re.lastIndex = 0;
    while ((m = re.exec(t))) {
      const end = m.index + m[0].length;
      if (!/^\s+of\b/i.test(t.slice(end, end + 5))) continue;
      if (spans.some(([a, b]) => m.index < b && end > a)) continue;
      spans.push([m.index, end]);
      out.push({ raw: m[0], value: val, kind: 'percent', currency: null, precision: 10, qualifier: qualifierBefore(t, m.index), index: m.index, ratio: true });
    }
  }

  // Spelled-out figures with a unit: "eight seconds", "three times", "twenty percent".
  WORD_NUM_RE.lastIndex = 0;
  while ((m = WORD_NUM_RE.exec(t))) {
    const end = m.index + m[0].length;
    if (spans.some(([a, b]) => m.index < b && end > a)) continue;
    const base = WORDS[m[1].toLowerCase()];
    const scale = m[2] ? SCALES[m[2].toLowerCase()] : 1;
    const isPct = /^per/i.test(m[3]);
    spans.push([m.index, end]);
    out.push({ raw: m[0], value: base * scale, kind: isPct ? 'percent' : 'count', currency: null, precision: scale, qualifier: qualifierBefore(t, m.index), index: m.index, word: true });
  }

  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(t))) {
    if (!m[2]) continue;
    const start = m.index;
    const end = NUM_RE.lastIndex;
    if (spans.some(([a, b]) => start < b && end > a)) continue;
    const prev = t[start - 1] || '';
    if (!m[1] && /[A-Za-z_\-/.]/.test(prev)) continue; // COVID-19, G7, 1/2, v2.1
    if (/^(st|nd|rd|th)\b/i.test(t.slice(end, end + 3))) continue; // ordinals
    if (/^[/:]\d/.test(t.slice(end, end + 2))) continue; // dates and times
    const digits = m[2].replace(/,/g, '');
    const scaleWord = (m[3] || m[4] || m[5] || '').toLowerCase();
    const scale = scaleWord ? SCALES[scaleWord] : 1;
    const unit = (m[6] || '').trim().toLowerCase();
    let kind = 'count';
    if (unit.startsWith('percentage') || unit === 'pp') kind = 'pp';
    else if (unit) kind = 'percent';
    else if (m[1]) kind = 'currency';
    else if (!scaleWord && /^(1[5-9]\d\d|20\d\d)$/.test(digits)) kind = 'year';
    const dec = digits.includes('.') ? digits.split('.')[1].length : 0;
    let precision;
    if (dec) precision = Math.pow(10, -dec);
    else {
      const tz = (digits.match(/0+$/) || [''])[0].length;
      precision = Math.pow(10, Math.min(tz, digits.length - 1));
    }
    out.push({
      raw: m[0].trim(),
      value: parseFloat(digits) * scale,
      kind,
      currency: m[1] ? normCur(m[1]) : null,
      precision: precision * scale,
      qualifier: qualifierBefore(t, start),
      index: start,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

function normCur(c) {
  c = c.trim().toUpperCase();
  return c === 'US$' || c === 'USD' ? '$' : c;
}

/** Figures that carry the claim (years are context, not the claim). */
export function keyNumbers(nums) {
  return nums.filter((n) => n.kind !== 'year');
}

export function compatible(c, p) {
  if (c.kind === p.kind) {
    if (c.kind === 'currency' && c.currency && p.currency && c.currency !== p.currency) return 'unit';
    return true;
  }
  if ((c.kind === 'percent' && p.kind === 'pp') || (c.kind === 'pp' && p.kind === 'percent')) return 'unit';
  if ((c.kind === 'count' && p.kind === 'currency') || (c.kind === 'currency' && p.kind === 'count')) return true;
  return false;
}

/** exact | approx | rounded | changed, for two compatible figures. */
export function compareNumber(c, p) {
  const a = c.value;
  const b = p.value;
  const rel = Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);
  if (rel <= 0.0005) return 'exact';
  const q = c.qualifier;
  if (q) {
    if (/more than|over|above|at least|upwards/.test(q) && b >= a * 0.999 && b <= a * 1.5) return 'approx';
    if (/nearly|almost|close to|up to|as many as|as much as/.test(q) && b <= a * 1.001 && b >= a * 0.85) return 'approx';
    if (/less than|under|fewer than|below/.test(q) && b <= a && b >= a * 0.6) return 'approx';
    if (/about|around|roughly|approx|some|estimated|~/.test(q) && rel <= 0.1) return 'approx';
  }
  if (rel <= 0.1 && Math.abs(a - b) <= (c.precision / 2) * 1.0001) return 'rounded';
  if (rel <= 0.1 && Math.abs(a - b) <= (p.precision / 2) * 1.0001) return 'rounded';
  return 'changed';
}

const STATUS_RANK = { exact: 0, approx: 1, rounded: 2, 'unit-changed': 3, changed: 4 };

/** For each claim figure, the closest compatible figure in the passage. */
export function matchNumbers(claimNums, passageNums) {
  return claimNums.map((c) => {
    let best = null;
    for (const p of passageNums) {
      const comp = compatible(c, p);
      if (!comp) continue;
      const status = comp === 'unit' ? 'unit-changed' : compareNumber(c, p);
      const dist = Math.abs(c.value - p.value) / Math.max(Math.abs(c.value), Math.abs(p.value), 1e-9);
      if (!best || STATUS_RANK[status] < STATUS_RANK[best.status] || (STATUS_RANK[status] === STATUS_RANK[best.status] && dist < best.dist)) {
        best = { claim: c, source: p, status, dist };
      }
    }
    return best || { claim: c, source: null, status: 'missing', dist: Infinity };
  });
}

// ---------------------------------------------------------------- quotes

function normalizeQuote(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function qWords(s) {
  return normalizeQuote(s).split(' ').filter(Boolean);
}

/** The quoted words inside a claim, if the claim is a quotation. */
export function extractQuote(text) {
  const m = (text || '').match(/["“]([^"”]{12,})["”]/);
  return m ? m[1].trim() : null;
}

function lcsTable(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp;
}

/** Word-level diff: '=' same, '-' only in the claim, '+' only in the source. */
export function wordDiff(a, b) {
  const dp = lcsTable(a, b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ w: a[i], op: '=' }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ w: a[i++], op: '-' });
    else out.push({ w: b[j++], op: '+' });
  }
  while (i < a.length) out.push({ w: a[i++], op: '-' });
  while (j < b.length) out.push({ w: b[j++], op: '+' });
  return out;
}

/** How closely a short passage reproduces a quotation (1 = word for word). */
export function quoteSimilarity(quote, text) {
  const qw = qWords(quote);
  const tw = qWords(text).slice(0, 2000);
  if (!qw.length || !tw.length) return { sim: 0 };
  if ((' ' + tw.join(' ') + ' ').includes(' ' + qw.join(' ') + ' ')) return { sim: 1, diff: qw.map((w) => ({ w, op: '=' })) };
  const L = qw.length;
  const lens = [...new Set([Math.max(1, Math.floor(L * 0.75)), L, Math.ceil(L * 1.25)])];
  const qset = new Set(qw);
  let best = { sim: 0 };
  for (let i = 0; i < tw.length; i++) {
    if (!qset.has(tw[i])) continue;
    for (const len of lens) {
      const win = tw.slice(i, i + len);
      if (win.length < lens[0]) continue;
      const dp = lcsTable(qw, win);
      const sim = (2 * dp[0][0]) / (qw.length + win.length);
      if (sim > best.sim) best = { sim, win };
    }
  }
  if (best.win) best.diff = wordDiff(qw, best.win);
  return best;
}

// ---------------------------------------------------------------- comparing a claim with a passage

const SOURCE_HEDGE = /\b(may|might|could|estimated|estimates?|projected|projections?|forecasts?|potentially|possibly|suggests?|preliminary|modell?ed)\b/i;
const BOUND_QUALIFIER = /up to|as many as|as much as/;

/**
 * Compares the claim with what a source actually says.
 * status: match | rounded | changed | misquoted | partial | supported | unsupported
 */
export function compareClaim(claimText, passageText, { quote } = {}) {
  claimText = stripRefMarks(claimText);
  passageText = stripRefMarks(passageText);
  const flags = [];
  let quoteResult = null;
  const claimNums = keyNumbers(parseNumbers(claimText));
  const passageNums = parseNumbers(passageText);
  const numbers = matchNumbers(claimNums, passageNums);
  // "9% recycled" vs "90.5% never recycled": the source states the complement.
  numbers.forEach((n, i) => {
    if (n.claim.kind !== 'percent' || ['exact', 'approx', 'rounded'].includes(n.status)) return;
    for (const p of passageNums) {
      if (p.kind !== 'percent' || p.value <= 50 === n.claim.value <= 50) continue;
      const around = passageText.slice(Math.max(0, p.index - 60), p.index + p.raw.length + 80);
      const neg = around.match(/\b(never|not|no longer|without|un\w+|non-?\w+)\b/i);
      if (!neg) continue;
      const inv = { ...p, value: Math.round((100 - p.value) * 1000) / 1000 };
      inv.raw = `${inv.value}%`;
      const st = compareNumber(n.claim, inv);
      if (['exact', 'approx', 'rounded'].includes(st)) {
        numbers[i] = { claim: n.claim, source: inv, status: st, dist: 0, complement: { raw: p.raw, word: neg[1] } };
        flags.push(`Source states it the other way round: ${p.raw} "${neg[1]}" (so ${inv.raw})`);
        break;
      }
    }
  });

  let status;
  if (numbers.length) {
    const st = numbers.map((n) => n.status);
    if (st.includes('unit-changed')) {
      status = 'changed';
      for (const n of numbers.filter((x) => x.status === 'unit-changed')) flags.push(`Unit changed: claim says ${n.claim.raw}, source says ${n.source.raw}`);
    } else if (st.includes('changed')) {
      status = 'changed';
      for (const n of numbers.filter((x) => x.status === 'changed')) {
        const ratio = n.claim.value / n.source.value;
        const scaleNote = Math.abs(Math.log10(Math.abs(ratio)) - 3) < 0.01 || Math.abs(Math.log10(Math.abs(ratio)) + 3) < 0.01 ? ' (off by a factor of 1,000)' : '';
        flags.push(`Figure differs: claim says ${n.claim.raw}, source says ${n.source.raw}${scaleNote}`);
      }
    } else if (st.every((s) => s === 'missing')) {
      status = 'partial';
      flags.push('Source discusses this but does not state the figure');
    } else if (st.includes('missing')) {
      status = 'partial';
      for (const n of numbers.filter((x) => x.status === 'missing')) flags.push(`Figure not found in source: ${n.claim.raw}`);
    } else if (st.includes('rounded')) {
      status = 'rounded';
      for (const n of numbers.filter((x) => x.status === 'rounded')) flags.push(`Rounded: source says ${n.source.raw}, claim says ${n.claim.raw}`);
    } else {
      status = 'match';
      for (const n of numbers.filter((x) => x.status === 'approx')) flags.push(`"${n.claim.qualifier} ${n.claim.raw}" is consistent with the source's ${n.source.raw}`);
    }
    for (const n of numbers) {
      if (n.source && n.source.qualifier && BOUND_QUALIFIER.test(n.source.qualifier) && !n.claim.qualifier) {
        flags.push(`Source says "${n.source.qualifier} ${n.source.raw}" (an upper bound); the claim drops that qualifier`);
        if (status === 'match' || status === 'rounded') status = 'changed';
      }
    }
  } else {
    const ov = overlap(keywords(claimText), keywords(passageText));
    status = ov >= 0.5 ? 'supported' : 'unsupported';
  }

  if (quote) {
    quoteResult = quoteSimilarity(quote, passageText);
    if (quoteResult.sim >= 0.97) {
      if (!numbers.length) status = 'match';
    } else if (quoteResult.sim >= 0.6) {
      status = 'misquoted';
      flags.unshift('Quotation wording differs from the source');
    } else {
      status = 'unsupported';
      flags.unshift('Quotation not found in this source');
    }
  }

  const claimYears = parseNumbers(claimText).filter((n) => n.kind === 'year').map((n) => n.value);
  const srcYears = passageNums.filter((n) => n.kind === 'year').map((n) => n.value);
  if (claimYears.length && srcYears.length && !claimYears.some((y) => srcYears.includes(y))) {
    flags.push(`Year differs: claim mentions ${claimYears.join(', ')}, source mentions ${[...new Set(srcYears)].join(', ')}`);
    if (status === 'match' || status === 'rounded' || status === 'supported') status = 'changed';
  }
  if (SOURCE_HEDGE.test(passageText) && !SOURCE_HEDGE.test(claimText)) {
    const w = passageText.match(SOURCE_HEDGE)[1];
    flags.push(`Source hedges ("${w}"); the claim states it as fact`);
  }
  return { status, numbers, flags, quote: quoteResult };
}

// ---------------------------------------------------------------- locating a passage in a page

/** Removes Markdown syntax, leaving readable text. */
export function stripMd(s) {
  return normalizeSpace(
    (s || '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '$1')
      .replace(/\[\^?\d+\]/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/(^|\s)[*_]{1,3}|[*_]{1,3}(?=\s|$|[.,;:])/g, '$1')
      .replace(/[`#>|]+/g, ' ')
      .replace(/^\s*[-+]\s+/gm, '')
  );
}

export function sentences(text) {
  return text.split(/(?<=[.!?…]["”’)\]]?)\s+(?=["“‘(\[]?[A-Z0-9])/).filter((s) => s.trim());
}

/** Splits Markdown into blocks (paragraphs or list/table lines), keeping offsets. */
export function splitBlocks(md) {
  const blocks = [];
  const re = /\n\s*\n/g;
  let last = 0;
  let m;
  const push = (part, index) => {
    const lines = part.split('\n');
    const listy = lines.length > 1 && lines.filter((l) => l.trim()).every((l) => /^\s*([-*+]|\d+[.)]|\|)/.test(l));
    if (listy) {
      let off = index;
      for (const l of lines) {
        if (l.trim()) blocks.push({ raw: l, index: off });
        off += l.length + 1;
      }
    } else blocks.push({ raw: part, index });
  };
  while ((m = re.exec(md))) {
    push(md.slice(last, m.index), last);
    last = m.index + m[0].length;
  }
  push(md.slice(last), last);
  return blocks;
}

function scoreWindow(win, refInfo) {
  const wkw = new Set(keywords(win));
  const wn = parseNumbers(win);
  let best = { s: 0, ov: 0 };
  for (const r of refInfo) {
    const ov = overlap(r.kw, wkw);
    let s = ov;
    if (r.nums.length) {
      let ns = 0;
      for (const c of r.nums) {
        let bestN = 0;
        for (const p of wn) {
          const comp = compatible(c, p);
          if (!comp) continue;
          const st = comp === 'unit' ? 'unit-changed' : compareNumber(c, p);
          bestN = Math.max(bestN, { exact: 1, approx: 1, rounded: 0.85, 'unit-changed': 0.5, changed: 0.25 }[st]);
        }
        ns += bestN;
      }
      s = 0.55 * ov + 0.45 * (ns / r.nums.length);
    }
    if (s > best.s) best = { s, ov };
  }
  return best;
}

/**
 * Finds the 1–3 sentence passage in a page that best matches any of the reference
 * texts (the claim, and the wording used by the page that cited this one).
 * Returns { score, ov, quote, raw, offset } or null.
 */
export function locatePassage(md, refs) {
  const refInfo = refs
    .filter(Boolean)
    .map((r) => ({ kw: [...new Set(keywords(r))], nums: keyNumbers(parseNumbers(r)) }))
    .filter((r) => r.kw.length);
  if (!refInfo.length || !md) return null;
  const blocks = splitBlocks(md.slice(0, 800000));
  let best = null;
  for (const b of blocks) {
    const clean = stripMd(b.raw);
    if (clean.length < 15) continue;
    const bkw = new Set(keywords(clean));
    let pre = 0;
    for (const r of refInfo) pre = Math.max(pre, overlap(r.kw, bkw));
    if (pre < 0.2) continue;
    const sents = sentences(clean);
    for (let i = 0; i < sents.length; i++) {
      for (const w of [1, 2, 3]) {
        if (i + w > sents.length) break;
        const win = sents.slice(i, i + w).join(' ');
        if (win.length > 1200) break;
        const sc = scoreWindow(win, refInfo);
        // Prefer body text over headlines and captions.
        const heading = /^\s*#{1,6}\s/.test(b.raw) ? 0.12 : 0;
        const s = sc.s - (w - 1) * 0.04 - heading - (win.length < 50 ? 0.05 : 0);
        if (!best || s > best.score) best = { score: s, ov: sc.ov, quote: win, raw: b.raw, offset: b.index };
      }
    }
  }
  return best;
}

/** A passage counts only if it shares the claim's wording, not just a number. */
export function isFound(loc, { strict = false } = {}) {
  if (!loc || loc.ov < (strict ? 0.5 : 0.35)) return false;
  return loc.score >= (strict ? 0.55 : 0.45) || loc.ov >= 0.6;
}

// ---------------------------------------------------------------- links and sources

/** [text](url) links in a Markdown snippet. */
export function mdLinks(raw) {
  const out = [];
  const re = /\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*<?(https?:\/\/[^)\s>]+(?:\([^)\s]*\)[^)\s>]*)?)>?(?:\s+"[^"]*")?\s*\)/g;
  let m;
  while ((m = re.exec(raw || ''))) out.push({ text: stripMd(m[1]).slice(0, 140), rawText: m[1], url: m[2] });
  return out;
}

function samePage(a, b) {
  const n = (u) => (u || '').split('#')[0].replace(/\/$/, '');
  return n(a) === n(b);
}

/**
 * Resolves footnote markers like [12] in a passage to the links in the matching
 * reference-list entry further down the page (Wikipedia-style footnotes).
 */
export function resolveFootnotes(md, pageUrl, links, fromOffset = 0) {
  const out = [];
  for (const l of links) {
    const num = ((l.rawText ?? l.text).trim().match(/^\[?(\d{1,3})\]?$/) || [])[1];
    if (!num) continue;
    if (!samePage(l.url, pageUrl) && !l.url.includes('#')) continue;
    const re = new RegExp(`(?:^|\\n)\\s*(?:${num}\\.|\\[${num}\\]|\\^?\\s*${num}\\s*[.)])\\s+([^\\n]{10,})`, 'g');
    re.lastIndex = fromOffset;
    const m = re.exec(md);
    if (!m) continue;
    for (const x of mdLinks(m[1])) if (!samePage(x.url, pageUrl)) out.push({ ...x, via: 'footnote' });
  }
  return out;
}

/**
 * Plain-text footnote markers ("…recycled.[19]") in a passage, resolved to the text of
 * the numbered reference entry further down ("19. ↑ Geyer, R. … doi:10.1126/…").
 * Markers right after the quoted sentence are marked `near`.
 */
export function footnoteEntries(md, raw, quote, fromOffset = 0) {
  const out = [];
  const w = (quote || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  let endIdx = -1;
  if (w.length >= 2) {
    const re = new RegExp(w.slice(-3).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]+'), 'i');
    const m = re.exec(raw);
    if (m) endIdx = m.index + m[0].length;
  }
  const seen = new Set();
  for (const m of raw.matchAll(/\[(\d{1,3})\]/g)) {
    const num = m[1];
    if (seen.has(num)) continue;
    seen.add(num);
    const near = endIdx >= 0 && m.index >= endIdx - 5 && m.index <= endIdx + 40;
    const re = new RegExp(`(?:^|\\n)\\s*${num}\\.\\s+([^\\n]{10,})`, 'g');
    re.lastIndex = fromOffset;
    const e = re.exec(md);
    if (e) out.push({ num, near, text: e[1] });
  }
  return out;
}

const NAMED_RE = /\b(?:according to|reported by|published by|conducted by|commissioned by|data from|figures from|(?:survey|study|report|research|analysis|poll|paper|data) (?:by|from)|by the|from the)\s+(?:a |an |the )?(?:new |recent |latest |\d{4} )?(?:(?:study|report|survey|analysis|poll|paper|research)\s+(?:by|from)\s+(?:the\s+)?)?((?:[A-Z][\w&.'’-]*)(?:\s+(?:[A-Z][\w&.'’-]*|of|for|and|on|&)){0,6})/g;
const NOT_NAMES = /^(January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|The|This|That|It|He|She|They|We|In|On)$/;

/** Organisations named as the source in a passage ("according to the CDC"). */
export function namedSources(text) {
  const out = new Set();
  let m;
  NAMED_RE.lastIndex = 0;
  while ((m = NAMED_RE.exec(text || ''))) {
    const name = m[1].replace(/\s+(of|for|and|on|&)$/, '').replace(/[’']s$/, '').trim();
    if (name.length < 3 || NOT_NAMES.test(name)) continue;
    out.add(name);
  }
  // "<Organisation> found / reported / estimates …"
  for (const m of (text || '').matchAll(/\b((?:[A-Z][\w&.'’-]+)(?:\s+[A-Z][\w&.'’-]+){0,3})\s+(?:found|finds|reported|reports|estimated|estimates|concluded|surveyed|says|said)\b/g)) {
    const name = m[1].replace(/\s+(Corp\.?|Inc\.?|Ltd\.?)$/, '').trim();
    if (name.length < 3 || NOT_NAMES.test(name) || /^(He|She|They|It|We|I|Researchers|Scientists|Experts|Officials|Analysts)$/.test(name)) continue;
    out.add(name);
  }
  return [...out].slice(0, 3);
}

export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const PRIMARY_HOSTS = /(^|\.)(gov|gov\.uk|gouv\.fr|gc\.ca|gov\.au|govt\.nz|europa\.eu|who\.int|un\.org|oecd\.org|worldbank\.org|imf\.org|doi\.org|arxiv\.org|biorxiv\.org|medrxiv\.org|ssrn\.com|nber\.org|nature\.com|science\.org|sciencedirect\.com|springer\.com|wiley\.com|tandfonline\.com|jamanetwork\.com|thelancet\.com|nejm\.org|bmj\.com|plos\.org|pnas\.org|cell\.com|frontiersin\.org|mdpi\.com|oup\.com|cambridge\.org|ieee\.org|acm\.org|sagepub\.com|pewresearch\.org|gallup\.com|ipsos\.com|yougov\.com|ipcc\.ch|iea\.org|unesco\.org|unicef\.org|ilo\.org|wto\.org|fao\.org|federalreserve\.gov|ecb\.europa\.eu|bankofengland\.co\.uk)$/;
const PRESS_HOSTS = /(^|\.)(prnewswire\.com|businesswire\.com|globenewswire\.com|newswire\.ca|accesswire\.com|einpresswire\.com|prweb\.com|presseportal\.de)$/;
const SOCIAL_HOSTS = /(^|\.)(twitter\.com|x\.com|facebook\.com|instagram\.com|tiktok\.com|linkedin\.com|reddit\.com|pinterest\.com|youtube\.com|threads\.net)$/;

/** primary | document | reference | social | secondary */
export function sourceKind(url) {
  const h = hostOf(url);
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {}
  if (/(^|\.)wikipedia\.org$|wikimedia|wikiwand/.test(h)) return 'reference';
  if (SOCIAL_HOSTS.test(h)) return 'social';
  if (PRIMARY_HOSTS.test(h) || /\.(edu|mil|int)$|\.(edu|ac|gov|gob|gouv)\.[a-z]{2}$/.test(h)) return 'primary';
  if (PRESS_HOSTS.test(h) || /\/(press-releases?|newsroom|press)\//.test(path)) return 'press';
  if (path.endsWith('.pdf')) return 'document';
  return 'secondary';
}

const JUNK_LINK = /(\/sharer|\/intent\/|\/share\?|\/shareArticle|pinterest\.com\/pin|reddit\.com\/submit|^mailto:|^javascript:|whatsapp|t\.me\/share|\/login|\/signin|\/sign-in|\/subscribe|\/newsletter|\/tag\/|\/tags\/|\/author\/|\/authors\/|\/category\/|\/topics?\/|\.(png|jpe?g|gif|svg|webp|mp4|mp3)(\?|$))/i;

export function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|mc_)/.test(k)) x.searchParams.delete(k);
    // Wayback Machine copies stand for the original URL.
    const wb = x.href.match(/^https?:\/\/web\.archive\.org\/web\/\d+[a-z_]*\/(https?:\/\/.+)$/);
    return (wb ? wb[1] : x.href).replace(/\/$/, '');
  } catch {
    return u;
  }
}

/** Site sections and account pages, which are never a source for a claim. */
function isNavLink(u) {
  try {
    const p = new URL(u).pathname.replace(/\/$/, '');
    const segs = p.split('/').filter(Boolean);
    return segs.length <= 1 || /^\/(section|account|live|video|weather|subscribe|search|my-feed|preferences|about|contact)(\/|$)/i.test(p);
  } catch {
    return true;
  }
}

/** Publication date written into a URL, e.g. /2015/01/16/ or /2023/09/. */
export function dateFromUrl(u) {
  const m = (u || '').match(/\/((?:19|20)\d\d)[\/-](0[1-9]|1[0-2])(?:[\/-](0[1-9]|[12]\d|3[01]))?(?=[\/-])/);
  return m ? `${m[1]}-${m[2]}${m[3] ? '-' + m[3] : ''}` : null;
}

/** Orders candidate citation links: closeness to the claim first, then how primary the site looks. */
export function rankLinks(links, { pageUrl, visited }) {
  const pageHost = hostOf(pageUrl);
  const best = new Map();
  for (const l of links || []) {
    if (!/^https?:/i.test(l.url) || JUNK_LINK.test(l.url)) continue;
    const key = normalizeUrl(l.url);
    if (visited.has(key) || samePage(key, pageUrl)) continue;
    if (hostOf(l.url) === pageHost && isNavLink(l.url)) continue;
    const kind = sourceKind(l.url);
    let score = l.weight || 1;
    score += { primary: 2, press: 1.5, document: 1.5, secondary: 0, reference: -0.5, social: -1 }[kind];
    if (hostOf(l.url) === pageHost) score -= 0.75;
    const prev = best.get(key);
    if (!prev || score > prev.score) best.set(key, { ...l, url: l.url, key, kind, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/** A Chrome text-fragment link that scrolls to and highlights the quote. */
export function fragmentLink(url, quote) {
  if (!quote || /\.pdf(\?|$)/i.test(url)) return url;
  const words = quote.replace(/[“”"]/g, '').split(/\s+/).filter(Boolean);
  if (words.length < 4) return url;
  const start = words.slice(0, Math.min(5, words.length)).join(' ');
  const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D');
  return `${url.split('#')[0]}#:~:text=${enc(start)}`;
}
