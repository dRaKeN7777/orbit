/**
 * Authentication.
 *
 * Design notes, because auth is easy to get subtly wrong:
 *
 *   - Passwords are hashed with scrypt and a per-user random salt, never stored
 *     or compared in plaintext. Comparison is constant-time.
 *   - Sessions live in the database, not in a signed cookie. That costs one
 *     SELECT per request and buys real revocation: "sign out" actually ends the
 *     session server-side, and sessions can be pruned on expiry.
 *   - What goes in the cookie is a 256-bit random token. What goes in the
 *     database is only its SHA-256, so a leaked database does not hand over
 *     live sessions.
 *   - Login attempts are throttled globally. This is a single-operator tool, so
 *     one bucket is the correct granularity — and keying on the socket address
 *     rather than a client-supplied header means the throttle cannot be evaded
 *     by rotating X-Forwarded-For.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { nowIso } from '../db.mjs'

export const SESSION_COOKIE = 'orbit_session'

// scrypt cost. N=16384,r=8 needs ~16MB, which is under Node's default maxmem.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

/* -------------------------------------------------------------------------- */
/* Passwords                                                                   */
/* -------------------------------------------------------------------------- */

/** @returns {string} `scrypt$N$r$p$salt$hash`, all base64 after the params. */
export function hashPassword(password) {
  const salt = randomBytes(16)
  const key = scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  })
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

/** Constant-time verification. Returns false for malformed stored hashes. */
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored ?? '').split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const N = Number(parts[1])
    const r = Number(parts[2])
    const p = Number(parts[3])
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false

    const salt = Buffer.from(parts[4], 'base64')
    const expected = Buffer.from(parts[5], 'base64')
    if (!expected.length) return false

    const actual = scryptSync(String(password), salt, expected.length, { N, r, p })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex')

export function createSession(db, { username, userAgent = '', ip = '', days = 7 }) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString()
  db.prepare(
    `INSERT INTO sessions (token_hash, username, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token),
    username,
    nowIso(),
    expiresAt,
    nowIso(),
    String(userAgent ?? '').slice(0, 200),
    String(ip ?? '').slice(0, 64),
  )
  return { token, expires_at: expiresAt }
}

/** @returns {object|null} the session row, or null when missing/expired. */
export function getSession(db, token) {
  if (!token) return null
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token))
  if (!row) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash)
    return null
  }
  return row
}

export function destroySession(db, token) {
  if (!token) return 0
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)).changes ?? 0
}

/** Removes every session for a user — used when the password changes. */
export function destroyUserSessions(db, username) {
  return db.prepare('DELETE FROM sessions WHERE username = ?').run(username).changes ?? 0
}

export function pruneSessions(db) {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso()).changes ?? 0
}

export function listSessions(db, username) {
  return db
    .prepare(
      `SELECT username, created_at, expires_at, last_seen_at, user_agent, ip
         FROM sessions WHERE username = ? AND expires_at > ?
        ORDER BY last_seen_at DESC`,
    )
    .all(username, nowIso())
}

/* -------------------------------------------------------------------------- */
/* Cookies                                                                     */
/* -------------------------------------------------------------------------- */

export function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    if (!key) continue
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      out[key] = part.slice(eq + 1).trim()
    }
  }
  return out
}

export function sessionCookie(token, { maxAge, secure = false } = {}) {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (typeof maxAge === 'number') bits.push(`Max-Age=${Math.floor(maxAge)}`)
  if (secure) bits.push('Secure')
  return bits.join('; ')
}

/* -------------------------------------------------------------------------- */
/* Login throttle                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fixed-window attempt limiter. Deliberately simple: this guards a single
 * operator's login form, not a public API.
 */
export function createLoginThrottle({ max = 8, windowMs = 15 * 60_000, blockMs = 15 * 60_000 } = {}) {
  const buckets = new Map()

  const entry = (key) => {
    let e = buckets.get(key)
    if (!e) {
      e = { count: 0, windowStart: Date.now(), blockedUntil: 0 }
      buckets.set(key, e)
    }
    return e
  }

  return {
    /** @returns {{allowed:boolean, retryAfterMs:number}} */
    check(key) {
      const e = entry(key)
      const now = Date.now()
      if (e.blockedUntil > now) return { allowed: false, retryAfterMs: e.blockedUntil - now }
      if (now - e.windowStart > windowMs) {
        e.count = 0
        e.windowStart = now
        e.blockedUntil = 0
      }
      return { allowed: true, retryAfterMs: 0 }
    },

    fail(key) {
      const e = entry(key)
      e.count += 1
      if (e.count >= max) {
        e.blockedUntil = Date.now() + blockMs
        e.count = 0
        e.windowStart = Date.now()
        return true // just became blocked
      }
      return false
    },

    reset(key) {
      buckets.delete(key)
    },

    /** Drops expired buckets so a long-running process does not grow forever. */
    sweep() {
      const now = Date.now()
      for (const [key, e] of buckets) {
        const idle = now - e.windowStart > windowMs && e.blockedUntil <= now
        if (idle) buckets.delete(key)
      }
    },

    size: () => buckets.size,
  }
}

export default {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  pruneSessions,
  parseCookies,
  sessionCookie,
  createLoginThrottle,
  SESSION_COOKIE,
}
