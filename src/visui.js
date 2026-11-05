// Side panel view for the AI visibility tracker.
import { VIS_PROJECT, VIS_RUNS, loadVis, saveRun, runTracker, runMetrics, suggestPrompts, captureToResult, cleanDomain, hostOf } from "./visibility.js";
import { ENGINES, engineForUrl, captureAnswer } from "./capture.js";
import { fetchInfo } from "./tech.js";
import { download, slug } from "./report.js";
import { describeError } from "./claude.js";

export const VIS_CAPTURES = "vis:captures";
export const VIS_LOCK = "vis:running";
export const ALARM = "vis-run";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (v) => (v == null ? "–" : `${v}%`);
const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

let ctx = null; // { state, setMode, openAndScan, currentTab, flash, colorFor }
const vis = { project: null, runs: [], captures: {}, engine: "all", abort: null, editing: false, captureTab: null };

export function initVis(c) {
  ctx = c;
  $("btn-open-vis").onclick = () => showVis();
  $("btn-vis-edit").onclick = () => showSetup();
  $("btn-vis-cancel").onclick = () => (vis.project ? showDash() : ctx.showHome());
  $("btn-vis-save").onclick = saveSetup;
  $("btn-vis-suggest").onclick = onSuggest;
  $("btn-vis-run").onclick = runNow;
  $("btn-vis-stop").onclick = () => vis.abort?.abort();
  $("btn-capture").onclick = onCapture;
  $("btn-reset-vis").onclick = async () => {
    await chrome.storage.local.remove([VIS_RUNS, VIS_CAPTURES]);
    $("set-status").textContent = "Visibility history cleared.";
  };
  chrome.storage.onChanged.addListener((changes) => {
    if (ctx.state.mode !== "vis" || vis.abort) return;
    if (changes[VIS_RUNS] || changes[VIS_CAPTURES]) reload().then(() => !vis.editing && renderDash());
  });
}

async function reload() {
  const got = await loadVis();
  vis.project = got.project;
  vis.runs = got.runs;
  vis.captures = (await chrome.storage.local.get(VIS_CAPTURES))[VIS_CAPTURES] || {};
}

export async function showVis() {
  ctx.setMode("vis");
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
  await reload();
  if (!vis.project) showSetup();
  else showDash();
  refreshCapture();
}

/** Show the capture card when the active tab is an AI assistant. */
export async function refreshCapture() {
  if (ctx.state.mode !== "vis") return;
  const tab = await ctx.currentTab();
  const engine = tab && engineForUrl(tab.url);
  vis.captureTab = engine ? { id: tab.id, engine, url: tab.url } : null;
  $("vis-capture").hidden = !engine || !vis.project;
  if (!engine || !vis.project) return;
  $("cap-title").textContent = `Capture this ${ENGINES[engine].label} answer`;
  $("cap-status").textContent = "";
  $("cap-prompt").replaceChildren(new Option("Detect from the page", ""), ...vis.project.prompts.map((p) => new Option(p.text, p.id)), new Option("Add the question on the page as a new prompt", "__new"));
}

// ---------------------------------------------------------------- setup

function showSetup() {
  vis.editing = true;
  $("vis-setup").hidden = false;
  $("vis-dash").hidden = true;
  const p = vis.project || {};
  $("vis-brand").value = p.brand || "";
  $("vis-aliases").value = (p.aliases || []).join(", ");
  $("vis-domain").value = p.domain || "";
  $("vis-competitors").value = (p.competitors || []).map((c) => `${c.name}, ${c.domain || ""}`.replace(/, $/, "")).join("\n");
  $("vis-prompts").value = (p.prompts || []).map((x) => x.text).join("\n");
  $("vis-schedule").value = p.schedule || "off";
  $("vis-setup-status").textContent = "";
  if (!p.domain) {
    ctx.currentTab().then((t) => {
      const h = hostOf(t?.url || "");
      if (h && !engineForUrl(t.url) && !$("vis-domain").value) $("vis-domain").value = h;
    });
  }
}

