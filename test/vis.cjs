// End-to-end check of the AI visibility tracker with a mocked Anthropic API
// and a fake ChatGPT page.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const DIST = path.resolve(__dirname, "../dist");
const OUT = path.resolve(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const usage = { input_tokens: 3000, output_tokens: 400, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 1 } };
const msg = (content, stop_reason = "end_turn", model = "claude-opus-5-5") => ({ id: "msg_t", type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null, usage });
const searchResult = (urls) => ({ type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: urls.map((url) => ({ type: "web_search_result", url, title: url, encrypted_content: "x", page_age: null })) });
const cite = (url, title) => ({ type: "web_search_result_location", url, title, cited_text: "…", encrypted_index: "x" });

const calls = { search: 0, pauses: 0, sentiment: 0, suggest: 0, continued: false };
function answer(body) {
  const prompt = body.messages[0].content;
  if (/best analytics/i.test(prompt)) {
    if (body.messages.length === 1) {
      calls.pauses++;
      return msg([{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "best analytics tool" } }, searchResult(["https://acme.test/features", "https://globex.com/"])], "pause_turn");
    }
    calls.continued = body.messages.length === 2 && body.messages[1].role === "assistant";
    return msg([
      { type: "text", text: "The most popular options are Globex, which suits larger teams, and " },
      { type: "text", text: "Acme Analytics, which is easiest for small stores.", citations: [cite("https://acme.test/features", "Acme features")] },
      { type: "text", text: " Reviewers on G2 rate both highly.", citations: [cite("https://www.g2.com/categories/analytics", "G2")] },
    ]);
  }
  return msg([
    { type: "text", text: "Globex is the standard choice for ecommerce reporting.", citations: [cite("https://globex.com/ecommerce", "Globex ecommerce")] },
    { type: "text", text: " See also this comparison.", citations: [cite("https://www.g2.com/compare", "G2 compare")] },
  ]);
}

