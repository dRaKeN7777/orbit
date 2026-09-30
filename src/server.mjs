/**
 * Orbit HTTP server.
 *
 * Node built-ins only — no framework, no build step, no dependency install.
 * Serves the JSON API described in docs/API.md and the static SPA in public/.
 */

import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { envConfig, ROOT, VERSION, llmMode, authRequired } from './config.mjs'
import { openDb, getSettings, setSettings, nowIso } from './db.mjs'
import { lint, findSpecificity, BANNED_HARD, BANNED_SOFT } from './lib/lint.mjs'
import { buildDiagram } from './lib/diagram.mjs'
import { rasterStatus, svgToPng } from './lib/raster.mjs'
import { buildDraftDiagram } from './lib/media.mjs'
import {
  clearSecret,
  getSecret,
  listSecrets,
  resolveSecret,
  setSecret,
  setSecretResolver,
} from './lib/secrets.mjs'
import {
  buildAuthorizeUrl,
  clearToken,
  connectionStatus,
  consumeState,
  exchangeCodeForToken,
  fetchMemberUrn,
  saveToken,
} from './lib/linkedin.mjs'
import { ANTI_AI_RULES, REGION_NOTES, generateAssets, llmStatus } from './lib/llm.mjs'
import { ingest } from './lib/ingest.mjs'
import { listTopics, recomputeTopics } from './lib/topics.mjs'
import { publisherStatus } from './lib/publish.mjs'
import {
  blockPendingSchedules,
  publishDue,
  runPipeline,
  scheduleVerifiedDrafts,
  startRun,
} from './lib/pipeline.mjs'
import {
  applyWebsiteUpdate, listWebsiteUpdates, planWebsiteUpdate, rejectWebsiteUpdate, getWebsiteUpdate,
} from './lib/website.mjs'
import { startScheduler } from './lib/cron.mjs'
import { ensureSeed } from './seed.mjs'
import { parseCsv } from './lib/csv.mjs'
import { createStaticHandler } from './lib/static.mjs'
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
import { importTargets } from './lib/targets.mjs'

if (envConfig.auth.mode === 'on' && !envConfig.auth.password) {
  console.error(
    '\n  ORBIT_AUTH=on requires ORBIT_ADMIN_PASSWORD.\n' +
      '  Refusing to start rather than running with auth enabled and no credential.\n',
  )
  process.exit(1)
}

const db = openDb(envConfig.dbPath)
// Lets the intelligence layer read a key saved through the UI.
setSecretResolver((name) => getSecret(db, name))
const startTime = Date.now()
const PUBLIC_DIR = resolve(ROOT, 'public')

/* -------------------------------------------------------------------------- */
/* SSE hub                                                                     */
/* -------------------------------------------------------------------------- */

const clients = new Set()
function emit(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) {
    try {
      res.write(payload)
    } catch {
      clients.delete(res)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const json = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

const fail = (res, status, message) => json(res, status, { error: message })

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const type = req.headers['content-type'] ?? ''
  if (type.includes('application/json')) {
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('invalid JSON body')
    }
  }
  if (type.includes('text/csv') || type.includes('text/plain')) return { csv: text }
  try {
    return JSON.parse(text)
  } catch {
    return { csv: text }
  }
}

const parseJson = (v, fallback) => {
  if (v === null || v === undefined || v === '') return fallback
  try {
    const out = JSON.parse(v)
    return out ?? fallback
  } catch {
    return fallback
  }
}

const serializeDraft = (row) =>
  row && {
    ...row,
    lint: parseJson(row.lint, { score: 0, passed: false, violations: [], metrics: {} }),
    visual: parseJson(row.visual, { kind: 'diagram' }),
  }

const serializePost = (row) =>
  row && {
    ...row,
    topics: parseJson(row.topics, []),
  }

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

const loginThrottle = createLoginThrottle()

/**
 * The admin user is re-seeded from the environment on every boot, so .env is
 * the single source of truth and a forgotten password is fixed by editing it
 * rather than by surgery on the database.
 */
