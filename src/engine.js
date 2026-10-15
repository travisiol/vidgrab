// A Job = one URL to harvest. It decides how to find the videos (yt-dlp native extractor,
// static HTML, headless browser), crawls the site if asked, and runs a download pool.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  normalizePageUrl,
  hostOf,
  siteOf,
  sleep,
  mediaKey,
  shortHash,
  safeFileName,
  nextId,
} from './util.js';
import { isDrmService, isDrmError } from './drm.js';
import { extract, isEmbedHost, mediaKind, isAdUrl } from './extract.js';
import { fetchPage, fetchText, loadRobots } from './fetch.js';
import { launchBrowser, findBrowser, sniff } from './browser.js';
import { readCookieFile, writeCookieFile } from './cookies.js';
import { probe, download } from './ytdlp.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_OUT = path.join(root, 'downloads');

export const DEFAULTS = {
  scope: 'page', // 'page' | 'site'
  maxPages: 200,
  maxDepth: 4,
  browser: 'auto', // 'auto' | 'always' | 'never'
  quality: 'best', // best | 1080 | 720 | 480 | audio
  concurrency: 3,
  scanConcurrency: 3,
  delayMs: 400,
  listOnly: false,
  respectRobots: true,
  sameSite: true, // site scope: include subdomains of the same domain
  include: '', // regex: only crawl URLs that match
  exclude: '', // regex: never crawl URLs that match
  outDir: DEFAULT_OUT,
  cookiesFile: '',
  cookiesFromBrowser: '',
};

export class Job extends EventEmitter {
  constructor(url, options = {}) {
    super();
    this.id = nextId('j');
    this.url = url.trim();
    this.opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
    this.state = {
      id: this.id,
      url: this.url,
      options: this.opts,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      outDir: null,
      pages: { queued: 0, scanned: 0, failed: 0 },
      videos: [],
      log: [],
    };
    this.cancelled = false;
    this.seenPages = new Set();
    this.seenMedia = new Set();
    this.active = new Map(); // video id -> cancel()
    this.dlQueue = [];
    this.dlRunning = 0;
    this.idleWaiters = [];
    this.nativeHosts = new Map(); // host -> boolean (yt-dlp has a dedicated extractor)
    this.browser = null;
    this.browserPromise = null;
    this.lastEmit = new Map();
  }

  // ---------- events ----------

  log(msg, level = 'info') {
    const entry = { t: Date.now(), level, msg };
    this.state.log.push(entry);
    if (this.state.log.length > 500) this.state.log.shift();
    this.emit('event', { type: 'log', data: entry });
  }

  pushPages() {
    this.emit('event', { type: 'pages', data: this.state.pages });
  }

  updateVideo(video, patch = {}) {
    Object.assign(video, patch);
    this.emit('event', { type: 'video', data: video });
  }

  setStatus(status) {
    this.state.status = status;
    if (status !== 'running') this.state.finishedAt = Date.now();
    this.emit('event', { type: 'status', data: { status, finishedAt: this.state.finishedAt } });
  }

  // ---------- main flow ----------

  async run() {
    try {
      await this.prepare();
      if (isDrmService(this.url)) {
        this.log('Service protégé par DRM (Netflix, Disney+, Prime…) : rien à télécharger.', 'error');
        return this.setStatus('failed');
      }
      const handled = await this.tryNative(this.url, { root: true });
      if (!handled || this.opts.scope === 'site') {
        if (this.opts.scope === 'site') await this.crawl();
        else await this.scanPage(this.url, 0, { rootPage: true });
      }
      await this.downloadsIdle();
      if (this.cancelled) return this.setStatus('cancelled');
      const done = this.state.videos.filter((v) => v.status === 'done' || v.status === 'exists').length;
      const found = this.state.videos.length;
      this.log(
        found
          ? `Terminé : ${found} vidéo(s) trouvée(s)${this.opts.listOnly ? '' : `, ${done} téléchargée(s)`}.`
          : 'Terminé : aucune vidéo trouvée.',
        found ? 'success' : 'warn',
      );
      this.setStatus('done');
    } catch (err) {
      this.log(`Erreur : ${err.message}`, 'error');
      this.setStatus(this.cancelled ? 'cancelled' : 'failed');
    } finally {
      await this.browser?.close().catch(() => {});
    }
  }

