import { scorePage, diffRuns, hashKey, CATEGORIES } from "./rules.js";
import { MODELS, askClaude, estimateCost, describeError } from "./claude.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const FIXED_TAB = params.get("tabId") ? Number(params.get("tabId")) : null; // used by tests

const state = {
  tabId: null,
  url: null,
  snap: null,
  result: null,
  run: null, // stored record for this URL
  tab: "open",
  highlight: false,
  scanning: false,
  claudeAbort: null,
  settings: { apiKey: "", model: MODELS[0].id, effort: "low" },
};

// ---------------------------------------------------------------- storage

const urlKey = (url) => {
  try {
    const u = new URL(url);
    return `run:${u.origin}${u.pathname}${u.search}`;
  } catch {
    return `run:${url}`;
  }
};

async function loadRun(url) {
  const key = urlKey(url);
  const got = await chrome.storage.local.get(key);
  return got[key] || { marked: {}, checks: null, ai: null, aiMarked: {} };
}

async function saveRun(url, run) {
  await chrome.storage.local.set({ [urlKey(url)]: run });
}

async function loadSettings() {
  const got = await chrome.storage.local.get("settings");
  state.settings = { ...state.settings, ...(got.settings || {}) };
}

// ---------------------------------------------------------------- site data

const siteCache = new Map(); // origin -> { at, robots, llmsTxt }

async function fetchText(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials: "omit", redirect: "follow", signal: ctrl.signal, cache: "no-store" });
    const text = res.ok ? (await res.text()).slice(0, 2_000_000) : "";
    return { status: res.status, text, contentType: res.headers.get("content-type") || "" };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function siteData(url) {
  const { origin } = new URL(url);
  let cached = siteCache.get(origin);
  if (!cached || Date.now() - cached.at > 5 * 60_000) {
    const [robots, llms] = await Promise.all([fetchText(`${origin}/robots.txt`), fetchText(`${origin}/llms.txt`)]);
    cached = {
      at: Date.now(),
      robots: robots && robots.status === 200 && /text\/plain|^$/.test(robots.contentType.split(";")[0]) ? robots : robots && { status: robots.status === 200 ? 404 : robots.status, text: "" },
      llmsTxt: llms ? llms.status === 200 && !/text\/html/.test(llms.contentType) : null,
    };
    siteCache.set(origin, cached);
  }
  const rawHtml = await fetchText(url); // the server response, without running JavaScript
  return { robots: cached.robots, llmsTxt: cached.llmsTxt, rawHtml };
}

// ---------------------------------------------------------------- page bridge

