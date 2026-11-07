// BugSnap player: video with custom controls, and steps, console and network logs kept in
// sync with playback. All page-derived text is rendered with textContent.
//
// Two sources:
//  - local server: /r/<id>, data from /api/recordings/<id> (review screen, editing, upload status)
//  - public player (GitHub Pages, built by scripts/build-viewer.js): ?id=<manifest>&v=<video>,
//    data and video streamed straight from Google Drive with a browser API key.

const $ = (id) => document.getElementById(id);
const CONFIG = globalThis.SCREENREC_CONFIG || {};
const params = new URLSearchParams(location.search);
const driveMode = Boolean(CONFIG.driveApiKey);
const id = driveMode ? params.get('id') || '' : location.pathname.split('/').filter(Boolean).pop();
const videoParam = params.get('v') || '';
const driveMedia = (fileId) =>
  `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(CONFIG.driveApiKey)}`;
const drivePreview = (fileId) => `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`;
const video = $('video');
const ICONS = globalThis.ScreenRecIcons || {};

let rec;
let durationSec = 0;
const lists = { steps: [], console: [], network: [] };
let activeTab = 'steps';
let level = 'all';
let fallbackActive = false;

if (driveMode) document.body.classList.add('public');

// ---------------------------------------------------------------- helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Bundled Phosphor icon (trusted SVG string). */
function icon(name, cls = 'icon') {
  const span = h('span', { class: cls, 'aria-hidden': 'true' });
  span.innerHTML = ICONS[name] || '';
  return span;
}

function paintIcons(scope = document) {
  scope.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = ICONS[el.dataset.icon] || ''));
}

function setIcon(el, name) {
  const slot = el.querySelector('[data-icon]') || el;
  slot.dataset.icon = name;
  slot.innerHTML = ICONS[name] || '';
}

const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

function relative(iso) {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(diff)) return '';
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Seconds into the video for an event, with paused stretches removed. */
function offsetOf(ev) {
  const ts = ev.type === 'network' && ev.startedAt ? ev.startedAt : ev.ts;
  let paused = 0;
  for (const p of rec.pauses || []) {
    if (p.start >= ts) break;
    paused += Math.min(ts, p.end) - p.start;
  }
  return Math.max(0, (ts - rec.startedAt - paused) / 1000);
}

const isHttp = (u) => /^https?:\/\//i.test(u || '');
const isNetError = (ev) => ev.status === 0 || ev.status >= 400;

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}`;
  } catch {
    return url || '';
  }
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
function pathOf(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url || '';
  }
}

const pageUrl = () => {
  const q = new URLSearchParams(location.search);
  q.delete('t');
  q.delete('review');
  const s = q.toString();
  return `${location.origin}${location.pathname}${s ? `?${s}` : ''}`;
};

/** The link to hand out: the public player (reserved when recording started), else this page. */
const shareLink = () => (driveMode ? pageUrl() : rec?.shareUrl || rec?.viewerUrl || pageUrl());
const isPublicLink = () => driveMode || Boolean(rec?.shareUrl);
const withTime = (url, sec) => `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(sec)}`;

// ---------------------------------------------------------------- load

async function fetchRecording() {
  if (driveMode) {
    if (!id) return null;
    // index.html starts this request before any script loads (see build-viewer.js).
    const early = globalThis.__bugsnapManifest;
    globalThis.__bugsnapManifest = null;
    const m = early ? await early : await fetch(driveMedia(id), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!m || !['bugsnap', 'screenrec'].includes(m.app)) return null;
    if (m.status === 'processing') return { status: 'uploading', meta: m.record?.meta || {}, createdAt: m.record?.createdAt, video: m.video, events: [] };
    return { ...m.record, events: m.events || [], video: m.video, posterData: m.posterData, poster: m.poster, status: 'ready' };
  }
  const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`, { cache: 'no-store' });
  return res.ok ? res.json() : null;
}

async function load() {
  paintIcons();
  if (driveMode) {
    document.querySelectorAll('[data-local-only]').forEach((el) => el.remove());
    // The video id is in the link, so streaming starts while the logs load.
    if (videoParam) video.src = driveMedia(videoParam);
  }
  rec = await fetchRecording().catch(() => null);
  if (!rec) {
    if (driveMode && videoParam) return useDriveFallback('Recording details could not be loaded, so steps and logs are not shown. The video plays in Google Drive’s player.');
    document.querySelector('.topbar').hidden = true;
    $('layout').hidden = true;
    $('notfound').hidden = false;
    document.title = 'Recording not found · BugSnap';
    return;
  }
  render();
  if (needsPoll()) poll();
  const tab = location.hash.slice(1);
  document.querySelector(`[data-tab="${CSS.escape(tab)}"]`)?.click();
  const t = Number(params.get('t'));
  if (t > 0) video.addEventListener('loadedmetadata', () => (video.currentTime = t), { once: true });
  if (!driveMode && params.has('review')) openReview();
}

