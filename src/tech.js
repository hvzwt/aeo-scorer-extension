// Site-level technical checks gathered from the network: HTTPS, 404 handling,
// security.txt, sitemap, and email DNS records (via DNS-over-HTTPS).

const HEADER_KEYS = [
  "strict-transport-security", "content-security-policy", "x-content-type-options", "x-frame-options",
  "referrer-policy", "permissions-policy", "cache-control", "content-encoding", "x-robots-tag", "server",
  "cf-ray", "x-sucuri-id", "x-akamai-transformed", "x-amz-cf-id", "x-vercel-id", "x-served-by", "x-cache", "via", "age", "etag", "last-modified",
];

export async function fetchInfo(url, { timeoutMs = 8000, method = "GET", readBody = true } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, { method, credentials: "omit", redirect: "follow", signal: ctrl.signal, cache: "no-store" });
    const ttfb = Math.round(performance.now() - started);
    const text = readBody && res.ok ? (await res.text()).slice(0, 2_000_000) : "";
    const headers = {};
    for (const k of HEADER_KEYS) {
      const v = res.headers.get(k);
      if (v != null) headers[k] = v;
    }
    return { status: res.status, text, contentType: res.headers.get("content-type") || "", headers, finalUrl: res.url, redirected: res.redirected, ms: ttfb, bytes: text.length };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Rough registrable domain (example.co.uk, example.com). */
export function baseDomain(host) {
  const parts = host.replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const twoLevel = tld.length === 2 && (sld.length <= 3 || ["gov", "com", "net", "org", "edu", "ac", "co"].includes(sld));
  return parts.slice(twoLevel ? -3 : -2).join(".");
}

async function dns(name, type) {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`, { credentials: "omit" });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.Answer || []).map((a) => String(a.data || "").replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
  } catch {
    return null;
  }
}

const DKIM_SELECTORS = ["google", "default", "selector1", "selector2", "k1", "s1", "s2", "mail", "dkim", "mandrill", "smtp"];

export async function emailRecords(host) {
  const domain = baseDomain(host);
  if (domain === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(domain)) return { domain, skipped: true };
  const [mx, txt, dmarc, mtasts] = await Promise.all([dns(domain, "MX"), dns(domain, "TXT"), dns(`_dmarc.${domain}`, "TXT"), dns(`_mta-sts.${domain}`, "TXT")]);
  if (mx === null && txt === null) return { domain, error: true };
  let dkim = null;
  for (const sel of DKIM_SELECTORS) {
    const r = await dns(`${sel}._domainkey.${domain}`, "TXT");
    if (r?.some((x) => /v=DKIM1|k=rsa|p=/i.test(x))) {
      dkim = sel;
      break;
    }
  }
  return {
    domain,
    mx: (mx || []).length,
    spf: (txt || []).find((x) => /^v=spf1/i.test(x)) || null,
    dmarc: (dmarc || []).find((x) => /^v=DMARC1/i.test(x)) || null,
    dkimSelector: dkim,
    mtaSts: (mtasts || []).some((x) => /^v=STSv1/i.test(x)),
  };
}

/** Everything that is per-origin, fetched once and cached by the caller. */
export async function originTech(origin) {
  const u = new URL(origin);
  const random = `/aeo-scorer-check-${Math.random().toString(36).slice(2, 10)}`;
  const [notFound, securityTxt, sitemap, httpVersion, email] = await Promise.all([
    fetchInfo(origin + random, { readBody: true }),
    fetchInfo(`${origin}/.well-known/security.txt`),
    fetchInfo(`${origin}/sitemap.xml`),
    u.protocol === "https:" ? fetchInfo(`http://${u.host}/`, { readBody: false }) : Promise.resolve(null),
    emailRecords(u.hostname),
  ]);
  return {
    notFoundStatus: notFound?.status ?? null,
    securityTxt: !!(securityTxt && securityTxt.status === 200 && /contact:/i.test(securityTxt.text)),
    sitemapStatus: sitemap ? (sitemap.status === 200 && /<(urlset|sitemapindex)/i.test(sitemap.text) ? 200 : sitemap.status === 200 ? 415 : sitemap.status) : null,
    httpRedirectsToHttps: httpVersion ? /^https:/i.test(httpVersion.finalUrl || "") : null,
    email,
  };
}
