import { scorePage, diffRuns, hashKey, CATEGORIES, AREAS, A11Y_GROUPS, areaOf, scoreAccessibility, siteWideChecks } from "./rules.js";
import { MODELS, askClaude, estimateCost, describeError, streamText, BRIEF_SYSTEM, buildBriefInput } from "./claude.js";
import { crawlSite, normalizeUrl } from "./crawler.js";
import { fetchInfo, originTech, pageSpeed } from "./tech.js";
import { initComp, showComp, compDownload, renderReport as renderComp } from "./compui.js";
import { initVis, showVis, refreshCapture, visDownload } from "./visui.js";
import { pageReportHtml, siteReportHtml, siteIssues, issuesCsv, download, slug, briefMarkdown, siteBriefMarkdown } from "./report.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const FIXED_TAB = params.get("tabId") ? Number(params.get("tabId")) : null; // used by tests

const state = {
  mode: "home", // home | page | site | vis | comp
  settingsOpen: false,
  page: null, // { tabId, url, snap, result, a11y, run, live, fromSite }
  site: null, // stored site report
  crawlAbort: null,
  tab: "open",
  area: "all",
  category: null,
  siteArea: "all",
  highlight: false,
  scanning: false,
  claudeAbort: null,
  settings: { apiKey: "", model: MODELS[0].id, effort: "low", a11y: true, speed: true },
};

// ---------------------------------------------------------------- storage

const keyFor = (url) => `run:${normalizeUrl(url, true) || url}`;
const siteKey = (origin) => `site:${origin}`;

async function loadRun(url) {
  const k = keyFor(url);
  const got = await chrome.storage.local.get(k);
  return got[k] || { marked: {}, aiMarked: {}, checks: null, ai: null };
}
const saveRun = (url, run) => chrome.storage.local.set({ [keyFor(url)]: run });

async function loadSettings() {
  const got = await chrome.storage.local.get(["settings", "highlight"]);
  state.settings = { ...state.settings, ...(got.settings || {}) };
  state.highlight = !!got.highlight;
}

// ---------------------------------------------------------------- site data

const siteCache = new Map(); // origin -> { at, robots, llmsTxt }

const fetchText = (url) => fetchInfo(url);

async function originData(origin) {
  let cached = siteCache.get(origin);
  if (!cached || Date.now() - cached.at > 5 * 60_000) {
    const [robots, llms, tech] = await Promise.all([fetchText(`${origin}/robots.txt`), fetchText(`${origin}/llms.txt`), originTech(origin)]);
    const robotsOk = robots && robots.status === 200 && !/text\/html/.test(robots.contentType);
    cached = {
      at: Date.now(),
      robots: robotsOk ? robots : robots && { status: robots.status === 200 ? 404 : robots.status, text: "" },
      llmsTxt: llms ? llms.status === 200 && !/text\/html/.test(llms.contentType) : null,
      llmsText: llms && llms.status === 200 && !/text\/html/.test(llms.contentType) ? String(llms.text || "").slice(0, 20000) : null,
      tech,
    };
    siteCache.set(origin, cached);
  }
  return cached;
}

async function siteData(url) {
  const o = await originData(new URL(url).origin);
  const rawHtml = await fetchText(url); // the server response, without running JavaScript
  return { robots: o.robots, llmsTxt: o.llmsTxt, llmsText: o.llmsText, rawHtml, tech: o.tech };
}

// ---------------------------------------------------------------- page bridge

async function send(tabId, msg) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, msg);
    if (res !== undefined) return res;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  return chrome.tabs.sendMessage(tabId, msg);
}

async function runAxe(tabId) {
  let res = await send(tabId, { type: "aeo:axe" });
  if (!res?.ok && /not loaded/.test(res?.error || "")) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["axe.min.js"] });
    res = await send(tabId, { type: "aeo:axe" });
  }
  return res;
}

function scannable(url) {
  return /^https?:\/\//.test(url || "") && !/^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/.test(url);
}

/** Snapshot + rules + accessibility for one tab. */
async function analyzeTab(tabId, url) {
  const [snapRes, site] = await Promise.all([send(tabId, { type: "aeo:snapshot" }), siteData(url)]);
  if (!snapRes?.ok) throw new Error(snapRes?.error || "Could not read the page.");
  const snap = snapRes.snapshot;
  const result = scorePage(snap, site);
  let a11y = null;
  if (state.settings.a11y) {
    try {
      a11y = scoreAccessibility(await runAxe(tabId));
    } catch {
      a11y = null;
    }
  }
  return { snap, result, a11y, site, httpStatus: site.rawHtml?.status ?? null };
}

/** Analyze a page in a tab and save it as a stored page report. */
async function analyzePage(tabId, url) {
  const out = await analyzeTab(tabId, url);
  if (out.httpStatus >= 400) return out;
  const { snap, result, a11y } = out;
  const run = await loadRun(snap.url);
  const checks = allChecks(result, a11y);
  Object.assign(run, { url: snap.url, title: snap.title, host: snap.host, stack: snap.stack, checks: checks.map(({ id, pass, severity, title, category }) => ({ id, pass, severity, title, category })), score: result.score, a11yScore: a11y?.score ?? null, result, a11y, at: Date.now() });
  await saveRun(snap.url, run);
  return out;
}

const allChecks = (result, a11y) => [...result.checks, ...(a11y?.checks || [])];
const compact = ({ items, ...c }) => c;

// ---------------------------------------------------------------- views

function setMode(mode) {
  if (state.mode !== mode) window.scrollTo(0, 0);
  state.mode = mode;
  $("view-home").hidden = mode !== "home" || state.settingsOpen;
  $("view-main").hidden = mode !== "page" || state.settingsOpen;
  $("view-site").hidden = mode !== "site" || state.settingsOpen;
  $("view-vis").hidden = mode !== "vis" || state.settingsOpen;
  $("view-comp").hidden = mode !== "comp" || state.settingsOpen;
  $("view-settings").hidden = !state.settingsOpen;
  $("btn-rescan").hidden = !(mode === "page" && state.page?.live) && mode !== "site";
  $("btn-rescan").title = mode === "site" ? "Crawl the site again" : "Re-scan this page";
  $("btn-download").hidden = !((mode === "page" && state.page?.result) || (mode === "site" && state.site?.pages?.length) || mode === "vis" || (mode === "comp" && !$("comp-report").hidden));
  $("btn-close").hidden = mode === "home";
  $("download-menu").hidden = true;
  $("mainnav").hidden = state.settingsOpen;
  for (const b of document.querySelectorAll("#mainnav button")) {
    if (b.dataset.go === mode) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
}

async function currentTab() {
  if (FIXED_TAB) return chrome.tabs.get(FIXED_TAB);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// ---------------------------------------------------------------- home

async function showHome() {
  clearHighlights();
  state.page = null;
  setMode("home");
  const tab = await currentTab();
  $("home-current").textContent = tab?.url || "No tab";
  $("btn-scan-tab").disabled = $("btn-crawl-tab").disabled = !scannable(tab?.url);
  renderRecent();
}

async function renderRecent() {
  const all = await chrome.storage.local.get(null);
  const items = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("site:") && v?.finishedAt) items.push({ kind: "site", at: v.finishedAt, title: `Site: ${v.origin}`, sub: `${v.pages.filter((p) => !p.error).length} pages crawled`, score: v.avgScore, key: k });
    else if (k.startsWith("run:") && v?.result) items.push({ kind: "page", at: v.at, title: v.title || v.url, sub: v.url, score: v.score, url: v.url });
  }
  items.sort((a, b) => b.at - a.at);
  const box = $("home-recent");
  if (!items.length) {
    box.replaceChildren(Object.assign(document.createElement("p"), { className: "muted small", textContent: "No saved reports yet." }));
    return;
  }
  box.replaceChildren(
    ...items.slice(0, 8).map((it) => {
      const b = document.createElement("button");
      b.innerHTML = `<span class="r-title"></span><span class="r-sub"></span><span class="r-score"></span>`;
      b.querySelector(".r-title").textContent = it.title;
      b.querySelector(".r-sub").textContent = `${it.sub} · ${new Date(it.at).toLocaleString()}`;
      b.querySelector(".r-score").textContent = it.score ?? "–";
      b.querySelector(".r-score").style.color = colorFor(it.score ?? 0);
      b.onclick = async () => {
        if (it.kind === "site") {
          const got = await chrome.storage.local.get(it.key);
          state.site = got[it.key];
          renderSite();
        } else openStoredPage(it.url, false);
      };
      return b;
    }),
  );
}

