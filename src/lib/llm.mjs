/**
 * Intelligence layer.
 *
 * Two modes, same interface:
 *   - 'deepseek' — a real OpenAI-compatible chat completions call
 *   - 'offline'  — a deterministic composer that needs no network and still
 *                  satisfies the anti-AI-smell verifier
 *
 * The offline mode exists so the pipeline is demonstrable and testable without
 * a key, and so a model outage degrades instead of breaking.
 */

import { envConfig, llmMode } from '../config.mjs'
import { BANNED_HARD, BANNED_SOFT, findSpecificity } from './lint.mjs'
import { resolveSecret } from './secrets.mjs'

export class LLMUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'LLMUnavailable'
  }
}

/* -------------------------------------------------------------------------- */
/* Shared house style, injected verbatim into every generation prompt          */
/* -------------------------------------------------------------------------- */

export const ANTI_AI_RULES = `BANNED WORDS (never use): ${BANNED_HARD.join(', ')}.
AVOID (AI tells): ${BANNED_SOFT.join(', ')}.
BANNED OPENERS: "In today's ...", "Hot take:", "Unpopular opinion:", "Let's talk about...", "Most companies get X wrong.", "It's no secret...", "Gone are the days...".
BANNED STRUCTURES: symmetrical 3-item bullet lists with bolded lead-ins; contrast flips ("It's not about X. It's about Y.").
BANNED CLOSERS: "Agree?", "Thoughts?", "DM me", "Let me know in the comments", "Follow for more".
ZERO emoji.
RHYTHM: vary sentence length hard. Mix a 20+ word architectural sentence with a 5-word flat statement. Never a uniform cadence.
SPECIFICITY: name at least two concrete artifacts — a protocol, a control, a framework, a regulation clause (with number), or a measured number with units. Vague nouns like "modern threats" or "regulatory compliance" are failures.
START mid-observation. No throat-clearing. No summarising conclusion.`

export const REGION_NOTES = {
  UK: `UK audience: pragmatic, dry understatement, commercially direct. Board-level ROI, NCSC guidance, the Cyber Assessment Framework, supply-chain vendor sprawl, alert fatigue, FCA/PRA operational resilience.`,
  CH: `Swiss audience: precision-first, sovereignty-minded, engineering-led. Data residency, on-prem/hybrid control, cryptographic verification, FINMA circulars, revFADP accountability, EDÖB.`,
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

function extractJson(text) {
  if (!text) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = [fenced?.[1], text]
  for (const candidate of candidates) {
    if (!candidate) continue
    const trimmed = candidate.trim()
    try {
      return JSON.parse(trimmed)
    } catch {
      /* fall through to brace extraction */
    }
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        /* give up on this candidate */
      }
    }
  }
  return null
}

async function chat({ messages, model, json = false, temperature = 0.7, maxTokens = 2000 }) {
  const { apiKey: envKey, baseUrl, timeoutMs } = envConfig.llm
  // Resolved per call so a key saved in the UI takes effect without a restart.
  const apiKey = resolveSecret('DEEPSEEK_API_KEY') ?? envKey
  if (!apiKey) throw new LLMUnavailable('no LLM API key configured')

  const body = { model, messages, temperature, max_tokens: maxTokens, stream: false }
  // deepseek-reasoner rejects response_format on some versions; ask for JSON in
  // the prompt instead and parse leniently.
  if (json && !/reasoner/i.test(model)) body.response_format = { type: 'json_object' }

  let res
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new LLMUnavailable(`request failed: ${err.message}`)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new LLMUnavailable(`HTTP ${res.status}: ${detail.slice(0, 300)}`)
  }

  const payload = await res.json()
  const content = payload?.choices?.[0]?.message?.content
  if (!content) throw new LLMUnavailable('empty completion')
  return { content, usage: payload.usage, model: payload.model ?? model }
}

