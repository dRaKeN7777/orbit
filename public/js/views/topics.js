/**
 * views/topics.js — Topic & Pain-Point Matrix.
 *
 * Cards sorted by mention count, each with a UK/CH split bar, urgency, trend, tags
 * and last-seen time. Clicking a card hands the topic to the Radar's post feed.
 */
import { endpoints, listOf, totalOf } from '../api.js';
import {
  html,
  setHtml,
  panel,
  delegate,
  emptyState,
  urgencyBadge,
  trendIndicator,
  relativeTime,
  formatDateTime,
  fmtNum,
  toastOk,
  toastErr,
  withBusy,
} from '../ui.js';
import { icon } from '../icons.js';
import { activity } from '../activity.js';

const REGIONS = ['ALL', 'UK', 'CH'];

export async function mount(root, ctx) {
  const state = {
    region: 'ALL',
    items: [],
    total: 0,
    days: 14,
  };

  setHtml(root, html`
    <div class="view-head">
      <div class="tabs" role="tablist" aria-label="Region filter">
        ${REGIONS.map((r) => html`<button type="button" class="tab ${r === state.region ? 'active' : ''}" data-region="${r}" role="tab" aria-selected="${r === state.region}">${r === 'ALL' ? 'All' : r}</button>`)}
      </div>
      <span class="count muted small" id="topics-count"></span>
      <span class="head-spacer"></span>
      <label class="row small muted" for="recompute-days">Window</label>
      <input class="input" id="recompute-days" type="number" min="1" max="365" value="14" style="width: 76px" aria-label="Recompute window in days" />
      <span class="muted small">days</span>
      <button type="button" class="btn btn-sm" data-action="recompute">${icon('refresh', 14)}<span class="btn-label">Recompute</span></button>
      <button type="button" class="btn btn-sm btn-ghost" data-action="refresh-topics">${icon('list', 14)}<span class="btn-label">Reload</span></button>
    </div>

    <section class="panel">
      <div class="panel-head">
        <h3>Pain points &amp; topics</h3>
        <span class="spacer"></span>
        <span class="count" id="topics-total"></span>
      </div>
      <div class="panel-body" id="topics-panel"></div>
    </section>
  `);

  const panelEl = root.querySelector('#topics-panel');
  const countEl = root.querySelector('#topics-count');
  const totalEl = root.querySelector('#topics-total');

  function sorted(items) {
    return items.slice().sort((a, b) => {
      const am = Number(a && a.mentions);
      const bm = Number(b && b.mentions);
      return (isFinite(bm) ? bm : 0) - (isFinite(am) ? am : 0);
    });
  }

  function regionBar(regions) {
    const obj = regions && typeof regions === 'object' ? regions : {};
    const uk = Number(obj.UK) || 0;
    const ch = Number(obj.CH) || 0;
    const max = Math.max(uk, ch, 1);
    const row = (label, value, cls) => html`
      <div class="region-bar">
        <span>${label}</span>
        <span class="track"><span class="fill ${cls}" style="width: ${Math.round((value / max) * 100)}%"></span></span>
        <span class="val">${value}</span>
      </div>`;
    return html`<div class="region-bars">${row('UK', uk, '')}${row('CH', ch, 'ch')}</div>`;
  }

  function topicCard(item) {
    const t = item && typeof item === 'object' ? item : {};
    const tags = Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === 'string' && x) : [];
    const slug = t.slug || t.topic || '';
    return html`<article class="topic-card" role="button" tabindex="0" data-action="open-topic" data-topic="${slug}" title="Show the posts behind this topic">
      <div class="topic-top">
        <h4 class="topic-name">${t.topic || 'Untitled topic'}</h4>
        <span class="spacer"></span>
        ${urgencyBadge(t.urgency)}
      </div>
      <div class="topic-meta">
        <span title="Mentions">${icon('list', 13)} ${fmtNum(t.mentions)} mentions</span>
        ${trendIndicator(t.trend)}
        <span title="Last seen">${icon('calendar', 13)} ${relativeTime(t.last_seen)}</span>
      </div>
      ${regionBar(t.regions)}
      ${tags.length ? html`<div class="chips mt">${tags.map((tag) => html`<span class="chip chip-tag">${tag}</span>`)}</div>` : ''}
      <div class="topic-meta small" title="First seen ${formatDateTime(t.first_seen)}">first seen ${relativeTime(t.first_seen)}</div>
    </article>`;
  }

  async function loadTopics() {
    await panel(panelEl, async () => {
      const query = { limit: 100 };
      if (state.region !== 'ALL') query.region = state.region;
      const res = await endpoints.topics(query);
      const items = sorted(listOf(res));
      state.items = items;
      state.total = totalOf(res, items);
      if (countEl) countEl.textContent = state.region === 'ALL' ? 'all regions' : state.region + ' only';
      if (totalEl) totalEl.textContent = state.total + (state.total === 1 ? ' topic' : ' topics');

      if (!items.length) {
        return emptyState({
          icon: 'search',
          title: 'No topics clustered yet',
          message: 'Run Recompute to cluster the last ' + state.days + ' days of captured posts into pain points.',
          action: 'recompute',
          actionLabel: 'Recompute now',
        });
      }
      return html`<div class="cards">${items.map(topicCard)}</div>`;
    }, { retryAction: 'refresh-topics', errorTitle: "Couldn't load the topic matrix", skeletonRows: 6 });
  }

  async function recompute(button) {
    const input = root.querySelector('#recompute-days');
    const parsed = input ? Number(input.value) : 14;
    const days = isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 14;
    state.days = days;
    await withBusy(button, 'Recomputing…', async () => {
      try {
        const res = await endpoints.recomputeTopics(days);
        const count = res && typeof res.topics === 'number' ? res.topics : null;
        toastOk('Recomputed' + (count === null ? '' : ' — ' + count + ' topics') + (res && res.run_id ? ' (' + res.run_id + ')' : ''));
        activity.log('topics recomputed over ' + days + ' days' + (count === null ? '' : ' → ' + count + ' topics'));
        loadTopics();
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Recompute failed');
      }
    });
  }

  const offClick = delegate(root, 'click', '[data-action]', (event, el) => {
    const action = el.getAttribute('data-action');
    if (action === 'refresh-topics') { loadTopics(); return; }
    if (action === 'recompute') { recompute(el); return; }
    if (action === 'open-topic') {
      const topic = el.getAttribute('data-topic');
      if (!topic) { toastErr('This topic has no slug in the API response.'); return; }
      ctx.navigate('#radar?topic=' + encodeURIComponent(topic));
    }
  });
  ctx.onDestroy(offClick);

  const tabOff = delegate(root, 'click', '.tab[data-region]', (event, el) => {
    state.region = el.getAttribute('data-region') || 'ALL';
    for (const tab of root.querySelectorAll('.tab[data-region]')) {
      const active = tab === el;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    loadTopics();
  });
  ctx.onDestroy(tabOff);

  const onKey = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const el = event.target instanceof Element ? event.target.closest('[data-action="open-topic"]') : null;
    if (!el) return;
    event.preventDefault();
    const topic = el.getAttribute('data-topic');
    if (topic) ctx.navigate('#radar?topic=' + encodeURIComponent(topic));
  };
  root.addEventListener('keydown', onKey);
  ctx.onDestroy(() => root.removeEventListener('keydown', onKey));

  activity.log('topics: loading matrix');
  loadTopics();
}

export default { mount };
