# AEO Scorer (Chrome extension)

A Chrome side panel that scores a page or a whole site for Answer Engine Optimization (AEO), Generative Engine Optimization (GEO), schema and accessibility. It highlights the problems on the page, re-checks them after you fix them, exports reports to share with your team, and tracks whether AI answers mention your brand and cite your site. The rules follow "AEO & GEO: A Developer's Implementation Guide" (Nov 2026).

## Install (load unpacked)

1. Run `npm install && npm run build` and use the `dist/` folder (or unzip a packaged `aeo-scorer-<version>.zip`).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the unzipped folder.
3. Pin the extension and click its icon. The panel opens on the right and stays open while you reload or navigate.

## How it works

- **Score (free, instant, no AI).** The panel reads a snapshot of the page and runs rule checks in seven weighted groups: crawler access 20% (meta robots, X-Robots-Tag, robots.txt for Googlebot, Bingbot, OAI-SearchBot, PerplexityBot and Claude-SearchBot, server-rendered content), answer-first content 20%, page structure 15%, structured data 15%, head tags 10%, trust and evidence 10%, technical and security 10%. Grades run A to F. Blockers (noindex, HTTP errors, robots.txt blocking Google, Bing or every AI search bot, JavaScript-only content) cap the score at 59, grade D. Each issue cites the guide section and how solid the evidence is (Documented, Practice or Study).
- **Fix loop.** Click **Show on page** to scroll to and outline an element, or turn on **Highlight issues on page**. After you change the page, click **Mark fixed**, then reload the tab. The panel re-scans automatically and tells you which issues are verified fixed and which are still failing.
- **Claude review (optional).** Add your Anthropic API key in Settings and click **Ask Claude**. Claude judges what rules cannot, such as whether the opening actually answers the main question, and returns findings with paste-ready text and a suggested JSON-LD block. Findings appear in the same list with a Claude chip.

- **Start screen.** Close a report (✕) to scan the current tab, open and scan any URL, crawl a site, or reopen a recent report.
- **Site crawl.** Visits up to 10, 25, 50 or 100 pages one at a time in a background tab, so JavaScript-rendered content counts. Seeds from the sitemap, follows internal links, respects robots.txt, and skips login, cart, admin and non-HTML URLs. The site report shows average scores, issues grouped across pages (with how many pages each affects) and every page's score; click a page for its full report.
- **Schema, FAQ and tag checks.** JSON-LD @context, Organization, Article, BreadcrumbList, Product and rating, duplicate entities, dates matching the visible date, FAQPage completeness and whether its questions are visible, viewport, charset, duplicate canonicals, og:image and HTTP status.
- **Accessibility.** Runs axe-core (WCAG 2.0 to 2.2, A and AA, plus best practices) in the page. Issues are grouped by who they affect (screen-reader users, low vision, keyboard and motor, deaf and hard of hearing, cognitive) and tagged with the WCAG criterion. The accessibility score is separate from the AEO score. Automated checks catch only part of accessibility problems, so still test with a keyboard and a screen reader.
- **Technical & security.** HTTPS and HTTP→HTTPS redirect, HSTS and other security headers, caching headers, server response time and compression, soft 404s, sitemap.xml, security.txt, mixed content, image formats, sizes and lazy loading, URL structure, CDN/firewall detection, cookie consent, and email records (SPF, DMARC, DKIM at common selectors, MTA-STS) via Google DNS-over-HTTPS.
- **Site-wide checks in a crawl.** Duplicate titles and descriptions, one-way hreflang links and canonicals pointing at broken pages.
- **Reports.** The download button exports an HTML report (opens in any browser, prints to PDF) or a CSV with one row per issue, for the page or the whole site.
- **AI brief.** A Markdown fix list to paste into Claude Code, Cursor or Copilot: every failing issue with where it is, the fix and a "done when" test. With an API key, "AI brief with code fixes written by Claude" reads the real page HTML and detected stack (Next.js, WordPress, Webflow, Shopify and more) and writes the exact code change per issue.

## AI visibility tracker

Open it from the start screen (**Open tracker**). It does what Profound, Otterly, Peec and the Semrush and Ahrefs AI trackers do, on your own API key.

