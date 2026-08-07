# Touchstone — Implementation Notes

Companion to [ARCHITECTURE.md](ARCHITECTURE.md) (why) and [UX.md](UX.md) (what it looks like).
This document is *how*, and it is deliberately scoped to an MVP.

---

## 1. What the MVP is

> **Touchstone stores, indexes and displays what the existing n8n loop already produces, and
> tells you when the environment — not the app — is broken.**

It does **not** schedule, queue, lease, or drive assays in the MVP. The n8n loop keeps doing that,
untouched, exactly as it does today. Touchstone becomes the place the results *land*.

That split is the whole point: it gets the durable model, the history, the findings table and the
incident handling into production without a rewrite of the working part, and it makes phase 1 —
moving the scheduler in — a change of driver rather than a big bang.

### In

- report files on disk with frontmatter, and the in-memory index over them
- ingest endpoint the audit workflow posts to
- one-time importer for the existing 69 rows and ~55 reports
- Overview, Subject detail (+ markdown viewer), Findings, Activity, Environment
- bench prober, incident engine, Telegram/Discord push
- re-assay button (delegating to the existing n8n webhook)

### Out — and these are decisions, not omissions

| Deferred | Why |
| --- | --- |
| scheduler, queue, worker pool | n8n already does it; replacing it is phase 1–2 |
| bench + browser leasing | needs the runner first |
| dedicated browser sidecar | only the runner uses a browser; nothing in the MVP does |
| PR gate / check API | phase 3, and the schema already accommodates it |
| findings → PRs | phase 4 |
| Standards page | drift detection is valuable but not load-bearing on day one |
| charts | three weeks of history; the history strip carries the signal |
| per-subject mute | speculative until the Critical list actually gets noisy |

---

## 2. The seam with the existing loop

Two small changes on the n8n side, both mirroring the Newsdesk stringer pattern — a single HTTP
node that posts one payload with a header token.

**a. Result fan-out.** Add one node to `AppStore App Audit` (`QjzNu9yWZ5005J7m`), parallel to the
existing Docmost publish:

```
Extract LLM response ──┬─▶ Publish to Docmost      (existing, unchanged)
                       └─▶ POST /api/v1/assays     (new)
```

Nothing existing is modified or removed, so the fallback if Touchstone is down is "we lost a
notification," never "we lost an audit." Docmost publishing gets switched off later, once the
importer and the UI have been trusted for a while.

**b. Re-assay button.** The audit workflow already exposes a `Webhook (programmatic)` trigger.
Touchstone's re-assay action POSTs to it. The MVP gets a working action for the cost of one
`fetch`, and no scheduling logic.

---

## 3. Stack

Chosen to match Newsdesk so the packaging, base image and deploy story are already solved.

| Layer | Choice | Note |
| --- | --- | --- |
| runtime | Node 22 LTS, TypeScript, ESM | same as `newsdesk-backend` |
| HTTP | Fastify | static-file serving, schema validation, good TS types |
| **storage** | **files on disk + an in-memory index** | no database — see §5 |
| frontend | React + Vite, built into the image | one container serves API and SPA on one port |
| markdown | `markdown-it` + `gray-matter` + `yaml` | render server-side, sanitize output |
| MCP | one small JSON-RPC-over-SSE client | extracted **once**; today it is inlined twice in n8n |

Single container, single port, single data volume. No Redis, no Postgres, no job broker, **no
SQLite** — the MVP has no queue and no relational data.

Dropping the database also drops the only native dependency. The AppStore requires
`architectures: [amd64, arm64]`, and a native module means prebuilds or a compile step in a
multi-arch image. This stack is pure JavaScript.

---

## 4. Repo layout

