// Side panel view for competitor analysis.
import { COMP_KEY, questionFromPage, discoverFromAI, candidatesFromTracker, pickCompetitors, pageFacts, compare, buildWhyInput, explainWhy } from "./compete.js";
import { loadVis, hostOf, cleanDomain } from "./visibility.js";
import { VIS_CAPTURES } from "./visui.js";
import { scanUrls } from "./crawler.js";
import { describeError, estimateCost } from "./claude.js";
import { download, slug } from "./report.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SEV_LABEL = { critical: "critical", major: "major", minor: "minor" };

let ctx = null; // { state, setMode, currentTab, colorFor, openStoredPage, analyzePage, showHome }
const comp = { report: null, abort: null, whyAbort: null, lastInput: null };

export function initComp(c) {
  ctx = c;
  $("btn-open-comp").onclick = () => showComp();
  $("btn-compare-page").onclick = () => {
    const p = ctx.state.page;
    showComp({ url: p?.url, questions: p?.snap ? [questionFromPage(p.snap, p.run?.ai)] : [] });
  };
  $("btn-comp-run").onclick = () => run(readSetup());
  $("btn-comp-cancel").onclick = () => (comp.report ? renderReport() : ctx.showHome());
  $("btn-comp-edit").onclick = () => showSetup({});
  $("btn-comp-rerun").onclick = () => comp.report && run({ url: comp.report.you.url, questions: comp.report.questions, manual: comp.report.manual || [], useAI: comp.report.usedAI, max: comp.report.max || 5 });
  $("btn-comp-stop").onclick = () => comp.abort?.abort();
  $("btn-comp-why").onclick = onWhy;
}

/** Open the view. With prefill, start a new analysis form; otherwise show the last report for the current site. */
export async function showComp(prefill) {
  ctx.setMode("comp");
  if (!prefill) {
    const tab = await ctx.currentTab();
    const host = hostOf(tab?.url || "");
    const saved = host && (await chrome.storage.local.get(COMP_KEY(host)))[COMP_KEY(host)];
    if (saved) {
      comp.report = saved;
      return renderReport();
    }
  }
  showSetup(prefill || {});
}

function show(part) {
  $("comp-setup").hidden = part !== "setup";
  $("comp-report").hidden = part !== "report";
}

async function showSetup({ url, questions, manual }) {
  show("setup");
  $("comp-progress").hidden = true;
  const tab = await ctx.currentTab();
  const p = ctx.state.page;
  $("comp-url").value = url || p?.url || (/^https?:/.test(tab?.url || "") ? tab.url : "");
  let qs = questions?.filter(Boolean) || [];
  if (!qs.length && p?.snap) qs = [questionFromPage(p.snap, p.run?.ai)];
  $("comp-questions").value = qs.join("\n");
  $("comp-manual").value = (manual || []).join("\n");
  $("comp-ai").checked = !!ctx.state.settings.apiKey;
  $("comp-setup-status").textContent = ctx.state.settings.apiKey ? "" : "Without an API key, competitors come from your AI visibility tracker results and the URLs you add.";
}