const uploading = (r) => ['pending', 'uploading', 'reserved'].includes(r?.drive?.status);
const needsPoll = () => (driveMode ? rec.status === 'uploading' : rec.status !== 'ready' || uploading(rec));

let pollTimer = null;
function poll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const r = await fetchRecording().catch(() => null);
    if (!r) return;
    const becameReady = rec.status !== 'ready' && r.status === 'ready';
    if (becameReady) {
      const t = video.currentTime;
      rec = r;
      render();
      if (t) video.addEventListener('loadedmetadata', () => (video.currentTime = t), { once: true });
    } else {
      rec = { ...rec, drive: r.drive, shareUrl: r.shareUrl, driveConnected: r.driveConnected, meta: r.meta || rec.meta };
      renderBanner();
      renderDetails();
    }
    if (!needsPoll()) clearInterval(pollTimer);
  }, driveMode ? 5000 : 2500);
}

// ---------------------------------------------------------------- render

function render() {
  durationSec = (rec.durationMs || 0) / 1000;
  renderDetails();

  const stateEl = $('stageState');
  $('controls').hidden = rec.status !== 'ready' || fallbackActive;
  if (rec.status !== 'ready') {
    // Recording, processing, or (public link) still uploading to Drive.
    stateEl.hidden = false;
    $('stageTitle').textContent = rec.status === 'recording' ? 'Still recording' : driveMode ? 'Uploading…' : 'Preparing video…';
    $('stageText').textContent = driveMode ? 'This recording is still uploading. It opens here automatically.' : 'This page updates by itself.';
    video.removeAttribute('src');
    $('bigPlay').hidden = true;
  } else {
    stateEl.hidden = true;
    if (driveMode) {
      const vid = rec.video?.id || videoParam;
      if (!video.src || !video.src.includes(encodeURIComponent(vid))) video.src = driveMedia(vid);
      if (rec.posterData) video.poster = rec.posterData;
      else if (rec.poster?.id) video.poster = driveMedia(rec.poster.id);
      $('download').href = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(vid)}`;
      $('download').removeAttribute('download');
      $('download').target = '_blank';
      watchForStall();
    } else {
      const src = `/api/recordings/${encodeURIComponent(id)}/video`;
      // The version query makes the browser fetch the processed file once it replaces the raw one.
      const want = `${src}?v=${encodeURIComponent(rec.processing ? 'p' : rec.updatedAt || '')}`;
      if (!video.src.endsWith(want)) video.src = want;
      if (rec.hasPoster) video.poster = `/api/recordings/${encodeURIComponent(id)}/poster`;
      $('download').href = src;
      $('download').setAttribute('download', `recording-${id}.webm`);
    }
    $('bigPlay').hidden = !video.paused || video.currentTime > 0;
  }
  const driveVideo = driveMode ? rec.video?.id || videoParam : rec.drive?.status === 'done' ? rec.drive.videoId : null;
  $('openDrive').hidden = !driveVideo;
  if (driveVideo) $('openDrive').href = `https://drive.google.com/file/d/${driveVideo}/view`;
  renderBanner();

  // Events originate in arbitrary web pages: coerce every displayed field to a string.
  const str = (v) => (v === undefined || v === null ? undefined : String(v));
  const events = (rec.events || [])
    .filter((e) => e && typeof e.ts === 'number')
    .map((e) => ({ ...e, text: str(e.text), message: str(e.message) ?? '', url: str(e.url), method: str(e.method), selector: str(e.selector), stack: str(e.stack), source: str(e.source), responseBody: str(e.responseBody), level: str(e.level), status: Number(e.status) || 0 }));
  const byTime = (a, b) => offsetOf(a) - offsetOf(b);
  lists.steps = events.filter((e) => e.type === 'action' || e.type === 'navigation').sort(byTime);
  lists.console = events.filter((e) => e.type === 'console').sort(byTime);
  lists.network = events.filter((e) => e.type === 'network').sort(byTime);

  setCount('steps', lists.steps.length);
  setCount('console', lists.console.length, lists.console.filter((e) => e.level === 'error').length, 'error');
  setCount('network', lists.network.length, lists.network.filter(isNetError).length, 'failed');

  renderSteps();
  renderConsole();
  renderNetwork();
  renderInfo();
  renderMarkers();
  $('report').value = buildReport();
  sync();
}

function renderDetails() {
  const meta = rec.meta || {};
  const title = meta.title || shortUrl(meta.startUrl) || 'Untitled';
  document.title = `${title} · BugSnap`;
  $('title').textContent = title;
  $('crumbTitle').textContent = title;

  const desc = $('desc');
  desc.className = 'desc';
  if (meta.description) desc.textContent = meta.description;
  else if (!driveMode) {
    desc.classList.add('placeholder');
    desc.replaceChildren(h('button', { type: 'button', onclick: () => openReview() }, 'Add a description'));
  } else desc.textContent = '';
  desc.hidden = !meta.description && driveMode;

  const who = meta.reporter || 'Someone';
  const when = rec.startedAt || rec.createdAt;
  const items = [
    h('div', { class: 'item' }, h('span', { class: 'avatar' }, who.trim().charAt(0) || '?'), h('span', {}, h('strong', {}, who), ` recorded this${durationSec ? ` (${fmt(durationSec)})` : ''}`, when ? ` · ${relative(new Date(when).toISOString())}` : '')),
  ];
  const d = rec.drive;
  if (!driveMode && d) {
    const text = d.status === 'done' ? 'Shared on Google Drive · anyone with the link can watch' : uploading(rec) ? 'Uploading to Google Drive…' : d.status === 'error' ? 'Google Drive upload failed' : '';
    if (text) items.push(h('div', { class: 'item' }, h('span', { class: 'avatar drive' }, icon(d.status === 'done' ? 'cloud-check' : 'cloud-arrow-up')), h('span', {}, text)));
  }
  $('activity').replaceChildren(...items);
}

/** Status line under the top bar: Drive upload problems, or how to share. */
function renderBanner() {
  const banner = $('banner');
  const action = $('bannerAction');
  const set = (text, { button = null, tone = '' } = {}) => {
    banner.hidden = false;
    banner.className = `banner ${tone}`;
    setIcon($('bannerIcon'), tone === 'bad' ? 'warning-circle' : tone === 'ok' ? 'check' : 'info');
    $('bannerText').textContent = text;
    action.hidden = !button;
    if (button) {
      action.textContent = button.label;
      action.onclick = button.onClick;
    }
  };
  if (driveMode || rec.status !== 'ready') return (banner.hidden = !fallbackActive);
  const d = rec.drive;
  if (!d || d.status === 'done' || uploading(rec)) return (banner.hidden = true);
  const upload = async () => {
    action.disabled = true;
    const res = await fetch(`/api/recordings/${encodeURIComponent(id)}/drive`, { method: 'POST' }).catch(() => null);
    action.disabled = false;
    if (!res || !res.ok) {
      const b = await res?.json().catch(() => ({}));
      return set(b?.error || 'Could not start the upload.', { tone: 'bad', button: { label: 'Retry', onClick: upload } });
    }
    rec = { ...rec, drive: { ...rec.drive, status: 'pending' } };
    renderBanner();
    renderDetails();
    poll();
  };
  if (d.status === 'error') return set(`Drive upload failed: ${d.error}`, { tone: 'bad', button: { label: 'Retry', onClick: upload } });
  if (rec.driveConnected) return set('Not on Google Drive yet.', { button: { label: 'Upload', onClick: upload } });
  set('Only you can open this link. Connect Google Drive to share it.', { button: { label: 'Connect', onClick: () => (location.href = '/settings') } });
}

// When Google won't stream the file to us (throttled or blocked), Drive's own player still works.
function useDriveFallback(message) {
  const vid = rec?.video?.id || videoParam;
  if (!vid || fallbackActive) return;
  fallbackActive = true;
  video.pause();
  video.removeAttribute('src');
  video.load();
  const frame = h('iframe', { src: drivePreview(vid), allow: 'autoplay; fullscreen', allowfullscreen: '', title: 'Recording' });
  video.replaceWith(frame);
  $('controls').hidden = true;
  $('bigPlay').hidden = true;
  $('stageState').hidden = true;
  const banner = $('banner');
  banner.hidden = false;
  banner.className = 'banner';
  setIcon($('bannerIcon'), 'info');
  $('bannerText').textContent = message;
  $('bannerAction').hidden = true;
  if (!rec) {
    $('title').textContent = 'Recording';
    $('desc').hidden = true;
    $('side').hidden = true;
    $('layout').classList.add('no-side', 'side-gone');
  }
}

let stallTimer;
function watchForStall() {
  clearTimeout(stallTimer);
  if (video.readyState >= 2) return;
  stallTimer = setTimeout(() => {
    if (video.readyState >= 2 || fallbackActive) return;
    const banner = $('banner');
    banner.hidden = false;
    banner.className = 'banner';
    setIcon($('bannerIcon'), 'info');
    $('bannerText').textContent = 'The video is slow to load from Google Drive.';
    $('bannerAction').hidden = false;
    $('bannerAction').textContent = 'Use Drive player';
    $('bannerAction').onclick = () => useDriveFallback('Playing with Google Drive’s player. Steps still list what happened, but do not follow the video.');
  }, 9000);
}
video.addEventListener('loadeddata', () => {
  clearTimeout(stallTimer);
  if (!fallbackActive && driveMode) $('banner').hidden = true;
});
video.addEventListener('error', () => {
  if (driveMode && rec?.status === 'ready') useDriveFallback('Google Drive would not stream this video to the player, so it plays in Drive’s own player. Steps still list what happened.');
});

function setCount(name, n, bad = 0, noun = '') {
  $(`c-${name}`).textContent = String(n);
  const badge = $(`e-${name}`);
  if (!badge) return;
  badge.hidden = !bad;
  badge.textContent = String(bad);
  badge.dataset.tip = `${bad} ${noun}${noun === 'error' && bad !== 1 ? 's' : ''}`;
}

function row(ev, { cls = '', glyph, body }) {
  const off = offsetOf(ev);
  const li = h('li', { class: cls, onclick: () => seek(off - 0.5) }, h('span', { class: 't' }, fmt(off)), icon(glyph, 'glyph'), h('div', { class: 'body' }, ...body));
  li._off = off;
  li._ev = ev;
  return li;
}

function empty(iconName, text) {
  return h('li', { class: 'empty' }, icon(iconName), text);
}

const ACTION_ICON = { click: 'cursor-click', input: 'keyboard', key: 'keyboard', select: 'list-checks', submit: 'check', upload: 'folder-open' };

function renderSteps() {
  const items = lists.steps.map((ev) =>
    row(ev, {
      glyph: ev.type === 'navigation' ? 'compass' : ACTION_ICON[ev.action] || 'cursor-click',
      body: [
        h('div', { class: 'text' }, ev.text || ev.action || ''),
        ev.type === 'navigation' && ev.url ? h('div', { class: 'sub' }, shortUrl(ev.url)) : null,
        ev.type === 'action' && ev.selector ? h('div', { class: 'sub code' }, ev.selector) : null,
      ],
    }),
  );
  $('list-steps').replaceChildren(...(items.length ? items : [empty('cursor-click', rec.status === 'ready' ? 'No steps captured' : 'Steps appear when the recording is ready')]));
}

function renderConsole() {
  const items = lists.console.map((ev) =>
    row(ev, {
      cls: ev.level === 'error' ? 'bad' : ev.level === 'warn' ? 'warn' : '',
      glyph: ev.level === 'error' || ev.level === 'warn' ? 'warning-circle' : 'terminal-window',
      body: [
        h('div', { class: 'code' }, ev.message || ''),
        ev.source ? h('div', { class: 'sub code' }, ev.source) : null,
        ev.stack ? h('details', { onclick: (e) => e.stopPropagation() }, h('summary', {}, 'Stack trace'), h('div', { class: 'details-box' }, ev.stack)) : null,
      ],
    }),
  );
  $('list-console').replaceChildren(...(items.length ? items : [empty('terminal-window', 'No console messages')]));
}

function renderNetwork() {
  const items = lists.network.map((ev) => {
    const bad = isNetError(ev);
    const detail = h(
      'div',
      { class: 'details-box', hidden: true, onclick: (e) => e.stopPropagation() },
      `${ev.method} ${ev.url}\n`,
      `Status   ${ev.status || 'failed'} ${ev.statusText || ''}\n`,
      ev.contentType ? `Type     ${ev.contentType}\n` : '',
      ev.durationMs !== undefined ? `Time     ${ev.durationMs} ms\n` : '',
      ev.error ? `Error    ${ev.error}\n` : '',
      ev.responseBody ? `\nResponse\n${ev.responseBody}` : '',
    );
    const toggle = h('button', { class: 'more', type: 'button', onclick: (e) => { e.stopPropagation(); detail.hidden = !detail.hidden; toggle.textContent = detail.hidden ? 'Details' : 'Hide'; } }, 'Details');
    return row(ev, {
      cls: bad ? 'bad' : '',
      glyph: bad ? 'warning-circle' : 'globe-simple',
      body: [
        h('div', { class: 'text' }, h('span', { class: `status${bad ? ' bad' : ''}` }, ev.status || 'ERR'), h('span', { class: 'method' }, ev.method || 'GET'), pathOf(ev.url)),
        h('div', { class: 'sub' }, [hostOf(ev.url), ev.durationMs !== undefined ? `${ev.durationMs} ms` : null].filter(Boolean).join('  ·  ')),
        toggle,
        detail,
      ],
    });
  });
  $('list-network').replaceChildren(...(items.length ? items : [empty('globe-simple', 'No requests captured')]));
}

function osIcon(os = '') {
  if (/windows/i.test(os)) return 'windows-logo';
  if (/mac|ios/i.test(os)) return 'apple-logo';
  if (/linux|chrome os|android/i.test(os)) return 'linux-logo';
  return 'monitor';
}

function renderInfo() {
  const meta = rec.meta || {};
  const env = meta.env || {};
  const size = (o) => (o && o.width ? `${o.width} × ${o.height}` : undefined);
  const loc = env.location;
  const tz = env.timeZone ? `${env.timeZone} (UTC${env.utcOffsetMinutes >= 0 ? '+' : '-'}${fmtOffset(env.utcOffsetMinutes)})` : undefined;
  const link = (href, text) => (isHttp(href) ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text || href) : text || href);

  // Visited pages, each with the moment it was opened.
  const seen = new Set();
  const visits = lists.steps.filter((e) => e.type === 'navigation' && e.url && !seen.has(e.url) && seen.add(e.url));
  const blocks = [];
  if (visits.length) {
    blocks.push(
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, 'Visited URLs'), h('div', { class: 'urls' },
        ...visits.map((e) => h('button', { type: 'button', 'data-tip': 'Jump to this moment', onclick: () => seek(offsetOf(e)) }, h('span', { class: 'tt' }, fmt(offsetOf(e))), h('span', { class: 'u' }, shortUrl(e.url))))),
      ),
    );
  }
  const when = new Date(rec.startedAt || rec.createdAt);
  const rows = [
    ['Recorded', when.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })],
    ['Duration', durationSec ? fmt(durationSec) : undefined],
    ['Recorded by', meta.reporter],
    ['Type', meta.mode === 'desktop' ? `Screen (${{ monitor: 'entire screen', window: 'window', browser: 'browser tab' }[env.displaySurface] || 'screen'})` : 'Browser tab'],
    ['Location', loc && loc.latitude !== undefined
      ? [icon('map-pin'), link(`https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}#map=14/${loc.latitude}/${loc.longitude}`, `${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}`)]
      : loc?.error ? 'Not available' : undefined],
    ['OS', env.os || meta.platform?.os ? [icon(osIcon(env.os || meta.platform?.os)), [env.os || meta.platform?.os, env.architecture].filter(Boolean).join(' · ')] : undefined],
    ['Browser', env.browser ? [icon('google-chrome-logo'), env.browser] : undefined],
    ['Window size', size(meta.window)],
    ['Viewport', size(meta.viewport)],
    ['Screen', size(env.screen)],
    ['Time zone', tz],
    ['Language', env.language],
    ['Connection', env.connection?.effectiveType],
    ['CPU / memory', env.hardwareConcurrency ? `${env.hardwareConcurrency} cores${env.deviceMemoryGb ? ` · ${env.deviceMemoryGb} GB+` : ''}` : undefined],
    ['Start page', meta.startUrl ? link(meta.startUrl, shortUrl(meta.startUrl)) : undefined],
    ['Extension', meta.extensionVersion],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  blocks.push(h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
  if (env.userAgent) blocks.push(h('details', {}, h('summary', {}, 'User agent'), h('p', { class: 'ua' }, env.userAgent)));
  $('info').replaceChildren(...blocks);
}