```
src/
  server/
    index.ts            fastify bootstrap, static SPA, /api mount
    store/
      index.ts          the in-memory index: build, query, invalidate
      reports.ts        read/write report files + frontmatter
      state.ts          incidents.json / events.jsonl, atomic writes
      config.ts         config.yaml + standards/*.yaml
    routes/
      assays.ts         POST ingest, GET list, GET report
      subjects.ts       registry + hallmark view
      findings.ts       grouped + flat
      incidents.ts      list, ack, mute
      events.ts         feed
      benches.ts        status, manual probe
    domain/
      severity.ts       tier ordering, risk score, gate precedence
      hallmark.ts       compose latest assay per (subject, leg)
      regression.ts     compare against previous — emits verdict.* events
    services/
      prober.ts         bench health loop
      incidents.ts      open / refresh / resolve, dedup by key
      notify.ts         routing table → beacon outlets
      mcp.ts            the one MCP client
  web/
    routes/             Overview, Subject, Findings, Activity, Environment
    components/         StatusCell, HistoryStrip, MarkdownView, IncidentCard
tools/
  import-rollup.ts      one-time: the 69-row table
  import-reports.ts     one-time: Docmost pages → files → findings
test/
  fixtures/reports/     real archived reports, committed
```

Rule worth keeping: **nothing outside `store/` touches the filesystem.** The thing being replaced
failed partly because its data access was smeared through two 200-line code nodes; routes and
domain logic get the index, never a path.

---

## 5. Storage — files, no database

### Why there isn't one

Of the nine entities in ARCHITECTURE.md §4, **three are configuration** (`standard`, `rule`, and
the override half of `subject`), **two are already the report files** (`assay` and `finding` — the
frontmatter *is* the record), **two are tiny runtime state** (`bench`, `incident`), and **one is an
append-only log** (`event`). Nothing is relational, nothing needs a transaction spanning entities,
and nothing needs a query planner.

The query that sounds expensive — *which subjects fail rule X* — only ever runs over the **latest
assay per subject per leg: 138 files**, not the whole corpus. Parsing 138 frontmatters is
milliseconds. Subject history reads one folder. The activity feed is a log tail. No view in the
MVP touches the full archive.

### Layout

```
/data/
  config.yaml                benches + credentials, routing, constants   (hand-edited)
  standards/
    static-v3.yaml           rule codes, titles, default severities
    functional-v2.yaml
  reports/
    OpenClaw/
      2026-08-05T09-14-22Z-static.md        ← frontmatter = assay + findings
      2026-08-05T09-31-08Z-functional.md
  state/
    incidents.json           small, mutable
    events.jsonl             append-only
    benches.json             last probe result per bench
    index.json               CACHE ONLY — safe to delete at any time
```

Filenames use ISO-8601 with `:` replaced by `-`, so they sort lexically and are portable.

### The index

At boot, scan `reports/**`, parse frontmatter only (never the body), and hold the whole index in
memory. Update it in place on every write. That is the entire data layer.

`index.json` is an **mtime-keyed cache** so a restart re-parses only changed files. The test for
whether something is a cache rather than a database: deleting it must always be safe. It is —
delete it and the next boot rebuilds from `reports/`.

Bodies are read lazily, per request, when the viewer asks for one.

### Writes

- **Report files** are written first, then the index updates. If the write fails the ingest fails
  and n8n retries. Files are never modified after creation.
- **`incidents.json`** is mutable, so write to a temp file and `rename()` — atomic on the same
  filesystem, so a crash mid-write cannot leave a truncated file.
- **`events.jsonl`** is append-only with `O_APPEND`; a partial trailing line is skipped on read.

### What this costs, honestly

- **Boot scan is linear.** Fine at ~7k files, not fine at 100k. The mtime cache pushes that years
  out, and the fix when it arrives is to add an index, not to rewrite — because the frontmatter is
  the source of truth either way, adding one is purely additive and migrates nothing.
- **No cross-entity atomicity.** Writing a report and appending its event are two operations.
  Report first; the event log is replay-tolerant. A lost event is a lost notification, not lost
  data.
- **Single writer.** One process. Never run two replicas.
- **Incident dedup is application logic, not a constraint.** A keyed map in a single process is
  correct; a database unique index would only have been belt-and-braces against a bug in our own
  code. Worth a test rather than worth a database.

### Invariants worth a test each