function seedAdminUser() {
  if (!envConfig.auth.password) return null
  const now = nowIso()
  db.prepare(
    `INSERT INTO users (username, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
  ).run(envConfig.auth.username, hashPassword(envConfig.auth.password), now, now)
  return envConfig.auth.username
}

/**
 * Accepts either a session cookie (the browser) or the ORBIT_TOKEN bearer
 * (scripts, cron, the smoke test).
 * @returns {{ok:boolean, via:string|null, user:string|null}}
 */
function authenticate(req, url) {
  const cookies = parseCookies(req.headers.cookie)
  const session = getSession(db, cookies[SESSION_COOKIE])
  if (session) return { ok: true, via: 'session', user: session.username }

  if (envConfig.token) {
    const header = req.headers.authorization
    const query = url ? url.searchParams.get('token') : null
    if (header === `Bearer ${envConfig.token}` || query === envConfig.token) {
      return { ok: true, via: 'token', user: 'token' }
    }
  }
  return { ok: false, via: null, user: null }
}

/** Reachable without a session, so the login screen can load and render. */
const PUBLIC_API = new Set([
  '/api/health',
  '/api/auth/session',
  '/api/auth/login',
  '/api/auth/logout',
])

// Keyed on the socket address, not a client-supplied header, so rotating
// X-Forwarded-For cannot evade the throttle.
const clientIp = (req) => req.socket?.remoteAddress ?? 'unknown'

/* -------------------------------------------------------------------------- */
/* Router                                                                      */
/* -------------------------------------------------------------------------- */

const routes = []
const route = (method, pattern, handler) => routes.push({ method, pattern, handler })

function matchRoute(method, pathname) {
  const segs = pathname.split('/').filter(Boolean)
  for (const r of routes) {
    if (r.method !== method) continue
    const parts = r.pattern.split('/').filter(Boolean)
    if (parts.length !== segs.length) continue
    const params = {}
    let ok = true
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(segs[i])
      else if (parts[i] !== segs[i]) {
        ok = false
        break
      }
    }
    if (ok) return { handler: r.handler, params }
  }
  return null
}

const q = (url, key, fallback = null) => url.searchParams.get(key) ?? fallback
const qInt = (url, key, fallback) => {
  const n = Number.parseInt(url.searchParams.get(key) ?? '', 10)
  return Number.isFinite(n) ? n : fallback
}

/* --- Auth routes ---------------------------------------------------------- */

route('GET', '/api/auth/session', async (req, res) => {
  const auth = authenticate(req)
  json(res, 200, {
    authenticated: !authRequired || auth.ok,
    auth_required: authRequired,
    user: auth.ok && auth.via === 'session' ? auth.user : null,
    via: auth.via,
  })
})

route('POST', '/api/auth/login', async (req, res, { body }) => {
  if (!authRequired) {
    return json(res, 200, { ok: true, authenticated: true, auth_required: false, user: null })
  }

  const ip = clientIp(req)
  const gate = loginThrottle.check(ip)
  if (!gate.allowed) {
    const mins = Math.max(1, Math.ceil(gate.retryAfterMs / 60_000))
    res.setHeader('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)))
    return fail(res, 429, `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`)
  }

  const username = String(body?.username ?? '').trim()
  const password = String(body?.password ?? '')
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username)

  const ok =
    Boolean(row) &&
    username === envConfig.auth.username &&
    verifyPassword(password, row.password_hash)

  if (!ok) {
    const justBlocked = loginThrottle.fail(ip)
    // Identical wording whether the account exists or the password was wrong.
    return fail(
      res,
      401,
      justBlocked
        ? 'Too many failed attempts. Try again in 15 minutes.'
        : 'Invalid username or password.',
    )
  }

  loginThrottle.reset(ip)
  const { token, expires_at } = createSession(db, {
    username,
    userAgent: req.headers['user-agent'],
    ip,
    days: envConfig.auth.sessionDays,
  })
  res.setHeader('Set-Cookie', [
    sessionCookie(token, {
      maxAge: envConfig.auth.sessionDays * 86_400,
      secure: envConfig.auth.cookieSecure,
    }),
  ])
  json(res, 200, { ok: true, authenticated: true, user: username, expires_at })
})

route('POST', '/api/auth/logout', async (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  const revoked = destroySession(db, token)
  res.setHeader('Set-Cookie', [
    sessionCookie('', { maxAge: 0, secure: envConfig.auth.cookieSecure }),
  ])
  json(res, 200, { ok: true, authenticated: false, revoked })
})

/* --- API keys ------------------------------------------------------------- */

route('GET', '/api/keys', async (req, res) => {
  json(res, 200, { items: listSecrets(db) })
})

route('PUT', '/api/keys/:name', async (req, res, { params, body }) => {
  const value = body?.value
  if (typeof value !== 'string') return fail(res, 400, 'body must be { "value": "..." }')
  try {
    setSecret(db, params.name, value)
    json(res, 200, { ok: true, keys: listSecrets(db) })
  } catch (err) {
    fail(res, 400, err.message)
  }
})

route('DELETE', '/api/keys/:name', async (req, res, { params }) => {
  clearSecret(db, params.name)
  json(res, 200, { ok: true, keys: listSecrets(db) })
})

/* --- LinkedIn OAuth ------------------------------------------------------- */

/** Where the browser is sent back to after authorising. */
function appOrigin() {
  const raw = envConfig.frontend.host
  const host = raw === '0.0.0.0' || raw === '127.0.0.1' ? 'localhost' : raw
  return `http://${host}:${envConfig.frontend.port}`
}

route('GET', '/api/linkedin/status', async (req, res) => {
  json(res, 200, connectionStatus(db))
})

// A browser navigation, not a fetch: redirects to linkedin.com to authorise.
route('GET', '/api/linkedin/connect', async (req, res) => {
  try {
    const { url } = buildAuthorizeUrl()
    res.writeHead(302, { Location: url })
    res.end()
  } catch (err) {
    res.writeHead(302, {
      Location: `${appOrigin()}/?${new URLSearchParams({ linkedin: 'error', message: err.message })}`,
    })
    res.end()
  }
})

route('GET', '/api/linkedin/callback', async (req, res, { url }) => {
  const back = (params) => {
    res.writeHead(302, {
      Location: `${appOrigin()}/?${new URLSearchParams(params)}#runs`,
    })
    res.end()
  }

  const oauthError = url.searchParams.get('error')
  if (oauthError) {
    return back({
      linkedin: 'error',
      message: url.searchParams.get('error_description') ?? oauthError,
    })
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return back({ linkedin: 'error', message: 'missing code or state' })

  // Single-use state, so a replayed callback cannot be exchanged twice.
  const ctx = consumeState(state)
  if (!ctx) {
    return back({ linkedin: 'error', message: 'invalid or expired state — start the connect again' })
  }

  try {
    const token = await exchangeCodeForToken(code, ctx.redirectUri)
    // Record which member authorised, so the publisher can fall back to their
    // own profile when the app only has self-serve scopes.
    const memberUrn = await fetchMemberUrn(token.access_token)
    const saved = saveToken(db, token, { authorUrn: memberUrn })
    return back({
      linkedin: 'connected',
      message: saved.scope ?? '',
      expires: saved.expires_at ?? '',
    })
  } catch (err) {
    return back({ linkedin: 'error', message: err.message })
  }
})

route('POST', '/api/linkedin/disconnect', async (req, res) => {
  const removed = clearToken(db)
  json(res, 200, { ok: true, removed })
})

/* --- Core ----------------------------------------------------------------- */

route('GET', '/api/health', async (req, res) => {
  json(res, 200, {
    ok: true,
    version: VERSION,
    llm: resolveSecret('DEEPSEEK_API_KEY') ? 'deepseek' : 'offline',
    llm_detail: llmStatus,
    publisher: publisherStatus(),
    scraper: envConfig.scraper.provider,
    website_target: envConfig.website.target,
    uptime_s: Math.round((Date.now() - startTime) / 1000),
    worker: Boolean(scheduler),
    diagram_png: rasterStatus().available,
  })
})

route('GET', '/api/stats', async (req, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p)?.n ?? 0
  const regionRows = db.prepare('SELECT region, COUNT(*) AS n FROM targets GROUP BY region').all()
  const statusRows = db.prepare('SELECT status, COUNT(*) AS n FROM drafts GROUP BY status').all()
  json(res, 200, {
    targets: one('SELECT COUNT(*) AS n FROM targets'),
    posts: one('SELECT COUNT(*) AS n FROM posts'),
    topics: one('SELECT COUNT(*) AS n FROM topics'),
    drafts: one('SELECT COUNT(*) AS n FROM drafts'),
    scheduled: one("SELECT COUNT(*) AS n FROM schedules WHERE status = 'pending'"),
    published: one("SELECT COUNT(*) AS n FROM schedules WHERE status = 'published'"),
    engagements: one('SELECT COUNT(*) AS n FROM engagements'),
    website_updates: one('SELECT COUNT(*) AS n FROM website_updates'),
    targets_by_region: Object.fromEntries(regionRows.map((r) => [r.region, r.n])),
    pipeline: Object.fromEntries(statusRows.map((r) => [r.status, r.n])),
  })
})

route('GET', '/api/rules', async (req, res) => {
  json(res, 200, {
    rules: ANTI_AI_RULES,
    banned_hard: BANNED_HARD,
    banned_soft: BANNED_SOFT,
    region_notes: REGION_NOTES,
  })
})

route('GET', '/api/settings', async (req, res) => json(res, 200, getSettings(db)))
route('PATCH', '/api/settings', async (req, res, { body }) => {
  const updated = setSettings(db, body ?? {})
  emit({ type: 'stats', payload: { settings_changed: true } })
  json(res, 200, { ok: true, settings: updated })
})

/* --- Targets -------------------------------------------------------------- */

route('GET', '/api/targets', async (req, res, { url }) => {
  const region = q(url, 'region')
  const search = q(url, 'q')
  const limit = qInt(url, 'limit', 500)
  const offset = qInt(url, 'offset', 0)

  const where = []
  const params = []
  if (region) {
    where.push('t.region = ?')
    params.push(region)
  }
  if (search) {
    where.push('(t.name LIKE ? OR t.company LIKE ? OR t.title LIKE ?)')
    params.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total =
    db.prepare(`SELECT COUNT(*) AS n FROM targets t ${clause}`).get(...params)?.n ?? 0
  const items = db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM posts p WHERE p.target_id = t.id) AS post_count
         FROM targets t ${clause}
        ORDER BY t.region, t.company, t.name
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)
    .map((t) => ({ ...t, active: Boolean(t.active) }))

  json(res, 200, { items, total })
})

