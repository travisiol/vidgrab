// Headless pass with the locally installed Chrome/Edge: loads the page, nudges every player
// into playing, and records the media requests it makes. This is what catches JS players
// (hls.js, video.js, custom SPAs) that never put a URL in the HTML.
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { UA, sleep } from './util.js';
import { mediaKind, isAdUrl } from './extract.js';

const CANDIDATES = [
  process.env.VIDGRAB_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

export const findBrowser = () => CANDIDATES.find((p) => p && fs.existsSync(p)) ?? null;


const PLAY_SELECTORS = [
  '.vjs-big-play-button',
  '.jw-icon-display',
  '.jw-display-icon-container',
  '.plyr__control--overlaid',
  '.fp-play',
  '.ytp-large-play-button',
  'button[aria-label*="play" i]',
  'button[title*="play" i]',
  '[class*="play-button" i]',
  '[class*="playButton" i]',
  'video',
];

export async function launchBrowser() {
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('aucun Chrome/Edge trouvé (définis VIDGRAB_BROWSER)');
  return chromium.launch({
    executablePath,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-blink-features=AutomationControlled'],
  });
}

// One headless browser shared by every running job (each sniff gets its own context).
let shared = null;
let users = 0;

export async function acquireBrowser() {
  users++;
  try {
    if (!shared) shared = launchBrowser();
    let browser = await shared;
    if (!browser.isConnected()) {
      shared = launchBrowser();
      browser = await shared;
    }
    return browser;
  } catch (err) {
    users--;
    shared = null;
    throw err;
  }
}

export async function releaseBrowser() {
  users = Math.max(0, users - 1);
  if (users || !shared) return;
  const pending = shared;
  shared = null;
  const browser = await pending.catch(() => null);
  await browser?.close().catch(() => {});
}

export async function sniff(browser, pageUrl, { cookies = [], timeoutMs = 30000, settleMs = 7000 } = {}) {
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 800 },
    locale: 'fr-FR',
    ignoreHTTPSErrors: true,
  });
  if (cookies.length) await context.addCookies(cookies.map(toPlaywrightCookie)).catch(() => {});
  const page = await context.newPage();
  // Popunders opened by clicking a player are closed straight away.
  context.on('page', (p) => p !== page && p.close().catch(() => {}));

  const found = new Map();
  let lastHit = 0;
  const consider = (url, contentType = '') => {
    if (!url.startsWith('http') || isAdUrl(url)) return;
    const kind = mediaKind(url, contentType);
    if (!kind || found.has(url)) return;
    found.set(url, { url, kind, source: 'browser' });
    lastHit = Date.now();
  };
  page.on('request', (req) => consider(req.url()));
  page.on('response', (res) => consider(res.url(), res.headers()['content-type'] ?? ''));

  let error = null;
  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
    await sleep(1200);
    await nudgePlayers(page);
    const deadline = Date.now() + settleMs;
    while (Date.now() < deadline) {
      await sleep(500);
      if (lastHit && Date.now() - lastHit > 2500) break; // streams found and the network went quiet
    }
    if (!found.size) {
      await nudgePlayers(page);
      await sleep(2500);
    }
  } catch (err) {
    error = err.message.split('\n')[0];
  }

  const html = await page.content().catch(() => '');
  const title = await page.title().catch(() => '');
  const finalUrl = page.url();
  const jar = await context.cookies().catch(() => []);
  await context.close().catch(() => {});
  if (error && !found.size && !html) throw new Error(error);
  return { media: [...found.values()], html, title, finalUrl, cookies: jar };
}

async function nudgePlayers(page) {
  for (const frame of page.frames()) {
    await frame
      .evaluate(() => {
        for (const v of document.querySelectorAll('video')) {
          v.muted = true;
          v.play?.().catch(() => {});
        }
      })
      .catch(() => {});
  }
  for (const selector of PLAY_SELECTORS) {
    for (const frame of page.frames()) {
      const el = await frame.$(selector).catch(() => null);
      if (!el) continue;
      await el.click({ timeout: 1200, force: true }).catch(() => {});
      await sleep(300);
      break;
    }
  }
}

function toPlaywrightCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expires > 0 ? c.expires : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
  };
}
