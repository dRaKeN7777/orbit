/**
 * views/scheduler.js — Scheduler & Inbound Tracker.
 *
 * Week grid (Mon–Sun) of scheduled items coloured by status, the full publish queue
 * as a table with cancel + "Publish due now", and the inbound engagement tracker with
 * its warm-lead banner.
 */
import { endpoints, listOf, totalOf } from '../api.js';
import {
  html,
  setHtml,
  panel,
  delegate,
  emptyState,
  statusBadge,
  typeBadge,
  regionBadge,
  relativeTime,
  formatDateTime,
  formatClock,
  truncate,
  toastOk,
  toastErr,
  withBusy,
} from '../ui.js';
import { icon } from '../icons.js';
import { activity } from '../activity.js';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function startOfWeek(date, offsetWeeks) {
  const d = new Date(date.getTime());
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day + (offsetWeeks || 0) * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayKey(value) {
  const d = new Date(value);
  if (!isFinite(d.getTime())) return null;
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function weekLabel(start) {
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 6);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const left = start.getDate() + ' ' + months[start.getMonth()];
  const right = end.getDate() + ' ' + months[end.getMonth()];
  return left + ' – ' + right;
}

export async function mount(root, ctx) {
  const state = {
    items: [],
    total: 0,
    engagements: [],
    warmLeads: 0,
    weekOffset: 0,
  };

  setHtml(root, html`
    <div class="view-head">
      <span class="count muted small" id="sched-count"></span>
      <span class="head-spacer"></span>
      <label class="check" title="Publish every pending item regardless of its scheduled time">
        <input type="checkbox" id="publish-force" /> force
      </label>
      <button type="button" class="btn btn-sm btn-primary" data-action="publish-run">${icon('send', 14)}<span class="btn-label">Publish due now</span></button>
      <button type="button" class="btn btn-sm btn-ghost" data-action="reload-schedule">${icon('refresh', 14)}<span class="btn-label">Reload</span></button>
    </div>

    <section class="panel">
      <div class="panel-head">
        <h3>Week</h3>
        <span class="spacer"></span>
        <button type="button" class="btn btn-xs btn-ghost" data-action="prev-week" aria-label="Previous week">${icon('chevronLeft', 12)}</button>
        <span class="count" id="week-label"></span>
        <button type="button" class="btn btn-xs btn-ghost" data-action="this-week">Today</button>
        <button type="button" class="btn btn-xs btn-ghost" data-action="next-week" aria-label="Next week">${icon('chevronRight', 12)}</button>
      </div>
      <div class="panel-body">
        <div class="week" id="week-grid"></div>
        <div class="legend mt">
          <span><i style="background: var(--accent)"></i>pending</span>
          <span><i style="background: var(--green)"></i>published</span>
          <span><i style="background: var(--red)"></i>failed</span>
          <span><i style="background: var(--muted)"></i>cancelled</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h3>Publish queue</h3>
        <span class="spacer"></span>
        <span class="count" id="queue-count"></span>
      </div>
      <div class="panel-body tight" id="queue-panel"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h3>Inbound tracker</h3>
        <span class="spacer"></span>
        <span class="count" id="engagement-count"></span>
        <button type="button" class="btn btn-xs btn-ghost" data-action="reload-engagements" aria-label="Reload inbound tracker">${icon('refresh', 12)}</button>
      </div>
      <div class="panel-body" id="engagement-panel"></div>
    </section>
  `);

  const weekGrid = root.querySelector('#week-grid');
  const weekLabelEl = root.querySelector('#week-label');
  const queuePanel = root.querySelector('#queue-panel');
  const queueCount = root.querySelector('#queue-count');
  const schedCount = root.querySelector('#sched-count');
  const engagementPanel = root.querySelector('#engagement-panel');
  const engagementCount = root.querySelector('#engagement-count');

  /* ------------------------------------------------------------ week grid */

  function renderWeek() {
    const todayKey = dayKey(Date.now());
    const start = startOfWeek(new Date(), state.weekOffset);
    if (weekLabelEl) weekLabelEl.textContent = weekLabel(start);

    const buckets = {};
    for (const item of state.items) {
      const key = dayKey(item && item.scheduled_at);
      if (!key) continue;
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(item);
    }
    for (const key of Object.keys(buckets)) {
      buckets[key].sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
    }

    const cols = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(start.getTime());
      day.setDate(day.getDate() + i);
      const key = dayKey(day.getTime());
      const items = buckets[key] || [];
      cols.push(html`
        <div class="week-col ${key === todayKey ? 'today' : ''}">
          <div class="week-head">
            <span class="dow">${DOW[i]}</span>
            <span class="dom">${day.getDate()}</span>
          </div>
          <div class="week-items">
            ${items.length
              ? items.map((item) => {
                  const status = String((item && item.status) || 'pending').toLowerCase();
                  const title = truncate((item && item.title) || '(untitled draft)', 70);
                  return html`<button type="button" class="week-item wi-${status}" data-action="open-draft" data-draft-id="${item && item.draft_id}" title="${title}">
                    <span class="wi-time">${formatClock(item && item.scheduled_at)}</span>
                    <span class="wi-title">${title}</span>
                  </button>`;
                })
              : html`<span class="small muted">—</span>`}
          </div>
        </div>`);
    }
    setHtml(weekGrid, html`${cols}`);
  }

  /* ------------------------------------------------------------ queue */

  function queueMarkup() {
    const items = state.items;
    if (!items.length) {
      return emptyState({
        icon: 'calendar',
        title: 'Nothing scheduled',
        message: 'Schedule a verified draft from the Studio and it will appear here.',
        action: 'reload-schedule',
        actionLabel: 'Reload',
      });
    }

    return html`<div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="nowrap">Scheduled</th>
            <th>Draft</th>
            <th>Channel</th>
            <th>Status</th>
            <th class="num">Attempts</th>
            <th>Last error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item) => {
            const status = String((item && item.status) || 'pending').toLowerCase();
            const title = truncate((item && item.title) || '(untitled draft)', 70);
            const error = item && item.last_error ? String(item.last_error) : '';
            return html`<tr>
              <td class="nowrap">
                <div>${formatDateTime(item && item.scheduled_at)}</div>
                <div class="table-sub">${relativeTime(item && item.scheduled_at)}</div>
              </td>
              <td>
                <div class="table-primary truncate" title="${title}">${title}</div>
                <div class="table-sub">
                  ${item && item.draft_id !== undefined && item.draft_id !== null
                    ? html`<a href="#studio?draft=${encodeURIComponent(item.draft_id)}">draft #${item.draft_id}</a>`
                    : 'draft —'}
                  ${item && item.published_url ? html` · <a href="${/^https?:\/\//i.test(item.published_url) ? item.published_url : '#'}" target="_blank" rel="noopener">published</a>` : ''}
                </div>
              </td>
              <td class="nowrap small muted">${(item && item.channel) || '—'}</td>
              <td>${statusBadge(status)}</td>
              <td class="num">${item && item.attempts !== undefined && item.attempts !== null ? item.attempts : '—'}</td>
              <td>${error ? html`<div class="err-mono">${error}</div>` : html`<span class="muted small">—</span>`}</td>
              <td class="nowrap">
                ${status === 'pending'
                  ? html`<button type="button" class="btn btn-xs btn-danger" data-action="cancel-item" data-schedule-id="${item && item.id}" data-title="${title}">Cancel</button>`
                  : ''}
              </td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>`;
  }

  function renderQueue() {
    setHtml(queuePanel, queueMarkup());
  }

  async function loadSchedule() {
    await panel(queuePanel, async () => {
      const res = await endpoints.schedule({ limit: 200 });
      const items = listOf(res);
      state.items = items;
      state.total = totalOf(res, items);
      if (queueCount) queueCount.textContent = state.total + (state.total === 1 ? ' item' : ' items');
      if (schedCount) {
        const pending = items.filter((i) => String((i && i.status) || '').toLowerCase() === 'pending').length;
        const failed = items.filter((i) => String((i && i.status) || '').toLowerCase() === 'failed').length;
        schedCount.textContent = pending + ' pending · ' + failed + ' failed · ' + state.total + ' total';
      }
      renderWeek();
      return queueMarkup();
    }, { retryAction: 'reload-schedule', errorTitle: "Couldn't load the publish queue", skeletonRows: 5 });
  }

  /* ------------------------------------------------------------ engagements */

  function engagementMarkup() {
    const items = state.engagements;
    const banner = state.warmLeads > 0
      ? html`<div class="alert alert-warm" role="status">
          ${icon('bolt', 17)}
          <span><b>${state.warmLeads} warm lead${state.warmLeads === 1 ? '' : 's'}</b> — a watched executive engaged with our content. Reply while it is fresh.</span>
        </div>`
      : '';

    if (!items.length) {
      return html`${banner}${emptyState({
        icon: 'inbox',
        title: 'No inbound signals yet',
        message: 'Likes, comments, shares and profile views from watched executives show up here.',
        action: 'reload-engagements',
        actionLabel: 'Reload',
      })}`;
    }

    return html`${banner}
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Executive</th>
              <th>Company</th>
              <th>Region</th>
              <th>Type</th>
              <th class="nowrap">Detected</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((e) => html`<tr class="${e && e.warm ? 'tr-warm' : ''}">
              <td>
                <div class="table-primary">${(e && e.target_name) || 'Unknown'}</div>
                ${e && e.our_post_url && /^https?:\/\//i.test(e.our_post_url)
                  ? html`<div class="table-sub"><a href="${e.our_post_url}" target="_blank" rel="noopener">our post</a></div>`
                  : ''}
              </td>
              <td class="truncate">${(e && e.company) || '—'}</td>
              <td>${regionBadge(e && e.region)}</td>
              <td>${typeBadge(e && e.type)}${e && e.warm ? html` <span class="badge badge-amber">warm</span>` : ''}</td>
              <td class="nowrap muted small" title="${formatDateTime(e && e.detected_at)}">${relativeTime(e && e.detected_at)}</td>
              <td class="small muted">${(e && e.notes) || '—'}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>`;
  }

  async function loadEngagements() {
    await panel(engagementPanel, async () => {
      const res = await endpoints.engagements({ limit: 100 });
      const items = listOf(res);
      state.engagements = items;
      state.warmLeads = res && typeof res.warm_leads === 'number' ? res.warm_leads : items.filter((e) => e && e.warm).length;
      if (engagementCount) engagementCount.textContent = state.warmLeads + ' warm · ' + totalOf(res, items) + ' total';
      return engagementMarkup();
    }, { retryAction: 'reload-engagements', errorTitle: "Couldn't load the inbound tracker", skeletonRows: 4 });
  }

  /* ------------------------------------------------------------ actions */

  async function publishDue(button) {
    const force = root.querySelector('#publish-force');
    const forceValue = !!(force && force.checked);
    await withBusy(button, 'Publishing…', async () => {
      try {
        const res = await endpoints.publishRun(forceValue);
        const published = Array.isArray(res && res.published) ? res.published : [];
        const failed = Array.isArray(res && res.failed) ? res.failed : [];
        const skipped = res && res.skipped !== undefined && res.skipped !== null ? res.skipped : 0;
        activity.log('publish run: ' + published.length + ' published, ' + failed.length + ' failed, ' + skipped + ' skipped');
        if (failed.length) {
          toastErr('Published ' + published.length + ', failed ' + failed.length + ': ' + (failed[0] && failed[0].error ? failed[0].error : 'see queue for details'));
        } else {
          toastOk('Published ' + published.length + ' · failed 0 · skipped ' + skipped);
        }
        loadSchedule();
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Publish run failed');
      }
    });
  }

  async function cancelItem(button, id, title) {
    if (id === null || id === undefined || id === '') {
      toastErr('This schedule item has no id in the API response.');
      return;
    }
    const ok = window.confirm('Cancel the scheduled publish of “' + title + '”?');
    if (!ok) return;
    await withBusy(button, 'Cancelling…', async () => {
      try {
        await endpoints.cancelSchedule(id);
        toastOk('Scheduled item cancelled');
        loadSchedule();
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Cancel failed');
      }
    });
  }

  const offClick = delegate(root, 'click', '[data-action]', (event, el) => {
    const action = el.getAttribute('data-action');
    if (action === 'reload-schedule') { loadSchedule(); return; }
    if (action === 'reload-engagements') { loadEngagements(); return; }
    if (action === 'publish-run') { publishDue(el); return; }
    if (action === 'cancel-item') {
      cancelItem(el, el.getAttribute('data-schedule-id'), el.getAttribute('data-title') || 'this item');
      return;
    }
    if (action === 'open-draft') {
      const draftId = el.getAttribute('data-draft-id');
      if (!draftId) { toastErr('This schedule item has no draft_id.'); return; }
      ctx.navigate('#studio?draft=' + encodeURIComponent(draftId));
      return;
    }
    if (action === 'prev-week') { state.weekOffset -= 1; renderWeek(); return; }
    if (action === 'next-week') { state.weekOffset += 1; renderWeek(); return; }
    if (action === 'this-week') { state.weekOffset = 0; renderWeek(); }
  });
  ctx.onDestroy(offClick);

  activity.log('scheduler: loading queue and inbound tracker');
  renderWeek();
  loadSchedule();
  loadEngagements();
}

export default { mount };
