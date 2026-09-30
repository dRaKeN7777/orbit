/**
 * Sample watchlist.
 *
 * These are SYNTHETIC entries targeting the CyberPresalesOS buyer:
 * the CEO / founder of a UK or Swiss cybersecurity company or MSSP — at that
 * size of firm the CEO usually owns the presales and bid function directly.
 *
 * They are SYNTHETIC entries — invented names, invented companies, and
 * `sample-` prefixed profile URLs. They exist so a fresh install has something
 * to render and so the pipeline can be demonstrated end to end. Replace them
 * with your real target list via POST /api/targets/import (the Radar screen has
 * a CSV import) or `npm run seed -- --force` after editing this file.
 */

import { nowIso } from './db.mjs'

export const SAMPLE_TARGETS = [
  // --- United Kingdom ------------------------------------------------------
  { name: 'Alastair Kenning', title: 'CEO', company: 'Northgate Cyber', region: 'UK' },
  { name: 'Priya Raghunathan', title: 'Founder & CEO', company: 'Thameside Security Group', region: 'UK' },
  { name: 'Dominic Fairweather', title: 'Chief Executive Officer', company: 'Blackfen Resilience', region: 'UK' },
  { name: 'Yusuf Adeyemi', title: 'Managing Director', company: 'Meridian Threat Labs', region: 'UK' },
  { name: 'Eleanor Vance', title: 'Founder', company: 'Cavendish Information Assurance', region: 'UK' },
  { name: 'Rory McAllister', title: 'CEO', company: 'Clydeside Defence Systems', region: 'UK' },
  { name: 'Hannah Okonkwo', title: 'Chief Executive', company: 'Lantern Cyber Advisory', region: 'UK' },
  { name: 'Gabriel Thornton', title: 'Founder & CEO', company: 'Wexford Security Partners', region: 'UK' },
  { name: 'Saira Baloch', title: 'Managing Director', company: 'Pennine Cyber Works', region: 'UK' },
  { name: 'Oliver Ashworth', title: 'CEO', company: 'Kingfisher Managed Security', region: 'UK' },
  { name: 'Nadia Petrova', title: 'CEO', company: 'Stonebury Cyber', region: 'UK' },
  { name: 'Callum Drury', title: 'Founder & CEO', company: 'Ashcombe Security Engineering', region: 'UK' },
  { name: 'Meera Deshpande', title: 'Chief Executive Officer', company: 'Ravenhill Cyber', region: 'UK' },
  { name: 'Tobias Lindsey', title: 'Managing Director', company: 'Brackenwood InfoSec', region: 'UK' },
  { name: 'Grace Ferreira', title: 'Founder', company: 'Halewood Cyber Partners', region: 'UK' },
  { name: 'Reuben Sackey', title: 'CEO', company: 'Ironbridge Security', region: 'UK' },

  // --- Switzerland ---------------------------------------------------------
  { name: 'Urs Widmer', title: 'Chief Executive', company: 'Alpenrand Security AG', region: 'CH' },
  { name: 'Beatrice Holliger', title: 'Founder & CEO', company: 'Limmat Cyber AG', region: 'CH' },
  { name: 'Lukas Brändli', title: 'Managing Director', company: 'Säntis Information Security', region: 'CH' },
  { name: 'Nadine Cuche', title: 'CEO', company: 'Léman Cyber Défense SA', region: 'CH' },
  { name: 'Matthias Zünd', title: 'CEO', company: 'Reuss Security Engineering AG', region: 'CH' },
  { name: 'Sandro Bernasconi', title: 'Founder & CEO', company: 'Cerêsio Cyber SA', region: 'CH' },
  { name: 'Andrea Vollenweider', title: 'Chief Executive Officer', company: 'Aare Data Assurance AG', region: 'CH' },
  { name: 'Fabienne Girard', title: 'Managing Director', company: 'Jura Systems Security SA', region: 'CH' },
  { name: 'Reto Kaufmann', title: 'Founder', company: 'Gotthard Cyber GmbH', region: 'CH' },
  { name: 'Isabelle Morgenroth', title: 'CEO', company: 'Zugersee Threat Analytics AG', region: 'CH' },
  { name: 'Pascal Nussbaumer', title: 'Chief Executive', company: 'Emme Resilience AG', region: 'CH' },
  { name: 'Corinne Delacroix', title: 'Founder & CEO', company: 'Rigi Secure Infrastructure AG', region: 'CH' },
  { name: 'Thomas Wiederkehr', title: 'Managing Director', company: 'Thur Cyber Audit AG', region: 'CH' },
  { name: 'Sabine Locher', title: 'CEO', company: 'Bielersee Security Group AG', region: 'CH' },
  { name: 'Nicolas Bovay', title: 'CEO', company: 'Matterhorn Cyber SA', region: 'CH' },
]

/**
 * Insert the sample watchlist if the database has no targets yet.
 * @param {{force?: boolean}} [options]
 */
export function ensureSeed(db, { force = false } = {}) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM targets').get()?.n ?? 0
  if (existing > 0 && !force) return { inserted: 0, total: existing, skipped: true }

  const stmt = db.prepare(
    `INSERT INTO targets (name, title, company, region, linkedin_url, active, notes, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(linkedin_url) DO NOTHING`,
  )

  let inserted = 0
  for (const t of SAMPLE_TARGETS) {
    const slug = t.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    const info = stmt.run(
      t.name,
      t.title,
      t.company,
      t.region,
      `https://www.linkedin.com/in/sample-${slug}`,
      'sample data — replace with a real watchlist',
      nowIso(),
    )
    if (info.changes > 0) inserted++
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM targets').get()?.n ?? 0
  return { inserted, total, skipped: false }
}

export default { ensureSeed, SAMPLE_TARGETS }