function readSetup() {
  let url = $("comp-url").value.trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return {
    url,
    questions: [...new Set($("comp-questions").value.split("\n").map((s) => s.trim()).filter(Boolean))].slice(0, 5),
    manual: $("comp-manual").value.split("\n").map((s) => s.trim()).filter(Boolean).map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`)).filter((u) => { try { return !!new URL(u); } catch { return false; } }).slice(0, 8),
    useAI: $("comp-ai").checked,
    max: Number($("comp-max").value) || 5,
  };
}

function progress(text, done, total, now = "") {
  $("comp-progress").hidden = false;
  $("comp-status").textContent = text;
  $("comp-bar").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $("comp-now").textContent = now;
}

async function run(opts) {
  const s = ctx.state.settings;
  const status = $("comp-setup-status");
  try {
    new URL(opts.url);
  } catch {
    show("setup");
    status.textContent = "Enter the URL of your page.";
    return;
  }
  if (opts.useAI && !s.apiKey) {
    show("setup");
    status.textContent = "Add your Anthropic API key in Settings, or untick “Find competitors from AI answers” and add competitor URLs.";
    return;
  }
  if (opts.useAI && !opts.questions.length) {
    show("setup");
    status.textContent = "Add at least one question that this page should win.";
    return;
  }
  const yourDomain = hostOf(opts.url);
  comp.abort = new AbortController();
  const signal = comp.abort.signal;
  show(null);
  $("btn-comp-run").disabled = true;
  try {
    // 1. who AI cites
    let answers = [];
    let candidates = [];
    let cost = 0;
    if (opts.useAI) {
      const d = await discoverFromAI({ apiKey: s.apiKey, model: s.model, questions: opts.questions, yourDomain, signal, onProgress: (p) => progress(`Asking AI question ${p.done + 1} of ${p.total}…`, p.done, p.total + 1, p.text) });
      answers = d.answers;
      candidates = d.candidates;
      for (const a of answers) if (a.usage) cost += (estimateCost(s.model, a.usage) || 0) + (a.usage.web_search_requests || 0) * 0.01;
      const failed = answers.filter((a) => a.error);
      if (failed.length === answers.length && answers.length) throw new Error(`AI search failed: ${failed[0].error}`);
    } else {
      const { runs } = await loadVis();
      const captures = (await chrome.storage.local.get(VIS_CAPTURES))[VIS_CAPTURES] || {};
      candidates = candidatesFromTracker(runs, captures, yourDomain);
    }
    if (signal.aborted) throw new Error("Stopped.");
    const picked = pickCompetitors(candidates, opts.manual, opts.max);
    if (!picked.length) throw new Error(opts.useAI ? "AI answers did not cite any competitor pages for these questions. Try broader questions or add competitor URLs." : "No competitors found. Add competitor URLs, or run the AI visibility tracker first.");

    // 2. score your page and theirs with the same rules
    const urls = [opts.url, ...picked.map((c) => c.url)];
    const pages = await scanUrls({
      urls,
      signal,
      onProgress: (p) => progress(p.done === 0 ? "Scoring your page…" : `Scoring competitor ${p.done} of ${p.total - 1}…`, p.done + (opts.useAI ? 1 : 0), p.total + (opts.useAI ? 1 : 0), p.url),
      analyze: async (tabId, url) => {
        const { snap, result, a11y, httpStatus } = await ctx.analyzePage(tabId, url);
        if (httpStatus >= 400) return { url, host: hostOf(url), title: snap.title, error: `HTTP ${httpStatus}` };
        return {
          url: snap.url,
          host: hostOf(snap.url),
          title: snap.title,
          score: result.score,
          grade: result.grade,
          blockers: result.blockers,
          a11yScore: a11y?.score ?? null,
          categories: Object.fromEntries(Object.entries(result.categories).map(([k, v]) => [k, { score: v.score }])),
          checks: result.checks.map(({ id, pass, severity, title, category, fix }) => ({ id, pass, severity, title, category, fix })),
          facts: pageFacts(snap, result),
          excerpt: String(snap.text || "").slice(0, 2500),
        };
      },
    });
    if (!pages.length || pages[0].error) throw new Error(`Could not score your page: ${pages[0]?.error || "stopped"}`);
    const you = { ...pages[0], cited: answers.filter((a) => a.youCited).length, questions: answers.filter((a) => a.youCited).map((a) => a.question) };
    const competitors = pages.slice(1).map((p, i) => ({ ...picked[i], ...p, host: picked[i].host }));
    const report = {
      at: Date.now(),
      questions: opts.questions,
      manual: opts.manual,
      usedAI: opts.useAI,
      max: opts.max,
      answers: answers.map(({ usage, ...a }) => ({ ...a, answer: (a.answer || "").slice(0, 4000) })),
      you,
      competitors,
      cmp: compare(you, competitors),
      cost,
      aborted: signal.aborted,
    };
    await chrome.storage.local.set({ [COMP_KEY(you.host)]: report });
    comp.report = report;
    renderReport();
  } catch (e) {
    show("setup");
    $("comp-setup-status").textContent = signal.aborted ? "Stopped." : describeError(e);
  } finally {
    comp.abort = null;
    $("comp-progress").hidden = true;
    $("btn-comp-run").disabled = false;
  }
}

// ---------------------------------------------------------------- render

function ranking(r) {
  const rows = [{ ...r.you, isYou: true }, ...r.competitors];
  return rows.sort((a, b) => !!a.error - !!b.error || (b.cited || 0) - (a.cited || 0) || (b.score ?? -1) - (a.score ?? -1));
}

export function renderReport() {
  const r = comp.report;
  if (!r) return showSetup({});
  show("report");
  ctx.setMode("comp");
  const ok = r.competitors.filter((c) => !c.error);
  const asked = r.answers.filter((a) => !a.error).length;
  $("comp-name").textContent = `${r.you.host} vs ${ok.length} competitors`;
  $("comp-meta").textContent = `${r.questions.length ? `${r.questions.length} question${r.questions.length > 1 ? "s" : ""} · ` : ""}${new Date(r.at).toLocaleString()}${r.cost ? ` · ≈$${r.cost.toFixed(2)}` : ""}${r.usedAI ? "" : " · competitors from your tracker and the URLs you added"}`;
  $("comp-you").textContent = r.you.score;
  $("comp-you").style.color = ctx.colorFor(r.you.score);
  $("comp-median").textContent = r.cmp.medianScore ?? "–";
  $("comp-median").style.color = ctx.colorFor(r.cmp.medianScore ?? 0);
  if (asked) {
    $("comp-cited-label").textContent = "AI cited you in";
    $("comp-cited").textContent = `${r.you.cited}/${asked}`;
    $("comp-cited").style.color = r.you.cited ? "var(--good)" : "var(--critical)";
  } else {
    $("comp-cited-label").textContent = "Competitors ahead";
    $("comp-cited").textContent = `${r.cmp.ahead}/${ok.length}`;
    $("comp-cited").style.color = "";
  }
  const lead = ranking(r).filter((x) => !x.error);
  const pos = lead.findIndex((x) => x.isYou) + 1;
  $("comp-verdict").textContent =
    `You rank #${pos} of ${lead.length}. ` +
    (asked ? `AI cited you for ${r.you.cited} of ${asked} question${asked > 1 ? "s" : ""}; ${r.cmp.citedAhead} competitor${r.cmp.citedAhead === 1 ? " was" : "s were"} cited. ` : "") +
    (r.cmp.ahead ? `${r.cmp.ahead} of ${ok.length} competitors score higher on AEO. ` : `Your AEO score beats every competitor here, so the gap is likely content or authority. `) +
    (r.cmp.reasons.length ? `The biggest gap: ${r.cmp.reasons[0].title.toLowerCase()} (${r.cmp.reasons[0].passers.length} of ${r.cmp.reasons[0].judged} competitors have it).` : "");

  $("comp-rank").replaceChildren(
    ...ranking(r).map((p, i) => {
      const b = document.createElement("button");
      b.className = `rank-row${p.isYou ? " you" : ""}`;
      b.innerHTML = `<span class="n"></span><span class="t"></span><span class="c"></span><span class="s"></span><span class="u"></span>`;
      b.querySelector(".n").textContent = p.error ? "–" : i + 1;
      b.querySelector(".t").textContent = `${p.isYou ? "You · " : ""}${p.host}`;
      b.querySelector(".u").textContent = p.error ? `${p.url} · ${p.error}` : `${p.title || p.url}`;
      b.querySelector(".c").textContent = p.error ? "" : asked ? `cited ${p.cited || 0}×` : p.manual ? "added" : p.cited ? `cited ${p.cited}×` : "";
      b.querySelector(".s").textContent = p.error ? "" : p.score;
      b.querySelector(".s").style.color = ctx.colorFor(p.score ?? 0);
      b.title = p.error ? p.error : "Open the full report for this page";
      b.onclick = () => !p.error && ctx.openStoredPage(p.url, false);
      return b;
    }),
  );

  // reasons
  const reasons = r.cmp.reasons;
  const SHOW = 6;
  $("comp-reasons").replaceChildren(
    ...(reasons.length
      ? reasons.map((x, i) => {
          const el = document.createElement("article");
          el.className = `issue sev-${x.severity}`;
          el.innerHTML = `<div class="issue-head"><span class="sev ${x.severity}">${SEV_LABEL[x.severity] || x.severity}</span><h3 class="issue-title"></h3></div><p class="issue-detail"></p><details class="issue-fix"><summary>How to fix</summary><p class="fix-text"></p></details>`;
          el.querySelector(".issue-title").textContent = x.title;
          el.querySelector(".issue-detail").textContent = `${x.passers.length} of ${x.judged} competitors pass this: ${x.passers.join(", ")}. You don't.`;
          el.querySelector(".fix-text").textContent = x.fix || "";
          if (!x.fix) el.querySelector("details").remove();
          if (i >= SHOW) el.hidden = true;
          return el;
        }).concat(reasons.length > SHOW ? [Object.assign(document.createElement("button"), { className: "link", textContent: `Show ${reasons.length - SHOW} more`, onclick: (e) => { document.querySelectorAll("#comp-reasons .issue[hidden]").forEach((n) => (n.hidden = false)); e.target.remove(); } })] : [])
      : [Object.assign(document.createElement("p"), { className: "muted small", textContent: "No check that competitors pass and you fail. The difference is in content depth, authority or freshness; see below and ask Claude." })]),
  );
  $("comp-schema").innerHTML = r.cmp.schemaGaps.length ? `<p class="small"><b>Schema they use that you don't:</b> ${r.cmp.schemaGaps.map((g) => `${esc(g.type)} (${g.count})`).join(", ")}</p>` : "";

  $("comp-facts").innerHTML = `<tr><th>Signal</th><th>You</th><th>Median</th></tr>${r.cmp.facts.map((f) => `<tr><td>${esc(f.label)}</td><td class="${f.behind ? "behind" : ""}">${f.you ?? "–"}</td><td>${f.median ?? "–"}</td></tr>`).join("")}<tr><td>Named author</td><td class="${!r.you.facts.author && ok.filter((c) => c.facts?.author).length > ok.length / 2 ? "behind" : ""}">${r.you.facts.author ? "yes" : "no"}</td><td>${ok.filter((c) => c.facts?.author).length} of ${ok.length}</td></tr><tr><td>Direct answer under H1</td><td class="${r.you.facts.directAnswer === false && ok.filter((c) => c.facts?.directAnswer).length > ok.length / 2 ? "behind" : ""}">${r.you.facts.directAnswer ? "yes" : "no"}</td><td>${ok.filter((c) => c.facts?.directAnswer).length} of ${ok.length}</td></tr>`;

  $("comp-cats").innerHTML =
    r.cmp.categories.map((c) => `<div class="cmp-cat"><span>${esc(c.label)}</span><span class="muted">you ${c.you ?? "–"} · median ${c.median ?? "–"} · best ${c.best ?? "–"}</span><div class="bars"><div class="bar you"><span style="width:${c.you ?? 0}%"></span></div><div class="bar med"><span style="width:${c.median ?? 0}%"></span></div></div></div>`).join("") +
    `<div class="legend"><span><i style="background:var(--accent)"></i>You</span><span><i style="background:var(--muted)"></i>Competitor median</span></div>`;

  $("comp-strengths").innerHTML = r.cmp.strengths.length ? `<h3 class="sub">Where you're ahead</h3><ul class="why-list small">${r.cmp.strengths.map((x) => `<li>${esc(x.title)}: ${x.failers} of ${x.judged} competitors miss this.</li>`).join("")}</ul>` : "";

  $("comp-answers").innerHTML = r.answers.length
    ? `<h3 class="sub">What AI cited for each question</h3>${r.answers
        .map((a) =>
          a.error
            ? `<p class="small"><b>${esc(a.question)}</b> <span class="err">failed: ${esc(a.error.slice(0, 160))}</span></p>`
            : `<details class="issue-fix"><summary>${a.youCited ? "✓" : "✗"} ${esc(a.question)}</summary><div class="answer">${esc(a.answer)}</div><ol class="cites">${a.citations
                .slice(0, 10)
                .map((c) => `<li class="${hostOf(c.url) === r.you.host || hostOf(c.url).endsWith(`.${r.you.host}`) ? "you" : ""}">${esc(c.title || hostOf(c.url))} · ${esc(c.url)}</li>`)
                .join("")}</ol></details>`,
        )
        .join("")}`
    : "";
  renderWhy();
}

function renderWhy(progressText) {
  const r = comp.report;
  const box = $("comp-why");
  const btn = $("btn-comp-why");
  btn.disabled = !!comp.whyAbort;
  btn.textContent = comp.whyAbort ? "Thinking…" : r.why ? "Ask again" : "Explain with Claude";
  if (!ctx.state.settings.apiKey) {
    $("comp-claude-sub").textContent = "Add your Anthropic API key in Settings to get Claude's explanation and action plan.";
    btn.disabled = true;
  }
  if (progressText) {
    box.innerHTML = `<p class="muted small">${esc(progressText)}</p>`;
    return;
  }
  if (r.whyError) {
    box.innerHTML = `<p class="err small">${esc(r.whyError)}</p>`;
    return;
  }
  if (!r.why) {
    box.replaceChildren();
    return;
  }
  const w = r.why;
  box.innerHTML = `<p>${esc(w.summary)}</p><h3 class="sub">Why they rank higher</h3><ol class="why-list">${w.reasons.map((x) => `<li><b>${esc(x.title)}</b> <span class="chip">${esc(x.impact)} impact</span><br><span class="muted">${esc(x.evidence)}</span>${x.competitors.length ? `<br><span class="small muted">Seen on: ${esc(x.competitors.join(", "))}</span>` : ""}</li>`).join("")}</ol><h3 class="sub">Action plan</h3><ol class="why-list">${w.plan.map((x) => `<li><b>${esc(x.action)}</b> <span class="chip">${esc(x.effort)}</span><br>${esc(x.detail)}</li>`).join("")}</ol>`;
}

async function onWhy() {
  const r = comp.report;
  const s = ctx.state.settings;
  if (!r || !s.apiKey || comp.whyAbort) return;
  comp.whyAbort = new AbortController();
  delete r.whyError;
  renderWhy("Claude is comparing your page with the competitors…");
  try {
    const input = buildWhyInput({ questions: r.questions, you: r.you, competitors: r.competitors, cmp: r.cmp, answers: r.answers });
    const { why, usage, model } = await explainWhy({ apiKey: s.apiKey, model: s.model, effort: s.effort, input, signal: comp.whyAbort.signal });
    r.why = why;
    r.whyMeta = { model, cost: estimateCost(s.model, usage) };
  } catch (e) {
    r.whyError = describeError(e);
  } finally {
    comp.whyAbort = null;
    await chrome.storage.local.set({ [COMP_KEY(r.you.host)]: r });
    if (comp.report === r) renderWhy();
  }
}

// ---------------------------------------------------------------- export

export function compDownload(format) {
  const r = comp.report;
  if (!r) return;
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "comp-csv") {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = ranking(r);
    const head = ["Rank", "Site", "URL", "Yours", "AI citations", "AEO score", "Accessibility", ...r.cmp.categories.map((c) => c.label), ...r.cmp.facts.map((f) => f.label), "Schema types", "Error"];
    const lines = rows.map((p, i) => [p.error ? "" : i + 1, p.host, p.url, p.isYou ? "yes" : "", p.cited || 0, p.score ?? "", p.a11yScore ?? "", ...r.cmp.categories.map((c) => p.categories?.[c.key]?.score ?? ""), ...r.cmp.facts.map((f) => p.facts?.[f.key] ?? ""), (p.facts?.schemaTypes || []).join(" "), p.error || ""]);
    download(`competitors-${slug(r.you.host)}-${stamp}.csv`, [head, ...lines].map((l) => l.map(cell).join(",")).join("\r\n"), "text/csv");
    return;
  }
  download(`competitors-${slug(r.you.host)}-${stamp}.html`, compReportHtml(r), "text/html");
}

