# Orbit — API Contract (v1)

Base URL: `http://127.0.0.1:8040` (backend, direct)

The UI is served from `http://127.0.0.1:3020`, which reverse-proxies `/api/*` to the backend.
Either origin works for API calls; use `:8040` for scripts and `:3020` from the browser.

All responses are JSON. Errors use `{ "error": "message" }` with an appropriate HTTP status.
Every mutating endpoint returns `{ "ok": true, ... }` on success.

Auth: local-only app. If `ORBIT_TOKEN` is set in the environment, every `/api/*` request must send
`Authorization: Bearer <token>`. If unset, auth is disabled (localhost development).

---

## Pipeline state machine

Every content item moves through: `researched -> planned -> drafted -> verified -> scheduled -> published`.
The `schedule` stage allocates posting slots automatically when `auto_schedule` is on (`POST /api/schedule/auto` does it on demand).
`verify` is a hard gate: a draft whose lint `passed` is `false` cannot be scheduled or published.
A `failed` item keeps its `last_error` and can be retried without losing prior state.

---

## Core

### `GET /api/health`
```json
{ "ok": true, "version": "1.0.0", "llm": "deepseek" | "offline", "publisher": "outbox" | "linkedin", "uptime_s": 12 }
```

### `GET /api/stats`
```json
{
  "targets": 128, "posts": 942, "topics": 17, "drafts": 23,
  "scheduled": 6, "published": 41, "engagements": 9,
  "targets_by_region": { "UK": 71, "CH": 57 },
  "pipeline": { "researched": 12, "planned": 8, "drafted": 5, "verified": 3, "scheduled": 2, "published": 1 }
}
```

### `GET /api/settings` / `PATCH /api/settings`
Editable settings. PATCH accepts any subset.
```json
{
  "our_company": "Acme Security",
  "our_focus": "cryptographic data-plane sovereignty for regulated financial workloads",
  "our_voice": "founder-engineering",
  "regions": ["UK", "CH"],
  "auto_publish": false,
  "auto_schedule": false,
  "auto_apply_website": false,
  "schedule_cron": "0 6 * * *",
  "publish_cron": "* * * * *",
  "website_target": "static",
  "website_path": "./data/site",
  "banned_extra": [],
  "drafts_per_run": 3,
  "schedule_per_run": 5,
  "min_lint_score": 70,
  "posting_windows": ["08:15", "13:45"],
  "posting_days": [1, 2, 3, 4, 5],
  "posts_per_day": 2,
  "min_hours_between_posts": 6,
  "schedule_horizon_days": 45,
  "publish_channel": "linkedin_company"
}
```

---

## 1. Executive Radar

### `GET /api/targets?region=UK&q=&limit=&offset=`
```json
{ "items": [ {
  "id": 12, "name": "Urs Widmer", "title": "CEO", "company": "Alps Security AG",
  "region": "CH", "linkedin_url": "https://linkedin.com/in/...", "email": null,
  "post_count": 14, "last_scraped_at": "2026-02-01T06:00:11Z", "active": true
} ], "total": 128 }
```

### `POST /api/targets/import`
Body: `{ "csv": "name,company,region,linkedin_url\n...", "region_default": "UK" }`
Also accepts `{ "urls": ["https://linkedin.com/in/x"] }`.
```json
{ "ok": true, "imported": 12, "skipped": 2, "errors": ["row 4: missing linkedin_url"] }
```

### `PATCH /api/targets/:id` / `DELETE /api/targets/:id`
PATCH body: any of `name,title,company,region,linkedin_url,active`.

### `GET /api/posts?region=&target_id=&limit=&min_reactions=&q=`
Newest first.
```json
{ "items": [ {
  "id": 5012, "target_id": 12, "target_name": "Urs Widmer", "company": "Alps Security AG",
  "region": "CH", "content_text": "A major Zurich financial client just asked us...",
  "reactions": 184, "comments": 23, "shares": 6, "velocity": 41.2,
  "posted_at": "2026-01-31T09:12:00Z", "url": "https://linkedin.com/posts/...",
  "topics": ["revFADP", "data-sovereignty"], "urgency": "high", "sentiment": "concerned"
} ], "total": 942 }
```

### `POST /api/ingest/run`
Body: `{ "target_ids": [12,13], "since_hours": 24 }` (both optional — defaults to all active targets, 24h)
```json
{ "ok": true, "run_id": "run_01HX...", "status": "queued" }
```

