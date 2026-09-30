#!/usr/bin/env node
/**
 * Orbit CLI — drive the pipeline without the web UI, or from cron.
 *
 *   npm run seed
 *   npm run ingest
 *   npm run topics
 *   npm run pipeline -- --mode full
 *   npm run publish
 *   node src/cli.mjs lint "your draft copy"
 *   node src/cli.mjs import watchlist.csv
 *   node src/cli.mjs doctor
 */

import { readFileSync } from 'node:fs'
import { envConfig, VERSION, llmMode } from './config.mjs'
import { openDb, getSettings } from './db.mjs'
import { ensureSeed } from './seed.mjs'
import { importTargets } from './lib/targets.mjs'
import { parseCsv } from './lib/csv.mjs'
import { ingest } from './lib/ingest.mjs'
import { recomputeTopics, listTopics } from './lib/topics.mjs'
import { publishDue, runPipeline, scheduleVerifiedDrafts, startRun } from './lib/pipeline.mjs'
import { planWebsiteUpdate, applyWebsiteUpdate, listWebsiteUpdates } from './lib/website.mjs'
import { lint } from './lib/lint.mjs'
import { publisherStatus } from './lib/publish.mjs'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'

const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}
const has = (name) => argv.includes(`--${name}`)
const positional = argv.slice(1).filter((a) => !a.startsWith('--'))

const db = openDb(envConfig.dbPath)
const settings = () => getSettings(db)

const c = {
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  red: (s) => `\u001b[31m${s}\u001b[0m`,
  yellow: (s) => `\u001b[33m${s}\u001b[0m`,
  cyan: (s) => `\u001b[36m${s}\u001b[0m`,
}

const heading = (t) => console.log(`\n${c.bold(t)}\n${c.dim('─'.repeat(Math.max(20, t.length)))}`)

const logger = (msg, level = 'info') => {
  const tag =
    level === 'error' ? c.red('  err ') : level === 'warn' ? c.yellow(' warn ') : c.dim(' info ')
  console.log(`${tag} ${msg}`)
}

/* -------------------------------------------------------------------------- */

