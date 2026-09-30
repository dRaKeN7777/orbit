/**
 * app.js (router + bootstrap)
 *
 * Responsibilities: hash routing for the six views, the shared header (health dot +
 * pipeline counters), the SSE subscription with backoff and the /api/stats polling
 * fallback, and wiring the activity console.
 *
 * Views are pure ES modules exporting `mount(root, ctx)`; `ctx` carries
 * `navigate`, `params`, the route metadata and `onDestroy(fn)`.
 */
import { endpoints, streamUrl } from './api.js';
import {
  html,
  setHtml,
  toast,
  toastOk,
  toastErr,
  fmtNum,
  disposers,
  errorState,
  delegate,
} from './ui.js';
import { activity } from './activity.js';
import { EVENTS, emit } from './bus.js';
import { renderLogin } from './login.js';

import * as radarView from './views/radar.js';
import * as topicsView from './views/topics.js';
import * as studioView from './views/studio.js';
import * as schedulerView from './views/scheduler.js';
import * as websiteView from './views/website.js';
import * as runsView from './views/runs.js';

const ROUTES = {
  radar: { title: 'Executive Radar', module: radarView },
  topics: { title: 'Topic & Pain-Point Matrix', module: topicsView },
  studio: { title: 'Content & Comment Studio', module: studioView },
  scheduler: { title: 'Scheduler & Inbound Tracker', module: schedulerView },
  website: { title: 'Website Updates', module: websiteView },
  runs: { title: 'Runs, Automation & Settings', module: runsView },
};

const DEFAULT_VIEW = 'radar';

let routeToken = 0;
let disposeRoute = () => {};
let lastHealthOk = null;
let healthTimer = null;

/* ------------------------------------------------------------- routing */

