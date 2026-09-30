/**
 * Reading pipeline — ingestion adapters.
 *
 * LinkedIn exposes no API for reading other users' personal posts, so this
 * layer is deliberately pluggable. Every adapter normalises to the same shape:
 *
 *   { linkedin_url, posts: [{ external_id, text, url, posted_at, reactions, comments, shares }] }
 *
 * `sample` is the default so the whole system is demonstrable end-to-end with
 * no credentials. It is clearly labelled in every run log and every post it
 * creates carries a `sample-` external id.
 */

import { createHash } from 'node:crypto'
import { envConfig } from '../config.mjs'
import { nowIso } from '../db.mjs'

const HOUR_MS = 36e5
const hoursSince = (iso) => Math.max(0.5, (Date.now() - new Date(iso).getTime()) / HOUR_MS)

const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16)

/** Engagements weighted, normalised by age. Comments and shares count for more. */
export function velocityOf(counts, postedAt) {
  const weighted =
    (counts.reactions ?? 0) + (counts.comments ?? 0) * 2 + (counts.shares ?? 0) * 3
  return Number((weighted / hoursSince(postedAt)).toFixed(2))
}

/* -------------------------------------------------------------------------- */
/* Sample provider                                                             */
/* -------------------------------------------------------------------------- */

/** Synthetic but realistic posts, so the pipeline runs with zero credentials. */
const SAMPLE_TEXTS = [
  { region: 'UK', text: 'Two of our SEs spent most of last week reformatting the same boilerplate into a customer RFP template. That is not a skills problem. We have the answers, we just cannot retrieve them.' },
  { region: 'UK', text: 'Our renewal win rate is fine. Our competitive displacement rate is not, and I think it is because we scope the POC before we understand the incumbent commercial position.' },
  { region: 'UK', text: 'Every bid we lose, I ask the same question: could we have known the margin was unworkable before we wrote 80 pages? Usually the answer is yes, and usually nobody looked.' },
  { region: 'UK', text: 'We run four approval routes depending on deal size. Nobody can tell me which one a given bid went through without opening the email chain. That is not governance.' },
  { region: 'UK', text: 'The biggest unlock in our presales function this year was not a tool. It was agreeing that an estimate is a model, not a number someone types into a spreadsheet the night before submission.' },
  { region: 'UK', text: 'Crown Commercial framework bids are their own discipline. If your proposal library was built for direct enterprise deals it will not survive a G-Cloud submission.' },
  { region: 'UK', text: 'I have three partner catalogues open right now and none of them agree on part numbers. That is why our estimates drift between the first call and the final quote.' },
  { region: 'UK', text: 'We hired a bid manager in January and our on-time submission rate went from 61% to 94%. The lesson is not hire bid managers. It is that presales was never resourced to run a process.' },
  { region: 'UK', text: 'Handover to delivery is where the margin actually dies. We quote carefully and then lose two weeks of effort in the transition because nobody wrote down what we assumed.' },
  { region: 'UK', text: 'Our CRM is the system of record for pipeline and I would not change that. But it has never once held the estimate, and the estimate is the thing we argue about.' },
  { region: 'UK', text: 'I asked how many live bids we are running. Three different numbers came back from three people. Not one of them was being dishonest.' },
  { region: 'CH', text: 'A Zurich client asked us to respond to their tender in German and French from the same approved content. Our library is monolingual. That became a two week problem.' },
  { region: 'CH', text: 'Swiss procurement through SIMAP rewards precision. Every deviation has to be declared. If the proposal is assembled by hand you will eventually miss one.' },
  { region: 'CH', text: 'We modelled a managed service deal last month. The estimate changed four times because the partner rate card changed and nobody versioned it.' },
  { region: 'CH', text: 'FINMA driven deals in Switzerland move on documentation quality. The technical answer is rarely the differentiator. The audit trail is.' },
  { region: 'CH', text: 'Our pricing model lives in one person spreadsheet and he is on holiday for two weeks in August. That is a business continuity risk, not an IT inconvenience.' },
  { region: 'CH', text: 'revFADP questions come up in nearly every Swiss enterprise bid now. We answer them well. We answer them slowly, because the answer sits in three different documents.' },
  { region: 'CH', text: 'In Switzerland the buyer wants the delivery assumptions before the price. We had been leading with the price for two years and wondering why we were shortlisted and then dropped.' },
  { region: 'CH', text: 'We won a displacement deal last quarter. The reason was not the product. We were the only vendor who could produce a costed migration plan inside the deadline.' },
  { region: 'CH', text: 'Precision beats speed in this market, but we were using precision as an excuse for a manual process that simply took too long.' },
  { region: 'CH', text: 'We lost a bid because our costed scope did not match the delivery plan we had approved six weeks earlier. Two artefacts, one deal, no reconciliation.' },
]

