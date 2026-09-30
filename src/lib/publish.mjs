/**
 * Writing pipeline — publisher adapters.
 *
 * `outbox` is the default: it writes the exact payload that would have gone to
 * LinkedIn into ./data/outbox as a reviewable file. Nothing leaves the machine.
 * `linkedin` performs the real REST call. `postiz` hands the draft to a
 * self-hosted Postiz instance.
 *
 * Every adapter returns the same shape: { ok, provider, url, error }.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { envConfig } from '../config.mjs'
import { nowIso } from '../db.mjs'
import { activeAccessToken, resolveAuthorUrn } from './linkedin.mjs'

const LINKEDIN_API = 'https://api.linkedin.com/rest'
const LINKEDIN_VERSION = process.env.LINKEDIN_VERSION || '202411'

export class PublishError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PublishError'
  }
}

/* -------------------------------------------------------------------------- */
/* outbox                                                                      */
/* -------------------------------------------------------------------------- */

function publishOutbox({ draft, schedule, log }) {
  const dir = envConfig.outboxDir
  mkdirSync(dir, { recursive: true })
  const slug = (draft.topic_slug ?? `draft-${draft.id}`).replace(/[^a-z0-9-]/gi, '-')
  const stamp = nowIso().replace(/[:.]/g, '-')
  const base = join(dir, `${stamp}-${slug}-d${draft.id}`)

  const body = `---
title: ${JSON.stringify(draft.topic_slug ?? `draft ${draft.id}`)}
channel: ${schedule.channel}
draft_id: ${draft.id}
schedule_id: ${schedule.id}
lint_score: ${draft.lint?.score ?? 'n/a'}
target: ${draft.target_name ?? 'n/a'} (${draft.region ?? 'n/a'})
generated_by: ${draft.generator ?? 'unknown'}
created_at: ${nowIso()}
---

${draft.inbound_post ?? ''}

---
## Peer comment (post manually under the target's update)

${draft.peer_comment ?? ''}

---
## Detected pain point

${draft.detected_pain_point ?? ''}

## Angle

${draft.angle ?? ''}
`
  // Ship the diagram alongside the copy so attaching it is a drag-and-drop.
  let imageNote = ''
  if (draft.visual?.asset_path && existsSync(draft.visual.asset_path)) {
    const imageName = `${basename(base)}.png`
    copyFileSync(draft.visual.asset_path, join(dir, imageName))
    imageNote = `\n![${draft.visual.alt ?? 'diagram'}](${imageName})\n`
    log(`outbox: wrote ${join(dir, imageName)}`)
  }

  writeFileSync(base + '.md', body + imageNote, 'utf8')
  writeFileSync(
    base + '.json',
    JSON.stringify({ draft, schedule, channel: schedule.channel }, null, 2),
    'utf8',
  )
  log(`outbox: wrote ${base}.md`)
  return { ok: true, provider: 'outbox', url: `file://${base}.md`, error: null }
}

/* -------------------------------------------------------------------------- */
/* LinkedIn (official REST API)                                                */
/* -------------------------------------------------------------------------- */

