# Checky

A Chrome extension that does the check a journalist, student or analyst should do before quoting a number. Highlight a statistic, claim or quote on any page and click **Check source**. Checky follows the claim back through the pages that repeat it to the original study, report, filing or interview. It shows every step with its link, date and exact wording, and flags where the claim was **rounded, changed or misquoted**, or where **no original source exists**.

**▶ [Watch the 52-second demo](media/checky-demo.mp4)**, made from real runs.

Built for the TinyFish **Source Hunter** bounty. It uses four TinyFish endpoints: Search, Fetch, Agent and TinyResearch.

## Install (2 minutes)

1. Download this repo (**Code → Download ZIP**, then unzip) or `git clone` it.
2. Open `chrome://extensions` in Chrome (version 116 or later).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and choose the repo folder (the one with `manifest.json`).
5. The settings page opens. Paste your TinyFish API key from [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys), click **Save**, then **Test key**.
6. Pin the extension (puzzle-piece icon → pin) so you can open the side panel quickly.
7. Refresh any tabs that were already open.

TinyResearch is on by default and costs about $2 per check from your TinyFish wallet. Turn it off in Settings for fast, cheap checks (Search and Fetch only).

## Use

- Select text on any page and click the **Check source** button that appears under it, or
- right-click the selection → **Check the source of "…"**, or
- press **Alt+Shift+S**.

A **Checking** pill appears next to the text straight away. When the check finishes it opens into a **result card**, joined to the text by a line:

- the verdict, with the claim and any changed figure marked
- the trail as a citation timeline: each source's icon, title, site, date and how it compares
- a one-line summary, and **Full trail →** for the full report

Verdicts: **Matches the original**, **Rounded**, **Changed**, **Misquoted**, **Cited sources don't back this up**, **No original source found**, and **Source found, but nothing behind it** (the claim matches a report or press release that itself cites no study, and TinyResearch found none either). If lookups fail, the card says **Check failed** instead of guessing.

The side panel (**Full trail →**) shows:

- **Verdict** and summary.
- **Figure chain**: how each number reads at every step, e.g. `50%` ← `50%` ← `48.7%`.
- **Trail**: one card per step, from the page you're on back to the earliest source. Each card has the link (it opens scrolled to and highlighting the passage), the date, the exact passage with figures coloured by how they compare, and flags such as "Rounded here", "Source says *up to* 30%", "Source hedges ('may')" or "Year differs". Cited pages that did *not* support the claim are listed under each step, so dead ends are visible.
- **Deep check (TinyResearch)**: an independent investigation that runs alongside the trace (see below).
- **Copy report** exports the trail as Markdown for notes or a fact-check memo.
- **How this was checked**: the step-by-step log.

Settings has a Light / Dark / System theme (light by default) and switches for the card, the selection button and each TinyFish feature.

## Demo claims

