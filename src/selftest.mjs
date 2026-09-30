/**
 * Self-test. Run with: npm run selftest
 *
 * These are behavioural tests, not smoke tests. The important ones assert that
 * the verifier actually REJECTS bad copy — a gate that never fires is worse
 * than no gate, because it creates false confidence.
 */

import assert from 'node:assert/strict'
import { openDb, nowIso } from './db.mjs'
import { lint, findSpecificity } from './lib/lint.mjs'
import { generateAssets } from './lib/llm.mjs'
import { topicsForPost, recomputeTopics } from './lib/topics.mjs'
import { parseCron, matchesCron, nextRun } from './lib/cron.mjs'
import { storePosts, velocityOf } from './lib/ingest.mjs'
import { blockPendingSchedules, publishDue, scheduleVerifiedDrafts } from './lib/pipeline.mjs'
import { describeSlot, parseWindow, planSlots } from './lib/slots.mjs'
import {
  SESSION_COOKIE,
  createLoginThrottle,
  createSession,
  destroySession,
  getSession,
  hashPassword,
  parseCookies,
  pruneSessions,
  sessionCookie,
  verifyPassword,
} from './lib/auth.mjs'
import { lintWebsite } from './lib/website.mjs'
import { SAMPLE_TEXTS } from './lib/ingest.mjs'

const tests = []
const test = (name, fn) => tests.push({ name, fn })

/* -------------------------------------------------------------------------- */
/* Verifier: it must reject                                                     */
/* -------------------------------------------------------------------------- */

test('rejects banned vocabulary', () => {
  const r = lint('We delve into the ever-evolving landscape of cyber.', { kind: 'comment' })
  assert.equal(r.passed, false)
  const rules = r.violations.map((v) => v.rule)
  assert.ok(rules.includes('banned_word'), 'expected banned_word')
  assert.ok(r.violations.filter((v) => v.severity === 'hard').length >= 2)
})

test('rejects emoji', () => {
  const r = lint('Great session with the team 🚀🔒 today.', { kind: 'comment' })
  assert.equal(r.passed, false)
  assert.ok(r.violations.some((v) => v.rule === 'emoji'))
})

test('rejects banned openers', () => {
  for (const opener of [
    "In today's fast-paced cyber landscape, everything changed.",
    'Hot take: your SIEM is fine.',
    "Let's talk about supply chain risk.",
    'Most companies get third-party risk wrong.',
  ]) {
    const r = lint(opener, { kind: 'comment' })
    assert.ok(
      r.violations.some((v) => v.rule === 'banned_opener'),
      `expected banned_opener for: ${opener}`,
    )
  }
})

test('rejects banned closers', () => {
  for (const closer of ['Agree?', 'Thoughts?', 'DM me for the deck.', 'Let me know in the comments.']) {
    const r = lint(`We mapped the control estate against revFADP. ${closer}`, { kind: 'comment' })
    assert.ok(
      r.violations.some((v) => v.rule === 'banned_closer'),
      `expected banned_closer for: ${closer}`,
    )
  }
})

test('rejects the contrast flip construction', () => {
  const r = lint("Sovereignty isn't a checkmark. It's a persistent control reality.", { kind: 'comment' })
  assert.ok(r.violations.some((v) => v.rule === 'contrast_flip'))
})

test('rejects symmetrical bolded bullet lists', () => {
  const text = `Three things matter:
- **Visibility:** you need logs.
- **Control:** you need keys.
- **Audit:** you need evidence.`
  const r = lint(text, { kind: 'comment' })
  assert.equal(r.passed, false)
  assert.ok(r.violations.some((v) => v.rule === 'bold_bullet_symmetry'))
})

test('rejects copy with no concrete artifact', () => {
  const r = lint(
    'Security teams face many challenges today. We help organisations stay ahead of threats with our platform.',
    { kind: 'comment' },
  )
  assert.equal(r.passed, false)
  assert.ok(r.violations.some((v) => v.rule === 'no_specificity'))
})

