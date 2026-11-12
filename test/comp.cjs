// End-to-end check of competitor analysis with a mocked Anthropic API and
// three fake sites served through request routing.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const DIST = path.resolve(__dirname, "../dist");
const SITE = path.resolve(__dirname, "site");
const OUT = path.resolve(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const usage = { input_tokens: 3000, output_tokens: 400, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 1 } };
const msg = (content) => ({ id: "msg_t", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: "end_turn", stop_sequence: null, usage });
const cite = (url, title) => ({ type: "web_search_result_location", url, title, cited_text: "…", encrypted_index: "x" });
const why = {
  summary: "Globex and Initech answer the question in the first paragraph and back it with FAQ schema and sources; your page buries the answer.",
  reasons: [
    { title: "They answer the question immediately", evidence: "Both competitors open with a direct answer; your first paragraph repeats the keyword.", competitors: ["globex.com", "initech.io"], impact: "high" },
    { title: "FAQ schema and visible FAQs", evidence: "2 of 2 competitors have FAQPage markup.", competitors: ["globex.com"], impact: "medium" },
  ],
  plan: [
    { action: "Rewrite the opening paragraph as a direct answer", detail: "Two sentences that answer the H1 question.", effort: "small" },
    { action: "Add an FAQ section with FAQPage JSON-LD", detail: "Five questions from the prompts you track.", effort: "medium" },
  ],
};

const good = fs.readFileSync(path.join(SITE, "guides/good.html"), "utf8");
const bad = fs.readFileSync(path.join(SITE, "bad.html"), "utf8");

