import crypto from 'node:crypto';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src)$/i;

/** Canonical form used to dedupe crawled pages. Returns null for anything that isn't http(s). */
export function normalizePageUrl(input, base) {
  let url;
  try {
    url = new URL(input, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

export function resolveUrl(input, base) {
  if (!input) return null;
  try {
    const url = new URL(input.trim(), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const TWO_LEVEL_TLD = /\.(co|com|net|org|gov|edu|ac|ne|or|go)\.[a-z]{2}$/;

/** Rough registrable domain ("video.example.co.uk" -> "example.co.uk"), enough to scope a crawl. */
export function siteOf(u) {
  const host = hostOf(u);
  const parts = host.split('.');
  if (parts.length <= 2 || /^\d+$/.test(parts.at(-1))) return host;
  return parts.slice(TWO_LEVEL_TLD.test(host) ? -3 : -2).join('.');
}

export const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

/** Signed CDN URLs change their query on every load; identity is host + path. */
export function mediaKey(u) {
  try {
    const url = new URL(u);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return u;
  }
}

export function safeFileName(s, fallback = 'video') {
  const clean = String(s ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120);
  return clean || fallback;
}

let seq = 0;
export const nextId = (prefix) => `${prefix}${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;