/* -------------------------------------------------------------------------- */
/* Deterministic offline composer                                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_ARTIFACTS = {
  UK: ['MEDDPICC', 'Crown Commercial Service framework'],
  CH: ['SIMAP', 'revFADP'],
}
const CITY = { UK: 'London', CH: 'Zurich' }

function seedFrom(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    return ((h >>> 0) % 100000) / 100000
  }
}

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length) % arr.length]
const countWords = (t) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length

const shuffled = (arr, rand) =>
  arr
    .map((item) => ({ item, k: rand() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.item)

/**
 * Coherent scenario openers. Each triple agrees grammatically (singular vs
 * plural subject), so the fallback never emits "A Zurich team... Both had".
 */
const SCENARIOS = [
  {
    opener: (c, A) => `Two presales leads in ${c} described the same problem this week.`,
    friction: 'Both had a process that worked.',
    punch: 'Neither could show it to me.',
  },
  {
    opener: (c, A) => `Sat in on a bid review in ${c} this week where a question about ${A} came up twice.`,
    friction: 'The estimate looked reasonable.',
    punch: 'Nobody could reproduce it.',
  },
  {
    opener: (c, A) => `A ${c} vendor asked me to review how they handle ${A} on Tuesday.`,
    friction: 'The proposal was strong.',
    punch: 'The margin was a guess.',
  },
  {
    opener: (c, A) => `Three conversations in ${c} this month stalled on the same ${A} question.`,
    friction: 'Everyone had a process that said the right thing.',
    punch: 'None could show it working.',
  },
]

const DIAGNOSIS = [
  'The estimate lived in a spreadsheet, the scope lived in the proposal, and nothing reconciled the two.',
  'Approvals were routed by email, so the decision existed but the reasoning behind it did not.',
  'The rate card changed twice during negotiation and only one person knew.',
  'The bid went out on time. The handover took two weeks because the assumptions were never written down.',
  'Everyone knew the number. Nobody could explain where it came from.',
]

const FIX = [
  'We moved the estimate into a model that both the proposal and the delivery plan read from, so the number cannot drift away from the scope.',
  'Approvals now route to named approvers and the decision is recorded against the deal rather than in a thread.',
  'The catalogue was versioned once and every quote pulled from that version.',
  'Nothing about how the team sold changed. Only where the numbers lived.',
]

const CONTEXT = [
  (B) => `Getting agreement on ${B} took longer than the tooling, mostly because two teams disagreed about what counted as a deal stage.`,
  () => 'The first version failed review. It produced a number quickly, but could not show which assumptions produced it.',
  () => 'We ended up with one source of truth for the estimate, which is far easier to defend in a deal review than a shared drive.',
  () => 'Rollout was one team and one live bid, so nothing depended on a migration weekend.',
  () => 'The remaining gap is who owns the rate card when a partner changes it mid-negotiation. That is a process problem, not a tooling one.',
  () => 'Submission time fell by about 40%, which nobody argued about once the deadlines stopped moving.',
]

const CLOSE = [
  () => 'That took three weeks.',
  () => 'The approval route fit on one page.',
  () => 'Anything longer gets filed and forgotten.',
  () => 'Small change, large reduction in review risk.',
]

/**
 * Assembles a post in narrative order — opener, friction, diagnosis, fix,
 * supporting context, flat close — then balances it into the 120-180 word
 * window. Sentence lengths are deliberately uneven for the burstiness rule.
 */
function composePost({ post, target }) {
  const region = target?.region === 'CH' ? 'CH' : 'UK'
  const found = findSpecificity(post?.content_text ?? '')
  const A = found[0] ?? DEFAULT_ARTIFACTS[region][0]
  const B = found[1] ?? DEFAULT_ARTIFACTS[region][1]
  const city = CITY[region]
  const rand = seedFrom(`${post?.id ?? 0}:${post?.content_text?.slice(0, 64) ?? ''}`)

  const scenario = pick(rand, SCENARIOS)
  const sentences = [scenario.opener(city, A), scenario.friction, scenario.punch]
  const total = () => countWords(sentences.join(' '))

  sentences.push(pick(rand, DIAGNOSIS))

  const fixes = shuffled(FIX, rand)
  sentences.push(fixes[0])
  if (total() < 120) sentences.push(fixes[1])

  const contexts = shuffled(CONTEXT, rand)
  for (let i = 0; i < contexts.length && total() < 133; i++) {
    sentences.push(contexts[i](B))
  }

  const close = pick(rand, CLOSE)(B)
  if (total() + countWords(close) <= 176) sentences.push(close)

  return sentences.join(' ')
}