// ---------------------------------------------------------------- page scan

async function scanPage({ reason = "manual" } = {}) {
  if (state.scanning) return;
  const tab = await currentTab();
  if (!tab) return;
  state.page = { ...(state.page?.live && state.page.tabId === tab.id ? state.page : {}), tabId: tab.id, live: true, fromSite: false };
  setMode("page");
  if (!scannable(tab.url)) {
    showState("Open a web page (http or https) to score it. Chrome pages and the Web Store cannot be scanned.");
    return;
  }
  state.scanning = true;
  $("btn-rescan").classList.add("spin");
  if (!state.page.result || state.page.url !== tab.url) showState("Scanning page…");
  try {
    const { snap, result: firstResult, a11y, site } = await analyzeTab(tab.id, tab.url);
    let result = firstResult;
    const prevRun = await loadRun(snap.url);
    const cachedPsi = freshPsi(prevRun.psi, snap.url);
    if (cachedPsi) result = scorePage(snap, { ...site, psi: cachedPsi });
    const run = await loadRun(snap.url);
    const sameUrl = state.page.url === snap.url;
    const checks = allChecks(result, a11y);

    // Re-check: compare with the last scan of this URL.
    const diff = run.checks ? diffRuns(run.checks, checks, run.marked) : null;
    for (const v of diff?.verified || []) delete run.marked[v.id];
    const prevScore = run.score;
    Object.assign(run, {
      url: snap.url,
      title: snap.title,
      host: snap.host,
      stack: snap.stack,
      checks: checks.map(({ id, pass, severity, title, category }) => ({ id, pass, severity, title, category })),
      score: result.score,
      a11yScore: a11y?.score ?? null,
      result,
      a11y,
      at: Date.now(),
    });
    await saveRun(snap.url, run);

    if (cachedPsi) run.psi = cachedPsi;
    Object.assign(state.page, { url: snap.url, snap, result, a11y, run, site, psiPending: false });
    renderPage();
    if (!cachedPsi) measureSpeed(state.page);
    renderRecheck(diff, prevScore, sameUrl || reason === "reload");
    if (state.highlight) highlightAll();
  } catch (e) {
    showState(`Could not scan this page: ${e.message || e}`);
  } finally {
    state.scanning = false;
    $("btn-rescan").classList.remove("spin");
  }
}

async function openStoredPage(url, fromSite) {
  const run = await loadRun(url);
  if (!run.result) {
    flash("No saved details for this page. Open it and scan it.");
    return;
  }
  clearHighlights();
  state.page = { url: run.url || url, snap: null, result: run.result, a11y: run.a11y, run, live: false, fromSite };
  state.tab = "open";
  setMode("page");
  window.scrollTo(0, 0);
  renderPage();
  $("recheck").hidden = true;
}

