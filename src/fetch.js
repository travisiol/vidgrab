import { UA } from './util.js';
import { cookieHeader } from './cookies.js';

const MAX_HTML_BYTES = 6 * 1024 * 1024;

function headersFor(url, { referer, cookies = [] } = {}) {
  const headers = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
  };
  if (referer) headers.referer = referer;
  const cookie = cookieHeader(cookies, url);
  if (cookie) headers.cookie = cookie;
  return headers;
}

/**
 * Fetches a page. Non-HTML responses are not downloaded: a video/* response is reported as
 * `{ media }` so a plain link to a file still counts, anything else as `{ skipped }`.
 */
export async function fetchPage(url, opts = {}) {
  const res = await fetch(url, {
    headers: headersFor(url, opts),
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
  });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    await res.body?.cancel();
    return { status: res.status, finalUrl: res.url, error: `HTTP ${res.status}` };
  }
  if (type.startsWith('video/') || type.includes('mpegurl') || type.includes('dash+xml')) {
    await res.body?.cancel();
    return { status: res.status, finalUrl: res.url, media: { url: res.url, contentType: type } };
  }
  if (type && !/html|xml|text\/plain/i.test(type)) {
    await res.body?.cancel();
    return { status: res.status, finalUrl: res.url, skipped: type };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > MAX_HTML_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return { status: res.status, finalUrl: res.url, html: Buffer.concat(chunks).toString('utf8') };
}

export async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    headers: headersFor(url, opts),
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Minimal robots.txt support: Disallow/Allow rules of the `*` group, with * and $ wildcards. */
export async function loadRobots(origin, opts) {
  let text = '';
  try {
    text = await fetchText(`${origin}/robots.txt`, { ...opts, timeoutMs: 8000 });
  } catch {
    return () => true;
  }
  const rules = [];
  let applies = false;
  let inAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!inAgents) applies = false;
      inAgents = true;
      if (value === '*') applies = true;
      continue;
    }
    inAgents = false;
    if (!applies || (key !== 'disallow' && key !== 'allow') || !value) continue;
    const pattern = new RegExp(
      `^${value.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`,
    );
    rules.push({ allow: key === 'allow', pattern, length: value.length });
  }
  return (url) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    let best = null;
    for (const rule of rules) if (rule.pattern.test(path) && (!best || rule.length > best.length)) best = rule;
    return !best || best.allow;
  };
}