async function send(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

function scannable(url) {
  return /^https?:\/\//.test(url || "") && !/^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/.test(url);
}

// ---------------------------------------------------------------- scanning

async function currentTab() {
  if (FIXED_TAB) return chrome.tabs.get(FIXED_TAB);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function scan({ reason = "manual" } = {}) {
  if (state.scanning) return;
  const tab = await currentTab();
  if (!tab) return;
  state.tabId = tab.id;
  if (!scannable(tab.url)) {
    showState("Open a web page (http or https) to score it. Chrome pages and the Web Store cannot be scanned.");
    return;
  }
  state.scanning = true;
  $("btn-rescan").classList.add("spin");
  if (!state.result || state.url !== tab.url) showState("Scanning page…");
  try {
    const [snapRes, site] = await Promise.all([send(tab.id, { type: "aeo:snapshot" }), siteData(tab.url)]);
    if (!snapRes?.ok) throw new Error(snapRes?.error || "Could not read the page.");
    const snap = snapRes.snapshot;
    const result = scorePage(snap, site);
    const run = await loadRun(snap.url);
    const sameUrlAsShown = state.url === snap.url;

    // Re-check: compare with the last scan of this URL.
    const diff = run.checks ? diffRuns(run.checks, result.checks, run.marked) : null;
    for (const v of diff?.verified || []) delete run.marked[v.id];
    const prevScore = run.score;
    run.checks = result.checks.map(({ id, pass, severity, title, category }) => ({ id, pass, severity, title, category }));
    run.score = result.score;
    run.at = Date.now();
    await saveRun(snap.url, run);

    Object.assign(state, { url: snap.url, snap, result, run });
    render();
    renderRecheck(diff, prevScore, reason, sameUrlAsShown || reason === "reload");
    if (state.highlight) highlightAll();
  } catch (e) {
    showState(`Could not scan this page: ${e.message || e}`);
  } finally {
    state.scanning = false;
    $("btn-rescan").classList.remove("spin");
  }
}

function showState(msg) {
  $("state-msg").hidden = false;
  $("state-msg").textContent = msg;
  for (const id of ["summary", "recheck", "categories", "claude", "tabs"]) $(id).hidden = true;
  $("issues").replaceChildren();
}

// ---------------------------------------------------------------- rendering

function colorFor(score) {
  const css = getComputedStyle(document.documentElement);
  if (score >= 75) return css.getPropertyValue("--good");
  if (score >= 55) return css.getPropertyValue("--minor");
  return css.getPropertyValue("--critical");
}

function render() {
  const { snap, result } = state;
  $("state-msg").hidden = true;
  for (const id of ["summary", "categories", "claude", "tabs"]) $(id).hidden = false;

  $("score").textContent = result.score;
  $("grade").textContent = result.grade;
  const fg = $("ring-fg");
  fg.style.strokeDashoffset = String(326.7 * (1 - result.score / 100));
  fg.style.stroke = colorFor(result.score);
  $("page-host").textContent = snap.host;
  $("page-title").textContent = snap.title || snap.url;
  $("page-title").title = snap.url;
  $("scanned-at").textContent = `Scanned ${new Date(state.run.at).toLocaleTimeString()}`;

  $("categories").replaceChildren(
    ...Object.entries(result.categories).map(([, c]) => {
      const row = document.createElement("div");
      row.className = "cat";
      row.innerHTML = `<span class="cat-label"></span><span class="cat-score"></span><div class="bar"><span></span></div>`;
      row.querySelector(".cat-label").textContent = `${c.label} · ${c.passed}/${c.total}`;
      row.querySelector(".cat-score").textContent = `${c.score}%`;
      const bar = row.querySelector(".bar > span");
      bar.style.width = `${c.score}%`;
      bar.style.background = colorFor(c.score);
      return row;
    }),
  );

  renderClaude();
  renderIssues();
}

function renderRecheck(diff, prevScore, reason, show) {
  const box = $("recheck");
  if (!diff || !show || (!diff.verified.length && !diff.stillFailing.length)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.classList.toggle("warn", diff.stillFailing.length > 0 && !diff.verified.length);
  const delta = typeof prevScore === "number" ? state.result.score - prevScore : 0;
  const parts = [];
  if (diff.verified.length) parts.push(`${diff.verified.length} issue${diff.verified.length > 1 ? "s" : ""} fixed`);
  if (diff.stillFailing.length) parts.push(`${diff.stillFailing.length} marked fixed but still failing`);
  box.innerHTML = `<strong></strong><ul></ul>`;
  box.querySelector("strong").textContent = `Re-check: ${parts.join(", ")}${delta ? ` (score ${delta > 0 ? "+" : ""}${delta})` : ""}.`;
  const ul = box.querySelector("ul");
  for (const v of diff.verified.slice(0, 8)) ul.append(li(`✓ ${v.title}`));
  for (const s of diff.stillFailing.slice(0, 8)) ul.append(li(`✗ Still failing: ${s.title}`));
}

const li = (t) => Object.assign(document.createElement("li"), { textContent: t });

const SEV_ORDER = { critical: 0, major: 1, minor: 2, info: 3 };

function allIssues() {
  const { result, run } = state;
  const rule = result.checks.map((c) => ({ ...c, kind: "rule" }));
  const ai = (run.ai?.review?.findings || []).map((f) => ({
    id: `ai:${hashKey(f.title + f.ref)}`,
    kind: "ai",
    pass: false,
    severity: f.severity,
    category: f.category,
    title: f.title,
    detail: f.problem,
    fix: f.fix,
    suggested: f.suggested_text,
    selector: run.ai.refs?.[f.ref] || null,
  }));
  return [...ai, ...rule];
}

function renderIssues() {
  const { run } = state;
  const issues = allIssues();
  const isMarked = (i) => (i.kind === "ai" ? run.aiMarked?.[i.id] : run.marked?.[i.id]);
  const buckets = {
    open: issues.filter((i) => !i.pass && i.severity !== "info" && !isMarked(i)),
    marked: issues.filter((i) => !i.pass && isMarked(i)),
    passed: issues.filter((i) => i.pass || i.severity === "info"),
  };
  $("count-open").textContent = buckets.open.length;
  $("count-marked").textContent = buckets.marked.length;
  $("count-passed").textContent = buckets.passed.length;
  for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));

  const list = buckets[state.tab].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "ai" ? -1 : 1) || SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const container = $("issues");
  if (!list.length) {
    const msg = { open: "Nothing left to fix. Nice work.", marked: "Mark issues as fixed after you change the page, then reload it to verify.", passed: "No passed checks yet." }[state.tab];
    container.replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: msg }));
    return;
  }
  container.replaceChildren(...list.map((i) => issueCard(i, !!isMarked(i))));
}

