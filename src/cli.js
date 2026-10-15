#!/usr/bin/env node
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import fs from 'node:fs';
import { Job, DEFAULTS, parseUrls } from './engine.js';
import { hostOf } from './util.js';
import { locateYtDlp, ffmpegLocation } from './ytdlp.js';
import { findBrowser } from './browser.js';

const HELP = `vidgrab — télécharge les vidéos d'une page ou d'un site entier

Usage
  vidgrab <url> [<url> …] [options]
  vidgrab --file liens.txt [options]     plusieurs liens, tous lancés en même temps

Options
  -s, --site              parcourt tout le site (sinon : la page seule)
  -p, --max-pages <n>     pages max à parcourir            (défaut ${DEFAULTS.maxPages})
  -d, --depth <n>         profondeur max de liens          (défaut ${DEFAULTS.maxDepth})
  -b, --browser <mode>    auto | always | never            (défaut auto)
  -q, --quality <q>       best | 1080 | 720 | 480 | audio  (défaut best)
  -j, --jobs <n>          téléchargements simultanés       (défaut ${DEFAULTS.concurrency})
  -o, --out <dossier>     dossier de sortie                (défaut ./downloads)
  -l, --list              liste les vidéos sans télécharger
  -f, --file <fichier>    lit les liens dans un fichier texte (un par ligne)
  -n, --batch <n>         télécharge par lots de n (Entrée = lot suivant)
      --include <regex>   ne parcourt que les URL qui matchent
      --exclude <regex>   ignore les URL qui matchent
      --cookies <fichier> cookies.txt (format Netscape) pour un site où tu es connecté
      --cookies-from <nav> firefox | chrome | edge … (lecture directe par yt-dlp)
      --ignore-robots     ignore robots.txt
      --delay <ms>        pause entre deux pages            (défaut ${DEFAULTS.delayMs})
  -h, --help
`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      site: { type: 'boolean', short: 's' },
      'max-pages': { type: 'string', short: 'p' },
      depth: { type: 'string', short: 'd' },
      browser: { type: 'string', short: 'b' },
      quality: { type: 'string', short: 'q' },
      jobs: { type: 'string', short: 'j' },
      out: { type: 'string', short: 'o' },
      list: { type: 'boolean', short: 'l' },
      batch: { type: 'string', short: 'n' },
      file: { type: 'string', short: 'f' },
      include: { type: 'string' },
      exclude: { type: 'string' },
      cookies: { type: 'string' },
      'cookies-from': { type: 'string' },
      'ignore-robots': { type: 'boolean' },
      delay: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const { values: a, positionals } = parsed;
let urls = parseUrls(positionals.join(' '));
if (a.file) urls = [...new Set([...urls, ...parseUrls(fs.readFileSync(a.file, 'utf8'))])];
if (a.help || !urls.length) {
  console.log(HELP);
  process.exit(a.help ? 0 : 2);
}

const int = (v) => (v == null ? undefined : Number.parseInt(v, 10));

try {
  const yt = locateYtDlp();
  console.log(
    `yt-dlp ${yt.version} · ffmpeg ${ffmpegLocation() ? 'ok' : 'absent'} · navigateur ${findBrowser() ? 'ok' : 'absent'}`,
  );
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const LEVEL = { info: (s) => s, success: c.green, warn: c.yellow, error: c.red };

const options = {
  scope: a.site ? 'site' : 'page',
  maxPages: int(a['max-pages']),
  maxDepth: int(a.depth),
  browser: a.browser,
  quality: a.quality,
  concurrency: int(a.jobs),
  outDir: a.out,
  listOnly: a.list,
  batchSize: int(a.batch),
  include: a.include,
  exclude: a.exclude,
  cookiesFile: a.cookies,
  cookiesFromBrowser: a['cookies-from'],
  respectRobots: a['ignore-robots'] ? false : undefined,
  delayMs: int(a.delay),
};
const jobs = urls.map((url) => new Job(url, options));
const multi = jobs.length > 1;
if (multi) console.log(`${jobs.length} liens, lancés en même temps`);

const fmtBytes = (n) => (n ? `${(n / 1048576).toFixed(n > 1e9 ? 0 : 1)} Mo` : '?');
const fmtSpeed = (n) => (n ? `${(n / 1048576).toFixed(1)} Mo/s` : '');
const shown = new Set();
const finished = new Set();
let progressLine = false;

const clearProgress = () => {
  if (progressLine && process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  progressLine = false;
};

jobs.forEach((job, i) => {
  // With several links, every line says which one it belongs to.
  const tag = multi ? c.dim(`[${i + 1} ${hostOf(job.url)}] `) : '';
  job.on('event', ({ type, data }) => {
    if (type === 'log') {
      clearProgress();
      console.log(tag + LEVEL[data.level](data.msg));
    } else if (type === 'video') {
      if (!shown.has(data.id)) {
        shown.add(data.id);
        clearProgress();
        console.log(`${tag}${c.cyan('+')} [${data.kind}] ${data.title || data.url}${a.list ? `\n  ${c.dim(data.url)}` : ''}`);
      }
      if (data.status === 'downloading' && !multi && process.stdout.isTTY) {
        const pct = data.percent != null ? `${data.percent.toFixed(1)}%` : '…';
        const label = (data.title || data.url).slice(0, 50);
        process.stdout.write(`\r\x1b[K${c.dim('↓')} ${label}  ${pct}  ${fmtBytes(data.total)}  ${fmtSpeed(data.speed)}`);
        progressLine = true;
      }
    }
  });
});

process.on('SIGINT', () => {
  clearProgress();
  for (const job of jobs) job.cancel();
});

await Promise.all(jobs.map((job) => job.run()));
clearProgress();

// --batch: after the first lot, each Enter starts the next one (across every link).
const batch = int(a.batch);
const waiting = () => jobs.flatMap((j) => j.state.videos.filter((v) => v.status === 'found').map((v) => [j, v]));
if (batch > 0 && !a.list && waiting().length && process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  while (waiting().length && !jobs.every((j) => j.cancelled)) {
    const left = waiting().length;
    const answer = await rl.question(
      c.cyan(`\n${left} vidéo(s) en attente — Entrée = les ${Math.min(batch, left)} suivantes, q = quitter : `),
    );
    if (answer.trim().toLowerCase().startsWith('q')) break;
    for (const [job, video] of waiting().slice(0, batch)) job.downloadVideo(video.id);
    await Promise.all(jobs.map((j) => j.downloadsIdle()));
    clearProgress();
  }
  rl.close();
}

const vids = jobs.flatMap((j) => j.state.videos);
const count = (s) => vids.filter((v) => v.status === s).length;
const dirs = [...new Set(jobs.map((j) => j.state.outDir).filter(Boolean))];
console.log(
  c.dim(
    `\n${vids.length} trouvée(s) · ${count('done')} téléchargée(s) · ${count('exists')} déjà là · ${
      count('error') + count('drm')
    } échec(s) · ${jobs.reduce((n, j) => n + j.state.pages.scanned, 0)} page(s) analysée(s)\n→ ${dirs.join('\n→ ')}`,
  ),
);
process.exit(jobs.every((j) => j.state.status === 'failed') ? 1 : 0);