- **Set up.** Enter your brand (and other names), domain, competitors and the prompts your buyers ask. **Suggest prompts with Claude** reads your homepage and writes 15 realistic prompts, mostly non-branded.
- **Run now.** Claude answers every prompt with live web search under a neutral system prompt that does not name your brand, so the answer is not biased. For each answer the tracker records whether your brand is mentioned, its position among the tracked brands, whether your site is cited, which competitors appear, and (with a cheap Haiku call) whether the answer is positive, neutral or negative about you.
- **Dashboard.** Mention rate, citation rate, share of voice, average position and sentiment; a table of you against each competitor; the domains AI cites most (yours in green, competitors in orange); a trend line across runs; and every prompt with the full answer, highlighted names and its sources. Prompts where a competitor shows up and you don't are listed first as gaps.
- **Real ChatGPT, Perplexity, Google AI Mode, Gemini and Copilot answers.** Each prompt has Ask ChatGPT, Ask Perplexity and Ask Google AI buttons that open the prompt in that app. When the panel sees an assistant tab, a **Capture this answer** card appears. It reads the answer and its source links from the page (or only what you selected), matches it to your prompt, and adds it to the dashboard with its own engine filter. This uses your own logged-in session, needs no API key, and avoids scraping those services from a server.
- **From gap to fix.** On a gap, **Scan cited competitor page** opens the page AI chose instead of yours in the AEO scorer, and **Scan my site** scores yours, so you can compare.
- **Scheduled re-runs.** Daily or weekly, in the background while Chrome is open. The toolbar badge shows the latest mention rate.
- **Exports.** Visibility report (HTML) and prompt results (CSV) from the download button.
- **Cost.** About $0.02–0.05 per prompt on Opus 5.5 at low effort (tokens plus $0.01 per web search), less on Sonnet or Haiku. Web search must be allowed for your organization in the Claude Console.

## Claude details

- Called from the panel with the official `@anthropic-ai/sdk`, streaming, structured JSON output, effort `low` by default.
- Models: Claude Opus 5.5 (default), Sonnet 5.5 or Haiku 5.5. About $0.04–0.07 per review on Opus 5.5 at low effort; under $0.01 on Haiku 5.5.
- The rubric is a frozen, cached system prompt, so repeat reviews read it from the prompt cache.
- Server-side refusal fallbacks (`fallbacks: "default"`) are on for Opus and Sonnet; if your account rejects that beta, the call retries once without it.
- The key is stored in `chrome.storage.local` and sent only to `api.anthropic.com`. Anyone with access to this Chrome profile can read it, so this mode is for you and your team. Before a public release, move calls behind a backend proxy (see the integration plan).

## Develop

```
npm install
npm run build      # bundles src/ into dist/
npm test           # builds, then runs test/e2e.cjs in Chromium (needs Playwright and test pages on :8765)
```

Serve the test pages first: `cd test/site && python3 -m http.server 8765`. The test loads the extension, scores a good and a bad page, checks highlights, the mark-fixed and reload re-check, and runs Ask Claude against a mocked API. `test/vis.cjs` covers the tracker: prompt suggestions, a run with web search and `pause_turn`, metrics, a capture from a fake ChatGPT page, exports and a scheduled run.

## Files

- `src/manifest.json` – Manifest V3, side panel, permissions
- `src/background.js` – opens the side panel from the toolbar icon and runs scheduled visibility checks
- `src/visibility.js` – visibility engine: Claude with web search, mention and citation analysis, metrics
- `src/capture.js` – reads answers and sources from ChatGPT, Perplexity, Google, Gemini and Copilot tabs
- `src/visui.js` – the tracker view, dashboard and exports
- `src/content.js` – page snapshot, axe-core runner and highlight overlay (injected on demand)
- `src/rules.js` – the scoring rules and accessibility grouping (pure functions)
- `src/crawler.js` – the site crawler
- `src/report.js` – HTML and CSV reports
- `src/claude.js` – the Claude prompt, output schema and API call
- `src/sidepanel.*` – the panel UI, re-scan on reload, saved fix state per URL

## Third-party code

`axe-core` 4.14 (Deque Systems, MPL-2.0) is bundled unmodified as `axe.min.js`.