function issueCard(issue, marked) {
  const node = $("tpl-issue").content.firstElementChild.cloneNode(true);
  const passed = issue.pass || issue.severity === "info";
  node.classList.add(passed && issue.severity !== "info" ? "pass" : `sev-${issue.severity}`);
  if (issue.kind === "ai") node.classList.add("ai");
  if (marked && state.tab === "marked") node.classList.add("still");
  const sev = node.querySelector(".sev");
  sev.textContent = passed && issue.severity !== "info" ? "pass" : issue.severity;
  sev.classList.add(passed && issue.severity !== "info" ? "pass" : issue.severity);
  node.querySelector(".issue-title").textContent = issue.title;
  node.querySelector(".issue-detail").textContent = issue.detail || "";
  node.querySelector(".fix-text").textContent = issue.fix || "";
  if (passed) node.querySelector(".issue-fix").hidden = !issue.fix || issue.severity !== "info";

  const chips = node.querySelector(".chips");
  const chip = (t, cls = "") => chips.append(Object.assign(document.createElement("span"), { className: `chip ${cls}`, textContent: t }));
  if (issue.kind === "ai") chip("Claude", "ai");
  chip(issue.kind === "ai" ? issue.category : CATEGORIES[issue.category]?.label || issue.category);
  if (issue.evidence) chip(issue.evidence);
  if (issue.section) chip(`§${issue.section}`);

  if (issue.suggested) {
    const pre = node.querySelector(".suggest");
    pre.hidden = false;
    pre.textContent = issue.suggested;
    const copy = node.querySelector(".btn-copy");
    copy.hidden = false;
    copy.onclick = () => copyText(issue.suggested, copy);
  }

  const show = node.querySelector(".btn-show");
  const targets = issue.items?.length ? issue.items : issue.selector ? [{ selector: issue.selector }] : [];
  if (!targets.length) show.hidden = true;
  show.onclick = () => focusIssue(issue, targets);

  const mark = node.querySelector(".btn-mark");
  if (passed) mark.hidden = true;
  mark.textContent = marked ? "Undo" : "Mark fixed";
  mark.onclick = () => toggleMarked(issue, !marked);
  return node;
}

async function toggleMarked(issue, on) {
  const bag = issue.kind === "ai" ? (state.run.aiMarked ||= {}) : (state.run.marked ||= {});
  if (on) bag[issue.id] = Date.now();
  else delete bag[issue.id];
  await saveRun(state.url, state.run);
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
    if (i.pass || i.severity === "info") continue;
    const marked = i.kind === "ai" ? state.run.aiMarked?.[i.id] : state.run.marked?.[i.id];
    if (marked) continue;
    const targets = i.items?.length ? i.items : i.selector ? [{ selector: i.selector }] : [];
    for (const t of targets.slice(0, 40)) items.push({ selector: t.selector, severity: i.kind === "ai" ? "ai" : i.severity, label: t.label || i.title });
  }
  return items;
}

async function highlightAll(focus) {
  if (!state.tabId) return;
  try {
    await send(state.tabId, { type: "aeo:highlight", items: highlightItems(), focus });
  } catch {}
}