test('applies length bands per content kind', () => {
  // 120 words: past a comment's 110-word comfort band, but not yet absurd.
  const soft = lint('The architecture matters. '.repeat(40), { kind: 'comment' })
  assert.ok(
    soft.violations.some((v) => v.rule === 'word_count_off'),
    'expected the soft length flag',
  )
  assert.ok(
    !soft.violations.some((v) => v.rule === 'word_count'),
    '120 words should not yet be a hard failure',
  )

  // 420 words is unambiguously wrong for a comment.
  const hard = lint('The architecture matters. '.repeat(140), { kind: 'comment' })
  assert.equal(hard.passed, false)
  assert.ok(hard.violations.some((v) => v.rule === 'word_count'))

  // And a two-word post is too thin in the other direction.
  assert.equal(lint('Too short.', { kind: 'post' }).passed, false)
})

test('flags a uniform rhythm', () => {
  const text = [
    'We looked at the audit plane last week and found a problem.',
    'The team had built a good control set across the estate.',
    'Nobody had checked who could read the underlying log data.',
    'That meant the evidence chain was broken at the first hop.',
    'We rebuilt the signing path so each event attests itself.',
  ].join(' ')
  const r = lint(text, { kind: 'comment' })
  assert.ok(
    r.violations.some((v) => v.rule === 'low_burstiness') ||
      r.violations.some((v) => v.rule === 'no_short_sentence'),
    'expected a rhythm violation',
  )
})

/* -------------------------------------------------------------------------- */
/* Verifier: it must accept good copy                                           */
/* -------------------------------------------------------------------------- */

test('accepts the offline composer output for every sample post', async () => {
  for (const region of ['UK', 'CH']) {
    for (const sample of SAMPLE_TEXTS.filter((s) => s.region === region)) {
      const post = { id: 1, content_text: sample.text }
      const target = { name: 'Test', company: 'Test', region }
      const assets = await generateAssets({ post, target, settings: {} })
      const lp = lint(assets.inbound_post, { kind: 'post' })
      const lc = lint(assets.peer_comment, { kind: 'comment' })
      assert.equal(lp.passed, true, `post rejected for "${sample.text.slice(0, 50)}": ${JSON.stringify(lp.violations)}`)
      assert.equal(lc.passed, true, `comment rejected for "${sample.text.slice(0, 50)}": ${JSON.stringify(lc.violations)}`)
      assert.ok(lp.metrics.words >= 120 && lp.metrics.words <= 180, `word count ${lp.metrics.words}`)
    }
  }
})

test('composer output is deterministic', async () => {
  const post = { id: 7, content_text: SAMPLE_TEXTS[0].text }
  const target = { name: 'A', company: 'B', region: 'CH' }
  const a = await generateAssets({ post, target, settings: {} })
  const b = await generateAssets({ post, target, settings: {} })
  assert.equal(a.inbound_post, b.inbound_post)
})

test('custom banned terms are honoured', () => {
  const r = lint('We are a market leader in cyber assurance.', {
    kind: 'comment',
    bannedExtra: ['market leader'],
  })
  assert.ok(r.violations.some((v) => v.rule === 'banned_custom'))
})

test('specificity finds regulations, protocols and measured numbers', () => {
  const found = findSpecificity(
    'We cut p99 latency to 40ms while keeping revFADP Art. 32 evidence and mTLS everywhere.',
  )
  assert.ok(found.some((f) => /revFADP/i.test(f)), JSON.stringify(found))
  assert.ok(found.some((f) => /p99/i.test(f)), JSON.stringify(found))
  assert.ok(found.some((f) => /mTLS/i.test(f)), JSON.stringify(found))

  const presales = findSpecificity(
    'The RFP required a rate card and MEDDPICC qualification before the deal review.',
  )
  assert.ok(presales.some((f) => /RFP/i.test(f)), JSON.stringify(presales))
  assert.ok(presales.some((f) => /rate card/i.test(f)), JSON.stringify(presales))
  assert.ok(presales.some((f) => /MEDDPICC/i.test(f)), JSON.stringify(presales))
})

/* -------------------------------------------------------------------------- */
/* Topic clustering                                                            */
/* -------------------------------------------------------------------------- */

test('clusters name the right presales themes', () => {
  const slugs = topicsForPost(
    'Our estimate for the revFADP bid changed four times because the partner rate card was updated and nobody versioned it.',
  ).map((t) => t.slug)
  assert.ok(slugs.includes('estimation-margin'), JSON.stringify(slugs))
  assert.ok(slugs.includes('frameworks-in-bids'), JSON.stringify(slugs))
  assert.ok(slugs.includes('partner-vendor-catalogue'), JSON.stringify(slugs))
})