const commands = {
  async help() {
    console.log(`
${c.bold(`Orbit ${VERSION}`)} — ${c.dim('account-based social listening for UK/CH cyber executives')}

${c.bold('Usage')}  node src/cli.mjs <command> [options]

  ${c.cyan('seed')}                  insert the 31-entry sample watchlist (--force to re-add)
  ${c.cyan('import')} <file.csv>     import a real watchlist (columns: name,company,region,linkedin_url,title,email)
  ${c.cyan('ingest')}                run the reading pipeline only
  ${c.cyan('topics')}                recompute the topic matrix (--days N, default 14)
  ${c.cyan('pipeline')}              run the full pipeline (--mode full|research|draft|publish|website)
  ${c.cyan('schedule')}              queue verified drafts into posting slots
  ${c.cyan('publish')}               drain the scheduler queue (--force to ignore scheduled_at)
  ${c.cyan('website')}               plan a page from the top cluster, or --apply <id> to write it
  ${c.cyan('drafts')}                list drafts with their verification status
  ${c.cyan('lint')} <text|file>      run the anti-AI-smell verifier on arbitrary copy
  ${c.cyan('doctor')}                print configuration and readiness

${c.bold('Examples')}
  node src/cli.mjs import watchlist.csv
  node src/cli.mjs pipeline --mode full
  node src/cli.mjs schedule
  node src/cli.mjs lint "$(cat post.txt)"
`)
  },

  async seed() {
    heading('Seed watchlist')
    const result = ensureSeed(db, { force: has('force') })
    console.log(
      result.skipped
        ? `  ${c.yellow('skipped')} — ${result.total} targets already present (use --force to add samples anyway)`
        : `  ${c.green('ok')} — inserted ${result.inserted}, ${result.total} targets total`,
    )
  },

  async import() {
    const file = positional[0]
    if (!file) throw new Error('usage: import <file.csv>')
    heading(`Import ${file}`)
    const rows = parseCsv(readFileSync(file, 'utf8'))
    const result = importTargets(db, rows, { defaultRegion: String(flag('region', 'UK')).toUpperCase() })
    console.log(`  ${c.green('ok')} — imported ${result.imported}, skipped ${result.skipped}`)
    for (const e of result.errors.slice(0, 10)) console.log(`  ${c.yellow('warn')} ${e}`)
  },

  async ingest() {
    heading('Ingest')
    const targets = db.prepare('SELECT * FROM targets WHERE active = 1').all()
    if (!targets.length) {
      console.log(`  ${c.yellow('no active targets')} — run: node src/cli.mjs seed`)
      return
    }
    const run = startRun(db, 'ingest', () => {})
    const result = await ingest({ db, targets, log: logger })
    run.setStats(result)
    run.finish('succeeded')
    console.log(
      `\n  ${c.green('ok')} — ${result.inserted} new posts from ${result.fetched} fetched via ${result.provider}`,
    )
    for (const e of result.errors) console.log(`  ${c.yellow('warn')} ${e}`)
  },

  async topics() {
    heading('Topic matrix')
    const days = Number.parseInt(flag('days', '14'), 10)
    const result = recomputeTopics(db, { days, log: logger })
    const items = listTopics(db, { limit: 12 })
    console.log('')
    for (const t of items) {
      const regions = `UK:${t.regions.UK ?? 0} CH:${t.regions.CH ?? 0}`
      const trend = t.trend === 'rising' ? c.green('▲ rising') : t.trend === 'falling' ? c.red('▼ falling') : c.dim('• steady')
      console.log(
        `  ${String(t.mentions).padStart(3)}  ${t.urgency.padEnd(6)} ${trend.padEnd(18)} ${t.label}  ${c.dim(regions)}`,
      )
    }
    console.log(`\n  ${c.green('ok')} — ${result.topics} clusters from ${result.posts} posts`)
  },

  async pipeline() {
    const mode = String(flag('mode', 'full'))
    heading(`Pipeline: ${mode}`)
    const run = await runPipeline(db, { mode, settings: settings(), emit: () => {} })
    const stats = JSON.parse(run.stats || '{}')
    for (const line of JSON.parse(run.log || '[]').slice(-30)) {
      logger(line.msg, line.level)
    }
    console.log(
      `\n  ${run.status === 'succeeded' ? c.green('ok') : c.red('failed')} — ${run.duration_ms}ms  ${JSON.stringify(stats)}`,
    )
  },

  async schedule() {
    heading('Auto-schedule verified drafts')
    const result = scheduleVerifiedDrafts(db, {
      settings: settings(),
      limit: Number.isFinite(Number(flag('limit'))) ? Number(flag('limit')) : null,
      log: logger,
    })
    const slots = result.slots ?? []
    console.log('')
    for (const s of slots) console.log(`  ${c.green('→')} ${s}`)
    console.log(
      `\n  ${c.green('ok')} — ${result.scheduled} queued, ${result.skipped} sent back to review`,
    )
    if (!settings().auto_schedule) {
      console.log(
        c.dim('  note: auto_schedule is off, so the pipeline will not do this by itself'),
      )
    }
  },

  async publish() {
    heading('Publish due')
    const run = startRun(db, 'publish', () => {})
    const result = await publishDue(db, { settings: settings(), run, force: has('force'), log: logger })
    run.setStats({ published: result.published.length, failed: result.failed.length })
    run.finish('succeeded')
    console.log(
      `\n  ${c.green('ok')} — ${result.published.length} published, ${result.failed.length} failed, ${result.skipped} skipped`,
    )
    for (const p of result.published) console.log(`  ${c.green('→')} ${p.url ?? `schedule ${p.schedule_id}`}`)
    for (const f of result.failed) console.log(`  ${c.red('✗')} schedule ${f.schedule_id}: ${f.error}`)
  },

  async website() {
    const applyId = flag('apply')
    if (applyId) {
      heading(`Apply website update ${applyId}`)
      const update = await applyWebsiteUpdate(db, Number(applyId), { settings: settings(), log: logger })
      console.log(`\n  ${c.green('ok')} — status ${update.status}`)
      const result = update.result ?? {}
      for (const f of result.written ?? []) console.log(`  written: ${f}`)
      if (result.commit) console.log(`  commit:  ${result.commit}`)
      if (result.preview_url) console.log(`  preview: ${result.preview_url}`)
      return
    }
    heading('Plan website update')
    const update = await planWebsiteUpdate(db, {
      topicSlug: flag('topic', null),
      kind: String(flag('kind', 'insight')),
      settings: settings(),
      log: logger,
    })
    console.log(`\n  ${c.green('ok')} — #${update.id} "${update.title}"`)
    console.log(`  path : ${update.target_path}`)
    console.log(`  lint : ${update.result?.lint?.score ?? 'n/a'} (${update.result?.lint?.passed ? 'passed' : 'failed'})`)
    if (has('apply')) {
      const applied = await applyWebsiteUpdate(db, update.id, { settings: settings(), log: logger })
      console.log(`  ${c.green('applied')} — ${JSON.stringify(applied.result?.written ?? [])}`)
    } else {
      console.log(c.dim(`\n  review it in the UI, or re-run with --apply`))
    }
    const all = listWebsiteUpdates(db, { limit: 5 })
    if (all.length > 1) {
      console.log(c.dim(`\n  recent updates: ${all.map((u) => `#${u.id} ${u.status}`).join(', ')}`))
    }
  },

  async drafts() {
    heading('Drafts')
    const rows = db
      .prepare(
        `SELECT d.id, d.status, d.topic_slug, d.lint, t.name AS target_name, t.region
           FROM drafts d LEFT JOIN targets t ON t.id = d.target_id
          ORDER BY d.id DESC LIMIT 30`,
      )
      .all()
    if (!rows.length) {
      console.log(c.dim('  none yet — run: node src/cli.mjs pipeline --mode full'))
      return
    }
    for (const r of rows) {
      const state = JSON.parse(r.lint || '{}')
      const mark = state.passed ? c.green('✓') : c.red('✗')
      console.log(
        `  ${mark} #${String(r.id).padStart(3)}  ${String(state.score ?? 0).padStart(3)}  ${r.status.padEnd(12)} ${String(r.target_name ?? '—').padEnd(20)} ${c.dim(r.topic_slug ?? '')}`,
      )
    }
    const failed = rows.filter((r) => !JSON.parse(r.lint || '{}').passed).length
    console.log(`\n  ${rows.length} drafts, ${failed} failing verification`)
  },

  async lint() {
    const input = positional[0]
    if (!input) throw new Error('usage: lint "<text>"  (or a path to a file)')
    let text = input
    try {
      if (!input.includes(' ') && input.includes('.')) text = readFileSync(input, 'utf8')
    } catch {
      /* treat as literal text */
    }
    heading('Verifier')
    for (const kind of ['post', 'comment']) {
      const result = lint(text, { kind, minScore: 70, bannedExtra: settings().banned_extra ?? [] })
      const verdict = result.passed ? c.green('PASS') : c.red('FAIL')
      console.log(`\n  ${c.bold(kind.padEnd(8))} ${verdict}  score ${result.score}/100`)
      console.log(
        c.dim(
          `           ${result.metrics.words} words · ${result.metrics.sentences} sentences · stdev ${result.metrics.stdevSentenceLen} · ${result.metrics.specificity} artifacts`,
        ),
      )
      if (result.metrics.artifacts?.length) {
        console.log(c.dim(`           artifacts: ${result.metrics.artifacts.join(', ')}`))
      }
      for (const v of result.violations) {
        const sev = v.severity === 'hard' ? c.red('hard') : c.yellow('soft')
        console.log(`           ${sev}  ${v.rule}: ${v.detail}`)
      }
    }
    console.log('')
  },

  async doctor() {
    heading('Doctor')
    const one = (sql) => db.prepare(sql).get()?.n ?? 0
    const pub = publisherStatus()
    const rows = [
      ['version', VERSION],
      ['database', envConfig.dbPath],
      ['llm mode', llmMode === 'offline' ? `${llmMode} ${c.yellow('(no DEEPSEEK_API_KEY — using the offline composer)')}` : `${llmMode} @ ${envConfig.llm.baseUrl}`],
      ['reasoning model', envConfig.llm.reasoningModel],
      ['writer model', envConfig.llm.writerModel],
      ['scraper', `${envConfig.scraper.provider}${envConfig.scraper.provider === 'sample' ? c.yellow(' (synthetic posts)') : ''}`],
      ['publisher', `${pub.kind}${pub.ready ? c.green(' ready') : c.red(' not configured')}`],
      ['website writer', `${envConfig.website.target} → ${envConfig.website.path}`],
      ['worker', envConfig.worker.enabled ? 'enabled' : 'disabled'],
      ['auto publish', envConfig.worker.autoPublish ? c.yellow('ON') : 'off (drafts queue for review)'],
      ['targets', `${one('SELECT COUNT(*) AS n FROM targets')} (UK ${one("SELECT COUNT(*) AS n FROM targets WHERE region='UK'")} / CH ${one("SELECT COUNT(*) AS n FROM targets WHERE region='CH'")})`],
      ['posts', String(one('SELECT COUNT(*) AS n FROM posts'))],
      ['topics', String(one('SELECT COUNT(*) AS n FROM topics'))],
      ['drafts', String(one('SELECT COUNT(*) AS n FROM drafts'))],
      ['awaiting review', String(one("SELECT COUNT(*) AS n FROM drafts WHERE status='needs_review'"))],
      ['scheduled', String(one("SELECT COUNT(*) AS n FROM schedules WHERE status='pending'"))],
      ['published', String(one("SELECT COUNT(*) AS n FROM schedules WHERE status='published'"))],
    ]
    console.log('')
    for (const [k, v] of rows) console.log(`  ${k.padEnd(17)} ${v}`)
    console.log('')
  },
}

try {
  const handler = commands[command]
  if (!handler) {
    console.error(`Unknown command "${command}". Run: node src/cli.mjs help`)
    process.exit(1)
  }
  await handler()
} catch (err) {
  console.error(`\n  ${c.red('error')} ${err.message}\n`)
  process.exit(1)
}
