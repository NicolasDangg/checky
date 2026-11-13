// Scholarly databases: finds published papers that may be the origin of a claim.
//
//   OpenAlex  ~250M works across all fields (what Google Scholar indexes), with abstracts,
//             DOIs, citation counts and open-access PDF links
//   PubMed    medicine and life sciences, where most viral health statistics come from
//   arXiv     preprints in CS, physics, maths and economics
//
// Google Scholar has no API and blocks automated access, so it isn't used. These are
// open databases meant to be queried by tools. Search results here are only
// candidates: the tracer reads each paper (through TinyFish Fetch) and only puts it on
// the trail if the claim is actually in its text or abstract.

import { keywords, overlap, parseNumbers, keyNumbers, normalizeSpace } from './claims.js';

export const usage = { openalex: 0, pubmed: 0, arxiv: 0 };
export function resetUsage() {
  for (const k of Object.keys(usage)) usage[k] = 0;
}

let openAlexKey = '';
export function setOpenAlexKey(k) {
  openAlexKey = (k || '').trim();
}

async function get(url, { signal, timeout = 15000, type = 'json' } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) return null;
    return type === 'json' ? await res.json() : await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const clean = (s) =>
  normalizeSpace(
    String(s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
        e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m,
      ),
  );

// ---------------------------------------------------------------- claim cues

const SCI = /\b(stud(y|ies)|research(ers)?|scientists?|journal|universit(y|ies)|professor|paper|peer[- ]reviewed|published in|meta-analys[ie]s|trial|experiment|survey|analysis|estimat\w*|data|findings?|cohort|participants|sample|percent|%|rate|risk|average)\b/i;
const TECH = /\b(AI|artificial intelligence|machine learning|deep learning|neural|algorithm|language models?|LLMs?|quantum|physics|particle|galax\w*|dark matter|cosmolog\w*|mathemat\w*|computer science|computing|robot\w*|economists?|econometric\w*)\b/i;

/** Does the claim look like something a paper could be the source of? */
export function looksScholarly(text) {
  return SCI.test(text || '');
}

// Words that say how a claim was reported, not what it is about. Papers don't contain them,
// so they only pull search results off topic.
const NEWSY = new Set(
  ('only about likely nearly almost around roughly just more less than most least percent percentage per cent ' +
    'named core fact story statistic statistics year years said says say according found find finds new recent recently ' +
    'researchers research researcher study studies scientists scientist report reports reported survey surveys data ' +
    'analysis paper journal published university professor experts expert people number numbers average show shows showed ' +
    'january february march april may june july august september october november december today week month since').split(' '),
);

/**
 * Search terms for a paper: the claim's topic words, in order, without reporting filler,
 * months, or the names of organisations quoted around the claim.
 */