1. **Round-trip.** Parse a written file, rebuild the assay + findings, get identical values.
2. **Reindex.** Delete `state/index.json`, rebuild, get a byte-identical index. This is what makes
   the folder the archive of record rather than a nice-to-have.

---

## 6. Ingest contract

`POST /api/v1/assays`, header token auth (`TOUCHSTONE_INGEST_TOKEN`), same shape of trust as
Newsdesk's `/api/v1/filings`.

```jsonc
{
  "subject": "Prowlarr",
  "leg": "static",                          // static | functional
  "standard": { "name": "Static Review Protocol", "version": 3 },
  "verdict": "non-compliant",               // compliant | non-compliant | errored | deferred
  "top_severity": "major",                  // critical | major | minor | none
  "risk_score": 13,
  "blocked_reason": null,                   // e.g. "bench_unavailable" | "agent_busy"
  "subject_ref": "Yundera/AppStore@main:Apps/Prowlarr",
  "commit": "0f5955e3e243",
  "images": ["lscr.io/linuxserver/prowlarr:2.4.0"],
  "started_at": "2026-08-06T07:00:16Z",
  "finished_at": "2026-08-06T07:16:27Z",
  "findings": [
    { "rule": "D2", "severity": "major", "status": "fail",
      "note": "relies on first-launch auth onboarding, no rationale.md" },
    { "rule": "E9", "severity": "critical", "status": "unverified",
      "note": "DisabledForLocalAddresses may skip the gate for proxied traffic" }
  ],
  "report_markdown": "# Yundera/AppStore — Prowlarr\n\n..."
}
```

Server-side, in order:

1. validate; resolve the `subject`, creating its report folder if new
2. **write the report file** — frontmatter assembled from the payload, body verbatim
3. update the in-memory index
4. **compute events** by comparing to the previous `done` assay for the same `(subject, leg)`
5. append events, route notifications

Step 2 is the commit point: once the file is on disk the assay exists, whatever happens next.

**Blocked assays never consume a try.** If `blocked_reason` is set, the row is recorded with
`status='blocked'`, `try_n` is *not* incremented, and no `verdict.*` event fires. This is
architecture principle 5, and it is enforced here — the one place it can be enforced.

### Regression detection

Rank `compliant(0) < minor(1) < major(2) < critical(3)`. `errored` and `blocked` are excluded from
comparison entirely — an infra failure must never read as a regression. Then:

| Transition | Event |
| --- | --- |
| rank increased | `verdict.regression` |
| any new Critical finding | `verdict.critical` |
| rank → 0 | `verdict.compliant` |
| rank changed, not above | `verdict.changed` |
| no change | `assay.finished` |

---

## 7. Prober and incidents

A timer (default 5 min, configurable) probes each configured bench:

```
POST https://local-auth-<bench>/api/firstfactor   { username, password }
expect 200 · treat 401 as auth failure · treat timeout/5xx as unreachable
```

Credentials come from `config.yaml` in the data dir, never from the repo. On failure open or
refresh an incident keyed `bench.auth` or `bench.unreachable`; on success resolve it and emit the
recovery notification.

**Impact accounting** on the open incident: count of subjects whose functional leg is currently
blocked, refreshed on each probe. That is what turns the card into *"49 assays blocked, 0 tries
consumed"* instead of a bare error string.

The MVP does not act on the incident beyond reporting it, because the MVP does not schedule. Phase
1 is where an open `bench.*` incident pauses the functional queue.

---

## 8. Notifications

