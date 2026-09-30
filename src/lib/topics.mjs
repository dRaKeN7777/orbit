/**
 * Topic & pain-point matrix.
 *
 * Clustering is rule-based rather than embedding-based, deliberately: it is
 * deterministic, instant, needs no vector store, and — most importantly —
 * produces *named* clusters a human recognises ("revFADP / Swiss data
 * protection") instead of opaque nearest-neighbour groups. When an LLM is
 * configured, its per-post topic suggestions are merged in as extra tags.
 */

import { findSpecificity } from './lint.mjs'
import { nowIso } from '../db.mjs'

/** The cluster dictionary. Everything the matrix can surface lives here. */
export const TOPIC_RULES = [
  { slug: 'presales-spreadsheet-chaos', label: 'Presales run on spreadsheets', tags: ['presales', 'ops'], re: /presales|pre-sales|sales engineer|deal desk|bid team|spreadsheet|single point of failure|one person/i },
  { slug: 'proposal-rfp-response', label: 'RFP, ITT and proposal response', tags: ['bids', 'proposals'], re: /\bRFP\b|\bRFI\b|\bRFQ\b|\bITT\b|\bPQQs?\b|tender|bid (response|library|team|manager)|proposal|boilerplate/i },
  { slug: 'estimation-margin', label: 'Estimation, effort and margin', tags: ['estimation', 'margin'], re: /estimat|margin|rate card|day rate|cost model|pricing model|\bSOW\b|scope creep|effort|quote/i },
  { slug: 'approval-governance', label: 'Approvals and deal governance', tags: ['governance', 'approvals'], re: /approval|sign-?off|deal review|discount|audit trail|governance|authorisation route|authorization/i },
  { slug: 'partner-vendor-catalogue', label: 'Partners, vendors and catalogue', tags: ['partners', 'catalogue'], re: /partner|vendor|distributor|catalogue|catalog|alliance|reseller|part number/i },
  { slug: 'renewal-retention', label: 'Renewals and retention', tags: ['renewals', 'retention'], re: /renewal|uplift|retention|churn|anniversary|true-?up|co-?term|renegotiat/i },
  { slug: 'pipeline-forecast-hygiene', label: 'Pipeline hygiene and forecasting', tags: ['pipeline', 'forecast'], re: /pipeline|forecast|win rate|qualif|MEDDPICC|close plan|stage gate|slippage|system of record/i },
  { slug: 'crm-vs-presales-tooling', label: 'CRM versus presales tooling', tags: ['CRM', 'tooling'], re: /Salesforce|HubSpot|Dynamics|\bCRM\b|tech stack|stack consolidation/i },
  { slug: 'mssp-managed-service-deals', label: 'MSSP and managed-service deal motions', tags: ['MSSP', 'services'], re: /\bMSSP\b|managed service|\bMDR\b|SOC-?as-?a-?service|service wrap|\bMSA\b|recurring/i },
  { slug: 'frameworks-in-bids', label: 'Security frameworks inside bids', tags: ['frameworks', 'compliance'], re: /NIST CSF|ISO\/?IEC ?27001|ISO ?27001|\bSOC ?2\b|PCI ?DSS|CIS Benchmarks|\bCMMC\b|Essential Eight|GDPR|revFADP|FINMA|\bNCSC\b|compliance-?driven/i },
  { slug: 'public-sector-procurement', label: 'Public-sector procurement', tags: ['public-sector', 'procurement'], re: /public sector|G-?Cloud|Crown Commercial|\bCCS\b|framework agreement|SIMAP|procurement|OJEU|below-?threshold/i },
  { slug: 'competitive-displacement', label: 'Competitive displacement and POCs', tags: ['competitive', 'POC'], re: /displac|rip and replace|competitive|bake-?off|\bPOC\b|proof of concept|incumbent/i },
  { slug: 'land-and-expand', label: 'Land and expand', tags: ['expansion', 'upsell'], re: /land and expand|upsell|cross-?sell|expansion|attach rate|footprint/i },
  { slug: 'presales-talent-enablement', label: 'Presales hiring and enablement', tags: ['talent', 'enablement'], re: /hiring|recruit|headcount|skills gap|enablement|onboarding (engineers|presales)|talent/i },
  { slug: 'ai-in-presales', label: 'AI in the presales motion', tags: ['AI', 'automation'], re: /\bAI\b|\bLLM\b|copilot|agentic|generative|automation/i },
  { slug: 'handover-to-delivery', label: 'Handover from bid to delivery', tags: ['handover', 'delivery'], re: /handover|hand-?off|transition to (delivery|service)|delivery assumptions|mobilisation|mobilization/i },
]

export function topicsForPost(text) {
  const out = []
  for (const rule of TOPIC_RULES) {
    rule.re.lastIndex = 0
    if (rule.re.test(text)) out.push(rule)
  }
  return out
}

const URGENCY_WEIGHT = { high: 3, medium: 2, low: 1 }
const firstSentence = (t) => (String(t).split(/(?<=[.!?])\s+/)[0] ?? '').trim()