test('recomputeTopics aggregates regions, urgency and trend', () => {
  const db = openDb(':memory:')
  db.prepare(
    'INSERT INTO targets (id, name, company, region, active, created_at) VALUES (1, ?, ?, ?, 1, ?)',
  ).run('Urs Widmer', 'Alpenrand Security AG', 'CH', nowIso())
  db.prepare(
    'INSERT INTO targets (id, name, company, region, active, created_at) VALUES (2, ?, ?, ?, 1, ?)',
  ).run('Alastair Kenning', 'Northgate Cyber', 'UK', nowIso())

  const insert = db.prepare(
    `INSERT INTO posts (target_id, content_text, posted_at, reactions, comments, shares, velocity, urgency, sentiment, created_at)
     VALUES (?, ?, ?, 10, 2, 1, 5, ?, ?, ?)`,
  )
  const recent = new Date(Date.now() - 86_400_000).toISOString()
  const older = new Date(Date.now() - 10 * 86_400_000).toISOString()
  insert.run(1, 'Our estimate for the revFADP bid changed four times this week.', recent, 'high', 'concerned', nowIso())
  insert.run(1, 'The estimate still does not match the delivery assumptions.', recent, 'high', 'concerned', nowIso())
  insert.run(2, 'Crown Commercial Service framework bids need a different proposal library.', recent, 'medium', 'neutral', nowIso())
  insert.run(2, 'G-Cloud submissions are their own discipline.', older, 'low', 'neutral', nowIso())

  const result = recomputeTopics(db, { days: 14 })
  assert.ok(result.topics >= 3, `expected >=3 topics, got ${result.topics}`)

  const ch = db.prepare("SELECT * FROM topics WHERE slug = 'estimation-margin'").get()
  assert.ok(ch, 'estimation cluster missing')
  assert.equal(ch.mentions, 2)
  assert.equal(JSON.parse(ch.regions).CH, 2)
  assert.equal(ch.urgency, 'high')

  const uk = db.prepare("SELECT * FROM topics WHERE slug = 'public-sector-procurement'").get()
  assert.ok(uk, 'public-sector cluster missing')
  assert.equal(JSON.parse(uk.regions).UK, 2)
})

/* -------------------------------------------------------------------------- */
/* Cron                                                                        */
/* -------------------------------------------------------------------------- */

test('cron parses and matches correctly', () => {
  const every5 = parseCron('*/5 * * * *')
  assert.equal(matchesCron(every5, new Date(Date.UTC(2026, 0, 5, 3, 10))), true)
  assert.equal(matchesCron(every5, new Date(Date.UTC(2026, 0, 5, 3, 12))), false)

  const daily6 = parseCron('0 6 * * *')
  assert.equal(matchesCron(daily6, new Date(Date.UTC(2026, 0, 5, 6, 0))), true)
  assert.equal(matchesCron(daily6, new Date(Date.UTC(2026, 0, 5, 7, 0))), false)

  const monday = parseCron('30 6 * * 1')
  // 2026-01-05 is a Monday.
  assert.equal(matchesCron(monday, new Date(Date.UTC(2026, 0, 5, 6, 30))), true)
  assert.equal(matchesCron(monday, new Date(Date.UTC(2026, 0, 6, 6, 30))), false)

  assert.throws(() => parseCron('bad'), /5 fields/)
  assert.throws(() => parseCron('99 * * * *'), /out of range/)

  const next = nextRun('0 6 * * *', new Date(Date.UTC(2026, 0, 5, 7, 0)))
  assert.equal(next.toISOString(), '2026-01-06T06:00:00.000Z')
})

/* -------------------------------------------------------------------------- */
/* Ingestion                                                                   */
/* -------------------------------------------------------------------------- */

test('storing posts is idempotent', () => {
  const db = openDb(':memory:')
  db.prepare(
    'INSERT INTO targets (id, name, company, region, active, created_at) VALUES (1, ?, ?, ?, 1, ?)',
  ).run('Test', 'Test Co', 'UK', nowIso())
  const posts = [
    { external_id: 'x1', text: 'First post about NCSC guidance.', posted_at: nowIso(), reactions: 5, comments: 1, shares: 0 },
    { external_id: 'x2', text: 'Second post about revFADP.', posted_at: nowIso(), reactions: 9, comments: 2, shares: 1 },
  ]
  assert.equal(storePosts(db, 1, posts), 2)
  assert.equal(storePosts(db, 1, posts), 0, 're-inserting must not duplicate')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 2)
})