/**
 * The peer comment. Deliberately grammatically neutral about the extracted
 * artifact ("The scope included X") so it reads correctly whether X is a
 * protocol, a framework or a regulation.
 */
function composeComment({ post, target }) {
  const region = target?.region === 'CH' ? 'CH' : 'UK'
  const found = findSpecificity(post?.content_text ?? '')
  const A = found[0] ?? DEFAULT_ARTIFACTS[region][0]

  return [
    'One edge case worth flagging: the number and the delivery plan are two artefacts, and they drift independently.',
    'If the estimate is assembled outside the proposal, the scope you sold and the scope you costed can diverge without anyone noticing until mobilisation.',
    `We saw the same break last year. The scope included ${A}.`,
    'Making the proposal and the cost model read from one source fixed it. Review then had something concrete to argue with.',
  ].join(' ')
}

function painPointOf({ post, target }) {
  const text = post?.content_text ?? ''
  const found = findSpecificity(text)
  const subject = found[0] ?? (target?.region === 'CH' ? 'a Swiss enterprise bid' : 'a UK framework bid')
  const asks = /estimat|margin|rate card|cost model|pricing/i.test(text)
    ? 'The quoted number cannot be defended against the delivery plan it implies.'
    : /approval|governance|sign-?off|audit trail/i.test(text)
      ? 'Decisions are made but the reasoning behind them is not recorded anywhere.'
      : /partner|vendor|catalog/i.test(text)
        ? 'Partner and vendor data lives in several places and none of them agree.'
        : /renewal|retention|uplift|churn/i.test(text)
          ? 'Renewals are tracked by memory rather than by a clock.'
          : /RFP|RFI|ITT|tender|proposal|bid|boilerplate/i.test(text)
            ? 'Bid content exists but cannot be retrieved and reassembled under deadline.'
            : /pipeline|forecast|CRM|win rate/i.test(text)
              ? 'Pipeline is recorded, but the commercial reasoning behind each deal is not.'
              : 'Presales work is spread across inboxes and spreadsheets, so nothing is reproducible.'
  return `${asks} Raised in the context of ${subject}.`
}

/**
 * Deterministic per-post classification. Cheap enough to run over every
 * ingested post, which is the point: the expensive LLM pass is reserved for the
 * handful of posts we actually draft from.
 */
export function classifyPost({ post, target }) {
  const text = post?.content_text ?? ''
  const found = findSpecificity(text)

  return {
    topics: found.slice(0, 5).map((f) => f.toLowerCase()),
    urgency: urgencyOf(text),
    sentiment: sentimentOf(text),
    region_hook:
      target?.region === 'CH'
        ? 'DACH privacy and sovereignty compliance'
        : 'UK enterprise procurement and board-level ROI',
    angle: 'Presales rigour is a systems problem, not a people problem.',
    pain_point: painPointOf({ post, target }),
  }
}

/**
 * Urgency is about regulatory pressure and operational pain, not sentiment.
 * A post can be calm in tone and still be a five-alarm compliance problem.
 */
