// Recording viewer: plays the video and keeps steps, console and network logs
// in sync with playback. All page-derived text is rendered with textContent.
//
// Two sources:
//  - local server: /r/<id>, data from /api/recordings/<id>
//  - public player (GitHub Pages, built by scripts/build-viewer.js): ?id=<Drive manifest id>,
//    data and video streamed straight from Google Drive with a browser API key.

const $ = (id) => document.getElementById(id);
const CONFIG = globalThis.SCREENREC_CONFIG || {};
const params = new URLSearchParams(location.search);
const driveMode = Boolean(CONFIG.driveApiKey);
const id = driveMode ? params.get('id') || '' : location.pathname.split('/').filter(Boolean).pop();
const driveMedia = (fileId) =>
  `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(CONFIG.driveApiKey)}`;
const pageUrl = () => `${location.origin}${location.pathname}${location.search}`;
const video = $('video');
const ICONS = globalThis.ScreenRecIcons || {};

let rec;
let durationSec = 0;
const lists = { steps: [], console: [], network: [] };
let activeTab = 'steps';
let level = 'all';

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

const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

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

// ---------------------------------------------------------------- load

async function fetchRecording() {
  if (driveMode) {
    if (!id) return null;
    const res = await fetch(driveMedia(id));
    if (!res.ok) return null;
    const m = await res.json();
    if (!['bugsnap', 'screenrec'].includes(m?.app) || !m.video?.id) return null;
    return { ...m.record, events: m.events || [], video: m.video, poster: m.poster, shareUrl: pageUrl() };
  }
  const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`);
  return res.ok ? res.json() : null;
}

/** The link to hand out: the public player once on Drive, otherwise this page. */
const shareLink = () => (driveMode ? pageUrl() : rec?.shareUrl || rec?.viewerUrl || location.href);

async function load() {
  paintIcons();
  rec = await fetchRecording().catch(() => null);
  if (driveMode) {
    document.querySelectorAll('[data-local-only]').forEach((el) => el.remove());
    document.querySelector('.topbar .mark')?.removeAttribute('href');
  }
  if (!rec) {
    document.querySelector('.topbar').hidden = true;
    $('layout').hidden = true;
    $('notfound').hidden = false;
    document.title = 'Recording not found · BugSnap';
    return;
  }
  render();
  if (needsPoll()) poll();
  // Deep link to a tab, e.g. /r/<id>#network
  const tab = location.hash.slice(1);
  document.querySelector(`[data-tab="${CSS.escape(tab)}"]`)?.click();
}

const uploading = (r) => ['pending', 'uploading'].includes(r?.drive?.status);
const needsPoll = () => !driveMode && (rec.status !== 'ready' || uploading(rec));

let pollTimer = null;
function poll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const r = await fetchRecording().catch(() => null);
    if (!r) return;
    const becameReady = rec.status !== 'ready' && r.status === 'ready';
    if (becameReady) {
      const t = video.currentTime;
      const playing = !video.paused;
      rec = r;
      render();
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = t;
        if (playing) video.play().catch(() => {});
      }, { once: true });
    } else {
      rec = { ...rec, drive: r.drive, shareUrl: r.shareUrl, driveConnected: r.driveConnected };
      renderBanner();
    }
    if (!needsPoll()) clearInterval(pollTimer);
  }, 2500);
}

/** Status line under the top bar: processing, Drive upload progress, or how to share. */
function renderBanner() {
  const banner = $('banner');
  const action = $('bannerAction');
  const set = (text, { spin = false, button = null, tone = '' } = {}) => {
    banner.hidden = false;
    banner.className = `banner ${tone}`;
    $('bannerIcon').dataset.icon = spin ? 'spinner-gap' : tone === 'bad' ? 'warning-circle' : 'info';
    $('bannerIcon').classList.toggle('spin', spin);
    paintIcons(banner);
    $('bannerText').textContent = text;
    action.hidden = !button;
    if (button) {
      action.textContent = button.label;
      action.onclick = button.onClick;
    }
  };
  if (driveMode) return (banner.hidden = true);
  if (rec.status === 'recording') return set('Still recording. This page updates when it is saved.', { spin: true });
  if (rec.status !== 'ready') return set('Preparing video…', { spin: true });
  const d = rec.drive;
  if (d?.status === 'done') return (banner.hidden = true);
  if (uploading(rec)) return set('Uploading to Google Drive…', { spin: true });
  const upload = async () => {
    action.disabled = true;
    const res = await fetch(`/api/recordings/${encodeURIComponent(id)}/drive`, { method: 'POST' }).catch(() => null);
    action.disabled = false;
    if (!res || !res.ok) {
      const b = await res?.json().catch(() => ({}));
      return set(b?.error || 'Could not start the upload.', { tone: 'bad', button: { label: 'Retry', onClick: upload } });
    }
    rec = { ...rec, drive: { status: 'pending' } };
    renderBanner();
    poll();
  };
  if (d?.status === 'error') return set(`Drive upload failed: ${d.error}`, { tone: 'bad', button: { label: 'Retry', onClick: upload } });
  if (rec.driveConnected) return set('Not on Google Drive yet.', { button: { label: 'Upload', onClick: upload } });
  set('Only you can open this link. Connect Google Drive to share it.', {
    button: { label: 'Connect', onClick: () => (location.href = '/settings') },
  });
}

// ---------------------------------------------------------------- render

function render() {
  durationSec = (rec.durationMs || 0) / 1000;
  const meta = rec.meta || {};
  const env = meta.env || {};
  const title = meta.title || shortUrl(meta.startUrl) || 'Untitled';
  document.title = `${title} · BugSnap`;
  $('title').textContent = title;
  const when = new Date(rec.startedAt || Date.parse(rec.createdAt));
  $('subtitle').textContent = [
    when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    durationSec ? fmt(durationSec) : null,
    meta.reporter ? `by ${meta.reporter}` : null,
    [env.os, env.browser].filter(Boolean).join(', ') || null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  if (driveMode) {
    video.src = driveMedia(rec.video.id);
    if (rec.poster?.id) video.poster = driveMedia(rec.poster.id);
    $('download').href = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(rec.video.id)}`;
    $('download').removeAttribute('download');
    $('download').target = '_blank';
  } else {
    const src = `/api/recordings/${encodeURIComponent(id)}/video`;
    // The version query makes the browser fetch the processed file once it replaces the raw one.
    video.src = `${src}?v=${encodeURIComponent(rec.updatedAt || '')}`;
    if (rec.hasPoster) video.poster = `/api/recordings/${encodeURIComponent(id)}/poster`;
    $('download').href = src;
    $('download').setAttribute('download', `recording-${id}.webm`);
  }
  renderBanner();

  // Events originate in arbitrary web pages: coerce every displayed field to a string.
  const str = (v) => (v === undefined || v === null ? undefined : String(v));
  const events = (rec.events || [])
    .filter((e) => e && typeof e.ts === 'number')
    .map((e) => ({ ...e, text: str(e.text), message: str(e.message) ?? '', url: str(e.url), method: str(e.method), selector: str(e.selector), stack: str(e.stack), source: str(e.source), responseBody: str(e.responseBody), level: str(e.level), status: Number(e.status) || 0 }));
  lists.steps = events.filter((e) => e.type === 'action' || e.type === 'navigation');
  const byTime = (a, b) => offsetOf(a) - offsetOf(b);
  lists.steps.sort(byTime);
  lists.console = events.filter((e) => e.type === 'console').sort(byTime);
  lists.network = events.filter((e) => e.type === 'network').sort(byTime);

  setCount('steps', lists.steps.length);
  setCount('console', lists.console.length, lists.console.filter((e) => e.level === 'error').length, 'error');
  setCount('network', lists.network.length, lists.network.filter(isNetError).length, 'failed');

  renderSteps();
  renderConsole();
  renderNetwork();
  renderInfo();
  renderTimeline();
  $('report').value = buildReport();
  sync();
}