test('velocity weights shares and decays with age', () => {
  const fresh = velocityOf({ reactions: 100, comments: 10, shares: 5 }, new Date().toISOString())
  const stale = velocityOf(
    { reactions: 100, comments: 10, shares: 5 },
    new Date(Date.now() - 20 * 86_400_000).toISOString(),
  )
  assert.ok(fresh > stale, 'fresh engagement should have higher velocity')
})

/* -------------------------------------------------------------------------- */
/* The pipeline invariant                                                      */
/* -------------------------------------------------------------------------- */

test('publishDue refuses to publish a draft that fails verification', async () => {
  const db = openDb(':memory:')
  db.prepare(
    'INSERT INTO targets (id, name, company, region, active, created_at) VALUES (1, ?, ?, ?, 1, ?)',
  ).run('Test', 'Test Co', 'CH', nowIso())
  db.prepare(
    `INSERT INTO posts (id, target_id, content_text, posted_at, created_at) VALUES (1, 1, ?, ?, ?)`,
  ).run('A post.', nowIso(), nowIso())

  const badLint = lint('We delve into the landscape. Agree?', { kind: 'post' })
  assert.equal(badLint.passed, false)

  db.prepare(
    `INSERT INTO drafts (id, post_id, target_id, inbound_post, lint, status, created_at, updated_at)
     VALUES (1, 1, 1, ?, ?, 'scheduled', ?, ?)`,
  ).run('We delve into the landscape. Agree?', JSON.stringify(badLint), nowIso(), nowIso())
  db.prepare(
    `INSERT INTO schedules (id, draft_id, channel, scheduled_at, status, created_at, updated_at)
     VALUES (1, 1, 'outbox', ?, 'pending', ?, ?)`,
  ).run(new Date(Date.now() - 60_000).toISOString(), nowIso(), nowIso())

  const result = await publishDue(db, { kind: 'outbox', settings: { min_lint_score: 70, auto_publish: true } })
  assert.equal(result.published.length, 0, 'a failing draft must never be published')
  assert.equal(result.failed.length, 1)

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = 1').get()
  assert.equal(schedule.status, 'failed')
  assert.match(schedule.last_error, /verification failed/)
  // The draft must stop claiming to be scheduled, or the Studio lies to the user.
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id = 1').get().status, 'needs_review')
})

test('publishDue publishes a verified draft through the outbox', async () => {
  const db = openDb(':memory:')
  db.prepare(
    'INSERT INTO targets (id, name, company, region, active, created_at) VALUES (1, ?, ?, ?, 1, ?)',
  ).run('Urs Widmer', 'Alpenrand Security AG', 'CH', nowIso())

  const assets = await generateAssets({
    post: { id: 1, content_text: SAMPLE_TEXTS[0].text },
    target: { name: 'Urs Widmer', company: 'Alpenrand Security AG', region: 'CH' },
    settings: {},
  })
  const good = lint(assets.inbound_post, { kind: 'post' })
  assert.equal(good.passed, true)

  db.prepare(
    `INSERT INTO drafts (id, post_id, target_id, inbound_post, peer_comment, lint, status, created_at, updated_at)
     VALUES (1, NULL, 1, ?, ?, ?, 'scheduled', ?, ?)`,
  ).run(assets.inbound_post, assets.peer_comment, JSON.stringify(good), nowIso(), nowIso())
  db.prepare(
    `INSERT INTO schedules (id, draft_id, channel, scheduled_at, status, created_at, updated_at)
     VALUES (1, 1, 'outbox', ?, 'pending', ?, ?)`,
  ).run(new Date(Date.now() - 60_000).toISOString(), nowIso(), nowIso())

  const result = await publishDue(db, { kind: 'outbox', settings: { min_lint_score: 70 } })
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed))
  assert.equal(result.published.length, 1)
  assert.equal(db.prepare('SELECT status FROM schedules WHERE id = 1').get().status, 'published')
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id = 1').get().status, 'published')
})

