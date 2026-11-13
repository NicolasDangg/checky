// End-to-end tracer test against a fake web: TinyFish's HTTP APIs are mocked,
// so this exercises the whole pipeline offline and costs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrace } from '../lib/tracer.js';

const PAGES = {
  'https://blog.example.com/stats': {
    title: 'Social media stats you need',
    published_date: '2024-05-01',
    text: '# Stats\n\nA recent report found that half of young adults have quit social media for a week, according to the Digital Habits Institute. [Read the report](https://dhi.example.org/report-2023.pdf)\n\nOther stuff here.',
  },
  'https://dhi.example.org/report-2023.pdf': {
    title: 'Digital Habits Report 2023',
    published_date: '2023-03-10',
    text: 'Key findings\n\nAmong adults aged 18 to 29, 48.7% said they had quit social media for at least a week in the past year. The survey of 2,000 adults was fielded in January 2023.\n\nMethodology follows.',
  },
  // A later university page that copies the claim word for word (like a course reading).
  'https://law.example.edu/goldfish': {
    title: 'Are we no better than goldfish?',
    published_date: '2025-01-06',
    text: 'A recent report found that half of young adults have quit social media for a week, according to the Digital Habits Institute.',
  },
  'https://unrelated.example.net/x': { title: 'Unrelated', published_date: '2022-01-01', text: 'Nothing to see here about cats and dogs at all.' },
};

function mockFetch(log) {
  return async (url, init = {}) => {
    const u = String(url);
    log.push(u);
    const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.startsWith('https://api.fetch.tinyfish.ai')) {
      const { urls } = JSON.parse(init.body);
      const results = [];
      const errors = [];
      for (const x of urls) {
        const p = PAGES[x];
        if (p) results.push({ url: x, final_url: x, links: [], format: 'markdown', ...p });
        else errors.push({ url: x, error: 'page_not_found', status: 404 });
      }
      return json({ results, errors });
    }
    if (u.includes('/run-research-async')) return json({ research_run_id: 'r1', error: null });
    if (u.endsWith('/research-run/r1')) {
      return json({
        status: 'COMPLETED',
        deep_result: {
          result: '# Report\n\n## Executive Summary\n\nThe figure was copied from an aggregator site that cites nothing; no study behind it could be found by anyone who checked.\n\nORIGINAL SOURCE: NONE FOUND',
          citations: ['https://law.example.edu/goldfish'],
        },
      });
    }
    if (u.startsWith('https://api.search.tinyfish.ai')) {
      return json({ results: [{ position: 1, url: 'https://dhi.example.org/report-2023.pdf', title: 'Digital Habits Report', snippet: '' }, { position: 2, url: 'https://unrelated.example.net/x', title: 'x' }] });
    }
    return new Response('{}', { status: 404 });
  };
}

const base = {
  id: 't1',
  claim: 'Half of young adults have quit social media for a week',
  url: 'https://news.example.com/story',
  title: 'Story',
  pageDate: '2024-06-01',
};
const settings = { apiKey: 'test', useResearch: false, useAgent: false, maxHops: 5 };

test('follows a cited chain to the primary document and flags rounding', async () => {
  const calls = [];
  globalThis.fetch = mockFetch(calls);
  const req = {
    ...base,
    sentence: 'Half of young adults have quit social media for a week, studies show (50%).',
    links: [{ url: 'https://blog.example.com/stats', text: 'studies show', weight: 4 }],
  };
  const s = await runTrace(req, settings, () => {}, new AbortController().signal);
  assert.equal(s.steps.length, 3, s.log.map((l) => l.msg).join('\n'));
  assert.equal(s.steps[1].via, 'cited');
  assert.equal(s.steps[2].site, 'dhi.example.org');
  assert.equal(s.steps[2].kind, 'document');
  assert.match(s.steps[2].quote, /48\.7%/);
  assert.equal(s.verdict.originIndex, 2);
  assert.equal(s.verdict.status, 'rounded', JSON.stringify(s.verdict));
});

test('no citation: falls back to search and finds the report', async () => {
  globalThis.fetch = mockFetch([]);
  const req = { ...base, id: 't2', sentence: base.claim + '.', links: [] };
  const s = await runTrace(req, settings, () => {}, new AbortController().signal);
  assert.equal(s.steps.length, 2, s.log.map((l) => l.msg).join('\n'));
  assert.equal(s.steps[1].via, 'search');
  assert.equal(s.steps[1].site, 'dhi.example.org');
});