async function openAndScan(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  showState("Opening page…");
  setMode("page");
  await new Promise((resolve) => {
    const l = (id, info) => {
      if (id === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(l);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(l);
    setTimeout(resolve, 25000);
  });
  state.page = null;
  await scanPage({ reason: "open" });
}

function showState(msg) {
  $("state-msg").hidden = false;
  $("state-msg").textContent = msg;
  for (const id of ["summary", "recheck", "blockers", "categories", "a11y-groups", "claude", "tabs", "filters", "page-back"]) $(id).hidden = true;
  $("issues").replaceChildren();
}

// ---------------------------------------------------------------- speed

const PSI_TTL = 6 * 3600_000;
const freshPsi = (psi, url) => (psi && !psi.error && psi.url === url && Date.now() - psi.at < PSI_TTL ? psi : null);
function publicUrl(url) {
  try {
    const h = new URL(url).hostname;
    return !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)|\.(test|local|localhost|internal)$/.test(h);
  } catch {
    return false;
  }
}

/** Core Web Vitals from PageSpeed Insights; re-scores the page when they arrive. */
async function measureSpeed(page) {
  if (state.settings.speed === false || !publicUrl(page.url)) return;
  page.psiPending = true;
  if (state.page === page) renderGlance();
  const psi = await pageSpeed(page.url);
  psi.url = page.url;
  page.psiPending = false;
  page.run.psi = psi;
  if (!psi.error) {
    page.result = scorePage(page.snap, { ...page.site, psi });
    const checks = allChecks(page.result, page.a11y);
    Object.assign(page.run, { result: page.result, score: page.result.score, checks: checks.map(({ id, pass, severity, title, category }) => ({ id, pass, severity, title, category })) });
  }
  await saveRun(page.url, page.run);
  if (state.page === page && state.mode === "page") renderPage();
}

// ---------------------------------------------------------------- page rendering

function colorFor(score) {
  const css = getComputedStyle(document.documentElement);
  if (score >= 75) return css.getPropertyValue("--good");
  if (score >= 55) return css.getPropertyValue("--minor");
  return css.getPropertyValue("--critical");
}

function renderPage() {
  const { result, a11y, run, live, fromSite } = state.page;
  setMode("page");
  $("state-msg").hidden = true;
  for (const id of ["summary", "categories", "claude", "tabs", "filters"]) $(id).hidden = false;
  $("page-back").hidden = !fromSite;
  $("toggle-wrap").hidden = !live;
  $("btn-open-live").hidden = live;

  $("score").textContent = result.score;
  $("grade").textContent = `Grade ${result.grade.split(" · ")[0]}`;
  $("grade").title = result.grade;
  $("blockers").hidden = !result.blockers?.length;
  if (result.blockers?.length) {
    $("blockers").innerHTML = `<b></b><span></span><ul></ul>`;
    $("blockers").querySelector("b").textContent = `${result.blockers.length} blocker${result.blockers.length > 1 ? "s" : ""}: AI engines can't use this page yet`;
    $("blockers").querySelector("span").textContent = `The score is capped at 59 (it would be ${result.rawScore}) until you fix:`;
    $("blockers").querySelector("ul").replaceChildren(...result.blockers.map(li));
  }
  const fg = $("ring-fg");
  fg.style.strokeDashoffset = String(326.7 * (1 - result.score / 100));
  fg.style.stroke = colorFor(result.score);
  let host = "";
  try {
    host = new URL(state.page.url).hostname;
  } catch {}
  $("page-host").textContent = host;
  $("page-title").textContent = run.title || state.page.url;
  $("page-title").title = state.page.url;
  $("scanned-at").textContent = `${live ? "Scanned" : "Saved scan from"} ${new Date(run.at).toLocaleString()}`;
  const chip = $("a11y-chip");
  chip.hidden = true; // shown in the at-a-glance tiles
  if (a11y) {
    chip.innerHTML = `Accessibility <b></b><span class="muted">/100 · <span></span></span>`;
    chip.querySelector("b").textContent = a11y.score;
    chip.querySelector("b").style.color = colorFor(a11y.score);
    chip.querySelector("span span").textContent = `${a11y.checks.length} rule${a11y.checks.length === 1 ? "" : "s"} failing`;
  } else chip.textContent = state.settings.a11y ? "Accessibility: not available on this page" : "";

  $("categories").replaceChildren(
    ...Object.entries(result.categories).map(([key, c]) => {
      const row = document.createElement("button");
      row.className = "cat";
      row.title = `Show only ${c.label} issues`;
      row.setAttribute("aria-pressed", String(state.category === key));
      row.onclick = () => setCategory(state.category === key ? null : key);
      row.innerHTML = `<span class="cat-label"></span><span class="cat-score"></span><div class="bar"><span></span></div>`;
      row.querySelector(".cat-label").textContent = `${c.label} · ${c.passed}/${c.total}`;
      row.querySelector(".cat-score").textContent = `${c.score}%`;
      const bar = row.querySelector(".bar > span");
      bar.style.width = `${c.score}%`;
      bar.style.background = colorFor(c.score);
      return row;
    }),
  );

  const groups = $("a11y-groups");
  groups.hidden = !a11y;
  if (a11y) {
    groups.replaceChildren(Object.assign(document.createElement("h3"), { textContent: "Accessibility issues by who they affect" }));
    for (const [, g] of Object.entries(a11y.groups)) {
      const b = document.createElement("button");
      b.className = `g ${g.count ? "bad" : "ok"}`;
      b.innerHTML = `<b></b><span></span>`;
      b.querySelector("b").textContent = g.count;
      b.querySelector("span").textContent = g.label;
      b.onclick = () => setArea("a11y");
      groups.append(b);
    }
  }

  renderGlance();
  renderTopFixes();
  renderClaude();
  renderIssues();
}

function openIssues() {
  return allIssues().filter((i) => !i.pass && i.severity !== "info" && !isMarked(i));
}

/** One row of tiles: the numbers that matter, each one click from its issues. */
function renderGlance() {
  const p = state.page;
  if (!p?.result) return;
  const box = $("glance");
  box.hidden = false;
  const open = openIssues();
  const crit = open.filter((i) => i.severity === "critical").length;
  const major = open.filter((i) => i.severity === "major").length;
  const bots = p.result.checks.filter((c) => /^robots-allow-/.test(c.id));
  const botsOk = bots.filter((c) => c.pass).length;
  const blocked = bots.filter((c) => !c.pass && c.severity !== "minor");
  const schemaTypes = p.result.checks.find((c) => c.id === "jsonld-present");
  const psi = p.run.psi && !p.run.psi.error && p.run.psi.url === p.url ? p.run.psi : null;
  const lcp = psi?.metrics?.lcp;
  const raw = p.result.checks.find((c) => c.id === "server-rendered");
  const tiles = [
    { k: "Critical + major", v: `${crit + major}`, s: `${crit} critical · ${major} major`, cls: crit ? "bad" : major ? "warn" : "ok", go: () => setFilter({ tab: "open", area: "all", category: null }) },
    { k: "AI crawlers allowed", v: bots.length ? `${botsOk}/${bots.length}` : "–", s: blocked.length ? `Blocked: ${blocked.map((c) => c.title.replace("robots.txt allows ", "")).join(", ")}` : "Search and AI bots can fetch it", cls: blocked.length ? "bad" : bots.length ? "ok" : "", go: () => setFilter({ tab: blocked.length ? "open" : "passed", area: "aeo", category: "access" }) },
    { k: "What AI crawlers see", v: raw ? (raw.pass ? "Full" : "Partial") : "–", s: raw ? (raw.pass ? "Content is in the server HTML" : "Content needs JavaScript") : "Not checked", cls: raw ? (raw.pass ? "ok" : "bad") : "", go: () => setFilter({ tab: raw && !raw.pass ? "open" : "passed", area: "aeo", category: "access" }) },
    { k: "Structured data", v: `${p.result.categories.schema?.score ?? "–"}%`, s: schemaTypes?.pass ? (schemaTypes.detail || "").replace(/^Found:?\s*/i, "").slice(0, 60) : "No JSON-LD", cls: (p.result.categories.schema?.score ?? 0) >= 75 ? "ok" : (p.result.categories.schema?.score ?? 0) >= 50 ? "warn" : "bad", go: () => setFilter({ tab: "open", area: "schema", category: null }) },
    { k: "Speed (LCP)", v: psi && lcp != null ? `${(lcp / 1000).toFixed(1)}s` : p.psiPending ? "…" : "–", s: psi ? `${psi.field ? "Real users" : "Lab test"}${psi.performance != null ? ` · perf ${psi.performance}` : ""}` : p.psiPending ? "Measuring with PageSpeed…" : p.run.psi?.error ? "PageSpeed unavailable" : publicUrl(p.url) ? (state.settings.speed === false ? "Off in Settings" : "Not measured") : "Local page, not measured", cls: psi && lcp != null ? (lcp <= 2500 ? "ok" : lcp <= 4000 ? "warn" : "bad") : "wait", go: () => setFilter({ tab: "open", area: "tech", category: null }) },
    { k: "Accessibility", v: p.a11y ? `${p.a11y.score}` : "–", s: p.a11y ? `${p.a11y.checks.length} rule${p.a11y.checks.length === 1 ? "" : "s"} failing` : "Not run", cls: p.a11y ? (p.a11y.score >= 90 ? "ok" : p.a11y.score >= 70 ? "warn" : "bad") : "", go: () => setFilter({ tab: "open", area: "a11y", category: null }) },
  ];
  box.replaceChildren(
    ...tiles.map((t) => {
      const b = document.createElement("button");
      b.className = t.cls || "";
      b.innerHTML = `<span class="k"></span><span class="v"></span><span class="s"></span>`;
      b.querySelector(".k").textContent = t.k;
      b.querySelector(".v").textContent = t.v;
      b.querySelector(".s").textContent = t.s;
      b.title = t.s;
      b.onclick = t.go;
      return b;
    }),
  );
}

const IMPACT = { access: 1.6, answers: 1.5, schema: 1.3, trust: 1.2, structure: 1.1, head: 0.9, tech: 0.7, a11y: 0.8 };
const SEV_POINTS = { critical: 10, major: 5, minor: 2 };

/** The three open issues with the most impact, with the fix in view. */
function renderTopFixes() {
  const top = openIssues()
    .map((i) => ({ i, w: (IMPACT[i.category] || 1) * (i.blocker ? 3 : 1) * (i.kind === "ai" ? 1.2 : 1) }))
    .sort((a, b) => !!b.i.blocker - !!a.i.blocker || (SEV_POINTS[b.i.severity] || 0) - (SEV_POINTS[a.i.severity] || 0) || b.w - a.w)
    .slice(0, 3)
    .map((x) => x.i);
  $("top-fixes").hidden = !top.length;
  $("top-fixes-list").replaceChildren(
    ...top.map((i) => {
      const row = document.createElement("div");
      row.className = `fix-row sev-${i.severity}`;
      row.innerHTML = `<div class="h"><span class="sev"></span><b></b></div><p class="d muted"></p><p class="f"></p><div class="a"></div>`;
      row.querySelector(".sev").textContent = i.severity;
      row.querySelector(".sev").classList.add(i.severity);
      row.querySelector("b").textContent = i.title;
      row.querySelector(".d").textContent = i.detail || "";
      row.querySelector(".f").textContent = i.fix || "";
      const a = row.querySelector(".a");
      const targets = i.items?.length ? i.items : i.selector ? [{ selector: i.selector }] : [];
      if (targets.length && state.page.live) {
        const b = Object.assign(document.createElement("button"), { className: "small-btn", textContent: "Show on page" });
        b.onclick = () => focusIssue(i, targets);
        a.append(b);
      }
      if (i.suggested) {
        const c = Object.assign(document.createElement("button"), { className: "small-btn", textContent: "Copy fix" });
        c.onclick = () => copyText(i.suggested, c);
        a.append(c);
      }
      const m = Object.assign(document.createElement("button"), { className: "small-btn", textContent: "Mark fixed" });
      m.onclick = () => toggleMarked(i, true);
      a.append(m);
      return row;
    }),
  );
}

function setCategory(key) {
  state.category = key;
  if (!key) state.area = "all";
  state.tab = "open";
  renderPage();
  if (key) $("cat-filter").scrollIntoView({ block: "start", behavior: "smooth" });
}

function setFilter({ tab, area, category }) {
  state.tab = tab;
  state.area = area;
  state.category = category;
  renderPage();
  $("tabs").scrollIntoView({ block: "start", behavior: "smooth" });
}

function renderRecheck(diff, prevScore, show) {
  const box = $("recheck");
  if (!diff || !show || (!diff.verified.length && !diff.stillFailing.length)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.classList.toggle("warn", diff.stillFailing.length > 0 && !diff.verified.length);
  const delta = typeof prevScore === "number" ? state.page.result.score - prevScore : 0;
  const parts = [];
  if (diff.verified.length) parts.push(`${diff.verified.length} issue${diff.verified.length > 1 ? "s" : ""} fixed`);
  if (diff.stillFailing.length) parts.push(`${diff.stillFailing.length} marked fixed but still failing`);
  box.innerHTML = `<strong></strong><ul></ul>`;
  box.querySelector("strong").textContent = `Re-check: ${parts.join(", ")}${delta ? ` (AEO score ${delta > 0 ? "+" : ""}${delta})` : ""}.`;
  const ul = box.querySelector("ul");
  for (const v of diff.verified.slice(0, 8)) ul.append(li(`✓ ${v.title}`));
  for (const s of diff.stillFailing.slice(0, 8)) ul.append(li(`✗ Still failing: ${s.title}`));
}

const li = (t) => Object.assign(document.createElement("li"), { textContent: t });
const SEV_ORDER = { critical: 0, major: 1, minor: 2, info: 3 };

function aiIssues() {
  const { run } = state.page;
  return (run.ai?.review?.findings || []).map((f) => ({
    id: `ai:${hashKey(f.title + f.ref)}`,
    kind: "ai",
    pass: false,
    severity: f.severity,
    category: f.category === "schema" ? "schema" : "answers",
    aiCategory: f.category,
    title: f.title,
    detail: f.problem,
    fix: f.fix,
    suggested: f.suggested_text,
    selector: run.ai.refs?.[f.ref] || null,
  }));
}

function allIssues() {
  const { result, a11y } = state.page;
  return [...aiIssues(), ...result.checks.map((c) => ({ ...c, kind: "rule" })), ...(a11y?.checks || []).map((c) => ({ ...c, kind: "a11y" }))];
}

const isMarked = (i) => (i.kind === "ai" ? state.page.run.aiMarked?.[i.id] : state.page.run.marked?.[i.id]);

function setArea(area) {
  state.area = area;
  renderIssues();
}

function renderIssues() {
  const every = allIssues().filter((i) => !state.category || i.category === state.category);
  const issues = every.filter((i) => state.area === "all" || areaOf(i.category) === state.area);
  const cf = $("cat-filter");
  cf.hidden = !state.category;
  if (state.category) {
    const b = Object.assign(document.createElement("button"), { textContent: `${CATEGORIES[state.category]?.label || state.category} only  ✕`, title: "Show all areas" });
    b.onclick = () => setCategory(null);
    cf.replaceChildren(b);
  }
  for (const b of document.querySelectorAll("#filters button")) {
    const n = every.filter((i) => !i.pass && i.severity !== "info" && !isMarked(i) && (b.dataset.area === "all" || areaOf(i.category) === b.dataset.area)).length;
    let span = b.querySelector(".n");
    if (!span) b.append((span = Object.assign(document.createElement("span"), { className: "n" })));
    span.textContent = n;
  }
  const buckets = {
    open: issues.filter((i) => !i.pass && i.severity !== "info" && !isMarked(i)),
    marked: issues.filter((i) => !i.pass && isMarked(i)),
    passed: issues.filter((i) => i.pass || i.severity === "info"),
  };
  const nc = buckets.open.filter((i) => i.severity === "critical").length;
  const nm = buckets.open.filter((i) => i.severity === "major").length;
  $("count-open").innerHTML = `${buckets.open.length}${nc ? `<span class="sevcount c">${nc} critical</span>` : ""}${nm ? `<span class="sevcount m">${nm} major</span>` : ""}`;
  $("count-marked").textContent = buckets.marked.length;
  $("count-passed").textContent = buckets.passed.length;
  for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
  for (const b of document.querySelectorAll("#filters button")) b.setAttribute("aria-pressed", String(b.dataset.area === state.area));

  const kindOrder = { ai: 0, rule: 1, a11y: 2 };
  const list = buckets[state.tab].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const container = $("issues");
  if (!list.length) {
    const msg = { open: "Nothing left to fix here. Nice work.", marked: "Mark issues as fixed after you change the page, then reload it to verify.", passed: "No passed checks in this filter." }[state.tab];
    container.replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: msg }));
    return;
  }
  container.replaceChildren(...list.map((i) => issueCard(i, { marked: !!isMarked(i), live: state.page.live })));
}

