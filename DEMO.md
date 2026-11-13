# Demo claims

Each claim below was re-run on the current pipeline on 2026-11-13 with `scripts/live-trace.mjs`, using Search and Fetch only (no TinyResearch or Agent spend) unless noted. To demo one, open the page, find the sentence, highlight the **claim text** and click **Check source**.

| # | Verdict | Page | Highlight |
|---|---|---|---|
| 1 | Matches, back to a paper | [National Geographic](https://www.nationalgeographic.com/science/article/plastic-produced-recycling-waste-ocean-trash-debris-environment) | `only about nine percent of all plastic ever made has likely been recycled` |
| 2 | Matches, two steps back | [FOX 13 Seattle](https://www.fox13seattle.com/news/americans-check-their-smartphones-96-times-a-day-survey-says) | `Americans check their phones 96 times a day` |
| 3 | **Changed (the wrong claim)** | [Wikipedia: Plastic pollution](https://en.wikipedia.org/wiki/Plastic_pollution) | `an estimated 9% has been recycled` |
| 4 | No original source found | [Forbes (Neil Patel, 2015)](https://forbes.com/sites/neilpatel/2015/01/16/90-of-startups-will-fail-heres-what-you-need-to-know-about-the-10) | `Nine out of ten startups will fail` |
| 5 | Source found, but nothing behind it (uses TinyResearch, about $2) | [TIME](https://time.com/3858309/attention-spans-goldfish/) | `the average attention span dropped from 12 seconds to eight seconds` |

## What each one shows

1. **NatGeo plastics, which matches.** NatGeo leads to the RSS write-up and then to Geyer, Jambeck & Law 2017, *Science Advances*. The paper is found through OpenAlex and PubMed and read through the Wayback Machine. RSS words the figure the other way round ("90.5% never recycled"), and Checky treats that as the same figure. Shows: scholarly search, archive fallback, and complement matching.
2. **Phones 96 times a day, which matches.** FOX 13 (2021) leads to the PR Newswire release (21 Nov 2019) and then to Asurion's own page. Shows: a multi-hop trail with a date on each step, and that it stops at the company that ran the survey.
3. **Wikipedia plastics, the wrong claim.** Wikipedia says that from the 1950s up to 2018, 6.3 billion tonnes of plastic was *produced* and 9% of it recycled. The cited paper (Geyer 2017) only covers up to **2015**, and 6.3 billion tonnes is its figure for plastic *waste*; total production was 8.3 billion. Checky flags "Year differs: claim mentions 1950, 2018, source mentions 2015" and reaches the science.org paper through the footnote. In the voice-over, point out the production/waste mix-up too, because Checky only flags the year.
4. **90% of startups fail, with no source.** The Forbes piece gives no citation, and search finds nothing earlier that states it. This is the honest "No original source found".
5. **Goldfish (optional, paid).** TIME leads to Microsoft Canada's 2015 report, read through the Wayback Machine. TinyResearch then finds **no study behind Microsoft's figure** ("NONE FOUND"). Shows: TinyResearch, and the fact that matching the cited source doesn't make a figure true. The card reads **"Source found, but nothing behind it"**: the claim matches Microsoft's report, but the report cites no study and TinyResearch found none either.

## Demo video

[media/checky-demo.mp4](media/checky-demo.mp4) (52 s, 1080p) shows claims 1, 3 and 2: highlight, **Check source**, the Checking pill, the result card, the full trail in the side panel, and Settings. Every screenshot in it is from a real run: each claim was traced live with Search and Fetch, then Checky's own page scripts drew the card on the real article page.

Forbes (claim 4) isn't in the video, because forbes.com shows automated browsers a bot wall instead of the article. It works in a normal Chrome.

## A known limit: misattributed quotes

The "Einstein" quote *"Insanity is doing the same thing over and over and expecting different results"* ([golfprop.com](https://golfprop.com/uncategorized/repetition-the-definition-of-insanity/)) was dropped from the list. On 13 Nov one run gave "No original source found", and a later run gave **"Matches the earliest source found"**: search found 2015 Scientific American and Quanta articles that quote the line, and Checky followed them. The verdict still says the trail stopped at secondary sources and never reached an original, but Checky doesn't yet check *who* said a quote, so a quote repeated widely enough can look sourced. See "Known limits" in the README.