function readSetup() {
  const competitors = $("vis-competitors")
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, domain] = l.split(/\s*,\s*/);
      const d = cleanDomain(domain || (/\.[a-z]{2,}$/i.test(name) ? name : ""));
      return { name: name.trim(), domain: d };
    });
  const old = vis.project?.prompts || [];
  const prompts = [...new Set($("vis-prompts").value.split("\n").map((l) => l.trim()).filter(Boolean))].slice(0, 50).map((text) => old.find((o) => o.text === text) || { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text });
  return {
    brand: $("vis-brand").value.trim(),
    aliases: $("vis-aliases").value.split(",").map((s) => s.trim()).filter(Boolean),
    domain: cleanDomain($("vis-domain").value),
    competitors,
    prompts,
    schedule: $("vis-schedule").value,
  };
}

async function saveSetup() {
  const p = readSetup();
  const msg = !p.brand ? "Add your brand name." : !p.domain ? "Add your domain." : !p.prompts.length ? "Add at least one prompt, or let Claude suggest some." : "";
  if (msg) {
    $("vis-setup-status").textContent = msg;
    return;
  }
  vis.project = { ...vis.project, ...p, updatedAt: Date.now() };
  await chrome.storage.local.set({ [VIS_PROJECT]: vis.project });
  await chrome.alarms.clear(ALARM);
  if (p.schedule !== "off") {
    const period = p.schedule === "daily" ? 1440 : 10080;
    await chrome.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: period });
  }
  showDash();
  refreshCapture();
}

async function siteContext(domain) {
  const tab = await ctx.currentTab();
  const parts = [];
  for (const url of [`https://${domain}/`, tab && hostOf(tab.url).endsWith(domain) ? tab.url : null].filter(Boolean)) {
    try {
      const r = await fetchInfo(url, { timeoutMs: 10000 });
      if (!r.text) continue;
      const doc = new DOMParser().parseFromString(r.text, "text/html");
      doc.querySelectorAll("script, style, noscript, svg").forEach((n) => n.remove());
      parts.push(`URL: ${url}\nTitle: ${doc.title}\nDescription: ${doc.querySelector('meta[name="description"]')?.content || ""}\n${(doc.body?.innerText || doc.body?.textContent || "").replace(/\s+/g, " ").slice(0, 5000)}`);
    } catch {}
  }
  return parts.join("\n\n");
}

