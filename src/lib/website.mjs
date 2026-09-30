/**
 * Website pipeline.
 *
 * Turns a topic cluster into a publishable page, then writes it through the
 * configured writer. Three writers:
 *
 *   static    -> write the Markdown into WEBSITE_PATH (safe default)
 *   git       -> write it, then `git add` + `git commit` in WEBSITE_PATH
 *   wordpress -> create a draft post through the WordPress REST API
 *
 * Website copy is held to the same anti-AI-smell rules as social copy, but the
 * length and specificity-of-a-single-post rules do not apply to a long page, so
 * only the structural rules gate it.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { envConfig, llmMode } from '../config.mjs'
import { nowIso } from '../db.mjs'
import { findSpecificity, lint } from './lint.mjs'
import { ANTI_AI_RULES } from './llm.mjs'
import { mdToHtml } from './markdown.mjs'

/** Rules that still make sense for a long-form page. */
const STRUCTURAL_RULES = new Set([
  'banned_word', 'banned_custom', 'ai_tell', 'banned_opener', 'banned_closer',
  'emoji', 'contrast_flip', 'bold_bullet_symmetry', 'mention_spam',
  'preachy_summary', 'throat_clearing',
])

export function lintWebsite(body) {
  const raw = lint(body, { kind: 'post' })
  const violations = raw.violations.filter((v) => STRUCTURAL_RULES.has(v.rule))
  const hardCount = violations.filter((v) => v.severity === 'hard').length
  const softCount = violations.filter((v) => v.severity === 'soft').length
  return {
    score: Math.max(0, Math.min(100, 100 - hardCount * 22 - softCount * 7)),
    passed: hardCount === 0,
    violations,
    metrics: raw.metrics,
  }
}

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)

