/**
 * views/radar.js — Executive Radar.
 *
 * Left: the watched-executive table (region tabs + search).
 * Right: the executive activity feed — unfiltered by default, or filtered to the
 * selected target, or filtered to a topic handed over from the Topics view.
 */
import { endpoints, listOf, totalOf, unwrap } from '../api.js';
import {
  html,
  setHtml,
  panel,
  delegate,
  emptyState,
  urgencyBadge,
  regionBadge,
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
    q: '',
    total: 0,
    targets: [],
    selectedId: null,
    selectedName: '',
    topic: ctx.params.topic ? String(ctx.params.topic) : '',
  };

  setHtml(root, html`
    <div class="view-head">
      <div class="tabs" data-role="region-tabs" role="tablist" aria-label="Region filter">
        ${REGIONS.map((r) => html`<button type="button" class="tab ${r === state.region ? 'active' : ''}" data-region="${r}" role="tab" aria-selected="${r === state.region}">${r === 'ALL' ? 'All' : r}</button>`)}
      </div>
      <div class="search">
        ${icon('search', 14)}
        <input class="input" type="search" id="radar-q" placeholder="Search executives, company, title…" autocomplete="off" aria-label="Search executives" />
      </div>
      <span class="count muted small" id="radar-count"></span>
      <span class="head-spacer"></span>
      <button type="button" class="btn btn-sm" data-action="refresh-radar">${icon('refresh', 14)}<span class="btn-label">Refresh</span></button>
    </div>

    <div class="grid-radar">
      <section class="panel">
        <div class="panel-head">
          <h3>Watched executives</h3>
          <span class="spacer"></span>
          <span class="count" id="target-count"></span>
        </div>
        <div class="panel-body tight scroll" id="targets-panel" style="max-height: 62vh"></div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h3 id="feed-title">Live executive activity feed</h3>
          <span class="spacer"></span>
          <span class="count" id="feed-count"></span>
          <button type="button" class="btn btn-xs btn-ghost hidden" data-action="clear-filter">${icon('close', 12)}Clear filter</button>
        </div>
        <div class="panel-body" id="feed-panel"></div>
      </section>
    </div>
  `);

  const targetsPanel = root.querySelector('#targets-panel');
  const feedPanel = root.querySelector('#feed-panel');
  const feedTitle = root.querySelector('#feed-title');
  const feedCount = root.querySelector('#feed-count');
  const targetCount = root.querySelector('#target-count');
  const radarCount = root.querySelector('#radar-count');
  const clearFilter = root.querySelector('[data-action="clear-filter"]');

  /* ---------------------------------------------------------- targets */

  async function loadTargets() {
    await panel(targetsPanel, async () => {
      const query = { limit: 200 };
      if (state.region !== 'ALL') query.region = state.region;
      if (state.q) query.q = state.q;
      const res = await endpoints.targets(query);
      const items = listOf(res);
      state.targets = items;
      state.total = totalOf(res, items);

      if (targetCount) targetCount.textContent = state.total + (state.total === 1 ? ' executive' : ' executives');
      if (radarCount) {
        radarCount.textContent = state.q
          ? state.total + ' match' + (state.total === 1 ? '' : 'es') + ' for “' + state.q + '”'
          : state.total + ' watched';
      }

      if (!items.length) {
        return emptyState({
          icon: 'search',
          title: state.q ? 'No executives match that search' : 'No watched executives',
          message: state.q
            ? 'Try a shorter query, or clear the search box.'
            : 'Import a target list through POST /api/targets/import to start watching executives.',
          action: 'refresh-targets',
          actionLabel: 'Refresh',
        });
      }

      return html`<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Executive</th>
              <th>Company</th>
              <th>Region</th>
              <th class="num">Posts</th>
              <th class="nowrap">Last scraped</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((t) => html`
              <tr class="clickable ${t && t.id === state.selectedId ? 'selected' : ''}" data-action="select-target" data-target-id="${t && t.id}" data-target-name="${t && t.name}">
                <td>
                  <div class="table-primary truncate">${t && t.name ? t.name : 'Unnamed'}</div>
                  <div class="table-sub truncate">${t && t.title ? t.title : ''}</div>
                </td>
                <td class="truncate">${t && t.company ? t.company : '—'}</td>
                <td>${regionBadge(t && t.region)}</td>
                <td class="num">${fmtNum(t && t.post_count)}</td>
                <td class="nowrap muted small" title="${formatDateTime(t && t.last_scraped_at)}">${relativeTime(t && t.last_scraped_at)}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>`;
    }, { retryAction: 'refresh-targets', errorTitle: "Couldn't load watched executives", skeletonRows: 6 });
  }

  /* ---------------------------------------------------------- feed */

  function feedQuery() {
    const query = { limit: 50 };
    if (state.selectedId) {
      query.target_id = state.selectedId;
    } else if (state.topic) {
      query.q = state.topic;
    } else if (state.region !== 'ALL') {
      query.region = state.region;
    }
    return query;
  }

  function syncFeedHead() {
    if (state.selectedId) {
      feedTitle.textContent = 'Posts from ' + (state.selectedName || 'executive');
      clearFilter.classList.remove('hidden');
    } else if (state.topic) {
      feedTitle.textContent = 'Topic: ' + state.topic;
      clearFilter.classList.remove('hidden');
    } else {
      feedTitle.textContent = 'Live executive activity feed';
      clearFilter.classList.add('hidden');
    }
  }

  async function loadFeed() {
    syncFeedHead();
    await panel(feedPanel, async () => {
      const res = await endpoints.posts(feedQuery());
      const items = listOf(res);
      const total = totalOf(res, items);
      if (feedCount) feedCount.textContent = total + (total === 1 ? ' post' : ' posts');

      if (!items.length) {
        return emptyState({
          icon: 'inbox',
          title: state.selectedId ? 'No posts captured for this executive yet' : 'No posts in the feed yet',
          message: state.selectedId
            ? 'Run an ingest to pull the latest activity for this target.'
            : 'Trigger POST /api/ingest/run, or wait for the scheduled ingest job.',
          action: 'refresh-feed',
          actionLabel: 'Refresh',
        });
      }

      return html`${items.map(postCard)}`;
    }, { retryAction: 'refresh-feed', errorTitle: "Couldn't load the activity feed", skeletonRows: 5 });
  }

  function postCard(post) {
    const p = post && typeof post === 'object' ? post : {};
    const topics = Array.isArray(p.topics) ? p.topics.filter((t) => typeof t === 'string' && t) : [];
    const url = typeof p.url === 'string' && /^https?:\/\//i.test(p.url) ? p.url : null;
    const velocity = Number(p.velocity);
    return html`<article class="post-card">
      <div class="post-top">
        <span class="post-who">${p.target_name || 'Unknown executive'}</span>
        ${p.company ? html`<span class="post-co">${p.company}</span>` : ''}
        ${regionBadge(p.region)}
        ${urgencyBadge(p.urgency)}
        <span class="post-time" title="${formatDateTime(p.posted_at)}">${relativeTime(p.posted_at)}</span>
      </div>
      <p class="post-text">${p.content_text || '(no text captured)'}</p>
      ${topics.length
        ? html`<div class="chips">${topics.map((t) => html`<span class="chip chip-topic" role="button" tabindex="0" data-action="open-topic" data-topic="${t}" title="Show posts for this topic">${t}</span>`)}</div>`
        : ''}
      <div class="post-foot">
        <span class="metric" title="Reactions">${icon('reaction', 13)}${fmtNum(p.reactions)}</span>
        <span class="metric" title="Comments">${icon('comment', 13)}${fmtNum(p.comments)}</span>
        <span class="metric" title="Shares">${icon('share', 13)}${fmtNum(p.shares)}</span>
        ${isFinite(velocity) ? html`<span class="metric" title="Engagement velocity">${icon('bolt', 13)}${velocity.toFixed(1)}</span>` : ''}
        <div class="btn-row">
          ${url ? html`<a class="btn btn-sm" href="${url}" target="_blank" rel="noopener">${icon('external', 13)}Open</a>` : ''}
          <button type="button" class="btn btn-sm btn-primary" data-action="draft-post" data-post-id="${p.id}">
            ${icon('bolt', 13)}<span class="btn-label">Draft</span>
          </button>
        </div>
      </div>
    </article>`;
  }

  /* ---------------------------------------------------------- actions */

  async function draftFromPost(button, postId) {
    if (!postId) return;
    await withBusy(button, 'Generating…', async () => {
      try {
        const res = await endpoints.generate(postId, 'both');
        const draft = unwrap(res, ['draft']);
        const id = draft && draft.id !== undefined && draft.id !== null ? draft.id : null;
        toastOk('Draft generated');
        activity.log('generated draft for post ' + postId + (id ? ' (draft ' + id + ')' : ''));
        ctx.navigate('#studio' + (id ? '?draft=' + encodeURIComponent(id) : ''));
      } catch (err) {
        toastErr(err && err.message ? err.message : 'Generation failed');
      }
    });
  }

  const offClick = delegate(root, 'click', '[data-action]', (event, el) => {
    const action = el.getAttribute('data-action');
    if (action === 'refresh-radar') {
      loadTargets();
      loadFeed();
      return;
    }
    if (action === 'refresh-targets') { loadTargets(); return; }
    if (action === 'refresh-feed') { loadFeed(); return; }
    if (action === 'clear-filter') {
      state.selectedId = null;
      state.selectedName = '';
      state.topic = '';
      history.replaceState(null, '', '#radar');
      loadTargets();
      loadFeed();
      return;
    }
    if (action === 'select-target') {
      const id = el.getAttribute('data-target-id');
      const name = el.getAttribute('data-target-name') || '';
      if (!id) {
        toastErr('This target has no id in the API response.');
        return;
      }
      state.selectedId = Number(id);
      state.selectedName = name;
      state.topic = '';
      for (const row of root.querySelectorAll('tr.selected')) row.classList.remove('selected');
      el.classList.add('selected');
      loadFeed();
      return;
    }
    if (action === 'draft-post') {
      draftFromPost(el, el.getAttribute('data-post-id'));
      return;
    }
    if (action === 'open-topic') {
      const topic = el.getAttribute('data-topic');
      state.selectedId = null;
      state.topic = topic || '';
      loadFeed();
    }
  });
  ctx.onDestroy(offClick);

  const onKey = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const el = event.target instanceof Element ? event.target.closest('[data-action="open-topic"]') : null;
    if (!el) return;
    event.preventDefault();
    const topic = el.getAttribute('data-topic');
    state.selectedId = null;
    state.topic = topic || '';
    loadFeed();
  };
  root.addEventListener('keydown', onKey);
  ctx.onDestroy(() => root.removeEventListener('keydown', onKey));

  const tabOff = delegate(root, 'click', '.tab[data-region]', (event, el) => {
    state.region = el.getAttribute('data-region') || 'ALL';
    for (const tab of root.querySelectorAll('.tab[data-region]')) {
      const active = tab === el;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    loadTargets();
    loadFeed();
  });
  ctx.onDestroy(tabOff);

  let debounce = null;
  const input = root.querySelector('#radar-q');
  if (input) {
    const onInput = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.q = input.value.trim();
        loadTargets();
      }, 250);
    };
    input.addEventListener('input', onInput);
    ctx.onDestroy(() => {
      input.removeEventListener('input', onInput);
      if (debounce) clearTimeout(debounce);
    });
  }

  activity.log('radar: loading targets and live feed');
  syncFeedHead();
  loadTargets();
  loadFeed();
}

export default { mount };