  async prepare() {
    const { opts } = this;
    let parsed;
    try {
      parsed = new URL(this.url);
    } catch {
      throw new Error('URL invalide');
    }
    this.origin = parsed.origin;
    this.rootHost = hostOf(this.url);
    this.rootSite = siteOf(this.url);
    this.outDir = path.join(path.resolve(opts.outDir), safeFileName(this.rootHost, 'site'));
    this.state.outDir = this.outDir;
    this.workDir = path.join(path.resolve(opts.outDir), '.vidgrab');
    fs.mkdirSync(this.outDir, { recursive: true });
    fs.mkdirSync(this.workDir, { recursive: true });
    this.nativeArchive = path.join(this.workDir, 'archive-ytdlp.txt');
    this.directArchive = path.join(this.workDir, 'archive-direct.txt');
    this.doneDirect = new Set(
      fs.existsSync(this.directArchive) ? fs.readFileSync(this.directArchive, 'utf8').split(/\r?\n/).filter(Boolean) : [],
    );
    this.cookies = opts.cookiesFile ? readCookieFile(opts.cookiesFile) : [];
    this.jobCookieFile = path.join(this.workDir, `cookies-${this.id}.txt`);
    this.include = opts.include ? new RegExp(opts.include, 'i') : null;
    this.exclude = opts.exclude ? new RegExp(opts.exclude, 'i') : null;
    this.allowed = () => true;
    if (opts.scope === 'site' && opts.respectRobots) {
      this.allowed = await loadRobots(this.origin, { cookies: this.cookies });
    }
    this.log(
      `Analyse de ${this.url} — ${opts.scope === 'site' ? `site entier (max ${opts.maxPages} pages)` : 'page seule'}${
        opts.listOnly ? ', liste seulement' : ''
      }`,
    );
  }

  cancel() {
    if (this.cancelled || this.state.status !== 'running') return;
    this.cancelled = true;
    this.log('Annulation…', 'warn');
    this.dlQueue.length = 0;
    for (const cancel of this.active.values()) cancel();
    for (const v of this.state.videos) if (v.status === 'queued') this.updateVideo(v, { status: 'cancelled' });
    this.browser?.close().catch(() => {});
    this.resolveIdle();
  }

  // ---------- discovery ----------

  ytdlpOpts(extra = {}) {
    return {
      cookiesFile: this.opts.cookiesFile || (this.useJobCookies ? this.jobCookieFile : ''),
      cookiesFromBrowser: this.opts.cookiesFromBrowser,
      ...extra,
    };
  }

  /** yt-dlp first: it knows ~1800 sites (YouTube, Vimeo, TikTok, X, Twitch…) far better than any scraper. */
  async tryNative(url, { root = false } = {}) {
    const host = hostOf(url);
    if (this.nativeHosts.get(host) === false && !root) return false;
    const result = await probe(url, this.ytdlpOpts({ maxEntries: this.opts.maxPages * 5 }));
    if (this.cancelled) return true;
    if (!result.ok) {
      if (isDrmError(result.error)) {
        this.log(`DRM détecté sur ${url} : impossible à télécharger.`, 'error');
        return true;
      }
      if (root) this.nativeHosts.set(host, false);
      return false;
    }
    const info = result.info;
    const generic = /^generic$/i.test(info.extractor_key ?? info.ie_key ?? '');
    if (root) this.nativeHosts.set(host, !generic);
    const entries = info._type === 'playlist' ? (info.entries ?? []).filter(Boolean) : [info];
    if (!entries.length) return false;
    if (generic) {
      // The generic extractor just found raw files in the page: treat them as direct media.
      const media = entries
        .map((e) => {
          const direct = [e.url, ...(e.formats ?? []).map((f) => f.url).reverse()].find((u) => u && mediaKind(u));
          return direct && { url: direct, kind: mediaKind(direct), source: 'yt-dlp', title: e.title, thumb: e.thumbnail };
        })
        .filter(Boolean);
      if (!media.length) return false;
      let n = 0;
      for (const m of media) n += this.addMedia([m], url, info.title || m.title, m.thumb ?? null);
      if (root) this.log(`yt-dlp (extracteur générique) : ${n} vidéo(s) dans la page.`, n ? 'success' : 'info');
      return n > 0;
    }
    if (root)
      this.log(
        `Site reconnu par yt-dlp (${info.extractor_key}) : ${entries.length} vidéo(s).`,
        'success',
      );
    for (const entry of entries) {
      const target = entry.webpage_url || entry.url || (entries.length === 1 ? url : null);
      if (!target) continue;
      this.addVideo({
        url: entries.length === 1 && info._type !== 'playlist' ? url : target,
        kind: 'native',
        page: url,
        title: entry.title || info.title,
        thumb: entry.thumbnail || entry.thumbnails?.at(-1)?.url || null,
        duration: entry.duration ?? null,
        extractor: entry.ie_key || info.extractor_key,
      });
    }
    return true;
  }

