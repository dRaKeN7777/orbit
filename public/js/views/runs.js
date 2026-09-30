/**
 * views/runs.js — Runs, automation triggers and settings.
 *
 * Pipeline trigger buttons, the run history table, the selected run's log viewer,
 * and the settings panel (PATCH sends only changed fields). `llm` and `publisher`
 * come from GET /api/health and are read-only here.
 */
import { endpoints, listOf, totalOf, unwrap, ApiError } from '../api.js';
import {
  html,
  trust,
  setHtml,
  panel,
  delegate,
  escapeHtml,
  toast,
  emptyState,
  statusBadge,
  relativeTime,
  formatDateTime,
  formatClock,
  formatDuration,
  toastOk,
  toastErr,
  withBusy,
} from '../ui.js';
import { icon } from '../icons.js';
import { activity } from '../activity.js';
import { EVENTS, on } from '../bus.js';

const MODES = [
  { mode: 'full', label: 'Run full pipeline', primary: true },
  { mode: 'research', label: 'Research' },
  { mode: 'draft', label: 'Draft' },
  { mode: 'publish', label: 'Publish' },
  { mode: 'website', label: 'Website' },
];

const WEBSITE_TARGETS = ['static', 'git', 'wordpress'];

function statsSummary(stats) {
  if (!stats || typeof stats !== 'object') return html`<span class="muted small">—</span>`;
  const keys = Object.keys(stats);
  if (!keys.length) return html`<span class="muted small">—</span>`;
  const text = keys
    .map((k) => k + ' ' + (stats[k] === null || stats[k] === undefined ? '—' : stats[k]))
    .join(' · ');
  return html`<span class="small muted">${text}</span>`;
}

function levelClass(level) {
  const v = String(level === null || level === undefined ? 'info' : level).toLowerCase();
  if (v === 'warn' || v === 'warning') return 'lvl-warn';
  if (v === 'error' || v === 'fatal' || v === 'err') return 'lvl-error';
  if (v === 'debug' || v === 'trace') return 'lvl-debug';
  return 'lvl-info';
}