function fmtOffset(min) {
  const a = Math.abs(min || 0);
  return `${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- progress bar markers

function renderMarkers() {
  const total = timelineDuration();
  if (!total) return $('markers').replaceChildren();
  const label = (e) => e.text || e.message || `${e.method} ${pathOf(e.url)} returned ${e.status || 'an error'}`;
  const marks = [
    ...lists.steps.filter((e) => e.type === 'action').map((e) => ({ e, cls: 'action' })),
    ...lists.console.filter((e) => e.level === 'error').map((e) => ({ e, cls: 'error' })),
    ...lists.network.filter(isNetError).map((e) => ({ e, cls: 'error' })),
  ];
  $('markers').replaceChildren(
    ...marks.map(({ e, cls }) => {
      const off = offsetOf(e);
      const m = h('div', { class: `marker ${cls}`, style: `left:${Math.min(100, (off / total) * 100)}%` });
      m._label = `${fmt(off)}  ${label(e).split('\n')[0]}`;
      return m;
    }),
  );
}

function timelineDuration() {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : durationSec;
}

// ---------------------------------------------------------------- bug report draft

function buildReport() {
  const meta = rec.meta || {};
  const env = meta.env || {};
  const steps = lists.steps.filter((e) => e.text && e.transition !== 'start');
  const errors = lists.console.filter((e) => e.level === 'error');
  const failed = lists.network.filter(isNetError);
  const page = shortUrl(meta.startUrl) || meta.title || 'the page';

  let title = meta.title || `Problem on ${page}`;
  if (!meta.description && errors[0]) title = `${errors[0].message.split('\n')[0].slice(0, 90)} on ${page}`;
  else if (!meta.description && failed[0]) title = `${failed[0].method} ${pathOf(failed[0].url).split('?')[0]} returns ${failed[0].status || 'a network error'}`;

  const evidence = [
    ...errors.slice(0, 5).map((e) => `- [${fmt(offsetOf(e))}] Console error: \`${e.message.split('\n')[0].slice(0, 200)}\``),
    ...failed.slice(0, 5).map((e) => `- [${fmt(offsetOf(e))}] \`${e.method} ${shortUrl(e.url)}\` returned ${e.status || 'a network error'}${e.error ? ` (${e.error})` : ''}`),
  ];
  const size = (o) => (o && o.width ? `${o.width}x${o.height}` : 'unknown');

  return [
    `## ${title}`,
    '',
    '### Description',
    meta.description || '_Describe the problem in one or two sentences._',
    '',
    '### Preconditions',
    `- Start on: ${meta.startUrl || 'unknown'}`,
    `- ${env.browser || 'Unknown browser'} on ${env.os || meta.platform?.os || 'unknown OS'}`,
    `- Window ${size(meta.window)}, viewport ${size(meta.viewport)}`,
    '',
    '### Steps to reproduce',
    ...(steps.length ? steps.map((e, i) => `${i + 1}. ${e.text} _(${fmt(offsetOf(e))})_`) : ['1. _No steps captured_']),
    '',
    '### Actual result',
    '_What happened._',
    ...(evidence.length ? ['', 'Errors captured during the recording:', ...evidence] : []),
    '',
    '### Expected result',
    '_What should have happened._',
    '',
    '### Recording',
    shareLink(),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- playback

function seek(sec) {
  if (fallbackActive) return;
  video.currentTime = Math.max(0, Math.min(sec, timelineDuration() || sec));
  if (video.paused) video.play().catch(() => {});
}

const lastCurrent = {};
function sync() {
  const t = video.currentTime || 0;
  const total = timelineDuration();
  const pct = total ? Math.min(100, (t / total) * 100) : 0;
  $('clock').textContent = `${fmt(t)} / ${fmt(total)}`;
  $('played').style.width = `${pct}%`;
  $('knob').style.left = `${pct}%`;
  $('track').setAttribute('aria-valuenow', String(Math.round(t)));
  $('track').setAttribute('aria-valuemax', String(Math.round(total)));
  $('copyAtTime').querySelector('span:last-child').textContent = `Copy link at ${fmt(t)}`;

  const list = $(`list-${activeTab}`);
  if (!list) return;
  let current = null;
  for (const li of list.children) {
    if (li._off === undefined) continue;
    const past = li._off <= t + 0.05;
    li.classList.toggle('future', !past);
    if (past && !li.hidden) current = li;
  }
  if (lastCurrent[activeTab] !== current) {
    lastCurrent[activeTab]?.classList.remove('current');
    current?.classList.add('current');
    lastCurrent[activeTab] = current;
    if (current && $('follow').checked && !video.paused) current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function updatePlayState() {
  const playing = !video.paused && !video.ended;
  setIcon($('playBtn'), playing ? 'pause-fill' : 'play-fill');
  $('playBtn').dataset.tip = playing ? 'Pause' : 'Play';
  if (playing) $('bigPlay').hidden = true;
}

function updateBuffered() {
  const total = timelineDuration();
  if (!total || !video.buffered.length) return;
  $('buffered').style.width = `${Math.min(100, (video.buffered.end(video.buffered.length - 1) / total) * 100)}%`;
}

video.addEventListener('timeupdate', sync);
video.addEventListener('seeked', sync);
video.addEventListener('play', updatePlayState);
video.addEventListener('pause', updatePlayState);
video.addEventListener('ended', updatePlayState);
video.addEventListener('progress', updateBuffered);
video.addEventListener('volumechange', () => {
  setIcon($('muteBtn'), video.muted || video.volume === 0 ? 'speaker-slash' : 'speaker-high');
  $('muteBtn').dataset.tip = video.muted ? 'Unmute' : 'Mute';
});
video.addEventListener('loadedmetadata', () => {
  // An unprocessed WebM reports Infinity; seeking far forces Chrome to compute the duration.
  if (!Number.isFinite(video.duration)) {
    const restore = () => {
      video.removeEventListener('durationchange', restore);
      video.currentTime = 0;
      renderMarkers();
      sync();
    };
    video.addEventListener('durationchange', restore);
    video.currentTime = 1e7;
  } else if (rec) {
    renderMarkers();
  }
  sync();
});

const togglePlay = () => {
  if (fallbackActive || rec?.status !== 'ready') return;
  video.paused || video.ended ? video.play().catch(() => {}) : video.pause();
};
video.addEventListener('click', togglePlay);
$('bigPlay').addEventListener('click', togglePlay);
$('playBtn').addEventListener('click', togglePlay);
$('muteBtn').addEventListener('click', () => (video.muted = !video.muted));
document.querySelectorAll('[data-skip]').forEach((b) => b.addEventListener('click', () => seek(video.currentTime + Number(b.dataset.skip))));

const SPEEDS = [1, 1.5, 2, 0.5];
$('speedBtn').addEventListener('click', () => {
  const next = SPEEDS[(SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length];
  video.playbackRate = next;
  $('speedBtn').textContent = `${next}x`;
});
const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen?.());
$('fullBtn').addEventListener('click', toggleFull);
document.addEventListener('fullscreenchange', () => {
  setIcon($('fullBtn'), document.fullscreenElement ? 'corners-in' : 'corners-out');
  $('fullBtn').dataset.tip = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
});

// Progress bar: click or drag to seek, hover for the time (and what happened there).
const track = $('track');
const pctAt = (e) => {
  const r = track.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
};
track.addEventListener('pointerdown', (e) => {
  if (fallbackActive) return;
  track.setPointerCapture(e.pointerId);
  track.classList.add('drag');
  const move = (ev) => (video.currentTime = pctAt(ev) * timelineDuration());
  move(e);
  const up = () => {
    track.classList.remove('drag');
    track.removeEventListener('pointermove', move);
  };
  track.addEventListener('pointermove', move);
  track.addEventListener('pointerup', up, { once: true });
  track.addEventListener('pointercancel', up, { once: true });
});
track.addEventListener('pointermove', (e) => {
  const total = timelineDuration();
  if (!total) return;
  const p = pctAt(e);
  const tipEl = $('hoverTime');
  // Show the label of a marker under the pointer, otherwise just the time.
  const near = [...$('markers').children].find((m) => Math.abs(parseFloat(m.style.left) / 100 - p) * track.clientWidth < 6);
  tipEl.textContent = near ? near._label : fmt(p * total);
  tipEl.hidden = false;
  const w = tipEl.offsetWidth / 2;
  tipEl.style.left = `${Math.max(w, Math.min(track.clientWidth - w, p * track.clientWidth))}px`;
});
track.addEventListener('pointerleave', () => ($('hoverTime').hidden = true));
track.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') seek(video.currentTime - 5);
  else if (e.key === 'ArrowRight') seek(video.currentTime + 5);
  else return;
  e.preventDefault();
  e.stopPropagation();
});

// ---------------------------------------------------------------- side panel

document.querySelectorAll('[data-level]').forEach((b) =>
  b.addEventListener('click', () => {
    level = b.dataset.level;
    document.querySelectorAll('[data-level]').forEach((x) => x.classList.toggle('on', x === b));
    applyFilter();
  }),
);

document.querySelectorAll('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    history.replaceState(null, '', activeTab === 'steps' ? location.pathname + location.search : `${location.search}#${activeTab}`);
    document.querySelectorAll('[data-tab]').forEach((x) => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-selected', String(x === b));
    });
    for (const name of ['info', 'steps', 'console', 'network', 'report']) $(`pane-${name}`).hidden = name !== activeTab;
    $('toolbar').hidden = activeTab === 'info' || activeTab === 'report';
    $('levels').hidden = activeTab !== 'console';
    applyFilter();
    sync();
  }),
);

