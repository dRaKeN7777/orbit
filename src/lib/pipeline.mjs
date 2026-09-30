/**
 * The pipeline: research -> analyse -> plan -> draft -> verify -> schedule -> publish.
 *
 * `verify` is a real gate, not a checkbox. A draft that fails the linter is
 * stored with status `needs_review` and can never be scheduled or published
 * until it is edited into compliance. That invariant is enforced in two places:
 * at schedule time in the server, and again at publish time here — because a
 * draft can be edited after it was scheduled.
 */

import { nowIso } from '../db.mjs'
import { lint } from './lint.mjs'
import { classifyPost, generateAssets } from './llm.mjs'
import { ingest } from './ingest.mjs'
import { recomputeTopics } from './topics.mjs'
import { publish } from './publish.mjs'
import { applyWebsiteUpdate, planWebsiteUpdate } from './website.mjs'
import { materialiseVisual } from './media.mjs'
import { describeSlot, planSlots } from './slots.mjs'

const URGENCY_WEIGHT = { high: 3, medium: 2, low: 1 }

export function startRun(db, kind, emit = () => {}) {
  const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const startedAt = nowIso()
  const lines = []
  db.prepare(
    'INSERT INTO runs (id, kind, status, started_at, stats, log) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, kind, 'running', startedAt, '{}', '[]')

  const flush = (status, stats) => {
    db.prepare(
      'UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, stats = ?, log = ? WHERE id = ?',
    ).run(
      status,
      status === 'running' ? null : nowIso(),
      status === 'running' ? null : Date.now() - new Date(startedAt).getTime(),
      JSON.stringify(stats),
      JSON.stringify(lines.slice(-400)),
      id,
    )
  }

  return {
    id,
    stats: {},
    log(msg, level = 'info') {
      const entry = { at: nowIso(), level, msg }
      lines.push(entry)
      emit({ type: 'run.log', payload: { run_id: id, ...entry } })
    },
    setStats(patch) {
      Object.assign(this.stats, patch)
      flush('running', this.stats)
    },
    finish(status = 'succeeded') {
      flush(status, this.stats)
      emit({ type: 'run.status', payload: { run_id: id, kind, status, stats: this.stats } })
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Stage 2: analysis                                                           */
/* -------------------------------------------------------------------------- */

async function analysePending(db, { settings, run, limit = 1000 }) {
  const pending = db
    .prepare(
      `SELECT p.*, t.name AS target_name, t.company, t.title AS target_title, t.region
         FROM posts p JOIN targets t ON t.id = p.target_id
        WHERE p.analyzed = 0
        ORDER BY p.velocity DESC, p.posted_at DESC
        LIMIT ?`,
    )
    .all(limit)

  if (!pending.length) {
    run.log('no unanalysed posts')
    return 0
  }

  let done = 0
  for (const post of pending) {
    const target = {
      name: post.target_name,
      company: post.company,
      title: post.target_title,
      region: post.region,
    }
    // Deterministic and free — the LLM pass happens later, only for the
    // handful of posts that actually become drafts.
    const analysis = classifyPost({ post, target })
    db.prepare(
      'UPDATE posts SET topics = ?, urgency = ?, sentiment = ?, analyzed = 1 WHERE id = ?',
    ).run(
      JSON.stringify(analysis.topics ?? []),
      analysis.urgency ?? 'low',
      analysis.sentiment ?? 'neutral',
      post.id,
    )
    done++
  }
  run.log(`analysed ${done} posts`)
  return done
}

/* -------------------------------------------------------------------------- */
/* Stage 4: drafting                                                           */
/* -------------------------------------------------------------------------- */

async function createDraft(db, { post, target, topicSlug, settings, feedback = '', run }) {
  const assets = await generateAssets({ post, target, settings, feedback })
  let peerLint = lint(assets.peer_comment, {
    kind: 'comment',
    minScore: settings.min_lint_score ?? 70,
    bannedExtra: settings.banned_extra ?? [],
  })
  let postLint = lint(assets.inbound_post, {
    kind: 'post',
    minScore: settings.min_lint_score ?? 70,
    bannedExtra: settings.banned_extra ?? [],
  })

  // One repair attempt on style-only failures. Specificity failures need a
  // rewrite, which is the human's job in the Studio.
  if (!postLint.passed || !peerLint.passed) {
    const { repairDraft } = await import('./llm.mjs')
    if (!postLint.passed) {
      const fixed = await repairDraft({
        text: assets.inbound_post,
        violations: postLint.violations,
        settings,
        kind: 'post',
      })
      if (fixed) {
        const relint = lint(fixed, {
          kind: 'post',
          minScore: settings.min_lint_score ?? 70,
          bannedExtra: settings.banned_extra ?? [],
        })
        if (relint.score >= postLint.score) {
          assets.inbound_post = fixed
          postLint = relint
        }
      }
    }
    if (!peerLint.passed) {
      const fixed = await repairDraft({
        text: assets.peer_comment,
        violations: peerLint.violations,
        settings,
        kind: 'comment',
      })
      if (fixed) {
        const relint = lint(fixed, {
          kind: 'comment',
          minScore: settings.min_lint_score ?? 70,
          bannedExtra: settings.banned_extra ?? [],
        })
        if (relint.score >= peerLint.score) {
          assets.peer_comment = fixed
          peerLint = relint
        }
      }
    }
  }

  const overall = {
    score: Math.min(postLint.score, peerLint.score),
    passed: postLint.passed && peerLint.passed,
    post: postLint,
    comment: peerLint,
    // Kept flat for convenience in the UI and in publish-time re-checks.
    violations: [...postLint.violations, ...peerLint.violations],
    metrics: postLint.metrics,
  }

  const status = overall.passed ? 'verified' : 'needs_review'
  const info = db
    .prepare(
      `INSERT INTO drafts
         (post_id, target_id, source, topic_slug, detected_pain_point, angle, peer_comment,
          inbound_post, visual, lint, status, generator, feedback, created_at, updated_at)
       VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      post.id,
      target.id,
      topicSlug ?? null,
      assets.detected_pain_point ?? '',
      assets.angle ?? '',
      assets.peer_comment ?? '',
      assets.inbound_post ?? '',
      JSON.stringify({ kind: 'diagram', spec: null, asset_path: null }),
      JSON.stringify(overall),
      status,
      assets.generator ?? 'unknown',
      feedback || null,
      nowIso(),
      nowIso(),
    )

  run.log(
    `draft ${info.lastInsertRowid} for ${target.name}: ${status} (post ${postLint.score} / comment ${peerLint.score})`,
    overall.passed ? 'info' : 'warn',
  )
  return Number(info.lastInsertRowid)
}

/* -------------------------------------------------------------------------- */
/* Stage 6: publishing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Publish every schedule that is due. Re-checks the lint gate at publish time
 * because a draft can be edited between scheduling and publishing.
 */
export async function publishDue(db, { settings, run, force = false, log = () => {}, kind = null }) {
  const due = force
    ? db
        .prepare(
          `SELECT s.* FROM schedules s WHERE s.status IN ('pending','failed') ORDER BY s.scheduled_at ASC LIMIT 25`,
        )
        .all()
    : db
        .prepare(
          `SELECT s.* FROM schedules s
            WHERE s.status IN ('pending','failed')
              AND s.scheduled_at <= ?
            ORDER BY s.scheduled_at ASC LIMIT 25`,
        )
        .all(nowIso())

  const published = []
  const failed = []
  let skipped = 0

  for (const schedule of due) {
    const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(schedule.draft_id)
    if (!draft) {
      skipped++
      continue
    }
    const lintState = JSON.parse(draft.lint || '{}')
    const minScore = settings.min_lint_score ?? 70

    if (!lintState.passed || (lintState.score ?? 0) < minScore) {
      db.prepare(
        `UPDATE schedules SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(
        `blocked at publish: verification failed (score ${lintState.score ?? 0}, need ${minScore})`,
        nowIso(),
        schedule.id,
      )
      // Keep the draft's own status honest too, so the Studio shows it as
      // needing review rather than as a scheduled item.
      db.prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(
        'needs_review',
        nowIso(),
        draft.id,
        'scheduled',
      )
      failed.push({ schedule_id: schedule.id, error: 'verification failed' })
      run?.log(`schedule ${schedule.id} blocked: draft failed verification`, 'warn')
      continue
    }

    // Attach the schematic, so the post carries its visual rather than going out
    // as text only. Rasterisation degrades gracefully: a missing browser means a
    // text post, never a failed publish.
    let visual = JSON.parse(draft.visual || 'null')
    try {
      visual = await materialiseVisual(db, draft.id, {
        log: (m, l) => (run ? run.log(m, l) : log(m)),
      })
      db.prepare('UPDATE drafts SET visual = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(visual),
        nowIso(),
        draft.id,
      )
    } catch (err) {
      run?.log(`visual failed for draft ${draft.id}: ${err.message}`, 'warn')
    }

    const result = await publish({
      draft: { ...draft, lint: lintState, visual },
      schedule,
      db,
      kind,
      log: (m) => (run ? run.log(m) : log(m)),
    })
    const now = nowIso()

    if (result.ok) {
      db.prepare(
        `UPDATE schedules SET status = 'published', published_url = ?, attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?`,
      ).run(result.url, now, schedule.id)
      db.prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?').run(
        'published',
        now,
        draft.id,
      )
      published.push({ schedule_id: schedule.id, url: result.url, provider: result.provider })
    } else {
      db.prepare(
        `UPDATE schedules SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(result.error, now, schedule.id)
      failed.push({ schedule_id: schedule.id, error: result.error })
    }
  }

  return { published, failed, skipped, due: due.length }
}

/* -------------------------------------------------------------------------- */
/* Stage 5: scheduling                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Queue verified drafts into posting slots.
 *
 * The gate is re-checked here for the same reason it is checked at publish
 * time: a draft can be edited after it was verified. Anything that no longer
 * passes is demoted to `needs_review` rather than silently queued.
 */
export function scheduleVerifiedDrafts(db, { settings, limit = null, log = () => {} }) {
  const max = Math.max(1, limit ?? settings.schedule_per_run ?? 5)
  const minScore = settings.min_lint_score ?? 70

  const candidates = db
    .prepare(
      `SELECT * FROM drafts WHERE status IN ('verified','approved') ORDER BY id ASC LIMIT ?`,
    )
    .all(max * 3)

  if (!candidates.length) {
    log('schedule: no verified drafts waiting')
    return { scheduled: 0, skipped: 0, slots: [] }
  }

  const eligible = []
  let skipped = 0
  for (const draft of candidates) {
    if (eligible.length >= max) break
    const state = JSON.parse(draft.lint || '{}')
    if (!state.passed || (state.score ?? 0) < minScore) {
      db.prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?').run(
        'needs_review',
        nowIso(),
        draft.id,
      )
      log(
        `schedule: draft ${draft.id} sent back to review — score ${state.score ?? 0} is below ${minScore}`,
        'warn',
      )
      skipped++
      continue
    }
    eligible.push(draft)
  }

  if (!eligible.length) {
    log('schedule: nothing eligible after re-checking the gate', 'warn')
    return { scheduled: 0, skipped, slots: [] }
  }

  const taken = db
    .prepare("SELECT scheduled_at FROM schedules WHERE status IN ('pending','published')")
    .all()
    .map((r) => r.scheduled_at)

  const slots = planSlots({
    windows: settings.posting_windows,
    days: settings.posting_days,
    count: eligible.length,
    taken,
    minHoursBetween: settings.min_hours_between_posts,
    maxPerDay: settings.posts_per_day,
    horizonDays: settings.schedule_horizon_days ?? 45,
  })

  if (slots.length < eligible.length) {
    log(
      `schedule: only ${slots.length} free slot(s) in the next ${settings.schedule_horizon_days ?? 45} days for ${eligible.length} draft(s)`,
      'warn',
    )
  }

  let scheduled = 0
  eligible.forEach((draft, i) => {
    const slot = slots[i]
    if (!slot) return
    db.prepare(
      `INSERT INTO schedules (draft_id, channel, scheduled_at, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).run(draft.id, settings.publish_channel ?? 'linkedin_company', slot, nowIso(), nowIso())
    db.prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?').run(
      'scheduled',
      nowIso(),
      draft.id,
    )
    scheduled++
    log(`schedule: draft ${draft.id} queued for ${describeSlot(slot)}`)
  })

  return { scheduled, skipped, slots: slots.slice(0, scheduled) }
}

/**
 * Mirror of `scheduleVerifiedDrafts`, for the other direction.
 *
 * A draft can be edited after it was queued. If it no longer passes the gate,
 * its pending slot must stop looking like it is going to fire — otherwise the
 * Scheduler shows a failing post as "pending" and the operator reasonably
 * believes it will go out. `publishDue` would block it anyway, but finding out
 * at publish time is too late to be useful.
 *
 * @returns {number} how many slots were blocked
 */
export function blockPendingSchedules(db, { draftId, score, minScore }) {
  const info = db
    .prepare(
      `UPDATE schedules
          SET status = 'failed', last_error = ?, updated_at = ?
        WHERE draft_id = ? AND status = 'pending'`,
    )
    .run(
      `blocked: verification failed after editing (score ${score}, need ${minScore}) — edit the draft and schedule it again`,
      nowIso(),
      draftId,
    )
  return info.changes ?? 0
}

/* -------------------------------------------------------------------------- */
/* Top-level orchestration                                                     */
/* -------------------------------------------------------------------------- */

function selectTopics(db, limit) {
  const rows = db
    .prepare('SELECT * FROM topics ORDER BY mentions DESC LIMIT 40')
    .all()
    .map((r) => ({
      ...r,
      regions: JSON.parse(r.regions || '{}'),
      post_ids: JSON.parse(r.post_ids || '[]'),
    }))

  const score = (t) => t.mentions * (URGENCY_WEIGHT[t.urgency] ?? 1) * (t.trend === 'rising' ? 1.4 : 1)
  rows.sort((a, b) => score(b) - score(a))

  // Prefer a regional spread rather than five Swiss data-protection clusters.
  const picked = []
  for (const region of ['UK', 'CH']) {
    const first = rows.find((t) => !picked.includes(t) && (t.regions[region] ?? 0) > 0)
    if (first) picked.push(first)
  }
  for (const t of rows) {
    if (picked.length >= limit) break
    if (!picked.includes(t)) picked.push(t)
  }
  return picked.slice(0, limit)
}

/**
 * @param {'full'|'research'|'draft'|'publish'|'schedule'|'website'} mode
 */
export async function runPipeline(db, { mode = 'full', settings, emit = () => {} }) {
  const run = startRun(db, mode, emit)
  const log = (m, l) => run.log(m, l)

  try {
    // 1. RESEARCH
    if (mode === 'full' || mode === 'research') {
      const targets = db.prepare('SELECT * FROM targets WHERE active = 1').all()
      log(`research: ${targets.length} active targets`)
      const res = await ingest({ db, targets, log })
      run.setStats({ ingested: res.inserted, fetched: res.fetched, provider: res.provider })
      if (res.errors.length) log(`ingest warnings: ${res.errors.join('; ')}`, 'warn')

      await analysePending(db, { settings, run })
    }

    // 2. PLAN — cluster the market into themes
    if (mode === 'full' || mode === 'research' || mode === 'draft') {
      const t = recomputeTopics(db, { days: 14, log: (m) => log(m) })
      run.setStats({ topics: t.topics })

      if (mode === 'full' || mode === 'draft') {
        const picks = selectTopics(db, Math.max(1, settings.drafts_per_run ?? 3))
        log(`plan: selected ${picks.length} clusters to answer`)
        let created = 0

        for (const topic of picks) {
          const candidates = topic.post_ids
            .map((id) =>
              db
                .prepare(
                  `SELECT p.*, t.name AS target_name, t.company, t.title AS target_title, t.region, t.id AS t_id
                     FROM posts p JOIN targets t ON t.id = p.target_id WHERE p.id = ?`,
                )
                .get(id),
            )
            .filter(Boolean)

          // Do not draft the same post twice unless it was regenerated on purpose.
          const fresh = candidates.find(
            (p) => !db.prepare('SELECT 1 FROM drafts WHERE post_id = ?').get(p.id),
          )
          if (!fresh) {
            log(`cluster "${topic.label}": every candidate post already has a draft`)
            continue
          }

          const target = {
            id: fresh.t_id,
            name: fresh.target_name,
            company: fresh.company,
            title: fresh.target_title,
            region: fresh.region,
          }
          try {
            await createDraft(db, { post: fresh, target, topicSlug: topic.slug, settings, run })
            created++
          } catch (err) {
            log(`draft failed for cluster "${topic.label}": ${err.message}`, 'error')
          }
        }
        run.setStats({ drafts: created })
      }
    }

    // 3. WEBSITE
    if (mode === 'full' || mode === 'website') {
      try {
        const update = await planWebsiteUpdate(db, { topicSlug: null, kind: 'insight', settings, log })
        log(`website: planned "${update.title}" -> ${update.target_path}`)
        run.setStats({ website_updates: 1 })
        if (settings.auto_apply_website) {
          const applied = await applyWebsiteUpdate(db, update.id, { settings, log })
          log(`website: applied ${update.target_path} (status ${applied.status})`)
          run.setStats({ website_applied: 1 })
        }
      } catch (err) {
        log(`website planning skipped: ${err.message}`, 'warn')
      }
    }

    // 4. SCHEDULE — place verified drafts into posting slots
    if (mode === 'full' || mode === 'schedule') {
      if (mode === 'schedule' || settings.auto_schedule) {
        const res = scheduleVerifiedDrafts(db, { settings, log })
        run.setStats({ scheduled: res.scheduled })
      } else {
        const waiting =
          db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'verified'").get()?.n ?? 0
        log(
          `schedule: auto_schedule is off — ${waiting} verified draft(s) waiting for review in the Studio`,
        )
      }
    }

    // 5. PUBLISH
    if (mode === 'full' || mode === 'publish') {
      if (mode !== 'publish' && !settings.auto_publish) {
        log('publish: auto_publish is off — approve and schedule drafts in the Scheduler')
      } else {
        const res = await publishDue(db, { settings, run })
        run.setStats({ published: res.published.length, failed: res.failed.length })
        log(`publish: ${res.published.length} published, ${res.failed.length} failed`)
      }
    }

    run.finish('succeeded')
  } catch (err) {
    run.log(`pipeline failed: ${err.message}`, 'error')
    run.finish('failed')
  }

  return db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id)
}