function issueCard(issue, { marked = false, live = false, pages = null, totalPages = 0 } = {}) {
  const node = $("tpl-issue").content.firstElementChild.cloneNode(true);
  const passed = issue.pass || issue.severity === "info";
  const passLook = passed && issue.severity !== "info";
  node.classList.add(passLook ? "pass" : `sev-${issue.severity}`);
  if (issue.kind === "ai") node.classList.add("ai");
  if (marked && state.tab === "marked") node.classList.add("still");
  const sev = node.querySelector(".sev");
  sev.textContent = passLook ? "pass" : issue.severity;
  sev.classList.add(passLook ? "pass" : issue.severity);
  node.querySelector(".issue-title").textContent = issue.title;
  node.querySelector(".issue-detail").textContent = pages ? `On ${pages.length} of ${totalPages} pages. ${issue.detail || ""}` : issue.detail || "";
  node.querySelector(".fix-text").textContent = issue.fix || "";
  if (passed && issue.severity !== "info") node.querySelector(".issue-fix").hidden = true;
  if (!passed && !marked && (issue.severity === "critical" || issue.severity === "major")) node.querySelector(".issue-fix").open = true;

  const chips = node.querySelector(".chips");
  const chip = (t, cls = "") => chips.append(Object.assign(document.createElement("span"), { className: `chip ${cls}`, textContent: t }));
  if (issue.kind === "ai") chip("Claude", "ai");
  if (issue.category === "a11y") {
    chip(A11Y_GROUPS[issue.group] || "Accessibility");
    if (issue.wcag?.length) chip(`WCAG ${issue.wcag.join(", ")} ${issue.level}`, "wcag");
    else chip("Best practice");
  } else {
    chip(issue.kind === "ai" ? issue.aiCategory : CATEGORIES[issue.category]?.label || issue.category);
    if (issue.evidence) chip(issue.evidence);
    if (issue.section) chip(`§${issue.section}`);
    if (issue.blocker) chip("Blocker", "blocker");
  }

  if (issue.suggested) {
    const pre = node.querySelector(".suggest");
    pre.hidden = false;
    pre.textContent = issue.suggested;
    const copy = node.querySelector(".btn-copy");
    copy.hidden = false;
    copy.onclick = () => copyText(issue.suggested, copy);
  }
  if (issue.helpUrl) {
    const a = Object.assign(document.createElement("a"), { href: issue.helpUrl, target: "_blank", rel: "noopener", textContent: "Rule details" });
    node.querySelector(".fix-text").append(" ", a);
  }

  const show = node.querySelector(".btn-show");
  const mark = node.querySelector(".btn-mark");
  if (pages) {
    const pl = node.querySelector(".pages-list");
    pl.hidden = false;
    pl.textContent = "Pages: ";
    for (const u of pages.slice(0, 12)) {
      const a = Object.assign(document.createElement("a"), { href: "#", textContent: new URL(u).pathname || "/" });
      a.onclick = (e) => {
        e.preventDefault();
        openStoredPage(u, true);
      };
      pl.append(a, " ");
    }
    if (pages.length > 12) pl.append(`and ${pages.length - 12} more`);
    show.hidden = true;
    mark.hidden = true;
    return node;
  }

  const targets = issue.items?.length ? issue.items : issue.selector ? [{ selector: issue.selector }] : [];
  if (!targets.length || !live) show.hidden = true;
  show.onclick = () => focusIssue(issue, targets);
  if (passed) mark.hidden = true;
  mark.textContent = marked ? "Undo" : "Mark fixed";
  mark.onclick = () => toggleMarked(issue, !marked);
  return node;
}

