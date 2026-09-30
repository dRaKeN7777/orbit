/**
 * Runtime secret storage.
 *
 * A place to keep API keys that does not require editing .env and restarting.
 * Precedence is: value stored here wins, then the environment. The environment
 * stays the fallback so an existing .env keeps working.
 *
 * Secrets are never returned by GET /api/keys — only whether a key is set, where
 * it came from, and a short fingerprint, so the UI can confirm it saved without
 * the value ever travelling back to the browser.
 */

import { createHash } from 'node:crypto'
import { envConfig } from '../config.mjs'
import { nowIso } from '../db.mjs'

/** The keys the UI offers, with where each one is used. */
export const KNOWN_KEYS = [
  {
    name: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek API key',
    group: 'Intelligence',
    hint: 'Powers post generation. Without it the offline composer runs.',
  },
  {
    name: 'APIFY_TOKEN',
    label: 'Apify token',
    group: 'Ingestion',
    hint: 'Reads target executives’ LinkedIn posts. Required when SCRAPER_PROVIDER=apify.',
  },
  {
    name: 'SCRAPER_TOKEN',
    label: 'Custom scraper token',
    group: 'Ingestion',
    hint: 'Bearer token for SCRAPER_ENDPOINT.',
  },
  {
    name: 'PEXELS_API_KEY',
    label: 'Pexels API key',
    group: 'Website',
    hint: 'Stock photography for the website and post visuals. Free from pexels.com/api.',
  },
  {
    name: 'LINKEDIN_CLIENT_ID',
    label: 'LinkedIn client ID',
    group: 'Publishing',
    hint: 'From your app’s Auth tab in the LinkedIn Developer Portal.',
  },
  {
    name: 'LINKEDIN_CLIENT_SECRET',
    label: 'LinkedIn client secret',
    group: 'Publishing',
    hint: 'From the same tab. Revocable from the portal at any time.',
  },
  {
    name: 'LINKEDIN_ACCESS_TOKEN',
    label: 'LinkedIn access token',
    group: 'Publishing',
    hint: 'Only needed if you generated a token by hand instead of using Connect.',
  },
]

/** Env fallbacks, so an existing .env is not ignored. */
const ENV_FALLBACK = {
  DEEPSEEK_API_KEY: () => envConfig.llm.apiKey,
  APIFY_TOKEN: () => envConfig.scraper.apifyToken,
  SCRAPER_TOKEN: () => envConfig.scraper.token,
  PEXELS_API_KEY: () => envConfig.pexels.apiKey,
  LINKEDIN_CLIENT_ID: () => envConfig.linkedin.clientId,
  LINKEDIN_CLIENT_SECRET: () => envConfig.linkedin.clientSecret,
  LINKEDIN_ACCESS_TOKEN: () => envConfig.publisher.linkedinToken,
}

const fingerprint = (value) =>
  value ? createHash('sha256').update(String(value)).digest('hex').slice(0, 8) : null

/** Looks up a secret: stored value first, then the environment. */
export function getSecret(db, name) {
  if (db) {
    try {
      const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(name)
      if (row?.value) return row.value
    } catch {
      /* table missing or busy — fall through to the environment */
    }
  }
  const fallback = ENV_FALLBACK[name]
  return fallback ? fallback() || null : null
}

export function setSecret(db, name, value) {
  if (!KNOWN_KEYS.some((k) => k.name === name)) {
    throw new Error(`unknown key "${name}"`)
  }
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return clearSecret(db, name)

  db.prepare(
    `INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(name, trimmed, nowIso())
  return { name, configured: true }
}

export function clearSecret(db, name) {
  db.prepare('DELETE FROM secrets WHERE name = ?').run(name)
  return { name, configured: false }
}

/** Safe view for the UI: never includes the secret itself. */
export function listSecrets(db) {
  const stored = new Map()
  try {
    for (const row of db.prepare('SELECT name, value, updated_at FROM secrets').all()) {
      stored.set(row.name, row)
    }
  } catch {
    /* no table yet */
  }

  return KNOWN_KEYS.map((meta) => {
    const row = stored.get(meta.name)
    const envValue = ENV_FALLBACK[meta.name] ? ENV_FALLBACK[meta.name]() : null
    const source = row?.value ? 'stored' : envValue ? 'environment' : 'none'
    const value = row?.value ?? envValue ?? null
    return {
      ...meta,
      configured: Boolean(value),
      source,
      fingerprint: fingerprint(value),
      updated_at: row?.updated_at ?? null,
      // A stored value can be removed here; an env value must be edited in .env.
      editable: true,
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Resolver hook                                                               */
/* -------------------------------------------------------------------------- */

let resolver = null

/**
 * Registers the function used to resolve secrets at call time. The intelligence
 * layer needs this because it is imported before a database exists.
 */
export function setSecretResolver(fn) {
  resolver = fn
}

/** Used by the intelligence layer: stored value, then environment. */
export function resolveSecret(name) {
  if (resolver) {
    try {
      const value = resolver(name)
      if (value) return value
    } catch {
      /* fall through */
    }
  }
  const fallback = ENV_FALLBACK[name]
  return fallback ? fallback() || null : null
}

export default {
  KNOWN_KEYS,
  getSecret,
  setSecret,
  clearSecret,
  listSecrets,
  setSecretResolver,
  resolveSecret,
}
