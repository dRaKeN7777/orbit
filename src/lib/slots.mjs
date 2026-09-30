/**
 * Posting-slot planning.
 *
 * Pure functions, no database access, so the allocation rules are unit-testable.
 *
 * The rules exist because "schedule it automatically" is not enough on its own.
 * A queue that fires three posts in the same hour, on a Sunday, in a Swiss
 * bank's inbox, does more harm than no automation at all. So slots are:
 *
 *   - restricted to configured weekdays
 *   - placed at configured times of day (UTC)
 *   - spaced apart by a minimum gap
 *   - capped per day
 *   - never in the past, and never inside the lead-time window
 *   - aware of everything already queued, so re-running cannot double-book
 */

const DAY_MS = 86_400_000

/** "08:15" -> { h: 8, m: 15 }. Returns null for anything unparseable. */
export function parseWindow(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return { h, m: min }
}

const utcDayKey = (ms) => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
}

/**
 * Choose the next free posting slots.
 *
 * @param {object} options
 * @param {Date}   [options.now]            reference point (defaults to now)
 * @param {string[]} [options.windows]      times of day, UTC, e.g. ['08:15','13:45']
 * @param {number[]} [options.days]         allowed weekdays, 0=Sunday
 * @param {number} [options.count]          how many slots to return
 * @param {string[]} [options.taken]        ISO timestamps already queued
 * @param {number} [options.minHoursBetween] minimum spacing between posts
 * @param {number} [options.maxPerDay]
 * @param {number} [options.horizonDays]    how far ahead to search
 * @param {number} [options.leadMinutes]    earliest a post may go out
 * @returns {string[]} ISO-8601 timestamps, ascending
 */
export function planSlots({
  now = new Date(),
  windows = ['08:15', '13:45'],
  days = [1, 2, 3, 4, 5],
  count = 1,
  taken = [],
  minHoursBetween = 6,
  maxPerDay = 2,
  horizonDays = 45,
  leadMinutes = 15,
} = {}) {
  const wanted = Math.max(0, Math.floor(count))
  if (!wanted) return []

  const parsed = (windows ?? [])
    .map(parseWindow)
    .filter(Boolean)
    .sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m))
  if (!parsed.length) return []

  const allowedDays = new Set(
    (days ?? []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
  )
  if (!allowedDays.size) return []

  const nowMs = now.getTime()
  const earliest = nowMs + Math.max(0, leadMinutes) * 60_000
  const gapMs = Math.max(0, minHoursBetween) * 3_600_000
  const perDay = Math.max(1, Math.floor(maxPerDay))

  // Occupied slots drive both collision and per-day budgeting.
  const occupied = (taken ?? [])
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)

  const dayCounts = new Map()
  for (const t of occupied) {
    const key = utcDayKey(t)
    dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1)
  }

  const base = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).getTime()

  const chosen = []

  for (let d = 0; d <= horizonDays && chosen.length < wanted; d++) {
    const dayStart = base + d * DAY_MS
    const weekday = new Date(dayStart).getUTCDay()
    if (!allowedDays.has(weekday)) continue

    const key = utcDayKey(dayStart)
    let usedToday = dayCounts.get(key) ?? 0
    if (usedToday >= perDay) continue

    for (const { h, m } of parsed) {
      if (chosen.length >= wanted) break
      if (usedToday >= perDay) break

      const candidate = dayStart + h * 3_600_000 + m * 60_000
      if (candidate <= earliest) continue

      // An exactly-occupied slot is always rejected, whatever the gap setting
      // is (with minHoursBetween=0 the distance test alone would miss it).
      if (occupied.includes(candidate)) continue
      // Otherwise the candidate must clear the minimum gap against everything
      // already queued and everything chosen during this pass.
      const tooClose = [...occupied, ...chosen].some(
        (t) => Math.abs(t - candidate) < gapMs,
      )
      if (tooClose) continue

      chosen.push(candidate)
      usedToday++
      dayCounts.set(key, usedToday)
    }
  }

  return chosen.sort((a, b) => a - b).map((t) => new Date(t).toISOString())
}

/** Human-readable summary of a planned slot, used in run logs. */
export function describeSlot(iso) {
  const d = new Date(iso)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]
  const pad = (n) => String(n).padStart(2, '0')
  return `${day} ${d.toISOString().slice(0, 10)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
}

export default { planSlots, parseWindow, describeSlot }