function setCount(name, n, bad = 0, noun = '') {
  $(`c-${name}`).textContent = String(n);
  const badge = $(`e-${name}`);
  if (!badge) return;
  badge.hidden = !bad;
  badge.textContent = String(bad);
  badge.title = `${bad} ${noun}${noun === 'error' && bad !== 1 ? 's' : ''}`;
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
  $('list-steps').replaceChildren(...(items.length ? items : [empty('cursor-click', 'No steps captured')]));
}

function renderConsole() {
  const items = lists.console.map((ev) =>
    row(ev, {
      cls: ev.level === 'error' ? 'bad' : ev.level === 'warn' ? 'warn' : '',
      glyph: ev.level === 'error' ? 'warning-circle' : ev.level === 'warn' ? 'warning-circle' : 'terminal-window',
      body: [
        h('div', { class: 'code' }, ev.message || ''),
        ev.source ? h('div', { class: 'sub code' }, ev.source) : null,
        ev.stack ? h('details', { onclick: (e) => e.stopPropagation() }, h('summary', {}, 'Stack trace'), h('div', { class: 'details' }, ev.stack)) : null,
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
      { class: 'details', hidden: true, onclick: (e) => e.stopPropagation() },
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

function renderInfo() {
  const meta = rec.meta || {};
  const env = meta.env || {};
  const size = (o) => (o && o.width ? `${o.width} × ${o.height}` : undefined);
  const loc = env.location;
  const tz = env.timeZone ? `${env.timeZone} (UTC${env.utcOffsetMinutes >= 0 ? '+' : '-'}${fmtOffset(env.utcOffsetMinutes)})` : undefined;
  const visited = [...new Set(lists.steps.filter((e) => e.type === 'navigation' && e.url).map((e) => e.url))];
  const link = (href, text) => (isHttp(href) ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text || href) : text || href);

  const groups = [
    ['Session', [
      ['Recorded', new Date(rec.startedAt || rec.createdAt).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' })],
      ['Duration', durationSec ? fmt(durationSec) : undefined],
      ['Paused', rec.pauses?.length ? `${rec.pauses.length} time${rec.pauses.length === 1 ? '' : 's'}` : undefined],
      ['Reporter', meta.reporter],
      ['Type', meta.mode === 'desktop' ? `Screen recording (${{ monitor: 'entire screen', window: 'window', browser: 'browser tab' }[env.displaySurface] || 'screen'})` : 'Tab recording'],
      ['Start page', meta.startUrl ? link(meta.startUrl) : undefined],
      ['Pages visited', visited.length ? h('div', { class: 'urls' }, ...visited.map((u) => h('div', {}, link(u)))) : undefined],
    ]],
    ['Device', [
      ['Operating system', [env.os || meta.platform?.os, env.architecture].filter(Boolean).join(', ') || undefined],
      ['Screen', size(env.screen)],
      ['Pixel ratio', meta.devicePixelRatio || env.devicePixelRatio],
      ['CPU cores', env.hardwareConcurrency],
      ['Memory', env.deviceMemoryGb ? `${env.deviceMemoryGb} GB or more` : undefined],
      ['Location', loc && loc.latitude !== undefined
        ? link(`https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}#map=14/${loc.latitude}/${loc.longitude}`, `${loc.latitude}, ${loc.longitude} (within ${loc.accuracyM} m)`)
        : loc?.error ? `Not available (${loc.error})` : undefined],
      ['Time zone', tz],
      ['Language', env.language],
    ]],
    ['Browser', [
      ['Browser', env.browser],
      ['Window', size(meta.window) ? `${size(meta.window)}${meta.window.state && meta.window.state !== 'normal' ? ` (${meta.window.state})` : ''}` : undefined],
      ['Viewport', size(meta.viewport)],
      ['Captured video', size(env.captureSize)],
      ['Connection', env.connection?.effectiveType],
      ['User agent', env.userAgent],
      ['Extension', meta.extensionVersion],
    ]],
  ];

  $('info').replaceChildren(
    ...groups.flatMap(([name, rows]) => {
      const present = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
      if (!present.length) return [];
      return [h('h3', {}, name), h('dl', {}, ...present.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))];
    }),
  );
}

function fmtOffset(min) {
  const a = Math.abs(min || 0);
  return `${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

function renderTimeline() {
  const total = timelineDuration();
  if (!total) return $('markers').replaceChildren();
  const marks = [
    ...lists.steps.map((e) => ({ e, cls: e.type })),
    ...lists.console.filter((e) => e.level === 'error').map((e) => ({ e, cls: 'error' })),
    ...lists.network.filter(isNetError).map((e) => ({ e, cls: 'error' })),
  ];
  $('markers').replaceChildren(
    ...marks.map(({ e, cls }) => {
      const off = offsetOf(e);
      const label = e.text || e.message || `${e.method} ${pathOf(e.url)} returned ${e.status || 'an error'}`;
      return h('div', { class: `marker ${cls}`, style: `left:${Math.min(100, (off / total) * 100)}%`, title: `${fmt(off)}  ${label}` });
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
  const page = meta.title || shortUrl(meta.startUrl) || 'the page';

  let title = `Problem on ${page}`;
  if (errors[0]) title = `${errors[0].message.split('\n')[0].slice(0, 90)} on ${page}`;
  else if (failed[0]) title = `${failed[0].method} ${pathOf(failed[0].url).split('?')[0]} returns ${failed[0].status || 'a network error'}`;

  const evidence = [
    ...errors.slice(0, 5).map((e) => `- [${fmt(offsetOf(e))}] Console error: \`${e.message.split('\n')[0].slice(0, 200)}\``),
    ...failed.slice(0, 5).map((e) => `- [${fmt(offsetOf(e))}] \`${e.method} ${shortUrl(e.url)}\` returned ${e.status || 'a network error'}${e.error ? ` (${e.error})` : ''}`),
  ];
  const size = (o) => (o && o.width ? `${o.width}x${o.height}` : 'unknown');

  return [
    `## ${title}`,
    '',
    '### Description',
    '_Describe the problem in one or two sentences._',
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

// ---------------------------------------------------------------- playback sync

function seek(sec) {
  video.currentTime = Math.max(0, Math.min(sec, timelineDuration() || sec));
  if (video.paused) video.play().catch(() => {});
}

const lastCurrent = {};
function sync() {
  const t = video.currentTime || 0;
  const total = timelineDuration();
  const pct = total ? Math.min(100, (t / total) * 100) : 0;
  $('clock').textContent = `${fmt(t)} / ${fmt(total)}`;
  $('playhead').style.left = `${pct}%`;
  $('progress').style.width = `${pct}%`;
  $('timeline').setAttribute('aria-valuenow', String(Math.round(t)));
  $('timeline').setAttribute('aria-valuemax', String(Math.round(total)));

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

video.addEventListener('timeupdate', sync);
video.addEventListener('seeked', sync);
video.addEventListener('loadedmetadata', () => {
  // An unprocessed WebM reports Infinity; seeking far forces Chrome to compute the duration.
  if (!Number.isFinite(video.duration)) {
    const restore = () => {
      video.removeEventListener('durationchange', restore);
      video.currentTime = 0;
      renderTimeline();
      sync();
    };
    video.addEventListener('durationchange', restore);
    video.currentTime = 1e7;
  } else {
    renderTimeline();
  }
  sync();
});

// ---------------------------------------------------------------- UI wiring

$('timeline').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  seek(((e.clientX - r.left) / r.width) * timelineDuration());
});
$('timeline').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') seek(video.currentTime - 5);
  else if (e.key === 'ArrowRight') seek(video.currentTime + 5);
  else return;
  e.preventDefault();
  e.stopPropagation();
});

document.querySelectorAll('[data-skip]').forEach((b) => b.addEventListener('click', () => seek(video.currentTime + Number(b.dataset.skip))));

document.querySelectorAll('[data-rate]').forEach((b) =>
  b.addEventListener('click', () => {
    video.playbackRate = Number(b.dataset.rate);
    document.querySelectorAll('[data-rate]').forEach((x) => x.classList.toggle('on', x === b));
  }),
);

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
    history.replaceState(null, '', activeTab === 'steps' ? location.pathname + location.search : `#${activeTab}`);
    document.querySelectorAll('[data-tab]').forEach((x) => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-selected', String(x === b));
    });
    for (const name of ['steps', 'console', 'network', 'info', 'report']) $(`pane-${name}`).hidden = name !== activeTab;
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