/* -------------------------------------------------------------------------- */
/* Website                                                                     */
/* -------------------------------------------------------------------------- */

test('website lint allows long-form but still blocks banned vocabulary', () => {
  const good = lintWebsite(
    '# Proving control\n\nWe mapped the estate against revFADP and rebuilt the signing path so each event attests itself. That took three weeks. The control map fit on two pages, which mattered more than the architecture diagram.',
  )
  assert.equal(good.passed, true, JSON.stringify(good.violations))

  const bad = lintWebsite('## A robust, seamless landscape\n\nWe leverage holistic synergy to empower teams.')
  assert.equal(bad.passed, false)
  assert.ok(bad.violations.some((v) => v.rule === 'banned_word'))
})


/* -------------------------------------------------------------------------- */
/* Posting-slot planning                                                       */
/* -------------------------------------------------------------------------- */

// 2026-01-05 is a Monday; 2026-01-10 is a Saturday.
const MONDAY = new Date('2026-01-05T00:00:00Z')
const H = 3600000

test('parseWindow accepts valid times and rejects the rest', () => {
  assert.deepEqual(parseWindow('08:15'), { h: 8, m: 15 })
  assert.deepEqual(parseWindow(' 23:59 '), { h: 23, m: 59 })
  assert.equal(parseWindow('24:00'), null)
  assert.equal(parseWindow('08:60'), null)
  assert.equal(parseWindow('8am'), null)
  assert.equal(parseWindow(''), null)
})

test('planSlots only uses configured weekdays', () => {
  const slots = planSlots({
    now: MONDAY, windows: ['08:15'], days: [1, 2, 3, 4, 5], count: 5, leadMinutes: 15,
  })
  assert.equal(slots.length, 5)
  const days = slots.map((s) => new Date(s).getUTCDay())
  assert.deepEqual(days, [1, 2, 3, 4, 5], 'expected Mon-Fri, got ' + JSON.stringify(days))

  const weekend = planSlots({
    now: MONDAY, windows: ['08:15'], days: [0, 6], count: 1, leadMinutes: 0,
  })
  assert.equal(weekend[0], '2026-01-10T08:15:00.000Z', 'expected the first Saturday')
})

test('planSlots respects the minimum gap between posts', () => {
  // 08:15 -> 13:45 is only 5.5h apart, so with a 6h gap only one per day fits.
  const spaced = planSlots({
    now: MONDAY, windows: ['08:15', '13:45'], days: [1], count: 2,
    minHoursBetween: 6, leadMinutes: 0,
  })
  // The 13:45 window is inside the 6h gap, so the second post rolls forward a
  // whole week to the next allowed Monday rather than clustering on day one.
  assert.deepEqual(spaced, ['2026-01-05T08:15:00.000Z', '2026-01-12T08:15:00.000Z'])

  // With a 4h gap both fit on the same day.
  const both = planSlots({
    now: MONDAY, windows: ['08:15', '13:45'], days: [1], count: 2,
    minHoursBetween: 4, leadMinutes: 0,
  })
  assert.equal(both.length, 2)
  assert.deepEqual(both, ['2026-01-05T08:15:00.000Z', '2026-01-05T13:45:00.000Z'])
})

test('planSlots caps posts per day', () => {
  const slots = planSlots({
    now: MONDAY, windows: ['08:15', '13:45'], days: [1, 2, 3], count: 4,
    minHoursBetween: 0, maxPerDay: 2, leadMinutes: 0,
  })
  assert.deepEqual(slots, [
    '2026-01-05T08:15:00.000Z', '2026-01-05T13:45:00.000Z',
    '2026-01-06T08:15:00.000Z', '2026-01-06T13:45:00.000Z',
  ])
})

test('planSlots never returns a past slot', () => {
  // 20:00 on Monday — both windows have already passed today.
  const reference = new Date('2026-01-05T20:00:00Z')
  const slots = planSlots({
    now: reference, windows: ['08:15', '13:45'],
    days: [1, 2, 3, 4, 5], count: 1, leadMinutes: 15,
  })
  assert.equal(slots[0], '2026-01-06T08:15:00.000Z')
  assert.ok(
    new Date(slots[0]).getTime() > reference.getTime() + 15 * 60000,
    'slot must be after the reference time plus the lead time',
  )
})