route('POST', '/api/targets/import', async (req, res, { body }) => {
  const defaultRegion = String(body?.region_default ?? 'UK').trim().toUpperCase() === 'CH' ? 'CH' : 'UK'
  let rows = []

  if (body?.csv) {
    rows = parseCsv(body.csv)
  } else if (Array.isArray(body?.urls)) {
    rows = body.urls.map((u) => ({ linkedin_url: String(u).trim(), region: defaultRegion }))
  } else if (Array.isArray(body?.targets)) {
    rows = body.targets
  } else {
    return fail(res, 400, 'provide csv, urls[] or targets[]')
  }

  const result = importTargets(db, rows, { defaultRegion })
  emit({ type: 'stats', payload: { targets_imported: result.imported } })
  json(res, 200, { ok: true, ...result })
})

route('PATCH', '/api/targets/:id', async (req, res, { params, body }) => {
  const id = Number(params.id)
  const existing = db.prepare('SELECT * FROM targets WHERE id = ?').get(id)
  if (!existing) return fail(res, 404, 'target not found')

  const allowed = ['name', 'title', 'company', 'region', 'linkedin_url', 'email', 'active', 'notes']
  const sets = []
  const values = []
  for (const key of allowed) {
    if (!(key in (body ?? {}))) continue
    sets.push(`${key} = ?`)
    let v = body[key]
    if (key === 'active') v = v ? 1 : 0
    if (key === 'region') v = String(v).toUpperCase() === 'CH' ? 'CH' : 'UK'
    values.push(v)
  }
  if (!sets.length) return fail(res, 400, 'no editable fields supplied')
  db.prepare(`UPDATE targets SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  const row = db.prepare('SELECT * FROM targets WHERE id = ?').get(id)
  json(res, 200, { ok: true, target: { ...row, active: Boolean(row.active) } })
})

route('DELETE', '/api/targets/:id', async (req, res, { params }) => {
  const info = db.prepare('DELETE FROM targets WHERE id = ?').run(Number(params.id))
  if (!info.changes) return fail(res, 404, 'target not found')
  json(res, 200, { ok: true })
})

/* --- Posts ---------------------------------------------------------------- */

route('GET', '/api/posts', async (req, res, { url }) => {
  const where = []
  const params = []
  const region = q(url, 'region')
  const targetId = qInt(url, 'target_id', null)
  const minReactions = qInt(url, 'min_reactions', null)
  const search = q(url, 'q')
  const since = q(url, 'since')

  if (region) {
    where.push('t.region = ?')
    params.push(region)
  }
  if (targetId !== null) {
    where.push('p.target_id = ?')
    params.push(targetId)
  }
  if (minReactions !== null) {
    where.push('p.reactions >= ?')
    params.push(minReactions)
  }
  if (search) {
    where.push('(p.content_text LIKE ? OR t.name LIKE ? OR t.company LIKE ?)')
    params.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }
  if (since) {
    where.push('p.posted_at >= ?')
    params.push(since)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(qInt(url, 'limit', 100), 500)

  const total =
    db
      .prepare(`SELECT COUNT(*) AS n FROM posts p JOIN targets t ON t.id = p.target_id ${clause}`)
      .get(...params)?.n ?? 0

  const items = db
    .prepare(
      `SELECT p.*, t.name AS target_name, t.company, t.title AS target_title, t.region,
              (SELECT d.id FROM drafts d WHERE d.post_id = p.id ORDER BY d.id DESC LIMIT 1) AS draft_id
         FROM posts p JOIN targets t ON t.id = p.target_id
         ${clause}
        ORDER BY p.posted_at DESC
        LIMIT ?`,
    )
    .all(...params, limit)
    .map(serializePost)

  json(res, 200, { items, total })
})

route('POST', '/api/ingest/run', async (req, res, { body }) => {
  const run = startRun(db, 'ingest', emit)
  const ids = Array.isArray(body?.target_ids) ? body.target_ids.map(Number) : null
  const targets = ids?.length
    ? db.prepare(`SELECT * FROM targets WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : db.prepare('SELECT * FROM targets WHERE active = 1').all()

  run.log(`manual ingest for ${targets.length} targets`)
  // Fire-and-forget: the client follows progress over SSE.
  ;(async () => {
    try {
      const settings = getSettings(db)
      const result = await ingest({ db, targets, log: (m, l) => run.log(m, l) })
      run.setStats(result)
      run.finish('succeeded')
      emit({ type: 'stats', payload: { ingested: result.inserted } })
    } catch (err) {
      run.log(err.message, 'error')
      run.finish('failed')
    }
  })()

  json(res, 202, { ok: true, run_id: run.id, status: 'queued' })
})

/* --- Topics --------------------------------------------------------------- */

route('GET', '/api/topics', async (req, res, { url }) => {
  const region = q(url, 'region')
  const limit = Math.min(qInt(url, 'limit', 100), 200)
  const items = listTopics(db, { limit, region })
  json(res, 200, { items, total: items.length })
})

route('POST', '/api/topics/recompute', async (req, res, { body }) => {
  const days = Number.isFinite(body?.days) ? body.days : 14
  const run = startRun(db, 'topics', emit)
  try {
    const result = recomputeTopics(db, { days, log: (m, l) => run.log(m, l) })
    run.setStats(result)
    run.finish('succeeded')
    json(res, 200, { ok: true, ...result, run_id: run.id })
  } catch (err) {
    run.log(err.message, 'error')
    run.finish('failed')
    fail(res, 500, err.message)
  }
})

/* --- Drafts / Studio ------------------------------------------------------ */

route('GET', '/api/drafts', async (req, res, { url }) => {
  const status = q(url, 'status')
  const limit = Math.min(qInt(url, 'limit', 100), 300)
  const rows = status
    ? db
        .prepare(
          `SELECT d.*, t.name AS target_name, t.company, t.region, t.title AS target_title
             FROM drafts d
             LEFT JOIN targets t ON t.id = d.target_id
            WHERE d.status = ? ORDER BY d.id DESC LIMIT ?`,
        )
        .all(status, limit)
    : db
        .prepare(
          `SELECT d.*, t.name AS target_name, t.company, t.region, t.title AS target_title
             FROM drafts d
             LEFT JOIN targets t ON t.id = d.target_id
            ORDER BY d.id DESC LIMIT ?`,
        )
        .all(limit)
  const total = db.prepare('SELECT COUNT(*) AS n FROM drafts').get()?.n ?? 0
  json(res, 200, { items: rows.map(serializeDraft), total })
})

route('GET', '/api/drafts/:id', async (req, res, { params }) => {
  const row = db
    .prepare(
      `SELECT d.*, t.name AS target_name, t.company, t.region, t.title AS target_title
         FROM drafts d LEFT JOIN targets t ON t.id = d.target_id WHERE d.id = ?`,
    )
    .get(Number(params.id))
  if (!row) return fail(res, 404, 'draft not found')
  const post = row.post_id
    ? db.prepare('SELECT * FROM posts WHERE id = ?').get(row.post_id)
    : null
  json(res, 200, { ...serializeDraft(row), post: post ? serializePost(post) : null })
})

route('POST', '/api/generate', async (req, res, { body }) => {
  const postId = Number(body?.post_id)
  const mode = body?.mode ?? 'both'
  const post = db
    .prepare(
      `SELECT p.*, t.name AS target_name, t.company, t.title AS target_title, t.region, t.id AS t_id
         FROM posts p JOIN targets t ON t.id = p.target_id WHERE p.id = ?`,
    )
    .get(postId)
  if (!post) return fail(res, 404, 'post not found')

  const settings = getSettings(db)
  const target = {
    id: post.t_id,
    name: post.target_name,
    company: post.company,
    title: post.target_title,
    region: post.region,
  }

  try {
    const assets = await generateAssets({ post, target, settings })
    const postLint = lint(assets.inbound_post, {
      kind: 'post',
      minScore: settings.min_lint_score ?? 70,
      bannedExtra: settings.banned_extra ?? [],
    })
    const peerLint = lint(assets.peer_comment, {
      kind: 'comment',
      minScore: settings.min_lint_score ?? 70,
      bannedExtra: settings.banned_extra ?? [],
    })
    const overall = {
      score: Math.min(postLint.score, peerLint.score),
      passed: postLint.passed && peerLint.passed,
      post: postLint,
      comment: peerLint,
      violations: [...postLint.violations, ...peerLint.violations],
      metrics: postLint.metrics,
    }
    const info = db
      .prepare(
        `INSERT INTO drafts
           (post_id, target_id, source, detected_pain_point, angle, peer_comment, inbound_post,
            visual, lint, status, generator, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        post.id,
        target.id,
        body?.source === 'trend' ? 'trend' : 'inbound',
        assets.detected_pain_point ?? '',
        assets.angle ?? '',
        mode === 'post' ? '' : (assets.peer_comment ?? ''),
        mode === 'comment' ? '' : (assets.inbound_post ?? ''),
        JSON.stringify({ kind: 'diagram', spec: null, asset_path: null }),
        JSON.stringify(overall),
        overall.passed ? 'verified' : 'needs_review',
        assets.generator ?? 'unknown',
        nowIso(),
        nowIso(),
      )
    // Analysis results are useful even when only drafting was requested.
    db.prepare('UPDATE posts SET analyzed = 1, urgency = COALESCE(urgency, ?), sentiment = COALESCE(sentiment, ?) WHERE id = ?').run(
      'medium',
      'neutral',
      post.id,
    )
    const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(info.lastInsertRowid))
    emit({ type: 'stats', payload: { draft_created: Number(info.lastInsertRowid) } })
    json(res, 200, { ok: true, draft: serializeDraft({ ...row, target_name: target.name, company: target.company, region: target.region }) })
  } catch (err) {
    fail(res, 500, `generation failed: ${err.message}`)
  }
})

route('PATCH', '/api/drafts/:id', async (req, res, { params, body }) => {
  const id = Number(params.id)
  const existing = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id)
  if (!existing) return fail(res, 404, 'draft not found')

  const settings = getSettings(db)
  const inboundPost = body?.inbound_post ?? existing.inbound_post ?? ''
  const peerComment = body?.peer_comment ?? existing.peer_comment ?? ''

  const postLint = lint(inboundPost, {
    kind: 'post',
    minScore: settings.min_lint_score ?? 70,
    bannedExtra: settings.banned_extra ?? [],
  })
  const peerLint = lint(peerComment, {
    kind: 'comment',
    minScore: settings.min_lint_score ?? 70,
    bannedExtra: settings.banned_extra ?? [],
  })
  const overall = {
    score: Math.min(postLint.score, peerLint.score),
    passed: postLint.passed && peerLint.passed,
    post: postLint,
    comment: peerLint,
    violations: [...postLint.violations, ...peerLint.violations],
    metrics: postLint.metrics,
  }

  // A human edit re-runs verification. Status follows the gate unless the
  // editor explicitly set it to something terminal.
  let status = overall.passed ? 'verified' : 'needs_review'
  if (body?.status && ['approved', 'rejected', 'drafted'].includes(body.status)) {
    status = body.status
  }
  if (existing.status === 'published' && !body?.status) status = existing.status

  db.prepare(
    `UPDATE drafts SET inbound_post = ?, peer_comment = ?, lint = ?, status = ?, updated_at = ? WHERE id = ?`,
  ).run(inboundPost, peerComment, JSON.stringify(overall), status, nowIso(), id)

  // An edit can invalidate a draft that was already queued.
  if (!overall.passed) {
    const blocked = blockPendingSchedules(db, {
      draftId: id,
      score: overall.score,
      minScore: settings.min_lint_score ?? 70,
    })
    if (blocked) {
      emit({ type: 'stats', payload: { schedules_blocked: blocked } })
    }
  }

  if (body?.detected_pain_point !== undefined || body?.angle !== undefined) {
    db.prepare('UPDATE drafts SET detected_pain_point = ?, angle = ? WHERE id = ?').run(
      body?.detected_pain_point ?? existing.detected_pain_point,
      body?.angle ?? existing.angle,
      id,
    )
  }

  const row = db
    .prepare(
      `SELECT d.*, t.name AS target_name, t.company, t.region
         FROM drafts d LEFT JOIN targets t ON t.id = d.target_id WHERE d.id = ?`,
    )
    .get(id)
  json(res, 200, { ok: true, draft: serializeDraft(row) })
})

route('GET', '/api/drafts/:id/diagram.svg', async (req, res, { params }) => {
  const diagram = buildDraftDiagram(db, Number(params.id))
  if (!diagram) return fail(res, 404, 'draft not found')
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(diagram.svg),
  })
  res.end(diagram.svg)
})

// LinkedIn will not accept SVG, so this is the format you actually upload.
route('GET', '/api/drafts/:id/diagram.png', async (req, res, { params }) => {
  const diagram = buildDraftDiagram(db, Number(params.id))
  if (!diagram) return fail(res, 404, 'draft not found')
  try {
    const png = await svgToPng(diagram.svg, {
      width: diagram.width,
      height: diagram.height,
      scale: 2,
    })
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="orbit-draft-${params.id}.png"`,
    })
    res.end(png)
  } catch (err) {
    fail(res, 503, err.message)
  }
})

