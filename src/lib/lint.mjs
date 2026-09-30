/**
 * The anti-AI-smell verifier.
 *
 * This is the hard gate in the pipeline: nothing gets scheduled or published
 * unless it passes here. Everything is deterministic and offline — no model
 * judgement involved, so the same draft always scores the same and the rules
 * can be tested.
 *
 * Severity model:
 *   hard -> the brand's non-negotiable rules. Any single one fails the draft.
 *   soft -> style penalties that accumulate. Enough of them also fail it.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/** Explicitly banned by the house style. Never allowed. */
export const BANNED_HARD = [
  'delve', 'testament', 'tapestry', 'beacon', 'game-changer', 'game changer',
  'landscape', 'realm', 'pivotal', 'underscore', 'unleash', 'elevate',
  'foster', 'robust', 'seamless', 'cutting-edge', 'cutting edge', 'paradigm',
]

/** Additional LLM tells. Style penalties, not automatic failures. */
export const BANNED_SOFT = [
  'leverage', 'leveraging', 'dive into', 'diving into', 'navigate the',
  'in conclusion', 'moreover', 'furthermore', "it's worth noting",
  'in essence', 'at the end of the day', 'synergy', 'holistic',
  'best-in-class', 'state-of-the-art', 'transformative', 'revolutionize',
  'revolutionise', 'empower', 'streamline', 'meticulous', 'multifaceted',
  'myriad', 'plethora', 'crucial', 'vital', 'crucially', 'ever-evolving',
  'ever-changing', 'in the ever', 'supercharge', 'turbocharge', 'effortless',
]

