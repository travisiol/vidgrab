const $ = (sel, el = document) => el.querySelector(sel);
const jobsEl = $('#jobs');
const views = new Map(); // job id -> { el, state, videos: Map, source }

const STATUS = {
  running: 'en cours',
  done: 'terminé',
  failed: 'échec',
  cancelled: 'annulé',
};
const VIDEO_STATUS = {
  found: 'trouvée',
  queued: 'en attente',
  downloading: 'téléchargement',
  done: 'ok',
  exists: 'déjà là',
  error: 'erreur',
  drm: 'drm',
  cancelled: 'annulée',
};
const KIND = { native: 'yt-dlp', direct: 'fichier', hls: 'hls', dash: 'dash' };

const mb = (n) => (n ? `${(n / 1048576).toFixed(n > 1e9 ? 0 : 1)} Mo` : '');
const speed = (n) => (n ? `${(n / 1048576).toFixed(1)} Mo/s` : '');
const eta = (s) => (s ? (s > 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`) : '');

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- tools ----------

async function loadTools() {
  const t = await api('/api/tools').catch(() => null);
  if (!t) return;
  const set = (name, ok, label) => {
    const chip = $(`[data-tool="${name}"]`);
    chip.classList.toggle('ok', ok);
    chip.classList.toggle('bad', !ok);
    chip.textContent = label;
  };
  set('ytdlp', !!t.ytdlp, t.ytdlp ? `yt-dlp ${t.ytdlp}` : 'yt-dlp absent');
  set('ffmpeg', t.ffmpeg, t.ffmpeg ? 'ffmpeg' : 'ffmpeg absent');
  set('browser', t.browser, t.browser ? 'navigateur' : 'pas de navigateur');
}

$('#update-ytdlp').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Mise à jour…';
  try {
    const r = await api('/api/tools/update', { method: 'POST' });
    btn.textContent = r.before === r.after ? 'Déjà à jour' : `${r.before} → ${r.after}`;
  } catch (err) {
    btn.textContent = 'Échec';
    btn.title = err.message;
  }
  await loadTools();
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = 'Mettre à jour yt-dlp';
  }, 4000);
});

// ---------- form ----------

const form = $('#grab');
try {
  const saved = JSON.parse(localStorage.getItem('vidgrab:form') ?? '{}');
  for (const [name, value] of Object.entries(saved)) {
    const fields = form.elements.namedItem(name);
    if (!fields || name === 'url') continue;
    if (fields instanceof RadioNodeList) fields.value = value;
    else if (fields.type === 'checkbox') fields.checked = value;
    else fields.value = value;
  }
} catch {
  /* storage unavailable */
}

const modeSelect = $('#mode');
const syncBatchField = () => {
  $('#batch-field').hidden = modeSelect.value !== 'batch';
};
modeSelect.addEventListener('change', syncBatchField);
syncBatchField();

// Several links at once: the textarea grows with its content and the button shows the count.
const urlBox = $('#url');
const countUrls = () => new Set(urlBox.value.match(/https?:\/\/[^\s,;<>"']+/gi) ?? []).size;
const syncUrlBox = () => {
  urlBox.style.height = 'auto';
  urlBox.style.height = `${urlBox.scrollHeight + 2}px`;
  const n = countUrls();
  $('#submit').textContent = n > 1 ? `Récupérer les ${n} liens` : 'Récupérer';
  const hint = $('#url-hint');
  hint.hidden = n < 2;
  hint.textContent = `${n} liens : une tâche par lien, toutes lancées en même temps. Maj+Entrée pour aller à la ligne.`;
};
urlBox.addEventListener('input', syncUrlBox);
urlBox.addEventListener('keydown', (e) => {
  // Enter submits; Shift+Enter adds a line for the next link (pasting several links just works).
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
syncUrlBox();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.ignoreRobots = fd.has('ignoreRobots');
  const errorEl = $('#form-error');
  errorEl.hidden = true;
  try {
    const { url, ...prefs } = body;
    localStorage.setItem('vidgrab:form', JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const { ids } = await api('/api/jobs', { method: 'POST', body });
    ids.forEach((id) => attach(id));
    urlBox.value = '';
    syncUrlBox();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ---------- jobs ----------

function attach(id) {
  if (views.has(id)) return;
  const el = $('#job-tpl').content.firstElementChild.cloneNode(true);
  jobsEl.prepend(el);
  const view = { el, state: null, videos: new Map(), source: null };
  views.set(id, view);
  $('#empty').hidden = true;

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'cancel') await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
    if (act === 'open') await api(`/api/jobs/${id}/open`, { method: 'POST' });
    if (act === 'all') await api(`/api/jobs/${id}/download`, { method: 'POST', body: { all: true } });
    if (act === 'next') await api(`/api/jobs/${id}/download`, { method: 'POST', body: { next: batchOf(view) } });
    if (act === 'dl') {
      const videoId = btn.closest('[data-id]').dataset.id;
      await api(`/api/jobs/${id}/download`, { method: 'POST', body: { videoId } });
    }
    if (act === 'remove') {
      await api(`/api/jobs/${id}`, { method: 'DELETE' });
      view.source?.close();
      el.remove();
      views.delete(id);
      $('#empty').hidden = views.size > 0;
    }
  });

  const source = new EventSource(`/api/jobs/${id}/events`);
  view.source = source;
  source.addEventListener('snapshot', (e) => {
    view.state = JSON.parse(e.data);
    $('ol', el).replaceChildren();
    view.state.log.forEach((entry) => addLog(view, entry));
    view.state.videos.forEach((v) => renderVideo(view, v));
    renderJob(view);
  });
  source.addEventListener('video', (e) => {
    const v = JSON.parse(e.data);
    const list = view.state.videos;
    const i = list.findIndex((x) => x.id === v.id);
    if (i >= 0) list[i] = v;
    else list.push(v);
    renderVideo(view, v);
    renderJob(view);
  });
  source.addEventListener('pages', (e) => {
    view.state.pages = JSON.parse(e.data);
    renderJob(view);
  });
  source.addEventListener('status', (e) => {
    Object.assign(view.state, JSON.parse(e.data));
    renderJob(view);
  });
  source.addEventListener('log', (e) => {
    const entry = JSON.parse(e.data);
    view.state.log.push(entry);
    addLog(view, entry);
    renderJob(view);
  });
}

const batchOf = (view) => view.state?.options?.batchSize || 5;

function renderJob(view) {
  const { el, state } = view;
  if (!state) return;
  el.dataset.status = state.status;
  $('.badge', el).textContent = STATUS[state.status] ?? state.status;
  const link = $('.job-url', el);
  link.textContent = state.url.replace(/^https?:\/\//, '');
  link.href = state.url;
  const videos = state.videos;
  const count = (...s) => videos.filter((v) => s.includes(v.status)).length;
  $('[data-stat=pages]', el).textContent = state.pages.scanned;
  $('[data-stat=found]', el).textContent = videos.length;
  $('[data-stat=done]', el).textContent = count('done', 'exists');
  $('[data-stat=failed]', el).textContent = count('error', 'drm');
  $('.last-log', el).textContent = state.log.at(-1)?.msg ?? '';
  $('[data-act=cancel]', el).hidden = state.status !== 'running';
  const waiting = count('found');
  const n = batchOf(view);
  const next = $('[data-act=next]', el);
  next.hidden = waiting === 0;
  next.textContent = waiting > n ? `Les ${n} suivantes` : `Les ${waiting} dernière${waiting > 1 ? 's' : ''}`;
  $('[data-wait]', el).hidden = waiting === 0;
  $('[data-stat=waiting]', el).textContent = waiting;
  $('[data-act=all]', el).hidden = !videos.some((v) => ['found', 'error', 'cancelled'].includes(v.status));
}

function renderVideo(view, v) {
  let row = view.videos.get(v.id);
  if (!row) {
    row = $('#video-tpl').content.firstElementChild.cloneNode(true);
    row.dataset.id = v.id;
    $('.videos', view.el).append(row);
    view.videos.set(v.id, row);
  }
  row.dataset.s = v.status;
  const thumb = $('.thumb', row);
  if (v.thumb && thumb.dataset.src !== v.thumb) {
    thumb.dataset.src = v.thumb;
    thumb.style.backgroundImage = `url("${v.thumb.replace(/"/g, '%22')}")`;
    thumb.textContent = '';
  } else if (!v.thumb) {
    thumb.textContent = '▶';
  }
  const title = v.title || v.file?.split(/[\\/]/).pop() || v.url.split('/').pop() || v.url;
  $('.v-title', row).textContent = title;
  $('.v-title', row).title = v.url;
  $('.kind', row).textContent = v.extractor && v.kind === 'native' ? v.extractor : KIND[v.kind] ?? v.kind;
  const page = $('.v-page', row);
  page.textContent = v.page?.replace(/^https?:\/\//, '') ?? '';
  page.href = v.page ?? '#';
  $('.bar i', row).style.width = `${Math.max(0, Math.min(100, v.percent ?? 0))}%`;
  const status = $('.v-status', row);
  status.dataset.s = v.status;
  status.textContent = VIDEO_STATUS[v.status] ?? v.status;
  let info = '';
  if (v.status === 'downloading')
    info = [v.percent != null ? `${v.percent.toFixed(1)} %` : '…', mb(v.total), speed(v.speed), eta(v.eta)]
      .filter(Boolean)
      .join(' · ');
  else if (v.status === 'error' || v.status === 'drm') info = v.error ?? '';
  else if (v.file) info = v.file.split(/[\\/]/).pop();
  $('.v-info', row).textContent = info;
  $('.v-info', row).title = info;
  $('[data-act=dl]', row).hidden = !['found', 'error', 'cancelled'].includes(v.status);
}

function addLog(view, entry) {
  const li = document.createElement('li');
  li.dataset.l = entry.level;
  li.textContent = `${new Date(entry.t).toLocaleTimeString('fr-FR')}  ${entry.msg}`;
  const ol = $('ol', view.el);
  ol.append(li);
  ol.scrollTop = ol.scrollHeight;
}

loadTools();
api('/api/jobs')
  .then((list) => list.reverse().forEach((j) => attach(j.id)))
  .catch(() => {});
