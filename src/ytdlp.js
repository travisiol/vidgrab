// Thin wrapper around the yt-dlp process: locate it, probe a URL, download with live progress.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { UA } from './util.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let cached = null;

/** Finds a working yt-dlp: env override, ./bin (npm run setup), PATH, then `python -m yt_dlp`. */
export function locateYtDlp() {
  if (cached) return cached;
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const candidates = [
    process.env.VIDGRAB_YTDLP && { cmd: process.env.VIDGRAB_YTDLP, pre: [] },
    { cmd: path.join(root, 'bin', exe), pre: [] },
    { cmd: 'yt-dlp', pre: [] },
    { cmd: process.platform === 'win32' ? 'python' : 'python3', pre: ['-m', 'yt_dlp'] },
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c.cmd, [...c.pre, '--version'], { encoding: 'utf8', timeout: 30000 });
    if (r.status === 0) {
      const help = spawnSync(c.cmd, [...c.pre, '--help'], { encoding: 'utf8', timeout: 30000 }).stdout ?? '';
      cached = { ...c, version: r.stdout.trim(), jsRuntimes: help.includes('--js-runtimes') };
      return cached;
    }
  }
  throw new Error('yt-dlp introuvable — lance `npm run setup`');
}

export const resetYtDlp = () => {
  cached = null;
};

export const ffmpegLocation = () => (ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : null);

function commonArgs(opts = {}) {
  const yt = locateYtDlp();
  const args = ['--no-warnings', '--encoding', 'utf-8', '--socket-timeout', '20', '--no-color'];
  const ffmpeg = ffmpegLocation();
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);
  // Recent yt-dlp needs a JS runtime for YouTube signatures; Node is already here.
  if (yt.jsRuntimes) args.push('--js-runtimes', `node:${process.execPath}`);
  if (opts.cookiesFile) args.push('--cookies', opts.cookiesFile);
  else if (opts.cookiesFromBrowser) args.push('--cookies-from-browser', opts.cookiesFromBrowser);
  if (opts.direct) {
    // Raw media URLs found by the crawler: present them like the page's own player would.
    args.push('--user-agent', UA);
    if (opts.referer) args.push('--referer', opts.referer);
  }
  return args;
}

function run(args, { timeoutMs, onLine } = {}) {
  const yt = locateYtDlp();
  const child = spawn(yt.cmd, [...yt.pre, ...args], { windowsHide: true });
  let stdout = '';
  let stderr = '';
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdout += d;
    if (!onLine) return;
    buffer += d;
    const lines = buffer.split(/\r?\n|\r/);
    buffer = lines.pop();
    for (const line of lines) if (line) onLine(line);
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : null;
  const promise = new Promise((resolve) => {
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (onLine && buffer) onLine(buffer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
  return { child, promise };
}

export const lastError = (stderr) =>
  stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ERROR:') || l.startsWith('WARNING:'))
    .pop()
    ?.replace(/^(ERROR|WARNING):\s*/, '') ||
  stderr.trim().split(/\r?\n/).pop() ||
  'erreur inconnue';

/**
 * Asks yt-dlp what a URL holds without downloading. Playlists/channels come back flat
 * (one entry per video) and capped at `maxEntries`.
 */
export async function probe(url, opts = {}) {
  const args = [
    '-J',
    '--flat-playlist',
    '--playlist-end',
    String(opts.maxEntries ?? 500),
    ...commonArgs(opts),
    url,
  ];
  const { promise } = run(args, { timeoutMs: opts.timeoutMs ?? 90000 });
  const { code, stdout, stderr } = await promise;
  if (code !== 0) return { ok: false, error: lastError(stderr) };
  try {
    return { ok: true, info: JSON.parse(stdout) };
  } catch {
    return { ok: false, error: 'réponse yt-dlp illisible' };
  }
}

export const FORMATS = {
  best: 'bv*+ba/b',
  1080: 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
  720: 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
  480: 'bv*[height<=480]+ba/b[height<=480]/bv*+ba/b',
  audio: 'ba/b',
};

const num = (s) => (s && s !== 'NA' && s !== 'None' ? Number(s) : null);

/**
 * Downloads one URL. `onEvent` receives {type:'progress', percent, speed, eta, total},
 * {type:'title', title}, {type:'file', file}. Returns { promise, cancel }.
 */
export function download(url, opts, onEvent = () => {}) {
  const args = [
    '--newline',
    '--progress',
    '--no-simulate',
    '--progress-template',
    'download:[vg] %(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s',
    '--print',
    'before_dl:[vgtitle] %(title)s',
    '--print',
    'after_move:[vgfile] %(filepath)s',
    '-P',
    opts.outDir,
    '-o',
    opts.output ?? '%(title).150B [%(id)s].%(ext)s',
    '-f',
    FORMATS[opts.quality] ?? FORMATS.best,
    '--no-overwrites',
    '--continue',
    '--no-mtime',
    '--no-playlist',
    '--concurrent-fragments',
    '4',
    '--retries',
    '5',
    '--fragment-retries',
    '10',
    ...commonArgs(opts),
  ];
  if (opts.quality === 'audio') args.push('-x', '--audio-format', 'mp3');
  else args.push('--merge-output-format', 'mp4');
  if (opts.archive) args.push('--download-archive', opts.archive);
  args.push(url);

  const { child, promise } = run(args, {
    onLine: (line) => {
      if (line.startsWith('[vg] ')) {
        const [done, total, estimate, speed, eta, fragIndex, fragCount] = line.slice(5).split('|').map(num);
        const size = total ?? estimate;
        let percent = size ? (done / size) * 100 : null;
        if (percent == null && fragCount) percent = (fragIndex / fragCount) * 100;
        onEvent({ type: 'progress', percent, speed, eta, total: size, done });
      } else if (line.startsWith('[vgtitle] ')) {
        onEvent({ type: 'title', title: line.slice(10) });
      } else if (line.startsWith('[vgfile] ')) {
        onEvent({ type: 'file', file: line.slice(9) });
      }
    },
  });
  return {
    promise: promise.then(({ code, stderr }) => ({ ok: code === 0, error: code === 0 ? null : lastError(stderr) })),
    cancel: () => child.kill(),
  };
}

export async function updateYtDlp() {
  const yt = locateYtDlp();
  const { promise } = run(['-U'], { timeoutMs: 180000 });
  const { code, stdout, stderr } = await promise;
  resetYtDlp();
  return { ok: code === 0, output: (stdout + stderr).trim(), before: yt.version, after: locateYtDlp().version };
}
