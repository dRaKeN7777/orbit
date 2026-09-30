#!/usr/bin/env node
/**
 * Standalone worker — runs the automation on a cron without the web server.
 *
 * Useful when you want the pipeline on a small always-on box and the UI
 * somewhere else: both processes share the same SQLite file. Do NOT run this
 * alongside `npm start` unless you set WORKER_ENABLED=false on the server, or
 * the two will both fire the same jobs.
 */

import { envConfig } from './config.mjs'
import { openDb, getSettings } from './db.mjs'
import { startScheduler } from './lib/cron.mjs'
import { publishDue, runPipeline } from './lib/pipeline.mjs'
import { ensureSeed } from './seed.mjs'

const db = openDb(envConfig.dbPath)
ensureSeed(db, { force: false })

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (msg, level = 'info') => console.log(`${stamp()}  ${level.padEnd(5)}  ${msg}`)

const settings = () => getSettings(db)

const run = async (mode) => {
  const result = await runPipeline(db, { mode, settings: settings(), emit: () => {} })
  const stats = JSON.parse(result.stats || '{}')
  log(`pipeline ${mode}: ${result.status} in ${result.duration_ms}ms ${JSON.stringify(stats)}`)
}

const scheduler = startScheduler({
  log,
  jobs: [
    {
      name: 'pipeline:research',
      cron: settings().schedule_cron || envConfig.worker.ingestCron,
      run: () => run('research'),
    },
    { name: 'pipeline:draft', cron: envConfig.worker.draftCron, run: () => run('draft') },
    {
      name: 'pipeline:publish',
      cron: settings().publish_cron || envConfig.worker.publishCron,
      run: async () => {
        const s = settings()
        if (!s.auto_publish) {
          log('auto_publish is off — nothing will be published automatically', 'warn')
          return
        }
        const res = await publishDue(db, { settings: s, log })
        log(`publish: ${res.published.length} published, ${res.failed.length} failed`)
      },
    },
    { name: 'pipeline:website', cron: envConfig.worker.websiteCron, run: () => run('website') },
  ],
})

log(`worker started — ${scheduler.jobs.length} jobs armed`)
for (const job of scheduler.describe()) {
  log(`  ${job.name.padEnd(20)} ${job.cron.padEnd(16)} next ${job.next ?? 'n/a'}`)
}
log(`auto_publish=${envConfig.worker.autoPublish}  publisher=${envConfig.publisher.kind}`)

process.on('SIGINT', () => {
  scheduler.stop()
  process.exit(0)
})
process.on('SIGTERM', () => {
  scheduler.stop()
  process.exit(0)
})
