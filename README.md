# Orbit

An account-based social listening and thought-leadership engine for **inbound** cybersecurity
lead generation aimed at UK and Swiss executives.

Instead of scheduling generic posts, it watches what a target list of executives is actually
talking about, clusters that into named themes, drafts a counter-insight and a peer-level
comment for each, **verifies the copy against a hard anti-AI-smell gate**, and only then
schedules it. It also turns the same intelligence into website pages.

---

## Status — what actually works right now

| Capability | State |
|---|---|
| Executive watchlist (CSV import, UK/CH) | ✅ working |
| Post ingestion | ✅ working — `sample` provider by default; Apify / generic / RSS adapters built |
| Topic & pain-point clustering | ✅ working — 23 named cluster rules, deterministic |
| AI draft + comment generation | ✅ working — DeepSeek when keyed, high-quality offline composer when not |
| **Anti-AI-smell verification gate** | ✅ working — enforced at schedule *and* publish time |
| Auto-scheduling + publish queue | ✅ working — slot-aware queue, outbox / LinkedIn REST / Postiz adapters |
| Inbound engagement tracking | ✅ working — API + UI (manual/API ingest; see note below) |
| Website page generation + apply | ✅ working — static / git / WordPress writers |
| Cron automation | ✅ working — in-process and standalone worker |
| Live UI (6 views), SSE activity console | ✅ working |

Everything above runs **today with zero credentials** against the built-in sample watchlist
so you can evaluate the whole flow before wiring anything up.

