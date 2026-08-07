# Touchstone — Design & Architecture

Status: **design**, nothing implemented. This document is the argument for the shape of the
system, not a specification of a built one. The web UI is designed separately in [UX.md](UX.md). Where it asserts a fact about the existing loop, that
fact was read off the running system on 2026-08-06 and is cited so it can be re-checked when it
drifts.

---

## 1. What exists today

The job is already running on `yunderalabs` as four active n8n workflows:

| Workflow | ID | Role |
| --- | --- | --- |
| AppStore Continuous Store QA Loop | `uEmep2z22i5qv1OF` | hourly tick; picks one target, calls the audit |
| AppStore App Audit | `QjzNu9yWZ5005J7m` | builds the prompt, calls Claude Code, publishes the report |
| AppStore PR Review | `tOclUcWTrfQN6j1N` | PR-triggered review |
| AppStore release notes | `XJsURBnt7aIUhQVn` | commit-triggered release notes |

State lives in Docmost, not a database:

- Roll-up: **`Store QA — Results`**, slug `B5ZBicxRSn`, page id
  `019f373d-c73f-7cdd-b720-3d26da849dbe`
- Per-subject reports: children of **App Audits**, `wyi3Hb1MOx`
- Static Review Protocol: `LPwfKYUVig` · Functional Review Protocol: `7HxjTwe63H`

Read and written through Beacon at `http://beacon-backend:9300/mcp`, via
`docmost-mcp__get_page` / `docmost-mcp__update_page`, with a JSON-RPC-over-SSE client inlined —
twice, once in each of the two Code nodes that carry the domain logic.

### The scheduling policy, which is correct and should survive

The loop's central idea is good and Touchstone keeps it: **there is no queue.** The backlog is
re-derived from the "Last run" column on every tick, so it cannot drift out of sync with reality.
A subject is either idle, in progress, or carrying a verdict.

Its constants, worth preserving as configuration rather than reinventing:

| Constant | Value | Meaning |
| --- | --- | --- |
| `FRESH_DAYS` | 7 | a verdict older than this makes the subject eligible again |
| `STUCK_DAYS` | 7 | how long a subject that exhausted its tries is parked |
| `LEASE_MIN` | 120 | an in-progress claim expires after this, so a dead run cannot hold a row forever |
| `COOLDOWN_MIN` | 55 | minimum gap between finishing one assay and starting the next |
| `MAX_TRIES` | 3 | consecutive errored attempts before parking |

Two more pieces of existing logic are load-bearing and must be carried over, because they encode
hard-won correctness:

- **`agent-busy` must not consume a try.** When the shared Claude Code endpoint returns 409, that
  says nothing about the subject, so the row is restored untouched and no try is burned. The
  existing code comments this explicitly. Touchstone generalises the principle: *no infra
  condition may ever consume a subject's retry budget* — which is precisely what today's
  implementation fails to do for an unavailable bench, at a cost of 49 wasted assays.
- **Last-run is stamped on completion, not on claim.** Deliberately, so a failing subject goes to
  the back of the backlog and every subject gets one attempt before any subject gets a second.

---

## 2. What is wrong with it

### 2.1 The database is a wiki page

`Pick next target` fetches the roll-up markdown, parses table rows with

```
/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/
```

then recovers structured state by pattern-matching prose *inside* those cells: `⏳` means claimed,
`⚠` means errored, `try (\d+)` is the retry counter, `since (\S+)` is the lease timestamp, `stuck`
is the parked flag. It then re-renders all 69 rows and writes the page back. `Record result` does
the same in reverse.

It works. It is also a read-modify-write cycle over a document, with concurrency safety provided
by a 120-minute lease written in emoji, and no way to add a column without touching two regexes.

### 2.2 No history, therefore no regressions

One row per subject, overwritten each run. The three questions that matter most are all
unanswerable: is store risk trending down, when did this subject first fail, and **has anything
that was compliant become non-compliant?** A regression is the single most important event this
system can observe and it currently produces no signal whatsoever.