---

## 2. Topic & Pain-Point Matrix

### `GET /api/topics?region=&limit=`
```json
{ "items": [ {
  "topic": "revFADP subcontractor access logging",
  "label": "revFADP subcontractor access logging", "slug": "revfadp-subcontractor-access-logging",
  "mentions": 14, "regions": { "UK": 3, "CH": 11 },
  "urgency": "high", "sentiment": "concerned", "trend": "rising",
  "tags": ["revFADP", "data-residency", "audit"],
  "first_seen": "2026-01-19T00:00:00Z", "last_seen": "2026-01-31T09:12:00Z",
  "post_ids": [5012, 4988, 4971]
} ], "total": 17 }
```

### `POST /api/topics/recompute`
Re-runs clustering over the last N days. Body: `{ "days": 14 }` -> `{ "ok": true, "topics": 17, "run_id": "..." }`

---

## 3. AI Content & Comment Studio

### `POST /api/generate`
Body: `{ "post_id": 5012, "mode": "both" | "post" | "comment", "source": "inbound" }`
Returns the created draft. Long-running: the response returns when generation + verification finish.
```json
{ "ok": true, "draft": { /* Draft object, see below */ } }
```

### Draft object
```json
{
  "id": 88, "post_id": 5012, "target_id": 12, "target_name": "Urs Widmer",
  "company": "Alps Security AG", "region": "CH",
  "detected_pain_point": "Subcontractor access logging breaks the sovereignty chain when the audit plane is multi-tenant.",
  "angle": "Policy-based control cannot prove sovereignty; only cryptographic verification on the log data plane can.",
  "peer_comment": "One thing that bit us...",
  "inbound_post": "The board wants 100% sovereignty guarantees...",
  "visual": { "kind": "diagram", "spec": "mermaid-ish schema", "asset_path": null },
  "lint": {
    "score": 92, "passed": true,
    "violations": [ { "rule": "banned_word", "severity": "hard", "detail": "delve", "index": 3 } ],
    "metrics": { "words": 164, "sentences": 12, "stdev_sentence_len": 9.4, "specificity": 4 }
  },
  "status": "verified",
  "source": "inbound" | "trend",
  "generator": "deepseek-chat" | "offline",
  "created_at": "2026-02-01T07:14:02Z"
}
```

### `GET /api/drafts?status=&limit=`
`{ "items": [ Draft, ... ], "total": 23 }`

### `GET /api/drafts/:id`
Single draft (full object).

### `PATCH /api/drafts/:id`
Body: `{ "inbound_post": "...", "peer_comment": "...", "status": "approved" }`
Editing text **re-runs the linter** and returns the refreshed draft.

### `POST /api/drafts/:id/verify`
Re-runs the linter only. Returns `{ "ok": true, "lint": {...} }`.

### `POST /api/drafts/:id/regenerate`
Body: `{ "feedback": "too abstract, add the audit-plane detail" }` -> new draft version on the same post.

---

## 4. Scheduler & Inbound Tracker

### `POST /api/drafts/:id/schedule`
Body: `{ "scheduled_at": "2026-02-03T09:30:00Z", "channel": "linkedin_company" }`
Rejected with 409 if `lint.passed` is false.
```json
{ "ok": true, "schedule": { "id": 31, "draft_id": 88, "channel": "linkedin_company",
  "scheduled_at": "2026-02-03T09:30:00Z", "status": "pending", "attempts": 0 } }
```

### `GET /api/schedule?status=&from=&to=`
```json
{ "items": [ {
  "id": 31, "draft_id": 88, "channel": "linkedin_company", "scheduled_at": "...",
  "status": "pending" | "published" | "failed" | "cancelled",
  "attempts": 0, "last_error": null, "published_url": null,
  "title": "The board wants 100% sovereignty guarantees..."
} ], "total": 6 }
```

### `DELETE /api/schedule/:id` — cancel a pending item.

### `POST /api/schedule/auto`
Queues verified drafts into free posting slots. Body: `{ "limit": 5 }` (optional).
Re-checks the verification gate first — a draft that no longer passes is demoted to
`needs_review` instead of being queued. Slots respect `posting_windows`, `posting_days`,
`posts_per_day`, `min_hours_between_posts`, and never collide with anything already queued.
```json
{ "ok": true, "scheduled": 2, "skipped": 0,
  "slots": ["2026-10-01T08:15:00.000Z", "2026-10-02T08:15:00.000Z"], "run_id": "run_..." }
```