`notify.ts` maps `(class, kind) → outlets` from the routing table in
[UX.md §2.4](UX.md#24-activity--incidents-and-events), then calls Beacon over MCP.

The Telegram and Discord tool names must be resolved at implementation time via beacon's
`server_doc` for `telegram-mcp` / `discord-mcp` — do not guess them from memory, and do not copy
whatever string the n8n nodes use without checking it still exists.

Delivery is best-effort and must never fail an ingest: log, mark the event undelivered, move on. A
notification outage is not a data-loss event.

---

## 9. Frontend

Routes map 1:1 to UX.md: `/`, `/s/:subject`, `/findings`, `/activity`, `/env`.

Three components carry most of the design:

- **`StatusCell`** — renders one leg's state. The only component that knows *failed* and *unknown*
  must look different; get this right once and the rest of the UI inherits it.
- **`HistoryStrip`** — the per-subject glyph run with the regression marker.
- **`MarkdownView`** — server-rendered HTML, injected. Tables first: wrap every table in an
  `overflow-x: auto` container, because the reports are mostly tables and a wide one must not
  break the page. Heading anchors for deep-linking from a finding row.

Polling on a short interval is fine for the MVP; there is no live-updating requirement that
justifies websockets when the fastest thing in the system takes eight minutes.

---

## 10. Configuration

Env, following the `NEWSDESK_*` convention:

```
TOUCHSTONE_DATA_DIR=/data
TOUCHSTONE_PORT=8080
TOUCHSTONE_PUBLIC_URL=https://touchstone-${APP_DOMAIN}
TOUCHSTONE_TRUSTED_GATE=touchstone
TOUCHSTONE_INGEST_TOKEN=...
TOUCHSTONE_BEACON_URL=http://beacon-backend:9300/mcp
TZ
```

Everything else — benches and their credentials, notification routing, the scheduling constants,
the n8n re-assay webhook — lives in `config.yaml`, seeded on first boot into the data dir. Secrets
stay out of the repo and out of the compose file.

---

## 11. Packaging

Copy the Newsdesk compose and change the names: AppShield sidecar in front, backend with no Caddy
labels on the `pcs` network, `name` == `container_name` == `hostname` == `touchstone`,
`user: 1000:1000`, `pre-install-cmd` creating and chowning `/DATA/AppData/$AppID/data`.

Two notes:

- Reconcile the Newsdesk compose drift first — the running `newsdesk-browser` is not in the
  compose file on disk. Copy from the *running* stack, not the stale file.
- Touchstone needs **no** browser sidecar in the MVP. It arrives with the runner in phase 2, and
  with an ephemeral profile — see ARCHITECTURE.md § Bench and browser leasing.

---

## 12. Testing

Unit tests where the logic is subtle rather than everywhere: severity ordering and gate
precedence, regression comparison (including that `errored` never counts), incident dedup and
resolve, frontmatter round-trip, and reindex-after-cache-delete.

**The acceptance test for the whole model** is concrete and uses real data: import the archived
reports, then assert that the grouped-findings query independently rediscovers the `cpu_shares: 10`
cluster across Radarr, Sonarr, Lidarr, Prowlarr and qBittorrent — a fact that currently exists only
as one sentence inside one report. If that query does not find it, the rule vocabulary is not good
enough yet, and that is the thing to fix before building anything on top.

A second one worth having: import the 2026-08-05/06 window and assert that it produces **one** open
incident and **zero** `verdict.regression` events. That is the exact scenario the system exists to
handle correctly.

Commit the fixture reports. They are the only realistic corpus, and they are full of the messy
formatting a parser has to survive.

---

## 13. Order of work

Each milestone is independently useful and independently abandonable.

| # | Milestone | Done when |
| --- | --- | --- |
| **M1** | store, ingest, report writer | POSTing a real archived report produces a file and an index entry |
| **M2** | importers | 69 subjects and ~55 reports on disk; the `cpu_shares` test passes |
| **M3** | Overview + Subject detail + markdown viewer | the current state is visible without opening Docmost |
| **M4** | Findings view | the recurring-findings query has a UI |
| **M5** | prober, incidents, Activity, push | the bench outage shows as one incident, in-app and on Telegram |
| **M6** | packaging, deploy behind AppShield | reachable at `touchstone-yunderalabs.nsl.sh` |
| **M7** | the n8n fan-out node | live results land without the importer |

M7 last on purpose: point the live feed at it only once the UI has proven the model against
imported history.

### Before any of it

The twenty-line login preflight in the existing `Pick next target` node. It is not part of
Touchstone, it stops the bleeding now, and everything above assumes the bench outage is understood
rather than ongoing.