function generateSample(target, count = 4) {
  const pool = SAMPLE_TEXTS.filter((s) => s.region === target.region)
  const fallback = pool.length ? pool : SAMPLE_TEXTS
  const seed = hash(`${target.id}:${target.linkedin_url ?? target.name}`)
  const n = Number.parseInt(seed.slice(0, 2), 16)
  const offset = n % fallback.length

  const posts = []
  for (let i = 0; i < count; i++) {
    const item = fallback[(offset + i * 3) % fallback.length]
    // Spread across the last 5 days, deterministic per target+index.
    const hoursAgo = 3 + i * 27 + (n % 11)
    const postedAt = new Date(Date.now() - hoursAgo * HOUR_MS).toISOString()
    const reactions = 40 + ((n + i * 37) % 420)
    const comments = 3 + ((n + i * 13) % 60)
    const shares = (n + i * 7) % 25
    posts.push({
      external_id: `sample-${target.id}-${i}-${hash(item.text)}`,
      text: item.text,
      url: null,
      posted_at: postedAt,
      reactions,
      comments,
      shares,
    })
  }
  return posts
}

/* -------------------------------------------------------------------------- */
/* Real providers                                                              */
/* -------------------------------------------------------------------------- */

function normaliseItem(target, raw) {
  const text =
    raw.text ?? raw.content ?? raw.postText ?? raw.commentary ?? raw.description ?? ''
  const postedAt =
    raw.postedAt ?? raw.posted_at ?? raw.publishedAt ?? raw.createdAt ?? raw.date ?? null
  const url = raw.url ?? raw.postUrl ?? raw.link ?? raw.shareUrl ?? null
  const eng = raw.engagement ?? raw.engagements ?? raw.stats ?? {}
  return {
    external_id:
      raw.id ?? raw.urn ?? raw.postUrn ?? raw.activityUrn ?? (url ? hash(url) : hash(text)),
    text: String(text).trim(),
    url,
    posted_at: postedAt ? new Date(postedAt).toISOString() : nowIso(),
    reactions: Number(raw.reactions ?? raw.likes ?? eng.reactions ?? eng.likes ?? 0) || 0,
    comments: Number(raw.comments ?? raw.commentCount ?? eng.comments ?? 0) || 0,
    shares: Number(raw.shares ?? raw.reposts ?? eng.shares ?? eng.reposts ?? 0) || 0,
    targetUrlHint: target.linkedin_url,
  }
}

/** Groups a flat array of scraped posts by whichever target URL they belong to. */
function groupByTarget(targets, items) {
  const byUrl = new Map(targets.map((t) => [t.linkedin_url, []]))
  const unmapped = []
  for (const raw of items) {
    const owner =
      raw.targetUrl ?? raw.authorUrl ?? raw.profileUrl ?? raw.inputUrl ?? raw.query ?? null
    const match = owner ? byUrl.get(owner) : null
    if (match) match.push(raw)
    else unmapped.push(raw)
  }
  // Scrapers that return one item per target with a nested posts[] array.
  if (unmapped.length && targets.length === unmapped.length) {
    targets.forEach((t, i) => byUrl.get(t.linkedin_url).push(unmapped[i]))
  }
  return byUrl
}

function flattenPosts(raw) {
  if (Array.isArray(raw.posts)) return raw.posts
  if (Array.isArray(raw.items)) return raw.items
  return [raw]
}

async function fetchApify(targets) {
  const { apifyToken, apifyActorId, timeoutMs } = envConfig.scraper
  if (!apifyToken) throw new Error('APIFY_TOKEN is not set')

  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(
    apifyActorId,
  )}/run-sync-get-dataset-items?token=${encodeURIComponent(apifyToken)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetUrls: targets.map((t) => t.linkedin_url).filter(Boolean),
      urls: targets.map((t) => t.linkedin_url).filter(Boolean),
      maxPosts: 10,
      postedLimit: 'week',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Apify HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const items = await res.json()
  if (!Array.isArray(items)) throw new Error('Apify returned a non-array payload')

  const grouped = groupByTarget(targets, items)
  return targets.map((t) => ({
    target: t,
    posts: grouped
      .get(t.linkedin_url)
      .flatMap(flattenPosts)
      .map((raw) => normaliseItem(t, raw))
      .filter((p) => p.text),
  }))
}

