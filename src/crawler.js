// Site crawler: visits same-site pages one at a time in a background tab, so
// each page is fully rendered (JavaScript included) before it is scored.
import { parseRobots, robotsVerdict } from "./rules.js";

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|avif|ico|zip|gz|mp4|mp3|webm|mov|css|js|mjs|json|xml|txt|rss|atom|woff2?|ttf|eot|docx?|xlsx?|pptx?|csv)$/i;
const SKIP_PATH = /\/(wp-admin|wp-login|login|logout|signin|sign-in|signout|sign-out|account|cart|checkout|basket|admin)(\/|$)/i;

export function normalizeUrl(u, keepQuery = false) {
  try {
    const url = new URL(u);
    url.hash = "";
    if (!keepQuery) url.search = "";
    if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    return url.href;
  } catch {
    return null;
  }
}

async function fetchText(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials: "omit", signal: ctrl.signal });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Read up to `limit` page URLs from the site's sitemaps (follows one level of sitemap index). */
export async function sitemapUrls(origin, robotsText, limit = 300) {
  const parsed = parseRobots(robotsText || "");
  const candidates = parsed.sitemaps.length ? parsed.sitemaps : [`${origin}/sitemap.xml`];
  const out = [];
  const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  for (const sm of candidates.slice(0, 3)) {
    const xml = await fetchText(sm);
    if (!xml) continue;
    if (/<sitemapindex/i.test(xml)) {
      for (const child of locs(xml).slice(0, 5)) {
        const cx = await fetchText(child);
        if (cx) out.push(...locs(cx));
        if (out.length >= limit) break;
      }
    } else out.push(...locs(xml));
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function waitForLoad(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * @param {object} o
 * @param {string} o.startUrl
 * @param {number} o.maxPages
 * @param {(tabId:number, url:string) => Promise<object>} o.analyze  returns a page record
 * @param {(p:object) => void} o.onProgress
 * @param {AbortSignal} o.signal
 */
export async function crawlSite({ startUrl, maxPages = 25, analyze, onProgress, signal, robotsText }) {
  const start = new URL(startUrl);
  const origin = start.origin;
  const host = start.hostname.replace(/^www\./, "");
  const robots = parseRobots(robotsText || "");
  const queue = [];
  const queued = new Set();
  const skipped = { robots: 0, other: 0 };

  const enqueue = (u, front = false) => {
    const n = normalizeUrl(u, u === startUrl);
    if (!n || queued.has(n)) return;
    let url;
    try {
      url = new URL(n);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || url.hostname.replace(/^www\./, "") !== host) return;
    if (SKIP_EXT.test(url.pathname) || SKIP_PATH.test(url.pathname)) {
      skipped.other++;
      return;
    }
    if (!robotsVerdict(robots, "*", url.pathname).allowed) {
      skipped.robots++;
      queued.add(n);
      return;
    }
    queued.add(n);
    front ? queue.unshift(n) : queue.push(n);
  };

  enqueue(startUrl);
  onProgress?.({ phase: "sitemap", done: 0, total: maxPages });
  const fromSitemap = await sitemapUrls(origin, robotsText, maxPages * 4);
  fromSitemap.forEach((u) => enqueue(u));

  const pages = [];
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  try {
    while (queue.length && pages.length < maxPages) {
      if (signal?.aborted) break;
      const url = queue.shift();
      onProgress?.({ phase: "page", url, done: pages.length, total: Math.min(maxPages, pages.length + queue.length + 1) });
      try {
        const loaded = waitForLoad(tab.id);
        await chrome.tabs.update(tab.id, { url });
        const ok = await loaded;
        await new Promise((r) => setTimeout(r, ok ? 700 : 0));
        const t = await chrome.tabs.get(tab.id);
        const finalHost = new URL(t.url).hostname.replace(/^www\./, "");
        if (finalHost !== host) {
          pages.push({ url, error: `Redirected off-site to ${t.url}` });
          continue;
        }
        const finalUrl = normalizeUrl(t.url);
        if (finalUrl && finalUrl !== url && pages.some((p) => p.url === finalUrl)) continue; // redirect to a page we already have
        const record = await analyze(tab.id, url);
        pages.push(record);
        for (const link of record.links || []) enqueue(link);
        delete record.links;
      } catch (e) {
        pages.push({ url, error: String(e?.message || e) });
      }
    }
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
  return { origin, startUrl, pages, skipped, sitemapCount: fromSitemap.length, aborted: !!signal?.aborted };
}