const BANNED_OPENER_PATTERNS = [
  [/\bin today'?s\b[^.!?]{0,40}\b(landscape|world|environment|climate|era|age)\b/i, "In today's ... landscape"],
  [/^\s*hot take\b/i, 'Hot take:'],
  [/^\s*unpopular opinion\b/i, 'Unpopular opinion:'],
  [/^\s*let'?s talk about\b/i, "Let's talk about..."],
  [/^\s*most (companies|organisations|organizations|cisos|teams|businesses)\s+get\b/i, 'Most X get Y wrong'],
  [/^\s*it'?s no secret\b/i, "It's no secret..."],
  [/^\s*gone are the days\b/i, 'Gone are the days...'],
  [/^\s*picture this\b/i, 'Picture this...'],
  [/^\s*as we all know\b/i, 'As we all know...'],
  [/^\s*when it comes to\b/i, 'When it comes to...'],
  [/^\s*in the world of\b/i, 'In the world of...'],
]

const BANNED_CLOSER_PATTERNS = [
  [/\bagree\?/i, 'Agree?'],
  [/\bthoughts\?\s*$/im, 'Thoughts?'],
  [/\bdm me\b/i, 'DM me'],
  [/\blet me know (in the comments|your thoughts|what you think)\b/i, 'Let me know...'],
  [/\bwhat do you think\b/i, 'What do you think?'],
  [/\bshare your thoughts\b/i, 'Share your thoughts'],
  [/\bcomment below\b/i, 'Comment below'],
  [/\bfollow (me|us) for more\b/i, 'Follow for more'],
  [/\blink in (the )?(bio|comments|first comment)\b/i, 'Link in bio/comments'],
  [/\bhit (the )?(follow|bell)\b/i, 'Hit follow'],
]

const PREACHY_PATTERN =
  /\b(ultimately|in the end|the key (takeaway )?is|never forget|proactive (defence|defense)? ?is key|staying ahead|matters most|is everything)\b/i

/* -------------------------------------------------------------------------- */
/* Specificity — does the copy contain a concrete artifact?                    */
/* -------------------------------------------------------------------------- */

/**
 * The rule that kills generic output: every post must name at least one real
 * thing — a control, a protocol, a clause, a measured number. Without this,
 * "we help you stay secure" scores as highly as an architecture breakdown.
 */
export const SPECIFICITY_TERMS = [
  // UK regulation & government
  'NCSC', 'Cyber Assessment Framework', 'UK CAF', 'CAF', 'Cyber Resilience Bill',
  'PSTI Act', 'NIS Regulations', 'Cyber Essentials', 'CSP', 'DSIT',
  'FCA', 'PRA', 'SYSC', 'Operational Resilience', 'Critical Third Party', 'CTP',
  // Swiss / EU regulation
  'FINMA', 'revFADP', 'nFADP', 'revDSG', 'FADP', 'DSG', 'Circular 2023/1',
  'Circular 2018/3', 'FINMA Circular', 'EDÖB', 'FDPIC', 'ISG', 'Melde- und Analysestelle',
  'NIS2', 'DORA', 'GDPR', 'PSD2', 'MiFID', 'EU AI Act', 'CRA', 'Cyber Resilience Act',
  'ISO 27001', 'ISO 27017', 'SOC 2', 'PCI DSS', 'SWIFT CSCF', 'Basel III',
  // Standards & clauses
  'Article 21', 'Art. 21', 'Article 32', 'Art. 32', 'Annex III', 'Recital',
  // Protocols, primitives, tech
  'eBPF', 'mTLS', 'TLS 1.3', 'OIDC', 'OAuth', 'SAML', 'SPIFFE', 'SPIRE',
  'Kerberos', 'X.509', 'PKI', 'HSM', 'KMS', 'TPM', 'FIDO2', 'WebAuthn',
  'OPA', 'Rego', 'Vault', 'Cosign', 'Sigstore', 'SBOM', 'SLSA', 'in-toto',
  'QUIC', 'gRPC', 'Mutual TLS', 'token binding', 'certificate pinning',
  'SIEM', 'SOAR', 'EDR', 'XDR', 'NDR', 'WAF', 'CASB', 'DSPM', 'CNAPP',
  'OpenTelemetry', 'Fluent Bit', 'Fluentd', 'Vector', 'syslog', 'RFC 5424',
  'CEF', 'OCSF', 'OpenSearch', 'Elastic', 'Kafka', 'ClickHouse', 'pgvector',
  'MCP', 'Model Context Protocol', 'RAG', 'prompt injection', 'agentic',
  'row-level security', 'zero trust', 'data plane', 'control plane',
  'confidential computing', 'enclave', 'SGX', 'SEV-SNP', 'attestation',
  'key rotation', 'envelope encryption', 'tamper-evident', 'Merkle',
  'hash chain', 'append-only', 'WORM', 'immutable log', 'audit trail',
  'blast radius', 'lateral movement', 'supply chain', 'SBOM attestation',

  // Presales / bid / commercial artefacts — this is what the house speaks about.
  'MEDDPICC', 'MEDDIC', 'RFP', 'RFI', 'RFQ', 'ITT', 'PQQ', 'SOW', 'MSA', 'NDA',
  'G-Cloud', 'Crown Commercial Service', 'CCS', 'OJEU', 'SIMAP', 'below-threshold',
  'CIS Benchmarks', 'CMMC', 'Essential Eight', 'NIST CSF', 'ISO 27001', 'SOC 2',
  'rate card', 'day rate', 'gross margin', 'contribution margin', 'win rate',
  'attach rate', 'stage gate', 'deal review', 'discount approval', 'true-up',
  'co-term', 'bill of materials', 'BOM', 'Salesforce', 'HubSpot', 'Dynamics',
  'proof of concept', 'bake-off', 'land and expand', 'competitive displacement',
]

const SPECIFICITY_PATTERNS = [
  // Clause references: "Art. 21", "Article 32(1)", "§ 12"
  /\b(?:art|article|annex|section|clause|recital|§)\.?\s*\d+[a-z()0-9.]*/gi,
  // Regulatory circulars: "Circular 2023/1"
  /\bcircular\s+\d{4}\/\d+/gi,
  // Performance percentiles and measured numbers — "p99", "40ms", "12 GB", "3x"
  /\bp(?:50|95|99|999)\b/gi,
  /\b\d[\d.,]*\s?(?:%|ms|µs|us|ns|s\b|sec|seconds|minutes|hours|MB|GB|TB|PB|Mbps|Gbps|Tbps|rps|qps|IOPS)/gi,
  /\b\d[\d.,]*x\b/gi,
  // Named operational objectives
  /\b(?:RTO|RPO|MTTR|MTTD|SLA|SLO|SLA breach|error budget|TTL)\b/gi,
  // Versioned artifacts
  /\b[A-Z][A-Za-z0-9]+(?:\s[A-Z][A-Za-z0-9]+)*\s(?:v)?\d+\.\d+\b/g,
]

const buildTermMatcher = (terms) => {
  const escaped = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(?:^|[^\\w-])(${escaped.join('|')})(?![\\w-])`, 'gi')
}
const TERM_MATCHER = buildTermMatcher(SPECIFICITY_TERMS)

/** Returns the distinct concrete artifacts found in `text`. */
export function findSpecificity(text) {
  const found = new Set()
  for (const m of text.matchAll(TERM_MATCHER)) found.add(m[1])
  for (const re of SPECIFICITY_PATTERNS) {
    for (const m of text.matchAll(re)) found.add(m[0].trim())
  }
  return [...found]
}

/* -------------------------------------------------------------------------- */
/* Text metrics                                                                */
/* -------------------------------------------------------------------------- */

const ABBREVIATIONS = [
  'e.g.', 'i.e.', 'etc.', 'vs.', 'cf.', 'al.', 'Inc.', 'Ltd.', 'Dr.', 'Mr.',
  'Ms.', 'No.', 'Art.', 'Sec.', 'approx.', 'resp.', 'ca.', 'p.a.',
]

function splitSentences(text) {
  let work = text.replace(/\s+/g, ' ').trim()
  const held = []
  ABBREVIATIONS.forEach((abbr, i) => {
    const token = `\u0000${i}\u0000`
    work = work.split(abbr).join(token)
    held.push([token, abbr])
  })
  return work
    .split(/(?<=[.!?])\s+/)
    .map((s) => {
      let out = s.trim()
      for (const [token, abbr] of held) out = out.split(token).join(abbr)
      return out
    })
    .filter(Boolean)
}

const wordCount = (text) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length

function stdev(nums) {
  if (nums.length < 2) return 0
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1)
  return Math.sqrt(variance)
}

/* -------------------------------------------------------------------------- */
/* The linter                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} text        the copy to check
 * @param {object} [options]
 * @param {'post'|'comment'} [options.kind='post']
 * @param {number} [options.minScore=70]
 * @param {string[]} [options.bannedExtra=[]]
 * @returns {{score:number, passed:boolean, violations:Array, metrics:object}}
 */
export function lint(text, options = {}) {
  const {
    kind = 'post',
    minScore = 70,
    bannedExtra = [],
  } = options

  const violations = []
  const add = (rule, severity, detail, extra = {}) =>
    violations.push({ rule, severity, detail, ...extra })

  const body = String(text ?? '')
  const trimmed = body.trim()

  if (!trimmed) {
    add('empty', 'hard', 'no content to verify')
    return {
      score: 0,
      passed: false,
      violations,
      metrics: { words: 0, sentences: 0, stdevSentenceLen: 0, specificity: 0, artifacts: [] },
    }
  }

  const lower = trimmed.toLowerCase()
  const sentences = splitSentences(trimmed)
  const lengths = sentences.map(wordCount).filter((n) => n > 0)
  const words = wordCount(trimmed)
  const artifacts = findSpecificity(trimmed)

  /* --- 1. banned vocabulary ------------------------------------------------ */
  for (const term of BANNED_HARD) {
    const re = new RegExp(`(?:^|[^\\w-])${term.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![\\w-])`, 'i')
    const m = re.exec(lower)
    if (m) {
      const idx = lower.indexOf(term.toLowerCase())
      add('banned_word', 'hard', term, { index: idx >= 0 ? idx : undefined })
    }
  }
  for (const term of BANNED_SOFT) {
    const re = new RegExp(`(?:^|[^\\w-])${term.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![\\w-])`, 'i')
    const m = re.exec(lower)
    if (m) {
      const idx = lower.indexOf(term.toLowerCase())
      add('ai_tell', 'soft', term, { index: idx >= 0 ? idx : undefined })
    }
  }
  for (const term of bannedExtra) {
    if (!term) continue
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    if (re.test(lower)) add('banned_custom', 'hard', term)
  }

  /* --- 2. openers and closers --------------------------------------------- */
  const firstSentence = sentences[0] ?? trimmed
  for (const [re, label] of BANNED_OPENER_PATTERNS) {
    if (re.test(firstSentence)) add('banned_opener', 'hard', label)
  }
  for (const [re, label] of BANNED_CLOSER_PATTERNS) {
    if (re.test(trimmed)) add('banned_closer', 'hard', label)
  }
  const lastSentence = sentences[sentences.length - 1] ?? ''
  if (PREACHY_PATTERN.test(lastSentence)) {
    add('preachy_summary', 'soft', lastSentence.slice(0, 60))
  }

  /* --- 3. formatting tropes ----------------------------------------------- */
  const pictographs = trimmed.match(/\p{Extended_Pictographic}/gu)
  if (pictographs) {
    add('emoji', 'hard', pictographs.join(' '))
  }

  // Two shapes of the same trope:
  //   "It's not about X. It's about Y."          (the literal house-style ban)
  //   "Sovereignty isn't a checkmark. It's ..."  (the far more common variant)
  const contrastFlip =
    /\bit'?s not (?:about |just |only )?[^.!?]{1,70}[.!]\s*it'?s (?:about|really|the)\b/i.exec(trimmed) ||
    /\b(?:isn'?t|aren'?t|is not|are not|wasn'?t|weren'?t)\s+(?:about |just |only |a |an |the |merely )?[^.!?]{1,60}[.!]\s*(?:it'?s|that'?s|this is|it is)\b/i.exec(
      trimmed,
    )
  if (contrastFlip) add('contrast_flip', 'hard', contrastFlip[0].slice(0, 70))

  const boldBullets = trimmed.match(/^\s*(?:[-*•]|\d+[.)])?\s*\*\*[^*\n]{2,60}:?\*\*/gm) || []
  if (boldBullets.length >= 3) {
    add('bold_bullet_symmetry', 'hard', `${boldBullets.length} bolded list headers`)
  }

  const hashtags = trimmed.match(/#[\p{L}\p{N}_]+/gu) || []
  if (hashtags.length > 5) add('hashtag_spam', 'soft', `${hashtags.length} hashtags`)
  else if (hashtags.length > 3) add('hashtag_heavy', 'soft', `${hashtags.length} hashtags`)

  const mentions = trimmed.match(/(?:^|\s)@[\p{L}\p{N}_.-]+/gu) || []
  if (mentions.length > 3) add('mention_spam', 'hard', `${mentions.length} @mentions`)

  /* --- 4. specificity ------------------------------------------------------ */
  if (artifacts.length === 0) {
    add('no_specificity', 'hard', 'no concrete artifact (protocol, clause, control or measured number)')
  } else if (artifacts.length < 2 && kind === 'post') {
    add('thin_specificity', 'soft', `only one artifact: ${artifacts[0]}`)
  }

  /* --- 5. rhythm / burstiness --------------------------------------------- */
  // Engages from five sentences: a 25-110 word comment typically has 4-6, so a
  // six-sentence floor would let most comments through unchecked.
  if (lengths.length >= 5) {
    const sd = stdev(lengths)
    if (sd < 3.5) {
      add('low_burstiness', 'soft', `sentence-length stdev ${sd.toFixed(1)} — too uniform`)
    }
    if (!lengths.some((n) => n <= 9)) {
      add('no_short_sentence', 'soft', 'no blunt short sentence for rhythm')
    }
  }
  const longest = Math.max(0, ...lengths)
  if (longest > 34) add('long_sentence', 'soft', `longest sentence ${longest} words`)

  /* --- 6. length ----------------------------------------------------------- */
  const [minW, maxW] = kind === 'comment' ? [25, 110] : [120, 180]
  const [floorW, ceilW] = kind === 'comment' ? [12, 170] : [80, 260]
  if (words < floorW || words > ceilW) {
    add('word_count', 'hard', `${words} words (target ${minW}-${maxW})`)
  } else if (words < minW || words > maxW) {
    add('word_count_off', 'soft', `${words} words (target ${minW}-${maxW})`)
  }

  /* --- 7. throat-clearing opener ------------------------------------------ */
  const openingWords = wordCount(firstSentence)
  const abstractNouns =
    /\b(security|cyber|landscape|world|industry|business|technology|companies|organisations|organizations|leaders|teams|threats|solutions|digital)\b/i
  if (
    sentences.length >= 3 &&
    openingWords <= 18 &&
    findSpecificity(firstSentence).length === 0 &&
    abstractNouns.test(firstSentence)
  ) {
    add('throat_clearing', 'soft', `generic opener: "${firstSentence.slice(0, 60)}"`)
  }

  /* --- score --------------------------------------------------------------- */
  const hardCount = violations.filter((v) => v.severity === 'hard').length
  const softCount = violations.filter((v) => v.severity === 'soft').length
  const raw = 100 - hardCount * 22 - softCount * 7
  const score = Math.max(0, Math.min(100, Math.round(raw)))

  return {
    score,
    passed: hardCount === 0 && score >= minScore,
    violations,
    metrics: {
      words,
      sentences: sentences.length,
      stdevSentenceLen: Number(stdev(lengths).toFixed(2)),
      longestSentence: longest,
      specificity: artifacts.length,
      artifacts,
      hardCount,
      softCount,
    },
  }
}

export default { lint, findSpecificity, SPECIFICITY_TERMS, BANNED_HARD, BANNED_SOFT }