async function toggleMarked(issue, on) {
  const run = state.page.run;
  const bag = issue.kind === "ai" ? (run.aiMarked ||= {}) : (run.marked ||= {});
  if (on) bag[issue.id] = Date.now();
  else delete bag[issue.id];
  await saveRun(state.page.url, run);
  renderGlance();
  renderTopFixes();
  renderIssues();
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = old), 1200);
  } catch {
    btn.textContent = "Copy failed";
  }
}

// ---------------------------------------------------------------- highlights

function highlightItems() {
  const items = [];
  for (const i of allIssues()) {
    if (i.pass || i.severity === "info" || isMarked(i)) continue;
    if (state.area !== "all" && areaOf(i.category) !== state.area) continue;
    const targets = i.items?.length ? i.items : i.selector ? [{ selector: i.selector }] : [];
    for (const t of targets.slice(0, 25)) items.push({ selector: t.selector, severity: i.kind === "ai" ? "ai" : i.severity, label: t.label && i.kind !== "a11y" ? t.label : i.title });
  }
  return items;
}

async function highlightAll(focus) {
  if (!state.page?.live || !state.page.tabId) return;
  try {
    await send(state.page.tabId, { type: "aeo:highlight", items: highlightItems(), focus });
  } catch {}
}

function clearHighlights() {
  if (state.page?.live && state.page.tabId) send(state.page.tabId, { type: "aeo:clear" }).catch(() => {});
}

async function focusIssue(issue, targets) {
  if (!state.page?.tabId) return;
  const items = state.highlight ? highlightItems() : [];
  for (const t of targets) items.push({ selector: t.selector, severity: issue.kind === "ai" ? "ai" : issue.severity, label: issue.title });
  try {
    const res = await send(state.page.tabId, { type: "aeo:highlight", items, focus: targets[0].selector });
    if (!res?.found) flash("That element is not on the page any more. Re-scan to refresh.");
  } catch {
    flash("Could not reach the page. Re-scan it.");
  }
}

function flash(msg) {
  const box = $("recheck");
  box.hidden = false;
  box.classList.add("warn");
  box.textContent = msg;
  setTimeout(() => (box.hidden = true), 3500);
}

// ---------------------------------------------------------------- Claude