function urgencyOf(text) {
  const hard =
    /\b(urgent|deadline|breach|incident|enforcement|fine|penalt\w*|mandatory|must|fails?|failed|failure|stuck|stalled|impossible|nobody|no one|100%)\b/i
  const regulatory =
    /\b(FINMA|NCSC|revFADP|revDSG|nFADP|FADP|DSG|NIS2|DORA|FCA|PRA|ED[\u00d6O]B|FDPIC|regulat\w*|complian\w*|audit\w*|assess\w*|obligation\w*|reporting|procurement|questionnaire)\b/i
  const concern =
    /\b(problem|headache|gap|risk|worry|concern|can'?t|cannot|could not|couldn'?t|not clear|hard|difficult|challenge|nightmare|thin|broke|break|asking|asks)\b/i

  if (hard.test(text)) {
    return /must|mandatory|enforcement|urgent|deadline|breach|incident/i.test(text) ? 'high' : 'medium'
  }
  if (regulatory.test(text) && (concern.test(text) || text.includes('?'))) return 'high'
  if (regulatory.test(text)) return 'medium'
  if (concern.test(text)) return 'medium'
  return 'low'
}

function sentimentOf(text) {
  if (/\b(problem|headache|stuck|risk|worry|concern|can'?t|cannot|could not|fail|gap|hard|difficult|challenge|nightmare|impossible)\b/i.test(text)) {
    return 'concerned'
  }
  if (/\b(pleased|proud|delighted|great|excellent|achieved|milestone|happy|excited|passed)\b/i.test(text)) {
    return 'positive'
  }
  return 'neutral'
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Classification pass. Uses the reasoning model when available; the deterministic
 * extractor otherwise.
 */
export async function analyzePost({ post, target, settings = {} }) {
  const fallback = classifyPost({ post, target })
  if (llmMode === 'offline') return { ...fallback, generator: 'offline' }

  const system = `You classify LinkedIn posts by cybersecurity executives for a competitive-intelligence pipeline.
Return ONLY a JSON object with exactly these keys:
  "pain_point"  - one sentence: the operational or commercial problem this person actually has.
  "angle"       - one sentence: the non-obvious technical counter-position we could take.
  "topics"      - array of 2-5 short lowercase topic slugs (e.g. "revfadp-subcontractor-logging").
    Prefer named frameworks, protocols, regulations and controls over generic words.
  "urgency"     - one of "low" | "medium" | "high".
  "sentiment"   - one of "positive" | "neutral" | "concerned" | "negative".
  "region_hook" - one short phrase naming the regional regulatory or commercial context.
Do not invent facts that are not supported by the post.`

  const user = `Executive: ${target?.name ?? 'unknown'} (${target?.title ?? 'executive'}, ${target?.company ?? 'unknown company'}, region ${target?.region ?? 'UK'})
${REGION_NOTES[target?.region] ?? ''}

Their post:
"""
${(post?.content_text ?? '').slice(0, 4000)}
"""

Return json only.`

  try {
    const { content } = await chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      model: envConfig.llm.reasoningModel,
      json: true,
      temperature: 0.3,
      maxTokens: 1200,
    })
    const parsed = extractJson(content)
    if (!parsed) throw new LLMUnavailable('unparseable analysis response')
    return {
      pain_point: parsed.pain_point ?? fallback.pain_point,
      angle: parsed.angle ?? fallback.angle,
      topics: Array.isArray(parsed.topics) && parsed.topics.length ? parsed.topics : fallback.topics,
      urgency: ['low', 'medium', 'high'].includes(parsed.urgency) ? parsed.urgency : fallback.urgency,
      sentiment: parsed.sentiment ?? fallback.sentiment,
      region_hook: parsed.region_hook ?? fallback.region_hook,
      generator: envConfig.llm.reasoningModel,
    }
  } catch (err) {
    return { ...fallback, generator: 'offline', degraded: err.message }
  }
}

/**
 * Generation pass: the counter-post and the peer comment.
 * Falls back to the offline composer on any failure so the pipeline never stalls.
 */
