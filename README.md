# AEO Scorer (Chrome extension)

A Chrome side panel that scores a page or a whole site for Answer Engine Optimization (AEO), Generative Engine Optimization (GEO), schema and accessibility. It highlights the problems on the page, re-checks them after you fix them, and exports reports to share with your team. The rules follow "AEO & GEO: A Developer's Implementation Guide" (Nov 2026).

## Install (load unpacked)

1. Unzip `aeo-scorer-0.4.0.zip` (or run `npm install && npm run build` and use `dist/`).
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

Serve the test pages first: `cd test/site && python3 -m http.server 8765`. The test loads the extension, scores a good and a bad page, checks highlights, the mark-fixed and reload re-check, and runs Ask Claude against a mocked API.

## Files

- `src/manifest.json` – Manifest V3, side panel, permissions
- `src/background.js` – opens the side panel from the toolbar icon
- `src/content.js` – page snapshot, axe-core runner and highlight overlay (injected on demand)
- `src/rules.js` – the scoring rules and accessibility grouping (pure functions)
- `src/crawler.js` – the site crawler
- `src/report.js` – HTML and CSV reports
- `src/claude.js` – the Claude prompt, output schema and API call
- `src/sidepanel.*` – the panel UI, re-scan on reload, saved fix state per URL

## Third-party code

`axe-core` 4.14 (Deque Systems, MPL-2.0) is bundled unmodified as `axe.min.js`.