function applyFilter() {
  const list = $(`list-${activeTab}`);
  if (!list) return;
  const q = $('search').value.trim().toLowerCase();
  for (const li of list.children) {
    if (!li._ev) continue;
    const ev = li._ev;
    let show = !q || li.textContent.toLowerCase().includes(q);
    if (activeTab === 'console' && level === 'error') show &&= ev.level === 'error';
    if (activeTab === 'console' && level === 'warn') show &&= ev.level === 'error' || ev.level === 'warn';
    li.hidden = !show;
  }
}
$('search').addEventListener('input', applyFilter);

// DevTools panel: drag its left edge (or use arrow keys on it) to resize; the width is remembered.
(() => {
  const layout = $('layout');
  const handle = $('resizer');
  const clamp = (w) => Math.round(Math.max(320, Math.min(w, Math.min(900, window.innerWidth * 0.7))));
  const apply = (w) => layout.style.setProperty('--side-w', `${clamp(w)}px`);
  const save = () => {
    try {
      localStorage.setItem('bugsnap.sideWidth', String($('side').getBoundingClientRect().width));
    } catch {
      /* storage unavailable: width just isn't remembered */
    }
  };
  try {
    const w = Number(localStorage.getItem('bugsnap.sideWidth'));
    if (w) apply(w);
  } catch {
    /* ignore */
  }
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => apply(window.innerWidth - ev.clientX);
    const up = () => {
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => {
    layout.style.removeProperty('--side-w');
    save();
  });
  handle.addEventListener('keydown', (e) => {
    const w = $('side').getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') apply(w + 24);
    else if (e.key === 'ArrowRight') apply(w - 24);
    else return;
    e.preventDefault();
    save();
  });
})();