async function focusIssue(issue, targets) {
  if (!state.tabId) return;
  const items = state.highlight ? highlightItems() : [];
  for (const t of targets) items.push({ selector: t.selector, severity: issue.kind === "ai" ? "ai" : issue.severity, label: t.label || issue.title });
  try {
    const res = await send(state.tabId, { type: "aeo:highlight", items, focus: targets[0].selector });
    if (!res?.found) flash("That element is not on the page any more. Re-scan to refresh.");
  } catch (e) {
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
  const ai = state.run?.ai;
  const hasKey = !!state.settings.apiKey;
  const model = MODELS.find((m) => m.id === state.settings.model) || MODELS[0];

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
    if (!hasKey) body.append(Object.assign(document.createElement("p"), { className: "muted small", textContent: "Add your Anthropic API key in Settings to get Claude's review. Rule-based scoring works without it." }));
    if (state.run?.aiError) body.append(Object.assign(document.createElement("p"), { className: "err small", textContent: state.run.aiError }));
    return;
  }
  const r = ai.review;
  const wrap = document.createElement("div");
  wrap.innerHTML = `<div class="ai-score"><b></b><span class="muted">content score from Claude</span></div><p class="ai-q"></p><p class="ai-sum"></p><div class="ai-ld"></div><p class="muted small ai-meta"></p>`;
  wrap.querySelector("b").textContent = r.semantic_score;
  wrap.querySelector(".ai-q").textContent = r.primary_question ? `Main question: ${r.primary_question}` : "";
  wrap.querySelector(".ai-sum").textContent = r.summary;
  if (r.suggested_json_ld) {
    const ld = wrap.querySelector(".ai-ld");
    const det = document.createElement("details");
    det.innerHTML = `<summary>Suggested JSON-LD</summary><pre></pre><button class="small-btn">Copy JSON-LD</button>`;
    let pretty = r.suggested_json_ld;
    try {
      pretty = JSON.stringify(JSON.parse(pretty), null, 2);
    } catch {}
    det.querySelector("pre").textContent = pretty;
    det.querySelector("button").onclick = (e) => copyText(`<script type="application/ld+json">\n${pretty}\n</script>`, e.target);
    ld.append(det);
  }
  const cost = ai.cost != null ? ` · about $${ai.cost.toFixed(3)}` : "";
  const cached = ai.usage?.cache_read_input_tokens ? ` · ${ai.usage.cache_read_input_tokens.toLocaleString()} tokens from cache` : "";
  wrap.querySelector(".ai-meta").textContent = `${ai.model} · ${new Date(ai.at).toLocaleString()}${cost}${cached}. Findings appear in the list below.`;
  body.replaceChildren(wrap);
  if (state.run?.aiError) body.append(Object.assign(document.createElement("p"), { className: "err small", textContent: state.run.aiError }));
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
  if (!state.snap) return;
  const ctrl = new AbortController();
  state.claudeAbort = ctrl;
  renderClaude();
  const url = state.url;
  try {
    const { review, usage, model, refs } = await askClaude({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      effort: state.settings.effort,
      snap: state.snap,
      result: state.result,
      signal: ctrl.signal,
      onProgress: (n) => renderClaude(n),
    });
    const run = await loadRun(url);
    run.ai = { review, usage, model, refs, at: Date.now(), cost: estimateCost(model, usage) };
    run.aiMarked = {}; // a fresh review replaces the previous findings
    delete run.aiError;
    await saveRun(url, run);
    if (state.url === url) state.run = run;
  } catch (e) {
    if (state.url === url) {
      state.run.aiError = describeError(e);
    }
  } finally {
    state.claudeAbort = null;
    if (state.url === url) {
      renderClaude();
      renderIssues();
      if (state.highlight) highlightAll();
    }
  }
}

// ---------------------------------------------------------------- settings

function openSettings() {
  $("view-main").hidden = true;
  $("view-settings").hidden = false;
  $("set-key").value = state.settings.apiKey || "";
  $("set-model").replaceChildren(...MODELS.map((m) => new Option(m.label, m.id, false, m.id === state.settings.model)));
  $("set-effort").value = state.settings.effort;
  $("set-status").textContent = "";
}

function closeSettings() {
  $("view-settings").hidden = true;
  $("view-main").hidden = false;
  if (state.result) renderClaude();
}

async function saveSettings() {
  const key = $("set-key").value.trim();
  if (key && !/^sk-ant-/.test(key)) {
    $("set-status").textContent = 'That does not look like an Anthropic API key (it should start with "sk-ant-").';
    return;
  }
  state.settings = { apiKey: key, model: $("set-model").value, effort: $("set-effort").value };
  await chrome.storage.local.set({ settings: state.settings });
  $("set-status").textContent = "Saved.";
  setTimeout(closeSettings, 500);
}

// ---------------------------------------------------------------- wiring

$("btn-rescan").onclick = () => scan({ reason: "manual" });
$("btn-settings").onclick = () => ($("view-settings").hidden ? openSettings() : closeSettings());
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
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("run:")));
  $("set-status").textContent = "Scan history cleared.";
  state.result = null;
  closeSettings();
  scan();
};
$("btn-claude").onclick = onClaudeClick;
$("toggle-highlight").onchange = async (e) => {
  state.highlight = e.target.checked;
  await chrome.storage.local.set({ highlight: state.highlight });
  if (state.highlight) highlightAll();
  else if (state.tabId) send(state.tabId, { type: "aeo:clear" }).catch(() => {});
};
for (const b of document.querySelectorAll("#tabs button")) {
  b.onclick = () => {
    state.tab = b.dataset.tab;
    renderIssues();
  };
}

// Re-scan when the page reloads or the user switches tabs. The panel itself is
// not reloaded, so marked issues survive and get verified on the next scan.
let reloadTimer = null;
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  if (FIXED_TAB ? tabId !== FIXED_TAB : tabId !== state.tabId) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => scan({ reason: "reload" }), 400);
});
if (!FIXED_TAB) {
  chrome.tabs.onActivated.addListener(() => {
    state.claudeAbort?.abort();
    scan({ reason: "tab" });
  });
}

(async () => {
  await loadSettings();
  const got = await chrome.storage.local.get("highlight");
  state.highlight = !!got.highlight;
  $("toggle-highlight").checked = state.highlight;
  scan({ reason: "open" });
})();