export function parseHash() {
  const raw = String(location.hash || '').replace(/^#/, '');
  const split = raw.split('?');
  const name = split[0];
  const view = Object.prototype.hasOwnProperty.call(ROUTES, name) ? name : DEFAULT_VIEW;
  const params = {};
  if (split[1]) {
    const search = new URLSearchParams(split[1]);
    search.forEach((value, key) => { params[key] = value; });
  }
  return { view, params };
}

export function navigate(hash) {
  const next = String(hash || '').replace(/^#/, '');
  if (location.hash.replace(/^#/, '') === next) {
    renderRoute();
    return;
  }
  location.hash = next;
}

async function renderRoute() {
  const { view, params } = parseHash();
  const route = ROUTES[view];
  const viewEl = document.getElementById('view');
  const token = ++routeToken;

  disposeRoute();
  disposeRoute = () => {};

  const title = document.getElementById('view-title');
  if (title) title.textContent = route.title;
  document.title = 'Orbit — ' + route.title;

  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.getAttribute('data-view') === view);
    if (item.getAttribute('data-view') === view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }

  if (!viewEl) return;
  viewEl.className = 'view';
  viewEl.innerHTML = '';
  viewEl.scrollTop = 0;

  const bag = disposers();
  const ctx = {
    view,
    params,
    route,
    navigate,
    refreshHeader,
    onDestroy: (fn) => bag.add(fn),
  };
  disposeRoute = () => bag.dispose();

  emit(EVENTS.NAVIGATE, { view, params });

  try {
    await route.module.mount(viewEl, ctx);
  } catch (err) {
    if (token !== routeToken) return;
    setHtml(viewEl, errorState(err, 'retry-view', 'This view failed to render'));
    toastErr(err && err.message ? err.message : 'View failed to render');
  }
}

/* ------------------------------------------------------------- header */

function counterChip(label, value, cls, title) {
  const shown = value === null || value === undefined ? '—' : fmtNum(value);
  return html`<span class="counter ${cls || ''}" title="${title || label}"><b>${shown}</b><span>${label}</span></span>`;
}

function renderCounters(stats) {
  const container = document.getElementById('counters');
  if (!container || !stats || typeof stats !== 'object') return;
  const pipeline = stats.pipeline && typeof stats.pipeline === 'object' ? stats.pipeline : null;
  const pipelineChips = pipeline
    ? Object.keys(pipeline).map((key) => counterChip(key, pipeline[key], 'pipe', 'Pipeline stage: ' + key))
    : [];
  setHtml(
    container,
    html`${counterChip('targets', stats.targets)}
      ${counterChip('posts', stats.posts)}
      ${counterChip('topics', stats.topics)}
      ${counterChip('drafts', stats.drafts)}
      ${counterChip('scheduled', stats.scheduled)}
      ${counterChip('published', stats.published)}
      ${counterChip('engagements', stats.engagements)}
      ${pipelineChips}`
  );
}

function setStatus(kind, text, title) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  if (dot) dot.className = 'dot ' + (kind === 'ok' ? 'dot-ok' : kind === 'bad' ? 'dot-bad' : 'dot-idle');
  if (label) label.textContent = text;
  const wrap = document.getElementById('status');
  if (wrap && title) wrap.setAttribute('title', title);
}

export async function refreshHeader(options) {
  const o = options || {};
  const [healthResult, statsResult] = await Promise.allSettled([endpoints.health(), endpoints.stats()]);

  if (healthResult.status === 'fulfilled' && healthResult.value) {
    const health = healthResult.value;
    const ok = health.ok === true;
    const parts = [];
    if (health.llm) parts.push(health.llm);
    if (health.publisher) parts.push(health.publisher);
    setStatus(ok ? 'ok' : 'bad', ok ? 'ok · ' + (parts.join(' / ') || 'healthy') : 'degraded', 
      'version ' + (health.version || '—') + ' · uptime ' + (health.uptime_s === undefined ? '—' : health.uptime_s + 's'));
    const versionEl = document.getElementById('health-version');
    if (versionEl) versionEl.textContent = 'v' + (health.version || '—');
    if (lastHealthOk === false && ok) toastOk('API back online');
    lastHealthOk = ok;
    emit(EVENTS.HEALTH, health);
  } else {
    const err = healthResult.status === 'rejected' ? healthResult.reason : null;
    setStatus('bad', 'offline', err && err.message ? err.message : 'API unreachable');
    if (lastHealthOk !== false && !o.quiet) toastErr(err && err.message ? err.message : 'Orbit API is unreachable');
    lastHealthOk = false;
  }

  if (statsResult.status === 'fulfilled' && statsResult.value) {
    renderCounters(statsResult.value);
    emit(EVENTS.STATS, statsResult.value);
  }
}

/* ------------------------------------------------------------- SSE */

let source = null;
let failures = 0;
let reconnectTimer = null;
let pollTimer = null;

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollStats() {
  try {
    const stats = await endpoints.stats();
    renderCounters(stats);
    emit(EVENTS.STATS, stats);
  } catch (err) {
    // Background polling stays quiet (no toast spam) but is visible in the console.
    activity.warn('/api/stats poll failed: ' + (err && err.message ? err.message : 'unknown error'));
  }
}

/* `stats` stream events are sometimes full snapshots and sometimes delta hints
   (e.g. { draft_created: 88 }). Only a snapshot may overwrite the header counters;
   a hint triggers a coalesced refetch of GET /api/stats. */
const STAT_KEYS = ['targets', 'posts', 'topics', 'drafts', 'scheduled', 'published', 'engagements'];

function looksLikeFullStats(value) {
  if (!value || typeof value !== 'object') return false;
  let hits = 0;
  for (const key of STAT_KEYS) {
    if (typeof value[key] === 'number') hits += 1;
  }
  return hits >= 2;
}

let statsRefreshTimer = null;

function scheduleStatsRefresh() {
  if (statsRefreshTimer) return;
  statsRefreshTimer = setTimeout(() => {
    statsRefreshTimer = null;
    pollStats();
  }, 400);
}

function startPolling() {
  activity.setMode('polling');
  activity.warn('stream unavailable after 3 attempts — polling /api/stats every 15s');
  if (pollTimer) return;
  pollStats();
  pollTimer = setInterval(pollStats, 15000);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(15000, 1000 * Math.pow(2, Math.max(0, failures - 1)));
  activity.setMode('reconnecting');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectStream();
  }, delay);
}

function connectStream() {
  closeStream();
  let next;
  try {
    next = new EventSource(streamUrl());
  } catch (err) {
    failures += 1;
    scheduleReconnect();
    return;
  }
  source = next;
  next.onopen = () => {
    failures = 0;
    stopPolling();
    activity.setMode('live');
    activity.log('stream connected');
  };
  next.onmessage = (event) => handleStreamMessage(event && event.data);
  next.onerror = () => {
    if (next !== source) return;
    try { next.close(); } catch (e) { /* already closed */ }
    source = null;
    failures += 1;
    activity.warn('stream error (attempt ' + failures + ')');
    if (failures >= 3) {
      startPolling();
      return;
    }
    scheduleReconnect();
  };
}

function closeStream() {
  if (source) {
    try { source.close(); } catch (e) { /* already closed */ }
    source = null;
  }
}