async function onSuggest() {
  const s = ctx.state.settings;
  const p = readSetup();
  const status = $("vis-setup-status");
  if (!s.apiKey) {
    status.textContent = "Add your Anthropic API key in Settings first.";
    return;
  }
  if (!p.brand || !p.domain) {
    status.textContent = "Add your brand name and domain first, so Claude can read your site.";
    return;
  }
  const btn = $("btn-vis-suggest");
  btn.disabled = true;
  status.textContent = `Reading ${p.domain} and writing prompts…`;
  try {
    const list = await suggestPrompts({ apiKey: s.apiKey, model: s.model, project: p, siteContext: await siteContext(p.domain) });
    const existing = $("vis-prompts").value.trim();
    const have = new Set(existing.split("\n").map(norm));
    const add = list.map((x) => x.text).filter((t) => !have.has(norm(t)));
    $("vis-prompts").value = [existing, ...add].filter(Boolean).join("\n");
    status.textContent = `Added ${add.length} prompts. Edit or delete any that your buyers would not ask.`;
  } catch (e) {
    status.textContent = describeError(e);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- runs

async function runNow() {
  const s = ctx.state.settings;
  if (!s.apiKey) {
    showError("Add your Anthropic API key in Settings to run prompts. You can still capture answers from ChatGPT, Perplexity and Google tabs without one.");
    return;
  }
  const lock = (await chrome.storage.local.get(VIS_LOCK))[VIS_LOCK];
  if (lock && Date.now() - lock < 20 * 60_000) {
    showError("A scheduled run is in progress. It will show up here when it finishes.");
    return;
  }
  vis.abort = new AbortController();
  await chrome.storage.local.set({ [VIS_LOCK]: Date.now() });
  $("vis-error").hidden = true;
  $("vis-progress").hidden = false;
  $("btn-vis-run").disabled = true;
  const project = vis.project;
  try {
    const { results, cost } = await runTracker({
      apiKey: s.apiKey,
      model: s.model,
      project,
      signal: vis.abort.signal,
      onProgress: ({ done, total, prompt }) => {
        $("vis-status").textContent = `Asking prompt ${Math.min(done + 1, total)} of ${total}…`;
        $("vis-bar").style.width = `${Math.round((done / total) * 100)}%`;
        $("vis-now").textContent = prompt || "";
      },
    });
    if (results.length) {
      const errors = results.filter((r) => r.error);
      vis.runs = await saveRun({ at: Date.now(), model: s.model, results, metrics: runMetrics(project, results), cost, aborted: vis.abort.signal.aborted });
      if (errors.length === results.length) showError(`Every prompt failed. First error: ${errors[0].error}`);
      else if (errors.length) showError(`${errors.length} of ${results.length} prompts failed. First error: ${errors[0].error}`);
    }
  } catch (e) {
    showError(describeError(e));
  } finally {
    await chrome.storage.local.remove(VIS_LOCK);
    vis.abort = null;
    $("vis-progress").hidden = true;
    $("btn-vis-run").disabled = false;
    renderDash();
  }
}

function showError(msg) {
  $("vis-error").textContent = msg;
  $("vis-error").hidden = false;
}

async function onCapture() {
  const t = vis.captureTab;
  if (!t) return;
  const status = $("cap-status");
  status.className = "small";
  try {
    const [{ result: got }] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: captureAnswer, args: [t.engine] });
    if (!got || got.error) throw new Error(got?.error || "Nothing captured.");
    let promptId = $("cap-prompt").value;
    let promptText = "";
    const q = norm(got.question);
    if (!promptId && q) {
      const hit = vis.project.prompts.find((p) => norm(p.text) === q) || vis.project.prompts.find((p) => q.includes(norm(p.text)) || norm(p.text).includes(q));
      promptId = hit?.id || "__new";
    }
    if (promptId === "__new") {
      if (!got.question) throw new Error("Could not read the question on this page. Pick the prompt from the list.");
      const p = { id: `p${Date.now().toString(36)}`, text: got.question };
      vis.project.prompts.push(p);
      await chrome.storage.local.set({ [VIS_PROJECT]: vis.project });
      promptId = p.id;
    }
    if (!promptId) throw new Error("Could not tell which prompt this answers. Pick it from the list.");
    promptText = vis.project.prompts.find((p) => p.id === promptId)?.text || got.question;
    const res = captureToResult(vis.project, { promptId, prompt: promptText, engine: t.engine, text: got.text, links: got.links, url: t.url });
    vis.captures[`${promptId}|${t.engine}`] = res;
    await chrome.storage.local.set({ [VIS_CAPTURES]: vis.captures });
    const b = res.analysis.brand;
    status.textContent = `Captured ${got.text.length.toLocaleString()} characters and ${got.links.length} links${got.how === "selection" ? " from your selection" : ""}. ${b.mentioned ? `${vis.project.brand} is mentioned (#${b.position})${b.cited.length ? " and your site is cited" : ""}.` : `${vis.project.brand} is not mentioned.`}`;
    renderDash();
  } catch (e) {
    status.className = "small err";
    status.textContent = String(e.message || e);
  }
}

// ---------------------------------------------------------------- dashboard

function showDash() {
  vis.editing = false;
  $("vis-setup").hidden = true;
  $("vis-dash").hidden = false;
  renderDash();
}

function resultsFor(engine) {
  const latest = vis.runs[vis.runs.length - 1];
  const claude = engine === "all" || engine === "claude" ? latest?.results || [] : [];
  const caps = Object.values(vis.captures).filter((c) => (engine === "all" || c.engine === engine) && vis.project.prompts.some((p) => p.id === c.promptId));
  // re-analyse with the current brand and competitor list, in case it changed
  return [...claude, ...caps.map((c) => ({ ...c, analysis: captureToResult(vis.project, { ...c, text: c.answer, links: c.citations.map((x) => ({ href: x.url, text: x.title })) }).analysis }))];
}

export function renderDash() {
  if (!vis.project || vis.editing) return;
  const p = vis.project;
  const latest = vis.runs[vis.runs.length - 1];
  $("vis-name").textContent = `${p.brand} · ${p.domain}`;
  $("vis-meta").textContent = `${p.prompts.length} prompts · ${p.competitors.length} competitors · ${latest ? `last run ${new Date(latest.at).toLocaleString()}${latest.cost ? ` (≈$${latest.cost.toFixed(2)})` : ""}` : "not run yet"}${p.schedule !== "off" ? ` · re-runs ${p.schedule}` : ""}`;

  const engines = ["all", ...(vis.runs.length ? ["claude"] : []), ...new Set(Object.values(vis.captures).map((c) => c.engine))];
  if (!engines.includes(vis.engine)) vis.engine = "all";
  $("vis-engines").replaceChildren(
    ...(engines.length > 2
      ? engines.map((e) => {
          const b = document.createElement("button");
          b.textContent = e === "all" ? "All engines" : ENGINES[e]?.label || e;
          b.setAttribute("aria-pressed", String(e === vis.engine));
          b.onclick = () => {
            vis.engine = e;
            renderDash();
          };
          return b;
        })
      : []),
  );

  const results = resultsFor(vis.engine);
  const has = results.some((r) => r.analysis);
  $("vis-body").hidden = !has;
  $("vis-empty").hidden = has;
  if (!has) {
    $("vis-empty").textContent = "No answers yet. Click Run now to ask every prompt with Claude and web search, or open a prompt in ChatGPT, Perplexity or Google AI Mode from the list below and capture the answer.";
    $("vis-body").hidden = false;
    for (const id of ["vis-mention", "vis-cite", "vis-sov", "vis-pos"]) $(id).textContent = "–";
    $("vis-sentiment").textContent = "";
    $("vis-trend").replaceChildren();
    $("vis-table").replaceChildren();
    $("vis-domains").replaceChildren();
    renderPrompts([]);
    return;
  }
  const m = runMetrics(p, results);
  const b = m.brand;
  $("vis-mention").textContent = pct(b.mentionRate);
  $("vis-mention").style.color = ctx.colorFor(b.mentionRate);
  $("vis-cite").textContent = pct(b.citationRate);
  $("vis-cite").style.color = ctx.colorFor(b.citationRate);
  $("vis-sov").textContent = pct(b.shareOfVoice);
  $("vis-pos").textContent = b.avgPosition == null ? "–" : `#${b.avgPosition}`;
  const s = m.sentiments;
  const sTotal = s.positive + s.neutral + s.negative;
  $("vis-sentiment").textContent = `${m.prompts} answers${m.errors ? `, ${m.errors} failed` : ""}. ${sTotal ? `When mentioned: ${s.positive} positive, ${s.neutral} neutral, ${s.negative} negative.` : ""}`;

  renderTrend();

  const rows = Object.entries(m.entities).sort((a, b2) => b2[1].mentions - a[1].mentions);
  $("vis-table").innerHTML = `<tr><th>Brand</th><th>Mentioned</th><th>Cited</th><th>Avg pos.</th><th>Share</th></tr>${rows.map(([k, e]) => `<tr class="${k === "brand" ? "you" : ""}"><td>${esc(e.name)}${k === "brand" ? " (you)" : ""}</td><td>${e.mentionRate}%</td><td>${e.citationRate}%</td><td>${e.avgPosition == null ? "–" : `#${e.avgPosition}`}</td><td>${e.shareOfVoice}%</td></tr>`).join("")}`;

  const max = m.topDomains[0]?.count || 1;
  $("vis-domains").innerHTML = m.topDomains.length
    ? m.topDomains
        .slice(0, 10)
        .map((d) => `<div class="d ${d.yours ? "you" : d.competitor ? "comp" : ""}"><span>${esc(d.domain)}${d.yours ? " (you)" : d.competitor ? ` (${esc(d.competitor)})` : ""}</span><span>${d.count}</span><div class="bar"><span style="width:${Math.round((d.count / max) * 100)}%"></span></div></div>`)
        .join("")
    : `<p class="muted small">No sources were cited.</p>`;

  renderPrompts(results);
}

function renderTrend() {
  const runs = vis.runs.filter((r) => r.metrics?.brand);
  const box = $("vis-trend");
  if (runs.length < 2 || (vis.engine !== "all" && vis.engine !== "claude")) {
    box.replaceChildren();
    return;
  }
  const W = 300;
  const H = 70;
  const x = (i) => 6 + (i / (runs.length - 1)) * (W - 12);
  const y = (v) => H - 6 - (v / 100) * (H - 12);
  const line = (key, color) => `<polyline fill="none" stroke="${color}" stroke-width="2" points="${runs.map((r, i) => `${x(i).toFixed(1)},${y(r.metrics.brand[key]).toFixed(1)}`).join(" ")}"/>`;
  box.className = "vis-trend";
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Mention and citation rate over the last ${runs.length} runs"><line x1="0" x2="${W}" y1="${y(50)}" y2="${y(50)}" stroke="var(--line)" stroke-dasharray="3 3"/>${line("mentionRate", "var(--accent)")}${line("citationRate", "var(--good)")}${line("shareOfVoice", "var(--ai)")}</svg><div class="trend-legend"><span><i style="background:var(--accent)"></i>Mentioned</span><span><i style="background:var(--good)"></i>Cited</span><span><i style="background:var(--ai)"></i>Share of voice</span><span>${runs.length} runs since ${new Date(runs[0].at).toLocaleDateString()}</span></div>`;
}

function markNames(text) {
  const p = vis.project;
  const who = new Map();
  for (const n of [p.brand, ...(p.aliases || [])]) if (n && n.length >= 2) who.set(n.toLowerCase(), "");
  for (const c of p.competitors) if (c.name && c.name.length >= 2 && !who.has(c.name.toLowerCase())) who.set(c.name.toLowerCase(), "c");
  const names = [...who.keys()].sort((a, b) => b.length - a.length);
  if (!names.length) return esc(text);
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?=$|[^\\p{L}\\p{N}])`, "giu");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index + m[1].length;
    out += esc(text.slice(last, start)) + `<mark${who.get(m[2].toLowerCase()) ? ' class="c"' : ""}>${esc(m[2])}</mark>`;
    last = start + m[2].length;
  }
  return out + esc(text.slice(last));
}

function renderPrompts(results) {
  const p = vis.project;
  const byPrompt = new Map(p.prompts.map((x) => [x.id, []]));
  for (const r of results) byPrompt.get(r.promptId)?.push(r);
  const status = (rs) => {
    const ok = rs.filter((r) => r.analysis);
    if (!ok.length) return "none";
    if (ok.some((r) => r.analysis.brand.mentioned)) return "won";
    if (ok.some((r) => Object.entries(r.analysis).some(([k, v]) => k !== "brand" && v.mentioned))) return "gap";
    return "miss";
  };
  const order = { gap: 0, miss: 1, none: 2, won: 3 };
  const list = p.prompts.map((pr) => ({ pr, rs: byPrompt.get(pr.id), st: status(byPrompt.get(pr.id)) })).sort((a, b) => order[a.st] - order[b.st]);
  $("vis-prompts-list").replaceChildren(...list.map(promptCard));
}

function promptCard({ pr, rs, st }) {
  const p = vis.project;
  const el = document.createElement("article");
  el.className = `issue ${st === "won" ? "won" : st === "gap" ? "gap" : "miss"}`;
  const label = { won: ["pass", "Mentioned"], gap: ["major", "Gap"], miss: ["info", "Nobody"], none: ["info", "Not run"] }[st];
  const lines = rs.map((r) => {
    const eng = ENGINES[r.engine]?.label || r.engine;
    if (r.error) return `<div class="eng-line"><b>${esc(eng)}:</b> <span class="err">failed: ${esc(r.error.slice(0, 160))}</span></div>`;
    const b = r.analysis.brand;
    const comps = Object.entries(r.analysis).filter(([k, v]) => k !== "brand" && v.mentioned).map(([, v]) => `${v.name} #${v.position}`);
    return `<div class="eng-line"><b>${esc(eng)}:</b> ${b.mentioned ? `you are #${b.position}` : "you are not mentioned"}${b.cited.length ? ", your site is cited" : ""}${r.sentiment ? `, ${r.sentiment.sentiment}` : ""}${comps.length ? `. Competitors: ${esc(comps.join(", "))}` : ""}.</div>`;
  });
  el.innerHTML = `<div class="issue-head"><span class="sev ${label[0]}">${label[1]}</span><h3 class="issue-title"></h3></div><div class="eng-results">${lines.join("")}</div>`;
  el.querySelector(".issue-title").textContent = pr.text;
  const withAnswers = rs.filter((r) => r.answer || r.citations?.length);
  if (withAnswers.length) {
    const d = document.createElement("details");
    d.className = "issue-fix";
    d.innerHTML = `<summary>Show answer${withAnswers.length > 1 ? "s" : ""} and sources</summary>${withAnswers
      .map(
        (r) =>
          `<p class="small"><b>${esc(ENGINES[r.engine]?.label || r.engine)}</b>${r.captured ? " (captured)" : ""} · ${new Date(r.at).toLocaleString()}${r.sentiment?.reason ? ` · ${esc(r.sentiment.reason)}` : ""}</p>${r.answer ? `<div class="answer">${markNames(r.answer)}</div>` : ""}${
            r.citations?.length
              ? `<ol class="cites">${r.citations
                  .slice(0, 12)
                  .map((c) => {
                    const h = hostOf(c.url);
                    const you = h === p.domain || h.endsWith(`.${p.domain}`);
                    const comp = p.competitors.find((x) => x.domain && (h === x.domain || h.endsWith(`.${x.domain}`)));
                    return `<li class="${you ? "you" : comp ? "comp" : ""}">${esc(c.title || h)} · ${esc(c.url)}</li>`;
                  })
                  .join("")}</ol>`
              : ""
          }`,
      )
      .join("")}`;
    el.append(d);
  }
  const actions = document.createElement("div");
  actions.className = "issue-actions";
  actions.innerHTML = `<span class="chips"></span>`;
  for (const e of ["chatgpt", "perplexity", "google"]) {
    const b = document.createElement("button");
    b.className = "small-btn";
    b.textContent = `Ask ${ENGINES[e].label.replace(" AI Mode", " AI")}`;
    b.title = `Open this prompt in ${ENGINES[e].label}, then capture the answer here`;
    b.onclick = () => chrome.tabs.create({ url: ENGINES[e].ask(pr.text) });
    actions.append(b);
  }
  if (st === "gap") {
    // the competitor page that won the citation, to compare against
    const compUrl = rs.flatMap((r) => Object.entries(r.analysis || {}).filter(([k]) => k !== "brand").flatMap(([, v]) => v.cited))[0];
    if (compUrl) {
      const b = document.createElement("button");
      b.className = "small-btn";
      b.textContent = "Scan cited competitor page";
      b.title = compUrl;
      b.onclick = () => ctx.openAndScan(compUrl);
      actions.append(b);
    }
    const mine = document.createElement("button");
    mine.className = "small-btn";
    mine.textContent = "Scan my site";
    mine.onclick = () => ctx.openAndScan(`https://${p.domain}/`);
    actions.append(mine);
  }
  el.append(actions);
  return el;
}