/**
 * Rebuild the topic table from posts inside the window.
 * @returns {{topics:number, posts:number, window_days:number}}
 */
export function recomputeTopics(db, { days = 14, log = () => {} } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const midpoint = new Date(Date.now() - (days / 2) * 86_400_000).toISOString()

  const posts = db
    .prepare(
      `SELECT p.id, p.content_text, p.urgency, p.sentiment, p.posted_at, p.velocity,
              p.reactions, p.comments, p.shares, p.topics AS llm_topics,
              t.region, t.name AS target_name, t.company
         FROM posts p
         JOIN targets t ON t.id = p.target_id
        WHERE p.posted_at >= ?
        ORDER BY p.posted_at DESC`,
    )
    .all(since)

  /** slug -> aggregate */
  const clusters = new Map()

  for (const post of posts) {
    const rules = topicsForPost(post.content_text)
    if (!rules.length) continue
    const artifacts = findSpecificity(post.content_text)

    for (const rule of rules) {
      let c = clusters.get(rule.slug)
      if (!c) {
        c = {
          slug: rule.slug,
          label: rule.label,
          tags: new Set(rule.tags),
          post_ids: [],
          regions: { UK: 0, CH: 0 },
          urgencyScore: 0,
          sentimentTally: {},
          recent: 0,
          older: 0,
          first_seen: post.posted_at,
          last_seen: post.posted_at,
          top_post: post,
          artifacts: new Set(),
        }
        clusters.set(rule.slug, c)
      }
      c.post_ids.push(post.id)
      if (post.region === 'UK' || post.region === 'CH') c.regions[post.region] += 1
      c.urgencyScore += URGENCY_WEIGHT[post.urgency] ?? 1
      c.sentimentTally[post.sentiment ?? 'neutral'] =
        (c.sentimentTally[post.sentiment ?? 'neutral'] ?? 0) + 1
      if (post.posted_at >= midpoint) c.recent += 1
      else c.older += 1
      if (post.posted_at < c.first_seen) c.first_seen = post.posted_at
      if (post.posted_at > c.last_seen) c.last_seen = post.posted_at
      if ((post.velocity ?? 0) > (c.top_post.velocity ?? 0)) c.top_post = post
      for (const a of artifacts) c.artifacts.add(a)
    }
  }

  const rows = []
  for (const c of clusters.values()) {
    const mentions = c.post_ids.length
    const avgUrgency = c.urgencyScore / mentions
    const urgency = avgUrgency >= 2.4 ? 'high' : avgUrgency >= 1.7 ? 'medium' : 'low'
    const sentiment =
      Object.entries(c.sentimentTally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'neutral'
    const trend =
      c.recent > c.older * 1.3 ? 'rising' : c.recent < c.older * 0.7 ? 'falling' : 'steady'
    const artifacts = [...c.artifacts].slice(0, 6)

    rows.push({
      slug: c.slug,
      label: c.label,
      mentions,
      regions: c.regions,
      urgency,
      sentiment,
      trend,
      tags: [...c.tags, ...artifacts.map((a) => a.toLowerCase())].slice(0, 8),
      post_ids: c.post_ids.slice(0, 50),
      first_seen: c.first_seen,
      last_seen: c.last_seen,
      summary: `${firstSentence(c.top_post.content_text).slice(0, 220)}`,
      top_artifacts: artifacts,
    })
  }

  rows.sort((a, b) => {
    const score = (r) =>
      r.mentions * (URGENCY_WEIGHT[r.urgency] ?? 1) * (r.trend === 'rising' ? 1.4 : 1)
    return score(b) - score(a)
  })

  // Rebuild wholesale: the table is a materialised view, not a source of truth.
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM topics')
    const stmt = db.prepare(
      `INSERT INTO topics (slug, label, mentions, regions, urgency, sentiment, trend, tags, post_ids, first_seen, last_seen, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const r of rows) {
      stmt.run(
        r.slug,
        r.label,
        r.mentions,
        JSON.stringify(r.regions),
        r.urgency,
        r.sentiment,
        r.trend,
        JSON.stringify(r.tags),
        JSON.stringify(r.post_ids),
        r.first_seen,
        r.last_seen,
        nowIso(),
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  log(`recomputed ${rows.length} topics from ${posts.length} posts (${days}d window)`)
  return { topics: rows.length, posts: posts.length, window_days: days }
}

export function listTopics(db, { limit = 100, region = null } = {}) {
  const rows = db.prepare('SELECT * FROM topics ORDER BY mentions DESC LIMIT ?').all(limit)
  return rows
    .map((r) => ({
      ...r,
      // `topic` is the documented API field; `label` is the internal column
      // name. Emit both so the contract holds and internal callers keep working.
      topic: r.label,
      regions: JSON.parse(r.regions || '{}'),
      tags: JSON.parse(r.tags || '[]'),
      post_ids: JSON.parse(r.post_ids || '[]'),
    }))
    .filter((t) => !region || (t.regions[region] ?? 0) > 0)
}