$('togglePanel').addEventListener('click', () => {
  const layout = $('layout');
  const off = !layout.classList.contains('no-side');
  clearTimeout(layout._hideTimer);
  if (off) {
    layout.classList.add('no-side');
    // After the slide, take it out of keyboard focus order too.
    layout._hideTimer = setTimeout(() => layout.classList.add('side-gone'), 330);
  } else {
    layout.classList.remove('side-gone');
    requestAnimationFrame(() => layout.classList.remove('no-side'));
  }
  $('togglePanel').classList.toggle('off', off);
  $('togglePanel').dataset.tip = off ? 'Show DevTools' : 'Hide DevTools';
});

// ---------------------------------------------------------------- sharing

function flash(btn, iconName, text) {
  const label = btn.querySelector('span:last-child');
  const slot = btn.querySelector('[data-icon]');
  if (!label || !slot) {
    const old = btn.textContent;
    btn.textContent = text;
    return setTimeout(() => (btn.textContent = old), 1400);
  }
  const old = { icon: slot.dataset.icon, text: label.textContent };
  setIcon(slot, iconName);
  label.textContent = text;
  setTimeout(() => {
    setIcon(slot, old.icon);
    label.textContent = old.text;
  }, 1400);
}

async function copyShareLink(btn, url = shareLink()) {
  await navigator.clipboard.writeText(url);
  flash(btn, 'check', isPublicLink() ? 'Copied' : 'Copied (only you)');
}

