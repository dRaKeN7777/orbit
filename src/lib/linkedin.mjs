/**
 * LinkedIn OAuth 2.0 — Authorization Code flow.
 *
 * This is the supported way to post as a company page. The app never sees the
 * user's password and never needs a 2FA code: the user authorises on
 * linkedin.com, LinkedIn redirects back with a short-lived code, and we exchange
 * that code for a scoped access token.
 *
 * Requirements on the LinkedIn side:
 *   - a Developer App with the "Community Management API" product approved
 *     (that product grants w_organization_social, needed to post as a page)
 *   - the exact redirect URI below added under the app's Auth tab
 *
 * Tokens are stored in the local SQLite database, not in .env, so the Connect
 * screen can refresh and revoke them without a restart.
 */

import { createHash, randomBytes } from 'node:crypto'
import { envConfig } from '../config.mjs'
import { nowIso } from '../db.mjs'

const AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization'
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken'

/** Default scope: publish as the organisation page. */
export const DEFAULT_SCOPE = 'w_organization_social'

/** CSRF state values, held briefly in memory between redirect and callback. */
const pendingStates = new Map()
const STATE_TTL_MS = 10 * 60_000

export function linkedinConfig() {
  const { clientId, clientSecret, redirectUri, scope } = envConfig.linkedin
  return {
    clientId,
    clientSecret,
    redirectUri: redirectUri || defaultRedirectUri(),
    scope: scope || DEFAULT_SCOPE,
    configured: Boolean(clientId && clientSecret),
  }
}

function defaultRedirectUri() {
  const raw = envConfig.frontend.host
  const host = raw === '0.0.0.0' || raw === '127.0.0.1' ? 'localhost' : raw
  return `http://${host}:${envConfig.frontend.port}/api/linkedin/callback`
}

/** Builds the URL the browser must be sent to. */
export function buildAuthorizeUrl() {
  const cfg = linkedinConfig()
  if (!cfg.configured) {
    throw new Error('LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET must be set')
  }

  const state = randomBytes(16).toString('base64url')
  pendingStates.set(state, { createdAt: Date.now(), redirectUri: cfg.redirectUri })
  pruneStates()

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', cfg.clientId)
  url.searchParams.set('redirect_uri', cfg.redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('scope', cfg.scope)
  return { url: url.toString(), state, redirectUri: cfg.redirectUri }
}

function pruneStates() {
  const cutoff = Date.now() - STATE_TTL_MS
  for (const [key, value] of pendingStates) {
    if (value.createdAt < cutoff) pendingStates.delete(key)
  }
}

/** Consumes a state value. Returns the stored context, or null if unknown/expired. */
export function consumeState(state) {
  const entry = pendingStates.get(String(state ?? ''))
  if (!entry) return null
  pendingStates.delete(state)
  if (entry.createdAt < Date.now() - STATE_TTL_MS) return null
  return entry
}

/** Exchanges an authorization code for an access token. */
export async function exchangeCodeForToken(code, redirectUri) {
  const cfg = linkedinConfig()
  if (!cfg.configured) throw new Error('LinkedIn client credentials are not configured')

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  })

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  })

  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* fall through to the error below */
  }

  if (!res.ok || !parsed?.access_token) {
    const detail = parsed?.error_description ?? parsed?.error ?? text.slice(0, 300)
    throw new Error(`LinkedIn token exchange failed (${res.status}): ${detail}`)
  }
  return parsed
}

/**
 * Resolves the member URN the token belongs to.
 *
 * Needed because a self-serve app ("Share on LinkedIn" only) can post as the
 * member's personal profile but NOT as a company page — that requires the
 * Community Management API to be approved. Knowing both URNs lets the publisher
 * pick the identity the granted scopes actually allow, instead of failing with
 * a 403 at publish time.
 *
 * @returns {Promise<string|null>} e.g. urn:li:person:abc123
 */