test('honest when nothing supports the claim', async () => {
  globalThis.fetch = mockFetch([]);
  const req = {
    ...base,
    id: 't3',
    claim: 'Ninety percent of goldfish prefer jazz music',
    sentence: 'Ninety percent of goldfish prefer jazz music.',
    links: [{ url: 'https://unrelated.example.net/x', text: 'source', weight: 4 }],
  };
  const s = await runTrace(req, settings, () => {}, new AbortController().signal);
  assert.equal(s.steps.length, 1);
  assert.equal(s.verdict.status, 'unsupported');
  assert.match(s.verdict.headline, /don’t back/);
});

test('verdict defers to TinyResearch when it finds no original behind a secondary source', async () => {
  globalThis.fetch = mockFetch([]);
  const req = {
    ...base,
    id: 't4',
    sentence: 'Half of young adults have quit social media for a week, studies show (50%).',
    links: [{ url: 'https://blog.example.com/stats', text: 'studies show', weight: 4 }],
  };
  // Without the PDF, the trail ends at the blog (secondary).
  const saved = PAGES['https://dhi.example.org/report-2023.pdf'];
  delete PAGES['https://dhi.example.org/report-2023.pdf'];
  try {
    const s = await runTrace(req, { ...settings, useResearch: true }, () => {}, new AbortController().signal);
    assert.equal(s.research.status, 'done');
    assert.equal(s.research.saysNone, true);
    assert.equal(s.verdict.status, 'none', JSON.stringify(s.verdict));
    assert.ok(!s.steps.some((x) => x.site === 'law.example.edu'), 'a later copy cited by TinyResearch must not join the trail');
    assert.match(s.verdict.research, /aggregator site/);
  } finally {
    PAGES['https://dhi.example.org/report-2023.pdf'] = saved;
  }
});

test('a company report with nothing behind it: matched, but flagged as unsourced', async () => {
  globalThis.fetch = mockFetch([]);
  const req = {
    ...base,
    id: 't5',
    claim: '48.7% said they had quit social media for at least a week',
    sentence: 'Among adults aged 18 to 29, 48.7% said they had quit social media for at least a week, the institute said.',
    links: [{ url: 'https://dhi.example.org/report-2023.pdf', text: 'the institute said', weight: 4 }],
  };
  const s = await runTrace(req, { ...settings, useResearch: true }, () => {}, new AbortController().signal);
  assert.equal(s.research.saysNone, true);
  assert.equal(s.verdict.status, 'none', JSON.stringify(s.verdict));
  assert.equal(s.verdict.headline, 'Source found, but nothing behind it');
  assert.match(s.verdict.detail, /Digital Habits Report 2023 \(2023-03-10\), 1 step back.*cites no study/);
});

// ---------------------------------------------------------------- scholarly databases

const openAlexWork = (o) => ({
  id: 'https://openalex.org/W1',
  doi: `https://doi.org/${o.doi}`,
  title: o.title,
  publication_date: o.date,
  cited_by_count: 1200,
  primary_location: { source: { display_name: 'Journal of Sleep Research' } },
  best_oa_location: o.pdf ? { pdf_url: o.pdf, landing_page_url: null } : null,
  authorships: [{ author: { display_name: 'A. Researcher' }, institutions: [{ display_name: 'University of Somewhere' }] }],
  abstract_inverted_index: Object.fromEntries(
    o.abstract.split(' ').reduce((m, w, i) => (m.set(w, [...(m.get(w) || []), i]), m), new Map()),
  ),
});