$('copyLink').addEventListener('click', () => copyShareLink($('copyLink')));

const menu = $('shareMenu');
function closeMenu() {
  if (menu.hidden || menu.classList.contains('closing')) return;
  menu.classList.add('closing');
  setTimeout(() => {
    menu.hidden = true;
    menu.classList.remove('closing');
  }, 120);
}
$('shareMore').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!menu.hidden) return closeMenu();
  menu.hidden = false;
  menu.querySelector('button, a:not([hidden])')?.focus();
});
document.addEventListener('click', (e) => !menu.contains(e.target) && closeMenu());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
$('copyAtTime').addEventListener('click', async () => {
  closeMenu();
  await copyShareLink($('copyLink'), withTime(shareLink(), video.currentTime));
});
$('copyReportMenu').addEventListener('click', async () => {
  closeMenu();
  await navigator.clipboard.writeText($('report').value);
  flash($('copyLink'), 'check', 'Report copied');
});
$('copyReport').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('report').value);
  flash($('copyReport'), 'check', 'Copied');
});

// ---------------------------------------------------------------- review (local server only)

function reviewStatus() {
  if (!rec.driveConnected && !rec.shareUrl) return 'Only you can open this link. Connect Google Drive in Settings to share.';
  if (rec.drive?.status === 'done') return 'Anyone with the link can watch.';
  if (rec.drive?.status === 'error') return `Upload failed: ${rec.drive.error}. Retry from the player.`;
  if (rec.shareUrl) return 'Link is ready to share. The video opens for others as soon as the upload finishes.';
  return 'Getting your share link…';
}

