/**
 * api.js — the single fetch path for the whole app.
 *
 * Every request goes through `request()`:
 *   - path is prefixed with /api
 *   - writes send Content-Type: application/json
 *   - JSON is parsed; a non-2xx response throws ApiError carrying the server's
 *     `{ error }` message (never a silent failure)
 *
 * Auth: the API contract says `Authorization: Bearer <token>` when ORBIT_TOKEN is
 * set. The token is read from localStorage('orbit_token') so a local dev can set it
 * from the console without a settings screen. EventSource cannot send headers, so
 * the stream helper appends the same token as a query param.
 */

export const API_BASE = '/api';
export const TOKEN_KEY = 'orbit_token';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.status = status || 0;
    this.body = body || null;
  }
}

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}

export function setToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) { /* storage unavailable — requests simply go unauthenticated */ }
}

function buildUrl(path, query) {
  const url = new URL(API_BASE + path, window.location.origin);
  if (query && typeof query === 'object') {
    for (const key of Object.keys(query)) {
      const value = query[key];
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function cleanMessage(text, fallback) {
  if (!text) return fallback;
  const trimmed = String(text).trim();
  if (!trimmed) return fallback;
  if (trimmed.length > 300) return trimmed.slice(0, 300) + '…';
  return trimmed;
}

async function request(method, path, options) {
  const opts = options || {};
  const url = buildUrl(path, opts.query);
  const headers = { Accept: 'application/json' };
  // Same-origin so the session cookie rides along on every authenticated call.
  const init = { method, headers, credentials: 'same-origin' };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiError('Network error — could not reach the Orbit API.', 0, null);
  }

  let text = '';
  try { text = await res.text(); } catch (e) { text = ''; }
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = null; }
  }

  if (!res.ok) {
    let message = null;
    if (data && typeof data === 'object') {
      if (typeof data.error === 'string') message = data.error;
      else if (typeof data.message === 'string') message = data.message;
    }
    if (!message) message = cleanMessage(text, res.status + ' ' + (res.statusText || 'Request failed'));
    throw new ApiError(message, res.status, data);
  }

  if (data === null && text) {
    // 2xx with a non-JSON body: surface it rather than pretending success.
    throw new ApiError('Server returned a non-JSON response.', res.status, null);
  }
  return data === null ? {} : data;
}

export const api = {
  get: (path, query) => request('GET', path, { query }),
  post: (path, body) => request('POST', path, { body: body === undefined ? {} : body }),
  patch: (path, body) => request('PATCH', path, { body: body === undefined ? {} : body }),
  put: (path, body) => request('PUT', path, { body: body === undefined ? {} : body }),
  del: (path) => request('DELETE', path, {}),
};

/* -------------------------------------------------------------- defensive helpers */

/** Items array from any list response — never throws, never returns null. */
export function listOf(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.items)) return res.items;
  return [];
}

export function totalOf(res, fallbackItems) {
  if (res && typeof res.total === 'number') return res.total;
  if (Array.isArray(fallbackItems)) return fallbackItems.length;
  return 0;
}

/** Some endpoints may return the object bare or wrapped in { draft } / { update }. */
export function unwrap(res, keys) {
  if (!res || typeof res !== 'object') return null;
  for (const key of keys) {
    const value = res[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return res;
}

/* -------------------------------------------------------------- endpoints */

export const endpoints = {
  health: () => api.get('/health'),
  stats: () => api.get('/stats'),

  // Auth. The cookie is HttpOnly, so the browser stores it; we only ever read
  // who we are signed in as.
  session: () => api.get('/auth/session'),
  login: (username, password) => api.post('/auth/login', { username, password }),
  logout: () => api.post('/auth/logout', {}),

  settings: () => api.get('/settings'),
  saveSettings: (body) => api.patch('/settings', body),

  targets: (query) => api.get('/targets', query),
  posts: (query) => api.get('/posts', query),
  ingestRun: (body) => api.post('/ingest/run', body || {}),

  topics: (query) => api.get('/topics', query),
  recomputeTopics: (days) => api.post('/topics/recompute', { days: days === undefined ? 14 : days }),

  generate: (post_id, mode, source) =>
    api.post('/generate', { post_id, mode: mode || 'both', source: source || 'inbound' }),

  drafts: (query) => api.get('/drafts', query),
  draft: (id) => api.get('/drafts/' + encodeURIComponent(id)),
  patchDraft: (id, body) => api.patch('/drafts/' + encodeURIComponent(id), body),
  verifyDraft: (id) => api.post('/drafts/' + encodeURIComponent(id) + '/verify', {}),
  regenerateDraft: (id, feedback) =>
    api.post('/drafts/' + encodeURIComponent(id) + '/regenerate', { feedback: feedback || '' }),

  scheduleDraft: (id, scheduled_at, channel) =>
    api.post('/drafts/' + encodeURIComponent(id) + '/schedule', {
      scheduled_at,
      channel: channel || 'linkedin_company',
    }),

  schedule: (query) => api.get('/schedule', query),
  cancelSchedule: (id) => api.del('/schedule/' + encodeURIComponent(id)),
  publishRun: (force) => api.post('/publish/run', { force: !!force }),

  engagements: (query) => api.get('/engagements', query),

  websiteUpdates: (query) => api.get('/website/updates', query),
  websitePlan: (topic_slug, kind) => api.post('/website/plan', { topic_slug, kind }),
  websiteApply: (id) => api.post('/website/updates/' + encodeURIComponent(id) + '/apply', {}),
  websiteReject: (id) => api.post('/website/updates/' + encodeURIComponent(id) + '/reject', {}),

  keys: () => api.get('/keys'),
  setKey: (name, value) => api.put('/keys/' + encodeURIComponent(name), { value }),
  clearKey: (name) => api.del('/keys/' + encodeURIComponent(name)),

  linkedinStatus: () => api.get('/linkedin/status'),
  linkedinDisconnect: () => api.post('/linkedin/disconnect', {}),

  runs: (query) => api.get('/runs', query),
  run: (id) => api.get('/runs/' + encodeURIComponent(id)),
  pipelineRun: (mode) => api.post('/pipeline/run', { mode }),
};

/** URL for the SSE stream (token travels as a query param: EventSource has no headers). */
export function streamUrl() {
  const token = getToken();
  const url = new URL(API_BASE + '/stream', window.location.origin);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}
