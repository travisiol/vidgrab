#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Job, DEFAULTS } from './engine.js';
import { locateYtDlp, ffmpegLocation } from './ytdlp.js';
import { findBrowser } from './browser.js';

const HELP = `vidgrab — télécharge les vidéos d'une page ou d'un site entier

Usage
  vidgrab <url> [options]

Options
  -s, --site              parcourt tout le site (sinon : la page seule)
  -p, --max-pages <n>     pages max à parcourir            (défaut ${DEFAULTS.maxPages})
  -d, --depth <n>         profondeur max de liens          (défaut ${DEFAULTS.maxDepth})
  -b, --browser <mode>    auto | always | never            (défaut auto)
  -q, --quality <q>       best | 1080 | 720 | 480 | audio  (défaut best)
  -j, --jobs <n>          téléchargements simultanés       (défaut ${DEFAULTS.concurrency})
  -o, --out <dossier>     dossier de sortie                (défaut ./downloads)
  -l, --list              liste les vidéos sans télécharger
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
if (a.help || !positionals.length) {
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

const job = new Job(positionals[0], {
  scope: a.site ? 'site' : 'page',
  maxPages: int(a['max-pages']),
  maxDepth: int(a.depth),
  browser: a.browser,
  quality: a.quality,
  concurrency: int(a.jobs),
  outDir: a.out,
  listOnly: a.list,
  include: a.include,
  exclude: a.exclude,
  cookiesFile: a.cookies,
  cookiesFromBrowser: a['cookies-from'],
  respectRobots: a['ignore-robots'] ? false : undefined,
  delayMs: int(a.delay),
});

const fmtBytes = (n) => (n ? `${(n / 1048576).toFixed(n > 1e9 ? 0 : 1)} Mo` : '?');
const fmtSpeed = (n) => (n ? `${(n / 1048576).toFixed(1)} Mo/s` : '');
const shown = new Set();
let progressLine = false;

const clearProgress = () => {
  if (progressLine && process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  progressLine = false;
};

job.on('event', ({ type, data }) => {
  if (type === 'log') {
    clearProgress();
    console.log(LEVEL[data.level](data.msg));
  } else if (type === 'video') {
    if (!shown.has(data.id)) {
      shown.add(data.id);
      clearProgress();
      console.log(`${c.cyan('+')} [${data.kind}] ${data.title || data.url}${a.list ? `\n  ${c.dim(data.url)}` : ''}`);
    }
    if (data.status === 'downloading' && process.stdout.isTTY) {
      const pct = data.percent != null ? `${data.percent.toFixed(1)}%` : '…';
      const label = (data.title || data.url).slice(0, 50);
      process.stdout.write(`\r\x1b[K${c.dim('↓')} ${label}  ${pct}  ${fmtBytes(data.total)}  ${fmtSpeed(data.speed)}`);
      progressLine = true;
    }
  }
});

process.on('SIGINT', () => {
  clearProgress();
  job.cancel();
});

await job.run();
clearProgress();
const vids = job.state.videos;
const count = (s) => vids.filter((v) => v.status === s).length;
console.log(
  c.dim(
    `\n${vids.length} trouvée(s) · ${count('done')} téléchargée(s) · ${count('exists')} déjà là · ${
      count('error') + count('drm')
    } échec(s) · ${job.state.pages.scanned} page(s) analysée(s)\n→ ${job.state.outDir}`,
  ),
);
process.exit(job.state.status === 'failed' ? 1 : 0);