async function fetchGeneric(targets) {
  const { endpoint, token, timeoutMs } = envConfig.scraper
  if (!endpoint) throw new Error('SCRAPER_ENDPOINT is not set')

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ urls: targets.map((t) => t.linkedin_url).filter(Boolean) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`scraper HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const payload = await res.json()
  const items = Array.isArray(payload) ? payload : (payload.items ?? payload.data ?? [])

  const grouped = groupByTarget(targets, items)
  return targets.map((t) => ({
    target: t,
    posts: grouped
      .get(t.linkedin_url)
      .flatMap(flattenPosts)
      .map((raw) => normaliseItem(t, raw))
      .filter((p) => p.text),
  }))
}

/** Tiny RSS/Atom reader — regex based, no dependency. */
function parseFeed(xml) {
  const entries = []
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? []
  for (const block of blocks) {
    const pick = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null
    }
    const title = pick('title')
    const link = pick('link') ?? /<link[^>]*href="([^"]+)"/i.exec(block)?.[1] ?? null
    const date = pick('pubDate') ?? pick('published') ?? pick('updated')
    const desc =
      pick('description') ?? pick('summary') ?? pick('content:encoded') ?? pick('content') ?? ''
    const text = `${title ? `${title}. ` : ''}${desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`
    if (text.trim().length > 40) {
      entries.push({
        external_id: link ? hash(link) : hash(text),
        text: text.trim(),
        url: link,
        posted_at: date ? new Date(date).toISOString() : nowIso(),
        reactions: 0,
        comments: 0,
        shares: 0,
      })
    }
  }
  return entries
}

async function fetchRss(targets) {
  const feeds = envConfig.scraper.rssFeeds
  if (!feeds.length) throw new Error('RSS_FEEDS is not set')
  const all = []
  const errors = []
  for (const feed of feeds) {
    try {
      const res = await fetch(feed, {
        headers: { 'User-Agent': 'Orbit/1.0 (+market-intelligence)' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      all.push(...parseFeed(await res.text()))
    } catch (err) {
      errors.push(`${feed}: ${err.message}`)
    }
  }
  const seen = new Set()
  const posts = all.filter((p) => (seen.has(p.external_id) ? false : seen.add(p.external_id)))
  // RSS is one-to-many: attach the whole feed to the first target so it still
  // lands in the radar, and note the attribution limitation in the errors list.
  const batches = targets.map((t, i) => ({ target: t, posts: i === 0 ? posts : [] }))
  return { batches, errors }
}

/* -------------------------------------------------------------------------- */
/* Persistence + orchestration                                                 */
/* -------------------------------------------------------------------------- */

export function storePosts(db, targetId, posts) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO posts
       (target_id, external_id, content_text, reactions, comments, shares, velocity, posted_at, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  let inserted = 0
  for (const p of posts) {
    if (!p.text) continue
    const externalId = p.external_id ?? hash(`${p.text}${p.posted_at}`)
    const r = stmt.run(
      targetId,
      externalId,
      p.text,
      p.reactions ?? 0,
      p.comments ?? 0,
      p.shares ?? 0,
      velocityOf(p, p.posted_at),
      p.posted_at,
      p.url ?? null,
      nowIso(),
    )
    if (r.changes > 0) inserted++
  }
  return inserted
}

/**
 * Pull fresh posts for the given targets and persist the new ones.
 * @returns {Promise<{provider:string, targets:number, fetched:number, inserted:number, errors:string[]}>}
 */
export async function ingest({ db, targets, log = () => {} }) {
  const provider = envConfig.scraper.provider
  const errors = []
  let batches = []

  if (!targets.length) {
    return { provider, targets: 0, fetched: 0, inserted: 0, errors: ['no active targets'] }
  }

  if (provider === 'sample') {
    log(`sample provider: generating synthetic posts for ${targets.length} targets`)
    batches = targets.map((t) => ({ target: t, posts: generateSample(t) }))
  } else if (provider === 'apify') {
    log(`apify provider: actor ${envConfig.scraper.apifyActorId}`)
    try {
      batches = await fetchApify(targets)
    } catch (err) {
      errors.push(err.message)
      log(`apify failed: ${err.message}`)
    }
  } else if (provider === 'generic') {
    log('generic provider: POST to SCRAPER_ENDPOINT')
    try {
      batches = await fetchGeneric(targets)
    } catch (err) {
      errors.push(err.message)
      log(`generic scraper failed: ${err.message}`)
    }
  } else if (provider === 'rss') {
    log(`rss provider: ${envConfig.scraper.rssFeeds.length} feeds`)
    try {
      const out = await fetchRss(targets)
      batches = out.batches
      errors.push(...out.errors)
    } catch (err) {
      errors.push(err.message)
    }
  } else {
    errors.push(`unknown SCRAPER_PROVIDER "${provider}" — set sample|apify|generic|rss`)
    log(`unknown provider "${provider}"`)
  }

  let fetched = 0
  let inserted = 0
  for (const { target, posts } of batches) {
    fetched += posts.length
    inserted += storePosts(db, target.id, posts)
    db.prepare('UPDATE targets SET last_scraped_at = ? WHERE id = ?').run(nowIso(), target.id)
  }

  log(`ingested ${inserted} new posts from ${fetched} fetched (${provider})`)
  return { provider, targets: targets.length, fetched, inserted, errors }
}

export { generateSample, parseFeed, SAMPLE_TEXTS }