const CHATGPT = `<!doctype html><html><head><title>ChatGPT</title></head><body><main>
<div data-message-author-role="user">How do I track ecommerce conversions?</div>
<div data-message-author-role="assistant"><p>You can use <b>Acme Analytics</b> or Initech. Acme has a free plan.</p><p>Sources: <a href="https://acme.test/pricing">acme.test</a> <a href="https://initech.io/">Initech</a></p></div>
</main></body></html>`;

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
    let out;
    if (body.tools?.some((t) => t.name === "web_search")) {
      calls.search++;
      out = answer(body);
    } else if (body.output_config?.format?.schema?.properties?.prompts) {
      calls.suggest++;
      out = msg([{ type: "text", text: JSON.stringify({ prompts: [{ text: "What is the best analytics tool for small online stores?", intent: "recommendation" }, { text: "Which tool shows ecommerce revenue by channel?", intent: "informational" }, { text: "How do I track ecommerce conversions?", intent: "how-to" }] }) }]);
    } else if (body.output_config?.format?.schema?.properties?.sentiment) {
      calls.sentiment++;
      out = msg([{ type: "text", text: JSON.stringify({ sentiment: "positive", reason: "Recommended as the easiest option for small stores." }) }], "end_turn", "claude-haiku-5-5");
    } else out = msg([{ type: "text", text: "?" }]);
    await route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out) });
  });
  await ctx.route("https://acme.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><head><title>Acme Analytics: simple analytics for online stores</title></head><body><h1>Analytics for small online stores</h1><p>Revenue by channel, conversions and cohorts in one dashboard.</p></body></html>" }));
  await ctx.route("https://chatgpt.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: CHATGPT }));

  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker");
    const extId = sw.url().split("/")[2];
    await sw.evaluate(() => chrome.storage.local.set({ settings: { apiKey: "sk-ant-test", model: "claude-opus-5-5", effort: "low", a11y: true } }));

    const site = await ctx.newPage();
    await site.goto("http://localhost:8765/");
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8765/*" }))[0].id);
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`);
    await p.waitForSelector("#view-home:not([hidden]), #view-main:not([hidden])");
    await p.click("#btn-close").catch(() => {});
    await p.click("#btn-open-vis");
    await p.waitForSelector("#vis-setup:not([hidden])");
    console.log("setup prefilled domain:", await p.inputValue("#vis-domain"));
    await p.fill("#vis-brand", "Acme Analytics");
    await p.fill("#vis-aliases", "Acme");
    await p.fill("#vis-domain", "https://www.acme.test/");
    await p.fill("#vis-competitors", "Globex, globex.com\nInitech, initech.io");
    await p.click("#btn-vis-suggest");
    await p.waitForFunction(() => /Added \d+ prompts/.test(document.getElementById("vis-setup-status").textContent), null, { timeout: 10000 });
    console.log("suggest:", await p.textContent("#vis-setup-status"), "| user msg has site text:", /Revenue by channel/.test(requests.at(-1).messages[0].content));
    await p.selectOption("#vis-schedule", "weekly");
    await p.screenshot({ path: path.join(OUT, "vis-setup.png"), fullPage: true });
    await p.click("#btn-vis-save");
    await p.waitForSelector("#vis-dash:not([hidden])");
    const alarm = await sw.evaluate(() => chrome.alarms.get("vis-run"));
    console.log("alarm:", alarm && { period: alarm.periodInMinutes });
    const project = await sw.evaluate(async () => (await chrome.storage.local.get("vis:project"))["vis:project"]);
    console.log("project:", project.brand, project.domain, project.competitors, project.prompts.length, "prompts");

    await p.click("#btn-vis-run");
    await p.waitForSelector("#vis-progress:not([hidden])");
    await p.waitForSelector("#vis-progress[hidden]", { state: "attached", timeout: 30000 });
    const t = async (id) => (await p.textContent(id)).trim();
    console.log("tiles: mentioned", await t("#vis-mention"), "cited", await t("#vis-cite"), "sov", await t("#vis-sov"), "pos", await t("#vis-pos"));
    console.log("sentiment line:", await t("#vis-sentiment"));
    console.log("meta:", await t("#vis-meta"));
    console.log("calls:", calls);
    const ws = requests.find((r) => r.tools);
    console.log("search request:", { model: ws.model, tool: ws.tools[0], system: ws.system.slice(0, 50), mentionsBrand: /acme/i.test(JSON.stringify(ws.system) + ws.messages[0].content) });
    console.log("table:", await p.$$eval("#vis-table tr", (r) => r.map((x) => x.innerText.replace(/\s+/g, " "))));
    console.log("domains:", await p.$$eval("#vis-domains .d", (r) => r.map((x) => x.innerText.replace(/\s+/g, " "))));
    console.log("prompts:", await p.$$eval("#vis-prompts-list .issue", (r) => r.map((x) => x.querySelector(".sev").textContent + " | " + x.querySelector(".issue-title").textContent + " | " + x.querySelector(".eng-results").innerText.replace(/\s+/g, " "))));
    console.log("gap buttons:", await p.$$eval("#vis-prompts-list .issue.gap button", (b) => b.map((x) => x.textContent)));
    await p.locator("#vis-prompts-list .issue.won details summary").first().click();
    console.log("marks in answer:", await p.$$eval("#vis-prompts-list .issue.won .answer mark", (m) => m.map((x) => x.className + ":" + x.textContent)));
    await p.screenshot({ path: path.join(OUT, "vis-dashboard.png"), fullPage: true });

    // a second run so the trend shows
    await p.click("#btn-vis-run");
    await p.waitForSelector("#vis-progress[hidden]", { state: "attached", timeout: 30000 });
    console.log("trend drawn:", await p.isVisible("#vis-trend svg"), "runs stored:", await sw.evaluate(async () => (await chrome.storage.local.get("vis:runs"))["vis:runs"].length));

    // capture from a ChatGPT tab
    const gpt = await ctx.newPage();
    await gpt.goto("https://chatgpt.com/c/123");
    const gptTab = await sw.evaluate(async () => (await chrome.tabs.query({ url: "https://chatgpt.com/*" }))[0].id);
    const p2 = await ctx.newPage();
    await p2.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${gptTab}&view=vis`);
    await p2.waitForSelector("#vis-capture:not([hidden])");
    console.log("capture card:", await p2.textContent("#cap-title"));
    await p2.click("#btn-capture");
    await p2.waitForFunction(() => document.getElementById("cap-status").textContent.length > 0);
    console.log("capture status:", await p2.textContent("#cap-status"));
    console.log("engine filters:", await p2.$$eval("#vis-engines button", (b) => b.map((x) => x.textContent)));
    await p2.click('#vis-engines button:has-text("ChatGPT")');
    console.log("chatgpt tiles: mentioned", (await p2.textContent("#vis-mention")).trim(), "cited", (await p2.textContent("#vis-cite")).trim());
    await p2.click('#vis-engines button:has-text("All engines")');
    await p2.screenshot({ path: path.join(OUT, "vis-capture.png"), fullPage: true });

    // downloads
    const grab = async (fmt, name) => {
      await p2.click("#btn-download");
      const visible = await p2.$$eval("#download-menu button", (b) => b.filter((x) => !x.hidden).map((x) => x.dataset.format));
      const [dl] = await Promise.all([p2.waitForEvent("download"), p2.click(`#download-menu button[data-format="${fmt}"]`)]);
      const file = path.join(OUT, name);
      await dl.saveAs(file);
      console.log(`download ${dl.suggestedFilename()} (menu: ${visible}): ${fs.statSync(file).size} bytes`);
      return fs.readFileSync(file, "utf8");
    };
    const csv = await grab("vis-csv", "vis.csv");
    console.log(csv.split("\n").slice(0, 3).join("\n"));
    const html = await grab("vis-html", "vis.html");
    console.log("html has trend:", html.includes("Trend (Claude runs)"), "competitor table:", html.includes("You vs competitors"));

    // "Ask ChatGPT" opens a tab with the prompt
    const [newTab] = await Promise.all([ctx.waitForEvent("page"), p2.locator('#vis-prompts-list button:has-text("Ask ChatGPT")').first().click()]);
    await newTab.waitForLoadState().catch(() => {});
    console.log("ask link:", await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.pendingUrl || t.url)));

    // scheduled run via the background alarm handler
    const before = requests.length;
    await sw.evaluate(() => chrome.alarms.create("vis-run", { when: Date.now() + 100 }));
    for (let i = 0; i < 40 && (await sw.evaluate(async () => (await chrome.storage.local.get("vis:runs"))["vis:runs"].length)) < 3; i++) await new Promise((r) => setTimeout(r, 250));
    const runs = await sw.evaluate(async () => (await chrome.storage.local.get("vis:runs"))["vis:runs"]);
    console.log("scheduled run:", runs.length, "runs, last scheduled:", runs.at(-1).scheduled, "api calls:", requests.length - before, "badge:", await sw.evaluate(() => chrome.action.getBadgeText({})));
  } finally {
    await ctx.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