function renderClaude(progress) {
  const body = $("claude-body");
  const btn = $("btn-claude");
  const ai = state.page?.run?.ai;
  const hasKey = !!state.settings.apiKey;
  const model = MODELS.find((m) => m.id === state.settings.model) || MODELS[0];
  btn.hidden = !state.page?.live;

  if (state.claudeAbort) {
    btn.textContent = "Cancel";
    btn.disabled = false;
    body.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: `${model.label.split(" (")[0]} is reviewing the page…${progress ? ` ${(progress / 1000).toFixed(1)}k characters` : ""}` }));
    return;
  }
  btn.textContent = !hasKey ? "Add API key" : ai ? "Re-check with Claude" : "Ask Claude";
  btn.disabled = false;
  if (!ai) {
    body.replaceChildren();
    if (!state.page?.live) body.append(Object.assign(document.createElement("p"), { className: "muted small", textContent: "Open the page and re-scan it live to ask Claude." }));
    else if (!hasKey) body.append(Object.assign(document.createElement("p"), { className: "muted small", textContent: "Add your Anthropic API key in Settings to get Claude's review. Rule-based scoring works without it." }));
    if (state.page?.run?.aiError) body.append(Object.assign(document.createElement("p"), { className: "err small", textContent: state.page.run.aiError }));
    return;
  }
  const r = ai.review;
  const wrap = document.createElement("div");
  wrap.innerHTML = `<div class="ai-score"><b></b><span class="muted">content score from Claude</span></div><p class="ai-q"></p><p class="ai-sum"></p><div class="ai-ld"></div><p class="muted small ai-meta"></p>`;
  wrap.querySelector("b").textContent = r.semantic_score;
  wrap.querySelector(".ai-q").textContent = r.primary_question ? `Main question: ${r.primary_question}` : "";
  wrap.querySelector(".ai-sum").textContent = r.summary;
  if (r.suggested_json_ld) {
    const det = document.createElement("details");
    det.innerHTML = `<summary>Suggested JSON-LD</summary><pre></pre><button class="small-btn">Copy JSON-LD</button>`;
    let pretty = r.suggested_json_ld;
    try {
      pretty = JSON.stringify(JSON.parse(pretty), null, 2);
    } catch {}
    det.querySelector("pre").textContent = pretty;
    det.querySelector("button").onclick = (e) => copyText(`<script type="application/ld+json">\n${pretty}\n</script>`, e.target);
    wrap.querySelector(".ai-ld").append(det);
  }
  const cost = ai.cost != null ? ` · about $${ai.cost.toFixed(3)}` : "";
  const cached = ai.usage?.cache_read_input_tokens ? ` · ${ai.usage.cache_read_input_tokens.toLocaleString()} tokens from cache` : "";
  wrap.querySelector(".ai-meta").textContent = `${ai.model} · ${new Date(ai.at).toLocaleString()}${cost}${cached}. Findings appear in the list below.`;
  body.replaceChildren(wrap);
  if (state.page.run.aiError) body.append(Object.assign(document.createElement("p"), { className: "err small", textContent: state.page.run.aiError }));
}

async function onClaudeClick() {
  if (state.claudeAbort) {
    state.claudeAbort.abort();
    return;
  }
  if (!state.settings.apiKey) {
    openSettings();
    return;
  }
  if (!state.page?.snap) return;
  const ctrl = new AbortController();
  state.claudeAbort = ctrl;
  renderClaude();
  const url = state.page.url;
  const page = state.page;
  try {
    const { review, usage, model, refs } = await askClaude({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      effort: state.settings.effort,
      snap: page.snap,
      result: page.result,
      signal: ctrl.signal,
      onProgress: (n) => state.page === page && renderClaude(n),
    });
    const run = await loadRun(url);
    run.ai = { review, usage, model, refs, at: Date.now(), cost: estimateCost(model, usage) };
    run.aiMarked = {}; // a fresh review replaces the previous findings
    delete run.aiError;
    await saveRun(url, run);
    page.run = run;
  } catch (e) {
    page.run.aiError = describeError(e);
  } finally {
    state.claudeAbort = null;
    if (state.page === page && state.mode === "page") {
      renderClaude();
      renderIssues();
      if (state.highlight) highlightAll();
    }
  }
}

// ---------------------------------------------------------------- site crawl

async function startCrawl(startUrl) {
  if (state.crawlAbort) return;
  clearHighlights();
  const maxPages = Number($("crawl-max").value) || 25;
  const ctrl = new AbortController();
  state.crawlAbort = ctrl;
  state.site = null;
  setMode("site");
  $("site-summary").hidden = true;
  $("crawl-progress").hidden = false;
  $("crawl-status").textContent = "Reading robots.txt and sitemap…";
  $("crawl-bar").style.width = "0%";
  $("crawl-url").textContent = startUrl;
  const origin = new URL(startUrl).origin;
  const startedAt = Date.now();
  try {
    const o = await originData(origin);
    const res = await crawlSite({
      startUrl,
      maxPages,
      robotsText: o.robots?.text || "",
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.phase === "page") {
          $("crawl-status").textContent = `Scanning page ${p.done + 1} of up to ${maxPages}`;
          $("crawl-bar").style.width = `${Math.round((p.done / maxPages) * 100)}%`;
          $("crawl-url").textContent = p.url;
        }
      },
      analyze: async (tabId, url) => {
        const { snap, result, a11y, httpStatus } = await analyzeTab(tabId, url);
        if (httpStatus >= 400) return { url: snap.url, title: snap.title, error: `HTTP ${httpStatus}`, links: [] };
        const run = await loadRun(snap.url);
        const checks = allChecks(result, a11y);
        Object.assign(run, {
          url: snap.url,
          title: snap.title,
          host: snap.host,
          stack: snap.stack,
          checks: checks.map(({ id, pass, severity, title, category }) => ({ id, pass, severity, title, category })),
          score: result.score,
          a11yScore: a11y?.score ?? null,
          result,
          a11y,
          at: Date.now(),
        });
        await saveRun(snap.url, run);
        return {
          url: snap.url,
          title: snap.title,
          score: result.score,
          a11yScore: a11y?.score ?? null,
          issues: checks.filter((c) => !c.pass && c.severity !== "info").map(compact),
          meta: { title: snap.title, description: snap.metaDescription, canonical: snap.canonical ? new URL(snap.canonical, snap.url).href : null, hreflang: snap.hreflang },
          links: snap.internalLinks,
        };
      },
    });
    const ok = res.pages.filter((p) => !p.error);
    const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
    const report = {
      ...res,
      siteChecks: siteWideChecks(res.pages),
      startedAt,
      finishedAt: Date.now(),
      maxPages,
      avgScore: avg(ok.map((p) => p.score)),
      avgA11y: avg(ok.map((p) => p.a11yScore).filter((x) => x != null)),
    };
    const prev = (await chrome.storage.local.get(siteKey(origin)))[siteKey(origin)];
    if (prev?.avgScore != null) report.prevAvgScore = prev.avgScore;
    await chrome.storage.local.set({ [siteKey(origin)]: report });
    state.site = report;
  } catch (e) {
    $("crawl-status").textContent = `Crawl failed: ${e.message || e}`;
    state.crawlAbort = null;
    return;
  }
  state.crawlAbort = null;
  renderSite();
}

