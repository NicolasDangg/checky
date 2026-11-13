// Builds sample trail states for test/harness/panel.html from the offline mock web used
// by test/tracer.test.mjs (no API calls). Run: node test/harness/panel-state.mjs
import { writeFileSync } from 'node:fs';
import { runTrace } from '../../lib/tracer.js';

const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../tracer.test.mjs', import.meta.url), 'utf8'));
// Reuse the test file's PAGES and mockFetch without running its tests.
const body = src.slice(src.indexOf('const PAGES'), src.indexOf('const base'));
const { PAGES, mockFetch } = new Function(`${body}; return { PAGES, mockFetch };`)();
globalThis.fetch = mockFetch([]);

const settings = { apiKey: 'test', useResearch: false, useAgent: false, maxHops: 5 };
const base = { claim: 'Half of young adults have quit social media for a week', url: 'https://news.example.com/story', title: 'Story', pageDate: '2024-06-01' };
const rounded = await runTrace(
  { ...base, id: 'p1', sentence: 'Half of young adults have quit social media for a week, studies show (50%).', links: [{ url: 'https://blog.example.com/stats', text: 'studies show', weight: 4 }] },
  settings, () => {}, new AbortController().signal,
);
const nothing = await runTrace(
  { ...base, id: 'p2', claim: '48.7% said they had quit social media for at least a week', sentence: 'Among adults aged 18 to 29, 48.7% said they had quit social media for at least a week, the institute said.', links: [{ url: 'https://dhi.example.org/report-2023.pdf', text: 'the institute said', weight: 4 }] },
  { ...settings, useResearch: true }, () => {}, new AbortController().signal,
);
writeFileSync(new URL('./panel-states.json', import.meta.url), JSON.stringify({ rounded, nothing }, null, 1));
console.log('wrote', rounded.verdict.headline, '|', nothing.verdict.headline);
