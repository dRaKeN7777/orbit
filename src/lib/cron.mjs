/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week), UTC.
 * No dependency, no daemon — a single timer that fires jobs whose expression
 * matches the current minute, deduplicated so a slow tick cannot double-run.
 */

const RANGES = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
]

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function parseField(raw, index) {
  const [min, max] = RANGES[index]
  const out = new Set()
  for (let part of raw.split(',')) {
    part = part.trim().toLowerCase()
    if (!part) continue
    if (index === 3 && MONTHS[part]) part = String(MONTHS[part])
    if (index === 4 && DAYS[part] !== undefined) part = String(DAYS[part])

    let step = 1
    const slash = part.indexOf('/')
    if (slash !== -1) {
      step = Number.parseInt(part.slice(slash + 1), 10)
      part = part.slice(0, slash)
      if (!Number.isFinite(step) || step < 1) throw new Error(`bad step in "${raw}"`)
    }

    let lo
    let hi
    if (part === '*') {
      lo = min
      hi = max
    } else if (part.includes('-')) {
      const [a, b] = part.split('-')
      lo = Number.parseInt(a, 10)
      hi = Number.parseInt(b, 10)
    } else {
      lo = hi = Number.parseInt(part, 10)
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`bad field "${raw}"`)
    if (lo < min || hi > max || lo > hi) throw new Error(`field "${raw}" out of range ${min}-${max}`)

    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  if (!out.size) throw new Error(`empty field "${raw}"`)
  return out
}

export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${fields.length}: "${expr}"`)
  }
  return fields.map(parseField)
}

/** Cron day-of-week is OR-ed with day-of-month when both are restricted. */
export function matchesCron(parsed, date = new Date()) {
  const [minute, hour, dom, month, dow] = parsed
  if (!minute.has(date.getUTCMinutes())) return false
  if (!hour.has(date.getUTCHours())) return false
  if (!month.has(date.getUTCMonth() + 1)) return false

  const domRestricted = dom.size !== 31
  const dowRestricted = dow.size !== 7
  const domHit = dom.has(date.getUTCDate())
  const dowHit = dow.has(date.getUTCDay())

  if (domRestricted && dowRestricted) return domHit || dowHit
  if (domRestricted) return domHit
  if (dowRestricted) return dowHit
  return true
}

export function nextRun(expr, from = new Date()) {
  const parsed = parseCron(expr)
  const d = new Date(from.getTime())
  d.setUTCSeconds(0, 0)
  d.setUTCMinutes(d.getUTCMinutes() + 1)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matchesCron(parsed, d)) return new Date(d.getTime())
    d.setUTCMinutes(d.getUTCMinutes() + 1)
  }
  return null
}

/**
 * Schedule named jobs. Each job is { name, cron, run, enabled }.
 * A job is skipped while its previous invocation is still running.
 */
export function startScheduler({ jobs, log = () => {}, tickMs = 20_000, onError = () => {} }) {
  const compiled = []
  for (const job of jobs) {
    try {
      compiled.push({ ...job, parsed: parseCron(job.cron), running: false, lastKey: null })
    } catch (err) {
      log(`cron: skipping job "${job.name}" — ${err.message}`, 'warn')
    }
  }

  let timer = null
  let stopped = false

  const tick = async () => {
    if (stopped) return
    const now = new Date()
    const key = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`
    for (const job of compiled) {
      if (job.enabled === false) continue
      if (job.lastKey === key) continue
      if (!matchesCron(job.parsed, now)) continue
      if (job.running) {
        log(`cron: "${job.name}" still running, skipping this tick`, 'warn')
        job.lastKey = key
        continue
      }
      job.lastKey = key
      job.running = true
      log(`cron: firing "${job.name}"`)
      Promise.resolve()
        .then(() => job.run())
        .catch((err) => {
          log(`cron: "${job.name}" failed — ${err.message}`, 'error')
          onError(err, job)
        })
        .finally(() => {
          job.running = false
        })
    }
  }

  // Align the first tick to the top of the next 20s boundary so a restart at
  // :59 does not miss the minute.
  const align = (tickMs - (Date.now() % tickMs)) % tickMs
  let interval = null
  const start = setTimeout(() => {
    tick()
    interval = setInterval(tick, tickMs)
  }, align)

  return {
    jobs: compiled,
    stop() {
      stopped = true
      clearTimeout(start)
      if (interval) clearInterval(interval)
    },
    describe() {
      return compiled.map((j) => ({
        name: j.name,
        cron: j.cron,
        enabled: j.enabled !== false,
        running: j.running,
        next: (() => {
          try {
            return nextRun(j.cron)?.toISOString() ?? null
          } catch {
            return null
          }
        })(),
      }))
    },
  }
}
