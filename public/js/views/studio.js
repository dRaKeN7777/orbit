/**
 * views/studio.js — AI Content & Comment Studio (the centre of the app).
 *
 * Left: draft picker + the source CEO post with "Open on LinkedIn".
 * Right: inbound post (editable, with the LinkedIn 210-character fold preview),
 * peer comment (editable), and the verification panel — lint chips, headline score
 * and the Save / Verify / Regenerate / Schedule actions.
 *
 * Hard gate: Schedule is disabled whenever `lint.passed` is false, with a title
 * explaining why.
 */
import { endpoints, listOf, unwrap } from '../api.js';
import {
  html,
  trust,
  setHtml,
  panel,
  delegate,
  emptyState,
  regionBadge,
  statusBadge,
  scoreRing,
  lintChips,
  relativeTime,
  formatDateTime,
  fmtNum,
  truncate,
  toastOk,
  toastErr,
  withBusy,
  copyToClipboard,
  localInputToIso,
  isoToLocalInput,
} from '../ui.js';
import { icon } from '../icons.js';
import { activity } from '../activity.js';

const FOLD_AT = 210;
const CHANNEL = 'linkedin_company';

export async function mount(root, ctx) {
  const state = {
    drafts: [],
    draft: null,
    post: null,
    postLookupFailed: false,
    inbound: '',
    peer: '',
    scheduleOpen: false,
    scheduleAt: isoToLocalInput(null, 60),
    scheduled: null,
    regenOpen: false,
    feedback: '',
  };

  root.classList.add('view-fill');
  setHtml(root, html`
    <div class="split">
      <div class="split-left">
        <section class="panel">
          <div class="panel-head">
            <h3>Drafts</h3>
            <span class="spacer"></span>
            <span class="count" id="drafts-count"></span>
            <button type="button" class="btn btn-xs btn-ghost" data-action="reload-drafts" title="Reload drafts">${icon('refresh', 12)}</button>
          </div>
          <div class="panel-body tight" id="draft-picker"></div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h3>Source post</h3>
            <span class="spacer"></span>
            <span class="count" id="source-when"></span>
          </div>
          <div class="panel-body" id="source-panel"></div>
        </section>
      </div>

      <div class="split-right" id="studio-right"></div>
    </div>
  `);

  const pickerEl = root.querySelector('#draft-picker');
  const draftsCountEl = root.querySelector('#drafts-count');
  const sourceEl = root.querySelector('#source-panel');
  const sourceWhenEl = root.querySelector('#source-when');
  const rightEl = root.querySelector('#studio-right');

  /* ------------------------------------------------------------ drafts list */

  async function loadDrafts(preferredId) {
    await panel(pickerEl, async () => {
      const res = await endpoints.drafts({ limit: 50 });
      const items = listOf(res);
      state.drafts = items;
      if (draftsCountEl) draftsCountEl.textContent = items.length + (items.length === 1 ? ' draft' : ' drafts');

      if (!items.length) {
        return emptyState({
          icon: 'inbox',
          title: 'No drafts yet',
          message: 'Open the Radar and press Draft on a post to generate the first one.',
          action: 'goto-radar',
          actionLabel: 'Go to Radar',
        });
      }

      const wanted = preferredId !== undefined && preferredId !== null ? String(preferredId) : '';
      const current = state.draft && state.draft.id !== undefined ? String(state.draft.id) : wanted;
      return html`<div class="picker">
        ${items.map((d) => {
          const id = d && d.id !== undefined ? String(d.id) : '';
          const active = id && id === current;
          const text = truncate(d && d.inbound_post ? d.inbound_post : '(empty draft)', 90);
          const score = d && d.lint && typeof d.lint.score === 'number' ? d.lint.score : null;
          return html`<button type="button" class="picker-item ${active ? 'active' : ''}" data-action="pick-draft" data-draft-id="${id}">
            <span class="pi-title">${text}</span>
            <span class="pi-sub">${(d && d.target_name) || 'unknown target'}${d && d.region ? ' · ' + d.region : ''}${score === null ? '' : ' · score ' + score}${d && d.status ? ' · ' + d.status : ''}</span>
          </button>`;
        })}
      </div>`;
    }, { retryAction: 'reload-drafts', errorTitle: "Couldn't load drafts", skeletonRows: 6 });

    if (!state.draft) {
      const wanted = preferredId !== undefined && preferredId !== null ? String(preferredId) : '';
      const first = wanted && state.drafts.some((d) => String(d && d.id) === wanted)
        ? wanted
        : state.drafts.length
          ? String(state.drafts[0].id)
          : null;
      if (first) selectDraft(first);
      else renderRight();
    }
  }

  /* ------------------------------------------------------------ single draft */

  async function selectDraft(id) {
    await panel(rightEl, async () => {
      const res = await endpoints.draft(id);
      const draft = unwrap(res, ['draft']);
      if (!draft || draft.id === undefined) throw new Error('The API did not return a draft for id ' + id);
      state.draft = draft;
      state.inbound = typeof draft.inbound_post === 'string' ? draft.inbound_post : '';
      state.peer = typeof draft.peer_comment === 'string' ? draft.peer_comment : '';
      state.post = null;
      state.postLookupFailed = false;
      state.scheduleOpen = false;
      state.regenOpen = false;
      state.scheduled = null;
      return rightMarkup();
    }, { retryAction: 'retry-draft', errorTitle: "Couldn't load this draft", skeletonRows: 6 });

    if (state.draft && String(state.draft.id) === String(id)) {
      markActivePicker(id);
      updateFold();
      wireEditors();
      mountVisualPanel();
      loadSourcePost(state.draft);
    }
  }

  function markActivePicker(id) {
    for (const item of root.querySelectorAll('.picker-item')) {
      item.classList.toggle('active', item.getAttribute('data-draft-id') === String(id));
    }
  }

  async function loadSourcePost(draft) {
    // The draft response may already carry the source post inline (`draft.post`);
    // otherwise fall back to GET /api/posts?target_id=.
    const embedded = draft && draft.post && typeof draft.post === 'object' ? draft.post : null;
    if (embedded) {
      state.post = embedded;
      state.postLookupFailed = false;
      renderSource();
      return;
    }
    if (!draft || draft.target_id === undefined || draft.target_id === null) {
      state.postLookupFailed = true;
      renderSource();
      return;
    }
    await panel(sourceEl, async () => {
      const res = await endpoints.posts({ target_id: draft.target_id, limit: 100 });
      const items = listOf(res);
      state.post = items.find((p) => p && String(p.id) === String(draft.post_id)) || null;
      state.postLookupFailed = !state.post;
      return sourceMarkup();
    }, { retryAction: 'retry-source', errorTitle: "Couldn't load the source post", skeletonRows: 4 });
  }

  /* ------------------------------------------------------------ left: source */

  function sourceMarkup() {
    const draft = state.draft || {};
    if (sourceWhenEl) {
      sourceWhenEl.textContent = state.post && state.post.posted_at ? relativeTime(state.post.posted_at) : '';
    }

    const url = state.post && typeof state.post.url === 'string' && /^https?:\/\//i.test(state.post.url)
      ? state.post.url
      : null;

    const header = html`
      <div class="row mb">
        <span class="table-primary">${draft.target_name || 'Unknown executive'}</span>
        ${draft.company ? html`<span class="muted small">${draft.company}</span>` : ''}
        ${regionBadge(draft.region)}
        <span class="spacer"></span>
        ${url
          ? html`<a class="btn btn-sm" href="${url}" target="_blank" rel="noopener">${icon('external', 13)}Open on LinkedIn</a>`
          : html`<span class="btn btn-sm" aria-disabled="true" title="No post URL was returned by the API for this draft">${icon('external', 13)}No LinkedIn URL</span>`}
      </div>`;

    if (!state.post) {
      return html`${header}
        <div class="notice">
          ${state.postLookupFailed
            ? 'The original post (id ' + (draft.post_id === undefined ? '—' : draft.post_id) + ') was not present in GET /api/posts for this target. Showing the draft context instead.'
            : 'Loading the original post…'}
        </div>
        <div class="mt">
          <div class="context-box"><span class="k">Detected pain point</span><span class="v">${draft.detected_pain_point || '—'}</span></div>
          <div class="context-box"><span class="k">Angle</span><span class="v">${draft.angle || '—'}</span></div>
        </div>`;
    }

    const p = state.post;
    const topics = Array.isArray(p.topics) ? p.topics.filter((t) => typeof t === 'string' && t) : [];
    return html`${header}
      <p class="post-text">${p.content_text || '(no text captured)'}</p>
      ${topics.length ? html`<div class="chips">${topics.map((t) => html`<span class="chip chip-topic">${t}</span>`)}</div>` : ''}
      <div class="post-foot">
        <span class="metric" title="Reactions">${icon('reaction', 13)}${fmtNum(p.reactions)}</span>
        <span class="metric" title="Comments">${icon('comment', 13)}${fmtNum(p.comments)}</span>
        <span class="metric" title="Shares">${icon('share', 13)}${fmtNum(p.shares)}</span>
        <span class="metric" title="${formatDateTime(p.posted_at)}">${relativeTime(p.posted_at)}</span>
      </div>`;
  }

  function renderSource() {
    setHtml(sourceEl, sourceMarkup());
  }

  /* ------------------------------------------------------------ right panel */

  function rightMarkup() {
    const draft = state.draft;
    if (!draft) {
      return emptyState({
        icon: 'inbox',
        title: 'No draft selected',
        message: 'Pick a draft on the left, or generate one from the Radar.',
        action: 'goto-radar',
        actionLabel: 'Go to Radar',
      });
    }

    const lint = draft.lint && typeof draft.lint === 'object' ? draft.lint : null;
    const passed = !!(lint && lint.passed === true);
    const metrics = lint && lint.metrics && typeof lint.metrics === 'object' ? lint.metrics : null;
    const scheduleTitle = passed
      ? 'Pick a time and schedule this draft to ' + CHANNEL
      : 'Blocked: this draft failed verification (lint.passed is false), so it cannot be scheduled. Fix the hard violations and press Verify.';
    const inboundLen = String(state.inbound || '').length;
    const peerLen = String(state.peer || '').length;

    return html`
      <section class="panel">
        <div class="panel-head">
          <h3>Verification &amp; actions</h3>
          <span class="spacer"></span>
          ${statusBadge(draft.status || 'unknown')}
          <span class="score-label">lint</span>
          ${scoreRing(lint ? lint.score : null)}
        </div>
        <div class="panel-body">
          <div class="row mb">
            <span class="small muted">${passed ? html`${icon('check', 13)} verification passed` : html`<span style="color: var(--red)">verification failed — scheduling and publishing are blocked</span>`}</span>
            <span class="spacer"></span>
            <span class="small muted">id ${draft.id}${draft.generator ? ' · ' + draft.generator : ''}${draft.source ? ' · ' + draft.source : ''}</span>
          </div>

          <div class="chips mb">${lintChips(lint)}</div>

          ${metrics
            ? html`<div class="kv mb">
                <span><span class="k">words</span> <span class="v">${metrics.words === undefined ? '—' : metrics.words}</span></span>
                <span><span class="k">sentences</span> <span class="v">${metrics.sentences === undefined ? '—' : metrics.sentences}</span></span>
                <span><span class="k">stdev sentence len</span> <span class="v">${metrics.stdev_sentence_len === undefined ? '—' : metrics.stdev_sentence_len}</span></span>
                <span><span class="k">specificity</span> <span class="v">${metrics.specificity === undefined ? '—' : metrics.specificity}</span></span>
              </div>`
            : ''}

          <div class="btn-row">
            <button type="button" class="btn btn-sm btn-primary" data-action="save-draft">${icon('check', 13)}<span class="btn-label">Save</span></button>
            <button type="button" class="btn btn-sm" data-action="verify-draft">${icon('refresh', 13)}<span class="btn-label">Verify</span></button>
            <button type="button" class="btn btn-sm" data-action="toggle-regen">${icon('bolt', 13)}<span class="btn-label">Regenerate</span></button>
            <button type="button" class="btn btn-sm" data-action="toggle-schedule"
              ${passed ? null : trust('disabled')} title="${scheduleTitle}" aria-disabled="${passed ? 'false' : 'true'}">${icon('calendar', 13)}<span class="btn-label">Schedule</span></button>
            <span class="spacer"></span>
            <span class="small muted">${state.scheduled ? 'scheduled #' + state.scheduled.id : ''}</span>
          </div>

          ${state.regenOpen
            ? html`<div class="mt">
                <div class="field">
                  <label for="regen-feedback">Feedback for the regenerator</label>
                  <textarea class="textarea" id="regen-feedback" style="min-height: 74px" placeholder="e.g. too abstract — add the audit-plane detail">${state.feedback}</textarea>
                </div>
                <div class="btn-row">
                  <button type="button" class="btn btn-sm btn-primary" data-action="confirm-regen">${icon('bolt', 13)}<span class="btn-label">Regenerate draft</span></button>
                  <button type="button" class="btn btn-sm btn-ghost" data-action="cancel-regen">Cancel</button>
                  <span class="small muted">Creates a new draft version on this same post.</span>
                </div>
              </div>`
            : ''}

          ${state.scheduleOpen
            ? html`<div class="mt">
                <div class="inline-form">
                  <div class="field">
                    <label for="sched-at">Publish at</label>
                    <input type="datetime-local" class="input" id="sched-at" value="${state.scheduleAt}" />
                  </div>
                  <div class="field">
                    <label for="sched-channel">Channel</label>
                    <input class="input" id="sched-channel" value="${CHANNEL}" readonly />
                  </div>
                  <button type="button" class="btn btn-sm btn-primary" data-action="confirm-schedule">${icon('send', 13)}<span class="btn-label">Confirm schedule</span></button>
                  <button type="button" class="btn btn-sm btn-ghost" data-action="cancel-schedule">Cancel</button>
                </div>
                <div class="small muted mt">Times are entered in your local timezone and sent as RFC3339 UTC.</div>
              </div>`
            : ''}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h3>Inbound Post</h3>
          <span class="spacer"></span>
          <span class="small muted counter ${inboundLen > FOLD_AT ? 'counter-over' : ''}" id="inbound-counter">${inboundLen} chars</span>
          <button type="button" class="btn btn-xs" data-action="copy-inbound">${icon('copy', 12)}Copy</button>
          <button type="button" class="btn btn-xs btn-primary" data-action="compose-linkedin" title="Opens LinkedIn's composer with this post filled in">${icon('external', 12)}Post to LinkedIn</button>
        </div>
        <div class="panel-body">
          <div class="context-box">
            <span class="k">Detected pain point</span>
            <span class="v">${draft.detected_pain_point || '—'}</span>
          </div>
          <div class="context-box">
            <span class="k">Angle</span>
            <span class="v">${draft.angle || '—'}</span>
          </div>
          <textarea class="textarea" id="inbound-text" spellcheck="true" aria-label="Inbound post text">${state.inbound}</textarea>
          <div id="fold-region"></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h3>Peer Comment</h3>
          <span class="spacer"></span>
          <span class="small muted counter" id="peer-counter">${peerLen} chars</span>
          <button type="button" class="btn btn-xs" data-action="copy-peer">${icon('copy', 12)}Copy</button>
        </div>
        <div class="panel-body">
          <textarea class="textarea" id="peer-text" style="min-height: 110px" spellcheck="true" aria-label="Peer comment text">${state.peer}</textarea>
          <div class="small muted mt">Short, specific and additive: this is the comment left under the executive's post.</div>
        </div>
      </section>
    `;
  }

  function renderRight() {
    setHtml(rightEl, rightMarkup());
    updateFold();
    wireEditors();
    mountVisualPanel();
  }

  /**
   * The schematic that publishes with this post. It is generated server-side
   * from the copy, so it always matches what the post actually says.
   */
  function mountVisualPanel() {
    const draft = state.draft;
    if (!draft || !draft.id) return;

    // renderRight() and selectDraft() can both reach here; only ever one panel.
    const existing = rightEl.querySelector('#visual-panel');
    if (existing) {
      if (existing.getAttribute('data-draft-id') === String(draft.id)) return;
      existing.remove();
    }

    const section = document.createElement('section');
    section.className = 'panel';
    section.id = 'visual-panel';
    section.setAttribute('data-draft-id', String(draft.id));
    setHtml(section, html`
      <div class="panel-head">
        <h3>Visual</h3>
        <span class="spacer"></span>
        <span class="count">PNG 2400 × 1350</span>
        <a class="btn btn-xs btn-primary" href="/api/drafts/${draft.id}/diagram.png"
           download="orbit-draft-${draft.id}.png">Download PNG</a>
        <a class="btn btn-xs btn-ghost" href="/api/drafts/${draft.id}/diagram.svg"
           target="_blank" rel="noopener">SVG</a>
      </div>
      <div class="panel-body">
        <img class="diagram-preview" src="/api/drafts/${draft.id}/diagram.svg"
             alt="Diagram that publishes with this post" loading="lazy" />
        <p class="help">Attached automatically on publish. PNG is the format LinkedIn accepts; the SVG is for your website.</p>
      </div>
    `);
    rightEl.appendChild(section);
  }

  /* ------------------------------------------------------------ fold preview */

  function updateFold() {
    const region = root.querySelector('#fold-region');
    if (!region) return;
    const text = String(state.inbound || '');
    const len = text.length;
    const hidden = Math.max(0, len - FOLD_AT);
    const overflow = len > FOLD_AT;
    setHtml(region, html`
      <div class="fold">${overflow ? html`${text.slice(0, FOLD_AT)}<span class="fold-more">…see more</span>` : text}</div>
      <div class="fold-note">
        <span class="counter ${overflow ? 'counter-over' : ''}">${len} / ${FOLD_AT} characters</span>
        <span>${overflow
          ? html`fold lands at character ${FOLD_AT} — <span class="over">${hidden} character${hidden === 1 ? '' : 's'} hidden behind “see more”</span>`
          : html`no fold — the whole post shows above “see more”`}</span>
      </div>
    `);
    const counter = root.querySelector('#inbound-counter');
    if (counter) {
      counter.textContent = len + ' chars';
      counter.classList.toggle('counter-over', overflow);
    }
  }

  function wireEditors() {
    const inbound = root.querySelector('#inbound-text');
    const peer = root.querySelector('#peer-text');
    if (inbound) {
      inbound.addEventListener('input', () => {
        state.inbound = inbound.value;
        updateFold();
      });
    }
    if (peer) {
      peer.addEventListener('input', () => {
        state.peer = peer.value;
        const counter = root.querySelector('#peer-counter');
        if (counter) counter.textContent = peer.value.length + ' chars';
      });
    }
  }

  function syncBuffers() {
    const inbound = root.querySelector('#inbound-text');
    const peer = root.querySelector('#peer-text');
    const feedback = root.querySelector('#regen-feedback');
    const at = root.querySelector('#sched-at');
    if (inbound) state.inbound = inbound.value;
    if (peer) state.peer = peer.value;
    if (feedback) state.feedback = feedback.value;
    if (at && at.value) state.scheduleAt = at.value;
  }

  /* ------------------------------------------------------------ actions */

  async function saveDraft(button) {
    const draft = state.draft;
    if (!draft) return;
    syncBuffers();
    await withBusy(button, 'Saving…', async () => {
      try {
        const res = await endpoints.patchDraft(draft.id, {
          inbound_post: state.inbound,
          peer_comment: state.peer,
        });
        const refreshed = unwrap(res, ['draft']);
        if (refreshed && refreshed.id !== undefined) {
          state.draft = refreshed;
          state.inbound = typeof refreshed.inbound_post === 'string' ? refreshed.inbound_post : state.inbound;
          state.peer = typeof refreshed.peer_comment === 'string' ? refreshed.peer_comment : state.peer;
        } else if (res && res.lint) {
          state.draft = Object.assign({}, draft, { lint: res.lint });
        }
        renderRight();
        refreshPickerLabels();
        const score = state.draft && state.draft.lint ? state.draft.lint.score : null;
        toastOk('Saved' + (score === null || score === undefined ? '' : ' — lint score ' + score));
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Save failed');
      }
    });
  }

  async function verifyDraft(button) {
    const draft = state.draft;
    if (!draft) return;
    syncBuffers();
    await withBusy(button, 'Verifying…', async () => {
      try {
        const res = await endpoints.verifyDraft(draft.id);
        const lint = res && res.lint ? res.lint : null;
        if (lint) {
          state.draft = Object.assign({}, draft, { lint });
          renderRight();
          toastOk('Verified — score ' + (lint.score === undefined ? '—' : lint.score) + (lint.passed ? ' (passed)' : ' (failed)'));
        } else {
          toastOk('Verification finished');
        }
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Verification failed');
      }
    });
  }

  async function regenerate(button) {
    const draft = state.draft;
    if (!draft) return;
    syncBuffers();
    await withBusy(button, 'Regenerating…', async () => {
      try {
        const res = await endpoints.regenerateDraft(draft.id, state.feedback);
        const next = unwrap(res, ['draft']);
        state.regenOpen = false;
        state.feedback = '';
        toastOk('Regenerated — new version created');
        if (next && next.id !== undefined) {
          state.draft = next;
          state.inbound = typeof next.inbound_post === 'string' ? next.inbound_post : '';
          state.peer = typeof next.peer_comment === 'string' ? next.peer_comment : '';
          renderRight();
          await loadDrafts(next.id);
          loadSourcePost(next);
        } else {
          await loadDrafts();
        }
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Regeneration failed');
      }
    });
  }

  async function confirmSchedule(button) {
    const draft = state.draft;
    if (!draft) return;
    const lint = draft.lint || {};
    if (lint.passed !== true) {
      toastErr('This draft failed verification and cannot be scheduled.');
      return;
    }
    syncBuffers();
    const iso = localInputToIso(state.scheduleAt);
    if (!iso) {
      toastErr('Pick a valid publish time first.');
      return;
    }
    await withBusy(button, 'Scheduling…', async () => {
      try {
        const res = await endpoints.scheduleDraft(draft.id, iso, CHANNEL);
        const schedule = res && res.schedule ? res.schedule : null;
        state.scheduled = schedule;
        state.scheduleOpen = false;
        renderRight();
        toastOk('Draft scheduled for ' + formatDateTime(iso) + ' (' + CHANNEL + ')');
        activity.log('draft ' + draft.id + ' scheduled at ' + iso);
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Scheduling failed');
      }
    });
  }

  function refreshPickerLabels() {
    const draft = state.draft;
    if (!draft) return;
    for (const item of root.querySelectorAll('.picker-item')) {
      if (item.getAttribute('data-draft-id') !== String(draft.id)) continue;
      const title = item.querySelector('.pi-title');
      if (title) title.textContent = truncate(state.inbound, 90);
      const score = draft.lint && typeof draft.lint.score === 'number' ? draft.lint.score : null;
      const sub = item.querySelector('.pi-sub');
      if (sub && score !== null) {
        sub.textContent = (draft.target_name || 'unknown target') + (draft.region ? ' · ' + draft.region : '') + ' · score ' + score + (draft.status ? ' · ' + draft.status : '');
      }
    }
  }

  /* ------------------------------------------------------------ wiring */

  const offClick = delegate(root, 'click', '[data-action]', (event, el) => {
    const action = el.getAttribute('data-action');
    if (action === 'reload-drafts') { loadDrafts(); return; }
    if (action === 'retry-draft') {
      if (state.draft) selectDraft(state.draft.id);
      return;
    }
    if (action === 'retry-source') {
      if (state.draft) loadSourcePost(state.draft);
      return;
    }
    if (action === 'goto-radar') { ctx.navigate('#radar'); return; }
    if (action === 'pick-draft') {
      const id = el.getAttribute('data-draft-id');
      if (!id) return;
      selectDraft(id);
      return;
    }
    if (action === 'save-draft') { saveDraft(el); return; }
    if (action === 'verify-draft') { verifyDraft(el); return; }
    if (action === 'toggle-regen') {
      syncBuffers();
      state.regenOpen = !state.regenOpen;
      renderRight();
      const box = root.querySelector('#regen-feedback');
      if (box) box.focus();
      return;
    }
    if (action === 'cancel-regen') {
      syncBuffers();
      state.regenOpen = false;
      renderRight();
      return;
    }
    if (action === 'confirm-regen') { regenerate(el); return; }
    if (action === 'toggle-schedule') {
      const draft = state.draft;
      const passed = draft && draft.lint && draft.lint.passed === true;
      if (!passed) {
        toastErr('This draft failed verification and cannot be scheduled until it passes.');
        return;
      }
      syncBuffers();
      state.scheduleOpen = !state.scheduleOpen;
      renderRight();
      return;
    }
    if (action === 'cancel-schedule') {
      state.scheduleOpen = false;
      renderRight();
      return;
    }
    if (action === 'confirm-schedule') { confirmSchedule(el); return; }
    if (action === 'copy-inbound') {
      syncBuffers();
      copyToClipboard(state.inbound).then((ok) => (ok ? toastOk('Inbound post copied') : toastErr('Copy failed — select the text manually.')));
      return;
    }
    if (action === 'compose-linkedin') {
      syncBuffers();
      const text = String(state.inbound || '').trim();
      if (!text) {
        toastErr('Nothing to post yet.');
        return;
      }
      // LinkedIn's own share composer, pre-filled. You review and press Post —
      // nothing is sent on your behalf.
      const url =
        'https://www.linkedin.com/feed/?shareActive=true&text=' + encodeURIComponent(text);
      window.open(url, '_blank', 'noopener');
      toast('LinkedIn composer opened — attach the downloaded PNG, then press Post.', 'info');
      return;
    }
    if (action === 'copy-peer') {
      syncBuffers();
      copyToClipboard(state.peer).then((ok) => (ok ? toastOk('Peer comment copied') : toastErr('Copy failed — select the text manually.')));
    }
  });
  ctx.onDestroy(offClick);

  const onKeydown = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      const btn = root.querySelector('[data-action="save-draft"]');
      if (btn) saveDraft(btn);
    }
  };
  root.addEventListener('keydown', onKeydown);
  ctx.onDestroy(() => root.removeEventListener('keydown', onKeydown));

  const preferred = ctx.params.draft ? String(ctx.params.draft) : '';
  activity.log('studio: loading drafts' + (preferred ? ' (target draft ' + preferred + ')' : ''));
  await loadDrafts(preferred || undefined);
  if (preferred && (!state.draft || String(state.draft.id) !== preferred)) {
    // The requested draft was not in the list response — load it directly.
    selectDraft(preferred);
  }
}

export default { mount };