  inScope(url) {
    if (this.seenPages.has(url)) return false;
    if (this.opts.sameSite ? siteOf(url) !== this.rootSite : hostOf(url) !== this.rootHost) return false;
    if (this.include && !this.include.test(url)) return false;
    if (this.exclude && this.exclude.test(url)) return false;
    return this.allowed(url);
  }

  async crawl() {
    const start = normalizePageUrl(this.url);
    const queue = [{ url: start, depth: 0 }];
    this.seenPages.add(start);
    this.state.pages.queued = 1;
    let busy = 0;
    const enqueue = (links, depth) => {
      if (depth > this.opts.maxDepth) return;
      for (const link of links) {
        if (this.seenPages.size >= this.opts.maxPages) break;
        if (!this.inScope(link)) continue;
        this.seenPages.add(link);
        queue.push({ url: link, depth });
        this.state.pages.queued++;
      }
      this.pushPages();
    };
    const worker = async () => {
      while (!this.cancelled) {
        const item = queue.shift();
        if (!item) {
          if (!busy) return;
          await sleep(200);
          continue;
        }
        busy++;
        try {
          const links = await this.scanPage(item.url, item.depth, { rootPage: item.depth === 0 });
          enqueue(links, item.depth + 1);
        } finally {
          busy--;
        }
        await sleep(this.opts.delayMs);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.opts.scanConcurrency) }, worker));
    if (this.seenPages.size >= this.opts.maxPages)
      this.log(`Limite de ${this.opts.maxPages} pages atteinte — augmente « pages max » pour aller plus loin.`, 'warn');
  }

  /** Scans one page for videos; returns the links it contains (for the crawler). */
  async scanPage(url, depth, { rootPage = false } = {}) {
    if (this.cancelled) return [];
    const { opts } = this;
    let page = null;
    try {
      page = await fetchPage(url, { cookies: this.cookies });
    } catch (err) {
      page = { error: err.name === 'TimeoutError' ? 'délai dépassé' : err.message };
    }
    if (page.media) {
      this.addMedia([{ url: page.media.url, kind: mediaKind(page.media.url, page.media.contentType) ?? 'direct', source: 'link' }], url, '', null);
      this.markScanned();
      return [];
    }
    if (page.skipped) {
      this.markScanned();
      return [];
    }

    let ext = page.html ? extract(page.html, page.finalUrl || url) : null;
    let found = 0;
    if (ext) {
      found += this.addMedia(ext.media, url, ext.title, ext.thumb);
      for (const embed of ext.embeds) found += await this.addEmbed(embed, url, ext.title);
      for (const frame of ext.frames) found += await this.scanFrame(frame, url, ext.title);
    }

    // Sites with a dedicated yt-dlp extractor: every page may be a video page.
    const host = hostOf(url);
    if (!rootPage && this.nativeHosts.get(host) && !found) {
      if (await this.tryNative(url)) found++;
    }

    const wantBrowser =
      opts.browser === 'always' ||
      (opts.browser === 'auto' && !found && (rootPage || !ext || ext.hasPlayerHints));
    if (wantBrowser && !this.cancelled) {
      const sniffed = await this.sniffPage(url);
      if (sniffed) {
        found += this.addMedia(sniffed.media, url, sniffed.title || ext?.title, ext?.thumb);
        // JS-rendered sites: the browser's DOM has the links the raw HTML didn't.
        if (sniffed.html) {
          const rendered = extract(sniffed.html, sniffed.finalUrl || url);
          for (const embed of rendered.embeds) found += await this.addEmbed(embed, url, rendered.title);
          if (!ext || ext.links.length < rendered.links.length) ext = rendered;
          else found += this.addMedia(rendered.media, url, rendered.title, rendered.thumb);
        }
      }
    }

    if (page.error && !ext) {
      this.state.pages.failed++;
      this.log(`Page inaccessible (${page.error}) : ${url}`, 'warn');
    }
    this.markScanned();
    if (found && opts.scope === 'site') this.log(`${found} vidéo(s) sur ${url}`);
    return ext?.links ?? [];
  }

  markScanned() {
    this.state.pages.scanned++;
    this.pushPages();
  }

  async scanFrame(frameUrl, page, title) {
    if (this.seenPages.has(`frame:${frameUrl}`)) return 0;
    this.seenPages.add(`frame:${frameUrl}`);
    try {
      const res = await fetchPage(frameUrl, { referer: page, cookies: this.cookies });
      if (!res.html) return 0;
      const ext = extract(res.html, res.finalUrl || frameUrl);
      return this.addMedia(ext.media, page, title || ext.title, ext.thumb);
    } catch {
      return 0;
    }
  }

  async addEmbed(embedUrl, page, title) {
    if (this.seenMedia.has(embedUrl)) return 0;
    this.seenMedia.add(embedUrl);
    // Resolve channels/playlists into single videos; a lone video is queued as-is.
    const result = await probe(embedUrl, this.ytdlpOpts({ maxEntries: 200 }));
    if (!result.ok) return 0;
    const info = result.info;
    const entries = info._type === 'playlist' ? (info.entries ?? []).filter(Boolean) : [info];
    let n = 0;
    for (const entry of entries) {
      const url = info._type === 'playlist' ? entry.webpage_url || entry.url : embedUrl;
      if (!url) continue;
      n += this.addVideo({
        url,
        kind: 'native',
        page,
        title: entry.title || title,
        thumb: entry.thumbnail || null,
        duration: entry.duration ?? null,
        extractor: entry.ie_key || info.extractor_key,
      });
    }
    return n;
  }

  async getBrowser() {
    if (this.browser) return this.browser;
    if (!this.browserPromise) {
      if (!findBrowser()) {
        this.log('Mode navigateur indisponible : aucun Chrome/Edge trouvé.', 'warn');
        this.opts.browser = 'never';
        return null;
      }
      this.browserPromise = launchBrowser().then((b) => (this.browser = b));
    }
    return this.browserPromise.catch((err) => {
      this.log(`Navigateur headless : ${err.message}`, 'warn');
      this.opts.browser = 'never';
      return null;
    });
  }

  async sniffPage(url) {
    const browser = await this.getBrowser();
    if (!browser || this.cancelled) return null;
    try {
      const result = await sniff(browser, url, { cookies: this.cookies });
      // Streams sniffed in the browser often need its session cookies; hand them to yt-dlp.
      if (result.media.length && result.cookies.length && !this.opts.cookiesFile) {
        writeCookieFile(this.jobCookieFile, result.cookies);
        this.useJobCookies = true;
      }
      return result;
    } catch (err) {
      if (!this.cancelled) this.log(`Navigateur : ${err.message} (${url})`, 'warn');
      return null;
    }
  }

  // ---------- candidates -> videos ----------

  /** Adds raw media URLs found on `page`; HLS variant playlists are folded into their master. */
  addMedia(media, page, title, thumb) {
    const fresh = media.filter(
      (m) => m.kind && !isAdUrl(m.url) && !this.seenMedia.has(mediaKey(m.url)) && !isEmbedHost(m.url),
    );
    if (!fresh.length) return 0;
    for (const m of fresh) this.seenMedia.add(mediaKey(m.url));
    const hls = fresh.filter((m) => m.kind === 'hls');
    const finish = (variants) => {
      let n = 0;
      const kept = fresh.filter((m) => !variants.has(mediaKey(m.url)));
      const sameTitle = kept.length > 1;
      kept.forEach((m, i) => {
        n += this.addVideo({
          url: m.url,
          kind: m.kind,
          page,
          title: sameTitle && title ? `${title} (${i + 1})` : title || null,
          thumb: thumb ?? null,
          source: m.source,
        });
      });
      return n;
    };
    if (hls.length < 2) return finish(new Set());
    // Several playlists from one page: drop those referenced by a master playlist.
    this.pendingMasters = (this.pendingMasters ?? Promise.resolve()).then(async () => {
      const variants = new Set();
      await Promise.all(
        hls.map(async (m) => {
          try {
            const text = await fetchText(m.url, { referer: page, cookies: this.cookies, timeoutMs: 10000 });
            if (!text.includes('#EXT-X-STREAM-INF')) return;
            for (const line of text.split(/\r?\n/)) {
              if (!line || line.startsWith('#')) continue;
              try {
                variants.add(mediaKey(new URL(line.trim(), m.url).toString()));
              } catch {
                /* ignore */
              }
            }
          } catch {
            /* unreachable playlist: keep it */
          }
        }),
      );
      finish(variants);
    });
    return hls.length;
  }

  addVideo({ url, kind, page, title, thumb, duration = null, extractor = null, source = null }) {
    const key = kind === 'native' ? `native:${url}` : `direct:${mediaKey(url)}`;
    if (this.state.videos.some((v) => v.key === key)) return 0;
    const video = {
      id: nextId('v'),
      key,
      url,
      kind,
      page,
      title: title || null,
      thumb,
      duration,
      extractor,
      source,
      status: this.opts.listOnly ? 'found' : 'queued',
      percent: null,
      speed: null,
      eta: null,
      total: null,
      file: null,
      error: null,
    };
    this.state.videos.push(video);
    this.emit('event', { type: 'video', data: video });
    if (!this.opts.listOnly) this.enqueueDownload(video);
    return 1;
  }

  // ---------- downloads ----------

  enqueueDownload(video) {
    if (this.cancelled) return;
    if (video.kind !== 'native' && this.doneDirect.has(mediaKey(video.url))) {
      this.updateVideo(video, { status: 'exists', percent: 100 });
      return;
    }
    this.updateVideo(video, { status: 'queued', error: null });
    this.dlQueue.push(video);
    this.pump();
  }

  /** Manual download of a video found in list-only mode (from the UI). */
  downloadVideo(videoId) {
    const video = this.state.videos.find((v) => v.id === videoId);
    if (!video || ['queued', 'downloading', 'done'].includes(video.status)) return false;
    this.cancelled = false;
    const wasIdle = this.state.status !== 'running';
    if (wasIdle) this.setStatus('running');
    this.enqueueDownload(video);
    if (wasIdle) this.downloadsIdle().then(() => this.setStatus('done'));
    return true;
  }

  pump() {
    while (this.dlRunning < this.opts.concurrency && this.dlQueue.length && !this.cancelled) {
      const video = this.dlQueue.shift();
      this.dlRunning++;
      this.runDownload(video).finally(() => {
        this.dlRunning--;
        this.active.delete(video.id);
        this.pump();
        this.resolveIdle();
      });
    }
  }

  async runDownload(video) {
    this.updateVideo(video, { status: 'downloading', percent: 0 });
    const direct = video.kind !== 'native';
    const name = safeFileName(video.title || path.basename(new URL(video.url).pathname).replace(/\.\w+$/, ''));
    const job = download(
      video.url,
      this.ytdlpOpts({
        outDir: this.outDir,
        quality: this.opts.quality,
        direct,
        referer: video.page,
        // Raw streams are often all called master.m3u8 / index.mp4: name them after the page instead.
        output: direct ? `${name.replace(/%/g, '%%')} [${shortHash(mediaKey(video.url))}].%(ext)s` : undefined,
        archive: direct ? null : this.nativeArchive,
      }),
      (e) => {
        if (e.type === 'progress') {
          const now = Date.now();
          if (now - (this.lastEmit.get(video.id) ?? 0) < 400 && e.percent < 100) {
            Object.assign(video, { percent: e.percent, speed: e.speed, eta: e.eta, total: e.total });
            return;
          }
          this.lastEmit.set(video.id, now);
          this.updateVideo(video, { percent: e.percent, speed: e.speed, eta: e.eta, total: e.total });
        } else if (e.type === 'title' && e.title && e.title !== 'NA' && (!video.title || !direct)) {
          this.updateVideo(video, { title: e.title });
        } else if (e.type === 'file') {
          this.updateVideo(video, { file: e.file });
        }
      },
    );
    this.active.set(video.id, job.cancel);
    const result = await job.promise;
    if (this.cancelled) return this.updateVideo(video, { status: 'cancelled' });
    if (result.ok) {
      const status = video.file ? 'done' : 'exists';
      if (direct) {
        this.doneDirect.add(mediaKey(video.url));
        fs.appendFileSync(this.directArchive, `${mediaKey(video.url)}\n`);
      }
      this.updateVideo(video, { status, percent: 100, speed: null, eta: null });
      this.log(`${status === 'done' ? 'Téléchargé' : 'Déjà présent'} : ${video.title || video.url}`, 'success');
    } else {
      const drm = isDrmError(result.error);
      this.updateVideo(video, { status: drm ? 'drm' : 'error', error: drm ? 'Protégé par DRM' : result.error });
      this.log(`Échec : ${video.title || video.url} — ${result.error}`, 'warn');
    }
  }

  resolveIdle() {
    if ((this.dlRunning === 0 && this.dlQueue.length === 0) || this.cancelled) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  async downloadsIdle() {
    await this.pendingMasters;
    if ((this.dlRunning === 0 && this.dlQueue.length === 0) || this.cancelled) return;
    await new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