export async function generateAssets({ post, target, settings = {}, feedback = '' }) {
  const offline = () => ({
    detected_pain_point: painPointOf({ post, target }),
    angle: 'Presales rigour is a systems problem, not a people problem.',
    peer_comment: composeComment({ post, target, settings }),
    inbound_post: composePost({ post, target, settings }),
    generator: 'offline',
  })

  if (llmMode === 'offline') return offline()

  const region = target?.region === 'CH' ? 'CH' : 'UK'
  const focus = settings.our_focus ?? 'cybersecurity engineering'
  const company = settings.our_company ?? 'our company'

  const system = `You write for ${company}, a cybersecurity firm specialising in ${focus}.
You are ghostwriting a battle-hardened security founder. Follow the house style exactly:

${ANTI_AI_RULES}

${REGION_NOTES[region]}

You must return ONLY a JSON object with exactly these keys:
  "detected_pain_point" - one sentence, what the executive actually cares about.
  "angle"               - one sentence, the non-obvious technical position we take.
  "peer_comment"        - 2-4 sentences, 25-110 words. A technical addition to post under THEIR update.
                          Add a concrete edge case or operational observation. Never pitch. Never compliment.
  "inbound_post"        - 120-180 words for OUR own feed. Tackles the deeper architectural problem behind
                          their post without naming or quoting them. Must contain at least two concrete
                          artifacts (named protocol, control, framework, regulation clause with number, or a
                          measured number with units). Ends on a flat factual statement, not a question or CTA.
Write the json object now.`

  const user = `Target executive: ${target?.name ?? 'unknown'}, ${target?.title ?? 'executive'} at ${target?.company ?? 'unknown'} (${region})

Their recent post:
"""
${(post?.content_text ?? '').slice(0, 4000)}
"""
${feedback ? `\nThe previous attempt was rejected by our style verifier for: ${feedback}\nFix those specific problems.` : ''}`

  try {
    const { content } = await chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      model: envConfig.llm.writerModel,
      json: true,
      temperature: 0.75,
      maxTokens: 2200,
    })
    const parsed = extractJson(content)
    if (!parsed) throw new LLMUnavailable('unparseable generation response')
    const out = {
      detected_pain_point: parsed.detected_pain_point ?? painPointOf({ post, target }),
      angle: parsed.angle ?? '',
      peer_comment: (parsed.peer_comment ?? '').trim() || composeComment({ post, target, settings }),
      inbound_post: (parsed.inbound_post ?? '').trim() || composePost({ post, target, settings }),
      generator: envConfig.llm.writerModel,
    }
    return out
  } catch (err) {
    return { ...offline(), degraded: err.message }
  }
}

/**
 * Optional one-shot repair pass for drafts that fail verification on style
 * grounds only (never on specificity — that needs a rewrite, not a polish).
 */
export async function repairDraft({ text, violations, settings = {}, kind = 'post' }) {
  if (llmMode === 'offline') return null
  const styleRules = violations.filter((v) => v.rule !== 'no_specificity')
  if (!styleRules.length) return null
  try {
    const { content } = await chat({
      messages: [
        {
          role: 'system',
          content: `You are a line editor. Rewrite the copy to remove the listed violations while keeping every concrete technical detail, every number, and the original argument intact. Do not add new claims. ${ANTI_AI_RULES}\nReturn ONLY a JSON object: {"text": "<the rewritten copy>"}.`,
        },
        {
          role: 'user',
          content: `Violations to remove:\n${styleRules.map((v) => `- ${v.rule}: ${v.detail}`).join('\n')}\n\nCopy (json):\n"""\n${text}\n"""`,
        },
      ],
      model: envConfig.llm.writerModel,
      json: true,
      temperature: 0.5,
      maxTokens: 1600,
    })
    const parsed = extractJson(content)
    return typeof parsed?.text === 'string' && parsed.text.trim() ? parsed.text.trim() : null
  } catch {
    return null
  }
}

export const llmStatus = {
  mode: llmMode,
  baseUrl: envConfig.llm.baseUrl,
  reasoningModel: llmMode === 'offline' ? null : envConfig.llm.reasoningModel,
  writerModel: llmMode === 'offline' ? null : envConfig.llm.writerModel,
}
