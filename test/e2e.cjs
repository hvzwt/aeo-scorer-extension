// End-to-end check: loads the built extension in Chromium, scores two local
// pages, marks an issue fixed, fixes the page, reloads and checks the re-check,
// then runs "Ask Claude" against a mocked Anthropic API.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const DIST = path.resolve(__dirname, "../dist");
const SITE = path.resolve(__dirname, "site");
const OUT = path.resolve(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const review = {
  semantic_score: 42,
  primary_question: "How do you add schema markup in Next.js?",
  summary: "The page repeats its keyword instead of answering the question. Lead with the steps and add a source.",
  findings: [
    { title: "Opening paragraph does not answer the question", severity: "critical", category: "answer-first", ref: "p0", problem: "The first paragraph repeats \"schema markup Next.js\" without saying how to do it.", fix: "Replace it with a direct answer.", suggested_text: "To add schema markup in Next.js, render a <script type=\"application/ld+json\"> tag in the page component and fill it from the page's own data." },
  ],
  suggested_json_ld: "{\"@context\":\"https://schema.org\",\"@type\":\"TechArticle\",\"headline\":\"Schema markup Next.js\"}",
};

function sse() {
  const text = JSON.stringify(review);
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return (
    ev("message_start", { message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5200, output_tokens: 1, cache_read_input_tokens: 2100, cache_creation_input_tokens: 0 } } }) +
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(0, 80) } }) +
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(80) } }) +
    ev("content_block_stop", { index: 0 }) +
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 900 } }) +
    ev("message_stop", {})
  );
}