function renderSite() {
  const s = state.site;
  setMode("site");
  $("crawl-progress").hidden = true;
  $("site-summary").hidden = false;
  const ok = s.pages.filter((p) => !p.error);
  $("site-origin").textContent = s.origin;
  const trend = s.prevAvgScore != null && s.prevAvgScore !== s.avgScore ? ` · avg score ${s.avgScore - s.prevAvgScore > 0 ? "+" : ""}${s.avgScore - s.prevAvgScore} since last crawl` : "";
  const skipped = s.skipped?.robots ? ` · ${s.skipped.robots} URLs skipped by robots.txt` : "";
  $("site-meta").textContent = `${ok.length} pages crawled${s.aborted ? " (stopped early)" : ""} · ${new Date(s.finishedAt).toLocaleString()}${skipped}${trend}`;
  const tile = (id, v) => {
    $(id).textContent = v ?? "–";
    $(id).style.color = v == null ? "" : colorFor(v);
  };
  tile("site-score", s.avgScore);
  tile("site-a11y", s.avgA11y);
  const sevRank = { critical: 0, major: 1, minor: 2, info: 3 };
  const issues = [...(s.siteChecks || []), ...siteIssues(ok)].sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || (b.pages?.length || 0) - (a.pages?.length || 0));
  const nCrit = issues.filter((i) => i.severity === "critical").length;
  const nMaj = issues.filter((i) => i.severity === "major").length;
  $("site-issues").textContent = issues.length;
  $("site-issues").style.color = nCrit ? "var(--critical)" : nMaj ? "var(--major)" : "var(--good)";
  $("site-issues").title = `${nCrit} critical · ${nMaj} major`;
  $("site-issues-sub").textContent = `${nCrit} critical · ${nMaj} major`;

  for (const b of document.querySelectorAll("#site-filters button")) {
    b.setAttribute("aria-pressed", String(b.dataset.area === state.siteArea));
    let span = b.querySelector(".n");
    if (!span) b.append((span = Object.assign(document.createElement("span"), { className: "n" })));
    span.textContent = issues.filter((i) => b.dataset.area === "all" || areaOf(i.category) === b.dataset.area).length;
  }
  const list = issues.filter((i) => state.siteArea === "all" || areaOf(i.category) === state.siteArea);
  $("site-issue-list").replaceChildren(
    ...(list.length
      ? list.map((i) => issueCard({ ...i, kind: i.category === "a11y" ? "a11y" : "rule" }, { pages: i.pages, totalPages: ok.length }))
      : [Object.assign(document.createElement("p"), { className: "empty", textContent: "No issues in this filter." })]),
  );

  $("site-pages").replaceChildren(
    ...[...s.pages]
      .sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || a.score - b.score)
      .map((p) => {
        const b = document.createElement("button");
        b.innerHTML = `<span class="r-title"></span><span class="r-sub"></span><span class="r-score"></span>`;
        b.querySelector(".r-title").textContent = p.title || p.url;
        b.querySelector(".r-sub").textContent = p.error ? p.error : `${new URL(p.url).pathname} · ${p.issues.length} issues${p.a11yScore != null ? ` · accessibility ${p.a11yScore}` : ""}`;
        b.querySelector(".r-score").textContent = p.error ? "!" : p.score;
        if (!p.error) b.querySelector(".r-score").style.color = colorFor(p.score);
        b.onclick = () => (p.error ? null : openStoredPage(p.url, true));
        return b;
      }),
  );
}

// ---------------------------------------------------------------- downloads

async function downloadReport(format) {
  if (format.startsWith("vis-")) return visDownload(format);
  if (format.startsWith("comp-")) return compDownload(format);
  const stamp = new Date().toISOString().slice(0, 10);
  if (state.mode === "site" && state.site) {
    const s = state.site;
    const ok = s.pages.filter((p) => !p.error);
    if (format === "brief" || format === "brief-ai") download(`site-aeo-brief-${slug(s.origin)}-${stamp}.md`, siteBriefMarkdown(s), "text/markdown");
    else if (format === "html") download(`site-aeo-report-${slug(s.origin)}-${stamp}.html`, siteReportHtml(s), "text/html");
    else {
      const rows = [
        ...(s.siteChecks || []).map((c) => ({ ...c, url: s.origin, detail: `${c.detail} Pages: ${c.pages.join(" ")}`, pagesAffected: c.pages.length })),
        ...ok.flatMap((p) => p.issues.map((c) => ({ ...c, url: p.url }))),
      ];
      download(`site-aeo-issues-${slug(s.origin)}-${stamp}.csv`, issuesCsv(rows), "text/csv");
    }
    return;
  }
  const p = state.page;
  if (!p?.result) return;
  const briefArgs = { url: p.url, title: p.run.title, stack: p.run.stack || p.snap?.stack, result: p.result, a11y: p.a11y, ai: p.run.ai };
  if (format === "brief") {
    download(`aeo-brief-${slug(p.url)}-${stamp}.md`, briefMarkdown(briefArgs), "text/markdown");
  } else if (format === "brief-ai") {
    await claudeBrief(briefArgs, stamp);
  } else if (format === "html") {
    download(`aeo-report-${slug(p.url)}-${stamp}.html`, pageReportHtml({ url: p.url, title: p.run.title, result: p.result, a11y: p.a11y, ai: p.run.ai, at: p.run.at }), "text/html");
  } else {
    const rows = [
      ...aiIssues().map((i) => ({ ...i, url: p.url, evidence: "Claude", detail: i.detail, fix: [i.fix, i.suggested].filter(Boolean).join(" Suggested text: ") })),
      ...allChecks(p.result, p.a11y)
        .filter((c) => !c.pass && c.severity !== "info")
        .map((c) => ({ ...c, url: p.url })),
    ];
    download(`aeo-issues-${slug(p.url)}-${stamp}.csv`, issuesCsv(rows), "text/csv");
  }
}

async function claudeBrief(args, stamp) {
  const p = state.page;
  if (!state.settings.apiKey) return openSettings();
  if (!p.live || !p.tabId) return flash("Open the page and re-scan it live to write code fixes.");
  if (state.claudeAbort) return;
  const ctrl = new AbortController();
  state.claudeAbort = ctrl;
  const body = $("claude-body");
  const status = (t) => body.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: t }));
  $("btn-claude").textContent = "Cancel";
  status("Collecting the page HTML…");
  $("claude").scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const failing = [...p.result.checks, ...(p.a11y?.checks || [])].filter((c) => !c.pass && c.severity !== "info");
    const selectors = [...new Set(failing.flatMap((c) => (c.items?.length ? c.items.map((i) => i.selector) : c.selector ? [c.selector] : []).slice(0, 5)))];
    const html = await send(p.tabId, { type: "aeo:html", selectors });
    status("Claude is writing the code fixes…");
    const { text, usage, model } = await streamText({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      effort: state.settings.effort,
      system: BRIEF_SYSTEM,
      user: buildBriefInput({ ...args, html }),
      signal: ctrl.signal,
      onProgress: (n) => status(`Claude is writing the code fixes… ${(n / 1000).toFixed(1)}k characters`),
    });
    const cost = estimateCost(model, usage);
    const footer = `\n\n---\n_Written by ${model} from an AEO Scorer scan of ${p.url} on ${new Date().toLocaleString()}. Review before applying._\n`;
    download(`aeo-brief-claude-${slug(p.url)}-${stamp}.md`, text + footer, "text/markdown");
    p.run.aiError = null;
    flash(`Brief downloaded${cost != null ? ` (about $${cost.toFixed(3)})` : ""}.`);
  } catch (e) {
    p.run.aiError = describeError(e);
  } finally {
    state.claudeAbort = null;
    if (state.page === p) renderClaude();
  }
}

// ---------------------------------------------------------------- settings

function openSettings() {
  state.settingsOpen = true;
  setMode(state.mode);
  $("set-key").value = state.settings.apiKey || "";
  $("set-model").replaceChildren(...MODELS.map((m) => new Option(m.label, m.id, false, m.id === state.settings.model)));
  $("set-effort").value = state.settings.effort;
  $("set-a11y").checked = state.settings.a11y !== false;
  $("set-speed").checked = state.settings.speed !== false;
  $("set-status").textContent = "";
}

