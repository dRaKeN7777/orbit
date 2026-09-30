/**
 * SVG -> PNG rasterisation.
 *
 * LinkedIn's image upload accepts PNG/JPG, never SVG. Rather than pull in a
 * native image dependency (sharp, canvas) or ship a font renderer, this shells
 * out to a headless browser that is already on the machine and already used for
 * the UI verification.
 *
 * If no browser is found the caller degrades to serving the SVG, which is still
 * correct — it just needs converting before it can be attached to a post.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
]

/** @returns {string|null} path to a usable headless browser */
export function findBrowser() {
  for (const candidate of CANDIDATES) {
    if (!candidate) continue
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* unreadable path — keep looking */
    }
  }
  return null
}

/**
 * Render an SVG string to a PNG buffer.
 * @param {string} svg
 * @param {{ width?:number, height?:number, scale?:number }} [options]
 * @returns {Promise<Buffer>}
 */
export async function svgToPng(svg, { width = 1200, height = 675, scale = 2 } = {}) {
  const browser = findBrowser()
  if (!browser) {
    throw new Error(
      'no headless browser found for PNG export — set CHROME_PATH or convert the SVG manually',
    )
  }

  const dir = mkdtempSync(join(tmpdir(), 'orbit-png-'))
  const svgPath = join(dir, 'diagram.svg')
  const pngPath = join(dir, 'diagram.png')

  try {
    writeFileSync(svgPath, svg, 'utf8')

    // Scale 2x so the text stays sharp when LinkedIn re-encodes the upload.
    await run(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // A private profile per render. Without this, a Chrome already running
        // for the UI holds the default profile and this instance fails to start,
        // which silently cost us the post image.
        `--user-data-dir=${join(dir, 'chrome-profile')}`,
        `--force-device-scale-factor=${scale}`,
        `--window-size=${width},${height}`,
        `--screenshot=${pngPath}`,
        `file://${svgPath}`,
      ],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    )

    if (!existsSync(pngPath)) throw new Error('browser produced no screenshot')
    return readFileSync(pngPath)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* temp dir cleanup is best-effort */
    }
  }
}

export function rasterStatus() {
  const browser = findBrowser()
  return { available: Boolean(browser), browser: browser ?? null }
}

export default { svgToPng, findBrowser, rasterStatus }