async function linkedinFetch(path, { method = 'GET', body, token, headers = {} }) {
  const res = await fetch(`${LINKEDIN_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': LINKEDIN_VERSION,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new PublishError(`LinkedIn ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`)
  }
  return { res, text: text ? safeJson(text) : null }
}

const safeJson = (t) => {
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

/**
 * Registers, uploads and returns an image URN.
 * LinkedIn's flow is two-step: ask for an upload URL, then PUT the bytes.
 */
async function uploadImage({ token, authorUrn, filePath, log }) {
  const registerBody = {
    registerUploadRequest: {
      recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
      owner: authorUrn,
      serviceRelationships: [
        { relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' },
      ],
    },
  }

  // Two register endpoints exist. /rest/images is the modern one but is not
  // available to every app (returns 404 RESOURCE_NOT_FOUND), while the legacy
  // /v2/assets endpoint still works and returns the same payload shape. Try the
  // modern one first so nothing changes if the app later gains access.
  let register = null
  const attempts = [
    { url: `${LINKEDIN_API}/images?action=registerUpload`, headers: {} },
    {
      url: 'https://api.linkedin.com/v2/assets?action=registerUpload',
      // The legacy endpoint predates versioned API access.
      headers: { 'LinkedIn-Version': '' },
    },
  ]

  for (const attempt of attempts) {
    const res = await fetch(attempt.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        ...(attempt.headers['LinkedIn-Version'] === ''
          ? {}
          : { 'LinkedIn-Version': LINKEDIN_VERSION }),
      },
      body: JSON.stringify(registerBody),
      signal: AbortSignal.timeout(60_000),
    })
    const textRaw = await res.text()
    if (res.ok) {
      register = safeJson(textRaw)
      log(`linkedin: image registered via ${new URL(attempt.url).pathname}`)
      break
    }
    log(`linkedin: ${new URL(attempt.url).pathname} -> ${res.status}`, 'warn')
  }

  if (!register) throw new PublishError('no image register endpoint accepted the request')
  const uploadUrl =
    register?.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']
      ?.uploadUrl
  const asset = register?.value?.asset
  if (!uploadUrl || !asset) throw new PublishError('LinkedIn registerUpload returned no upload URL')

  const bytes = (await import('node:fs')).readFileSync(filePath)
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: bytes,
    signal: AbortSignal.timeout(120_000),
  })
  if (!put.ok) {
    throw new PublishError(`image upload failed: ${put.status} ${(await put.text()).slice(0, 200)}`)
  }
  log(`linkedin: uploaded image asset ${asset}`)
  return asset
}

async function publishLinkedIn({ draft, schedule, log, db }) {
  // A token obtained through the Connect screen wins over the environment.
  const linkedinToken = db ? activeAccessToken(db) : envConfig.publisher.linkedinToken
  if (!linkedinToken) {
    throw new PublishError(
      'LinkedIn is not connected — open the Connect screen, or set LINKEDIN_ACCESS_TOKEN',
    )
  }

  const resolved = db
    ? resolveAuthorUrn(db)
    : { authorUrn: envConfig.publisher.linkedinAuthorUrn, mode: 'organization' }
  const linkedinAuthorUrn = resolved.authorUrn
  if (!linkedinAuthorUrn) {
    throw new PublishError(
      'No LinkedIn author resolved. Add LINKEDIN_AUTHOR_URN (urn:li:organization:…) or reconnect so the member URN is captured.',
    )
  }
  log(`linkedin: posting as ${resolved.mode} (${linkedinAuthorUrn})`)
  // A page post needs w_organization_social; a member post needs w_member_social.
  const isOrg = linkedinAuthorUrn.startsWith('urn:li:organization:')
  const commentary = draft.inbound_post ?? ''
  if (!commentary.trim()) throw new PublishError('draft has no inbound_post to publish')

  let mediaWarning = null
  const payload = {
    author: linkedinAuthorUrn,
    commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  }

  if (draft.visual?.asset_path) {
    // The image is an enhancement, not a precondition. A media failure must not
    // cost us the post — publish the text and report the attachment separately.
    try {
      const asset = await uploadImage({
        token: linkedinToken,
        authorUrn: linkedinAuthorUrn,
        filePath: draft.visual.asset_path,
        log,
      })
      payload.content = { media: { id: asset, altText: draft.visual.alt ?? '' } }
    } catch (err) {
      log(`linkedin: image attach failed (${err.message}) — publishing text only`, 'warn')
      mediaWarning = err.message
    }
  }

  let res
  let text

  if (payload.content?.media?.id) {
    // Legacy asset URN -> legacy post endpoint. Mixing the two APIs is what
    // produced `id value ... is of type digitalmediaAsset` (422).
    const legacy = {
      author: linkedinAuthorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: commentary },
          shareMediaCategory: 'IMAGE',
          media: [
            {
              status: 'READY',
              media: payload.content.media.id,
              description: { text: payload.content.media.altText || '' },
            },
          ],
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    }

    const raw = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${linkedinToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(legacy),
      signal: AbortSignal.timeout(60_000),
    })
    const body = await raw.text()
    if (!raw.ok) {
      throw new PublishError(`LinkedIn POST /v2/ugcPosts -> ${raw.status}: ${body.slice(0, 300)}`)
    }
    log('linkedin: published with image via /v2/ugcPosts')
    res = raw
    text = safeJson(body)
  } else {
    const out = await linkedinFetch('/posts', {
      method: 'POST',
      token: linkedinToken,
      body: payload,
    })
    res = out.res
    text = out.text
  }

  const urn = res.headers.get('x-restli-id') ?? text?.id ?? null
  const url = urn ? `https://www.linkedin.com/feed/update/${urn}/` : null
  if (mediaWarning) log(`linkedin: published without the image — ${mediaWarning}`)
  log(`linkedin: published as ${isOrg ? 'organization' : 'member'} post${urn ? ` ${urn}` : ''}`)
  return { ok: true, provider: 'linkedin', url, error: null }
}

/* -------------------------------------------------------------------------- */
/* Postiz                                                                      */
/* -------------------------------------------------------------------------- */

async function publishPostiz({ draft, schedule, log }) {
  const { postizUrl, postizKey, postizIntegrationId } = envConfig.publisher
  if (!postizUrl || !postizKey) throw new PublishError('POSTIZ_API_URL / POSTIZ_API_KEY are not set')
  if (!postizIntegrationId) throw new PublishError('POSTIZ_INTEGRATION_ID is not set')

  // Postiz has shipped a couple of shapes for this endpoint; the `content`
  // + `integrations` form is the one its public API documents.
  const body = {
    type: progressType(schedule.status),
    content: draft.inbound_post ?? '',
    integrations: [postizIntegrationId],
    date: schedule.scheduled_at,
  }
  const res = await fetch(`${postizUrl}/public/v1/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: postizKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (!res.ok) throw new PublishError(`Postiz ${res.status}: ${text.slice(0, 400)}`)
  const parsed = safeJson(text)
  log('postiz: draft created')
  return { ok: true, provider: 'postiz', url: parsed?.id ? `${postizUrl}/posts/${parsed.id}` : null, error: null }
}

const progressType = (status) => (status === 'published' ? 'schedule' : 'draft')

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

export const PUBLISHERS = ['outbox', 'linkedin', 'postiz']

/**
 * Publish one scheduled draft through the configured adapter.
 * @returns {Promise<{ok:boolean, provider:string, url:string|null, error:string|null}>}
 */
export async function publish({ draft, schedule, log = () => {}, db = null, kind: kindOverride = null }) {
  // Defaults to the configured publisher; callers (tests) may override so a
  // test never depends on whatever PUBLISHER happens to be set to.
  const kind = kindOverride ?? envConfig.publisher.kind
  try {
    if (kind === 'outbox') return publishOutbox({ draft, schedule, log })
    if (kind === 'linkedin') return await publishLinkedIn({ draft, schedule, log, db })
    if (kind === 'postiz') return await publishPostiz({ draft, schedule, log })
    throw new PublishError(`unknown PUBLISHER "${kind}" — set outbox|linkedin|postiz`)
  } catch (err) {
    log(`publish failed via ${kind}: ${err.message}`)
    return { ok: false, provider: kind, url: null, error: err.message }
  }
}

/** Describes the active publisher for /api/health and the Settings screen. */
export function publisherStatus() {
  const kind = envConfig.publisher.kind
  const ready =
    kind === 'outbox' ||
    (kind === 'linkedin' && Boolean(envConfig.publisher.linkedinAuthorUrn)) ||
    (kind === 'postiz' && Boolean(envConfig.publisher.postizUrl && envConfig.publisher.postizKey))
  return { kind, ready, options: PUBLISHERS }
}
