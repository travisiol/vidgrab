// Local web UI: http://localhost:3787 — jobs run in this process, progress streams over SSE.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Job, DEFAULT_OUT } from './engine.js';
import { locateYtDlp, ffmpegLocation, updateYtDlp } from './ytdlp.js';
import { findBrowser } from './browser.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 3787;
const HOST = process.env.HOST || '127.0.0.1';
const jobs = new Map();

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new Error('requête trop grosse');
  }
  return raw ? JSON.parse(raw) : {};
}

function toolStatus() {
  let ytdlp = null;
  let error = null;
  try {
    ytdlp = locateYtDlp().version;
  } catch (err) {
    error = err.message;
  }
  return { ytdlp, ffmpeg: !!ffmpegLocation(), browser: !!findBrowser(), outDir: DEFAULT_OUT, error };
}

function summary(job) {
  const { videos, ...rest } = job.state;
  const count = (...s) => videos.filter((v) => s.includes(v.status)).length;
  return {
    ...rest,
    log: undefined,
    counts: {
      found: videos.length,
      done: count('done', 'exists'),
      active: count('downloading'),
      queued: count('queued'),
      failed: count('error', 'drm'),
    },
  };
}

function openFolder(dir) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return fs.createReadStream(path.join(root, 'ui', file)).pipe(res);
    }

    if (parts[0] !== 'api') return send(res, 404, { error: 'introuvable' });

    // GET /api/tools · POST /api/tools/update
    if (parts[1] === 'tools') {
      if (req.method === 'POST' && parts[2] === 'update') return send(res, 200, await updateYtDlp());
      return send(res, 200, toolStatus());
    }

    if (parts[1] === 'jobs' && parts.length === 2) {
      if (req.method === 'GET') return send(res, 200, [...jobs.values()].map(summary).reverse());
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (!body.url || !/^https?:\/\//i.test(body.url.trim())) return send(res, 400, { error: 'URL http(s) requise' });
        const job = new Job(body.url, {
          scope: body.scope === 'site' ? 'site' : 'page',
          maxPages: body.maxPages ? Number(body.maxPages) : undefined,
          maxDepth: body.maxDepth ? Number(body.maxDepth) : undefined,
          browser: ['auto', 'always', 'never'].includes(body.browser) ? body.browser : undefined,
          quality: body.quality,
          concurrency: body.concurrency ? Number(body.concurrency) : undefined,
          listOnly: body.mode === 'list' || !!body.listOnly,
          batchSize: body.mode === 'batch' ? Math.max(1, Number(body.batchSize) || 5) : 0,
          include: body.include || undefined,
          exclude: body.exclude || undefined,
          respectRobots: body.ignoreRobots ? false : undefined,
          cookiesFromBrowser: body.cookiesFromBrowser || undefined,
          outDir: body.outDir || undefined,
        });
        jobs.set(job.id, job);
        job.run();
        return send(res, 201, { id: job.id });
      }
    }

    const job = parts[1] === 'jobs' && jobs.get(parts[2]);
    if (!job) return send(res, 404, { error: 'tâche introuvable' });
    const action = parts[3];

    if (req.method === 'GET' && !action) return send(res, 200, job.state);

    if (req.method === 'GET' && action === 'events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify(job.state)}\n\n`);
      const forward = ({ type, data }) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      job.on('event', forward);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        job.off('event', forward);
      });
      return;
    }

    if (req.method === 'POST' && action === 'cancel') {
      job.cancel();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'open') {
      openFolder(job.state.outDir ?? DEFAULT_OUT);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'download') {
      const body = await readJson(req);
      if (body.next) return send(res, 200, { started: job.downloadNext(Number(body.next)) });
      const ids = body.all
        ? job.state.videos.filter((v) => ['found', 'error', 'cancelled'].includes(v.status)).map((v) => v.id)
        : [body.videoId];
      const started = ids.filter((id) => job.downloadVideo(id)).length;
      return send(res, 200, { started });
    }
    if (req.method === 'DELETE' && !action) {
      job.cancel();
      jobs.delete(job.id);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'introuvable' });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  const t = toolStatus();
  console.log(`vidgrab → http://localhost:${PORT}`);
  console.log(`yt-dlp ${t.ytdlp ?? 'ABSENT'} · ffmpeg ${t.ffmpeg ? 'ok' : 'absent'} · navigateur ${t.browser ? 'ok' : 'absent'}`);
});
