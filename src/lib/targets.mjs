/**
 * Watchlist import. Shared by the HTTP route and the CLI so the two cannot
 * drift on validation rules.
 */

import { nowIso } from '../db.mjs'

/** Derives a display name from a profile URL when none is supplied. */
function nameFromUrl(url) {
  const slug = url.replace(/\/+$/, '').split('/').pop() ?? ''
  const decoded = decodeURIComponent(slug).replace(/-/g, ' ').trim()
  if (!decoded) return 'Unknown'
  // "sample-urs-widmer" -> "urs widmer" is more honest than title-casing a guess.
  return decoded.startsWith('sample-') ? decoded.slice(7) : decoded
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<Record<string,string>>} rows
 * @returns {{imported:number, skipped:number, errors:string[]}}
 */
export function importTargets(db, rows, { defaultRegion = 'UK' } = {}) {
  const stmt = db.prepare(
    `INSERT INTO targets (name, title, company, region, linkedin_url, email, active, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(linkedin_url) DO NOTHING`,
  )

  const seen = new Set()
  let imported = 0
  let skipped = 0
  const errors = []

  rows.forEach((r, i) => {
    const url = String(r.linkedin_url ?? r.url ?? r.profile_url ?? '').trim()
    if (!url) {
      errors.push(`row ${i + 1}: missing linkedin_url`)
      skipped++
      return
    }
    if (!/^https?:\/\//i.test(url)) {
      errors.push(`row ${i + 1}: not a URL (${url})`)
      skipped++
      return
    }
    if (seen.has(url)) {
      skipped++
      return
    }
    seen.add(url)

    const rawRegion = String(r.region ?? defaultRegion).trim().toUpperCase()
    const region = rawRegion === 'CH' || rawRegion === 'SWITZERLAND' || rawRegion === 'CHF' ? 'CH' : 'UK'
    const name = String(r.name ?? '').trim() || nameFromUrl(url)

    const info = stmt.run(
      name,
      String(r.title ?? '').trim() || null,
      String(r.company ?? '').trim() || null,
      region,
      url,
      String(r.email ?? '').trim() || null,
      String(r.notes ?? '').trim() || null,
      nowIso(),
    )
    if (info.changes > 0) imported++
    else skipped++
  })

  return { imported, skipped, errors }
}

export default { importTargets }