// ---------------------------------------------------------------- export

export function visDownload(format) {
  const p = vis.project;
  if (!p) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const results = resultsFor("all");
  if (format === "vis-csv") {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const comps = p.competitors.map((c, i) => [`c${i}`, c.name]);
    const head = ["Prompt", "Engine", "Date", "Brand mentioned", "Brand position", "Site cited", "Sentiment", ...comps.map(([, n]) => `${n} position`), "Cited URLs", "Error"];
    const rows = results.map((r) => [r.prompt, ENGINES[r.engine]?.label || r.engine, new Date(r.at).toISOString(), r.analysis?.brand.mentioned ? "yes" : "no", r.analysis?.brand.position ?? "", r.analysis?.brand.cited.length ? "yes" : "no", r.sentiment?.sentiment || "", ...comps.map(([k]) => r.analysis?.[k]?.position ?? ""), (r.citations || []).map((c) => c.url).join(" "), r.error || ""]);
    download(`ai-visibility-${slug(p.domain)}-${stamp}.csv`, [head, ...rows].map((r) => r.map(cell).join(",")).join("\n"), "text/csv");
    return;
  }
  download(`ai-visibility-${slug(p.domain)}-${stamp}.html`, visReportHtml(p, results, vis.runs), "text/html");
}

export function visReportHtml(p, results, runs) {
  const m = runMetrics(p, results);
  const ents = Object.entries(m.entities).sort((a, b) => b[1].mentions - a[1].mentions);
  const trend = runs.filter((r) => r.metrics?.brand).map((r) => `<tr><td>${new Date(r.at).toLocaleDateString()}</td><td>${r.metrics.brand.mentionRate}%</td><td>${r.metrics.brand.citationRate}%</td><td>${r.metrics.brand.shareOfVoice}%</td><td>${r.metrics.brand.avgPosition ?? "–"}</td></tr>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI visibility: ${esc(p.brand)}</title><style>
:root{--t:#1d2228;--m:#5f6773;--l:#e3e6ea;--g:#188038;--o:#e8710a;--bg:#fff}
@media (prefers-color-scheme:dark){:root{--t:#e8eaed;--m:#a0a7b1;--l:#353a41;--g:#81c995;--o:#fcad70;--bg:#1b1d21}}
body{font:14px/1.5 system-ui,sans-serif;max-width:900px;margin:0 auto;padding:24px 16px;color:var(--t);background:var(--bg)}
table{border-collapse:collapse;width:100%;margin:8px 0 20px}td,th{border-bottom:1px solid var(--l);padding:6px;text-align:left;vertical-align:top}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.tile{border:1px solid var(--l);border-radius:8px;padding:10px}.tile b{display:block;font-size:26px}
.m{color:var(--m)}.you{color:var(--g);font-weight:600}.gap{color:var(--o);font-weight:600}
</style></head><body>
<h1>AI visibility: ${esc(p.brand)}</h1><p class="m">${esc(p.domain)} · ${m.prompts} answers across ${p.prompts.length} prompts · generated ${new Date().toLocaleString()} by AEO Scorer</p>
<div class="tiles"><div class="tile">Mentioned in<b>${m.brand.mentionRate}%</b></div><div class="tile">Site cited in<b>${m.brand.citationRate}%</b></div><div class="tile">Share of voice<b>${m.brand.shareOfVoice}%</b></div><div class="tile">Average position<b>${m.brand.avgPosition == null ? "–" : `#${m.brand.avgPosition}`}</b></div></div>
<h2>You vs competitors</h2><table><tr><th>Brand</th><th>Mentioned</th><th>Cited</th><th>Avg position</th><th>Share of voice</th></tr>${ents.map(([k, e]) => `<tr${k === "brand" ? ' class="you"' : ""}><td>${esc(e.name)}</td><td>${e.mentionRate}%</td><td>${e.citationRate}%</td><td>${e.avgPosition ?? "–"}</td><td>${e.shareOfVoice}%</td></tr>`).join("")}</table>
${trend.length > 1 ? `<h2>Trend (Claude runs)</h2><table><tr><th>Date</th><th>Mentioned</th><th>Cited</th><th>Share of voice</th><th>Avg position</th></tr>${trend.join("")}</table>` : ""}
<h2>Sources AI cites most</h2><table><tr><th>Domain</th><th>Citations</th></tr>${m.topDomains.map((d) => `<tr${d.yours ? ' class="you"' : ""}><td>${esc(d.domain)}${d.competitor ? ` (${esc(d.competitor)})` : ""}</td><td>${d.count}</td></tr>`).join("")}</table>
<h2>Prompts</h2><table><tr><th>Prompt</th><th>Engine</th><th>You</th><th>Competitors mentioned</th></tr>${results
    .map((r) => {
      if (r.error) return `<tr><td>${esc(r.prompt)}</td><td>${esc(ENGINES[r.engine]?.label || r.engine)}</td><td colspan="2">Failed: ${esc(r.error)}</td></tr>`;
      const b = r.analysis.brand;
      const comps = Object.entries(r.analysis).filter(([k, v]) => k !== "brand" && v.mentioned).map(([, v]) => `${v.name} (#${v.position})`);
      return `<tr><td>${esc(r.prompt)}</td><td>${esc(ENGINES[r.engine]?.label || r.engine)}</td><td class="${b.mentioned ? "you" : comps.length ? "gap" : ""}">${b.mentioned ? `#${b.position}${b.cited.length ? ", cited" : ""}` : comps.length ? "Gap" : "–"}</td><td>${esc(comps.join(", "))}</td></tr>`;
    })
    .join("")}</table>
<p class="m">Mentioned: the answer names the brand or cites its site. Cited: the answer links to the brand's domain. Share of voice: the brand's mentions as a share of all tracked brands' mentions. Position: order of first mention among tracked brands.</p>
</body></html>`;
}
