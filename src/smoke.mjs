#!/usr/bin/env node
/**
 * End-to-end API smoke test. Run against a live server:
 *
 *   npm start                 # in one terminal
 *   npm run smoke             # in another
 *
 * It writes real rows into the database and, with the default `outbox`
 * publisher, writes files under ./data/outbox. Nothing is sent anywhere.
 */

// Defaults to the backend directly. Point ORBIT_URL at the frontend
// (http://127.0.0.1:3020) to exercise the proxy path instead.
const BASE = process.env.ORBIT_URL || `http://127.0.0.1:${process.env.PORT || 8040}`
const TOKEN = process.env.ORBIT_TOKEN || ''

let passed = 0
let failed = 0
const failures = []

const c = {
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  red: (s) => `\u001b[31m${s}\u001b[0m`,
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status, body: json }
}

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ${c.green('PASS')}  ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ${c.red('FAIL')}  ${name}`)
    if (detail) console.log(`        ${c.dim(String(detail).slice(0, 300))}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForRun(runId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { body } = await api('GET', `/api/runs/${runId}`)
    if (body?.status && body.status !== 'running') return body
    await sleep(400)
  }
  return null
}

/* -------------------------------------------------------------------------- */

console.log(`\n${c.bold('Orbit smoke test')}  ${c.dim(BASE)}\n`)

// 1. Liveness
const health = await api('GET', '/api/health')
check('GET /api/health returns ok', health.status === 200 && health.body?.ok === true, JSON.stringify(health.body))
console.log(`        ${c.dim(`llm=${health.body?.llm} publisher=${health.body?.publisher?.kind} scraper=${health.body?.scraper}`)}`)

const stats0 = await api('GET', '/api/stats')
check('GET /api/stats returns counters', stats0.status === 200 && typeof stats0.body?.targets === 'number', JSON.stringify(stats0.body))

// 2. Optional auth is enforced when a token is configured.
if (TOKEN) {
  const unauth = await fetch(`${BASE}/api/stats`)
  check('unauthenticated request is rejected when ORBIT_TOKEN is set', unauth.status === 401, `status ${unauth.status}`)
}

// 3. Make sure there is something to work with.
let drafts = (await api('GET', '/api/drafts')).body?.items ?? []
if (!drafts.length) {
  console.log(`  ${c.dim('no drafts yet — running the full pipeline first')}`)
  const started = await api('POST', '/api/pipeline/run', { mode: 'full' })
  check('POST /api/pipeline/run queues a run', started.status === 202 && started.body?.run_id, JSON.stringify(started.body))
  const finished = await waitForRun(started.body.run_id)
  check('pipeline run completes', finished?.status === 'succeeded', finished?.status)
  console.log(`        ${c.dim(`stats: ${JSON.stringify(finished?.stats)}`)}`)
  drafts = (await api('GET', '/api/drafts')).body?.items ?? []
}

check('drafts exist after the pipeline', drafts.length > 0, `found ${drafts.length}`)
if (!drafts.length) {
  console.log(`\n  ${c.red('Cannot continue without a draft.')}\n`)
  process.exit(1)
}

const draftId = drafts[0].id

// 4. The verification gate. This is the single most important behaviour.
const bad = await api('PATCH', `/api/drafts/${draftId}`, {
  inbound_post:
    "In today's fast-paced cyber landscape, we delve into a robust, seamless paradigm. 🚀 Agree?",
})
check('editing into bad copy fails verification', bad.body?.draft?.lint?.passed === false, JSON.stringify(bad.body?.draft?.lint?.violations))
check('a failing draft reports hard violations', (bad.body?.draft?.lint?.violations ?? []).some((v) => v.severity === 'hard'))

const blocked = await api('POST', `/api/drafts/${draftId}/schedule`, {
  scheduled_at: new Date(Date.now() + 60_000).toISOString(),
  channel: 'linkedin_company',
})
check('scheduling a draft that fails verification is refused with 409', blocked.status === 409, `status ${blocked.status} ${JSON.stringify(blocked.body)}`)