function closeSettings() {
  state.settingsOpen = false;
  setMode(state.mode);
  if (state.mode === "page" && state.page?.result) renderClaude();
  if (state.mode === "home") showHome();
  if (state.mode === "vis") showVis();
  if (state.mode === "comp") renderComp();
}

async function saveSettings() {
  const key = $("set-key").value.trim();
  if (key && !/^sk-ant-/.test(key)) {
    $("set-status").textContent = 'That does not look like an Anthropic API key (it should start with "sk-ant-").';
    return;
  }
  state.settings = { apiKey: key, model: $("set-model").value, effort: $("set-effort").value, a11y: $("set-a11y").checked, speed: $("set-speed").checked };
  await chrome.storage.local.set({ settings: state.settings });
  $("set-status").textContent = "Saved.";
  setTimeout(closeSettings, 500);
}

// ---------------------------------------------------------------- wiring

function typedUrl() {
  let v = $("home-url").value.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    return new URL(v).href;
  } catch {
    return null;
  }
}

for (const b of document.querySelectorAll("#mainnav button")) {
  b.onclick = async () => {
    if (state.crawlAbort) return flash("A crawl is running. Stop it first.");
    state.settingsOpen = false;
    const go = b.dataset.go;
    if (go === "comp") return showComp();
    if (go === "vis") return showVis();
    const tab = await currentTab();
    if (go === "page") {
      if (state.page?.result && (!state.page.live || state.page.url === tab?.url)) return renderPage();
      if (scannable(tab?.url)) return scanPage({ reason: "open" });
      return showHome();
    }
    if (go === "site") {
      if (state.site) return renderSite();
      if (scannable(tab?.url)) {
        const key = siteKey(new URL(tab.url).origin);
        const saved = (await chrome.storage.local.get(key))[key];
        if (saved) {
          state.site = saved;
          return renderSite();
        }
      }
      showHome();
      flash("Click “Crawl this site” to score every page.");
    }
  };
}
$("btn-home").onclick = () => !state.crawlAbort && showHome();
$("btn-close").onclick = () => {
  if (state.crawlAbort) state.crawlAbort.abort();
  state.claudeAbort?.abort();
  if (state.mode === "comp") document.getElementById("btn-comp-stop").click();
  if (state.mode === "page" && state.page?.fromSite && state.site) renderSite();
  else showHome();
};
$("btn-rescan").onclick = () => (state.mode === "site" && state.site ? startCrawl(state.site.startUrl) : scanPage({ reason: "manual" }));
$("btn-settings").onclick = () => (state.settingsOpen ? closeSettings() : openSettings());
$("btn-back").onclick = closeSettings;
$("btn-save").onclick = saveSettings;
$("btn-clear-key").onclick = async () => {
  $("set-key").value = "";
  state.settings.apiKey = "";
  await chrome.storage.local.set({ settings: state.settings });
  $("set-status").textContent = "Key removed.";
};
$("btn-reset-history").onclick = async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("run:") || k.startsWith("site:")));
  $("set-status").textContent = "Saved reports cleared.";
};
$("btn-claude").onclick = onClaudeClick;
$("toggle-highlight").onchange = async (e) => {
  state.highlight = e.target.checked;
  await chrome.storage.local.set({ highlight: state.highlight });
  if (state.highlight) highlightAll();
  else clearHighlights();
};
$("btn-scan-tab").onclick = () => {
  state.page = null;
  scanPage({ reason: "open" });
};
$("btn-crawl-tab").onclick = async () => {
  const tab = await currentTab();
  if (scannable(tab?.url)) startCrawl(tab.url);
};
$("btn-scan-url").onclick = () => {
  const u = typedUrl();
  if (u) openAndScan(u);
  else $("home-url").focus();
};
$("btn-crawl-url").onclick = () => {
  const u = typedUrl();
  if (u) startCrawl(u);
  else $("home-url").focus();
};
$("home-url").onkeydown = (e) => {
  if (e.key === "Enter") $("btn-scan-url").click();
};
$("btn-crawl-stop").onclick = () => state.crawlAbort?.abort();
$("btn-back-site").onclick = () => state.site && renderSite();
$("btn-open-live").onclick = () => state.page?.url && openAndScan(state.page.url);
$("btn-download").onclick = (e) => {
  e.stopPropagation();
  for (const b of document.querySelectorAll("#download-menu button")) b.hidden = (state.mode === "vis") !== b.classList.contains("vis-only") || (state.mode === "comp") !== b.classList.contains("comp-only");
  $("menu-brief-ai").hidden = !(state.mode === "page" && state.page?.live);
  $("download-menu").hidden = !$("download-menu").hidden;
};
for (const b of document.querySelectorAll("#download-menu button")) {
  b.onclick = () => {
    $("download-menu").hidden = true;
    downloadReport(b.dataset.format);
  };
}
document.addEventListener("click", (e) => {
  if (!$("download-menu").contains(e.target)) $("download-menu").hidden = true;
});
for (const b of document.querySelectorAll("#tabs button")) {
  b.onclick = () => {
    state.tab = b.dataset.tab;
    renderIssues();
  };
}
for (const b of document.querySelectorAll("#filters button")) {
  b.onclick = () => {
    setArea(b.dataset.area);
    if (state.highlight) highlightAll();
  };
}
for (const b of document.querySelectorAll("#site-filters button")) {
  b.onclick = () => {
    state.siteArea = b.dataset.area;
    renderSite();
  };
}

// Re-scan when the page reloads or the user switches tabs, but only while a
// live page report is open. Marked issues survive and get verified.
let reloadTimer = null;
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  if (state.mode === "home" && !state.settingsOpen) {
    currentTab().then((t) => t?.id === tabId && showHome());
    return;
  }
  if (state.mode === "vis") {
    currentTab().then((t) => t?.id === tabId && refreshCapture());
    return;
  }
  if (state.mode !== "page" || !state.page?.live || state.crawlAbort) return;
  if (tabId !== (FIXED_TAB || state.page.tabId)) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => scanPage({ reason: "reload" }), 400);
});
if (!FIXED_TAB) {
  chrome.tabs.onActivated.addListener(() => {
    if (state.crawlAbort) return;
    if (state.mode === "home") return showHome();
    if (state.mode === "vis") return refreshCapture();
    if (state.mode === "page" && state.page?.live) {
      state.claudeAbort?.abort();
      scanPage({ reason: "tab" });
    }
  });
}

initVis({ state, setMode, openAndScan, currentTab, flash, colorFor, showHome, compare: (o) => showComp(o) });
initComp({ state, setMode, currentTab, colorFor, showHome, openStoredPage, analyzePage });

(async () => {
  await loadSettings();
  if (params.get("view") === "vis") return showVis();
  if (params.get("view") === "comp") return showComp({});
  $("toggle-highlight").checked = state.highlight;
  const tab = await currentTab();
  if (scannable(tab?.url)) scanPage({ reason: "open" });
  else showHome();
})();