### 2.3 Findings are prose

A finding today is a paragraph inside a Docmost page. The Prowlarr report notes that
`cpu_shares: 10` is a family-wide convention across Radarr, Sonarr, Lidarr and qBittorrent and
says, correctly, that it is *"worth fixing across the *arr family in one pass rather than treating
it as a Prowlarr-specific slip."* Nothing surfaces that. Cross-subject aggregation is where most
of the value is, and it needs rows.

### 2.4 Infra failure is recorded as subject failure

The demo pool began rejecting all credentials on 2026-08-05:

- `POST /api/firstfactor` → **401** on both `demostaging1.inojob.com` and `demostaging2.inojob.com`
  (Authelia), for the protocol's `demo`/`demodemo` **and** for `demo@yundera.com`/`Demo123!`, the
  pair the demo portal itself advertises
- the upstream Firebase IdP returns `auth/invalid-credential` for the same credentials
- the hosts are healthy — static assets and `/api/state` return 200, the login UI renders; only
  the credential check fails
- the management board still reports `✅ Ready`, so **the board does not detect this failure mode**

Consequence: 49 of 69 subjects sit at `⚠️ errored`, 12 of them parked as "stuck after 3 tries."
Not one of those is a statement about an app.

### 2.5 One assay conflates two independent verdicts

Static and functional are already two protocol documents producing two leaf results, but they are
collapsed into one headline. Because a mandatory functional phase that errors can never yield
`compliant`, a bench outage overrides a complete and correct static result. NextcloudMCP's report
states its static answer plainly — the best achievable outcome once the bench returns is
`non-compliant · Minor · risk 2` — and still displays as `⚠️`.

### 2.6 The browser is shared, and it is contended

Three consecutive reports independently flag it:

> *"A concurrent `functional-OpenClaw-audit` context was observed sharing the same browser and
> intermittently stealing page selection"* — SegmentPlayer, 2026-08-05
>
> *"the shared CDP browser additionally reset its page set twice mid-run and was recovered each
> time"* — Prowlarr, 2026-08-06
>
> *"The browser/CDP session also restarted once mid-run and was recovered"* — NextcloudMCP,
> 2026-08-06

Two assays stealing page selection from one another is a correctness hazard, not a nuisance: an
assay can act on another assay's page and record the result as its own.

---

## 3. Design principles

1. **The report folder is the archive of record; the index is disposable.** Reports are markdown
   files on disk with self-describing frontmatter, and the index over them is held in memory and
   cached — deleting the cache is always safe. There is no database. Docmost stops being storage
   entirely and becomes an optional publisher, off by default.
2. **Assays are append-only.** Nothing is overwritten. Current state is a view over history.
3. **A finding is a row, keyed by a stable rule code.** Prose is evidence attached to a row, not
   the row itself.
4. **Every assay records which version of the standard judged it.** A verdict without a rubric
   version is not durable.
5. **Infra conditions never consume a subject's retry budget, and never produce a verdict about
   the subject.** Generalised from the existing `agent-busy` handling.
6. **Legs are independent.** One unavailable resource degrades one leg.
7. **Generic model, one tenant.** `subject.kind` and pluggable standards; the AppStore is the
   first tenant, not the schema.

---

## 4. Domain model