(async () => {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    viewport: { width: 420, height: 1400 },
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  const requests = [];
  await ctx.route("https://api.anthropic.com/**", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    requests.push(body);
    if (body.tools?.some((t) => t.name === "web_search")) {
      const out = msg([
        { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://www.youtube.com/watch?v=1", title: "video" }, { type: "web_search_result", url: "https://globex.com/guide", title: "Globex guide" }] },
        { type: "text", text: "Globex explains it best,", citations: [cite("https://globex.com/guide", "Globex guide")] },
        { type: "text", text: " and Initech has a good checklist.", citations: [cite("https://initech.io/best", "Initech checklist")] },
      ]);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(out) });
    }
    const text = JSON.stringify(why);
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const sse =
      ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6000, output_tokens: 1 } } }) +
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
      ev("content_block_stop", { index: 0 }) +
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 700 } }) +
      ev("message_stop", {});
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
  });
  const html = (body) => ({ status: 200, contentType: "text/html", body });
  const notFound = { status: 404, contentType: "text/plain", body: "not found" };
  await ctx.route(/https:\/\/(acme\.test|globex\.com|initech\.io)\/.*/, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/analytics") return route.fulfill(html(bad));
    if (u.pathname === "/guide") return route.fulfill(html(good));
    if (u.pathname === "/best") return route.fulfill(html(good.replace(/FAQPage/g, "HowTo")));
    if (u.pathname === "/robots.txt") return route.fulfill({ status: 200, contentType: "text/plain", body: "User-agent: *\nAllow: /\n" });
    return route.fulfill(notFound);
  });

  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker");
    const extId = sw.url().split("/")[2];
    await sw.evaluate(() => chrome.storage.local.set({ settings: { apiKey: "sk-ant-test", model: "claude-opus-5-5", effort: "low", a11y: true } }));
    const mine = await ctx.newPage();
    await mine.goto("https://acme.test/analytics");
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "https://acme.test/*" }))[0].id);

    // start from the page report, like a user would
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`);
    await p.waitForFunction(() => /^\d+$/.test(document.getElementById("score").textContent), null, { timeout: 20000 });
    await p.click("#btn-compare-page");
    await p.waitForSelector("#comp-setup:not([hidden])");
    console.log("prefill:", await p.inputValue("#comp-url"), "|", await p.inputValue("#comp-questions"), "| ai:", await p.isChecked("#comp-ai"));
    await p.fill("#comp-questions", "How do I add schema markup in Next.js?\nWhat is the best way to add JSON-LD to a React site?");
    await p.screenshot({ path: path.join(OUT, "comp-setup.png"), fullPage: true });
    await p.click("#btn-comp-run");
    await p.waitForSelector("#comp-report:not([hidden])", { timeout: 90000 });
    const t = async (id) => (await p.textContent(id)).trim();
    console.log("tiles: you", await t("#comp-you"), "median", await t("#comp-median"), (await t("#comp-cited-label")), await t("#comp-cited"));
    console.log("meta:", await t("#comp-meta"));
    console.log("verdict:", await t("#comp-verdict"));
    console.log("ranking:", await p.$$eval("#comp-rank button", (b) => b.map((x) => x.innerText.replace(/\s+/g, " "))));
    console.log("reasons:", await p.$$eval("#comp-reasons .issue", (n) => n.slice(0, 8).map((x) => x.querySelector(".issue-title").textContent + " | " + x.querySelector(".issue-detail").textContent)));
    console.log("schema gaps:", await t("#comp-schema"));
    console.log("facts:", await p.$$eval("#comp-facts tr", (r) => r.map((x) => x.innerText.replace(/\s+/g, " ") + (x.querySelector(".behind") ? " ← behind" : ""))));
    console.log("cats:", await p.$$eval("#comp-cats .cmp-cat", (r) => r.map((x) => x.innerText.replace(/\s+/g, " "))));
    console.log("api calls:", requests.length, "search tool:", requests[0].tools[0].type);
    await p.click("#btn-comp-why");
    await p.waitForSelector("#comp-why .why-list", { timeout: 15000 });
    console.log("why:", (await t("#comp-why")).slice(0, 300));
    const whyReq = requests.at(-1);
    console.log("why request: format", whyReq.output_config?.format?.type, "| input has rule gaps:", /<rule_gaps>/.test(whyReq.messages[0].content), "| chars", whyReq.messages[0].content.length);
    await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(OUT, "comp-report.png"), fullPage: true });

    const grab = async (fmt, name) => {
      await p.click("#btn-download");
      const menu = await p.$$eval("#download-menu button", (b) => b.filter((x) => !x.hidden).map((x) => x.dataset.format));
      const [dl] = await Promise.all([p.waitForEvent("download"), p.click(`#download-menu button[data-format="${fmt}"]`)]);
      const file = path.join(OUT, name);
      await dl.saveAs(file);
      console.log(`download ${dl.suggestedFilename()} (menu ${menu}): ${fs.statSync(file).size} bytes`);
      return fs.readFileSync(file, "utf8");
    };
    const csv = await grab("comp-csv", "comp.csv");
    console.log(csv.split("\r\n").slice(0, 2).join("\n"));
    const rep = await grab("comp-html", "comp.html");
    console.log("html has action plan:", rep.includes("Action plan"), "ranking:", rep.includes("<h2>Ranking</h2>"));

    // open a competitor's stored report from the ranking
    await p.locator("#comp-rank").screenshot({ path: path.join(OUT, "comp-rank.png") });
    await p.locator("#comp-rank button", { hasText: "globex.com" }).click();
    await p.waitForSelector("#view-main:not([hidden]) #summary:not([hidden])");
    console.log("competitor report opened:", await t("#page-host"), "score", await t("#score"));
    await p.click("#btn-close");
    await p.waitForSelector("#view-home:not([hidden])");
    // saved report reopens for the same site
    await p.click("#btn-open-comp");
    await p.waitForSelector("#comp-report:not([hidden])");
    console.log("saved report reopened:", await t("#comp-name"));
    console.log("tabs left:", await sw.evaluate(async () => (await chrome.tabs.query({})).length));
  } finally {
    await ctx.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
