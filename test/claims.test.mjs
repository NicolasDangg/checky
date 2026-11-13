// Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripRefMarks,
  parseNumbers, compareClaim, locatePassage, isFound, mdLinks, resolveFootnotes,
  namedSources, sourceKind, rankLinks, quoteSimilarity, extractQuote,
} from '../lib/claims.js';

test('parses percentages, scales, currency, ratios and years', () => {
  const n = parseNumbers('About 43% of adults, $1.5 billion, one in five teens, 2,300 people in 2021, two-thirds of voters, COVID-19');
  const by = (raw) => n.find((x) => x.raw === raw);
  assert.equal(by('43%').kind, 'percent');
  assert.equal(by('43%').qualifier, 'about');
  assert.equal(by('$1.5 billion').value, 1.5e9);
  assert.equal(by('$1.5 billion').kind, 'currency');
  assert.equal(Math.round(by('one in five').value), 20);
  assert.equal(by('2,300').value, 2300);
  assert.equal(by('2021').kind, 'year');
  assert.ok(n.some((x) => x.raw === 'two-thirds'));
  assert.ok(!n.some((x) => x.value === 19), 'COVID-19 is not a figure');
});

test('exact match', () => {
  const r = compareClaim('43% of adults use the app', 'The survey found 43% of adults use the app daily.');
  assert.equal(r.status, 'match');
});

test('rounding is detected', () => {
  const r = compareClaim('Half of all users quit within a week (50%)', 'Overall, 48.7% of users stopped using it within seven days.');
  assert.equal(r.status, 'rounded');
});

test('changed figure is detected', () => {
  const r = compareClaim('70% of Americans support the policy', 'Support for the policy stands at 52% of Americans.');
  assert.equal(r.status, 'changed');
});

test('qualifier "more than" is consistent', () => {
  const r = compareClaim('more than 40% of firms', '43% of firms reported losses');
  assert.equal(r.status, 'match');
});

test('percent vs percentage points is a unit change', () => {
  const r = compareClaim('unemployment rose 2%', 'unemployment rose 2 percentage points');
  assert.equal(r.status, 'changed');
});

test('dropping "up to" is flagged', () => {
  const r = compareClaim('the drug cuts risk by 30%', 'the drug cuts risk by up to 30% in trials');
  assert.equal(r.status, 'changed');
  assert.ok(r.flags.some((f) => f.includes('upper bound')));
});

test('million vs billion', () => {
  const r = compareClaim('costs $3 billion a year', 'costs an estimated $3 million a year');
  assert.equal(r.status, 'changed');
  assert.ok(r.flags.some((f) => f.includes('1,000')));
});

test('misquote detected via word diff', () => {
  const q = extractQuote('He said "we will never raise taxes on working families"');
  assert.ok(q);
  const s = quoteSimilarity(q, 'Speaking on Monday he said: "We will not raise taxes on working families this year."');
  assert.ok(s.sim > 0.6 && s.sim < 0.97, String(s.sim));
});

test('locates the right passage in a long page', () => {
  const md = [
    '# Report', 'Intro text about many unrelated things and methods.',
    'Among adults aged 18 to 29, 48.7% said they stopped using social media for a week at least once. [source](https://example.org/study.pdf)',
    'Another paragraph mentions 12% of something else entirely.',
  ].join('\n\n');
  const loc = locatePassage(md, ['Half of young adults have quit social media for a week']);
  assert.ok(isFound(loc));
  assert.match(loc.quote, /48\.7%/);
  assert.equal(mdLinks(loc.raw)[0].url, 'https://example.org/study.pdf');
});

test('resolves wikipedia-style footnotes', () => {
  const md = 'The tower is 330 metres tall.[[12]](https://en.wikipedia.org/wiki/Tower#cite_note-12)\n\n## References\n\n12. ^ [Official site](https://tower.example.fr/facts) Retrieved 2020.';
  const links = mdLinks(md.split('\n\n')[0]);
  const fn = resolveFootnotes(md, 'https://en.wikipedia.org/wiki/Tower', links, 0);
  assert.equal(fn[0].url, 'https://tower.example.fr/facts');
});

test('named sources and source kinds', () => {
  assert.deepEqual(namedSources('according to the Pew Research Center, most adults agree'), ['Pew Research Center']);
  assert.equal(sourceKind('https://www.cdc.gov/x'), 'primary');
  assert.equal(sourceKind('https://doi.org/10.1/abc'), 'primary');
  assert.equal(sourceKind('https://en.wikipedia.org/wiki/X'), 'reference');
  assert.equal(sourceKind('https://news.example.com/report.pdf'), 'document');
  const ranked = rankLinks(
    [{ url: 'https://twitter.com/intent/tweet?x', weight: 4 }, { url: 'https://blog.example.com/a', weight: 2 }, { url: 'https://www.bls.gov/data', weight: 2 }],
    { pageUrl: 'https://news.example.com/story', visited: new Set() },
  );
  assert.equal(ranked[0].url, 'https://www.bls.gov/data');
  assert.equal(ranked.length, 2);
});

test('a source stating the complement is recognised, not flagged as changed', () => {
  const r = compareClaim(
    'only about nine percent of all plastic ever made has been recycled',
    'The winning statistic is 90.5%: the proportion of plastic waste that has never been recycled. Around 12% has been incinerated.',
  );
  assert.notEqual(r.status, 'changed', JSON.stringify(r));
  assert.equal(r.numbers[0].source.value, 9.5);
  assert.ok(r.flags.some((f) => /other way round/.test(f)));
  // No negation near the figure: not a complement.
  assert.equal(compareClaim('9% of plastic is recycled', 'Of all plastic, 91% is landfilled.').status, 'changed');
});

test('footnote markers selected with a claim are ignored', () => {
  assert.equal(stripRefMarks('covers 1.6 million km²[5].'), 'covers 1.6 million km².');
  assert.equal(stripRefMarks('9% has been recycled[12][13] and[citation needed] more[a]'), '9% has been recycled and more');
  assert.equal(compareClaim('the patch covers 1.6 million square kilometres[5]', 'The patch covers 1.6 million square kilometres, a 2018 study found.').status, 'match');
});
