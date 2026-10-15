// Fetches the official yt-dlp binary into ./bin (run automatically after npm install).
// yt-dlp breaks often as sites change; re-run `npm run setup` or use the UI button to update.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binDir = path.join(root, 'bin');
const asset =
  process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
const target = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;

const force = process.argv.includes('--force');
if (fs.existsSync(target) && !force) {
  console.log(`[setup] yt-dlp déjà présent: ${target}`);
  process.exit(0);
}

try {
  fs.mkdirSync(binDir, { recursive: true });
  console.log(`[setup] téléchargement de ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
  console.log(`[setup] yt-dlp installé (${(buf.length / 1e6).toFixed(1)} Mo)`);
} catch (err) {
  // Never fail npm install over this: the app falls back to yt-dlp on PATH or `python -m yt_dlp`.
  console.warn(`[setup] impossible de récupérer yt-dlp: ${err.message}`);
}