// 5. Recover it, then schedule successfully.
const regen = await api('POST', `/api/drafts/${draftId}/regenerate`, {})
check('regenerate produces a passing draft', regen.body?.draft?.lint?.passed === true, JSON.stringify(regen.body?.draft?.lint?.violations))
const goodDraftId = regen.body?.draft?.id ?? draftId

const scheduled = await api('POST', `/api/drafts/${goodDraftId}/schedule`, {
  scheduled_at: new Date(Date.now() - 1000).toISOString(),
  channel: 'outbox',
})
check('scheduling a verified draft succeeds', scheduled.status === 200 && scheduled.body?.schedule?.id, JSON.stringify(scheduled.body))

// 6. Publish it (due now).
const publish = await api('POST', '/api/publish/run', {})
check('POST /api/publish/run publishes the due item', publish.body?.published?.length >= 1, JSON.stringify(publish.body))
check('publish reports no failures', (publish.body?.failed ?? []).length === 0, JSON.stringify(publish.body?.failed))

const scheduleList = await api('GET', '/api/schedule?status=published')
check('the published item appears in the scheduler as published', (scheduleList.body?.items ?? []).length >= 1)

// 6b. Auto-scheduling: verified drafts land in future posting slots.
const allPosts = (await api('GET', '/api/posts?limit=50')).body?.items ?? []
const undrafted = allPosts.find((p) => !p.draft_id)
if (undrafted) {
  const made = await api('POST', '/api/generate', { post_id: undrafted.id, mode: 'both' })
  check(
    'POST /api/generate creates a draft',
    made.status === 200 && Boolean(made.body?.draft?.id),
    JSON.stringify(made.body).slice(0, 200),
  )

  const auto = await api('POST', '/api/schedule/auto', {})
  check(
    'POST /api/schedule/auto queues a verified draft',
    auto.status === 200 && (auto.body?.scheduled ?? 0) >= 1,
    JSON.stringify(auto.body),
  )

  const slots = auto.body?.slots ?? []
  check(
    'auto-scheduled slots are in the future',
    slots.length > 0 && slots.every((t) => new Date(t).getTime() > Date.now()),
    JSON.stringify(slots),
  )

  // A queued draft that is then edited into failure must not stay queued
  // looking like it is about to fire.
  const queuedId = made.body?.draft?.id
  if (queuedId && (auto.body?.scheduled ?? 0) >= 1) {
    const sabotage = await api('PATCH', `/api/drafts/${queuedId}`, {
      inbound_post:
        "In today's fast-paced cyber landscape, we delve into a robust, seamless paradigm. 🚀 Agree?",
    })
    check(
      'editing a queued draft into failure fails verification',
      sabotage.body?.draft?.lint?.passed === false,
    )

    const queue = await api('GET', '/api/schedule')
    const mine = (queue.body?.items ?? []).filter((s) => s.draft_id === queuedId)
    check(
      'its queued slot is blocked rather than left pending',
      mine.length > 0 && mine.every((s) => s.status !== 'pending'),
      JSON.stringify(mine.map((s) => s.status)),
    )
  }
} else {
  check('an undrafted post was available for the auto-schedule check', false, 'no undrafted post found')
}

// 7. Topics and the market view.
const topics = await api('GET', '/api/topics')
check('GET /api/topics returns clusters', (topics.body?.items ?? []).length > 0, `total ${topics.body?.total}`)

const posts = await api('GET', '/api/posts?region=CH&limit=5')
check('GET /api/posts filters by region', (posts.body?.items ?? []).every((p) => p.region === 'CH'))

const radar = await api('GET', '/api/targets?region=UK')
check('GET /api/targets filters by region', (radar.body?.items ?? []).every((t) => t.region === 'UK'))

// 8. Watchlist import validation.
// The URL is unique per run so the test is re-runnable; the row is removed at
// the end so repeated runs do not accumulate junk in the watchlist.
const uniqueUrl = `https://www.linkedin.com/in/orbit-smoke-${Date.now().toString(36)}`
const csv = `name,company,region,linkedin_url\nSmoke Test,Smoke Co,CH,${uniqueUrl}`
const imported = await api('POST', '/api/targets/import', { csv })
check('CSV watchlist import works', imported.body?.imported === 1, JSON.stringify(imported.body))