test('planSlots honours the lead time', () => {
  // At 08:00 a 15-minute lead makes the 08:15 window unusable.
  const slots = planSlots({
    now: new Date('2026-01-05T08:00:00Z'), windows: ['08:15'], days: [1],
    count: 1, leadMinutes: 15,
  })
  assert.equal(slots[0], '2026-01-12T08:15:00.000Z', 'expected to skip a week to the next Monday')
})

test('planSlots avoids slots that are already taken', () => {
  const slots = planSlots({
    now: MONDAY, windows: ['08:15', '13:45'], days: [1], count: 1,
    taken: ['2026-01-05T08:15:00.000Z'], minHoursBetween: 0, leadMinutes: 0,
  })
  assert.deepEqual(slots, ['2026-01-05T13:45:00.000Z'])
})

test('planSlots counts already-taken posts against the daily cap', () => {
  const slots = planSlots({
    now: MONDAY, windows: ['08:15', '13:45', '17:00'], days: [1, 2], count: 5,
    taken: ['2026-01-05T08:15:00.000Z', '2026-01-05T13:45:00.000Z'],
    minHoursBetween: 0, maxPerDay: 2, leadMinutes: 0,
  })
  // Monday is already full from the existing queue, so the next slot is Tuesday.
  assert.equal(slots[0], '2026-01-06T08:15:00.000Z')
})

test('planSlots returns nothing when it cannot satisfy the request', () => {
  assert.deepEqual(planSlots({ now: MONDAY, windows: [], count: 3 }), [])
  assert.deepEqual(planSlots({ now: MONDAY, windows: ['08:15'], days: [], count: 3 }), [])
  assert.deepEqual(planSlots({ now: MONDAY, windows: ['08:15'], count: 0 }), [])
})

test('describeSlot renders a readable stamp', () => {
  assert.equal(describeSlot('2026-01-05T08:15:00.000Z'), 'Mon 2026-01-05 08:15Z')
})

/* -------------------------------------------------------------------------- */
/* The scheduling stage                                                        */
/* -------------------------------------------------------------------------- */

const slotSettings = {
  min_lint_score: 70,
  schedule_per_run: 5,
  posting_windows: ['08:15', '13:45'],
  posting_days: [1, 2, 3, 4, 5],
  posts_per_day: 2,
  min_hours_between_posts: 4,
  schedule_horizon_days: 45,
  publish_channel: 'outbox',
}

function seedDrafts(db, rows) {
  db.prepare(
    'INSERT INTO targets (id, name, company, region, active, created_at) VALUES (1, ?, ?, ?, 1, ?)',
  ).run('T', 'C', 'UK', nowIso())
  const stmt = db.prepare(
    'INSERT INTO drafts (id, target_id, inbound_post, lint, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)',
  )
  for (const [id, score, status] of rows) {
    stmt.run(id, 'copy ' + id, JSON.stringify({ score, passed: score >= 70 }), status, nowIso(), nowIso())
  }
}

test('scheduleVerifiedDrafts queues passing drafts and demotes failing ones', () => {
  const db = openDb(':memory:')
  seedDrafts(db, [[1, 96, 'verified'], [2, 20, 'verified']])

  const res = scheduleVerifiedDrafts(db, { settings: slotSettings })
  assert.equal(res.scheduled, 1)
  assert.equal(res.skipped, 1, 'the failing draft must be sent back, not queued')
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id = 1').get().status, 'scheduled')
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id = 2').get().status, 'needs_review')

  const rows = db.prepare('SELECT * FROM schedules').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].channel, 'outbox')
  assert.equal(rows[0].status, 'pending')
  assert.ok(new Date(rows[0].scheduled_at).getTime() > Date.now(), 'slot must be in the future')
})