The one thing that is *not* turnkey is **scraping real LinkedIn data** — see
[LinkedIn reality check](#linkedin-reality-check).

---

## Quick start

No dependencies. Node 22.5+ (built-in `node:sqlite`, `fetch`, and an HTTP server are all
this needs — there is no `npm install`).

```bash
cp .env.example .env          # optional; everything has a working default
npm start                     # backend API  on :8040
npm run frontend              # frontend     on :3020   (separate terminal)
```

Then open **http://127.0.0.1:3020**.

`npm run dev` starts both in one shell. The frontend reverse-proxies `/api/*` to the backend,
so the browser only ever talks to port 3020.

On first boot it seeds 31 sample UK/CH executives. Then either use the UI:

- **Radar → Import** to replace the samples with your real watchlist
- **Runs → Run full pipeline**

or drive it from the CLI:

```bash
npm run seed                              # insert the sample watchlist
node src/cli.mjs pipeline --mode full     # research -> topics -> drafts -> verify
node src/cli.mjs drafts                   # see verification results
node src/cli.mjs publish                  # drain the queue (writes to ./data/outbox)
```

Verify your install:

```bash
npm run selftest     # 37 unit/behaviour tests, no server needed

npm start            # backend on :8040
npm run smoke        # 34 end-to-end API tests against the backend

# ...or point the same suite at the frontend to prove the proxy is transparent:
ORBIT_URL=http://127.0.0.1:3020 npm run smoke
```

---

## The screens

| View | What it does |
|---|---|
| **Radar** | The watchlist and a live feed of target posts, filterable by region, sorted by engagement velocity. "Draft" on any post jumps to the Studio. Shows which posts already have a draft. |
| **Topics** | The pain-point matrix. Named clusters with mention counts, UK-vs-CH split, urgency, trend, and the concrete artifacts people keep citing. |
| **Studio** | Split screen. Left: the executive's original post. Right: the generated inbound post and peer comment, both editable, with a LinkedIn "…see more" fold preview at 210 characters and inline verification chips. |
| **Scheduler** | Week calendar of the queue, status table, and the inbound tracker with a warm-lead banner. |
| **Website** | Planned pages generated from the top clusters. Review the raw Markdown or a rendered preview, then Apply or Reject. |
| **Runs** | Pipeline history with full per-run logs, one-click pipeline triggers, and live settings. |

---

## Two processes, one origin

The frontend (`:3020`) and the backend (`:8040`) are separate processes:

```
browser  ──►  :3020  frontend  ──/api/*──►  :8040  backend  ──►  SQLite
                    (static SPA)            (JSON API + SSE)
```

The frontend serves the SPA and reverse-proxies `/api/*` to the backend. That indirection is
what lets the UI keep using relative `/api/...` paths, `EventSource` connect same-origin, and
bearer auth work without any CORS configuration — while the API stays independently
restartable, scalable, or puttable behind its own auth.

The proxy pipes bodies and passes headers and status through untouched. It explicitly does not
buffer, because the activity console holds a Server-Sent Events connection open indefinitely.
If the backend is down the frontend still serves the UI and returns a `502` explaining exactly
what is wrong, so you get an error toast rather than a blank page.

The backend also serves the SPA on `:8040` as a convenience — useful for debugging, but `:3020`
is the documented entry point.

## The pipeline

```
research  →  analyse  →  plan  →  draft  →  VERIFY  →  schedule  →  publish
   │            │          │        │         │            │           │
 ingest      classify   cluster   LLM      lint gate    queue      adapter
 posts       every post  topics   writes   (hard)                  (outbox/
             (cheap)             post+                          linkedin/postiz)
                                  comment
```

Three design decisions matter more than the rest:

**Classification is cheap, generation is expensive.** Every ingested post is classified by a
deterministic rule engine — free, instant, no API call. The LLM is only invoked for the
handful of posts that actually become drafts. Analysing 124 posts costs zero API calls;
drafting 3 costs 3.

**Verify is a real gate, not a checkbox.** A draft that fails verification is stored as
`needs_review` and **cannot** be scheduled (HTTP 409) or published. The check runs again at
publish time, because a draft can be edited after it was scheduled. This is enforced in the
API layer, in the scheduler, and in `publishDue` — and it is covered by tests.

**Scheduling is slot-aware, not clock-aware.** "Post every 6 hours" is how you end up firing
three posts into a Swiss bank's inbox on a Sunday. When `auto_schedule` is on, verified drafts
are placed into slots that respect configured weekdays, times of day, a minimum gap, a
per-day cap, and everything already queued — so re-running the pipeline can never double-book.
The allocator is a pure function in `src/lib/slots.mjs` with its own tests.

### Turning the loop on

Three independent switches make the loop autonomous:

```bash
AUTO_SCHEDULE=true       # queue verified drafts into posting slots
AUTO_PUBLISH=true        # send whatever is due
AUTO_APPLY_WEBSITE=true  # write planned pages without review
```

They **default to on while the destination is safe** — `PUBLISHER=outbox` and
`WEBSITE_TARGET=static` only write local files, so a fresh install runs the whole loop
end to end with nothing leaving the machine. The moment you set a real destination
(`linkedin`, `postiz`, `wordpress`, `git`) they default to **off**, and you turn them on
deliberately. Automation you did not ask for should never be one env var away from posting
to your company page.

None of them can bypass the verifier. To watch the whole loop without cron:

```bash
AUTO_SCHEDULE=true AUTO_PUBLISH=true node src/cli.mjs pipeline --mode full
node src/cli.mjs schedule        # queue verified drafts on demand
node src/cli.mjs publish         # send anything due
node src/cli.mjs publish --force # send the queued slots now, ignoring their time
```

---

## The verification gate

`src/lib/lint.mjs` scores copy from 0–100 and returns every violation with a severity.
`hard` violations fail the draft outright; `soft` ones accumulate until the score drops below
the threshold (default 70).

**Hard failures**

- Banned vocabulary — `delve`, `landscape`, `robust`, `seamless`, `pivotal`, `realm`, `testament`, `tapestry`, `beacon`, `game-changer`, `underscore`, `unleash`, `elevate`, `foster`, `cutting-edge`, `paradigm`
- Banned openers — `In today's …`, `Hot take:`, `Unpopular opinion:`, `Let's talk about…`, `Most companies get X wrong.`
- Banned closers — `Agree?`, `Thoughts?`, `DM me`, `Let me know in the comments`, `Follow for more`
- Contrast flips — `It's not about X. It's about Y.` and the `X isn't Y. It's Z.` variant
- Any emoji
- Three or more bolded list headers (`**Visibility:** …`)
- More than three `@mentions`
- **No concrete artifact** — the rule that kills generic output. The copy must name at least one real thing: a regulation (`FINMA`, `revFADP`, `NIS2`, `DORA`, `Cyber Assessment Framework`), a clause (`Art. 21`), a protocol (`mTLS`, `eBPF`, `OIDC`, `SPIFFE`), a control, or a measured number (`p99`, `40ms`, `4%`, `RTO`)
- Word count outside the hard band (80–260 for a post, 12–170 for a comment)

**Soft penalties**

- LLM tells — `leverage`, `crucial`, `vital`, `holistic`, `streamline`, `empower`, `in conclusion`, `it's worth noting`, `at the end of the day`, …
- Uniform rhythm — sentence-length standard deviation below 3.5 across 5+ sentences
- No short sentence — nothing under 10 words to break the cadence
- A sentence over 34 words
- A throat-clearing first sentence (abstract, no specifics)
- A preachy closing sentence (`Ultimately…`, `The key is…`, `Staying ahead…`)
- Thin specificity (only one artifact in a post)

The offline composer in `src/lib/llm.mjs` is written to satisfy all of this deliberately —
that is how the sample output scores 100/100 while still reading like a person.

You can run the gate on anything:

```bash
node src/cli.mjs lint "$(cat my-post.txt)"
```

---

## Configuration

Copy `.env.example` to `.env`. Everything is optional; the defaults give you a fully working
local system.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8040` / `127.0.0.1` | Backend API listen address |
| `FRONTEND_PORT` / `FRONTEND_HOST` | `3020` / `127.0.0.1` | Frontend listen address |
| `BACKEND_URL` | `http://127.0.0.1:8040` | Where the frontend proxies `/api/*` |
| `ORBIT_TOKEN` | *(unset)* | When set, every `/api/*` call needs `Authorization: Bearer …` |
| `DATABASE_PATH` | `./data/orbit.db` | SQLite file |
| `DEEPSEEK_API_KEY` | *(unset)* | Enables live generation. Without it, the offline composer runs |
| `LLM_BASE_URL` | `https://api.deepseek.com` | Any OpenAI-compatible endpoint |
| `LLM_MODEL_REASONING` | `deepseek-reasoner` | Analysis |
| `LLM_MODEL_WRITER` | `deepseek-chat` | Copywriting |
| `SCRAPER_PROVIDER` | `sample` | `sample` / `apify` / `generic` / `rss` / `none` |
| `APIFY_TOKEN`, `APIFY_ACTOR_ID` | — | Apify actor ingestion |
| `SCRAPER_ENDPOINT`, `SCRAPER_TOKEN` | — | Any custom JSON scraper |
| `RSS_FEEDS` | — | Comma-separated feeds (company newsrooms, regulator bulletins) |
| `PUBLISHER` | `outbox` | `outbox` / `linkedin` / `postiz` |
| `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_AUTHOR_URN` | — | Official LinkedIn publishing |
| `POSTIZ_API_URL`, `POSTIZ_API_KEY`, `POSTIZ_INTEGRATION_ID` | — | Self-hosted Postiz |
| `WEBSITE_TARGET` | `static` | `static` / `git` / `wordpress` |
| `WEBSITE_PATH` | `./data/site` | Where pages are written |
| `WORDPRESS_URL`, `WORDPRESS_USER`, `WORDPRESS_APP_PASSWORD` | — | WordPress publishing |
| `AUTO_SCHEDULE` | `false` | Queue verified drafts into posting slots automatically |
| `AUTO_PUBLISH` | `false` | Send queued posts when due. Leave off until you trust the output |
| `AUTO_APPLY_WEBSITE` | `false` | Write planned pages without review |
| `POSTING_WINDOWS` | `08:15,13:45` | Times of day (UTC) posts may go out |
| `POSTING_DAYS` | `1,2,3,4,5` | Allowed weekdays, `0`=Sunday |
| `POSTS_PER_DAY` | `2` | Daily cap |
| `MIN_HOURS_BETWEEN_POSTS` | `6` | Minimum spacing |
| `WORKER_ENABLED` | `true` | In-process cron. Set `false` if you run `npm run worker` separately |
| `INGEST_CRON`, `DRAFT_CRON`, `PUBLISH_CRON`, `WEBSITE_CRON` | see `.env` | 5-field cron, UTC |

Settings that are safe to change at runtime (`our_company`, `our_focus`, `auto_publish`,
cron expressions, `banned_extra`, `min_lint_score`, `drafts_per_run`) live in the database and
are editable on the **Runs** screen. `banned_extra` lets you add your own forbidden phrases to
the gate.

---

## Going live

### 1. Intelligence (DeepSeek)

Put `DEEPSEEK_API_KEY=sk-…` in `.env` and restart. `/api/health` will report
`llm: "deepseek"` instead of `"offline"`. No other change is needed — `analyzePost`,
`generateAssets`, and `repairDraft` all switch over automatically.

Because DeepSeek is OpenAI-compatible, any other provider works by changing `LLM_BASE_URL`
and the two model names.

### 2. Ingestion

LinkedIn has **no official API for reading other people's personal posts**. You must supply a
permitted third-party source:

```bash
SCRAPER_PROVIDER=apify
APIFY_TOKEN=apify_api_…
APIFY_ACTOR_ID=harvestapi~linkedin-post-search
```

The Apify adapter posts your target URLs to the actor and maps the response onto the internal
shape. If your actor uses different field names, adapt `normaliseItem` and `groupByTarget` in
`src/lib/ingest.mjs` — they are written to be tolerant of the common variants (`text`/`content`/
`commentary`, `postedAt`/`createdAt`, flat vs nested `engagement`).

For anything else — an internal scraper, a vendor API, a newsroom — use the `generic` adapter
(POST `{urls:[…]}`, receive an array or `{items:[…]}`) or `rss`.

### 3. Publishing

Start with the default `outbox` publisher. It writes the exact payload that would go to
LinkedIn into `./data/outbox/*.md` for review, and nothing leaves the machine.

For real publishing you need a LinkedIn developer app with the **Share on LinkedIn** product
(→ `w_member_social`) and/or **Community Management API** (→ `w_organization_social`), plus an
OAuth 2.0 flow to obtain a token. This project deliberately does **not** implement the OAuth
handshake — do it once in the LinkedIn developer portal or a small script, then set:

```bash
PUBLISHER=linkedin
LINKEDIN_ACCESS_TOKEN=…
LINKEDIN_AUTHOR_URN=urn:li:organization:12345678   # or urn:li:person:…
```

Posts are created via `POST https://api.linkedin.com/rest/posts` with
`X-Restli-Protocol-Version: 2.0.0`. Set `LINKEDIN_VERSION` to override the API version header
(default `202411`). If `draft.visual.asset_path` is set, the image is registered and uploaded
first via `/rest/images?action=registerUpload`.

### 4. Website

```bash
WEBSITE_TARGET=git
WEBSITE_PATH=/path/to/your/site
GIT_COMMIT=true
```

`git` writes the Markdown then stages and commits it. `static` writes the file only.
`wordpress` creates a **draft** post through the WordPress REST API using an application
password. Generated pages are held to the same anti-AI-smell rules as social copy (structural
rules only — the length and single-artifact rules do not apply to a long page).

---

## LinkedIn reality check

Three things are worth being explicit about, because the marketing around "LinkedIn automation"
usually glosses over them:

1. **Reading is the unsolved half.** There is no legitimate API for reading other users'
   personal posts. Every product that does this relies on scraping, which is a
   Terms-of-Service grey area and carries account risk. This project isolates that risk in a
   pluggable adapter so you can use a licensed vendor, your own permitted source, or RSS
   instead — and it never uses your personal LinkedIn session.

2. **Comments are never automated.** The peer comment is generated and copy-to-clipboard only.
   Commenting programmatically is the fastest way to get an account restricted, and the
   Studio is built around pasting it yourself within the first couple of hours. Only the
   original inbound post (your own feed) is ever sent to the publishing API.

3. **Nothing publishes without review by default.** `AUTO_PUBLISH=false` and the default
   publisher is a local outbox. Turn automation on deliberately, after you have watched the
   verification gate for a while.

Also worth knowing: the engagement tracker records inbound signals via `POST /api/engagements`
(or the API), and there is no automatic poller for LinkedIn notifications — that would require
the same restricted reading access. Wire your notification source into that endpoint, or log
them from the UI.

---

## CLI

```
node src/cli.mjs seed [--force]           insert the sample watchlist
node src/cli.mjs import <file.csv>        import a real watchlist
node src/cli.mjs ingest                   run ingestion only
node src/cli.mjs topics [--days N]        recompute the topic matrix
node src/cli.mjs pipeline [--mode M]      full | research | draft | schedule | publish | website
node src/cli.mjs schedule [--limit N]     queue verified drafts into posting slots
node src/cli.mjs publish [--force]        drain the queue
node src/cli.mjs website [--topic S] [--kind K] [--apply]
node src/cli.mjs drafts                   list drafts with verification status
node src/cli.mjs lint "<text>"            run the gate on arbitrary copy
node src/cli.mjs doctor                   configuration and readiness
```

`npm run worker` runs the automation standalone (no web server) against the same SQLite file —
useful when the UI and the worker live on different hosts. If you do that, set
`WORKER_ENABLED=false` on the server so the jobs do not run twice.

Watchlist CSV columns: `name,company,region,linkedin_url,title,email`. The header is optional,
comma and semicolon both work, and quotes are handled. Region is `UK` or `CH`.
See `docs/watchlist-template.csv`.

---

## Architecture

```
src/
  server.mjs       backend: HTTP API + SSE + in-process cron
  frontend.mjs     frontend: serves the SPA + reverse-proxies /api to the backend
  worker.mjs       standalone cron worker
  cli.mjs          command line
  smoke.mjs        end-to-end API test        (npm run smoke)
  selftest.mjs     unit/behaviour tests       (npm run selftest)
  config.mjs       env + runtime settings
  db.mjs           schema and helpers (node:sqlite)
  seed.mjs         sample watchlist
  lib/
    lint.mjs       THE VERIFICATION GATE
    slots.mjs      posting-slot allocation (pure, tested)
    static.mjs     shared static-file handler (traversal-safe)
    llm.mjs        DeepSeek client + offline composer + prompts
    classify.mjs   (in llm.mjs) deterministic per-post classification
    topics.mjs     cluster dictionary + aggregation
    ingest.mjs     sample / apify / generic / rss adapters
    publish.mjs    outbox / linkedin / postiz adapters
    website.mjs     page generation + static / git / wordpress writers
    pipeline.mjs   the orchestrator + publishDue
    cron.mjs       minimal 5-field cron
    csv.mjs        tolerant CSV parsing
    targets.mjs    watchlist import
public/            SPA — vanilla ES modules, no build step (~4.4k lines)
docs/API.md        the frozen API contract
```

**Stack:** Node built-ins only. No framework, no bundler, no `node_modules`. SQLite via
`node:sqlite`, HTTP via `node:http`, `fetch` for outbound calls. The frontend is plain ES
modules with a hand-written router. This is a deliberate trade: the whole thing starts in
milliseconds, has no supply chain, and cannot break because a transitive dependency changed.

Run the server behind a reverse proxy with TLS for anything non-local, and set `ORBIT_TOKEN`.

---

## Where to change the behaviour

| Want to change… | Edit |
|---|---|
| What counts as AI-smell | `src/lib/lint.mjs` — the rule table |
| Your brand's banned phrases | `banned_extra` in Settings (no code change) |
| Which themes are tracked | `TOPIC_RULES` in `src/lib/topics.mjs` |
| Tone, structure, regional nuance | `ANTI_AI_RULES` / `REGION_NOTES` in `src/lib/llm.mjs` |
| Offline fallback copy | the sentence pools in `src/lib/llm.mjs` |
| Website page structure | `offlinePage()` in `src/lib/website.mjs` |
| Publishing target | add an adapter in `src/lib/publish.mjs` |
| When posts go out | `posting_windows` / `posting_days` in Settings, or `src/lib/slots.mjs` |
| Scraper payload shape | `normaliseItem` / `groupByTarget` in `src/lib/ingest.mjs` |
