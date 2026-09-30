import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Minimal .env parser — no dependency. Does not override already-set env vars. */
function loadDotEnv() {
  const file = resolve(ROOT, '.env')
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadDotEnv()

const env = (k, d = '') => {
  const v = process.env[k]
  return v === undefined || v === '' ? d : v
}
const bool = (k, d = false) => {
  const v = process.env[k]
  if (v === undefined || v === '') return d
  return /^(1|true|yes|on)$/i.test(v)
}
const int = (k, d) => {
  const n = Number.parseInt(process.env[k] ?? '', 10)
  return Number.isFinite(n) ? n : d
}
const abs = (p) => (p.startsWith('/') ? p : resolve(ROOT, p))

// A destination is "safe" when nothing leaves the machine. Automation defaults
// to ON for safe destinations (so the whole loop runs out of the box) and OFF
// the moment a real one is configured (so nothing is ever posted by surprise).
const safePublisher = env('PUBLISHER', 'outbox').toLowerCase() === 'outbox'
const safeWebsite = env('WEBSITE_TARGET', 'static').toLowerCase() === 'static'

export const envConfig = {
  // Backend API. The frontend server (src/frontend.mjs) proxies /api here.
  port: int('PORT', 8040),
  host: env('HOST', '127.0.0.1'),
  token: env('ORBIT_TOKEN'),
  dbPath: abs(env('DATABASE_PATH', './data/orbit.db')),

  llm: {
    apiKey: env('DEEPSEEK_API_KEY') || env('OPENAI_API_KEY'),
    baseUrl: env('LLM_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
    reasoningModel: env('LLM_MODEL_REASONING', 'deepseek-reasoner'),
    writerModel: env('LLM_MODEL_WRITER', 'deepseek-chat'),
    // Generous: deepseek-reasoner can think for a while on a long post.
    timeoutMs: int('LLM_TIMEOUT_MS', 120_000),
  },

  scraper: {
    provider: env('SCRAPER_PROVIDER', 'sample').toLowerCase(),
    apifyToken: env('APIFY_TOKEN'),
    apifyActorId: env('APIFY_ACTOR_ID', 'harvestapi~linkedin-post-search'),
    endpoint: env('SCRAPER_ENDPOINT'),
    token: env('SCRAPER_TOKEN'),
    rssFeeds: env('RSS_FEEDS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    timeoutMs: int('SCRAPER_TIMEOUT_MS', 180_000),
  },

  publisher: {
    kind: env('PUBLISHER', 'outbox').toLowerCase(),
    linkedinToken: env('LINKEDIN_ACCESS_TOKEN'),
    linkedinAuthorUrn: env('LINKEDIN_AUTHOR_URN'),
    postizUrl: env('POSTIZ_API_URL').replace(/\/+$/, ''),
    postizKey: env('POSTIZ_API_KEY'),
    postizIntegrationId: env('POSTIZ_INTEGRATION_ID'),
  },

  website: {
    target: env('WEBSITE_TARGET', 'site').toLowerCase(),
    path: abs(env('WEBSITE_PATH', './site')),
    baseUrl: env('WEBSITE_BASE_URL').replace(/\/+$/, ''),
    gitCommit: bool('GIT_COMMIT', false),
    gitAuthorName: env('GIT_AUTHOR_NAME', 'Orbit'),
    gitAuthorEmail: env('GIT_AUTHOR_EMAIL', 'orbit@localhost'),
    wordpressUrl: env('WORDPRESS_URL').replace(/\/+$/, ''),
    wordpressUser: env('WORDPRESS_USER'),
    wordpressPassword: env('WORDPRESS_APP_PASSWORD'),
  },

  worker: {
    enabled: bool('WORKER_ENABLED', true),
    autoPublish: bool('AUTO_PUBLISH', safePublisher),
    autoSchedule: bool('AUTO_SCHEDULE', safePublisher),
    autoApplyWebsite: bool('AUTO_APPLY_WEBSITE', safeWebsite),
    postsPerDay: int('POSTS_PER_DAY', 2),
    minHoursBetweenPosts: int('MIN_HOURS_BETWEEN_POSTS', 6),
    postingWindows: env('POSTING_WINDOWS', '08:15,13:45')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    postingDays: env('POSTING_DAYS', '1,2,3,4,5')
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    ingestCron: env('INGEST_CRON', '0 6 * * *'),
    draftCron: env('DRAFT_CRON', '15 6 * * *'),
    publishCron: env('PUBLISH_CRON', '*/5 * * * *'),
    websiteCron: env('WEBSITE_CRON', '30 6 * * 1'),
  },

  outboxDir: abs(env('OUTBOX_PATH', './data/outbox')),

  // Auth. mode 'auto' means: require a login only when a password is actually
  // configured, so a fresh localhost install stays frictionless.
  auth: {
    mode: env('ORBIT_AUTH', 'auto').toLowerCase(),
    username: env('ORBIT_ADMIN_USER', 'admin'),
    password: env('ORBIT_ADMIN_PASSWORD'),
    sessionDays: int('ORBIT_SESSION_DAYS', 7),
    // Set true when serving over HTTPS so the cookie is not sent in the clear.
    cookieSecure: bool('ORBIT_COOKIE_SECURE', false),
  },

  // Stock imagery for the website and post visuals.
  pexels: {
    apiKey: env('PEXELS_API_KEY'),
  },

  // LinkedIn OAuth app credentials (Developer Portal -> your app -> Auth tab).
  linkedin: {
    clientId: env('LINKEDIN_CLIENT_ID'),
    clientSecret: env('LINKEDIN_CLIENT_SECRET'),
    // Must match a redirect URI registered on the app, exactly.
    redirectUri: env('LINKEDIN_REDIRECT_URI'),
    scope: env('LINKEDIN_SCOPE', 'w_organization_social'),
  },

  // Frontend: serves the SPA and reverse-proxies /api to the backend, so the
  // browser keeps a single origin and no CORS is involved.
  frontend: {
    port: int('FRONTEND_PORT', 3020),
    host: env('FRONTEND_HOST', '127.0.0.1'),
    backendUrl: env(
      'BACKEND_URL',
      `http://${env('HOST', '127.0.0.1')}:${int('PORT', 8040)}`,
    ).replace(/\/+$/, ''),
  },
}

/** Which intelligence layer is actually live. Surfaced in /api/health. */
export const llmMode = envConfig.llm.apiKey ? 'deepseek' : 'offline'

/**
 * Whether a login is required. 'auto' turns auth on exactly when a password is
 * configured, so the zero-config localhost experience is unchanged.
 */
export const authRequired =
  envConfig.auth.mode === 'on'
    ? true
    : envConfig.auth.mode === 'off'
      ? false
      : Boolean(envConfig.auth.password)

/** Settings are user-editable at runtime and live in SQLite, not .env. */
export const DEFAULT_SETTINGS = {
  our_company: 'Enhancing Security',
  our_focus:
    'an operating console for cybersecurity presales — pipeline, estimation, proposals, approvals, partner catalogue and renewals in one place',
  our_voice: 'founder-engineering',
  regions: ['UK', 'CH'],
  auto_publish: envConfig.worker.autoPublish,
  schedule_cron: envConfig.worker.ingestCron,
  publish_cron: envConfig.worker.publishCron,
  website_target: envConfig.website.target,
  website_path: envConfig.website.path,
  // Extra phrases the linter should reject, beyond the built-in list.
  banned_extra: [],
  // How many top topics each pipeline run turns into drafts.
  drafts_per_run: 3,
  // Minimum lint score required to schedule or publish.
  min_lint_score: 70,

  // --- Automation policy ----------------------------------------------------
  // auto_schedule queues verified drafts into posting slots by itself. It is
  // off by default so a fresh install always keeps a human in the loop; turn it
  // on once you trust the verifier's output.
  auto_schedule: envConfig.worker.autoSchedule,
  // auto_apply_website writes planned pages without review.
  auto_apply_website: envConfig.worker.autoApplyWebsite,
  // How many verified drafts to queue per pipeline run.
  schedule_per_run: 5,
  // Posting slots are times of day in UTC. These two are a reasonable default
  // for a UK/CH audience (mid-morning London, early afternoon Zurich).
  posting_windows: envConfig.worker.postingWindows.length
    ? envConfig.worker.postingWindows
    : ['08:15', '13:45'],
  // 0 = Sunday. Weekdays only by default.
  posting_days: envConfig.worker.postingDays.length ? envConfig.worker.postingDays : [1, 2, 3, 4, 5],
  posts_per_day: envConfig.worker.postsPerDay,
  min_hours_between_posts: envConfig.worker.minHoursBetweenPosts,
  schedule_horizon_days: 45,
  publish_channel: 'linkedin_company',
}

export const VERSION = '1.0.0'
