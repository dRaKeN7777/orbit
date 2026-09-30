/**
 * views/website.js — Website updates.
 *
 * Left: the planned updates list. Right: the selected update's raw body in a
 * monospace pane, a toggle to the rendered preview (own minimal markdown renderer),
 * target_path, and Plan new / Apply / Reject.
 */
import { endpoints, listOf, totalOf, unwrap } from '../api.js';
import {
  html,
  trust,
  setHtml,
  panel,
  delegate,
  emptyState,
  statusBadge,
  relativeTime,
  formatDateTime,
  toastOk,
  toastErr,
  withBusy,
} from '../ui.js';
import { icon } from '../icons.js';
import { renderMarkdown } from '../markdown.js';
import { activity } from '../activity.js';

const KINDS = ['insight', 'service_page', 'case_note'];

export async function mount(root, ctx) {
  const state = {
    items: [],
    total: 0,
    update: null,
    mode: 'body',
    applyResult: null,
    planOpen: false,
    planSlug: '',
    planKind: 'insight',
  };

  root.classList.add('view-fill');
  setHtml(root, html`
    <div class="view-head">
      <span class="count muted small" id="website-count"></span>
      <span class="head-spacer"></span>
      <button type="button" class="btn btn-sm btn-primary" data-action="toggle-plan">${icon('file', 14)}<span class="btn-label">Plan new</span></button>
      <button type="button" class="btn btn-sm btn-ghost" data-action="reload-updates">${icon('refresh', 14)}<span class="btn-label">Reload</span></button>
    </div>

    <div id="plan-holder"></div>

    <div class="grid-side" style="flex: 1 1 auto; min-height: 0; align-items: stretch">
      <section class="panel" style="min-height: 0">
        <div class="panel-head">
          <h3>Planned updates</h3>
          <span class="spacer"></span>
          <span class="count" id="updates-total"></span>
        </div>
        <div class="panel-body tight scroll" id="updates-panel" style="max-height: 70vh"></div>
      </section>

      <section class="panel" style="min-height: 0">
        <div class="panel-head">
          <h3>Update detail</h3>
          <span class="spacer"></span>
          <div class="tabs" role="tablist" aria-label="Detail mode">
            <button type="button" class="tab active" data-mode="body" role="tab">Raw</button>
            <button type="button" class="tab" data-mode="preview" role="tab">Preview</button>
          </div>
        </div>
        <div class="panel-body scroll" id="detail-panel" style="overflow: auto"></div>
      </section>
    </div>
  `);

  const updatesPanel = root.querySelector('#updates-panel');
  const detailPanel = root.querySelector('#detail-panel');
  const countEl = root.querySelector('#website-count');
  const totalEl = root.querySelector('#updates-total');

  /* ------------------------------------------------------------ list */

  async function loadUpdates(preferredId) {
    await panel(updatesPanel, async () => {
      const res = await endpoints.websiteUpdates({ limit: 100 });
      const items = listOf(res);
      state.items = items;
      state.total = totalOf(res, items);
      if (countEl) countEl.textContent = state.total + (state.total === 1 ? ' update' : ' updates');
      if (totalEl) totalEl.textContent = items.length + ' listed';

      if (!items.length) {
        return emptyState({
          icon: 'file',
          title: 'No website updates planned',
          message: 'Plan one from a topic slug to draft an insight, service page or case note.',
          action: 'toggle-plan',
          actionLabel: 'Plan new',
        });
      }

      const wanted = preferredId !== undefined && preferredId !== null ? String(preferredId) : '';
      const current = state.update && state.update.id !== undefined ? String(state.update.id) : wanted;
      return html`<div class="picker">
        ${items.map((u) => {
          const id = u && u.id !== undefined ? String(u.id) : '';
          return html`<button type="button" class="picker-item ${id === current ? 'active' : ''}" data-action="pick-update" data-update-id="${id}">
            <span class="pi-title">${(u && u.title) || '(untitled)'}</span>
            <span class="pi-sub">${(u && u.slug) || '—'}${u && u.status ? ' · ' + u.status : ''} · ${relativeTime(u && u.created_at)}</span>
          </button>`;
        })}
      </div>`;
    }, { retryAction: 'reload-updates', errorTitle: "Couldn't load website updates", skeletonRows: 6 });

    const wanted = preferredId !== undefined && preferredId !== null ? String(preferredId) : '';
    if (wanted && (!state.update || String(state.update.id) !== wanted)) {
      selectUpdate(wanted);
    } else if (!state.update && state.items.length) {
      selectUpdate(String(state.items[0].id));
    } else if (!state.items.length) {
      renderDetail();
    }
  }

  /* ------------------------------------------------------------ detail */

  function selectUpdate(id) {
    const known = state.items.find((u) => u && String(u.id) === String(id));
    if (known) {
      state.update = known;
      state.applyResult = null;
      markActive(id);
      renderDetail();
      return;
    }
    // Not in the cached list (deep link, or a freshly planned update): refetch once.
    panel(detailPanel, async () => {
      const res = await endpoints.websiteUpdates({});
      const found = listOf(res).find((u) => u && String(u.id) === String(id));
      if (!found) throw new Error('Update ' + id + ' was not in GET /api/website/updates.');
      state.update = found;
      state.applyResult = null;
      markActive(id);
      return detailMarkup();
    }, { retryAction: 'retry-update', errorTitle: "Couldn't load this update", skeletonRows: 5 });
  }

  function markActive(id) {
    for (const item of root.querySelectorAll('.picker-item')) {
      item.classList.toggle('active', item.getAttribute('data-update-id') === String(id));
    }
  }

  function detailMarkup() {
    const u = state.update;
    if (!u) {
      return emptyState({
        icon: 'file',
        title: 'No update selected',
        message: 'Pick an update on the left, or plan a new one.',
        action: 'toggle-plan',
        actionLabel: 'Plan new',
      });
    }

    const body = typeof u.body === 'string' ? u.body : '';
    const applied = state.applyResult;
    const written = applied && Array.isArray(applied.written) ? applied.written : [];

    return html`
      <div class="row mb">
        <div style="min-width: 0">
          <div class="table-primary">${u.title || '(untitled)'}</div>
          <div class="table-sub mono">${u.slug || '—'} · ${u.status || 'unknown'} · created ${formatDateTime(u.created_at)}</div>
        </div>
        <span class="spacer"></span>
        ${statusBadge(u.status || 'planned')}
      </div>

      <div class="kv mb">
        <span><span class="k">target_path</span> <span class="v mono">${u.target_path || '—'}</span></span>
        <span><span class="k">topic_slug</span> <span class="v mono">${u.topic_slug || '—'}</span></span>
        ${u.applied_at ? html`<span><span class="k">applied_at</span> <span class="v">${formatDateTime(u.applied_at)}</span></span>` : ''}
      </div>

      ${u.summary ? html`<div class="context-box"><span class="k">Summary</span><span class="v">${u.summary}</span></div>` : ''}

      <div class="row mb">
        <button type="button" class="btn btn-sm btn-primary" data-action="apply-update">${icon('send', 13)}<span class="btn-label">Apply</span></button>
        <button type="button" class="btn btn-sm btn-danger" data-action="reject-update">${icon('close', 13)}<span class="btn-label">Reject</span></button>
        <span class="spacer"></span>
        <span class="small muted">${body.length} characters</span>
      </div>

      ${applied
        ? html`<div class="notice mb">
            <div><b>Apply result:</b> ${applied.status || 'applied'}</div>
            ${written.length ? html`<div class="mt">written files: <span class="mono">${written.join(', ')}</span></div>` : ''}
            ${applied.commit ? html`<div>commit: <span class="mono">${applied.commit}</span></div>` : ''}
            ${applied.preview_url ? html`<div>preview: <a href="${/^https?:\/\//i.test(applied.preview_url) ? applied.preview_url : '#'}" target="_blank" rel="noopener">${applied.preview_url}</a></div>` : ''}
          </div>`
        : ''}

      ${state.mode === 'preview'
        ? html`<div class="md">${body ? renderMarkdown(body) : html`<span class="muted">(empty body)</span>`}</div>`
        : html`<div class="body-pane">${body || '(empty body)'}</div>`}
    `;
  }

  function renderDetail() {
    setHtml(detailPanel, detailMarkup());
  }

  /* ------------------------------------------------------------ actions */

  async function planNew(button) {
    const slugInput = root.querySelector('#plan-slug');
    const kindSelect = root.querySelector('#plan-kind');
    const slug = slugInput ? slugInput.value.trim() : state.planSlug;
    const kind = kindSelect ? kindSelect.value : state.planKind;
    if (!slug) {
      toastErr('Enter a topic slug first.');
      if (slugInput) slugInput.focus();
      return;
    }
    state.planSlug = slug;
    state.planKind = kind;
    await withBusy(button, 'Planning…', async () => {
      try {
        const res = await endpoints.websitePlan(slug, kind);
        const update = unwrap(res, ['update']);
        toastOk('Update planned');
        state.planOpen = false;
        renderPlanForm();
        if (update && update.id !== undefined) {
          state.update = update;
          await loadUpdates(update.id);
          renderDetail();
        } else {
          await loadUpdates();
        }
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Planning failed');
      }
    });
  }

  async function applyUpdate(button) {
    const u = state.update;
    if (!u) return;
    await withBusy(button, 'Applying…', async () => {
      try {
        const res = await endpoints.websiteApply(u.id);
        state.applyResult = res && typeof res === 'object' ? res : { status: 'applied' };
        const written = Array.isArray(state.applyResult.written) ? state.applyResult.written : [];
        activity.log('website update ' + u.id + ' applied' + (written.length ? ' → ' + written.join(', ') : ''));
        toastOk('Applied' + (written.length ? ' — ' + written.length + ' file' + (written.length === 1 ? '' : 's') + ' written' : ''));
        state.update = Object.assign({}, u, { status: state.applyResult.status || 'applied' });
        renderDetail();
        loadUpdates(u.id);
        markActive(u.id);
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Apply failed');
      }
    });
  }

  async function rejectUpdate(button) {
    const u = state.update;
    if (!u) return;
    if (!window.confirm('Reject “' + (u.title || 'this update') + '”?')) return;
    await withBusy(button, 'Rejecting…', async () => {
      try {
        await endpoints.websiteReject(u.id);
        toastOk('Update rejected');
        state.update = Object.assign({}, u, { status: 'rejected' });
        renderDetail();
        loadUpdates(u.id);
        markActive(u.id);
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Reject failed');
      }
    });
  }

  /* ------------------------------------------------------------ wiring */

  const offClick = delegate(root, 'click', '[data-action]', (event, el) => {
    const action = el.getAttribute('data-action');
    if (action === 'reload-updates') { loadUpdates(state.update ? state.update.id : undefined); return; }
    if (action === 'retry-update') {
      if (state.update) selectUpdate(state.update.id);
      return;
    }
    if (action === 'toggle-plan') {
      state.planOpen = !state.planOpen;
      renderPlanForm();
      if (state.planOpen) {
        const input = root.querySelector('#plan-slug');
        if (input) input.focus();
      }
      return;
    }
    if (action === 'cancel-plan') {
      state.planOpen = false;
      renderPlanForm();
      return;
    }
    if (action === 'confirm-plan') { planNew(el); return; }
    if (action === 'pick-update') {
      const id = el.getAttribute('data-update-id');
      if (!id) return;
      selectUpdate(id);
      return;
    }
    if (action === 'apply-update') { applyUpdate(el); return; }
    if (action === 'reject-update') { rejectUpdate(el); }
  });
  ctx.onDestroy(offClick);

  const offMode = delegate(root, 'click', '.tab[data-mode]', (event, el) => {
    state.mode = el.getAttribute('data-mode') === 'preview' ? 'preview' : 'body';
    for (const tab of root.querySelectorAll('.tab[data-mode]')) tab.classList.toggle('active', tab === el);
    renderDetail();
  });
  ctx.onDestroy(offMode);

  function planFormMarkup() {
    if (!state.planOpen) return '';
    return html`<div class="notice" style="border-left-color: var(--accent)">
      <div class="inline-form">
        <div class="field">
          <label for="plan-slug">Topic slug</label>
          <input class="input" id="plan-slug" value="${state.planSlug}" placeholder="revfadp-subcontractor-access-logging" />
        </div>
        <div class="field">
          <label for="plan-kind">Kind</label>
          <select class="select" id="plan-kind">
            ${KINDS.map((k) => html`<option value="${k}" ${k === state.planKind ? trust('selected') : null}>${k.replace(/_/g, ' ')}</option>`)}
          </select>
        </div>
        <button type="button" class="btn btn-sm btn-primary" data-action="confirm-plan">${icon('file', 13)}<span class="btn-label">Plan</span></button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="cancel-plan">Cancel</button>
      </div>
    </div>`;
  }

  /* The plan form sits above the split so it is visible from both panes. */
  const planHolder = root.querySelector('#plan-holder');
  function renderPlanForm() {
    setHtml(planHolder, planFormMarkup());
  }

  const params = ctx.params || {};
  activity.log('website: loading updates');
  renderPlanForm();
  await loadUpdates(params.id);
}

export default { mount };