function scholarFetch(works, pages) {
  const base = mockFetch([]);
  return async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://api.openalex.org/works')) {
      return new Response(JSON.stringify({ results: works }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://api.fetch.tinyfish.ai')) {
      const { urls } = JSON.parse(init.body);
      const results = [];
      const errors = [];
      for (const x of urls) {
        const p = pages[x] || PAGES[x];
        if (p) results.push({ url: x, final_url: x, links: [], format: 'markdown', ...p });
        else errors.push({ url: x, error: 'login_required', status: 403 });
      }
      return new Response(JSON.stringify({ results, errors }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return base(url, init);
  };
}

const sleepReq = {
  ...base,
  id: 's1',
  url: 'https://news.example.com/sleep',
  pageDate: '2021-03-01',
  claim: 'Teenagers who sleep less than 7 hours are 40% more likely to report anxiety, researchers found',
  sentence: 'Teenagers who sleep less than 7 hours are 40% more likely to report anxiety, researchers found.',
  links: [],
};
const SLEEP_ABSTRACT = 'In a cohort of 4,000 adolescents, teenagers who sleep less than 7 hours per night were 38% more likely to report symptoms of anxiety than peers who slept longer.';

test('scholarly search finds the paper and reads its full text', async () => {
  const pdf = 'https://journal.example.org/sleep.pdf';
  globalThis.fetch = scholarFetch(
    [openAlexWork({ doi: '10.1000/sleep', title: 'Sleep duration and anxiety in adolescents', date: '2019-05-02', pdf, abstract: SLEEP_ABSTRACT })],
    { [pdf]: { title: 'sleep.pdf', text: `Abstract\n\n${SLEEP_ABSTRACT}\n\nMethods\n\nWe surveyed students.` } },
  );
  const s = await runTrace(sleepReq, settings, () => {}, new AbortController().signal);
  const last = s.steps[s.steps.length - 1];
  assert.equal(last.via, 'scholar', s.log.map((l) => l.msg).join('\n'));
  assert.equal(last.kind, 'primary');
  assert.equal(last.paper.doi, '10.1000/sleep');
  assert.ok(!last.abstractOnly);
  assert.equal(s.papers[0].status, 'verified');
  assert.equal(s.verdict.status, 'rounded', JSON.stringify(s.verdict)); // 40% vs 38%
});

test('paywalled paper is checked against its abstract, and labelled so', async () => {
  globalThis.fetch = scholarFetch(
    [openAlexWork({ doi: '10.1000/sleep2', title: 'Sleep duration and anxiety in adolescents', date: '2019-05-02', abstract: SLEEP_ABSTRACT })],
    {},
  );
  const s = await runTrace({ ...sleepReq, id: 's2' }, settings, () => {}, new AbortController().signal);
  const last = s.steps[s.steps.length - 1];
  assert.equal(last.via, 'scholar', s.log.map((l) => l.msg).join('\n'));
  assert.equal(last.abstractOnly, true);
  assert.equal(s.papers[0].status, 'abstract');
  assert.match(s.verdict.detail, /abstract only/);
});

test('a paper published after the page is not accepted as its source', async () => {
  globalThis.fetch = scholarFetch(
    [openAlexWork({ doi: '10.1000/sleep3', title: 'Sleep duration and anxiety in adolescents', date: '2023-01-10', abstract: SLEEP_ABSTRACT })],
    {},
  );
  const s = await runTrace({ ...sleepReq, id: 's3' }, settings, () => {}, new AbortController().signal);
  assert.ok(!s.steps.some((x) => x.via === 'scholar'));
  assert.equal(s.papers[0].status, 'later');
});

test('scholarly search can be switched off', async () => {
  const calls = [];
  const f = scholarFetch([], {});
  globalThis.fetch = async (u, i) => (calls.push(String(u)), f(u, i));
  await runTrace({ ...sleepReq, id: 's4' }, { ...settings, useScholar: false }, () => {}, new AbortController().signal);
  assert.ok(!calls.some((u) => u.includes('openalex') || u.includes('eutils') || u.includes('arxiv')));
});

// ---------------------------------------------------------------- failures and dates

test('a rejected API key ends as a failed check, not "no source found"', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  const req = { ...base, id: 'e1', links: [{ url: 'https://blog.example.com/stats', text: 'studies show', weight: 4 }] };
  const s = await runTrace(req, settings, () => {}, new AbortController().signal);
  assert.equal(s.status, 'error', JSON.stringify(s.verdict));
  assert.match(s.error, /rejected the API key/);
});

test('when search is rate-limited, "no source found" becomes a failed check', async () => {
  const ok = mockFetch([]);
  globalThis.fetch = async (u, i) =>
    String(u).startsWith('https://api.search.tinyfish.ai')
      ? new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json' } })
      : ok(u, i);
  const s = await runTrace({ ...base, id: 'e2', links: [] }, settings, () => {}, new AbortController().signal);
  assert.equal(s.status, 'error', JSON.stringify(s.verdict));
  assert.match(s.error, /Couldn't finish checking: .*rate limit/);
});

test('a Wikipedia page’s creation date does not rule out newer sources', async () => {
  globalThis.fetch = mockFetch([]);
  const req = {
    ...base,
    id: 'w1',
    url: 'https://en.wikipedia.org/wiki/Social_media',
    title: 'Social media - Wikipedia',
    pageDate: '2005-12-29T02:18:50Z', // when the article was created, not when this line was written
    sentence: 'About half of young adults have quit social media for a week.[12]',
    claim: 'half of young adults have quit social media for a week[12]',
    links: [{ url: 'https://dhi.example.org/report-2023.pdf', text: '[12]', weight: 4.5, via: 'footnote' }],
  };
  const s = await runTrace(req, settings, () => {}, new AbortController().signal);
  assert.equal(s.steps[0].date, null);
  assert.ok(s.steps.some((x) => x.site === 'dhi.example.org'), s.log.map((l) => l.msg).join('\n'));
  assert.equal(s.claim, 'half of young adults have quit social media for a week');
});
