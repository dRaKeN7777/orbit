/**
 * ui.js — shared rendering helpers.
 *
 * XSS discipline: everything interpolated into an `html` tagged template is escaped
 * unless it is itself a value produced by `html` / `trust`. Server data (post text is
 * scraped from third parties) therefore can never reach the DOM as markup.
 */

/* ------------------------------------------------------------- safe html */

export class Html {
  constructor(value) { this.value = value == null ? '' : String(value); }
}

/** Mark a string as trusted markup. Only ever call this on markup this app built. */
export function trust(value) { return new Html(value); }

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderValue(value) {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escapeHtml(value);
}

/** Tagged template that escapes every interpolation by default. */
export function html(strings) {
  let out = strings[0];
  for (let i = 1; i < arguments.length; i++) {
    out += renderValue(arguments[i]) + strings[i];
  }
  return trust(out);
}

export function setHtml(node, value) {
  if (!node) return;
  node.innerHTML = renderValue(value);
}

/** Plain-text setter for places where markup is not wanted. */
export function setText(node, value) {
  if (!node) return;
  node.textContent = value === null || value === undefined ? '' : String(value);
}

/* Authored locally (not a circular import of icons.js) purely for toasts/empty states. */
const GLYPH = {
  success: '<path d="M4 12.5l5 5L20 6.5"></path>',
  error: '<path d="M12 3l9.5 16.5H2.5L12 3z"></path><path d="M12 9.5v4.2"></path><circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none"></circle>',
  info: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5.5"></path><circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none"></circle>',
  inbox: '<path d="M4 13.5L6.5 5h11L20 13.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"></path><path d="M4 13.5h4l1 2h6l1-2h4"></path>',
  search: '<circle cx="11" cy="11" r="7"></circle><path d="M16.5 16.5L21 21"></path>',
  alert: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5"></path><circle cx="12" cy="16.3" r="0.9" fill="currentColor" stroke="none"></circle>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M3 10h18M8 3v4M16 3v4"></path>',
  file: '<path d="M6 3.5h7.5L19 9v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5z"></path><path d="M13 3.5V9h5.5"></path>',
  list: '<path d="M4 6.5h16M4 12h16M4 17.5h10"></path>',
  code: '<path d="M9 7L4 12l5 5M15 7l5 5-5 5"></path>',
  gear: '<circle cx="12" cy="12" r="3"></circle><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18"></path>',
};

function glyph(name, size) {
  const body = GLYPH[name] || GLYPH.info;
  const s = size || 16;
  return trust('<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>');
}

/* ------------------------------------------------------------- toasts */

const MAX_TOASTS = 5;

export function toast(message, kind) {
  const container = document.getElementById('toasts');
  const text = message === null || message === undefined || message === '' ? 'Something went wrong.' : String(message);
  const type = kind === 'success' || kind === 'error' ? kind : 'info';
  if (!container) return null;

  const node = document.createElement('div');
  node.className = 'toast toast-' + type;
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');
  setHtml(node, html`${glyph(type, 15)}<div class="toast-msg">${text}</div><button type="button" class="toast-close" aria-label="Dismiss">${trust('<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>')}</button>`);

  const remove = () => {
    if (!node.parentNode) return;
    node.parentNode.removeChild(node);
  };
  node.querySelector('.toast-close').addEventListener('click', remove);

  container.appendChild(node);
  while (container.children.length > MAX_TOASTS) container.removeChild(container.firstElementChild);
  setTimeout(remove, 6000);
  return node;
}

export const toastOk = (message) => toast(message, 'success');
export const toastErr = (message) => toast(message, 'error');

/* ------------------------------------------------------------- time & numbers */

export function relativeTime(input) {
  if (!input) return '—';
  const t = typeof input === 'number' ? input : Date.parse(input);
  if (!isFinite(t)) return '—';
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  if (abs < 45000) return 'just now';
  const min = Math.round(abs / 60000);
  const hr = Math.round(abs / 3600000);
  const day = Math.round(abs / 86400000);
  let out;
  if (min < 60) out = min + 'm';
  else if (hr < 24) out = hr + 'h';
  else if (day < 30) out = day + 'd';
  else if (day < 365) out = Math.round(day / 30) + 'mo';
  else out = Math.round(day / 365) + 'y';
  return diff >= 0 ? out + ' ago' : 'in ' + out;
}