test('scheduleVerifiedDrafts does not queue the same draft twice', () => {
  const db = openDb(':memory:')
  seedDrafts(db, [[1, 96, 'verified']])
  assert.equal(scheduleVerifiedDrafts(db, { settings: slotSettings }).scheduled, 1)
  assert.equal(scheduleVerifiedDrafts(db, { settings: slotSettings }).scheduled, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schedules').get().n, 1)
})

test('re-running the scheduler books later slots, not the same one', () => {
  const db = openDb(':memory:')
  seedDrafts(db, [[1, 96, 'verified'], [2, 95, 'verified'], [3, 94, 'verified']])

  assert.equal(scheduleVerifiedDrafts(db, { settings: slotSettings, limit: 1 }).scheduled, 1)
  assert.equal(scheduleVerifiedDrafts(db, { settings: slotSettings, limit: 1 }).scheduled, 1)

  const slots = db.prepare('SELECT scheduled_at FROM schedules ORDER BY scheduled_at').all()
  assert.equal(slots.length, 2)
  assert.notEqual(slots[0].scheduled_at, slots[1].scheduled_at, 'slots must not collide')
  const gap = new Date(slots[1].scheduled_at).getTime() - new Date(slots[0].scheduled_at).getTime()
  assert.ok(gap >= slotSettings.min_hours_between_posts * H, 'gap was ' + gap / H + 'h')
})

test('the scheduled draft survives the publish gate', async () => {
  const db = openDb(':memory:')
  seedDrafts(db, [[1, 96, 'verified']])
  scheduleVerifiedDrafts(db, { settings: slotSettings })

  // Force the slot into the past so publishDue treats it as due.
  db.prepare('UPDATE schedules SET scheduled_at = ?').run(new Date(Date.now() - 60000).toISOString())
  const res = await publishDue(db, { kind: 'outbox', settings: slotSettings })
  assert.equal(res.published.length, 1, JSON.stringify(res.failed))
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id = 1').get().status, 'published')
})


test('editing a queued draft into failure blocks its pending slot', () => {
  const db = openDb(':memory:')
  seedDrafts(db, [[1, 96, 'verified']])
  assert.equal(scheduleVerifiedDrafts(db, { settings: slotSettings }).scheduled, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE status = 'pending'").get().n, 1)

  const blocked = blockPendingSchedules(db, { draftId: 1, score: 12, minScore: 70 })
  assert.equal(blocked, 1, 'the queued slot should have been blocked')

  const row = db.prepare('SELECT * FROM schedules WHERE draft_id = 1').get()
  assert.equal(row.status, 'failed')
  assert.match(row.last_error, /verification failed after editing/)
  assert.match(row.last_error, /edit the draft and schedule it again/)

  // And it must stay unpublished if the scheduler later runs.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE status = 'pending'").get().n, 0)
})

test('blockPendingSchedules leaves published and cancelled slots alone', () => {
  const db = openDb(':memory:')
  seedDrafts(db, [[1, 96, 'verified']])
  scheduleVerifiedDrafts(db, { settings: slotSettings })
  db.prepare("UPDATE schedules SET status = 'published', published_url = 'x' WHERE draft_id = 1").run()

  const blocked = blockPendingSchedules(db, { draftId: 1, score: 0, minScore: 70 })
  assert.equal(blocked, 0, 'a published post must not be retracted by an edit')

  const row = db.prepare('SELECT * FROM schedules WHERE draft_id = 1').get()
  assert.equal(row.status, 'published')
  assert.equal(row.last_error, null)
})


/* -------------------------------------------------------------------------- */
/* Authentication                                                              */
/* -------------------------------------------------------------------------- */

test('passwords are salted, hashed, and verified in constant time', () => {
  const a = hashPassword('correct horse battery staple')
  const b = hashPassword('correct horse battery staple')

  assert.match(a, /^scrypt\$16384\$8\$1\$/)
  assert.notEqual(a, b, 'the same password must not produce the same hash')
  assert.ok(!a.includes('correct horse'), 'the plaintext must not appear in the hash')

  assert.equal(verifyPassword('correct horse battery staple', a), true)
  assert.equal(verifyPassword('wrong password', a), false)
  assert.equal(verifyPassword('', a), false)
})

test('verifyPassword rejects malformed and hostile stored values', () => {
  for (const bad of ['', 'nonsense', 'scrypt$1$2', 'bcrypt$1$2$3$4$5', null, undefined, '$$$$$']) {
    assert.equal(verifyPassword('anything', bad), false, 'accepted: ' + String(bad))
  }
})

test('session lifecycle: create, read, revoke', () => {
  const db = openDb(':memory:')
  const { token, expires_at } = createSession(db, { username: 'admin', days: 7 })
  assert.ok(token && token.length >= 32)
  assert.ok(new Date(expires_at).getTime() > Date.now())

  const session = getSession(db, token)
  assert.ok(session, 'the session should be readable')
  assert.equal(session.username, 'admin')

  // The raw token must never be stored.
  const stored = db.prepare('SELECT token_hash FROM sessions').get()
  assert.notEqual(stored.token_hash, token, 'the token must be stored hashed')

  assert.equal(destroySession(db, token), 1)
  assert.equal(getSession(db, token), null, 'a revoked session must not resolve')
})

test('expired sessions are rejected and cleaned up', () => {
  const db = openDb(':memory:')
  const { token } = createSession(db, { username: 'admin', days: 7 })
  db.prepare('UPDATE sessions SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString())

  assert.equal(getSession(db, token), null, 'an expired session must not authenticate')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'it should be pruned on read')

  // pruneSessions clears rows that nobody tried to use.
  createSession(db, { username: 'admin', days: 7 })
  db.prepare('UPDATE sessions SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString())
  assert.equal(pruneSessions(db), 1)
})

test('unknown or absent session tokens do not authenticate', () => {
  const db = openDb(':memory:')
  assert.equal(getSession(db, 'not-a-real-token'), null)
  assert.equal(getSession(db, ''), null)
  assert.equal(getSession(db, null), null)
  assert.equal(getSession(db, undefined), null)
})

test('cookie parsing survives real-world headers', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: 1 ? '1' : '', b: '2' })
  assert.equal(parseCookies('orbit_session=abc%3Ddef').orbit_session, 'abc=def')
  assert.deepEqual(parseCookies(''), {})
  assert.deepEqual(parseCookies(undefined), {})
  assert.equal(parseCookies('novalue; x=1').x, '1')
})