export function compReportHtml(r) {
  const rows = ranking(r);
  const ok = r.competitors.filter((c) => !c.error);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Competitor analysis: ${esc(r.you.host)}</title><style>
:root{--t:#1d2228;--m:#5f6773;--l:#e3e6ea;--g:#188038;--r:#d93025;--bg:#fff}
@media (prefers-color-scheme:dark){:root{--t:#e8eaed;--m:#a0a7b1;--l:#353a41;--g:#81c995;--r:#f28b82;--bg:#1b1d21}}
body{font:14px/1.5 system-ui,sans-serif;max-width:960px;margin:0 auto;padding:24px 16px;color:var(--t);background:var(--bg)}
table{border-collapse:collapse;width:100%;margin:8px 0 20px}td,th{border-bottom:1px solid var(--l);padding:6px;text-align:left;vertical-align:top}
.m{color:var(--m)}.you{font-weight:700}.bad{color:var(--r);font-weight:700}li{margin:6px 0}
</style></head><body>
<h1>Competitor analysis: ${esc(r.you.host)}</h1>
<p class="m">${esc(r.you.url)} · ${ok.length} competitors · ${new Date(r.at).toLocaleString()} · AEO Scorer</p>
${r.questions.length ? `<p><b>Questions:</b> ${r.questions.map(esc).join(" · ")}</p>` : ""}
<p>${esc($("comp-verdict")?.textContent || "")}</p>
<h2>Ranking</h2><table><tr><th>#</th><th>Site</th><th>Page</th><th>AI citations</th><th>AEO score</th><th>Accessibility</th></tr>${rows.map((p, i) => `<tr${p.isYou ? ' class="you"' : ""}><td>${p.error ? "–" : i + 1}</td><td>${esc(p.host)}${p.isYou ? " (you)" : ""}</td><td>${esc(p.title || "")}<br><span class="m">${esc(p.url)}</span>${p.error ? `<br><span class="bad">${esc(p.error)}</span>` : ""}</td><td>${p.cited || 0}</td><td>${p.score ?? "–"}</td><td>${p.a11yScore ?? "–"}</td></tr>`).join("")}</table>
${r.why ? `<h2>Why they win (Claude)</h2><p>${esc(r.why.summary)}</p><ol>${r.why.reasons.map((x) => `<li><b>${esc(x.title)}</b> (${esc(x.impact)} impact). ${esc(x.evidence)}${x.competitors.length ? ` <span class="m">Seen on: ${esc(x.competitors.join(", "))}</span>` : ""}</li>`).join("")}</ol><h2>Action plan</h2><ol>${r.why.plan.map((x) => `<li><b>${esc(x.action)}</b> (${esc(x.effort)}). ${esc(x.detail)}</li>`).join("")}</ol>` : ""}
<h2>What they do that you don't</h2>${r.cmp.reasons.length ? `<table><tr><th>Check</th><th>Severity</th><th>Competitors that pass</th><th>How to fix</th></tr>${r.cmp.reasons.map((x) => `<tr><td>${esc(x.title)}</td><td>${esc(x.severity)}</td><td>${x.passers.length} of ${x.judged}: ${esc(x.passers.join(", "))}</td><td>${esc(x.fix || "")}</td></tr>`).join("")}</table>` : "<p>None.</p>"}
${r.cmp.schemaGaps.length ? `<p><b>Schema they use that you don't:</b> ${r.cmp.schemaGaps.map((g) => `${esc(g.type)} (${g.count})`).join(", ")}</p>` : ""}
<h2>Content signals</h2><table><tr><th>Signal</th><th>You</th><th>Competitor median</th></tr>${r.cmp.facts.map((f) => `<tr><td>${esc(f.label)}</td><td class="${f.behind ? "bad" : ""}">${f.you ?? "–"}</td><td>${f.median ?? "–"}</td></tr>`).join("")}</table>
<h2>Score by area</h2><table><tr><th>Area</th><th>You</th><th>Median</th><th>Best</th></tr>${r.cmp.categories.map((c) => `<tr><td>${esc(c.label)}</td><td>${c.you ?? "–"}</td><td>${c.median ?? "–"}</td><td>${c.best ?? "–"}</td></tr>`).join("")}</table>
${r.answers.length ? `<h2>What AI cited</h2>${r.answers.map((a) => (a.error ? `<p><b>${esc(a.question)}</b>: failed</p>` : `<h3>${esc(a.question)}</h3><p>${a.youCited ? "Your site was cited." : '<span class="bad">Your site was not cited.</span>'}</p><ol>${a.citations.slice(0, 10).map((c) => `<li>${esc(c.title || "")} <span class="m">${esc(c.url)}</span></li>`).join("")}</ol>`)).join("")}` : ""}
<p class="m">AEO score: the same rule checks for every page (crawler access, head tags, structure, answer-first content, structured data, trust, technical). AI citations: how many of the questions above cited the page when answered by Claude with live web search.</p>
</body></html>`;
}
