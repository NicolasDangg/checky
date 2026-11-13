// Runs a real trace from the terminal, without Chrome, so the pipeline can be checked
// against live TinyFish.
//   node scripts/live-trace.mjs "<claim text>" <page url> [--research] [--agent] [--out=trace.json]
// --out saves the request, the final state and the card at each step (for demos and test pages).
// Reads TINYFISH_API_KEY from the environment or from a .env file in this folder.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runTrace } from '../lib/tracer.js';
import { cardData } from '../lib/carddata.js';
import { writeFileSync } from 'node:fs';
import { setApiKey, fetchUrls } from '../lib/tinyfish.js';
import { locatePassage, mdLinks, resolveFootnotes } from '../lib/claims.js';
import { getHtml, buildLinkMap, linksForPassage } from '../lib/linkmap.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let key = process.env.TINYFISH_API_KEY;
if (!key && existsSync(join(root, '.env'))) key = (readFileSync(join(root, '.env'), 'utf8').match(/TINYFISH_API_KEY\s*=\s*(\S+)/) || [])[1];
if (!key) throw new Error('Set TINYFISH_API_KEY (or put it in source-hunter/.env)');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [claim, url] = args.filter((a) => !a.startsWith('--'));
if (!claim || !url) throw new Error('usage: node scripts/live-trace.mjs "<claim>" <url> [--research] [--agent]');

// Build what the content script would capture, from the live page.
setApiKey(key);
const page = await fetchUrls([url]);
const r = page.results?.[0];
if (!r) throw new Error(`Could not fetch the start page: ${JSON.stringify(page.errors)}`);
// Emulate the content script: the page's own text and links (from its HTML when available).
const html = await getHtml(r.final_url || url);
let loc = locatePassage(r.text, [claim]);
if (html && (!loc || loc.score < 0.45)) {
  const alt = locatePassage(buildLinkMap(html, r.final_url || url).text.replace(/\n+/g, '\n\n'), [claim]);
  if (alt && (!loc || alt.score > loc.score)) loc = alt;
}
let links = loc && html ? linksForPassage(buildLinkMap(html, r.final_url || url), loc.quote, r.final_url || url) || [] : [];
if (!links.length && loc) links = [...mdLinks(loc.raw), ...resolveFootnotes(r.text, r.final_url || url, mdLinks(loc.raw), loc.offset)].map((l) => ({ ...l, weight: 3.5 }));
console.log('HTML link map:', html ? 'yes' : 'no', links.slice(0, 8).map((l) => `${l.weight} ${l.url}`));
const req = { id: 'cli', claim, sentence: loc?.quote || claim, context: loc?.raw || '', url, title: r.title, pageDate: r.published_date, links };
console.log(`Start passage: ${loc?.quote}\nLinks near it: ${links.length}\n`);

let lastPhase = '';
const cards = []; // the card as it looked at each phase
const state = await runTrace(
  req,
  { apiKey: key, useResearch: flags.has('--research'), useAgent: flags.has('--agent'), maxHops: 5 },
  (s) => {
    if (s.phase !== lastPhase) {
      console.log('…', (lastPhase = s.phase));
      cards.push(cardData(req, s));
    }
  },
  new AbortController().signal,
);

console.log(`\nVERDICT: ${state.verdict?.headline}\n  ${state.verdict?.detail}\n`);
state.steps.forEach((s, i) => {
  console.log(`${i + 1}. [${s.via}] ${s.site} ${s.date || ''} (${s.kind}) ${s.cmp?.status || ''}`);
  console.log(`   ${s.url}`);
  console.log(`   "${s.quote.slice(0, 300)}"`);
  for (const f of [...(s.drift || []), ...(s.cmp?.flags || [])]) console.log(`   - ${f}`);
  for (const c of s.checked || []) console.log(`   x ${c.url}: ${c.reason}`);
});
if (state.papers?.length) {
  console.log('\nPapers checked:');
  for (const p of state.papers) console.log(`  [${p.status}] ${p.date || ''} ${p.title} (${p.db}, score ${p.score}${p.citedBy != null ? `, cited ${p.citedBy}` : ''}) ${p.link}`);
}
if (state.figures?.length) console.log('\nFigures:', state.figures.map((f) => [f.claim, ...f.chain.slice(1).map((c) => c.raw)].join(' <- ')).join(' | '));
if (state.research?.status !== 'off') console.log('\nResearch:', state.research.status, state.research.originalLine || state.research.error || '');
console.log('\nLog:\n' + state.log.map((l) => '  ' + l.msg).join('\n'));
console.log('\nUsage:', state.usage);

const out = args.find((a) => a.startsWith('--out='))?.slice(6);
if (out) {
  writeFileSync(out, JSON.stringify({ req, state, cards: [...cards, cardData(req, state)] }, null, 1));
  console.log('Saved', out);
}
