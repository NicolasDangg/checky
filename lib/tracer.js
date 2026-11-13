// The trace pipeline. Starting from the page you highlighted on, it follows the
// citation for the claim one hop at a time, back to the earliest source it can verify.
//
//   Fetch      reads each cited page and finds the exact passage that states the claim
//   Search     finds a source when a page names one ("a Pew survey") but doesn't link it,
//              or when the trail goes cold
//   TinyAgent  reads pages Fetch can't (bot walls, script-heavy pages) in a real browser
//   Research   runs in parallel: an independent deep investigation whose report and
//              citations are then verified with Fetch and merged into the trail

import * as TF from './tinyfish.js';
import {
  normalizeSpace, keywords, searchTerms, parseNumbers, keyNumbers, compareNumber,
  compareClaim, extractQuote, locatePassage, isFound, stripMd, mdLinks,
  resolveFootnotes, footnoteEntries, namedSources, stripRefMarks, dateFromUrl, hostOf, sourceKind, rankLinks, normalizeUrl,
} from './claims.js';
import { buildLinkMap, linksForPassage, getHtml, linksFromText } from './linkmap.js';
import * as SCH from './scholar.js';

const FETCH_ERRORS = {
  target_http_error: 'Site returned an error',
  page_not_found: 'Page no longer exists (404)',
  target_unreachable: 'Site unreachable',
  timeout: 'Page took too long to load',
  bot_blocked: 'Blocked by bot protection',
  empty_content: 'No readable text on page',
  login_required: 'Behind a login or paywall',
  content_too_large: 'Document too large to read',
  invalid_url: 'Invalid link',
  invalid_redirect_url: 'Link redirects somewhere invalid',
  proxy_error: 'Network error',
};

const HEADLINES = {
  match: 'Matches the original',
  supported: 'Supported by the source',
  rounded: 'Rounded from the original',
  changed: 'Changed from the original',
  misquoted: 'Misquoted',
  partial: 'Source found, but it doesn’t state this figure',
  unsupported: 'Source doesn’t support the claim',
};

/** First substantive paragraph of a research report (its executive summary). */
export function summaryOf(report) {
  if (!report) return '';
  const paras = report.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const i = paras.findIndex((p) => /^#+\s*(executive )?summary/i.test(p));
  const body = (i >= 0 ? paras.slice(i + 1) : paras).find((p) => !/^(#|---|\||>)/.test(p) && p.length > 80) || '';
  const plain = body.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[(\d+)\]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > 700 ? plain.slice(0, 700).replace(/\s\S*$/, '') + '…' : plain;
}

/** Errors no retry can fix within this trace: no key, a rejected key, an empty wallet. */
export const isFatal = (e) => e?.code === 'NO_KEY' || [401, 402, 403].includes(e?.status);

export function friendlyError(e) {
  if (!e) return 'Unknown error';
  if (e.code === 'NO_KEY') return 'Add your TinyFish API key in Settings first.';
  if (e.status === 401) return 'TinyFish rejected the API key. Check it in Settings.';
  if (e.status === 402) return 'TinyFish wallet is empty (agent.tinyfish.ai/wallet).';
  if (e.status === 403) return `Not enabled for this TinyFish account: ${e.message}`;
  if (e.status === 429) return 'TinyFish rate limit hit; try again in a moment.';
  return e.message || String(e);
}

const pathOf = (u) => {
  try {
    return new URL(u).pathname.replace(/\/$/, '') || '/';
  } catch {
    return u;
  }
};
const isPrimaryish = (s) => s && ['primary', 'document', 'press', 'publisher'].includes(s.kind);
const parseDate = (d) => {
  const t = d ? Date.parse(d) : NaN;
  return Number.isNaN(t) ? null : t;
};

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new TF.TinyFishError('Cancelled', 0, 'CANCELLED'));
    });
  });
}

/**
 * Runs a trace. `req` comes from the content script (claim, sentence, page, links);
 * `emit(state)` is called on every change so the panel can redraw.
 */
