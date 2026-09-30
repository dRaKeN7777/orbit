/**
 * Static file serving for the SPA, shared by the backend (which serves it as a
 * convenience) and the frontend server (which is the documented entry point).
 *
 * Keeping one implementation matters: two copies of a path-traversal guard is
 * how you end up with one of them wrong.
 */

import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/**
 * @param {string} publicDir absolute path to the directory to serve
 * @returns {(req, res, pathname) => Promise<void>}
 */
export function createStaticHandler(publicDir) {
  const root = resolve(publicDir)

  return async function serveStatic(req, res, pathname) {
    let rel = pathname
    try {
      rel = decodeURIComponent(pathname)
    } catch {
      rel = pathname // malformed percent-encoding: treat the raw path as literal
    }
    if (rel === '/' || rel === '') rel = '/index.html'

    // Resolve, then confirm we never escaped the root. Checking the resolved
    // path (not the raw string) is what makes "..%2f..%2fetc/passwd" harmless.
    const full = normalize(join(root, rel))
    if (full !== root && !full.startsWith(root + '/')) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'forbidden' }))
      return
    }

    try {
      const info = await stat(full)
      if (info.isDirectory()) {
        return serveStatic(req, res, join(rel, 'index.html'))
      }
      const data = await readFile(full)
      res.writeHead(200, {
        'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      })
      res.end(data)
    } catch {
      // SPA fallback so a deep link still boots the app.
      try {
        const data = await readFile(join(root, 'index.html'))
        res.writeHead(200, {
          'Content-Type': MIME['.html'],
          'Content-Length': data.length,
          'Cache-Control': 'no-cache',
        })
        res.end(data)
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'not found' }))
      }
    }
  }
}

export default { createStaticHandler, MIME }