const KIND_PATH = {
  insight: 'content/insights',
  service_page: 'content/services',
  case_note: 'content/work',
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

function offlinePage({ topic, artifacts, settings, kind }) {
  const focus = settings.our_focus ?? 'security engineering'
  const company = settings.our_company ?? 'We'
  const A = artifacts[0] ?? 'the Cyber Assessment Framework'
  const B = artifacts[1] ?? 'revFADP'
  const label = topic?.label ?? 'this problem'

  // Keep the label's own casing — it carries acronyms (SIEM, FINMA, NIS2) that
  // must not be flattened, and avoid verb-agreement traps with plural labels.
  const title =
    kind === 'service_page'
      ? `Bringing rigour to ${label}`
      : kind === 'case_note'
        ? `Field notes: ${label}`
        : `${label}: what a repeatable presales process has to prove`

  const summary =
    topic?.summary ??
    `Where ${label} stops being a people problem and becomes a records problem.`

  // The summary is rendered as the standfirst, so it is deliberately not
  // repeated as the opening paragraph here.
  const body = `# ${title}

## Where it breaks

Most presales teams can show a process that says the right thing. Fewer can show that it ran on a specific deal. The gap between those two positions is where ${A} reviews are lost, and it is rarely a tooling gap. It is a records gap.

The pattern repeats. The estimate lives in a spreadsheet. The scope lives in the proposal. The delivery assumptions live in someone's head until mobilisation. Each artefact is defensible on its own and the deal still cannot be reconciled.

## Why the obvious fix does not hold

The obvious fix is another template, and it fails for a structural reason. A template describes how a document should look. A deal review asks what a number was built from. Those are different artefacts, and only one of them can be produced on demand.

Adding another dashboard does not close it either. Dashboards summarise; they do not hold the reasoning. The failure mode is a margin figure whose assumptions nobody can name three weeks after submission.

## What has to change

The number has to be a model, and the proposal has to read from it. Concretely:

- The estimate is built from catalogue and effort inputs, so it can be reproduced rather than remembered.
- Price and scope come from the same source, so they cannot diverge mid-negotiation.
- Approvals route to named approvers, and the decision is recorded against the deal.
- Delivery assumptions are written down at bid time, not reconstructed at handover.

None of that is exotic. It is a decision about where the numbers live.

## How we approach it

${company} builds ${focus}. We start with the deal review your team already runs, then work backwards to the smallest set of records that would satisfy it. Usually that is one shared estimate model rather than a platform migration.

Rollout is one team and one live bid. Nothing depends on a cutover weekend, and the parts of the process that already work are left alone.

## What this looks like in practice

A recent engagement took three weeks of setup and put one real bid through the process. Submission time fell by about 40%. The approval route fit on one page. That was the whole deliverable, and it answered the question that had stalled the deal review for two quarters.

If ${label} is on your list of recurring problems, the useful first step is a deal-review walkthrough rather than a product evaluation. We are happy to run one.
`

  return { title, summary, body, slug: slugify(title), artifacts: [A, B] }
}

async function generatePage({ topic, artifacts, settings, kind, log }) {
  if (llmMode === 'offline') return offlinePage({ topic, artifacts, settings, kind })

  const system = `You write long-form technical pages for ${settings.our_company ?? 'a cybersecurity firm'},
specialising in ${settings.our_focus ?? 'security engineering'}.

${ANTI_AI_RULES}

This is a website page, 400-700 words, in Markdown with a single H1.
Use short sections with "## " headings. Prose first; bullets only where a list is genuinely a list,
and never as bolded lead-ins. No call-to-action buttons, no exclamation marks, no emoji.
Return ONLY a JSON object with keys "title", "summary" (one sentence under 200 chars) and "body".`

  const user = `Write a page of kind "${kind}" on this cluster of executive discussion.

Cluster: ${topic?.label ?? 'unknown'}
Recurring concrete artifacts seen in the source posts: ${artifacts.join(', ') || 'none extracted'}
Representative quote from a target executive: ${(topic?.summary ?? '').slice(0, 400)}

Audience: UK and Swiss cybersecurity leaders evaluating vendors.
Return json only.`

  try {
    const res = await fetch(`${envConfig.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${envConfig.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: envConfig.llm.writerModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.7,
        max_tokens: 2500,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(envConfig.llm.timeoutMs),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const parsed = JSON.parse(payload.choices[0].message.content)
    if (!parsed?.title || !parsed?.body) throw new Error('incomplete response')
    return {
      title: parsed.title,
      summary: parsed.summary ?? '',
      body: parsed.body,
      slug: slugify(parsed.title),
      artifacts,
    }
  } catch (err) {
    log(`llm page generation failed (${err.message}); using offline template`)
    return offlinePage({ topic, artifacts, settings, kind })
  }
}


/* -------------------------------------------------------------------------- */
/* Site writer — publishes an insight as a styled page on the real website      */
/* -------------------------------------------------------------------------- */

/** Shared chrome so generated pages look like the rest of the site. */
function insightShell({ title, summary, bodyHtml, updated }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — CyberPresalesOS</title>
<meta name="description" content="${summary}" />
<meta name="theme-color" content="#004530" />
<link rel="icon" href="../assets/logo.jpg" />
<link rel="stylesheet" href="../styles.css" />
<style>
  .article { padding: 150px 0 96px; }
  .article h1 { font-size: clamp(2rem, 4.4vw, 3.2rem); max-width: 780px; }
  .article .lede { margin-top: 22px; }
  .article-body { max-width: 740px; margin-top: 52px; }
  .article-body h2 { margin: 52px 0 16px; font-size: clamp(1.5rem, 2.6vw, 2rem); }
  .article-body h3 { margin: 36px 0 12px; }
  .article-body p { margin: 0 0 20px; color: var(--muted); font-size: 1.04rem; }
  .article-body ul { margin: 0 0 24px; }
  .article-body li { position: relative; padding: 7px 0 7px 24px; color: var(--muted); }
  .article-body li::before { content: ''; position: absolute; left: 0; top: 1.05em;
    width: 8px; height: 8px; border-radius: 2px; background: var(--green); opacity: .5; }
  .article-body strong { color: var(--ink); }
  .article-body blockquote { margin: 32px 0; padding: 20px 26px; border-left: 3px solid var(--green);
    background: var(--cream); border-radius: 0 10px 10px 0; font-family: var(--serif); font-size: 1.16rem; }
  .article-meta { margin-top: 18px; font-size: .86rem; color: var(--muted); }
  .back { display: inline-block; margin-bottom: 30px; font-size: .88rem; color: var(--green); font-weight: 600; }
</style>
</head>
<body>
<header class="nav stuck">
  <div class="wrap nav-inner">
    <a class="brand" href="../index.html">
      <img src="../assets/logo.jpg" alt="" width="34" height="34" />
      <span class="brand-text">Enhancing<b>Security</b></span>
    </a>
    <nav class="nav-links">
      <a href="../index.html#product">Product</a>
      <a href="../index.html#how">How it works</a>
      <a href="index.html">Insights</a>
      <a href="../index.html#pricing">Pricing</a>
    </nav>
    <div class="nav-cta"><a class="btn btn-solid" href="../index.html#cta">Request access</a></div>
  </div>
</header>

<main class="article">
  <div class="wrap">
    <a class="back" href="index.html">&larr; All insights</a>
    <h1>${title}</h1>
    <p class="lede dark">${summary}</p>
    <p class="article-meta">Updated ${updated}</p>
    <div class="article-body">
${bodyHtml}
    </div>
  </div>
</main>

<footer class="foot">
  <div class="wrap foot-base" style="margin-top:0;border-top:0">
    <p>© ${new Date().getUTCFullYear()} Enhancing Security · enhancingprofit.com</p>
    <p><a href="../index.html">Home</a></p>
  </div>
</footer>
</body>
</html>
`
}

function writeSiteInsights({ update, settings, log, db }) {
  const root = resolve(settings.website_path || envConfig.website.path)
  const dir = join(root, 'insights')
  mkdirSync(dir, { recursive: true })

  const { title, summary, bodyHtml, updated } = renderInsight(update)
  const file = join(dir, `${update.slug}.html`)
  writeFileSync(file, insightShell({ title, summary, bodyHtml, updated }), 'utf8')
  log(`site: wrote ${file}`)

  // Rebuild the listing from every applied update.
  let rows = []
  if (db) {
    try {
      rows = db
        .prepare(
          `SELECT title, slug, summary, applied_at FROM website_updates
            WHERE status = 'applied' ORDER BY applied_at DESC`,
        )
        .all()
    } catch {
      rows = []
    }
  }
  if (!rows.some((r) => r.slug === update.slug)) {
    rows.unshift({ title, slug: update.slug, summary, applied_at: update.applied_at ?? null })
  }

  // Only list pages that actually exist on disk. Older updates were applied
  // before the site writer existed and have no HTML, so linking them would 404.
  rows = rows.filter((r) => {
    try {
      return existsSync(join(dir, `${r.slug}.html`))
    } catch {
      return false
    }
  })

  const cards = rows
    .map(
      (r) => `      <a class="insight-card" href="${r.slug}.html">
        <h3>${esc(r.title)}</h3>
        <p>${esc(r.summary || '')}</p>
      </a>`,
    )
    .join('\n')

  const index = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Insights — CyberPresalesOS</title>
<meta name="theme-color" content="#004530" />
<link rel="icon" href="../assets/logo.jpg" />
<link rel="stylesheet" href="../styles.css" />
<style>
  .insights { padding: 150px 0 110px; }
  .insight-list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 22px; margin-top: 48px; }
  .insight-card { display: block; padding: 28px 26px; background: #fff; border: 1px solid var(--line);
    border-radius: var(--r); transition: transform .3s var(--ease), box-shadow .3s, border-color .3s; }
  .insight-card:hover { transform: translateY(-4px); box-shadow: var(--shadow); border-color: rgba(0,69,48,.24); }
  .insight-card h3 { font-size: 1.16rem; margin-bottom: 10px; color: var(--green); }
  .insight-card p { color: var(--muted); font-size: .95rem; }
  @media (max-width: 760px) { .insight-list { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header class="nav stuck">
  <div class="wrap nav-inner">
    <a class="brand" href="../index.html">
      <img src="../assets/logo.jpg" alt="" width="34" height="34" />
      <span class="brand-text">Enhancing<b>Security</b></span>
    </a>
    <nav class="nav-links">
      <a href="../index.html#product">Product</a>
      <a href="../index.html#how">How it works</a>
      <a href="index.html">Insights</a>
      <a href="../index.html#pricing">Pricing</a>
    </nav>
    <div class="nav-cta"><a class="btn btn-solid" href="../index.html#cta">Request access</a></div>
  </div>
</header>

<main class="insights">
  <div class="wrap">
    <p class="kicker">Insights</p>
    <h2>Notes from the presales floor.</h2>
    <p class="lede dark narrow-p">Written from the clusters of conversation our market watch surfaces each week.</p>
    <div class="insight-list">
${cards || '      <p class="lede dark">No insights published yet.</p>'}
    </div>
  </div>
</main>

<footer class="foot">
  <div class="wrap foot-base" style="margin-top:0;border-top:0">
    <p>© ${new Date().getUTCFullYear()} Enhancing Security · enhancingprofit.com</p>
    <p><a href="../index.html">Home</a></p>
  </div>
</footer>
</body>
</html>
`
  writeFileSync(join(dir, 'index.html'), index, 'utf8')
  log(`site: rebuilt insights index (${rows.length} page${rows.length === 1 ? '' : 's'})`)

  return { written: [file, join(dir, 'index.html')], commit: null, preview_url: null }
}

/** Shared by the site writer. */
function renderInsight(update) {
  const title = String(update.title ?? 'Untitled')
  const summary = String(update.summary ?? '')
  const body = String(update.body ?? '')
  // Drop a leading H1 so the page does not show the title twice.
  let trimmed = body.replace(/^\s*#\s+.*(\r?\n)+/, '')
  // The generator repeats the summary as the opening paragraph; the page already
  // shows it as the standfirst, so drop the duplicate.
  if (summary) {
    const first = trimmed.split(/\r?\n\s*\r?\n/)[0].trim()
    if (first && first.toLowerCase().startsWith(summary.trim().toLowerCase().slice(0, 60))) {
      trimmed = trimmed.slice(trimmed.indexOf(first) + first.length).replace(/^\s+/, '')
    }
  }
  return {
    title,
    summary,
    bodyHtml: mdToHtml(trimmed),
    updated: update.applied_at
      ? new Date(update.applied_at).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10),
  }
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Create a planned website update for a topic cluster. Does not write anything
 * to disk — that happens on apply.
 */
export async function planWebsiteUpdate(db, { topicSlug, kind = 'insight', settings, log = () => {} }) {
  const topic = topicSlug
    ? db.prepare('SELECT * FROM topics WHERE slug = ?').get(topicSlug)
    : db.prepare('SELECT * FROM topics ORDER BY mentions DESC LIMIT 1').get()
  if (!topic) throw new Error('no topic available to plan from — run topics recompute first')

  const postIds = JSON.parse(topic.post_ids || '[]')
  const artifacts = new Set()
  for (const id of postIds.slice(0, 25)) {
    const p = db.prepare('SELECT content_text FROM posts WHERE id = ?').get(id)
    if (!p) continue
    for (const a of findSpecificity(p.content_text)) artifacts.add(a)
  }
  const artifactList = [...artifacts].slice(0, 8)

  const page = await generatePage({ topic, artifacts: artifactList, settings, kind, log })
  const lintResult = lintWebsite(page.body)
  const targetPath = join(KIND_PATH[kind] ?? KIND_PATH.insight, `${page.slug}.md`)

  const info = db
    .prepare(
      `INSERT INTO website_updates
         (topic_slug, kind, title, summary, slug, target_path, body, status, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
    )
    .run(
      topic.slug,
      kind,
      page.title,
      page.summary,
      page.slug,
      targetPath,
      page.body,
      JSON.stringify({ lint: lintResult, artifacts: artifactList, generator: llmMode }),
      nowIso(),
    )

  log(`planned website update "${page.title}" (${targetPath}) lint=${lintResult.score}`)
  return getWebsiteUpdate(db, Number(info.lastInsertRowid))
}

export function getWebsiteUpdate(db, id) {
  const row = db.prepare('SELECT * FROM website_updates WHERE id = ?').get(id)
  if (!row) return null
  return { ...row, result: JSON.parse(row.result || '{}') }
}

export function listWebsiteUpdates(db, { status = null, limit = 100 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM website_updates WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM website_updates ORDER BY created_at DESC LIMIT ?').all(limit)
  return rows.map((r) => ({ ...r, result: JSON.parse(r.result || '{}') }))
}

/* -------------------------------------------------------------------------- */
/* Writers                                                                     */
/* -------------------------------------------------------------------------- */

function writeStatic({ update, settings, log }) {
  const root = resolve(settings.website_path || envConfig.website.path)
  const full = resolve(root, update.target_path)
  if (!full.startsWith(root)) throw new Error('target path escapes the configured website root')
  mkdirSync(dirname(full), { recursive: true })

  const doc = `---
title: ${JSON.stringify(update.title)}
slug: ${JSON.stringify(update.slug)}
summary: ${JSON.stringify(update.summary ?? '')}
generated_by: orbit
topic: ${JSON.stringify(update.topic_slug ?? '')}
created_at: ${nowIso()}
---

${update.body}
`
  writeFileSync(full, doc, 'utf8')
  log(`wrote ${full}`)
  return { written: [full], commit: null, preview_url: null }
}

function gitCommit({ settings, relativePath, message, log }) {
  const root = resolve(settings.website_path || envConfig.website.path)
  const run = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: settings.git_author_name ?? envConfig.website.gitAuthorName,
        GIT_AUTHOR_EMAIL: settings.git_author_email ?? envConfig.website.gitAuthorEmail,
        GIT_COMMITTER_NAME: settings.git_author_name ?? envConfig.website.gitAuthorName,
        GIT_COMMITTER_EMAIL: settings.git_author_email ?? envConfig.website.gitAuthorEmail,
      },
    })
  run(['add', relativePath])
  run(['commit', '-m', message])
  const hash = run(['rev-parse', '--short', 'HEAD']).trim()
  log(`committed ${hash} in ${root}`)
  return hash
}

async function writeWordPress({ update, settings, log }) {
  const url = settings.wordpress_url || envConfig.website.wordpressUrl
  const user = envConfig.website.wordpressUser
  const pass = envConfig.website.wordpressPassword
  if (!url || !user || !pass) {
    throw new Error('WORDPRESS_URL / WORDPRESS_USER / WORDPRESS_APP_PASSWORD are not set')
  }
  const auth = Buffer.from(`${user}:${pass}`).toString('base64')
  const res = await fetch(`${url}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      title: update.title,
      content: update.body,
      slug: update.slug,
      excerpt: update.summary ?? '',
      status: 'draft',
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`WordPress ${res.status}: ${text.slice(0, 300)}`)
  const parsed = JSON.parse(text)
  log(`created WordPress draft ${parsed.id}`)
  return { written: [], commit: null, preview_url: parsed.link ?? null, remote_id: parsed.id }
}

/**
 * Apply a planned update through the configured writer.
 * @returns {Promise<object>} the updated website_updates row
 */
export async function applyWebsiteUpdate(db, id, { settings, log = () => {} }) {
  const update = getWebsiteUpdate(db, id)
  if (!update) throw new Error(`website update ${id} not found`)
  if (update.status === 'applied') throw new Error('update already applied')

  const target = (settings.website_target || envConfig.website.target).toLowerCase()
  let result
  let status = 'applied'

  try {
    if (target === 'wordpress') {
      result = await writeWordPress({ update, settings, log })
    } else if (target === 'site') {
      // Publishes a styled HTML page onto the real website, plus a rebuilt index.
      result = writeSiteInsights({ update, settings, log, db })
    } else {
      result = writeStatic({ update, settings, log })
      if (target === 'git' || settings.git_commit) {
        result.commit = gitCommit({
          settings,
          relativePath: update.target_path,
          message: `content: ${update.title}`,
          log,
        })
      }
    }
  } catch (err) {
    log(`apply failed: ${err.message}`)
    db.prepare('UPDATE website_updates SET status = ?, result = ? WHERE id = ?').run(
      'planned',
      JSON.stringify({ ...update.result, error: err.message }),
      id,
    )
    throw err
  }

  db.prepare(
    'UPDATE website_updates SET status = ?, applied_at = ?, result = ? WHERE id = ?',
  ).run(
    status,
    nowIso(),
    JSON.stringify({ ...update.result, writer: target, ...result }),
    id,
  )
  return getWebsiteUpdate(db, id)
}

export function rejectWebsiteUpdate(db, id) {
  db.prepare('UPDATE website_updates SET status = ? WHERE id = ?').run('rejected', id)
  return getWebsiteUpdate(db, id)
}

export { slugify }