### `POST /api/publish/run`
Drains everything due now. Body `{ "force": false }`. Force publishes regardless of `scheduled_at`.
```json
{ "ok": true, "run_id": "...", "published": [ { "schedule_id": 31, "url": "..." } ],
  "failed": [ { "schedule_id": 32, "error": "..." } ], "skipped": 2 }
```

### `GET /api/engagements?limit=`
Inbound signals from watched accounts.
```json
{ "items": [ {
  "id": 4, "target_id": 12, "target_name": "Urs Widmer", "company": "Alps Security AG",
  "region": "CH", "type": "comment" | "like" | "share" | "profile_view" | "dm",
  "our_post_url": "https://linkedin.com/posts/...", "target_post_url": null,
  "warm": true, "detected_at": "2026-02-02T11:02:00Z", "notes": null
} ], "total": 9, "warm_leads": 3 }
```

### `POST /api/engagements`
Body: `{ "target_id": 12, "type": "comment", "our_post_url": "...", "notes": "..." }`
Used by the inbound-poll job or entered manually.

---

## 5. Website

### `GET /api/website/updates?status=`
```json
{ "items": [ {
  "id": 7, "topic_slug": "revfadp-subcontractor-access-logging",
  "title": "Proving subcontractor access on a multi-tenant audit plane",
  "summary": "...", "slug": "proving-subcontractor-access",
  "target_path": "content/insights/proving-subcontractor-access.md",
  "body": "---\ntitle: ...\n---\n\n...",
  "diff": null, "status": "planned" | "applied" | "rejected",
  "applied_at": null, "created_at": "..."
} ], "total": 7 }
```

### `POST /api/website/plan`
Body: `{ "topic_slug": "...", "kind": "insight" | "service_page" | "case_note" }`
-> `{ "ok": true, "update": { ...WebsiteUpdate } }`

### `POST /api/website/updates/:id/apply`
Writes the file through the configured `website_target` writer (`static` | `git` | `wordpress`).
```json
{ "ok": true, "status": "applied", "written": ["content/insights/x.md"], "commit": "a1b2c3d", "preview_url": null }
```

### `POST /api/website/updates/:id/reject` -> `{ "ok": true, "status": "rejected" }`

---

## 6. Runs & Automation

### `POST /api/pipeline/run`
Body: `{ "mode": "full" }` where mode is `full` | `research` | `draft` | `schedule` | `publish` | `website`.
`full` = ingest -> recompute topics -> generate drafts for top N topics -> verify -> schedule (if `auto_schedule`) -> publish due (if `auto_publish`).
```json
{ "ok": true, "run_id": "run_...", "status": "running" }
```

### `GET /api/runs?limit=20`
```json
{ "items": [ {
  "id": "run_01HX", "kind": "full", "status": "succeeded" | "failed" | "running",
  "started_at": "...", "finished_at": "...", "duration_ms": 8421,
  "stats": { "ingested": 34, "topics": 5, "drafts": 3, "published": 1 },
  "log": [ { "at": "...", "level": "info", "msg": "ingested 34 new posts" } ]
} ], "total": 12 }
```

### `GET /api/runs/:id` -> single run with the full log array.

### `GET /api/stream` — Server-Sent Events
`text/event-stream`. Emits `{ "type": "run.log" | "run.status" | "stats", "payload": {...} }`
on every pipeline log line and state change. Frontend subscribes for live updates.

---

## Frontend contract

- Vanilla ES modules in `public/`, no build step, served statically by the same server.
- Views (sidebar): **Radar**, **Topics**, **Studio**, **Scheduler**, **Website**, **Runs**.
- Persist active view in `location.hash`.
- All fetches go through one helper that surfaces `{ error }` as a visible toast — never fail silently.
- The Studio is a split-screen: left = the target CEO's original post + "Open on LinkedIn",
  right = generated `inbound_post` (editable) with a LinkedIn "...see more" fold preview at 210 characters,
  plus the `peer_comment` and a copy-to-clipboard button.
- Lint violations are shown inline as chips: `hard` = red, `soft` = amber.
- `Schedule` and `Publish now` buttons are disabled while `lint.passed` is false.