export async function runTrace(req, settings, emit, signal) {
  TF.setApiKey(settings.apiKey);
  TF.resetUsage();
  SCH.setOpenAlexKey(settings.openAlexKey);
  SCH.resetUsage();

  const claim = stripRefMarks(req.claim);
  const sentence = stripRefMarks(req.sentence || '');
  // A bare "43%" is not enough to find a passage, so fall back to the full sentence.
  const claimFull = keywords(claim).length >= 3 || !sentence ? claim : sentence;
  const quoteText = extractQuote(claim) || (req.inQuotes ? claim : null) || extractQuote(sentence.includes(claim) ? sentence : '');

  const state = {
    id: req.id,
    claim,
    claimFull,
    quoteText,
    page: { url: req.url, title: req.title },
    status: 'running',
    phase: 'Starting',
    steps: [],
    figures: [],
    verdict: null,
    research: { status: settings.useResearch ? 'starting' : 'off', progress: [] },
    papers: [],
    log: [],
    failures: [], // API/network errors that may have hidden evidence
    startedAt: Date.now(),
  };
  const push = () => emit({ ...state, usage: { ...TF.usage, scholar: { ...SCH.usage } } });
  const log = (msg) => {
    state.log.push({ t: Date.now(), msg });
    push();
  };
  const cancelled = () => signal?.aborted;
  // A lookup that failed. Key and wallet problems stop the trace (nothing else can work);
  // anything else (rate limit, timeout, network) is noted, so that a "no source found"
  // verdict built on missing evidence is reported as a failed check instead.
  const apiFailure = (e, what) => {
    if (cancelled() || isFatal(e)) throw e;
    state.failures.push(`${what}: ${friendlyError(e)}`);
    log(`${what} failed: ${friendlyError(e)}`);
  };

  const visited = new Set([normalizeUrl(req.url)]);
  const budget = { agent: settings.useAgent ? 2 : 0, search: 3, scholar: settings.useScholar === false ? 0 : 1 };

  // ------------------------------------------------------------ helpers

  /**
   * Which links does this passage cite? Fetch gives the text but not link positions,
   * so read the page's HTML to map links to the passage; fall back to footnote
   * entries, DOIs and URLs written in the text when the HTML can't be read.
   */
  async function citedLinks(r, text, loc, preMap = null) {
    const url = r.final_url || r.url;
    const out = [];
    let how = 'text';
    const html = preMap ? null : await getHtml(url, { signal });
    const map = preMap || (html ? buildLinkMap(html, url) : null);
    if (map) {
      const mapped = linksForPassage(map, loc.quote, url);
      if (mapped) {
        out.push(...mapped);
        how = 'html';
      }
    }
    const blockLinks = mdLinks(loc.raw);
    out.push(...blockLinks.map((l) => ({ ...l, weight: 3 })));
    out.push(...resolveFootnotes(text, url, blockLinks, loc.offset).map((l) => ({ ...l, weight: 3.5 })));
    for (const e of footnoteEntries(text, loc.raw, loc.quote, loc.offset)) {
      for (const l of linksFromText(e.text, r.links, url)) out.push({ ...l, via: 'footnote', weight: l.weight + (e.near ? 0.5 : -1) });
    }
    out.push(...linksFromText(stripMd(loc.raw), how === 'html' ? [] : r.links, url));
    return { links: out, how };
  }

  async function makeHop(r, text, loc, via, preMap = null) {
    const url = r.final_url || r.url;
    const { links, how } = await citedLinks(r, text, loc, preMap);
    const context = stripMd(loc.raw);
    const named = namedSources(context);
    // "according to the Pew Research Center" with the Pew link elsewhere on the page.
    if (named.length && Array.isArray(r.links)) {
      const generic = /^(center|centre|institute|university|national|research|report|study|survey|department|office|bureau|foundation|association|international|global)$/;
      const toks = named.flatMap((n) => n.toLowerCase().split(/\s+/)).filter((t) => t.length >= 4 && !generic.test(t));
      for (const u of r.links) {
        const lu = String(u).toLowerCase();
        if (toks.some((t) => lu.includes(t))) links.push({ url: u, text: '', weight: 1.5 });
      }
    }
    return {
      url,
      title: r.title || hostOf(url),
      site: hostOf(url),
      // Wikipedia's "published" date is the article's creation date, not when the text was written.
      date: sourceKind(url) === 'reference' ? null : r.published_date || dateFromUrl(url),
      author: r.author || null,
      quote: loc.quote,
      context: context.length > 700 ? context.slice(0, 700) + '…' : context,
      via,
      kind: sourceKind(url),
      links,
      linkMap: how,
      named,
      score: loc.score,
      ov: loc.ov,
    };
  }

  /** Is this page published by the organisation the previous step attributes the claim to? */
  function isNamedPublisher(hop, names) {
    const site = hop.site.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return (names || []).some((n) => {
      const first = n.toLowerCase().split(/\s+/).find((w) => w.length >= 4 && !/^(the|national|university|institute|center|centre)$/.test(w));
      return first && site.includes(first.replace(/[^a-z0-9]/g, ''));
    });
  }

  /** Earliest known date on the trail so far: no source of the claim can be later than this. */
  function trailCeiling() {
    // Wikis and other reference works are edited continuously: the date they carry is
    // when the article was created, not when this sentence was written, so it can't rule
    // out a newer source (Wikipedia's 2005 creation date would reject every 2019 study).
    const ds = state.steps.filter((s) => s.kind !== 'reference').map((s) => parseDate(s.date)).filter(Boolean);
    return ds.length ? Math.min(...ds) : null;
  }

  const hopRank = (h) => h.score + (h.kind === 'primary' ? 0.15 : h.kind === 'document' ? 0.1 : 0);

  /** Fetches candidate URLs and keeps the pages whose text contains the claim. */
  async function evaluate(cands, refs, via, fromHost = '', { strict = false, fromDate = null } = {}) {
    const res = await TF.fetchUrls(
      cands.map((c) => c.url),
      { purpose: `Check whether this page is a source for the claim: "${claim}"` },
      { signal },
    );
    const hops = [];
    const failed = [];
    const viaFor = (cand, url) => {
      let v = cand.via === 'footnote' ? 'footnote' : via;
      if (v === 'cited' && fromHost && hostOf(url) === fromHost) v = 'internal';
      return v;
    };
    const candFor = (u) => cands.find((c) => c.url === u) || cands.find((c) => normalizeUrl(c.url) === normalizeUrl(u)) || {};

    for (const r of res.results || []) {
      const cand = candFor(r.url);
      visited.add(normalizeUrl(r.url));
      if (r.final_url) visited.add(normalizeUrl(r.final_url));
      const text = typeof r.text === 'string' ? r.text : '';
      const loc = text ? locatePassage(text, refs) : null;
      if (isFound(loc, { strict })) {
        const hop = await makeHop(r, text, loc, viaFor(cand, r.final_url || r.url));
        hop.candScore = cand.score || 0;
        hop.paper = cand.paper;
        hops.push(hop);
        continue;
      }
      // Pages that build their text with JavaScript can come back nearly empty from
      // Fetch; their raw HTML often still has the article.
      if (text.length < 4000) {
        const url = r.final_url || r.url;
        const html = await getHtml(url, { signal });
        if (html) {
          const map = buildLinkMap(html, url);
          const htmlText = map.text.replace(/\n+/g, '\n\n');
          const loc2 = locatePassage(htmlText, refs);
          if (isFound(loc2, { strict })) {
            const title = (html.match(/<title[^>]*>([^<]*)</i) || [])[1]?.trim();
            const hop = await makeHop({ ...r, title: title || r.title, links: map.links.map((l) => l.url) }, htmlText, loc2, viaFor(cand, url), map);
            hop.candScore = cand.score || 0;
            hop.paper = cand.paper;
            hops.push(hop);
            continue;
          }
        }
      }
      const f = {
        url: r.final_url || r.url,
        title: r.title,
        reason: text.length < 400 ? 'Page had little readable text' : 'Claim not found on this page',
        short: text.length < 1500,
        rank: cand.score || 0,
      };
      // A cited link that now redirects to a different page has rotted: the archive may still have it.
      if (r.final_url && pathOf(r.final_url) !== pathOf(r.url) && via !== 'search' && via !== 'named') {
        f.reason = `Link now redirects to ${hostOf(r.final_url)}${pathOf(r.final_url)}`;
        f.redirectedFrom = r.url;
      }
      failed.push(f);
    }

    // Dead links: read the Wayback Machine's archived copy instead.
    const dead = failed.filter((f) => f.redirectedFrom).map((f) => ({ ...f, url: f.redirectedFrom, ref: f }));
    for (const e of res.errors || []) {
      visited.add(normalizeUrl(e.url));
      const f = { url: e.url, reason: FETCH_ERRORS[e.error] || e.error, blocked: e.error === 'bot_blocked' || e.error === 'timeout' || e.error === 'login_required', rank: candFor(e.url).score || 0 };
      failed.push(f);
      if (['page_not_found', 'target_unreachable', 'target_http_error', 'empty_content'].includes(e.error) && !/web\.archive\.org/.test(e.url)) dead.push({ ...f, ref: f });
    }
    if (dead.length && !hops.length) {
      // Ask for the snapshot nearest to when the citing page was written.
      const year = (fromDate && String(fromDate).match(/(19|20)\d\d/)?.[0]) || '2020';
      const archived = dead.slice(0, 3).map((f) => ({ ...candFor(f.url), url: `https://web.archive.org/web/${year}/${f.url}`, orig: f }));
      try {
        const ar = await TF.fetchUrls(archived.map((a) => a.url), { purpose: `Read the archived copy of a dead citation for the claim: "${claim}"` }, { signal });
        for (const r of ar.results || []) {
          const a = archived.find((x) => x.url === r.url) || archived[0];
          const text = typeof r.text === 'string' ? r.text : '';
          const loc = text ? locatePassage(text, refs) : null;
          if (!isFound(loc, { strict })) continue;
          const hop = await makeHop(r, text, loc, viaFor(a, a.orig.url));
          hop.archived = true;
          hop.paper = a.paper;
          hop.originalUrl = a.orig.url;
          hop.site = hostOf(a.orig.url);
          hop.kind = sourceKind(a.orig.url);
          hop.date = hop.date || dateFromUrl(a.orig.url);
          a.orig.ref.recovered = 'read from the Wayback Machine';
          hops.push(hop);
        }
      } catch (e) {
        if (cancelled()) throw e;
      }
    }
    return { hops, failed };
  }


  /** Reads one page in a real browser with TinyAgent and asks for the verbatim passage. */
  async function agentStep(url, refs) {
    state.phase = `Opening ${hostOf(url)} in a real browser (TinyAgent)`;
    push();
    const goal = [
      `You are verifying a claim. On this page, find the sentence or short passage that states or supports this claim: "${claimFull}".`,
      'Return:',
      '- found: true only if this page itself states this claim (the same figure or quotation);',
      '- passage: that passage copied VERBATIM, character for character, exactly as written on the page. Do not paraphrase or summarise;',
      "- published_date: the page's publication date if shown, otherwise null;",
      '- page_title: the title of the page;',
      '- cited_urls: absolute URLs of the sources the page cites for that passage (inline links, footnotes or reference entries); empty if none.',
      'Stay on this page; only expand footnotes, references or "show more" sections on it. Close any cookie banner by declining.',
    ].join('\n');
    try {
      const run = await TF.agentRun(
        {
          url,
          goal,
          browser_profile: 'stealth',
          output_schema: {
            type: 'object',
            properties: {
              found: { type: 'boolean' },
              passage: { type: 'string', nullable: true },
              published_date: { type: 'string', nullable: true },
              page_title: { type: 'string', nullable: true },
              cited_urls: { type: 'array', items: { type: 'string' }, maxItems: 10 },
            },
            required: ['found', 'cited_urls'],
          },
        },
        { signal },
      );
      let out = run?.result;
      if (out && out.found === undefined && out.result && typeof out.result === 'object') out = out.result;
      if (run?.status !== 'COMPLETED' || !out) {
        log(`TinyAgent couldn't read ${hostOf(url)}: ${run?.error?.message || 'no result'}`);
        return null;
      }
      if (!out.found || !out.passage) {
        log(`TinyAgent read ${hostOf(url)}: the claim is not on that page`);
        return null;
      }
      const loc = locatePassage(out.passage, refs);
      if (!loc || loc.score < 0.3) {
        log(`TinyAgent's passage from ${hostOf(url)} didn't match the claim closely enough to accept`);
        return null;
      }
      return {
        url,
        title: out.page_title || hostOf(url),
        site: hostOf(url),
        date: out.published_date || null,
        quote: normalizeSpace(out.passage).slice(0, 1200),
        context: '',
        via: 'agent',
        kind: sourceKind(url),
        links: (out.cited_urls || []).filter((u) => /^https?:/i.test(u)).map((u) => ({ url: u, text: '', weight: 3 })),
        named: namedSources(out.passage),
        score: loc.score,
      };
    } catch (e) {
      apiFailure(e, `TinyAgent on ${hostOf(url)}`);
      return null;
    }
  }

  /** Follows the links a step cites for the claim. */
  async function followCitations(current, refs) {
    const cands = rankLinks(current.links, { pageUrl: current.url, visited }).slice(0, 4);
    if (!cands.length) return null;
    state.phase = `Step ${state.steps.length + 1}: reading ${cands.length} source${cands.length > 1 ? 's' : ''} cited by ${current.site}`;
    push();
    let result;
    try {
      result = await evaluate(cands, refs, 'cited', current.site, { fromDate: current.date });
    } catch (e) {
      apiFailure(e, 'Fetch');
      return null;
    }
    current.checked = [...(current.checked || []), ...result.failed];
    // A citation that blocked plain fetching gets read in a real browser by TinyAgent:
    // always when nothing else worked, and also when it's a closer citation than the page found.
    const bestFound = Math.max(-Infinity, ...result.hops.map((h) => h.candScore ?? 0));
    const target = result.failed
      .filter((f) => (f.blocked || f.short) && !f.recovered)
      .sort((a, b) => (b.rank || 0) - (a.rank || 0))[0];
    if (target && budget.agent > 0 && (!result.hops.length || (target.rank || 0) > bestFound + 0.5)) {
      budget.agent--;
      const hop = await agentStep(target.url, refs);
      if (hop) {
        target.recovered = true;
        hop.candScore = (target.rank || 0) + 1;
        current.alternatives = result.hops.sort((a, b) => hopRank(b) - hopRank(a));
        return hop;
      }
    }
    const ceiling = trailCeiling();
    result.hops = result.hops.filter((h) => {
      const hd = parseDate(h.date);
      if (ceiling && hd && hd > ceiling + 30 * 864e5) {
        log(`Skipped ${h.site}: dated ${String(h.date).slice(0, 10)}, after an earlier step, so it can't be where the claim came from`);
        return false;
      }
      return true;
    });
    if (!result.hops.length) {
      log(`None of the ${cands.length} source(s) cited by ${current.site} contain the claim`);
      return null;
    }
    const sorted = result.hops.sort((a, b) => hopRank(b) - hopRank(a));
    // Keep the runners-up: if this branch dead-ends, the trace can come back and try them.
    current.alternatives = sorted.slice(1);
    return sorted[0];
  }

  /** Searches for a source when there is no citation to follow. */
  async function searchStep(current, refs, named) {
    budget.search--;
    // Past the first step, the cited page's own wording is closer to the source than the selection.
    const basis = current.via === 'page' ? claimFull : current.quote;
    const terms = searchTerms(basis, named ? 6 : 9);
    const nums = keyNumbers(parseNumbers(basis)).slice(0, 2).map((n) => n.raw);
    const query = normalizeSpace([named ? `"${named}"` : '', ...nums, ...terms].join(' ')).slice(0, 250);
    state.phase = named ? `${current.site} names "${named}" without a link. Searching for it` : `No citation to follow from ${current.site}. Searching for an earlier source`;
    push();
    const purpose = `Find the original primary source (study, report, dataset, official statement or interview) of this claim: "${claim}"`;
    const [web, papers] = await Promise.all([
      TF.search({ query, purpose }, { signal }).catch((e) => {
        apiFailure(e, 'Search');
        return null;
      }),
      named
        ? null
        : TF.search({ query: terms.slice(0, 7).join(' '), domain_type: 'research_paper' }, { signal }).catch((e) => {
            apiFailure(e, 'Paper search');
            return null;
          }),
    ]);
    const results = [...(web?.results || []).slice(0, 6), ...(papers?.results || []).slice(0, 2)];
    const cands = rankLinks(
      results.map((r) => ({ url: r.url, text: r.title, weight: 1 })),
      { pageUrl: current.url, visited },
    ).slice(0, 5);
    if (!cands.length) {
      log(`Search "${query}" returned nothing new`);
      return null;
    }
    let result;
    try {
      // Pages found by search must state the claim clearly: they weren't cited, so the bar is higher.
      result = await evaluate(cands, refs, named ? 'named' : 'search', '', { strict: true });
    } catch (e) {
      apiFailure(e, 'Fetch');
      return null;
    }
    const cd = trailCeiling();
    for (const hop of result.hops.sort((a, b) => hopRank(b) - hopRank(a))) {
      const hd = parseDate(hop.date);
      // A page published after the one it would be the source of can't be its source.
      if (cd && hd && hd > cd + 30 * 864e5) {
        log(`Skipped ${hop.site}: published after an earlier step, so it can't be the source`);
        continue;
      }
      const earlier = cd && hd && hd <= cd + 30 * 864e5;
      const namedSite = isNamedPublisher(hop, named ? [named] : current.named);
      // An undated university page found by search is often a reprint (course readings etc.).
      const strongPrimary = hop.kind === 'primary' && !/\.(edu|ac\.[a-z]{2})$/.test(hop.site);
      if (namedSite || hop.kind === 'press' || (strongPrimary && (earlier || !hd))) return { ...hop, searchQuery: query };
      if (earlier && (isPrimaryish(hop) || hop.links.length)) return { ...hop, searchQuery: query };
      log(`Skipped ${hop.site}: another copy of the claim, not shown to be earlier or better sourced`);
    }
    log(`Search found no earlier source for the claim (${cands.length} pages checked)`);
    return null;
  }

  // ------------------------------------------------------------ scholarly databases

  /**
   * Looks for a published paper that states the claim (OpenAlex, PubMed, arXiv), then
   * reads the best candidates through TinyFish Fetch. A paper joins the trail only if the
   * claim is found in its full text, or failing that, in its abstract (labelled as such).
   */
  async function scholarStep(current, refs) {
    budget.scholar--;
    const basis = current.via === 'page' ? claimFull : current.quote;
    // Topic words from the selection first, then from the passage around it.
    const terms = SCH.paperTerms(claim, basis, current.named || []);
    if (terms.length < 2) return null;
    const cd = trailCeiling();
    const until = cd ? new Date(cd + 30 * 864e5).toISOString().slice(0, 10) : null;
    state.phase = 'Searching scholarly databases (OpenAlex, PubMed, arXiv) for a published paper';
    push();
    let papers = [];
    try {
      const figures = keyNumbers(parseNumbers(basis)).map((n) => n.raw).join(' ');
      papers = await SCH.searchPapers({ terms, claim: `${terms.join(' ')} ${figures}`, named: current.named || [], until, signal });
    } catch (e) {
      if (cancelled()) throw e;
    }
    papers = papers.filter((p) => p.score >= 0.4 && !p.urls.every((u) => visited.has(normalizeUrl(u)))).slice(0, 3);
    if (!papers.length) {
      log('Scholarly databases (OpenAlex, PubMed, arXiv) returned no paper that matches the claim');
      return null;
    }
    const info = (p, status) => ({
      title: p.title, link: p.link, doi: p.doi, venue: p.venue, date: p.date, authors: p.authors,
      citedBy: p.citedBy, db: p.db, openAccess: p.openAccess, score: p.score, status,
    });
    state.papers = papers.map((p) => info(p, 'checking'));
    state.phase = `Reading ${papers.length} candidate paper${papers.length > 1 ? 's' : ''} from scholarly databases`;
    push();

    const cands = papers.map((p) => ({ url: p.urls.find((u) => !visited.has(normalizeUrl(u))) || p.urls[0], paper: p, score: p.score }));
    let result = { hops: [], failed: [] };
    try {
      result = await evaluate(cands, refs, 'scholar', '', { strict: true });
    } catch (e) {
      apiFailure(e, 'Reading the papers');
    }
    const found = [];
    const claimFigures = keyNumbers(parseNumbers(claimFull));
    papers.forEach((p, i) => {
      let hop = result.hops.find((h) => h.paper === p);
      if (!hop && p.abstract) {
        // Paywalled or unreadable full text: check the abstract the database gave us.
        const loc = locatePassage(p.abstract, refs);
        if (isFound(loc, { strict: true })) {
          hop = { url: p.link, site: hostOf(p.link), quote: loc.quote, context: '', links: [], named: [], score: loc.score, ov: loc.ov, abstractOnly: true };
        }
      }
      state.papers[i] = info(p, hop ? (hop.abstractOnly ? 'abstract' : 'verified') : 'not-found');
      if (!hop) return;
      // A paper on the same topic isn't the source unless it states the figure too.
      if (claimFigures.length) {
        const c = compareClaim(claimFull, hop.quote, { quote: quoteText });
        if (!c.numbers.some((n) => ['exact', 'approx', 'rounded'].includes(n.status))) {
          state.papers[i].status = 'no-figure';
          return;
        }
      }
      const hd = parseDate(p.date || hop.date);
      if (cd && hd && hd > cd + 30 * 864e5) {
        state.papers[i].status = 'later';
        return;
      }
      found.push({
        ...hop,
        title: p.title || hop.title,
        date: p.date || hop.date,
        via: 'scholar',
        kind: 'primary',
        paper: info(p, state.papers[i].status),
        searchQuery: terms.join(' '),
      });
    });
    push();
    if (!found.length) {
      log(`Checked ${papers.length} paper(s) from scholarly databases; none of them states the claim`);
      return null;
    }
    const pick = found[0];
    const pp = papers.find((p) => p.title === pick.title);
    for (const u of pp?.urls || []) visited.add(normalizeUrl(u));
    visited.add(normalizeUrl(pick.url));
    log(`Found the claim in a published paper: ${pick.title}${pick.abstractOnly ? ' (abstract only; full text not openly available)' : ''}`);
    return pick;
  }

  // ------------------------------------------------------------ research (runs in parallel)

  function describeEvent(ev) {
    const n = (x) => (Array.isArray(x) ? x.length : typeof x === 'number' ? x : null);
    const urlOf = (x) => x?.url || x?.source?.url || (Array.isArray(x?.urls) ? x.urls[0] : null);
    switch (ev.event) {
      case 'created':
        return 'Research run started';
      case 'plan_updated': {
        const k = n(ev.searches) ?? n(ev.queries) ?? n(ev.subquestions) ?? n(ev.plan?.searches);
        return k ? `Planned ${k} lines of inquiry` : 'Updated research plan';
      }
      case 'sources_searching': {
        const q = (ev.queries || ev.searches || [])[0];
        return q ? `Searching: ${typeof q === 'string' ? q : q.query || ''}` : 'Searching the web';
      }
      case 'sources_searched': {
        const k = n(ev.sources) ?? n(ev.results) ?? ev.count;
        return k ? `Found ${k} candidate sources` : 'Collected candidate sources';
      }
      case 'source_fetched': {
        const u = urlOf(ev);
        return u ? `Read ${hostOf(u)}` : 'Read a source';
      }
      case 'partial_summary':
        return 'Drafted interim findings';
      case 'synthesis_started':
        return 'Writing the report';
      case 'final_result':
        return 'Report ready';
      case 'error':
        return `Error: ${ev.message || 'research failed'}`;
      default:
        return null;
    }
  }

  async function runResearch() {
    const r = state.research;
    const query = [
      `Fact-check this claim and trace it back to its original primary source: "${claim}"`,
      sentence && sentence !== claim ? `Full sentence: "${sentence}"` : '',
      `It appeared on ${req.url}${req.title ? ` ("${req.title}")` : ''}${req.pageDate ? `, dated ${req.pageDate}` : ''}.`,
      'Follow citations back to the earliest original source: the study, report, dataset, filing or interview where this figure or quote first appeared, not the most popular copy.',
      'Report: (1) the original source with URL, publisher and date; (2) its exact wording of the figure or quote; (3) whether the claim as stated matches the original or was rounded, changed, taken out of context, misattributed or misquoted; (4) the intermediate sources that repeated it.',
      'If no original source can be found, say so plainly.',
      'End the report with one final line exactly in the form "ORIGINAL SOURCE: <url>" or "ORIGINAL SOURCE: NONE FOUND".',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const start = await TF.researchStart({ query, mode: settings.researchMode || 'deep' }, { signal });
      r.id = start.research_run_id;
      r.status = 'running';
      push();
      const onEv = (ev) => {
        if (ev.event === 'final_result') r.final = ev;
        const line = describeEvent(ev);
        if (line && r.progress[r.progress.length - 1] !== line) {
          r.progress.push(line);
          if (r.progress.length > 40) r.progress.shift();
          push();
        }
      };
      try {
        await TF.researchEvents(r.id, onEv, { signal });
      } catch (e) {
        if (cancelled()) throw e;
      }
      for (let i = 0; i < 240; i++) {
        const run = await TF.researchGet(r.id, { signal });
        if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.status)) {
          r.run = run;
          break;
        }
        await sleep(15000, signal);
      }
      const deep = r.run?.deep_result || {};
      r.report = deep.result || r.final?.result || '';
      r.citations = (deep.citations || r.final?.citations || []).map((c) => (typeof c === 'string' ? c : c?.url)).filter(Boolean);
      r.termination = deep.termination_reason || r.final?.termination_reason || null;
      r.status = r.run?.status === 'COMPLETED' || r.report ? 'done' : 'failed';
      if (r.status === 'failed') r.error = r.run?.error?.message || `Research ended: ${r.run?.status || 'unknown'}`;
      const m = r.report.match(/ORIGINAL SOURCE:\s*(.+)\s*$/im);
      r.originalLine = m ? m[1].trim() : null;
      r.saysNone = !!(r.originalLine && /none found/i.test(r.originalLine));
      r.summary = summaryOf(r.report);
    } catch (e) {
      r.status = cancelled() ? 'cancelled' : 'error';
      r.error = friendlyError(e);
      if (cancelled() && r.id) TF.researchCancel(r.id);
    }
    push();
  }

  /** Verifies what TinyResearch found with Fetch, and extends the trail if it reached further. */
  async function reconcileResearch() {
    const r = state.research;
    if (r.status !== 'done') return;
    const target = r.originalLine && !r.saysNone ? (r.originalLine.match(/https?:\/\/[^\s)\]>"']+/) || [])[0]?.replace(/[.,;]+$/, '') : null;
    r.target = target || null;
    const trailHas = (u) => state.steps.find((s) => normalizeUrl(s.url) === normalizeUrl(u));
    if (target && trailHas(target)) {
      trailHas(target).researchConfirmed = true;
      r.agrees = true;
      return;
    }
    // With no original, TinyResearch's citations are the pages that debunk or repeat the
    // claim, not sources of it, so none of them belongs on the trail.
    if (r.saysNone) return;
    const urls = [target, ...(r.citations || [])].filter(Boolean);
    const seen = new Set(state.steps.map((s) => normalizeUrl(s.url)));
    const cands = rankLinks(urls.map((u) => ({ url: u, weight: u === target ? 5 : 1 })), { pageUrl: state.page.url, visited: seen }).slice(0, 8);
    if (!cands.length) return;
    state.phase = 'Verifying the sources TinyResearch found';
    push();
    const last = state.steps[state.steps.length - 1];
    const refs = [claimFull, last && last.quote !== claimFull ? last.quote : null];
    let result;
    try {
      result = await evaluate(cands, refs, 'research');
    } catch (e) {
      apiFailure(e, 'Verifying TinyResearch sources');
      return;
    }
    const ceiling = trailCeiling();
    const hops = result.hops
      .filter((h) => {
        const hd = parseDate(h.date);
        if (ceiling && hd && hd > ceiling + 30 * 864e5) {
          log(`Skipped ${h.site} from TinyResearch: dated ${String(h.date).slice(0, 10)}, after the page you're on, so it can't be the original`);
          return false;
        }
        return true;
      })
      .sort((a, b) => hopRank(b) - hopRank(a));
    const pick = hops.find((h) => target && normalizeUrl(h.url) === normalizeUrl(target)) || hops.find(isPrimaryish) || hops[0];
    const origin = state.steps.length > 1 ? state.steps[state.steps.length - 1] : null;
    if (pick && (!origin || (!isPrimaryish(origin) && isPrimaryish(pick)) || (target && normalizeUrl(pick.url) === normalizeUrl(target)))) {
      state.steps.push({ ...pick, via: 'research' });
      r.addedStep = true;
      log(`TinyResearch reached ${pick.site}; verified the passage with Fetch and added it to the trail`);
    } else if (target) {
      r.unverified = `TinyResearch named ${hostOf(target)} as the original, but Checky couldn't find the claim on that page, so it isn't added to the trail.`;
    }
  }

  // ------------------------------------------------------------ verdict

  function finalize() {
    const steps = state.steps;
    for (const s of steps) s.cmp = compareClaim(claimFull, s.quote, { quote: quoteText });

    // How each figure in the claim reads at every step: 50% → 50% → 48.7%.
    const claimNums = keyNumbers(parseNumbers(claimFull));
    state.figures = claimNums.map((c, i) => ({
      claim: c.raw,
      chain: steps.map((s) => {
        const n = s.cmp.numbers[i];
        return n && n.source ? { raw: n.source.raw, num: n.source, status: n.status } : { raw: null, status: 'missing' };
      }),
    }));
    for (const s of steps) s.drift = [];
    for (const f of state.figures) {
      for (let i = 0; i < f.chain.length - 1; i++) {
        const a = f.chain[i];
        const b = f.chain[i + 1];
        if (!a.num || !b.num) continue;
        const st = compareNumber(a.num, b.num);
        if (st === 'rounded' || st === 'changed')
          steps[i].drift.push(`${st === 'rounded' ? 'Rounded' : 'Changed'} here: says ${a.raw}, but its source (step ${i + 2}) says ${b.raw}`);
      }
    }
    if (quoteText) {
      for (let i = 0; i < steps.length - 1; i++) {
        const a = steps[i].cmp.quote?.sim ?? 0;
        const b = steps[i + 1].cmp.quote?.sim ?? 0;
        if (a >= 0.97 && b < 0.97) steps[i].drift.push(`Wording changed here: this step has the quote as claimed, but its source (step ${i + 2}) words it differently`);
      }
    }

    const origin = steps.length > 1 ? steps[steps.length - 1] : null;
    const r = state.research;
    if (!origin && isPrimaryish(steps[0]) && !(steps[0].checked || []).length) {
      state.verdict = {
        status: 'match',
        headline: 'This page appears to be the original source',
        detail: `${steps[0].site} is a primary source (${steps[0].kind === 'press' ? 'the organisation’s own announcement' : 'a publisher of original research or data'}) and gives no earlier source for this claim.`,
        originIndex: 0,
        primary: true,
      };
      return;
    }
    if (!origin) {
      const checked = steps[0]?.checked || [];
      const researchNote = r.status === 'done' && r.saysNone ? ' TinyResearch also found no original source.' : '';
      state.verdict = checked.length
        ? {
            status: 'unsupported',
            headline: 'Cited sources don’t back this up',
            detail: `The page links to ${checked.length} source${checked.length > 1 ? 's' : ''} for this, but none of them contains the claim.${researchNote}`,
          }
        : {
            status: 'none',
            headline: 'No original source found',
            detail: `The page gives no citation for this claim, and search turned up no earlier source that states it.${researchNote}`,
          };
      return;
    }
    if (r.status === 'done' && r.saysNone && (origin.kind !== 'primary' || origin.via === 'search' || origin.via === 'research')) {
      // A company report or press release that states the figure but cites nothing behind
      // it (e.g. Microsoft's "8-second attention span"): say the trail ends there.
      const sourced = isPrimaryish(origin) && origin.via !== 'search' && origin.via !== 'research' && origin.cmp.status !== 'changed';
      const when = origin.date ? ` (${String(origin.date).slice(0, 10)})` : '';
      state.verdict = {
        status: 'none',
        headline: sourced ? 'Source found, but nothing behind it' : 'No original source found',
        detail: sourced
          ? `The claim matches ${origin.title || origin.site}${when}, ${steps.length - 1} step${steps.length > 2 ? 's' : ''} back, but that source cites no study or data for it, and TinyResearch found none either.`
          : `The trail reaches ${origin.title || origin.site}, but TinyResearch's deeper investigation found no primary source behind it.`,
        research: r.summary,
        originIndex: steps.length - 1,
        primary: false,
      };
      return;
    }
    let status = origin.cmp.status === 'supported' ? 'match' : origin.cmp.status;
    let headline = HEADLINES[status] || 'Traced';
    if (status === 'match' && !isPrimaryish(origin)) headline = 'Matches the earliest source found';
    const when = origin.date ? ` (${String(origin.date).slice(0, 10)})` : '';
    let detail = `Earliest source reached: ${origin.title || origin.site}${when}, ${steps.length - 1} step${steps.length > 2 ? 's' : ''} back.`;
    if (!isPrimaryish(origin)) detail += ' It is still a secondary source; the trail could not reach the underlying study or report.';
    if (origin.via === 'scholar') detail += ` Found by searching ${origin.paper?.db || 'scholarly databases'}; the page before it doesn't link to it.`;
    if (origin.abstractOnly) detail += ' Checked against the abstract only, as the full text isn’t openly available.';
    if (origin.cmp.flags[0]) detail += ` ${origin.cmp.flags[0]}.`;
    const agrees = r.status === 'done' && r.target && normalizeUrl(r.target) === normalizeUrl(origin.originalUrl || origin.url);
    state.verdict = { status, headline, detail, originIndex: steps.length - 1, primary: isPrimaryish(origin), research: r.status === 'done' && !agrees ? r.summary : '' };
  }

  // ------------------------------------------------------------ run

  const researchPromise = settings.useResearch ? runResearch() : null;

  state.steps.push({
    url: req.url,
    title: req.title || hostOf(req.url),
    site: hostOf(req.url),
    // A wiki's date is its creation date, which would mislead in the trail.
    date: sourceKind(req.url) === 'reference' ? null : req.pageDate || dateFromUrl(req.url),
    quote: sentence || claim,
    context: normalizeSpace(req.context || '').slice(0, 700),
    via: 'page',
    kind: sourceKind(req.url),
    links: req.links || [],
    named: namedSources(req.context || sentence || claim),
    score: 1,
  });
  push();

  try {
    // Follow the best citation at each step. If a branch dead-ends at a secondary
    // source, backtrack and try the next-best citation from an earlier step.
    const endsPrimary = (steps) => steps.length > 1 && isPrimaryish(steps[steps.length - 1]);
    const better = (x, y) => (endsPrimary(x) !== endsPrimary(y) ? endsPrimary(x) : x.length > y.length);
    let current = state.steps[0];
    let best = null;
    let backtracks = 0;
    for (;;) {
      while (state.steps.length - 1 < (settings.maxHops || 5)) {
        if (cancelled()) throw new TF.TinyFishError('Cancelled', 0, 'CANCELLED');
        const refs = [claimFull, current.quote !== claimFull ? current.quote : null];
        let next = await followCitations(current, refs);
        if (!next && current.named?.length && budget.search > 0) next = await searchStep(current, refs, current.named[0]);
        if (!next && budget.scholar > 0 && !isPrimaryish(current) && SCH.looksScholarly(`${claimFull} ${current.quote} ${current.context || ''}`))
          next = await scholarStep(current, refs);
        if (!next && budget.search > 0 && !isPrimaryish(current)) next = await searchStep(current, refs, null);
        if (!next) break;
        if (!isPrimaryish(next) && isNamedPublisher(next, current.named)) next.kind = 'publisher';
        state.steps.push(next);
        visited.add(normalizeUrl(next.url));
        current = next;
        finalize();
        push();
      }
      if (!best || better(state.steps, best)) best = [...state.steps];
      if (endsPrimary(state.steps) || backtracks >= 2) break;
      let idx = -1;
      for (let i = state.steps.length - 2; i >= 0; i--) if (state.steps[i].alternatives?.length) { idx = i; break; }
      if (idx < 0) break;
      backtracks++;
      const from = state.steps[idx];
      const alt = from.alternatives.shift();
      log(`The branch through ${state.steps[idx + 1].site} ended without reaching a primary source. Trying ${alt.site}, another page ${from.site} cites`);
      state.steps = [...state.steps.slice(0, idx + 1), alt];
      visited.add(normalizeUrl(alt.url));
      current = alt;
      finalize();
      push();
    }
    if (best && better(best, state.steps)) state.steps = best;
    finalize();
    state.status = researchPromise ? 'researching' : 'done';
    state.phase = researchPromise ? 'Fast trace done. TinyResearch is still working' : 'Done';
    push();
    if (researchPromise) {
      await researchPromise;
      if (!cancelled()) await reconcileResearch();
      finalize();
      state.status = cancelled() ? 'cancelled' : 'done';
      state.phase = 'Done';
    }
  } catch (e) {
    finalize();
    state.status = cancelled() ? 'cancelled' : 'error';
    state.error = friendlyError(e);
  }
  // "No source found" is only honest if every lookup actually ran.
  if (state.status === 'done' && state.failures.length && ['none', 'unsupported'].includes(state.verdict?.status)) {
    state.status = 'error';
    const n = state.failures.length;
    state.error = `Couldn't finish checking: ${n} lookup${n > 1 ? 's' : ''} failed (${state.failures[0]}). The trail so far may be missing the source. Try again in a moment.`;
  }
  state.finishedAt = Date.now();
  push();
  return { ...state, usage: { ...TF.usage, scholar: { ...SCH.usage } } };
}