export function formatDateTime(input) {
  if (!input) return '—';
  const t = typeof input === 'number' ? input : Date.parse(input);
  if (!isFinite(t)) return String(input);
  const d = new Date(t);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return months[d.getMonth()] + ' ' + d.getDate() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export function formatClock(input) {
  const t = typeof input === 'number' ? input : Date.parse(input);
  if (!isFinite(t)) return '--:--:--';
  const d = new Date(t);
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

export function formatDuration(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1000) return n + 'ms';
  if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
  const min = Math.floor(n / 60000);
  const sec = Math.round((n % 60000) / 1000);
  return min + 'm ' + sec + 's';
}

export function fmtNum(value) {
  const n = Number(value);
  if (!isFinite(n)) return '—';
  return n.toLocaleString('en-GB');
}

export function truncate(value, max) {
  const s = value === null || value === undefined ? '' : String(value);
  const limit = max || 80;
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}

/* ------------------------------------------------------------- badges */

const URGENCY_CLASS = { high: 'badge-high', medium: 'badge-medium', low: 'badge-low' };

export function urgencyBadge(urgency) {
  const v = String(urgency === null || urgency === undefined ? '' : urgency).toLowerCase();
  if (!URGENCY_CLASS[v]) return '';
  return html`<span class="badge ${URGENCY_CLASS[v]}" title="Urgency: ${v}">${v}</span>`;
}

export function regionBadge(region) {
  const v = region === null || region === undefined || region === '' ? '—' : String(region);
  return html`<span class="badge badge-region" title="Region">${v}</span>`;
}

const STATUS_CLASS = {
  pending: 'badge-accent',
  queued: 'badge-accent',
  running: 'badge-accent',
  scheduled: 'badge-accent',
  planned: 'badge-accent',
  drafted: 'badge-muted',
  researched: 'badge-muted',
  published: 'badge-green',
  succeeded: 'badge-green',
  applied: 'badge-green',
  verified: 'badge-green',
  approved: 'badge-green',
  ok: 'badge-green',
  failed: 'badge-red',
  error: 'badge-red',
  rejected: 'badge-red',
  cancelled: 'badge-muted',
  canceled: 'badge-muted',
  skipped: 'badge-muted',
};

export function statusBadge(status) {
  const raw = status === null || status === undefined || status === '' ? 'unknown' : String(status);
  const cls = STATUS_CLASS[raw.toLowerCase()] || 'badge-muted';
  return html`<span class="badge ${cls}">${raw}</span>`;
}

export function typeBadge(type) {
  const raw = type === null || type === undefined || type === '' ? 'signal' : String(type);
  const cls = raw.toLowerCase() === 'dm' ? 'badge-amber' : 'badge-accent';
  return html`<span class="badge ${cls}">${raw.replace(/_/g, ' ')}</span>`;
}

export function trendIndicator(trend) {
  const v = String(trend === null || trend === undefined ? '' : trend).toLowerCase();
  if (v === 'rising') {
    return html`<span class="trend trend-rising" title="Mentions rising">${trust('<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 16l6-6 4 4 6-6"></path><path d="M20 8h-4M20 8v4"></path></svg>')}rising</span>`;
  }
  if (v === 'falling') {
    return html`<span class="trend trend-falling" title="Mentions falling">${trust('<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8l6 6 4-4 6 6"></path><path d="M20 16h-4M20 16v-4"></path></svg>')}falling</span>`;
  }
  return html`<span class="trend" title="Mentions steady">${trust('<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 12h16"></path></svg>')}${v || 'steady'}</span>`;
}

export function scoreRing(score, small) {
  const n = Number(score);
  const has = isFinite(n);
  const val = has ? Math.max(0, Math.min(100, Math.round(n))) : 0;
  const cls = !has ? 'score-bad' : val >= 85 ? 'score-ok' : val >= 60 ? 'score-warn' : 'score-bad';
  return html`<div class="score ${small ? 'score-sm' : ''} ${cls}" style="--score:${val}" title="Lint score ${has ? val : '—'} / 100"><b>${has ? val : '—'}</b></div>`;
}

export function lintChips(lint) {
  if (!lint || typeof lint !== 'object') {
    return html`<span class="chip chip-tag" title="No lint object was returned for this draft">lint not available</span>`;
  }
  const violations = Array.isArray(lint.violations) ? lint.violations : [];
  if (!violations.length) {
    return lint.passed === false
      ? html`<span class="chip chip-hard">verification failed — no violation detail returned</span>`
      : html`<span class="chip chip-tag">no lint violations</span>`;
  }
  return violations.map((v) => {
    const sev = String(v && v.severity ? v.severity : '').toLowerCase() === 'hard' ? 'chip-hard' : 'chip-soft';
    const rule = v && v.rule ? v.rule : 'rule';
    const detail = v && v.detail ? v.detail : '';
    const label = detail ? rule + ' — ' + detail : rule;
    return html`<span class="chip ${sev}" title="${label}"><span class="chip-rule">${rule}</span><span class="chip-detail">${detail}</span></span>`;
  });
}

/* ------------------------------------------------------------- states */

export function skeletonBlock(rows) {
  const n = Math.max(1, rows || 4);
  let out = '';
  for (let i = 0; i < n; i++) {
    const width = i % 3 === 1 ? 'skel-row w60' : i % 3 === 2 ? 'skel-row w40' : 'skel-row w80';
    out += '<div class="' + width + ' skel"></div>';
  }
  return trust(out);
}

export function emptyState(opts) {
  const o = opts || {};
  return html`<div class="empty">
    ${o.icon ? glyph(o.icon, 26) : ''}
    <div class="empty-title">${o.title || 'Nothing here yet'}</div>
    ${o.message ? html`<div class="empty-msg">${o.message}</div>` : ''}
    ${o.action ? html`<button type="button" class="btn btn-sm" data-action="${o.action}">${o.actionLabel || 'Retry'}</button>` : ''}
  </div>`;
}

export function errorState(err, retryAction, title) {
  const message = err && err.message ? err.message : 'The request failed.';
  const status = err && err.status ? 'HTTP ' + err.status : '';
  return html`<div class="empty empty-error">
    ${glyph('error', 26)}
    <div class="empty-title">${title || "Couldn't load this panel"}</div>
    <div class="empty-msg">${message}${status ? ' (' + status + ')' : ''}</div>
    ${retryAction ? html`<button type="button" class="btn btn-sm" data-action="${retryAction}">Retry</button>` : ''}
  </div>`;
}

/**
 * Standard panel lifecycle: skeleton -> content | inline error state + toast.
 * `load` must resolve to markup (Html) — returning undefined keeps the skeleton off
 * and leaves whatever `onData` wrote.
 */
export async function panel(el, load, options) {
  const o = options || {};
  if (!el) return null;
  const showSkeleton = o.skeleton !== false;
  if (showSkeleton) setHtml(el, skeletonBlock(o.skeletonRows || 4));
  try {
    const result = await load();
    if (result !== undefined && result !== null) setHtml(el, result);
    return result;
  } catch (err) {
    setHtml(el, errorState(err, o.retryAction, o.errorTitle));
    if (!o.silent) toast(err && err.message ? err.message : 'Request failed', 'error');
    return null;
  }
}

/* ------------------------------------------------------------- events & dom */

export function delegate(root, eventName, selector, handler) {
  if (!root) return () => {};
  const listener = (event) => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    if (!target || !root.contains(target)) return;
    handler(event, target);
  };
  root.addEventListener(eventName, listener);
  return () => root.removeEventListener(eventName, listener);
}