This is the *shape* of the data, not a database schema. Nothing here is relational and there is no
database — see the storage note after the model, and
[IMPLEMENTATION.md §5](IMPLEMENTATION.md#5-storage--files-no-database).

```
-- WHAT IS JUDGED ---------------------------------------------------------
subject
  id, kind, name, source_ref, config_json, enabled, created_at
  -- kind='appstore_app'; source_ref='Yundera/AppStore@main:Apps/Prowlarr'

-- WHAT IT IS JUDGED AGAINST ---------------------------------------------
standard
  id, name, version, leg, source_page, content_hash, effective_from
  -- leg ∈ static | functional
  -- source_page = the Docmost slug; content_hash detects rubric drift

rule
  id, standard_id, code, title, default_severity, mandatory
  -- code is stable across versions: 'D1'..'D5', 'A', 'C', 'E8', 'E9', 'G'…

-- WHAT HAPPENED ---------------------------------------------------------
assay
  id, subject_id, standard_id, standard_version, depth, scope,
  bench_id, browser_id, try_n, trigger,
  status, verdict, top_severity, risk_score,
  subject_ref, image_refs_json, report_path,
  started_at, finished_at, blocked_reason
  -- report_path is relative to <data>/reports/, e.g.
  --   OpenClaw/2026-08-05T09-14-22Z-static.md
  -- status  ∈ queued | running | done | blocked
  -- verdict ∈ compliant | non-compliant | errored | deferred   (null unless done)
  -- scope   ∈ full | pr-diff
  -- blocked_reason distinguishes infra from subject; drives retry accounting

finding
  id, assay_id, rule_code, severity, status, note, evidence_json
  -- status ∈ pass | fail | n-a | advisory | unverified
  -- severity is the *observed* severity; for unverified it is the suspected one

-- WHAT IT RUNS ON -------------------------------------------------------
bench
  id, kind, url, status, healthy_at, health_detail,
  lease_assay_id, lease_until

browser
  id, endpoint, status, lease_assay_id, lease_until

-- WHAT IT TELLS YOU ------------------------------------------------------
incident      -- stateful, deduplicated: an outage is ONE row that accumulates
  id, key, severity, title, detail, state, impact_json,
  opened_at, last_seen_at, resolved_at, acked_at, muted_until
  -- key ∈ bench.auth | bench.unreachable | agent.unavailable
  --     | browser.crashloop | standard.drift
  -- state ∈ open | acked | resolved

event         -- point-in-time, immutable
  id, kind, subject_id, assay_id, detail_json, created_at, read_at
  -- kind ∈ verdict.critical | verdict.regression | verdict.compliant
  --      | verdict.changed  | assay.finished

-- DERIVED ---------------------------------------------------------------
hallmark   -- view: latest done assay per (subject, leg), composed
```

The incident/event split exists because the two behave differently, and conflating them is what
turned one bench outage into 49 identical alerts. See [UX.md § Activity](UX.md#24-activity--incidents-and-events).

### Where each part lives

| Entity | Storage | Why |
| --- | --- | --- |
| `standard`, `rule` | `standards/*.yaml` | the rubric is reviewable, versionable configuration |
| `subject` | GitHub contents API + overrides in `config.yaml` | derived; only overrides are authored |
| `assay`, `finding` | **frontmatter of the report file** | the record and the artefact are one thing |
| `bench` | `state/benches.json` | last probe result; re-probed at boot anyway |
| `incident` | `state/incidents.json` | small, mutable, atomically rewritten |
| `event` | `state/events.jsonl` | append-only log |
| `hallmark` | computed | latest assay per `(subject, leg)`, from the in-memory index |

Three of these are configuration, two are the report files, two are tiny runtime state, and one is
a log. That is the argument for having no database: there is nothing relational to store.

### Why `standard_version` on every assay

The protocols carry dated amendments — §B4/§E on verdict precedence, the 2026-07-07
strict-full-run amendment that forbids recording a mandatory phase as *skipped*, the 2026-07-17
amendment that binds bench selection. When a rubric changes, every prior verdict silently becomes
stale, and today nothing records which rubric produced which verdict. With the column, a rubric
bump is a query: *which hallmarks were issued under a superseded standard?* `content_hash` catches
the case where the Docmost page is edited without anyone bumping a version.

### Why `unverified` is a first-class status

This is the highest-value field in the schema and it does not exist today.

The Prowlarr assay could not run its functional leg, and its most important observation is
therefore filed as an advisory: the *arr stack defaults `AuthenticationRequired` to
`DisabledForLocalAddresses`; every request arrives from Caddy over the internal `pcs` network,
i.e. from an RFC1918 source; so the login gate may be skipped **for all proxied traffic** on a
host that the `nip.io`/`sslip.io` labels make internet-reachable. The report is explicit that this
is *"the single highest-value thing the blocked run would have settled"* — and that the check
which would have settled it, phase E9, is exactly the one that errored.

Stored as `status='unverified', severity='critical'`, that becomes a standing query:

> **suspected Criticals awaiting a working bench**

which is the correct work queue to drain the moment the pool is repaired. As prose in a page, it
is invisible.

### Verdict algebra

Carried over unchanged from the existing protocol, because it is already well specified:

| Severity | Meaning |
| --- | --- |
| **Critical** | security or data loss — auth bypass, account takeover, privilege escalation, data erasure |
| **Major** | contract break — missing or broken required asset, missing required `rationale.md`, name-regex violation, `:latest` on the main image |
| **Minor** | one-liner — missing or mis-tiered `cpu_shares`, unpinned helper image, missing descriptions |

`risk_score = 100·Critical + 10·Major + 1·Minor`, summed over failing findings. **The score ranks
a backlog; the tier and the gates decide the verdict.** Gate precedence is unchanged: any Critical
forces non-compliant; otherwise any fail sets the tier; an errored mandatory rule outranks both
and can never yield `compliant`.

The one change: where today an errored mandatory *functional* rule produces `errored` for the
whole assay, Touchstone scopes that to the functional assay and lets the static assay stand on its
own.

---

## 5. Components

```
   n8n adapters                    Touchstone                       outlets
  ┌──────────────┐          ┌───────────────────────┐          ┌─────────────┐
  │ PR opened    │          │  API  /api/v1/events  │          │  Docmost    │
  │ commit push  │─ POST ──▶│                       │─ MCP ───▶│  roll-up +  │
  │ release atom │          │  ┌─────────────────┐  │          │  reports    │
  └──────────────┘          │  │ scheduler       │  │          └─────────────┘
                            │  │  eligibility    │  │          ┌─────────────┐
                            │  │  cooldown/lease │  │─ MCP ───▶│  Telegram   │
                            │  └────────┬────────┘  │          │  Discord    │
                            │           ▼           │          └─────────────┘
                            │  ┌─────────────────┐  │
                            │  │ queue + workers │  │          ┌─────────────┐
                            │  │  static  (wide) │  │─ HTTP ──▶│ Claude Code │
                            │  │  functional (N) │  │          └─────────────┘
                            │  └────────┬────────┘  │
                            │           ▼           │          ┌─────────────┐
                            │  ┌─────────────────┐  │─ CDP ───▶│ browser ×N  │
                            │  │ bench + browser │  │          └─────────────┘
                            │  │ lease + health  │  │          ┌─────────────┐
                            │  └─────────────────┘  │─ HTTPS ─▶│ benches ×2  │
                            │   files + index       │          └─────────────┘
                            └───────────────────────┘
```

### Scheduler

Owns everything the two Code nodes own today: eligibility by freshness, cooldown, lease reclaim,
try accounting, parking. Runs on a timer inside the app. Because eligibility is a query rather
than a regex, the "no queue, re-derive every tick" property is preserved for free and becomes
cheaper.

Per-leg policy: static eligibility is driven by commit events and a long freshness window;
functional by a shorter one plus releases.

### Runner and queue

Today the audit calls a single shared Claude Code endpoint and handles 409 with a wait-and-retry
inside n8n. Touchstone owns a real queue with a worker pool:

- **static workers** need no bench and no browser, so they scale wide
- **functional workers** are bounded by the bench pool — two demo instances means two workers

That bound is a property of the resource, not a constant, and it falls straight out of leasing.

### Bench and browser leasing

Benches are rows, and **the app probes the bench before claiming it.** A login preflight against
`/api/firstfactor` costs one request and would have prevented all 49 wasted assays. If the pool is
unhealthy: pause the functional queue, mark queued functional assays `blocked` with
`blocked_reason='bench_unavailable'` — which by principle 5 consumes no try — and fire **one**
alert.

**A lease is `(bench, browser)` together.** One browser per functional worker, taken and released
with the bench. The page-stealing race in §2.6 then cannot occur, because no two assays share a
browser by construction.

#### The browser profile is ephemeral — the one deliberate divergence from Newsdesk

Newsdesk runs its own `browser-mcp` sidecar with a **persistent** Chrome profile on disk. That is
right for Newsdesk: a stringer reading a source benefits from a warm, logged-in session.

For Touchstone it is exactly backwards, and unsafe. Phase **E9 asks whether the app has an auth
gate**. A session cookie surviving from a previous assay makes an unprotected app look protected —
a **false pass on the one check that catches auth bypass**, which is the highest-severity finding
class in the whole standard. The agents already work around this by hand: the Prowlarr run used
"three isolated browser contexts" to rule out a stale `flow_id`.

Therefore: fresh context per assay, profile discarded between assays, and any state that must
survive (bench credentials) comes from configuration, not from disk residue.

Giving Touchstone its own browsers also removes it from the shared box-wide `browsermcp`, which
stops the interference in both directions.

### Reports and outlets

An assay writes one **markdown file** under `<data>/reports/<subject>/<iso>-<leg>.md`, with YAML
frontmatter carrying the structured verdict and finding list. That file is the archive of record:
sortable, greppable, backed up with the rest of the data dir, readable without the app, and
sufficient to rebuild the index. The web UI renders it — see [UX.md § Reports as files](UX.md#3-reports-as-files).

The cross-subject views that Docmost cannot produce — **recurring findings** grouped by
`rule_code`, and **regressions** — are pages in the UI, backed by queries rather than by rendering.

**Docmost becomes an optional publisher**, off by default. It can still receive a rendered roll-up
for people who live in the wiki, through the same Beacon MCP path used today, but nothing in
Touchstone ever reads it back. Telegram/Discord stay as push outlets for incidents and
high-severity events, per the routing table in UX.md.

---

## 6. API

Modelled directly on Newsdesk's ingest contract — `POST /api/v1/filings` with a static header
token, addressed by service name on the `pcs` network.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/events` | adapter ingest: PR opened, commit pushed, release published |
| `POST` | `/api/v1/assays` | explicitly request an assay (subject, leg, depth, scope) |
| `GET` | `/api/v1/subjects` | registry + current hallmark |
| `GET` | `/api/v1/assays` | history, filterable by subject/leg/verdict |
| `GET` | `/api/v1/findings` | `?rule_code=` for recurring, `?status=unverified` for the suspected-Critical queue |
| `GET` | `/api/v1/benches` | pool health |
| `GET` | `/api/v1/assays/:id/report` | the markdown file — `?format=raw\|html` |
| `GET` | `/api/v1/incidents` | open/acked incidents for the Activity page |
| `POST` | `/api/v1/incidents/:id/ack` | acknowledge or mute |
| `GET` | `/api/v1/events` | conformance event feed |
| `GET` | `/api/v1/subjects/:id/check` | **phase 3** — gate status for a PR-scoped assay |

The subject registry is refreshed from the GitHub contents API for `Yundera/AppStore/Apps`, as
today, with the existing hardcoded list retained only as a cold-start fallback.

---

## 7. What stays in n8n

Adapters only, each one POST, each the size of a Newsdesk stringer:

- PR opened/updated → `POST /api/v1/events` → static assay, `scope='pr-diff'`
- commit touching `Apps/*` → static assay for the touched subjects
- release atom → functional assay

**The hourly tick is deleted.** It is scheduling policy, not a source, and it moves inside.

---

## 8. Packaging

Copied from Newsdesk's compose, which is a solved problem:

- **AppShield sidecar** terminating OIDC/Authelia SSO; backend carries no Caddy labels and is
  reachable only on the internal `pcs` network
- `name` == `container_name` == `hostname` == **`touchstone`** — all three are load-bearing, since
  AppShield builds its redirect URIs from `os.hostname()` and the auth-registrar attests the app
  name via the container's PTR record
- **One data dir**, `pre-install-cmd` creating and chowning it so an unprivileged runtime can
  write: `config.yaml`, `standards/`, `reports/` and `state/` under a single volume, so a backup
  of that one path is the whole system
- `user: 1000:1000`, on `pcs` so Beacon is reachable by service name
- a **trusted-gate** env naming the sidecar, so a request arriving on the gate's socket counts as
  authenticated and users are not asked for a second login
- shipped as an AppStore app, so Touchstone assays the store it lives in

One thing to reconcile first: the running `newsdesk-browser` container is **not present in**
`/DATA/AppData/newsdesk/docker-compose.yml` — there is a `docker-compose.yml.bak-pre-browser` but
no browser service in the live file. The running stack and its compose have drifted. Fix that
before using it as a template.

---

## 9. Migration

Nothing is discarded. Two steps, and they double as the schema's first real test:

1. **Import the roll-up table** — 69 rows, using the existing regex, into `subject` + a synthetic
   most-recent `assay` per subject.
2. **Export the archived reports to files** — ~55 Docmost pages fetched once via
   `docmost-mcp__get_page` and written to `reports/<subject>/…md` with frontmatter reconstructed
   from the page. After this step Docmost holds nothing Touchstone needs.
3. **Extract findings from those files** — well-structured prose parsed into `finding` rows with
   rule codes.

The acceptance test for step 2 is concrete: the recurring-findings query must independently
rediscover the `cpu_shares: 10` cluster across the *arr family. If it does not, the rule vocabulary
is not yet good enough.

---

## 10. Phases

| Phase | Deliverable | Gets you |
| --- | --- | --- |
| **0** | schema, importer, read-only dashboard rendered from the DB | the model proven against real, messy data; n8n untouched and still driving |
| **1** | scheduler in-app, legs split, bench health preflight | the 2026-08-05 outage stops repeating; static coverage advances during bench outages |
| **2** | queue + worker pool, `(bench, browser)` leasing | the 409-busy retry dance and the page-stealing race both disappear |
| **3** | PR-scoped assays + check API | the contributor merge gate; schema already fits |
| **4** | findings → pull requests | the maintenance daemon the original concept note asked for |

### Worth doing this week, independent of all of it

Add a login preflight to `Pick next target` in the existing workflow: probe `/api/firstfactor`
before claiming a target and skip the tick on 401. Roughly twenty lines. Everything above is a
rewrite; this is not, and it stops the bleeding in the meantime.

---

## 11. Open questions

1. **Rule vocabulary.** Turning the contribution rules into stable coded rules is the piece that
   makes or breaks the findings table. Deviation rules `D1`–`D5` and phase codes `A`/`C`/`D`/`E8`/
   `E9`/`E10`/`F`/`G`/`G′` already exist and are used consistently in reports — that is the seed.
   The static documentation and asset checks are still prose and need codes.
2. **Who owns the standard?** If the rubric lives in Docmost, Touchstone points at it and hashes
   it. If it lives in the AppStore repo next to `CONTRIBUTING.md`, it versions with the thing it
   governs. The second is more principled; the first is what exists.
3. **Bench provisioning.** Touchstone currently *leases* benches it does not control. Should it be
   able to request a fresh one, or is depending on an externally managed pool acceptable?
4. **Gate strictness (phase 3).** Does a Minor finding block a contributor's PR, or only report?
   This is a community-policy decision, not a technical one, and it should be settled before the
   gate ships rather than after.
5. **Re-assay on rubric bump.** When a standard's version changes, are prior hallmarks invalidated
   immediately, marked stale, or left until their normal freshness expiry?