/** Plain-Markdown version of a finished trace, for pasting into notes. */
export function traceToMarkdown(s) {
  const lines = [`## Source trace: "${s.claim}"`, '', `**Verdict:** ${s.verdict?.headline || s.status}. ${s.verdict?.detail || ''}`, ''];
  s.steps.forEach((st, i) => {
    lines.push(`${i + 1}. [${st.title || st.site}](${st.url}): ${st.site}${st.date ? `, ${String(st.date).slice(0, 10)}` : ''} (${st.cmp?.status || ''})`);
    if (st.paper) lines.push(`   ${[st.paper.authors?.join(', '), st.paper.venue, st.paper.doi ? `doi:${st.paper.doi}` : ''].filter(Boolean).join(' · ')}${st.abstractOnly ? ' (abstract only)' : ''}`);
    lines.push(`   > ${st.quote}`);
    for (const f of [...(st.drift || []), ...(st.cmp?.flags || [])]) lines.push(`   - ${f}`);
  });
  if (s.research?.status === 'done') {
    lines.push('', `TinyResearch: ${s.research.originalLine || 'see report'}`);
  }
  lines.push('', `_Traced with Checky (TinyFish) on ${new Date(s.startedAt).toISOString().slice(0, 10)}_`);
  return lines.join('\n');
}