export function qs(root, selector) { return root ? root.querySelector(selector) : null; }
export function qsa(root, selector) { return root ? Array.prototype.slice.call(root.querySelectorAll(selector)) : []; }

/** Track disposers for a view and return one teardown function. */
export function disposers() {
  const list = [];
  return {
    add(fn) { if (typeof fn === 'function') list.push(fn); },
    dispose() {
      while (list.length) {
        const fn = list.pop();
        try { fn(); } catch (e) { /* teardown must never break navigation */ }
      }
    },
  };
}

/** Manage a button's busy state around an async action. */
export async function withBusy(button, label, fn) {
  if (!button) return fn();
  const original = button.getAttribute('aria-busy');
  const text = button.querySelector('.btn-label');
  const previous = text ? text.textContent : null;
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  if (text && label) text.textContent = label;
  try {
    return await fn();
  } finally {
    button.removeAttribute('aria-busy');
    button.disabled = false;
    if (text && previous !== null) text.textContent = previous;
    if (original !== null) button.setAttribute('aria-busy', original);
  }
}

export async function copyToClipboard(value) {
  const text = value === null || value === undefined ? '' : String(value);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

/** Local <input type="datetime-local"> value -> RFC3339 UTC. */
export function localInputToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!isFinite(d.getTime())) return null;
  return d.toISOString();
}

export function isoToLocalInput(iso, offsetMinutes) {
  const d = iso ? new Date(iso) : new Date(Date.now() + (offsetMinutes === undefined ? 60 : offsetMinutes) * 60000);
  const base = isFinite(d.getTime()) ? d : new Date(Date.now() + 3600000);
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return base.getFullYear() + '-' + pad(base.getMonth() + 1) + '-' + pad(base.getDate()) + 'T' + pad(base.getHours()) + ':' + pad(base.getMinutes());
}