[DEMO.md](DEMO.md) lists five real claims with the page and the exact text to highlight, including one that turns out wrong (Wikipedia's "9% recycled, 1950s–2018" → **Changed**) an honest **No original source found**, and a TinyResearch "Source found, but nothing behind it".

## How TinyFish is used

Checky uses four TinyFish endpoints. Each one does a job the others can't.

| Endpoint | What it does in Checky |
| --- | --- |
| **TinyResearch** (`/v1/automation/run-research-async`, `/events`, `/research-run/{id}`) | Starts at the same moment as the trace and independently investigates "where does this claim originally come from, and does it match?". Its progress streams into the panel. When it finishes, Checky takes the source it names as the original, plus its citations, **re-verifies them with Fetch** (finding the exact passage on each page) and, if TinyResearch reached further back than the citation trail, appends that page as the final step. If TinyResearch also finds no original, the verdict says so. Its full cited report is available in the panel. |
| **Fetch** (`api.fetch.tinyfish.ai`) | Reads every candidate source as clean Markdown (up to 10 per call, PDFs included). Checky then finds the 1–3 sentence passage that states the claim and records the page's publication date. Dead or redirected citations are re-read from their **Wayback Machine** snapshot nearest the citing page's date, also through Fetch. |
| **Search** (`api.search.tinyfish.ai`) | Used when a page names a source without linking it ("according to the Pew Research Center"), or when the trail goes cold. It runs web and `research_paper` searches. A result is only accepted if it is a primary-looking source, or is earlier than the page it would be the source of. Later copies are rejected. |
| **TinyAgent** (`/v1/automation/run`) | Fallback for cited pages that Fetch can't read (bot walls, script-heavy pages). It opens the page in a real browser and returns the verbatim passage and the URLs it cites, as structured JSON. Capped at 2 runs per trace. |

The panel footer shows how many calls each endpoint used for the current trace.

## Scholarly databases

Many viral statistics come from a published paper that the article repeating them never links. When the trail goes cold on a research-type claim, Checky searches three open scholarly databases:

| Database | Coverage |
| --- | --- |
| **OpenAlex** | About 250M works across all fields, with abstracts, DOIs, citation counts and open-access PDF links |
| **PubMed** | Medicine and life sciences |
| **arXiv** | Preprints in CS, physics, maths and economics (only for claims on those topics) |

Google Scholar isn't used: it has no API and blocks automated access.

How a paper is handled:

- **Query:** the selection's topic words only, without reporting filler ("researchers found", "about", "percent"), months or the names of organisations around the claim. Only papers published before the page that repeats the claim are searched.
- **Ranking:** title match counts more than an abstract match. A matching figure in the abstract, the citation count, and a match with a named institution add to the score.
- **Verification:** the top three are **read through TinyFish Fetch**, using the open-access PDF where there is one and the Wayback Machine for dead links.
  - A paper joins the trail only if its text states the claim **and** the claim's figure (exact or rounded). A paper that is merely on the topic is listed as "On topic, but doesn't state the figure".
  - If the full text is paywalled, the abstract is checked instead, and the step is labelled **Abstract only**.
- **Display:** every paper checked is listed under **Papers checked**, with its status, so a researcher can see what was considered.

Example: National Geographic says "only about nine percent of all plastic ever made has likely been recycled", citing the Royal Statistical Society. RSS phrases it as "90.5% … never been recycled", which Checky reads as the same figure stated the other way round. Neither page links the study, so OpenAlex and PubMed find Geyer et al., *Production, use, and fate of all plastics ever made* (Science Advances, 2017). Its PDF says "600 Mt (9%) have been recycled".

OpenAlex allows about 100 searches a day per network without a key. A free key (Settings → OpenAlex API key) raises that.

## How a trace works

1. **On the page you're on**, the content script captures the full sentence around your selection and the links next to it. It resolves footnote markers (`[12]` → the reference entry → its external link, as on Wikipedia) and reads the page's publication date.
2. **Which links does a passage cite?** Fetch's output gives a page's text and a flat list of its links, but not where each link sits. So Checky also reads the page's raw HTML and maps every link to its position in the text. Then it knows exactly which links (and which footnote entries) sit inside, or just before, the passage. When the HTML can't be read, it falls back to footnote entries, DOIs and URLs written in the text. If Fetch's text is nearly empty (pages built by JavaScript), the article text from that HTML is used instead.
3. **Each step**: rank the candidate links (closest to the claim first, then primary-looking domains: `.gov`, `.edu`, DOIs, journals, statistics offices, PDFs), fetch the top 4, and keep the page whose text actually contains the claim. "Contains" is scored on keyword overlap plus whether the figures match, and the passage text is kept word for word.
4. **Stop** when no further citation for the claim can be found or verified. The deepest verified page is the earliest source. It is labelled *primary* only when it looks like one, and otherwise the verdict says the trail stopped at a secondary source.
5. **Judge**: every figure in the claim is compared with every step's passage, so the panel can show exactly where a number changed:
   - exact, or consistent with a qualifier ("more than 40%" vs 43%)
   - **rounded** (within the precision the number was written with: "50%" for 48.7%)
   - **changed** (different value, % vs percentage points, million vs billion)
   - **not stated**
   - quotations are compared word by word, with a visible diff
   - also flagged: an "up to" or hedge ("may", "estimated") dropped from the source, and a different year

The rules are deliberately transparent. Every flag can be checked against the quoted passage shown right next to it.

## Honesty rules

- Every step is a live page that Checky fetched itself, and the quote is the text found on it.
- Pages found by search are labelled "Found by search, not linked", never presented as a citation.
- If cited links don't contain the claim, the verdict is "Cited sources don't back this up", and the pages that were checked are listed.
- If nothing is found, the verdict is "No original source found".
- If TinyResearch names an original that Checky can't verify on the page, the panel says so instead of adding it.
- A source dated more than 30 days after an earlier step can't be where the claim came from, so later copies are never called the original. Wiki creation dates are ignored for this, since wikis are edited continuously.
- If a lookup fails (rejected key, empty wallet, rate limit, timeout), a "no source" result is reported as **Check failed**, because the missing lookup might have found the source.
- Footnote markers selected with a claim (`[5]`, `[citation needed]`) are ignored when comparing figures.

## Known limits

- Figures written as words ("one million", "twice as likely") aren't compared as numbers.
- A misattributed quote can match a page that merely repeats it; who said it isn't checked yet.
- A figure can match an equal number elsewhere in the source's sentence.
- Pages in non-Latin scripts (Chinese, Russian, Arabic…) can't be matched yet.
- PDFs open in Chrome's viewer and text inside iframes can't be checked from the page.

## Development

```
npm test        # unit tests for claim matching + an offline end-to-end trace with mocked TinyFish APIs
node scripts/live-trace.mjs "<claim text>" <page url>   # a real trace from the terminal (Search + Fetch)
```

`live-trace.mjs` reads `TINYFISH_API_KEY` from the environment or from a `.env` file in the repo folder (never committed). Add `--research` or `--agent` to use those paid endpoints.

Plain JavaScript (ES modules) with no build step. Layout:

- `manifest.json` declares the extension
- `background.js` handles the right-click menu, the shortcut and opening the panel
- `content/content.js` runs in pages: the selection button, sentence, nearby links, footnotes and date
- `offscreen/` runs traces in the background, so they keep going whether or not the side panel is open
- `content/card.js` draws the on-page result: a "Checking…" pill while the trace runs, then the result card
- `sidepanel/` shows the full trail of the current trace
- `lib/tracer.js` is the pipeline
- `lib/claims.js` holds the figure parsing, passage finding and comparison
- `lib/tinyfish.js` is the API client
- `lib/scholar.js` handles the OpenAlex, PubMed and arXiv search and paper ranking
- `options/` holds the settings, including the Light / Dark / System theme (light by default)
- `ui/tokens.css` is the shared design system (colours, type, verdict tones) used by the card, side panel and Settings; `ui/theme.js` applies the theme setting
- `fonts/` bundles Geist and Geist Mono (SIL Open Font License, see `fonts/OFL.txt`), so no fonts are loaded from the web
- `icons/icon.svg` is the source of the toolbar icon
- `test/harness/` has test pages for the card (`card.html`), side panel (`panel.html`) and Settings (`options.html`) with stubbed extension APIs; serve the folder (`python -m http.server`) and add `#dark` to see the dark theme