route('POST', '/api/drafts/:id/verify', async (req, res, { params }) => {
  const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(params.id))
  if (!row) return fail(res, 404, 'draft not found')
  const settings = getSettings(db)
  const postLint = lint(row.inbound_post ?? '', {
    kind: 'post',
    minScore: settings.min_lint_score ?? 70,
    bannedExtra: settings.banned_extra ?? [],
  })
  const peerLint = lint(row.peer_comment ?? '', {
    kind: 'comment',
    minScore: settings.min_lint_score ?? 70,
    bannedExtra: settings.banned_extra ?? [],
  })
  const overall = {
    score: Math.min(postLint.score, peerLint.score),
    passed: postLint.passed && peerLint.passed,
    post: postLint,
    comment: peerLint,
    violations: [...postLint.violations, ...peerLint.violations],
    metrics: postLint.metrics,
  }
  db.prepare('UPDATE drafts SET lint = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(overall),
    nowIso(),
    Number(params.id),
  )
  if (!overall.passed) {
    blockPendingSchedules(db, {
      draftId: Number(params.id),
      score: overall.score,
      minScore: settings.min_lint_score ?? 70,
    })
  }
  json(res, 200, { ok: true, lint: overall })
})

route('POST', '/api/drafts/:id/regenerate', async (req, res, { params, body }) => {
  const id = Number(params.id)
  const existing = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id)
  if (!existing) return fail(res, 404, 'draft not found')
  const post = db
    .prepare(
      `SELECT p.*, t.name AS target_name, t.company, t.title AS target_title, t.region, t.id AS t_id
         FROM posts p JOIN targets t ON t.id = p.target_id WHERE p.id = ?`,
    )
    .get(existing.post_id)
  if (!post) return fail(res, 409, 'the source post for this draft no longer exists')

  const settings = getSettings(db)
  const target = {
    id: post.t_id,
    name: post.target_name,
    company: post.company,
    title: post.target_title,
    region: post.region,
  }
  // Feed the verifier's own findings back in as explicit repair instructions.
  const priorLint = parseJson(existing.lint, {})
  const feedback =
    body?.feedback ||
    (priorLint.violations ?? [])
      .map((v) => `${v.rule}: ${v.detail}`)
      .join('; ') ||
    'previous attempt was rejected'

  try {
    const assets = await generateAssets({ post, target, settings, feedback })
    const postLint = lint(assets.inbound_post, {
      kind: 'post',
      minScore: settings.min_lint_score ?? 70,
      bannedExtra: settings.banned_extra ?? [],
    })
    const peerLint = lint(assets.peer_comment, {
      kind: 'comment',
      minScore: settings.min_lint_score ?? 70,
      bannedExtra: settings.banned_extra ?? [],
    })
    const overall = {
      score: Math.min(postLint.score, peerLint.score),
      passed: postLint.passed && peerLint.passed,
      post: postLint,
      comment: peerLint,
      violations: [...postLint.violations, ...peerLint.violations],
      metrics: postLint.metrics,
    }
    const info = db
      .prepare(
        `INSERT INTO drafts
           (post_id, target_id, source, topic_slug, detected_pain_point, angle, peer_comment,
            inbound_post, visual, lint, status, generator, feedback, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        post.id,
        target.id,
        existing.source,
        existing.topic_slug,
        assets.detected_pain_point ?? '',
        assets.angle ?? '',
        assets.peer_comment ?? '',
        assets.inbound_post ?? '',
        existing.visual,
        JSON.stringify(overall),
        overall.passed ? 'verified' : 'needs_review',
        assets.generator ?? 'unknown',
        feedback,
        (existing.version ?? 1) + 1,
        nowIso(),
        nowIso(),
      )
    const row = db
      .prepare(
        `SELECT d.*, t.name AS target_name, t.company, t.region
           FROM drafts d LEFT JOIN targets t ON t.id = d.target_id WHERE d.id = ?`,
      )
      .get(Number(info.lastInsertRowid))
    json(res, 200, { ok: true, draft: serializeDraft(row) })
  } catch (err) {
    fail(res, 500, `regeneration failed: ${err.message}`)
  }
})

/* --- Scheduling ----------------------------------------------------------- */

const CHANNELS = ['linkedin_company', 'linkedin_member', 'postiz', 'outbox']

route('POST', '/api/drafts/:id/schedule', async (req, res, { params, body }) => {
  const id = Number(params.id)
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id)
  if (!draft) return fail(res, 404, 'draft not found')

  const settings = getSettings(db)
  const state = parseJson(draft.lint, { passed: false, score: 0 })
  const minScore = settings.min_lint_score ?? 70
  if (!state.passed || (state.score ?? 0) < minScore) {
    return fail(
      res,
      409,
      `draft fails verification (score ${state.score ?? 0}, need ${minScore}) — fix the flagged issues in the Studio first`,
    )
  }

  const when = body?.scheduled_at ? new Date(body.scheduled_at) : null
  if (!when || Number.isNaN(when.getTime())) {
    return fail(res, 400, 'scheduled_at must be an ISO-8601 timestamp')
  }
  const channel = CHANNELS.includes(body?.channel) ? body.channel : 'linkedin_company'

  const info = db
    .prepare(
      `INSERT INTO schedules (draft_id, channel, scheduled_at, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    )
    .run(id, channel, when.toISOString(), nowIso(), nowIso())
  db.prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?').run('scheduled', nowIso(), id)

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(info.lastInsertRowid))
  emit({ type: 'stats', payload: { scheduled: schedule.id } })
  json(res, 200, { ok: true, schedule })
})

