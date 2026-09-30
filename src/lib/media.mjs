/**
 * Visual assets.
 *
 * Turns a draft's schematic into a real file on disk so the publishers can
 * actually use it:
 *   - the LinkedIn adapter uploads it via /rest/images and attaches it as the
 *     post's media
 *   - the outbox adapter writes it beside the review file so it can be attached
 *     by hand in seconds
 *
 * Before this existed, `visual.asset_path` was always null and every post went
 * out as text only.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ROOT } from '../config.mjs'
import { nowIso } from '../db.mjs'
import { findSpecificity } from './lint.mjs'
import { buildDiagram } from './diagram.mjs'
import { svgToPng } from './raster.mjs'

export const MEDIA_DIR = resolve(ROOT, 'data/media')

const slugify = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'diagram'

/**
 * Builds the schematic for a draft without writing anything.
 * @returns {object|null} null when the draft does not exist
 */
export function buildDraftDiagram(db, id) {
  const draft = db
    .prepare(
      `SELECT d.*, t.company, t.region FROM drafts d
        LEFT JOIN targets t ON t.id = d.target_id WHERE d.id = ?`,
    )
    .get(id)
  if (!draft) return null

  const topic = draft.topic_slug
    ? db.prepare('SELECT slug, label FROM topics WHERE slug = ?').get(draft.topic_slug)
    : null

  // Pull the concrete artefacts the copy already cites, so the diagram and the
  // post are about the same things.
  const artifacts = [
    ...new Set([
      ...findSpecificity(draft.inbound_post ?? ''),
      ...findSpecificity(draft.detected_pain_point ?? ''),
    ]),
  ].slice(0, 4)

  const settings = db.prepare('SELECT key, value FROM settings').all()
  const settingMap = Object.fromEntries(
    settings.map((r) => {
      try {
        return [r.key, JSON.parse(r.value)]
      } catch {
        return [r.key, r.value]
      }
    }),
  )

  const diagram = buildDiagram({
    topic: topic ?? { slug: 'generic', label: 'Presales operations' },
    painPoint: draft.detected_pain_point,
    angle: draft.angle,
    artifacts,
    company: settingMap.our_company ?? 'CyberPresalesOS',
    domain: 'enhancingprofit.com',
  })

  return { ...diagram, draft, artifacts, topic }
}

/**
 * Renders the schematic to a PNG on disk and returns a `visual` descriptor that
 * the publishers understand.
 *
 * Never throws: if rasterisation is unavailable (no headless browser) the post
 * still publishes as text rather than failing the whole run.
 *
 * @returns {Promise<{kind:string, asset_path:string|null, alt:string, width:number, height:number, error?:string}>}
 */
export async function materialiseVisual(db, draftId, { log = () => {} } = {}) {
  const built = buildDraftDiagram(db, draftId)
  if (!built) throw new Error(`draft ${draftId} not found`)

  const alt = built.title
  const base = {
    kind: 'diagram',
    alt,
    width: built.width,
    height: built.height,
    title: built.title,
    artifacts: built.artifacts,
    generated_at: nowIso(),
  }

  try {
    const png = await svgToPng(built.svg, {
      width: built.width,
      height: built.height,
      scale: 2,
    })
    mkdirSync(MEDIA_DIR, { recursive: true })
    const file = join(MEDIA_DIR, `draft-${draftId}-${slugify(built.title)}.png`)
    writeFileSync(file, png)
    log(`visual: wrote ${file} (${Math.round(png.length / 1024)} KB)`)
    return { ...base, asset_path: file, bytes: png.length, error: null }
  } catch (err) {
    log(`visual: PNG export unavailable (${err.message}) — publishing text only`, 'warn')
    return { ...base, asset_path: null, bytes: 0, error: err.message }
  }
}

export default { materialiseVisual, buildDraftDiagram, MEDIA_DIR }