export async function mount(root, ctx) {
  const state = {
    runs: [],
    total: 0,
    run: null,
    settings: null,
    health: null,
  };

  setHtml(root, html`
    <div class="view-head">
      <span class="count muted small" id="runs-count"></span>
      <span class="head-spacer"></span>
      ${MODES.map((m) => html`<button type="button" class="btn btn-sm ${m.primary ? 'btn-primary' : ''}" data-action="pipeline-run" data-mode="${m.mode}">
        ${icon(m.primary ? 'play' : 'bolt', 13)}<span class="btn-label">${m.label}</span>
      </button>`)}
      <button type="button" class="btn btn-sm btn-ghost" data-action="reload-runs">${icon('refresh', 14)}<span class="btn-label">Reload</span></button>
    </div>

    <div class="grid-2 mb">
      <section class="panel">
        <div class="panel-head">
          <h3>Pipeline runs</h3>
          <span class="spacer"></span>
          <span class="count" id="runs-total"></span>
        </div>
        <div class="panel-body tight" id="runs-panel"></div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h3>Run detail</h3>
          <span class="spacer"></span>
          <span class="count" id="run-detail-label"></span>
        </div>
        <div class="panel-body" id="run-detail-panel"></div>
      </section>
    </div>

    <section class="panel">
      <div class="panel-head">
        <h3>Settings</h3>
        <span class="spacer"></span>
        <span class="count" id="settings-state"></span>
        <button type="button" class="btn btn-xs btn-ghost" data-action="reload-settings" aria-label="Reload settings">${icon('refresh', 12)}</button>
      </div>
      <div class="panel-body" id="settings-panel"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h3>API keys</h3>
        <span class="spacer"></span>
        <span class="count" id="keys-state"></span>
        <button type="button" class="btn btn-xs btn-ghost" data-action="reload-keys" aria-label="Reload keys">${icon('refresh', 12)}</button>
      </div>
      <div class="panel-body" id="keys-panel"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h3>LinkedIn</h3>
        <span class="spacer"></span>
        <span class="count" id="li-state"></span>
      </div>
      <div class="panel-body" id="li-panel"></div>
    </section>
  `);

  const runsPanel = root.querySelector('#runs-panel');
  const runsCount = root.querySelector('#runs-count');
  const runsTotal = root.querySelector('#runs-total');
  const detailPanel = root.querySelector('#run-detail-panel');
  const detailLabel = root.querySelector('#run-detail-label');
  const settingsPanel = root.querySelector('#settings-panel');
  const settingsState = root.querySelector('#settings-state');
  const keysPanel = root.querySelector('#keys-panel');
  const keysState = root.querySelector('#keys-state');
  const liPanel = root.querySelector('#li-panel');
  const liState = root.querySelector('#li-state');

  /* ------------------------------------------------------------ runs */

  function runRow(run) {
    const r = run && typeof run === 'object' ? run : {};
    const id = r.id === undefined || r.id === null ? '' : String(r.id);
    const selected = state.run && String(state.run.id) === id;
    const running = String(r.status || '').toLowerCase() === 'running';
    const duration = r.duration_ms !== undefined && r.duration_ms !== null
      ? formatDuration(r.duration_ms)
      : running && r.started_at
        ? formatDuration(Date.now() - Date.parse(r.started_at)) + '…'
        : '—';
    return html`<tr class="clickable ${selected ? 'selected' : ''}" data-action="open-run" data-run-id="${id}">
      <td>
        <div class="table-primary">${r.kind || 'run'}</div>
        <div class="table-sub mono truncate">${id || '—'}</div>
      </td>
      <td>${statusBadge(r.status || 'unknown')}</td>
      <td class="nowrap small">${duration}</td>
      <td class="nowrap small muted" title="${formatDateTime(r.started_at)}">${relativeTime(r.started_at)}</td>
      <td>${statsSummary(r.stats)}</td>
    </tr>`;
  }

  function runsMarkup() {
    if (!state.runs.length) {
      return emptyState({
        icon: 'list',
        title: 'No pipeline runs yet',
        message: 'Trigger a run above — full runs ingest, cluster, draft, verify and publish in one pass.',
      });
    }
    return html`<div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Status</th>
            <th class="nowrap">Duration</th>
            <th class="nowrap">Started</th>
            <th>Stats</th>
          </tr>
        </thead>
        <tbody>${state.runs.map(runRow)}</tbody>
      </table>
    </div>`;
  }

  async function loadRuns() {
    await panel(runsPanel, async () => {
      const res = await endpoints.runs({ limit: 20 });
      const items = listOf(res);
      state.runs = items;
      state.total = totalOf(res, items);
      if (runsTotal) runsTotal.textContent = state.total + (state.total === 1 ? ' run' : ' runs');
      if (runsCount) {
        const running = items.filter((r) => String((r && r.status) || '').toLowerCase() === 'running').length;
        const failed = items.filter((r) => String((r && r.status) || '').toLowerCase() === 'failed').length;
        runsCount.textContent = running + ' running · ' + failed + ' failed · ' + state.total + ' total';
      }
      return runsMarkup();
    }, { retryAction: 'reload-runs', errorTitle: "Couldn't load pipeline runs", skeletonRows: 5 });
  }

  async function openRun(id) {
    if (!id) { toastErr('This run has no id in the API response.'); return; }
    await panel(detailPanel, async () => {
      const res = await endpoints.run(id);
      const run = unwrap(res, ['run']);
      if (!run || typeof run !== 'object') throw new Error('The API did not return a run for id ' + id);
      state.run = run;
      if (detailLabel) detailLabel.textContent = (run.kind || 'run') + ' · ' + (run.status || 'unknown');
      for (const row of root.querySelectorAll('tr[data-run-id]')) {
        row.classList.toggle('selected', row.getAttribute('data-run-id') === String(id));
      }
      return detailMarkup();
    }, { retryAction: 'retry-run', errorTitle: "Couldn't load this run", skeletonRows: 5 });
  }

  function logMarkup(run) {
    const log = Array.isArray(run.log) ? run.log : [];
    if (!log.length) {
      return emptyState({
        icon: 'code',
        title: 'No log lines for this run',
        message: 'The API returned an empty log array. Live lines appear in the activity console below as they stream in.',
      });
    }
    return html`<div class="logview" id="logview">
      ${log.map((line) => {
        const l = line && typeof line === 'object' ? line : { msg: String(line) };
        return html`<div class="log-line ${levelClass(l.level)}">
          <span class="lt">${formatClock(l.at)}</span>
          <span class="ll">${l.level || 'info'}</span>
          <span class="lm">${l.msg || ''}</span>
        </div>`;
      })}
    </div>`;
  }

  function detailMarkup() {
    const run = state.run;
    if (!run) {
      return emptyState({
        icon: 'code',
        title: 'No run selected',
        message: 'Click a run in the table to read its full log.',
      });
    }
    const duration = run.duration_ms !== undefined && run.duration_ms !== null
      ? formatDuration(run.duration_ms)
      : String(run.status || '').toLowerCase() === 'running' && run.started_at
        ? formatDuration(Date.now() - Date.parse(run.started_at)) + '…'
        : '—';

    return html`
      <div class="row mb">
        <span class="table-primary">${run.kind || 'run'}</span>
        ${statusBadge(run.status || 'unknown')}
        <span class="spacer"></span>
        <span class="small muted mono truncate">${run.id || ''}</span>
      </div>
      <div class="kv mb">
        <span><span class="k">started</span> <span class="v">${formatDateTime(run.started_at)}</span></span>
        <span><span class="k">finished</span> <span class="v">${formatDateTime(run.finished_at)}</span></span>
        <span><span class="k">duration</span> <span class="v">${duration}</span></span>
      </div>
      ${statsSummary(run.stats)}
      <div class="mt">${logMarkup(run)}</div>
    `;
  }

  function renderDetail() {
    setHtml(detailPanel, detailMarkup());
    const view = root.querySelector('#logview');
    if (view) view.scrollTop = view.scrollHeight;
  }

  /* ------------------------------------------------------------ pipeline */

  async function triggerPipeline(button, mode) {
    const label = 'Running ' + mode + '…';
    await withBusy(button, label, async () => {
      try {
        const res = await endpoints.pipelineRun(mode);
        const runId = res && res.run_id ? res.run_id : null;
        toastOk('Pipeline "' + mode + '" started' + (runId ? ' — ' + runId : ''));
        activity.log('pipeline "' + mode + '" triggered' + (runId ? ' → ' + runId : ''));
        loadRuns();
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Could not start the pipeline');
      }
    });
  }

  /* ------------------------------------------------------------ settings */

  function settingsMarkup() {
    const s = state.settings;
    if (!s) return emptyState({ icon: 'gear', title: 'Settings unavailable' });
    const health = state.health || {};
    const regions = Array.isArray(s.regions) ? s.regions.join(', ') : s.regions || '';
    const banned = Array.isArray(s.banned_extra) ? s.banned_extra.join(', ') : s.banned_extra || '';
    return html`
      <div class="row mb">
        <span class="badge badge-accent">llm: ${health.llm || '—'}</span>
        <span class="badge badge-accent">publisher: ${health.publisher || '—'}</span>
        <span class="small muted">read-only, from GET /api/health${health.version ? ' · v' + health.version : ''}</span>
      </div>

      <div class="grid-2">
        <div>
          <div class="field">
            <label for="set-company">Our company</label>
            <input class="input" id="set-company" data-setting="our_company" value="${s.our_company || ''}" />
          </div>
          <div class="field">
            <label for="set-focus">Our focus</label>
            <textarea class="textarea" id="set-focus" data-setting="our_focus" style="min-height: 74px">${s.our_focus || ''}</textarea>
          </div>
          <div class="field">
            <label for="set-voice">Voice</label>
            <input class="input" id="set-voice" data-setting="our_voice" value="${s.our_voice || ''}" />
          </div>
          <div class="field">
            <label for="set-regions">Regions</label>
            <input class="input" id="set-regions" data-setting="regions" value="${regions}" />
            <span class="help">Comma separated, e.g. UK, CH</span>
          </div>
          <div class="field">
            <label class="check"><input type="checkbox" id="set-auto" data-setting="auto_publish" ${s.auto_publish ? trust('checked') : null} /> Publish scheduled drafts automatically</label>
            <span class="help">When off, due items wait for a manual “Publish due now”.</span>
          </div>
        </div>
        <div>
          <div class="field">
            <label for="set-schedule-cron">Schedule cron</label>
            <input class="input mono" id="set-schedule-cron" data-setting="schedule_cron" value="${s.schedule_cron || ''}" placeholder="0 6 * * *" />
          </div>
          <div class="field">
            <label for="set-publish-cron">Publish cron</label>
            <input class="input mono" id="set-publish-cron" data-setting="publish_cron" value="${s.publish_cron || ''}" placeholder="* * * * *" />
          </div>
          <div class="field">
            <label for="set-target">Website target</label>
            <select class="select" id="set-target" data-setting="website_target">
              ${WEBSITE_TARGETS.map((t) => html`<option value="${t}" ${s.website_target === t ? trust('selected') : null}>${t}</option>`)}
            </select>
          </div>
          <div class="field">
            <label for="set-path">Website path</label>
            <input class="input mono" id="set-path" data-setting="website_path" value="${s.website_path || ''}" />
          </div>
          <div class="field">
            <label for="set-banned">Extra banned words</label>
            <input class="input" id="set-banned" data-setting="banned_extra" value="${banned}" />
            <span class="help">Comma separated; added to the linter's hard-fail list.</span>
          </div>
        </div>
      </div>

      <div class="btn-row">
        <button type="button" class="btn btn-sm btn-primary" data-action="save-settings">${icon('check', 13)}<span class="btn-label">Save settings</span></button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="reload-settings">Discard changes</button>
      </div>
    `;
  }

  function keysMarkup(items) {
    const groups = new Map();
    for (const k of items) {
      if (!groups.has(k.group)) groups.set(k.group, []);
      groups.get(k.group).push(k);
    }
    const body = [...groups.entries()].map(([group, keys]) => `
      <div class="setting-group">
        <div class="setting-group-title">${escapeHtml(group)}</div>
        ${keys.map((k) => `
          <div class="setting-row">
            <label class="setting-label" for="key-${escapeHtml(k.name)}">
              ${escapeHtml(k.label)}
              <span class="badge ${k.configured ? 'badge-ok' : 'badge-grey'}">${escapeHtml(k.source)}</span>
            </label>
            <div class="key-row">
              <input class="input" id="key-${escapeHtml(k.name)}" type="password"
                     data-key="${escapeHtml(k.name)}" autocomplete="off" spellcheck="false"
                     placeholder="${k.configured ? '••••••••  (set — leave blank to keep)' : 'not set'}" />
              <button type="button" class="btn btn-xs btn-primary" data-action="save-key" data-key-name="${escapeHtml(k.name)}">Save</button>
              <button type="button" class="btn btn-xs btn-ghost" data-action="clear-key" data-key-name="${escapeHtml(k.name)}">Clear</button>
            </div>
            <span class="help">${escapeHtml(k.hint)}${k.fingerprint ? ' · fingerprint ' + escapeHtml(k.fingerprint) : ''}</span>
          </div>
        `).join('')}
      </div>
    `).join('');
    return body ? trust(body) : emptyState({ icon: 'gear', title: 'No keys configured' });
  }

  async function loadKeys() {
    await panel(keysPanel, async () => {
      const result = await endpoints.keys();
      const items = result && Array.isArray(result.items) ? result.items : [];
      if (keysState) {
        const set = items.filter((k) => k.configured).length;
        keysState.textContent = set + ' of ' + items.length + ' set';
      }
      return keysMarkup(items);
    }, { retryAction: 'reload-keys', errorTitle: "Couldn't load keys", skeletonRows: 4 });
  }

  function linkedinMarkup(status) {
    const s2 = status && typeof status === 'object' ? status : {};
    const connected = s2.connected === true;
    return trust(`
      <div class="setting-group">
        <div class="setting-row">
          <label class="setting-label">Company page</label>
          <div class="mono">${escapeHtml(s2.author_urn || 'not set')}</div>
          <span class="help">Posts are published as this organisation.</span>
        </div>
        <div class="setting-row">
          <label class="setting-label">Will post as</label>
          <div>
            <span class="badge ${s2.post_as ? 'badge-ok' : 'badge-warn'}">${escapeHtml(s2.post_as || 'nothing yet')}</span>
            ${s2.member_urn ? `<span class="help">member ${escapeHtml(s2.member_urn)}</span>` : ''}
            ${s2.org_urn ? `<span class="help">page ${escapeHtml(s2.org_urn)}</span>` : ''}
          </div>
          <span class="help">A self-serve app can post as the member's profile. Posting as the company page needs the Community Management API approved.</span>
        </div>
        <div class="setting-row">
          <label class="setting-label">Status</label>
          <div>
            <span class="badge ${connected ? 'badge-ok' : 'badge-warn'}">${connected ? 'connected' : 'not connected'}</span>
            ${s2.expires_at ? `<span class="help">expires ${escapeHtml(formatDateTime(s2.expires_at))}</span>` : ''}
          </div>
        </div>
        <div class="setting-row">
          <label class="setting-label">Redirect URI</label>
          <div class="mono">${escapeHtml(s2.redirect_uri || '')}</div>
          <span class="help">Add this exact value to your LinkedIn app's Auth tab, then connect.</span>
        </div>
        <div class="btn-row">
          <a class="btn btn-sm btn-primary" href="/api/linkedin/connect">${connected ? 'Reconnect' : 'Connect LinkedIn'}</a>
          ${connected ? '<button type="button" class="btn btn-sm btn-ghost" data-action="disconnect-linkedin">Disconnect</button>' : ''}
        </div>
      </div>
    `);
  }

  async function loadLinkedIn() {
    await panel(liPanel, async () => {
      const status = await endpoints.linkedinStatus();
      if (liState) liState.textContent = status && status.connected ? 'connected' : 'not connected';
      return linkedinMarkup(status);
    }, { retryAction: 'reload-linkedin', errorTitle: "Couldn't load LinkedIn status", skeletonRows: 3 });
  }

  async function loadSettings() {
    await panel(settingsPanel, async () => {
      const [settingsResult, healthResult] = await Promise.allSettled([endpoints.settings(), endpoints.health()]);
      if (settingsResult.status !== 'fulfilled') {
        throw settingsResult.reason instanceof Error ? settingsResult.reason : new ApiError('Settings request failed', 0, null);
      }
      state.settings = settingsResult.value && typeof settingsResult.value === 'object' ? settingsResult.value : {};
      state.health = healthResult.status === 'fulfilled' ? healthResult.value : null;
      if (settingsState) {
        const parts = [];
        if (state.health && state.health.llm) parts.push('llm ' + state.health.llm);
        if (state.health && state.health.publisher) parts.push('publisher ' + state.health.publisher);
        settingsState.textContent = parts.join(' · ');
      }
      return settingsMarkup();
    }, { retryAction: 'reload-settings', errorTitle: "Couldn't load settings", skeletonRows: 6 });
  }

  async function saveSettings(button) {
    const s = state.settings;
    if (!s) return;
    const next = {};
    for (const field of root.querySelectorAll('[data-setting]')) {
      const key = field.getAttribute('data-setting');
      if (field.type === 'checkbox') {
        next[key] = !!field.checked;
      } else if (key === 'regions' || key === 'banned_extra') {
        next[key] = String(field.value || '').split(',').map((v) => v.trim()).filter(Boolean);
      } else {
        next[key] = field.value;
      }
    }
    const diff = {};
    for (const key of Object.keys(next)) {
      if (JSON.stringify(next[key]) !== JSON.stringify(s[key])) diff[key] = next[key];
    }
    const keys = Object.keys(diff);
    if (!keys.length) {
      toastOk('No settings changed');
      return;
    }
    await withBusy(button, 'Saving…', async () => {
      try {
        const res = await endpoints.saveSettings(diff);
        const saved = unwrap(res, ['settings']);
        state.settings = saved && typeof saved === 'object' && saved.id !== undefined ? saved : Object.assign({}, s, next);
        toastOk('Saved ' + keys.join(', '));
        activity.log('settings updated: ' + keys.join(', '));
        loadSettings();
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Could not save settings');
      }
    });
  }

  /* ------------------------------------------------------------ wiring */

  const offClick = delegate(root, 'click', '[data-action]', async (event, el) => {
    const action = el.getAttribute('data-action');
    if (action === 'pipeline-run') { triggerPipeline(el, el.getAttribute('data-mode') || 'full'); return; }
    if (action === 'reload-runs') { loadRuns(); return; }
    if (action === 'reload-settings') { loadSettings(); return; }
    if (action === 'reload-keys') { loadKeys(); return; }
    if (action === 'reload-linkedin') { loadLinkedIn(); return; }
    if (action === 'save-key') {
      const name = target.getAttribute('data-key-name');
      const input = root.querySelector('[data-key="' + name + '"]');
      const value = input ? input.value.trim() : '';
      if (!value) { toast('Enter a value first', 'info'); return; }
      try {
        await endpoints.setKey(name, value);
        if (input) input.value = '';
        toastOk(name + ' saved');
        loadKeys();
      } catch (err) {
        toastErr(err instanceof Error ? err.message : 'Could not save key');
      }
      return;
    }
    if (action === 'clear-key') {
      const name = target.getAttribute('data-key-name');
      if (!window.confirm('Remove ' + name + '?')) return;
      try {
        await endpoints.clearKey(name);
        toastOk(name + ' cleared');
        loadKeys();
      } catch (err) {
        toastErr(err instanceof Error ? err.message : 'Could not clear key');
      }
      return;
    }
    if (action === 'disconnect-linkedin') {
      if (!window.confirm('Disconnect LinkedIn? Scheduled posts will fail until you reconnect.')) return;
      try {
        await endpoints.linkedinDisconnect();
        toastOk('LinkedIn disconnected');
        loadLinkedIn();
      } catch (err) {
        toastErr(err instanceof Error ? err.message : 'Could not disconnect');
      }
      return;
    }
    if (action === 'save-settings') { saveSettings(el); return; }
    if (action === 'retry-run') {
      if (state.run) openRun(state.run.id);
      return;
    }
    if (action === 'open-run') { openRun(el.getAttribute('data-run-id')); }
  });
  ctx.onDestroy(offClick);

  const offLog = on(EVENTS.RUN_LOG, (payload) => {
    const view = root.querySelector('#logview');
    if (!view || !state.run) return;
    const p = payload && typeof payload === 'object' ? payload : {};
    const runId = p.run_id || p.runId || (p.run && p.run.id);
    if (runId && String(runId) !== String(state.run.id)) return;
    const line = document.createElement('div');
    line.className = 'log-line ' + levelClass(p.level);
    setHtml(line, html`<span class="lt">${formatClock(p.at)}</span><span class="ll">${p.level || 'info'}</span><span class="lm">${p.msg || ''}</span>`);
    view.appendChild(line);
    view.scrollTop = view.scrollHeight;
  });
  ctx.onDestroy(offLog);

  const offStatus = on(EVENTS.RUN_STATUS, (payload) => {
    loadRuns();
    const p = payload && typeof payload === 'object' ? payload : {};
    const id = p.id || p.run_id;
    if (!state.run) return;
    if (!id || String(id) === String(state.run.id)) openRun(state.run.id);
  });
  ctx.onDestroy(offStatus);

  activity.log('runs: loading history, keys and LinkedIn status');
  loadRuns();
  loadSettings();
  loadKeys();
  loadLinkedIn();
}

export default { mount };