export async function fetchMemberUrn(token) {
  try {
    const res = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.sub ? `urn:li:person:${data.sub}` : null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Token store                                                                 */
/* -------------------------------------------------------------------------- */

export function saveToken(db, token, { authorUrn = null } = {}) {
  const expiresAt = token.expires_in
    ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString()
    : null
  const now = nowIso()

  db.prepare(
    `INSERT INTO oauth_tokens
       (provider, access_token, refresh_token, scope, token_type, expires_at, author_urn, obtained_at, updated_at)
     VALUES ('linkedin', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
       scope = excluded.scope,
       token_type = excluded.token_type,
       expires_at = excluded.expires_at,
       author_urn = COALESCE(excluded.author_urn, oauth_tokens.author_urn),
       updated_at = excluded.updated_at`,
  ).run(
    token.access_token,
    token.refresh_token ?? null,
    token.scope ?? null,
    token.token_type ?? 'Bearer',
    expiresAt,
    authorUrn,
    now,
    now,
  )

  return { expires_at: expiresAt, scope: token.scope ?? null }
}

export function getToken(db) {
  const row = db.prepare("SELECT * FROM oauth_tokens WHERE provider = 'linkedin'").get()
  if (!row) return null
  const expired = row.expires_at ? new Date(row.expires_at).getTime() <= Date.now() : false
  return { ...row, expired }
}

export function clearToken(db) {
  return db.prepare("DELETE FROM oauth_tokens WHERE provider = 'linkedin'").run().changes ?? 0
}

/**
 * The token the publisher should use: a stored OAuth token wins over the
 * environment, because the Connect screen is the supported way in.
 */
export function activeAccessToken(db) {
  const stored = getToken(db)
  if (stored && !stored.expired) return stored.access_token
  return envConfig.publisher.linkedinToken || null
}

/**
 * The identity a post should be published as.
 *
 * Preference order:
 *   1. an explicit choice in settings, if that URN is actually available
 *   2. the organisation page (what we want, needs w_organization_social)
 *   3. the member's own profile (self-serve fallback)
 */
export function resolveAuthorUrn(db) {
  const orgUrn = envConfig.publisher.linkedinAuthorUrn || null
  let memberUrn = null
  if (db) {
    try {
      const row = db.prepare("SELECT author_urn FROM oauth_tokens WHERE provider='linkedin'").get()
      memberUrn = row?.author_urn ?? null
    } catch {
      /* no token row */
    }
  }
  return { authorUrn: orgUrn || memberUrn, orgUrn, memberUrn, mode: orgUrn ? 'organization' : memberUrn ? 'member' : null }
}

/** Non-secret view of the connection, safe to return over the API. */
export function connectionStatus(db) {
  const cfg = linkedinConfig()
  const row = getToken(db)
  return {
    configured: cfg.configured,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    connected: Boolean(row && !row.expired),
    expires_at: row?.expires_at ?? null,
    expired: row?.expired ?? false,
    token_scope: row?.scope ?? null,
    obtained_at: row?.obtained_at ?? null,
    // Never return the token or the secret, only a short fingerprint.
    token_fingerprint: row?.access_token
      ? createHash('sha256').update(row.access_token).digest('hex').slice(0, 8)
      : null,
    client_id: cfg.clientId ? `${cfg.clientId.slice(0, 6)}…` : null,
    env_token_present: Boolean(envConfig.publisher.linkedinToken),
    author_urn: resolveAuthorUrn(db).authorUrn,
    org_urn: envConfig.publisher.linkedinAuthorUrn || null,
    member_urn: (() => {
      try {
        return db.prepare("SELECT author_urn FROM oauth_tokens WHERE provider='linkedin'").get()?.author_urn ?? null
      } catch {
        return null
      }
    })(),
    post_as: resolveAuthorUrn(db).mode,
  }
}

export default {
  buildAuthorizeUrl,
  consumeState,
  exchangeCodeForToken,
  saveToken,
  getToken,
  clearToken,
  activeAccessToken,
  connectionStatus,
  fetchMemberUrn,
  resolveAuthorUrn,
  linkedinConfig,
  DEFAULT_SCOPE,
}