function flash(btn, iconName, text) {
  const ic = btn.querySelector('[data-icon]');
  const label = btn.querySelector('span:last-child');
  const old = { icon: ic.dataset.icon, text: label.textContent };
  ic.dataset.icon = iconName;
  label.textContent = text;
  paintIcons(btn);
  setTimeout(() => {
    ic.dataset.icon = old.icon;
    label.textContent = old.text;
    paintIcons(btn);
  }, 1400);
}

$('copyLink').addEventListener('click', async () => {
  const link = shareLink();
  await navigator.clipboard.writeText(link);
  const isPublic = driveMode || Boolean(rec?.shareUrl);
  flash($('copyLink'), 'check', isPublic ? 'Copied' : 'Copied (only you)');
});

$('copyReport').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('report').value);
  flash($('copyReport'), 'check', 'Copied');
});

$('popout').addEventListener('click', () => {
  const w = Math.min(1440, screen.availWidth - 40);
  const hgt = Math.min(900, screen.availHeight - 40);
  window.open(location.href, `rec-${id}`, `popup=yes,width=${w},height=${hgt}`);
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
  if (e.key === ' ' || e.key === 'k') {
    e.preventDefault();
    video.paused ? video.play() : video.pause();
  } else if (e.key === 'ArrowLeft' || e.key === 'j') seek(video.currentTime - 5);
  else if (e.key === 'ArrowRight' || e.key === 'l') seek(video.currentTime + 5);
});

load();
