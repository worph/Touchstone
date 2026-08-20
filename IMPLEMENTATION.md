# Touchstone — Implementation Notes

Companion to [ARCHITECTURE.md](ARCHITECTURE.md) (why, and the parity matrix that is the
specification) and [UX.md](UX.md) (what it looks like). This document is *how*.

---

## 1. What is being built

> **Touchstone runs the conformance loop that two n8n workflows run today — the hourly tick, the
> target selection, the agent call, the browser, the report — and tells you when the environment,
> not the app, is broken.**

It schedules, leases, drives and records. That is the whole point: the previous plan stopped at
"the place results land", which left n8n owning every interesting decision and left the defect of
record ([ARCHITECTURE.md §2.3](ARCHITECTURE.md#23-infra-failure-is-recorded-as-subject-failure))
unfixed.

The specification is [ARCHITECTURE.md §1.4](ARCHITECTURE.md#14-capability-inventory-and-parity-matrix).
Every section below closes named rows from it.

---

## 2. Stack

Chosen to match Newsdesk so the packaging, base image and deploy story are already solved.

| Layer | Choice | Note |
| --- | --- | --- |
| runtime | Node 22 LTS, TypeScript, ESM | same as `newsdesk-backend` |
| HTTP | Fastify | static-file serving, schema validation, good TS types |
| **storage** | **files on disk + an in-memory index** | no database — §4 |
| scheduler | an in-process timer | no cron container, no job broker |
| agent | Claude Code over MCP, through Beacon | `http://beacon-backend:9300/mcp` |
| browser | `ghcr.io/worph/browser-mcp:1.1.5` sidecars, ephemeral profile | §6 |
| frontend | React + Vite, built into the image | one container serves API and SPA on one port |
| markdown | `markdown-it` + `gray-matter` + `yaml` | render server-side, sanitize output |
| push | `web-push` (VAPID) | Android and desktop; iOS out of scope |
| MCP | one small JSON-RPC-over-SSE client | already written as `tools/mcp.ts`; promote it |

Single backend container, single port, single data volume, plus N browser sidecars. No Redis, no
Postgres, **no SQLite** — there is no queue and no relational data. Dropping the database also
drops the only native dependency, which matters because the AppStore requires
`architectures: [amd64, arm64]`.

---

## 3. Repo layout

```
src/
  server/
    index.ts            fastify bootstrap, static SPA, /api mount, start the scheduler
    store/
      index.ts          the in-memory index: build, query, invalidate      [built]
      reports.ts        read/write report files + frontmatter              [built]
      registry.ts       subjects from the GitHub contents API + overrides  ← B1
      state.ts          alerts.json / events.jsonl / benches.json, atomic writes
      config.ts         config.yaml                                        [built]
    scheduler/
      tick.ts           the hourly timer; one tick end to end              ← A1
      eligibility.ts    freshness, cooldown, parking, ordering             ← B4,B5,B7
      lease.ts          claim, reclaim, release                            ← B3,C1,C2
      tries.ts          try accounting and the no-burn rules               ← B6,E5,E6
    runner/
      prompt.ts         assemble the protocol prompt                       ← D1
      agent.ts          call Claude Code, extract, busy-detect, backoff     ← D2–D5
      record.ts         headline → frontmatter → file → index              ← E1,E4,E7
    services/
      bench.ts          probe, lease, health loop                          ← D7
      browser.ts        lease a browser container, assert an empty profile  ← D6
      mcp.ts            the one MCP client (promoted from tools/)
      events.ts         the append-only log                                ← F5
      alerts.ts         open / refresh / resolve, dedup by key
      notify.ts         routing table → Beacon outlets                     ← F1–F4
      push.ts           VAPID subscriptions and sends
    routes/
      subjects.ts       registry + hallmark view                           [built]
      reports.ts        the markdown file, rendered and raw                [built]
      assays.ts         POST — request an assay now (the re-assay button)
      benches.ts        pool health
      events.ts         the log feed
      alerts.ts         open alerts
    domain/
      severity.ts       tier ordering, risk score, gate precedence          [built]
      hallmark.ts       latest done assay per (subject, leg)                [built]
      markdown.ts       render + anchors                                    [built]
  web/
    pages/              Overview, Subject, Activity
    components/         StatusCell, MarkdownView, EventRow, AlertCard
tools/
  import.ts             one-shot migration; delete after it has run once
test/
  fixtures/reports/     real archived reports, committed
```

Rule worth keeping: **nothing outside `store/` touches the filesystem.** The thing being replaced
failed partly because its data access was smeared through two 200-line Code nodes; routes, the
scheduler and the runner get the index, never a path.

---

## 4. Storage — files, no database

### Layout

```
/data/
  config.yaml                benches + credentials, routing, constants   (hand-edited)
  protocols/
    static.md                the rubric; its frontmatter names and versions the section
    functional.md
  reports/
    OpenClaw/
      2026-08-05T09-14-22Z-static.md        ← frontmatter = the assay record
      2026-08-05T09-31-08Z-functional.md
  state/
    alerts.json              small, mutable
    events.jsonl             append-only
    benches.json             last probe result per bench
    browsers.json            last lease per browser
    index.json               CACHE ONLY — safe to delete at any time
```

Filenames use ISO-8601 with `:` replaced by `-`, so they sort lexically and are portable.

### The index

At boot, scan `reports/**`, parse frontmatter only, hold it in memory, update in place on write.
`index.json` is an **mtime-keyed cache** so a restart re-parses only changed files. The test for
whether something is a cache rather than a database is that deleting it must always be safe. It is.

Bodies are read lazily, per request, when the viewer asks for one. Nothing else ever reads a body —
findings are no longer extracted from prose
([ARCHITECTURE.md §1.4 G](ARCHITECTURE.md#g-deliberately-dropped)).

### Frontmatter is the assay record

The full shape is in [MVP.md §5](MVP.md#5-contracts). Three fields are new relative to phase 0 and
all three exist because the scheduler needs them: `try_n`, `trigger`, and the `bench` / `browser` /
`lease_until` triple. They are additive — the frontmatter type already preserves unknown keys, so
files written by phase 0 stay readable.

### Writes

- **Report files** are written first, then the index updates. Files are never modified after
  creation.
- **A claim** is a report file written with `status: running`, `try_n`, and `lease_until`. That is
  what makes a claim crash-safe: the lease is on disk, and a tick that finds an expired one
  reclaims it. It is also why `finished_at` is null until the run completes.
- **`alerts.json`** is mutable: write a temp file and `rename()`, atomic on the same filesystem.
- **`events.jsonl`** is append-only with `O_APPEND`; a partial trailing line is skipped on read.

### What this costs, honestly

- **Boot scan is linear.** Fine at ~7k files, not fine at 100k. The mtime cache pushes that years
  out; the fix when it arrives is to add an index, not to rewrite.
- **Single writer.** One process, one scheduler. Never run two replicas — there is no lock outside
  the process, and two schedulers would double-claim.
- **No cross-entity atomicity.** Writing a report and appending its event are two operations.
  Report first; the log is replay-tolerant.

---

## 5. The scheduler — porting `Pick next target` and `Record result`

Closes A1–A4, B1–B9, C1–C2, E1, E5–E7. This is the densest part of the port and the part where a
subtle divergence is expensive, so the two Code nodes' comments are worth reading before writing
any of it — they document decisions that are not obvious from the code.

### One tick

```
1  refresh the subject registry (GitHub contents; DEFAULT_APPS as cold-start fallback)   B1
2  reclaim expired leases: any running assay older than LEASE_MIN is released            B3
3  if a subject is still validly claimed → log the tick and stop (single-flight)         B8
4  if the last finish is < COOLDOWN_MIN ago → log the tick and stop                      B5
5  build the eligible set from the index, per leg:                                       B4
      never assayed                                        → eligible
      last verdict older than FRESH_DAYS                    → eligible
      last assay errored and try_n < MAX_TRIES              → eligible
      parked (try_n >= MAX_TRIES) and parked >= STUCK_DAYS  → eligible, try_n reset
      functional leg and the bench pool is unhealthy        → NOT eligible               D7
6  pick the stalest eligible subject; forced lists jump the queue                        A3
7  claim it: write status=running, try_n, lease_until — do NOT stamp last-run            C1,C2
8  hand (subject, leg, bench, browser) to the runner
9  record the outcome                                                                    E1
```

Step 5 is a query over the in-memory index. That is the whole reason the "no queue, re-derive every
tick" property (B9) survives the move: it was expensive in n8n because it meant re-parsing a
document, and it is nearly free here.

### The constants live in `config.yaml`

`FRESH_DAYS=7`, `STUCK_DAYS=7`, `LEASE_MIN=120`, `COOLDOWN_MIN=55`, `MAX_TRIES=3`. Seeded on first
boot with the loop's current values so that behaviour is identical on day one, then tunable without
a deploy. Do not hardcode them; the whole point of moving them out of a Code node is that they stop
being a code change.

### Recording — the three rules that must not drift

These are carried over verbatim from `Record result`, and each one is a comment in the original
because each one was learned the hard way.

1. **An infra condition restores the row and burns nothing.** `agent_busy`,
   `bench_unavailable`, `browser_unavailable` → `status: blocked`, `blocked_reason` set,
   `try_n` unchanged, last-run untouched, no verdict. Rows E5 and D7, and
   [ARCHITECTURE.md principle 5](ARCHITECTURE.md#3-design-principles). This is the one place the
   principle can be enforced.
2. **Last-run is stamped on completion, including errors.** So a failing subject goes to the back
   of the backlog and every subject gets one attempt before any gets a second. Row E7. The try
   counter is what parks it, not the ordering.
3. **The headline is authoritative.** `verdict`, `top_severity` and `risk_score` come from the
   report's own `**VERDICT: … · risk_score N**` line, parsed once. Row E4 and
   [ARCHITECTURE.md §6.2](ARCHITECTURE.md#62-risk-and-severity-come-from-the-headline). Nothing
   derives them from prose; a parse failure is an error, never a silent `compliant`.

### Triggers

| Row | Trigger | Behaviour |
| --- | --- | --- |
| A1 | in-process hourly timer | a normal tick |
| A2 | `POST /api/v1/assays` with a token | queue one named subject/leg immediately |
| A3 | the same endpoint with a list | forced run, bypasses freshness and cooldown |
| A4 | the re-assay button | the same endpoint, from the UI |

The n8n `Weekly QA webhook` and the audit's `Webhook (programmatic)` both collapse into A2. There
is no separate ingest contract in the target state — the runner is in-process, so nothing external
posts a result. A temporary ingest endpoint exists only during M2, to watch the still-running n8n
loop before the scheduler takes over.

---

## 6. The runner

Closes D1–D6 and E4.

### The agent call

```
POST http://beacon-backend:9300/mcp        JSON-RPC over SSE, one call
  → claude-code tool, prompt assembled from protocols/<section>.md
  ← the report markdown, headline included
```

`tools/mcp.ts` is already the right client — beacon is stateless streamable-HTTP, one POST per
call, response framed as a single SSE `data:` line. Promote it to `src/server/services/mcp.ts`.

The Telegram and Discord tool names for §8 must be resolved at implementation time via beacon's
`server_doc` for `telegram-mcp` / `discord-mcp` — do not guess them, and do not copy whatever
string the n8n nodes use without checking it still exists.

### Busy handling is not optional and does not go away

`AppStore PR Review` stays in n8n and calls **the same** Claude Code endpoint
([ARCHITECTURE.md §5.3](ARCHITECTURE.md#53-the-agent-stays-shared--the-busy-retry-must-be-ported-not-deleted)).
Touchstone therefore faces contention it does not control:

```
call → 409 or a busy marker in the response
     → wait (configurable, default matching the n8n Wait node)
     → call once more
     → still busy → status=blocked, blocked_reason=agent_busy, try_n unchanged
```

Rows D4 and D5. An earlier draft said an in-process queue makes this unnecessary. It does not.

### The browser

One `browser-mcp` container per functional worker, leased with the bench as a pair. Configuration
mirrors Newsdesk's sidecar — `shm_size: 2gb`, `MCP_PORT: 9746`, `IDLE_TTL_MS`, `PAGE_COLLECTOR=on`,
`PAGE_TTL_MS`, nothing exposed, reachable only from the backend on `pcs` — with one divergence:

**No profile volume.** The profile is discarded between assays. The functional protocol asks
whether the app has an auth gate, and a session cookie surviving from a previous assay makes an
unprotected app look protected — a false pass on the check that catches auth bypass. `browser.ts`
asserts the profile is empty at lease time rather than trusting the container to have been reaped.

Image floor is **1.1.5**, not `latest`: the tab registry (`/api/pages`), `hover`, and the per-tab
screencast all arrive in that release, and the shared box-wide `browsermcp` predates them.

### Bench preflight

```
POST https://local-auth-<bench>/api/firstfactor   { username, password }
expect 200 · treat 401 as auth failure · treat timeout/5xx as unreachable
```

Runs on a timer (default 5 min) and again immediately before any functional claim. Credentials come
from `config.yaml` in the data dir, never from the repo. On failure, open or refresh an alert keyed
`bench.auth` or `bench.unreachable`, and hold the functional queue; on success resolve it and emit
the recovery notification. Row D7 — the defect of record.

---

## 7. Events and alerts

The distinction is the same one that turned one bench outage into 49 identical notifications:

- **An event is point-in-time.** Every tick, claim, dispatch, result, retry, block and probe. It is
  appended and never modified.
- **An alert is stateful and deduplicated by key.** `bench.auth`, `bench.unreachable`,
  `agent.unavailable`, `browser.unavailable`. A two-day outage is one row that refreshes, not 49.
  It auto-resolves when its probe succeeds, and the resolution is itself worth pushing.

There is no ack, no mute and no impact accounting — dropped, because n8n has no equivalent and
because a mute is speculative until the alert list is actually noisy.

**Two rules on every event row**, copied from Newsdesk because they are what makes a log readable:

- `message` is one sentence a human reads. No ids, no interpolated error strings, no JSON.
- `detail` is the technical payload, rendered only on `warn` and `error`.

Splicing an upstream error into `message` collapses the two and is the single thing that makes an
event log useless.

---

## 8. Notification

Closes F1–F5. Three layers, in strict order of trust.

| Layer | Carries | Fails how |
| --- | --- | --- |
| **1. the event log** | everything | it does not — it is a local append |
| **2. Beacon outlets** | tick summary, errors, results, run-log (F1–F4) | best-effort; log and move on |
| **3. web push** | alert opened/resolved, assay failed after retry | best-effort; a missed push is still a row |

`notify.ts` maps `(class, kind) → outlets` from the routing table in
[UX.md §2.3](UX.md#23-activity--the-log-alerts-and-the-environment), then calls Beacon over MCP —
the same path n8n uses today for the Talk room, so Touchstone holds no Telegram or Discord
credentials.

Delivery must never fail a tick or an assay: log it, mark the event undelivered, move on. **Layer 1
must render with layers 2 and 3 broken** — that is [ARCHITECTURE.md principle 7](ARCHITECTURE.md#3-design-principles),
and it is why the Activity page reads a file rather than a delivery receipt.

---

## 9. Configuration

Env, following the `NEWSDESK_*` convention:

```
TOUCHSTONE_DATA_DIR=/data
TOUCHSTONE_PORT=8080
TOUCHSTONE_PUBLIC_URL=https://touchstone-${APP_DOMAIN}
TOUCHSTONE_TRUSTED_GATE=touchstone
TOUCHSTONE_API_TOKEN=...
TOUCHSTONE_BEACON_URL=http://beacon-backend:9300/mcp
TOUCHSTONE_MCP_TOKEN=...
TZ
```

Everything else lives in `config.yaml`, seeded on first boot into the data dir: the five scheduling
constants, bench hostnames and credentials, the browser pool, notification routing, and subject
overrides. Secrets stay out of the repo and out of the compose file.

Seeding on first boot is a real requirement, not a nicety — phase 0's `config.ts` only *reads* the
file and falls back to defaults, which is fine when nothing needs credentials and wrong the moment
the bench prober exists.

---

## 10. Packaging

Copy the Newsdesk compose and change the names. Four services, per
[ARCHITECTURE.md §8](ARCHITECTURE.md#8-packaging):

```
touchstone            AppShield sidecar, the only public surface, Caddy labels here
touchstone-backend    no labels, pcs only, user 1000:1000, one data volume
touchstone-mcp        beaconify sidecar (optional) — admin surface for agents
touchstone-browser-1  browser-mcp:1.1.5, no ports, no profile volume
touchstone-browser-2  …one per functional worker
```

`name` == `container_name` == `hostname` == `touchstone`; `pre-install-cmd` creating and chowning
`/DATA/AppData/$AppID/data`.

Two notes:

- Reconcile the Newsdesk compose drift first — the running `newsdesk-browser` is not in the compose
  file on disk. Copy from the *running* stack, not the stale file.
- Browser containers get `mem_limit: 2g` each. Two of them on a box that also runs the store is a
  real budget question — [ARCHITECTURE.md §10](ARCHITECTURE.md#10-open-questions), open question 3.

---

## 11. Testing

Unit tests where the logic is subtle rather than everywhere.

**The acceptance test for the port** is a replay: feed the 69-row corpus and its last-run data
through `eligibility.ts` and assert the chosen target matches what `Pick next target` chooses for
the same input, across all five constants. That is the test that says "this is the same scheduler."

**The acceptance test for the product** is the outage: import the 2026-08-05/06 window, run the
prober against a bench returning 401, and assert it produces **one** open alert, **zero** consumed
tries, and a functional queue that is paused while static assays keep completing. That is the exact
scenario the system exists to handle correctly, and it is the scenario the current n8n loop was
still failing on 2026-08-07.

Also worth a test each: lease reclaim after `LEASE_MIN`; parking after `MAX_TRIES` and release
after `STUCK_DAYS`; last-run stamped on error but not on `blocked`; headline parsing against a
fixture whose headline and prose disagree; alert dedup; frontmatter round-trip; and
reindex-after-cache-delete.

Commit the fixture reports. They are the only realistic corpus and they are full of the messy
formatting a parser has to survive.

---

## 12. Order of work

See [MVP.md §8](MVP.md#8-order-of-work). The short version: delete the out-of-scope code, get the
log and the prober in before the scheduler, retire the loop workflow at M4, retire the audit
workflow at M7.
