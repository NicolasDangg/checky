// The compact summary the on-page card draws: verdict, sources and short summary.
import { fragmentLink } from './claims.js';

export const fmtDate = (d) => {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? String(d).slice(0, 24) : new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

export function cardData(req, s) {
  const v = s.verdict;
  return {
    id: req.id,
    claim: s.claim,
    status: s.status,
    phase: s.phase,
    error: s.error || null,
    verdict: v ? { status: v.status, headline: v.headline, detail: v.detail, research: v.research || '', originIndex: v.originIndex } : null,
    research: s.research?.status || 'off',
    elapsed: s.startedAt ? Math.max(1, Math.round((Date.now() - s.startedAt) / 1000)) : null,
    // How each figure in the claim reads at the earliest source (to mark it in the claim).
    figures: (s.figures || []).map((f) => ({ raw: f.claim, status: f.chain[f.chain.length - 1]?.status || null })),
    steps: (s.steps || []).map((st, i) => ({
      title: st.title,
      site: st.site,
      url: i === 0 ? st.url : fragmentLink(st.url, st.quote),
      favUrl: st.originalUrl || st.url,
      date: st.date ? fmtDate(st.date) : null,
      kind: st.kind,
      via: st.via,
      status: i === 0 ? null : st.cmp?.status || null,
      archived: !!st.archived,
      abstractOnly: !!st.abstractOnly,
      venue: st.paper?.venue || null,
    })),
  };
}