export function paperTerms(claim, context = '', named = [], max = 5) {
  const nameToks = new Set(named.flatMap((n) => n.toLowerCase().match(/[a-z]+/g) || []));
  const out = [];
  for (const src of [claim, context]) {
    // The surrounding passage only fills in when the selection itself is too thin.
    if (src === context && out.length >= 3) break;
    if (src === context) max = Math.min(max, 4);
    for (const w of (src || '').toLowerCase().match(/[a-z][a-z'-]+/g) || []) {
      const t = w.replace(/'s$/, '');
      if (t.length < 3 || NEWSY.has(t) || nameToks.has(t) || out.includes(t)) continue;
      if (/^(the|and|for|with|from|that|this|these|those|has|have|had|been|was|were|are|its|their|they|them|than|then|into|over|all|any|who|which|what|when|where|while|will|would|could|should|can|not|but|our|his|her|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|half|third|quarter|times|likely|also|such|some|many|much|each|every|other|another|there|here|being)$/.test(t)) continue;
      out.push(t);
      if (out.length >= max) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------- OpenAlex

function abstractFromIndex(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(' ');
}

async function openAlex(terms, until, signal) {
  const run = async (ts) => {
    const filter = [`title_and_abstract.search:${encodeURIComponent(ts.join(' '))}`];
    if (until) filter.push(`to_publication_date:${until}`);
    const select = 'id,doi,title,publication_date,cited_by_count,primary_location,best_oa_location,authorships,abstract_inverted_index,type';
    const key = openAlexKey ? `&api_key=${encodeURIComponent(openAlexKey)}` : '';
    usage.openalex++;
    return get(`https://api.openalex.org/works?filter=${filter.join(',')}&per-page=8&select=${select}${key}`, { signal });
  };
  let data = await run(terms.slice(0, 6));
  if ((!data?.results?.length || data.results.length < 2) && terms.length > 4) data = await run(terms.slice(0, 4));
  return (data?.results || []).map((w) => {
    const oa = w.best_oa_location || {};
    const doi = w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//i, '') : null;
    return {
      db: 'OpenAlex',
      title: clean(w.title),
      date: w.publication_date || null,
      doi,
      venue: w.primary_location?.source?.display_name || null,
      authors: (w.authorships || []).slice(0, 3).map((a) => a.author?.display_name).filter(Boolean),
      institutions: [...new Set((w.authorships || []).flatMap((a) => (a.institutions || []).map((i) => i.display_name)))].slice(0, 4),
      citedBy: w.cited_by_count ?? null,
      abstract: clean(abstractFromIndex(w.abstract_inverted_index)),
      openAccess: !!(oa.pdf_url || oa.landing_page_url),
      urls: [oa.pdf_url, oa.landing_page_url, doi ? `https://doi.org/${doi}` : null].filter(Boolean),
      link: doi ? `https://doi.org/${doi}` : oa.landing_page_url || w.id,
    };
  });
}

// ---------------------------------------------------------------- PubMed

async function pubmed(terms, until, signal) {
  const term = encodeURIComponent(terms.slice(0, 5).join(' '));
  const dates = until ? `&datetype=pdat&mindate=1900&maxdate=${until.replace(/-/g, '/')}` : '';
  usage.pubmed++;
  const s = await get(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${term}&retmax=5&retmode=json&sort=relevance${dates}`, { signal });
  const ids = s?.esearchresult?.idlist || [];
  if (!ids.length) return [];
  usage.pubmed++;
  const xml = await get(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(',')}&retmode=xml`, { signal, type: 'text' });
  if (!xml) return [];
  const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  return xml.split(/<PubmedArticle>/).slice(1).map((a) => {
    const pick = (re) => (a.match(re) || [])[1] || null;
    const pmid = pick(/<PMID[^>]*>(\d+)<\/PMID>/);
    const doi = pick(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/);
    const pmc = pick(/<ArticleId IdType="pmc">(PMC\d+)<\/ArticleId>/);
    const pd = a.match(/<PubDate>([\s\S]*?)<\/PubDate>/)?.[1] || '';
    const y = pd.match(/<Year>(\d{4})<\/Year>/)?.[1] || pd.match(/<MedlineDate>(\d{4})/)?.[1];
    const mRaw = pd.match(/<Month>(\w+)<\/Month>/)?.[1];
    const m = mRaw ? MONTHS[mRaw.slice(0, 3).toLowerCase()] || mRaw.padStart(2, '0') : null;
    const d = pd.match(/<Day>(\d+)<\/Day>/)?.[1];
    const abstract = [...a.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((x) => clean(x[1])).join(' ');
    const pmcUrl = pmc ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmc}/` : null;
    const pmUrl = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
    return {
      db: 'PubMed',
      title: clean(pick(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/)),
      date: y ? [y, m, m && d ? d.padStart(2, '0') : null].filter(Boolean).join('-') : null,
      doi,
      venue: clean(pick(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/)) || null,
      authors: [...a.matchAll(/<LastName>([^<]+)<\/LastName>/g)].slice(0, 3).map((x) => x[1]),
      institutions: [...new Set([...a.matchAll(/<Affiliation>([^<]+)<\/Affiliation>/g)].map((x) => clean(x[1]).split(',')[0]))].slice(0, 3),
      citedBy: null,
      abstract,
      openAccess: !!pmc,
      urls: [pmcUrl, pmUrl, doi ? `https://doi.org/${doi}` : null].filter(Boolean),
      link: doi ? `https://doi.org/${doi}` : pmUrl,
    };
  });
}

// ---------------------------------------------------------------- arXiv

async function arxiv(terms, until, signal) {
  const q = terms.slice(0, 4).map((t) => `all:${encodeURIComponent(t)}`).join('+AND+');
  usage.arxiv++;
  const xml = await get(`https://export.arxiv.org/api/query?search_query=${q}&max_results=5&sortBy=relevance`, { signal, type: 'text' });
  if (!xml) return [];
  return xml
    .split(/<entry>/)
    .slice(1)
    .map((e) => {
      const pick = (re) => (e.match(re) || [])[1] || null;
      const abs = pick(/<id>([^<]+)<\/id>/) || '';
      const id = abs.replace(/^https?:\/\/arxiv\.org\/abs\//, '');
      const doi = pick(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/);
      return {
        db: 'arXiv',
        title: clean(pick(/<title>([\s\S]*?)<\/title>/)),
        date: (pick(/<published>([^<]+)<\/published>/) || '').slice(0, 10) || null,
        doi,
        venue: clean(pick(/<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/)) || 'arXiv preprint',
        authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)].slice(0, 3).map((x) => x[1]),
        institutions: [],
        citedBy: null,
        abstract: clean(pick(/<summary>([\s\S]*?)<\/summary>/)),
        openAccess: true,
        urls: [`https://arxiv.org/abs/${id}`, `https://arxiv.org/pdf/${id}`],
        link: `https://arxiv.org/abs/${id}`,
      };
    })
    .filter((p) => !until || !p.date || p.date <= until);
}

// ---------------------------------------------------------------- search + rank

const normTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Searches the databases that fit the claim and returns candidate papers, best first.
 * `until` (YYYY-MM-DD) excludes papers published after the page that repeats the claim.
 */
export async function searchPapers({ terms, claim, named = [], until = null, signal }) {
  const jobs = [openAlex(terms, until, signal), pubmed(terms, until, signal)];
  if (TECH.test(claim)) jobs.push(arxiv(terms, until, signal));
  const lists = await Promise.all(jobs.map((j) => j.catch(() => [])));
  const seen = new Map();
  for (const p of lists.flat()) {
    if (!p.title) continue;
    const k = p.doi ? p.doi.toLowerCase() : normTitle(p.title);
    const prev = seen.get(k);
    if (!prev) seen.set(k, p);
    else {
      // Same paper in two databases: keep the richer record, union the readable URLs.
      prev.urls = [...new Set([...prev.urls, ...p.urls])];
      if (!prev.abstract && p.abstract) prev.abstract = p.abstract;
      prev.citedBy = prev.citedBy ?? p.citedBy;
      prev.db = prev.db.includes(p.db) ? prev.db : `${prev.db} + ${p.db}`;
    }
  }
  return rankPapers([...seen.values()], claim, named);
}

/** Ranks papers by how well their title and abstract match the claim. */
export function rankPapers(papers, claim, named = []) {
  const ckw = keywords(claim);
  const cnums = keyNumbers(parseNumbers(claim));
  const namedToks = named.flatMap((n) => n.toLowerCase().split(/\s+/)).filter((t) => t.length >= 4);
  return papers
    .map((p) => {
      // A paper about the claim usually names its topic in the title.
      let score = 0.55 * overlap(ckw, keywords(p.title)) + 0.45 * overlap(ckw, keywords(`${p.title} ${p.abstract}`));
      const pn = parseNumbers(p.abstract);
      if (cnums.some((c) => pn.some((n) => Math.abs(n.value - c.value) <= Math.max(0.5, Math.abs(c.value) * 0.05)))) score += 0.2;
      if (p.citedBy) score += Math.min(0.15, Math.log10(p.citedBy + 1) * 0.04);
      const org = `${p.institutions.join(' ')} ${p.venue || ''} ${p.authors.join(' ')}`.toLowerCase();
      if (namedToks.some((t) => org.includes(t))) score += 0.2;
      return { ...p, score: Math.round(score * 100) / 100 };
    })
    .sort((a, b) => b.score - a.score);
}