function openReview() {
  if (driveMode || !rec) return;
  const meta = rec.meta || {};
  $('rTitle').value = meta.title || '';
  $('rDesc').value = meta.description || '';
  $('rLink').value = shareLink();
  $('rStatus').textContent = reviewStatus();
  const rv = $('reviewVideo');
  if (rec.status === 'ready' && !rv.src) {
    rv.src = video.currentSrc || video.src;
    rv.poster = video.poster;
  }
  $('review').hidden = false;
  setTimeout(() => $('rTitle').focus(), 30);
  // Keep the link and status fresh while the modal is open (the link is reserved in the background).
  clearInterval(openReview.timer);
  openReview.timer = setInterval(async () => {
    if ($('review').hidden) return clearInterval(openReview.timer);
    const r = await fetchRecording().catch(() => null);
    if (!r) return;
    rec = { ...rec, drive: r.drive, shareUrl: r.shareUrl, driveConnected: r.driveConnected, status: r.status };
    $('rLink').value = shareLink();
    $('rStatus').textContent = reviewStatus();
    if (r.status === 'ready' && !rv.src) rv.src = `/api/recordings/${encodeURIComponent(id)}/video`;
  }, 2000);
}

function closeReview() {
  const back = $('review');
  if (back.hidden || back.classList.contains('closing')) return;
  back.classList.add('closing');
  setTimeout(() => {
    back.hidden = true;
    back.classList.remove('closing');
  }, 180);
  $('reviewVideo').pause();
  clearInterval(openReview.timer);
  if (params.has('review')) {
    params.delete('review');
    history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : '') + location.hash);
  }
}