route('GET', '/api/schedule', async (req, res, { url }) => {
  const status = q(url, 'status')
  const from = q(url, 'from')
  const to = q(url, 'to')
  const where = []
  const params = []
  if (status) {
    where.push('s.status = ?')
    params.push(status)
  }
  if (from) {
    where.push('s.scheduled_at >= ?')
    params.push(from)
  }
  if (to) {
    where.push('s.scheduled_at <= ?')
    params.push(to)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const items = db
    .prepare(
      `SELECT s.*, d.inbound_post, d.topic_slug, d.lint,
              t.name AS target_name, t.company, t.region
         FROM schedules s
         JOIN drafts d ON d.id = s.draft_id
         LEFT JOIN targets t ON t.id = d.target_id
         ${clause}
        ORDER BY s.scheduled_at ASC
        LIMIT 500`,
    )
    .all(...params)
    .map((s) => ({
      ...s,
      lint: parseJson(s.lint, { score: 0, passed: false }),
      title: (s.inbound_post ?? '').split('\n')[0].slice(0, 120),
    }))
  json(res, 200, { items, total: items.length })
})

route('DELETE', '/api/schedule/:id', async (req, res, { params }) => {
  const id = Number(params.id)
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id)
  if (!row) return fail(res, 404, 'schedule not found')
  if (row.status === 'published') return fail(res, 409, 'already published')
  db.prepare("UPDATE schedules SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), id)
  db.prepare("UPDATE drafts SET status = 'verified', updated_at = ? WHERE id = ? AND status = 'scheduled'").run(
    nowIso(),
    row.draft_id,
  )
  json(res, 200, { ok: true })
})

route('POST', '/api/schedule/auto', async (req, res, { body }) => {
  const settings = getSettings(db)
  const run = startRun(db, 'schedule', emit)
  try {
    const result = scheduleVerifiedDrafts(db, {
      settings,
      limit: Number.isFinite(body?.limit) ? body.limit : null,
      log: (m, l) => run.log(m, l),
    })
    run.setStats(result)
    run.finish('succeeded')
    json(res, 200, { ok: true, ...result, run_id: run.id })
  } catch (err) {
    run.log(err.message, 'error')
    run.finish('failed')
    fail(res, 500, err.message)
  }
})

route('POST', '/api/publish/run', async (req, res, { body }) => {
  const settings = getSettings(db)
  const run = startRun(db, 'publish', emit)
  try {
    const result = await publishDue(db, { settings, run, force: Boolean(body?.force) })
    run.setStats({ published: result.published.length, failed: result.failed.length })
    run.finish('succeeded')
    json(res, 200, {
      ok: true,
      run_id: run.id,
      published: result.published,
      failed: result.failed,
      skipped: result.skipped,
    })
  } catch (err) {
    run.log(err.message, 'error')
    run.finish('failed')
    fail(res, 500, err.message)
  }
})

/* --- Engagements ---------------------------------------------------------- */

route('GET', '/api/engagements', async (req, res, { url }) => {
  const limit = Math.min(qInt(url, 'limit', 100), 500)
  const items = db
    .prepare(
      `SELECT e.*, t.name AS target_name, t.company, t.region, t.title AS target_title
         FROM engagements e LEFT JOIN targets t ON t.id = e.target_id
        ORDER BY e.detected_at DESC LIMIT ?`,
    )
    .all(limit)
    .map((e) => ({ ...e, warm: Boolean(e.warm) }))
  const warm = db.prepare('SELECT COUNT(*) AS n FROM engagements WHERE warm = 1').get()?.n ?? 0
  json(res, 200, { items, total: items.length, warm_leads: warm })
})

const ENGAGEMENT_TYPES = ['like', 'comment', 'share', 'profile_view', 'dm', 'mention', 'follow']

route('POST', '/api/engagements', async (req, res, { body }) => {
  const type = ENGAGEMENT_TYPES.includes(body?.type) ? body.type : null
  if (!type) return fail(res, 400, `type must be one of: ${ENGAGEMENT_TYPES.join(', ')}`)
  const targetId = Number(body?.target_id)
  if (!db.prepare('SELECT 1 FROM targets WHERE id = ?').get(targetId)) {
    return fail(res, 404, 'target not found')
  }
  const info = db
    .prepare(
      `INSERT INTO engagements (target_id, type, our_post_url, target_post_url, warm, notes, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      targetId,
      type,
      body?.our_post_url ?? null,
      body?.target_post_url ?? null,
      body?.warm === false ? 0 : 1,
      body?.notes ?? null,
      nowIso(),
    )
  const row = db
    .prepare(
      `SELECT e.*, t.name AS target_name, t.company, t.region
         FROM engagements e LEFT JOIN targets t ON t.id = e.target_id WHERE e.id = ?`,
    )
    .get(Number(info.lastInsertRowid))
  emit({ type: 'stats', payload: { engagement: row.id } })
  json(res, 200, { ok: true, engagement: { ...row, warm: Boolean(row.warm) } })
})

route('DELETE', '/api/engagements/:id', async (req, res, { params }) => {
  const info = db.prepare('DELETE FROM engagements WHERE id = ?').run(Number(params.id))
  if (!info.changes) return fail(res, 404, 'engagement not found')
  json(res, 200, { ok: true })
})

/* --- Website -------------------------------------------------------------- */

route('GET', '/api/website/updates', async (req, res, { url }) => {
  const items = listWebsiteUpdates(db, { status: q(url, 'status'), limit: qInt(url, 'limit', 100) })
  json(res, 200, { items, total: items.length })
})

route('GET', '/api/website/updates/:id', async (req, res, { params }) => {
  const update = getWebsiteUpdate(db, Number(params.id))
  if (!update) return fail(res, 404, 'website update not found')
  json(res, 200, update)
})

route('POST', '/api/website/plan', async (req, res, { body }) => {
  const settings = getSettings(db)
  const run = startRun(db, 'website', emit)
  try {
    const update = await planWebsiteUpdate(db, {
      topicSlug: body?.topic_slug ?? null,
      kind: body?.kind ?? 'insight',
      settings,
      log: (m, l) => run.log(m, l),
    })
    run.finish('succeeded')
    json(res, 200, { ok: true, update, run_id: run.id })
  } catch (err) {
    run.log(err.message, 'error')
    run.finish('failed')
    fail(res, 500, err.message)
  }
})

route('POST', '/api/website/updates/:id/apply', async (req, res, { params }) => {
  const settings = getSettings(db)
  const run = startRun(db, 'website-apply', emit)
  try {
    const update = await applyWebsiteUpdate(db, Number(params.id), {
      settings,
      log: (m, l) => run.log(m, l),
    })
    run.setStats({ written: update.result?.written?.length ?? 0 })
    run.finish('succeeded')
    json(res, 200, {
      ok: true,
      status: update.status,
      written: update.result?.written ?? [],
      commit: update.result?.commit ?? null,
      preview_url: update.result?.preview_url ?? null,
      update,
    })
  } catch (err) {
    run.log(err.message, 'error')
    run.finish('failed')
    fail(res, 500, err.message)
  }
})

route('POST', '/api/website/updates/:id/reject', async (req, res, { params }) => {
  const update = rejectWebsiteUpdate(db, Number(params.id))
  if (!update) return fail(res, 404, 'website update not found')
  json(res, 200, { ok: true, status: update.status })
})

/* --- Runs ----------------------------------------------------------------- */

route('POST', '/api/pipeline/run', async (req, res, { body }) => {
  const mode = ['full', 'research', 'draft', 'publish', 'schedule', 'website'].includes(body?.mode)
    ? body.mode
    : 'full'
  const settings = getSettings(db)
  const run = startRun(db, mode, emit)
  run.log(`pipeline "${mode}" queued`)
  ;(async () => {
    try {
      await runPipeline(db, { mode, settings, emit })
    } catch (err) {
      run.log(err.message, 'error')
      run.finish('failed')
    }
  })()
  json(res, 202, { ok: true, run_id: run.id, status: 'running' })
})

route('GET', '/api/runs', async (req, res, { url }) => {
  const limit = Math.min(qInt(url, 'limit', 30), 200)
  const items = db
    .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ ...r, stats: parseJson(r.stats, {}), log: undefined }))
  json(res, 200, { items, total: items.length })
})

route('GET', '/api/runs/:id', async (req, res, { params }) => {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(params.id)
  if (!row) return fail(res, 404, 'run not found')
  json(res, 200, { ...row, stats: parseJson(row.stats, {}), log: parseJson(row.log, []) })
})

/* --- Seed (convenience for first run) ------------------------------------- */

route('POST', '/api/seed', async (req, res) => {
  try {
    const result = ensureSeed(db, { force: false })
    emit({ type: 'stats', payload: { seeded: result.inserted } })
    json(res, 200, { ok: true, ...result })
  } catch (err) {
    fail(res, 500, err.message)
  }
})

/* -------------------------------------------------------------------------- */
/* Static files                                                                */
/* -------------------------------------------------------------------------- */

// Static serving is shared with the frontend server (src/lib/static.mjs).
const serveStatic = createStaticHandler(PUBLIC_DIR)

/* -------------------------------------------------------------------------- */
/* Server                                                                      */
/* -------------------------------------------------------------------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const pathname = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    })
    return res.end()
  }

  // --- SSE ---------------------------------------------------------------
  if (pathname === '/api/stream') {
    // The browser sends the session cookie automatically (EventSource cannot
    // set headers). The ?token= form remains for scripts hitting the stream.
    if (authRequired && !authenticate(req, url).ok) {
      return fail(res, 401, 'authentication required')
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`retry: 3000\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'hello', payload: { version: VERSION } })}\n\n`)
    clients.add(res)
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        clearInterval(ping)
      }
    }, 25_000)
    req.on('close', () => {
      clearInterval(ping)
      clients.delete(res)
    })
    return
  }

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname)

  if (authRequired && !PUBLIC_API.has(pathname)) {
    const auth = authenticate(req, url)
    if (!auth.ok) return fail(res, 401, 'authentication required')
  }

  const matched = matchRoute(req.method, pathname)
  if (!matched) return fail(res, 404, `no route for ${req.method} ${pathname}`)

  try {
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {}
    await matched.handler(req, res, { params: matched.params, body, url })
  } catch (err) {
    if (!res.headersSent) fail(res, 400, err.message)
  }
})

// Broadcast a stats heartbeat so the UI header stays fresh without polling.
setInterval(() => {
  if (!clients.size) return
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM drafts').get()
    emit({ type: 'stats', payload: { drafts: row?.n ?? 0 } })
  } catch {
    /* database busy — the next tick will try again */
  }
}, 15_000).unref?.()

/* -------------------------------------------------------------------------- */
/* Automation                                                                  */
/* -------------------------------------------------------------------------- */

let scheduler = null
if (envConfig.worker.enabled) {
  const settings = getSettings(db)
  const cronLog = (msg, level = 'info') => emit({ type: 'run.log', payload: { run_id: 'scheduler', level, msg, at: nowIso() } })

  scheduler = startScheduler({
    log: cronLog,
    jobs: [
      {
        name: 'pipeline:research',
        cron: settings.schedule_cron || envConfig.worker.ingestCron,
        run: async () => {
              await runPipeline(db, { mode: 'research', settings: getSettings(db), emit })
        },
      },
      {
        name: 'pipeline:draft',
        cron: envConfig.worker.draftCron,
        run: async () => {
              await runPipeline(db, { mode: 'draft', settings: getSettings(db), emit })
        },
      },
      {
        name: 'pipeline:publish',
        cron: settings.publish_cron || envConfig.worker.publishCron,
        run: async () => {
          const s = getSettings(db)
          if (!s.auto_publish) {
            cronLog('scheduler: auto_publish is off, skipping publish tick')
            return
          }
          const run = startRun(db, 'publish', emit)
          const res = await publishDue(db, { settings: s, run })
          run.setStats({ published: res.published.length, failed: res.failed.length })
          run.finish('succeeded')
        },
      },
      {
        name: 'pipeline:website',
        cron: envConfig.worker.websiteCron,
        run: async () => {
              await runPipeline(db, { mode: 'website', settings: getSettings(db), emit })
        },
      },
    ],
  })
  console.log(`  scheduler: ${scheduler.jobs.length} jobs armed`)
}

const { inserted, total } = ensureSeed(db, { force: false })
const adminUser = seedAdminUser()
const prunedSessions = pruneSessions(db)

// Sessions expire on their own, but expired rows should not accumulate.
setInterval(() => {
  try {
    pruneSessions(db)
    loginThrottle.sweep()
  } catch {
    /* database busy — the next tick will try again */
  }
}, 3_600_000).unref?.()
if (inserted) console.log(`  seeded    : ${inserted} sample targets (${total} total)`)

server.listen(envConfig.port, envConfig.host, () => {
  const url = `http://${envConfig.host}:${envConfig.port}`
  console.log(`
  Orbit ${VERSION}
  ─────────────────────────────────────────────
  web       : ${url}
  api       : ${url}/api/health
  database  : ${envConfig.dbPath}
  llm       : ${llmMode}${llmMode === 'offline' ? '  (set DEEPSEEK_API_KEY for real generation)' : ''}
  publisher : ${envConfig.publisher.kind}
  scraper   : ${envConfig.scraper.provider}
  website   : ${envConfig.website.target}
  auth      : ${authRequired
    ? `password login required (user: ${envConfig.auth.username})`
    : envConfig.token
      ? 'bearer token required'
      : 'disabled (no ORBIT_ADMIN_PASSWORD set)'}
`)
})

const shutdown = () => {
  scheduler?.stop()
  for (const client of clients) {
    try {
      client.end()
    } catch {
      /* already closed */
    }
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