test('the session cookie carries the right security attributes', () => {
  const plain = sessionCookie('tok', { maxAge: 604800 })
  assert.ok(plain.startsWith(SESSION_COOKIE + '=tok'))
  assert.match(plain, /HttpOnly/, 'must not be readable from JavaScript')
  assert.match(plain, /SameSite=Lax/, 'must not ride along on cross-site POSTs')
  assert.match(plain, /Path=\//)
  assert.match(plain, /Max-Age=604800/)
  assert.ok(!/Secure/.test(plain), 'Secure must be opt-in for plain-HTTP localhost')

  const secure = sessionCookie('tok', { maxAge: 0, secure: true })
  assert.match(secure, /Secure/)
  assert.match(secure, /Max-Age=0/, 'Max-Age=0 is how the cookie is cleared on logout')
})

test('login throttle blocks after repeated failures and frees on success', () => {
  const throttle = createLoginThrottle({ max: 3, windowMs: 60000, blockMs: 60000 })

  assert.equal(throttle.check('1.2.3.4').allowed, true)
  assert.equal(throttle.fail('1.2.3.4'), false) // 1
  assert.equal(throttle.fail('1.2.3.4'), false) // 2
  assert.equal(throttle.fail('1.2.3.4'), true, 'the third failure should trip the block')

  const blocked = throttle.check('1.2.3.4')
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.retryAfterMs > 0)

  // A different address is unaffected.
  assert.equal(throttle.check('5.6.7.8').allowed, true)

  // A successful login clears the counter.
  throttle.reset('1.2.3.4')
  assert.equal(throttle.check('1.2.3.4').allowed, true)
})

test('the throttle window expires on its own', () => {
  const throttle = createLoginThrottle({ max: 2, windowMs: -1, blockMs: 0 })
  throttle.fail('ip')
  throttle.fail('ip')
  // windowMs of -1 means every check starts a fresh window.
  assert.equal(throttle.check('ip').allowed, true)
})

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

let passed = 0
let failed = 0
const failures = []

for (const t of tests) {
  try {
    await t.fn()
    passed++
    console.log(`  \u001b[32mPASS\u001b[0m  ${t.name}`)
  } catch (err) {
    failed++
    failures.push({ name: t.name, err })
    console.log(`  \u001b[31mFAIL\u001b[0m  ${t.name}`)
    console.log(`        ${err.message.split('\n').slice(0, 4).join('\n        ')}`)
  }
}

console.log(`\n  ${passed} passed, ${failed} failed, ${tests.length} total\n`)
if (failed) {
  console.error('Failures:')
  for (const f of failures) console.error(`  - ${f.name}`)
}
process.exit(failed ? 1 : 0)