const reimported = await api('POST', '/api/targets/import', { csv })
check(
  're-importing the same URL is idempotent',
  reimported.body?.imported === 0 && reimported.body?.skipped === 1,
  JSON.stringify(reimported.body),
)

const badImport = await api('POST', '/api/targets/import', { csv: 'name\nNo URL Here' })
check('import rejects rows with no URL', (badImport.body?.errors ?? []).length === 1, JSON.stringify(badImport.body))

const cleanup = await api('GET', '/api/targets?q=Smoke%20Test')
for (const t of cleanup.body?.items ?? []) {
  const del = await api('DELETE', `/api/targets/${t.id}`)
  if (t.linkedin_url === uniqueUrl) {
    check('DELETE /api/targets/:id removes the test row', del.status === 200, JSON.stringify(del.body))
  }
}

// 9. Website pipeline.
const plan = await api('POST', '/api/website/plan', { kind: 'insight' })
check('POST /api/website/plan creates a planned page', plan.status === 200 && plan.body?.update?.id, JSON.stringify(plan.body).slice(0, 200))

if (plan.body?.update?.id) {
  const apply = await api('POST', `/api/website/updates/${plan.body.update.id}/apply`, {})
  check('applying the page writes it through the configured writer', apply.status === 200 && apply.body?.status === 'applied', JSON.stringify(apply.body).slice(0, 300))
  check('apply reports the files it wrote', (apply.body?.written ?? []).length > 0, JSON.stringify(apply.body?.written))
}

// 10. Inbound tracking.
const targetId = radar.body?.items?.[0]?.id
if (targetId) {
  const engagement = await api('POST', '/api/engagements', {
    target_id: targetId,
    type: 'comment',
    our_post_url: 'https://www.linkedin.com/feed/update/urn:li:share:smoke',
    notes: 'smoke test',
  })
  check('POST /api/engagements records an inbound signal', engagement.status === 200 && engagement.body?.engagement?.warm === true, JSON.stringify(engagement.body).slice(0, 200))

  const list = await api('GET', '/api/engagements')
  check('GET /api/engagements surfaces warm leads', (list.body?.warm_leads ?? 0) >= 1, `warm_leads=${list.body?.warm_leads}`)
}

const badEngagement = await api('POST', '/api/engagements', { target_id: targetId, type: 'nonsense' })
check('invalid engagement type is rejected', badEngagement.status === 400)

// 11. Runs and settings.
const runs = await api('GET', '/api/runs?limit=5')
check('GET /api/runs lists recent runs', (runs.body?.items ?? []).length > 0, `total ${runs.body?.total}`)

const settings = await api('GET', '/api/settings')
check('GET /api/settings returns the editable config', typeof settings.body?.our_focus === 'string')

const patched = await api('PATCH', '/api/settings', { our_company: 'Smoke Test Ltd' })
check('PATCH /api/settings persists a change', patched.body?.settings?.our_company === 'Smoke Test Ltd')
await api('PATCH', '/api/settings', { our_company: settings.body?.our_company })

const rules = await api('GET', '/api/rules')
check('GET /api/rules exposes the house style', Array.isArray(rules.body?.banned_hard) && rules.body.banned_hard.length > 0)

// 12. SSE endpoint opens.
try {
  const controller = new AbortController()
  const sse = await fetch(`${BASE}/api/stream`, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    signal: controller.signal,
  })
  const reader = sse.body.getReader()
  const chunk = await Promise.race([
    reader.read(),
    sleep(3000).then(() => null),
  ])
  controller.abort()
  check('GET /api/stream opens an event stream', sse.status === 200 && Boolean(chunk?.value), `status ${sse.status}`)
} catch (err) {
  check('GET /api/stream opens an event stream', false, err.message)
}

/* -------------------------------------------------------------------------- */

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed) {
  console.error(`${c.red('Failures:')}`)
  for (const f of failures) console.error(`  - ${f}`)
}
process.exit(failed ? 1 : 0)