(async () => {
  const badPath = path.join(SITE, "bad.html");
  const badOriginal = fs.readFileSync(badPath, "utf8");
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    viewport: { width: 420, height: 1400 },
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  let apiRequest = null;
  await ctx.route("https://api.anthropic.com/**", async (route) => {
    apiRequest = { headers: route.request().headers(), body: JSON.parse(route.request().postData() || "{}"), url: route.request().url() };
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse() });
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker");
    const extId = sw.url().split("/")[2];

    const results = {};
    for (const [name, url] of [["good", "http://localhost:8765/guides/good.html"], ["bad", "http://localhost:8765/bad.html"]]) {
      const page = await ctx.newPage();
      await page.goto(url);
      const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, url);
      const panel = await ctx.newPage();
      await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`);
      await panel.waitForFunction(() => /^\d+$/.test(document.getElementById("score").textContent), null, { timeout: 15000 });
      const score = Number(await panel.textContent("#score"));
      const open = await panel.$$eval("#issues .issue .issue-title", (n) => n.map((x) => x.textContent));
      results[name] = { score, open, page, panel, tabId };
      await panel.screenshot({ path: path.join(OUT, `panel-${name}.png`), fullPage: true });
      console.log(`${name}: score ${score}, ${open.length} open issues`);
      for (const t of open) console.log("   -", t);
    }

    // highlight on page
    const bad = results.bad;
    await bad.panel.check("#toggle-highlight");
    await bad.page.waitForSelector("#__aeo-scorer-overlay > div", { timeout: 5000 });
    const boxes = await bad.page.$$eval("#__aeo-scorer-overlay > div", (n) => n.length);
    console.log(`highlight boxes drawn on bad page: ${boxes}`);
    await bad.page.screenshot({ path: path.join(OUT, "page-bad-highlighted.png") });

    // mark "html lang" fixed, fix the page, reload the tab
    const card = bad.panel.locator(".issue", { hasText: "<html lang> is set" });
    await card.locator(".btn-mark").click();
    await bad.panel.locator(".issue", { hasText: "Exactly one H1" }).locator(".btn-mark").click();
    fs.writeFileSync(badPath, badOriginal.replace("<html>", '<html lang="en">').replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="description" content="How to add JSON-LD structured data to a Next.js page, step by step, and how to validate it.">'));
    await bad.page.reload();
    await bad.panel.waitForSelector("#recheck:not([hidden])", { timeout: 15000 });
    const recheck = await bad.panel.textContent("#recheck");
    console.log("recheck banner:", recheck.replace(/\s+/g, " ").trim());
    await bad.panel.click('#tabs button[data-tab="marked"]');
    const marked = await bad.panel.$$eval("#issues .issue .issue-title", (n) => n.map((x) => x.textContent));
    console.log("still marked:", marked);
    await bad.panel.screenshot({ path: path.join(OUT, "panel-bad-recheck.png"), fullPage: true });
    await bad.panel.click('#tabs button[data-tab="open"]');

    // Ask Claude with a mocked API
    await bad.panel.click("#btn-settings");
    await bad.panel.fill("#set-key", "sk-ant-test-key");
    await bad.panel.click("#btn-save");
    await bad.panel.waitForSelector("#view-main:not([hidden])");
    await bad.panel.click("#btn-claude");
    await bad.panel.waitForSelector(".ai-score b", { timeout: 15000 });
    console.log("claude score:", await bad.panel.textContent(".ai-score b"));
    console.log("ai issue shown:", await bad.panel.locator(".issue.ai .issue-title").first().textContent());
    console.log("ai meta:", await bad.panel.textContent(".ai-meta"));
    console.log("api request:", {
      url: apiRequest?.url,
      model: apiRequest?.body.model,
      fallbacks: apiRequest?.body.fallbacks,
      beta: apiRequest?.headers["anthropic-beta"],
      effort: apiRequest?.body.output_config?.effort,
      format: apiRequest?.body.output_config?.format?.type,
      cache: apiRequest?.body.system?.[0]?.cache_control,
      browserHeader: apiRequest?.headers["anthropic-dangerous-direct-browser-access"],
      stream: apiRequest?.body.stream,
      userChars: apiRequest?.body.messages?.[0]?.content?.length,
    });
    await bad.panel.locator(".issue.ai .btn-show").first().click();
    await bad.panel.waitForTimeout(600);
    await bad.page.screenshot({ path: path.join(OUT, "page-bad-ai-focus.png") });
    await bad.panel.screenshot({ path: path.join(OUT, "panel-bad-claude.png"), fullPage: true });

    // accessibility + filters
    const p = bad.panel;
    console.log("a11y chip:", (await p.textContent("#a11y-chip")).replace(/\s+/g, " "));
    await p.click('#filters button[data-area="a11y"]');
    console.log("a11y issues:", await p.$$eval("#issues .issue .issue-title", (n) => n.map((x) => x.textContent)));
    await p.click('#filters button[data-area="schema"]');
    console.log("blockers:", await p.isVisible("#blockers") ? await p.textContent("#blockers") : "none", "| grade:", await p.textContent("#grade"));
    await p.click('#filters button[data-area="tech"]');
    console.log("technical issues:", await p.$$eval("#issues .issue .issue-title", (n) => n.map((x) => x.textContent)));
    await p.click('#tabs button[data-tab="passed"]');
    console.log("technical passed/info:", await p.$$eval("#issues .issue .issue-title", (n) => n.map((x) => x.textContent)));
    await p.click('#tabs button[data-tab="open"]');
    await p.click('#filters button[data-area="schema"]');
    console.log("schema & tag issues:", await p.$$eval("#issues .issue .issue-title", (n) => n.map((x) => x.textContent)));
    await p.click('#filters button[data-area="all"]');

    // page downloads
    const grab = async (fmt, name) => {
      await p.click("#btn-download");
      const [dl] = await Promise.all([p.waitForEvent("download"), p.click(`#download-menu button[data-format="${fmt}"]`)]);
      const file = path.join(OUT, name);
      await dl.saveAs(file);
      const txt = fs.readFileSync(file, "utf8");
      console.log(`download ${dl.suggestedFilename()}: ${txt.length} chars`);
      return txt;
    };
    const html = await grab("html", "page-report.html");
    console.log("  report has accessibility section:", html.includes("Accessibility ("), "claude section:", html.includes("Claude review"));
    const csv = await grab("csv", "page-issues.csv");
    console.log("  csv rows:", csv.trim().split(/\r\n/).length - 1, "| header:", csv.split(/\r\n/)[0].slice(1));

    // close -> home
    await p.click("#btn-close");
    await p.waitForSelector("#view-home:not([hidden])");
    console.log("home shown, recent reports:", await p.$$eval("#home-recent button", (n) => n.length));
    await p.screenshot({ path: path.join(OUT, "panel-home.png"), fullPage: true });

    // crawl the site
    await p.selectOption("#crawl-max", "10");
    await p.fill("#home-url", "http://localhost:8765/");
    await p.click("#btn-crawl-url");
    await p.waitForSelector("#crawl-progress:not([hidden])");
    await p.screenshot({ path: path.join(OUT, "panel-crawling.png") });
    await p.waitForSelector("#site-summary:not([hidden])", { timeout: 120000 });
    console.log("site meta:", await p.textContent("#site-meta"));
    await p.click('#site-filters button[data-area="tech"]');
    console.log("site technical issues:", await p.$$eval("#site-issue-list .issue .issue-title", (n) => n.map((x) => x.textContent)));
    await p.click('#site-filters button[data-area="schema"]');
    console.log("site schema & tag issues:", await p.$$eval("#site-issue-list .issue .issue-title", (n) => n.map((x) => x.textContent)));
    await p.click('#site-filters button[data-area="all"]');
    console.log("site scores:", await p.textContent("#site-score"), await p.textContent("#site-a11y"), await p.textContent("#site-issues"));
    console.log("site pages:", await p.$$eval("#site-pages button", (n) => n.map((b) => b.innerText.replace(/\s+/g, " "))));
    console.log("site issues (top 12):", await p.$$eval("#site-issue-list .issue", (n) => n.slice(0, 12).map((x) => x.querySelector(".issue-title").textContent + " | " + x.querySelector(".issue-detail").textContent.slice(0, 40))));
    await p.screenshot({ path: path.join(OUT, "panel-site.png"), fullPage: true });
    const shtml = await grab("html", "site-report.html");
    const scsv = await grab("csv", "site-issues.csv");
    console.log("  site csv rows:", scsv.trim().split(/\r\n/).length - 1);

    // open a page from the site report, then go back
    await p.locator("#site-pages button").first().click();
    await p.waitForSelector("#view-main:not([hidden]) #summary:not([hidden])");
    console.log("stored page view:", await p.textContent("#page-title"), "score", await p.textContent("#score"), "back visible:", await p.isVisible("#btn-back-site"));
    await p.screenshot({ path: path.join(OUT, "panel-site-page.png"), fullPage: true });
    await p.click("#btn-back-site");
    await p.waitForSelector("#view-site:not([hidden])");
    const tabsLeft = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url));
    console.log("tabs after crawl:", tabsLeft);
  } finally {
    fs.writeFileSync(badPath, badOriginal);
    await ctx.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