if (!driveMode) {
  $('editBtn').addEventListener('click', openReview);
  $('editDetails').addEventListener('click', () => {
    closeMenu();
    openReview();
  });
  $('reviewClose').addEventListener('click', closeReview);
  $('review').addEventListener('click', (e) => e.target === $('review') && closeReview());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('review').hidden && closeReview());
  $('rCopy').addEventListener('click', () => copyShareLink($('rCopy'), $('rLink').value));
  $('reviewForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('rSave').disabled = true;
    const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: $('rTitle').value, description: $('rDesc').value }),
    }).catch(() => null);
    $('rSave').disabled = false;
    if (!res || !res.ok) return ($('rStatus').textContent = 'Could not save. Is the server running?');
    const saved = await res.json();
    rec.meta = { ...rec.meta, title: saved.title, description: saved.description };
    renderDetails();
    $('report').value = buildReport();
    closeReview();
  });
  let armed = false;
  $('rDelete').addEventListener('click', async () => {
    const b = $('rDelete');
    if (!armed) {
      armed = true;
      b.classList.add('armed');
      b.querySelector('span:last-child').textContent = 'Click to delete';
      setTimeout(() => {
        armed = false;
        b.classList.remove('armed');
        b.querySelector('span:last-child').textContent = 'Delete';
      }, 3000);
      return;
    }
    b.disabled = true;
    const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    if (res && res.ok) location.href = '/';
    else {
      b.disabled = false;
      $('rStatus').textContent = 'Could not delete. Is the server running?';
    }
  });
}

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  if (!$('review').hidden) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ' || e.key === 'k') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowLeft' || e.key === 'j') seek(video.currentTime - 5);
  else if (e.key === 'ArrowRight' || e.key === 'l') seek(video.currentTime + 5);
  else if (e.key === 'f') toggleFull();
  else if (e.key === 'm') video.muted = !video.muted;
});

load();
