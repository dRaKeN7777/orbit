/**
 * activity.js — the always-visible bottom activity console.
 *
 * Owned by the shell, not by any view: `run.log` SSE events and local view notices
 * are appended here. Newest line is at the bottom and the pane auto-scrolls unless
 * the operator has scrolled up to read history.
 */
import { escapeHtml, formatClock } from './ui.js';

const MAX_LINES = 600;

const LEVELS = { info: 'cl-info', warn: 'cl-warn', warning: 'cl-warn', error: 'cl-error', debug: 'cl-debug' };

let body = null;
let meta = null;
let mode = null;
let count = 0;
let pinned = true;

function normalizeLevel(level) {
  const v = String(level === null || level === undefined ? 'info' : level).toLowerCase();
  if (v === 'warning') return 'warn';
  if (v === 'err' || v === 'fatal') return 'error';
  if (v === 'success') return 'info';
  return LEVELS[v] ? v : 'info';
}

function isPinned() {
  if (!body) return true;
  return body.scrollHeight - body.scrollTop - body.clientHeight < 40;
}

export function append(level, message, at) {
  if (!body) return;
  const lvl = normalizeLevel(level);
  const line = document.createElement('div');
  line.className = 'console-line ' + (LEVELS[lvl] || 'cl-info');
  const time = formatClock(at || Date.now());
  const text = message === null || message === undefined ? '' : String(message);
  line.innerHTML =
    '<span class="ct">' + escapeHtml(time) + '</span>' +
    '<span class="cl">' + escapeHtml(lvl) + '</span>' +
    '<span class="cm">' + escapeHtml(text) + '</span>';
  body.appendChild(line);

  count += 1;
  while (body.children.length > MAX_LINES) body.removeChild(body.firstElementChild);
  if (isPinned() || pinned) body.scrollTop = body.scrollHeight;
  if (meta) meta.textContent = count + (count === 1 ? ' line' : ' lines');
}

export function log(message) { append('info', message); }
export function warn(message) { append('warn', message); }
export function error(message) { append('error', message); }

export function clear() {
  if (!body) return;
  body.innerHTML = '';
  count = 0;
  if (meta) meta.textContent = 'no events yet';
}

export function setMode(next) {
  if (!mode) return;
  const value = String(next || 'live');
  mode.textContent = value === 'polling' ? 'polling /api/stats' : value;
  mode.classList.toggle('polling', value === 'polling');
  mode.classList.toggle('offline', value === 'offline');
}

export function init() {
  body = document.getElementById('console-body');
  meta = document.getElementById('console-meta');
  mode = document.getElementById('stream-mode');
  const strip = document.getElementById('console');
  const toggle = document.getElementById('console-toggle');
  const clearBtn = document.getElementById('console-clear');

  if (toggle && strip) {
    toggle.addEventListener('click', () => {
      const collapsed = strip.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  }
  if (clearBtn) clearBtn.addEventListener('click', clear);
  if (body) {
    body.addEventListener('scroll', () => { pinned = isPinned(); });
  }
  setMode('live');
}

export const activity = { append, log, warn, error, clear, setMode, init };