function handleStreamMessage(data) {
  if (!data) return;
  let parsed = null;
  try { parsed = JSON.parse(data); } catch (err) { return; }
  const type = parsed && parsed.type ? String(parsed.type) : '';
  const payload = parsed ? parsed.payload : null;

  if (type === 'run.log') {
    const p = payload && typeof payload === 'object' ? payload : {};
    const message = p.msg || p.message || (typeof payload === 'string' ? payload : '');
    activity.append(p.level || 'info', message, p.at || Date.now());
    emit(EVENTS.RUN_LOG, p);
    return;
  }

  if (type === 'run.status') {
    const p = payload && typeof payload === 'object' ? payload : {};
    const status = String(p.status || p.state || 'updated');
    const id = p.id || p.run_id || 'run';
    const level = status === 'failed' ? 'error' : status === 'succeeded' ? 'info' : 'info';
    activity.append(level, 'run ' + id + ' → ' + status, p.at || Date.now());
    if (status === 'failed') toastErr('Run ' + id + ' failed');
    else if (status === 'succeeded') toastOk('Run ' + id + ' succeeded');
    else toast('Run ' + id + ' → ' + status, 'info');
    emit(EVENTS.RUN_STATUS, p);
    refreshHeader({ quiet: true });
    return;
  }

  if (type === 'stats') {
    const stats = payload && payload.stats ? payload.stats : payload;
    if (looksLikeFullStats(stats)) {
      renderCounters(stats);
      emit(EVENTS.STATS, stats);
    } else if (stats && typeof stats === 'object') {
      scheduleStatsRefresh();
    }
    return;
  }

  activity.append('debug', 'event: ' + (type || 'unknown'));
}

/* ------------------------------------------------------------- boot */

let booted = false;

/** Reveals who is signed in and wires the sign-out control. */
function applyAuthChrome(session) {
  const footUser = document.getElementById('foot-user');
  const footName = document.getElementById('foot-user-name');
  const footMode = document.getElementById('foot-mode');
  const signout = document.getElementById('signout');

  const signedIn = Boolean(session && session.auth_required && session.user);
  if (footUser) footUser.hidden = !signedIn;
  if (footName && signedIn) footName.textContent = session.user;
  if (footMode) {
    footMode.textContent = signedIn
      ? 'signed in'
      : session && session.auth_required
        ? 'not signed in'
        : 'local only';
  }

  if (signout && !signout.dataset.wired) {
    signout.dataset.wired = '1';
    signout.addEventListener('click', async () => {
      signout.disabled = true;
      try {
        await endpoints.logout();
      } catch (err) {
        // The cookie may already be gone; either way, return to the gate.
      }
      location.reload();
    });
  }
}

export async function start() {
  // Auth gate. Ask the backend whether a session is required *before* building
  // any of the shell, so an unauthenticated visitor never sees the dashboard.
  let session = null;
  try {
    session = await endpoints.session();
  } catch (err) {
    // Backend unreachable. Fall through rather than trapping the operator on a
    // login screen — the normal error surfaces report the real problem.
    session = null;
  }

  if (session && session.auth_required && !session.authenticated) {
    renderLogin({ onAuthenticated: () => start() });
    return;
  }

  if (booted) {
    // Re-entry after signing in: the shell already exists, so just refresh.
    applyAuthChrome(session);
    renderRoute();
    refreshHeader();
    return;
  }
  booted = true;
  applyAuthChrome(session);

  activity.init();
  activity.log('Orbit frontend starting');

  const nav = document.getElementById('nav');
  if (nav) {
    // Re-render when the operator clicks the view they are already on.
    nav.addEventListener('click', (event) => {
      const link = event.target instanceof Element ? event.target.closest('.nav-item') : null;
      if (!link) return;
      const target = link.getAttribute('href') || '';
      if (location.hash === target) {
        event.preventDefault();
        renderRoute();
      }
    });
  }

  // Global fallback for retry buttons emitted by the router's own error state.
  delegate(document.body, 'click', '[data-action="retry-view"]', () => renderRoute());

  window.addEventListener('hashchange', () => renderRoute());

  refreshHeader();
  healthTimer = setInterval(() => refreshHeader({ quiet: true }), 20000);
  window.addEventListener('beforeunload', () => {
    if (healthTimer) clearInterval(healthTimer);
    closeStream();
    stopPolling();
  });

  connectStream();

  // replaceState (rather than assigning location.hash) so the hashchange listener
  // does not schedule a second render of the default view.
  if (!location.hash) history.replaceState(null, '', '#' + DEFAULT_VIEW);
  renderRoute();

  window.orbit = { navigate, refreshHeader, activity, EVENTS };
}
