#!/usr/bin/env node
/**
 * Orbit frontend server.
 *
 * Serves the SPA from `public/` on FRONTEND_PORT and reverse-proxies `/api/*`
 * to the backend on PORT.
 *
 * Why a proxy rather than pointing the browser straight at the backend: the UI
 * calls relative `/api/...` paths, `EventSource` connects to the same origin,
 * and any future cookie or bearer auth stays same-origin. Keeping the browser
 * on a single origin means no CORS, no pre-flight, and no mixed-origin SSE
 * surprises — while the API itself stays independently restartable.
 *
 * The proxy is deliberately dumb: headers and status pass through untouched and
 * bodies are piped, never buffered. Buffering would break the SSE stream.
 */

import { createServer, request as httpRequest } from 'node:http'
import { resolve } from 'node:path'
import { envConfig, ROOT } from './config.mjs'
import { createStaticHandler } from './lib/static.mjs'

const PUBLIC_DIR = resolve(ROOT, 'public')
const serveStatic = createStaticHandler(PUBLIC_DIR)
const backend = new URL(envConfig.frontend.backendUrl)

const isApiPath = (pathname) => pathname === '/api' || pathname.startsWith('/api/')

/** Hop-by-hop headers must not be forwarded (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function forwardedHeaders(req) {
  const out = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    out[key] = value
  }
  out.host = backend.host
  return out
}

function proxy(req, res) {
  const proxyReq = httpRequest(
    {
      protocol: backend.protocol,
      hostname: backend.hostname,
      port: backend.port || 80,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req),
    },
    (proxyRes) => {
      const headers = {}
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue
        headers[key] = value
      }
      // Server-Sent Events must not be cached or buffered by anything between
      // the backend and the browser.
      if ((headers['content-type'] ?? '').includes('text/event-stream')) {
        headers['cache-control'] = 'no-cache, no-transform'
        headers['x-accel-buffering'] = 'no'
      }
      res.writeHead(proxyRes.statusCode ?? 502, headers)
      proxyRes.pipe(res)
    },
  )

  proxyReq.on('error', (err) => {
    const detail = err.code === 'ECONNREFUSED'
      ? `nothing listening on ${backend.host}`
      : (err.code ?? err.message)
    const message = `backend unreachable at ${backend.origin} (${detail}) — start it with: npm start`

    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: message }))
  })

  // Long-lived responses (the SSE stream) must not be cut off by a socket timeout.
  proxyReq.setTimeout(0)
  req.pipe(proxyReq)
}

const server = createServer((req, res) => {
  let pathname = '/'
  try {
    pathname = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`).pathname
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'malformed request URL' }))
    return
  }

  if (isApiPath(pathname)) return proxy(req, res)
  return serveStatic(req, res, pathname)
})

// The activity console holds an SSE connection open indefinitely.
server.timeout = 0
server.requestTimeout = 0
server.headersTimeout = 60_000
server.keepAliveTimeout = 65_000

server.listen(envConfig.frontend.port, envConfig.frontend.host, () => {
  console.log(`
  Orbit frontend
  ─────────────────────────────────────────────
  web         : http://${envConfig.frontend.host}:${envConfig.frontend.port}
  api proxied : /api/*  ->  ${backend.origin}
  static      : ${PUBLIC_DIR}
`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
