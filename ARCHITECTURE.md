# Touchstone — Design & Architecture

Status: **phase 0 built; P1 (truth) and P2 (eyes) built; the driver and runner designed.** Touchstone exists to replace two running n8n
workflows. This document is the argument for its shape, and its first section is the inventory of
what those workflows do — because that inventory *is* the specification. We cannot switch n8n off
until every row in §1.4 is covered.

The web UI is designed separately in [UX.md](UX.md); the *how* is in
[IMPLEMENTATION.md](IMPLEMENTATION.md). Facts about the running system were read off `yunderalabs`
on 2026-08-07 and are cited so they can be re-checked when they drift.

---

## 1. What we are replacing

### 1.1 Scope

Four workflows are active on `yunderalabs`. Two are in scope.

| Workflow | ID | Nodes | In scope |
| --- | --- | --- | --- |
| AppStore Continuous Store QA Loop | `uEmep2z22i5qv1OF` | 12 | ✅ **the driver** |
| AppStore App Audit | `QjzNu9yWZ5005J7m` | 19 | ✅ **the executor** |
| AppStore PR Review | `tOclUcWTrfQN6j1N` | 17 | ❌ out of scope — stays in n8n |
| AppStore release notes | `XJsURBnt7aIUhQVn` | — | ❌ out of scope — produces no assay |

**31 nodes in scope.** Both in-scope workflows call Claude Code at
`http://beacon-backend:9300/mcp` — and so does the out-of-scope PR Review. That shared endpoint is
load-bearing for §5.3.

### 1.2 The driver — `AppStore Continuous Store QA Loop`

An hourly tick derives a backlog from a Docmost table, picks one app, claims it, calls the audit,
records the result, and re-renders the table. State lives entirely in the wiki page: roll-up
**`Store QA — Results`**, slug `B5ZBicxRSn`, page id `019f373d-c73f-7cdd-b720-3d26da849dbe`,
read and written through Beacon via `docmost-mcp__get_page` / `update_page`.

```
Schedule (hourly) ─┐
Weekly QA webhook ─┼─▶ Pick next target ─┬─▶ Log tick
Run weekly QA form ┘                     └─▶ Audit? ─▶ Mark in-progress ─▶ Execute App Audit
                                                                              │
                          Notify App Audit room ◀─┬─ Errored? ◀─ Record result ┘
                          Notify Agent Logs   ◀───┘
```

Its constants, all in `Pick next target`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `FRESH_DAYS` | 7 | a verdict older than this makes the subject eligible again |
| `STUCK_DAYS` | 7 | how long a subject that exhausted its tries is parked |
| `LEASE_MIN` | 120 | an in-progress claim expires after this |
| `COOLDOWN_MIN` | 55 | minimum gap between finishing one assay and starting the next |
| `MAX_TRIES` | 3 | consecutive errored attempts before parking |

### 1.3 The executor — `AppStore App Audit`

Three entry points converge on one prompt, one agent call, and one published report — with a
single-retry backoff when the agent is busy.

```
Audit an app (form) ─┐
Webhook (programmatic)┼─▶ Build prompt ─▶ Call Claude Code ─▶ Extract LLM response
Called by sweep ─────┘                                              │
                                                          Agent returned error?
                                                          ├─ no ──▶ Publish to Docmost ─▶ Notify room ─▶ run-log ─▶ Return
                                                          └─ yes ─▶ Agent busy? ─┬─ yes ─▶ Wait ─▶ retry ─▶ Retry still failed?
                                                                                 └─ no ──▶ Notify error ─▶ Return error
```

### 1.4 Capability inventory and parity matrix

This is the checklist. **n8n cannot be switched off until every ✅-target row is covered.**

Legend — ✅ covered · ◑ partial · ⬜ not started · ✂ deliberately dropped

#### A. Triggering

| # | Capability | n8n | Touchstone |
| --- | --- | --- | --- |
| A1 | Hourly tick | `Schedule (hourly)` | ✅ `Scheduler.start`, `tick_min` — dry-run until armed |
| A2 | Programmatic kick | webhook `POST /weekly-store-qa` | ✅ `POST /schedule/tick` |
| A3 | Forced run of a named app list, bypassing freshness | form trigger, `apps` CSV | ✅ `POST /schedule/tick {forced:[…]}` |
| A4 | Audit entry points (form, webhook, sub-workflow) | 3 triggers on the audit | ✅ `POST /assays` — the hand-run path, and the scheduler dispatch |

#### B. Target selection and scheduling policy — `Pick next target`, 9,374 chars

| # | Capability | n8n | Touchstone |
| --- | --- | --- | --- |
| B1 | Subject registry | `api.github` contents on `Apps/`; `DEFAULT_APPS` (55) cold-start fallback | ✅ `SubjectRegistry` — GitHub `Apps/`, `DEFAULT_APPS` cold start |
| B2 | Read current state | `get_page` + a six-capture-group row regex | ✅ superseded — the index reads frontmatter |
| B3 | Lease reclaim | `LEASE_MIN=120`, expired claim releases the row | ✅ burns the try; a claim on a dropped subject is released too |
| B4 | Eligibility / backlog | stale-or-never at `FRESH_DAYS=7`; errored retried; stuck retried after `STUCK_DAYS=7` | ✅ |
| B5 | Cooldown | `COOLDOWN_MIN=55` since the last finish | ✅ anchored on n8n s own finish time during shadow mode |
| B6 | Try accounting | `MAX_TRIES=3` | ✅ in `schedule.json`, not `AssayMeta` — see §5.1 |
| B7 | Parking | `stuck after 3 tries`, released after `STUCK_DAYS` | ✅ |
| B8 | Single-flight | one in-progress app at a time | ✅ one claim, and it is what blocks the next tick |
| B9 | Re-derive the backlog every tick — **no queue** | by construction | ✅ by construction, as n8n does |

#### C. Claim — `Mark in-progress`

| # | Capability | n8n | Touchstone |
| --- | --- | --- | --- |
| C1 | Write the claim | `⏳ in progress · try N · since T` | ✅ `openClaim`, only when armed |
| C2 | **Do not** stamp last-run at claim time | commented, deliberate | ✅ asserted by test |

#### D. Execution — the runner

| # | Capability | n8n | Touchstone |
| --- | --- | --- | --- |
| D1 | Prompt assembly from the protocol | `Build prompt` | ✅ `runner/prompt.ts`. Byte-identical to the n8n node **when given the default store** — `repo`, `ref` and `apps_path` became parameters on 2026-08-20 (R10), and `prompt.test.ts` pins the identity. The node's own `Yundera/AppStore`, `main` and `Apps` were wrong for every store but the first, and wrong silently |
| D2 | Call the agent | `POST http://beacon-backend:9300/mcp` | ✅ `callAgent`, direct or through a Beacon aggregator |
| D3 | Parse the agent response | `Extract LLM response` | ✅ `classify` — the four error classes reproduced branch for branch |
| D4 | Agent-busy (409) detection | `Agent busy (retriable)?` | ✅ text-level and HTTP-level reach the same branch |
| D5 | Backoff and one retry | `Wait` → `Call Claude Code (retry)` → `Retry still failed?` | ✅ one retry, then the subject is returned untouched |
| D6 | A browser to drive the functional leg | shared box-wide `browsermcp` — **contended, see §2.4** | ✅ own sidecar, leased with the bench, ephemeral profile — §5.4. **Not yet exercised end to end:** the agent and the sidecar have to share a network, which is the deploy step |
| D7 | Bench preflight before claiming | **absent — this is the defect of record, §2.3** | ✅ the gate is in the policy; `leasable()` feeds it |
| D8 | Only claim an instance with **> 1h** of runway and not mid-cleanup | inside `Build prompt`, so it never reached this matrix | ✅ `BenchProber.leasable()`, §5.4 |

#### E. Recording — `Record result`

| # | Capability | n8n | Touchstone |
| --- | --- | --- | --- |
| E1 | Accept a result | `Record result` code node | ✅ `Scheduler.record`, called by the dispatch and by `POST /assays` |
| E2 | Store the verdict | one wiki row, overwritten | ✅ frontmatter on a file |
| E3 | Store the report | `Publish to Docmost`, one page per app | ✅ markdown on disk |
| E4 | Risk score and severity tier | parsed from the agent's headline | ✅ from the assay's own headline, per principle 3 |
| E5 | Agent-busy restores the row, burns no try, stamps no last-run | commented, deliberate | ✅ |
| E6 | Park after `MAX_TRIES` | `gaveUp` branch | ✅ |
| E7 | Last-run stamped on completion including errors | deliberate — fair round-robin | ✅ |
| E8 | Render the roll-up for humans | rebuild 69 rows + legend + loop status into a page | ✅ the Overview page |

#### F. Notification

| # | Capability | n8n | Touchstone |
| --- | --- | --- | --- |
| F1 | Per-tick log | `Log tick` → `POST notify-hub` | ✅ `TICK_*` / `CLAIM_*`, every tick |
| F2 | Error notification | `Notify Agent Logs and Error`, `Notify error to Hub` | ✅ `ASSAY_FAILED` / `AGENT_UNAUTHENTICATED`, in the log and on push |
| F3 | Success notification | `Notify App Audit room` → Beacon MCP | ✅ `ASSAY_COMPLETED` |
| F4 | Per-run audit log | `Build audit run-log` → `Post run-log to Hub` | ✅ the event log is the run log |
| F5 | An in-app place to read all of the above | **none — you read n8n executions** | ✅ the Activity page — §5.5, the one addition |

**F1–F4 are satisfied in-app, not by re-posting.** Decided 2026-08-19: Touchstone notifies the way
Newsdesk does — the event log and web push — rather than fanning every tick and result back out to
the Telegram room (`-5438454538`) and `notify-hub` the way n8n does. The parity question these rows
ask is *does the operator find out*, and the answer is the Activity page and a push, which is
strictly more than n8n offers. `services/notify.ts` stays in the tree with `outlets: []`, so
restoring the room is a config line rather than a rewrite. **The consequence to accept: that
Telegram room goes quiet when n8n is switched off.**

#### G. Deliberately dropped

These were designed for Touchstone and are **not** capabilities of the workflows being replaced.
They are removed from the plan.

| Dropped | Was |
| --- | --- |
| ✂ Findings as rows, rule codes, `GROUP BY rule` | a findings table and a Findings page |
| ✂ `unverified` finding status, suspected-Critical queue | a standing work queue |
| ✂ Regression detection, `verdict.*` comparison events | the highest-signal event in the old design |
| ✂ History strip | per-subject glyph run |
| ✂ Standards page, rubric drift, `content_hash` | drift detection |
| ✂ PR-scoped assays, check API, `scope: pr-diff` | phase 3, the merge gate |
| ✂ Findings → pull requests | phase 4 |
| ✂ Incident ack / mute / impact accounting | a stateful incident engine |
| ✂ Generic `subject.kind`, pluggable tenants | a generic conformance product |

**Parity is complete as of 2026-08-19** — every row above is ✅. What that does *not* mean is
that everything has been proven against the live system: D6's sidecar is built, probed and
leased, but the agent driving *it* rather than the shared browser needs both on one network,
and that is the deploy the operator has reserved for themselves. Row by row the capability is
there; the last mile is a deployment, not a feature.

The rule is simple and it is why this section exists: **if n8n does not do it, it is not in the
plan.** There are **four sanctioned exceptions**, each asked for by the operator directly:

| # | Exception | Where |
| --- | --- | --- |
| 1 | The in-app notification panel — row F5 | §5.5 |
| 2 | The notification system built to Newsdesk's shape, PWA identity and error assistant included | §5.5 |
| 3 | Touchstone's own embedded browser sidecar, rather than the shared box-wide one | §5.4 |
| 4 | Docmost is exited entirely — reports are local files, nothing published, nothing read back | §5.6 |

Exceptions 2–4 were confirmed on 2026-08-19. Nothing else is added without the same explicit
decision.

---

## 2. Why replace it at all

Four defects, all observed on the running system. None of them is "the output is wrong" — the
audits themselves are good. They are all defects of *state management*.

### 2.1 The database is a wiki page

`Pick next target` fetches the roll-up markdown, parses rows with

```
/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/
```

then recovers structured state by pattern-matching prose *inside* those cells: `⏳` means claimed,
`⚠` means errored, `try (\d+)` is the retry counter, `since (\S+)` is the lease timestamp, `stuck`
is the parked flag. Emoji are load-bearing. It then re-renders all 69 rows and writes the page
back; `Record result` does the same in reverse.

It works. It is also a read-modify-write cycle over a document, with concurrency safety provided by
a 120-minute lease written in emoji, and no way to add a field without touching two regexes.

### 2.2 One assay conflates two independent verdicts

Static and functional are two protocol documents producing two leaf results, collapsed into one
headline. Because a mandatory functional phase that errors can never yield `compliant`, a bench
outage overrides a complete and correct static result. NextcloudMCP's report states its static
answer plainly — the best achievable outcome once the bench returns is `non-compliant · Minor` —
and still displays as `⚠️`.

### 2.3 Infra failure is recorded as subject failure

The demo pool began rejecting all credentials on 2026-08-05:

- `POST /api/firstfactor` → **401** on both `demostaging1.inojob.com` and `demostaging2.inojob.com`
  (Authelia), for the protocol's `demo`/`demodemo` **and** for `demo@yundera.com`/`Demo123!`
- the upstream Firebase IdP returns `auth/invalid-credential` for the same credentials
- the hosts are healthy — static assets and `/api/state` return 200, the login UI renders
- the management board still reports `✅ Ready`, so **the board does not detect this failure mode**

The loop has no preflight (row D7), so it kept claiming targets and burning retry budget. On
2026-08-06 the tally was ✅1 ⛔19 ⚠️49 with 12 apps parked as stuck. **Twenty-four hours later, on
2026-08-07, it was ✅0 ⛔15 ⚠️54 with 13 parked** — the loop audited four more apps into the errored
column that day. The failure is not historical; it compounds hourly.

`agent-busy` is already handled correctly — a 409 from the shared agent restores the row untouched
and burns no try, and the code says so in a comment. **The bench is the same class of condition and
is not handled at all.** Generalising that one rule is most of the value of this project.

### 2.4 The browser is shared, and it is contended

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

1. **Capability parity first.** §1.4 is the specification. Anything not on it is not built.
2. **The report folder is the archive of record; the index is disposable.** Reports are markdown
   files with self-describing frontmatter; the index over them is in memory and cached, and
   deleting the cache is always safe. There is no database. Docmost stops being storage.
3. **The agent's headline is authoritative.** The verdict, tier and risk score come from what the
   assay declared, parsed once. Nothing re-derives them from prose.
4. **Sections are independent, and the set of them is data.** One unavailable resource costs
   exactly the sections that declared they need it; the rest of the run proceeds and each blocked
   section is recorded on its own. A section is a leaf protocol file — `data/protocols/<id>.md` —
   so adding one is an edit to `data/`, not to the code. (Until 2026-08-20 this read "legs are
   independent" and there were exactly two, `static` and `functional`, hard-coded in the type
   system and branched on through a `depth: static | full` parameter. Both are gone: `section` is
   an open string, and a run always attempts everything the protocol declares.)
5. **No infra condition consumes a subject's retry budget or produces a verdict about the
   subject.** Generalised from the existing `agent-busy` handling to benches, browsers and the
   agent alike.
6. **Every assay records which version of the standard judged it.** A verdict without a rubric
   version is not durable.
7. **The app stays diagnosable with every outbound port broken.** The in-app log is authoritative;
   push and Beacon outlets are best-effort. Borrowed from Newsdesk, where it is invariant 7.

### 3.1 What the old design got right and must survive

**There is no queue.** The backlog is re-derived from last-run on every tick, so it cannot drift
out of sync with reality. A subject is either idle, in progress, or carrying a verdict. Moving the
scheduler in-process makes this *cheaper*, because eligibility becomes a query over the index
rather than a regex over a document — but the property must be preserved deliberately, not
accidentally. Row B9.

**Last-run is stamped on completion, not on claim.** Deliberately, so a failing subject goes to the
back of the backlog and every subject gets one attempt before any subject gets a second. Rows C2
and E7.

---

## 4. Domain model

The *shape* of the data, not a database schema. Nothing is relational and there is no database.

```
-- WHAT IS JUDGED ---------------------------------------------------------
subject
  origin, name, source_ref, enabled
  -- identity is `<origin>~<name>`; two stores may both ship a `FileBrowser`
  -- derived from each origin's GitHub contents API; only overrides are authored

origin     -- config.yaml `origins[]`; the store a subject comes from
  id, repo, ref, apps_path, seed
  -- one repo at one ref. NOT a tenant: every origin is judged by the same protocol files at
  --   the same version (§1.4 G still drops `subject.kind` and pluggable tenants)

-- WHAT IT IS JUDGED AGAINST ---------------------------------------------
protocol   -- data/protocols/<id>.md; a `leaf` IS a section definition
  id, name, version, kind, order, requires, phases, report_headings, requirements
  -- kind      ∈ orchestrator | leaf
  -- order     decides report order and which section carries the run's headline verdict
  -- requires  the capabilities it cannot run without — bench, browser. This replaced `depth`.
  -- phases    its fixed steps, if it has any; the UI track and the prompt both read this list

standard   -- not a separate entity: a section's standard IS its protocol file
  name, version
  -- taken from the leaf's own frontmatter, which the editor bumps on every save. There was
  --   a `data/standards/*.yaml` override until 2026-08-20; it could only ever disagree with
  --   the rubric it claimed to version, and did.

-- WHAT HAPPENED ---------------------------------------------------------
assay                        -- the frontmatter of a report file IS this record
  subject, origin, section, standard, standard_version,
  -- `subject` is the bare name; `origin` is filled in on read when the file predates it
  -- `leg` on any file written before 2026-08-20; filled into `section` on read
  status, verdict, top_severity, risk_score,
  try_n, trigger, bench, browser, lease_until,
  subject_ref, commit, images, report body,
  started_at, finished_at, blocked_reason
  -- status  ∈ queued | running | done | blocked
  -- verdict ∈ compliant | non-compliant | errored | deferred  (null unless done)
  -- blocked_reason distinguishes infra from subject; drives retry accounting

-- WHAT IT RUNS ON -------------------------------------------------------
bench      name, url, status, healthy_at, health_detail, lease_assay, lease_until
browser    name, endpoint, status, lease_assay, lease_until

-- WHAT IT TELLS YOU ------------------------------------------------------
event      -- append-only, authoritative, the in-app log
  ts, level, code, category, subject, message, detail
  -- level ∈ debug | info | warn | error

alert      -- a deduplicated environment condition; one outage is ONE row
  key, state, title, detail, opened_at, last_seen_at, resolved_at
  -- key ∈ bench.auth | bench.unreachable | agent.unavailable | browser.unavailable
  -- state ∈ open | resolved

-- DERIVED ---------------------------------------------------------------
hallmark   -- view: the latest done assay per (subject, section)
```

There is no `finding` entity and no `rule` entity. A finding is prose inside the report body, as
it is today. §1.4 G explains why.

### Where each part lives

| Entity | Storage |
| --- | --- |
| `standard` | the protocol file itself — a section's name and version are its own rubric's |
| `protocol` | `protocols/*.md` — the rubric, the definition of the sections, and the version every assay records |
| `subject` | each origin's GitHub contents API + overrides in `config.yaml` |
| `origin` | `config.yaml` `origins[]` — never discovered, and the default one is re-added if dropped |
| `assay` | **frontmatter of the report file** — the record and the artefact are one thing |
| `bench`, `browser` | `state/benches.json`, `state/browsers.json` — re-probed at boot anyway |
| `event` | `state/events.jsonl` — append-only |
| `alert` | `state/alerts.json` — small, mutable, atomically rewritten |
| `hallmark` | computed from the in-memory index |

Three of these are configuration, one is the report files, two are tiny runtime state, one is a
log. That is the argument for having no database.

### Reports accumulate; nothing reads history

Writing a timestamped file per assay means old reports stay on disk. That is a property of files,
not a feature: **nothing in the product reads more than the latest assay per `(subject, section)`.**
There is no history view and no regression detection — §1.4 G. The old files cost nothing, are
greppable, and are there if a question is ever asked of them.

---

## 5. Components

```
                                Touchstone                          outlets
                          ┌───────────────────────┐          ┌─────────────┐
   GitHub contents ──────▶│  scheduler            │─ MCP ───▶│  Telegram   │
   (subject registry)     │   eligibility         │          │  Discord    │
                          │   cooldown / lease    │          │  Talk room  │
   webhook / form ───────▶│   tries / parking     │          └─────────────┘
   (forced run)           │           ▼           │          ┌─────────────┐
                          │  runner               │─ HTTP ──▶│ Claude Code │
                          │   prompt · agent call │          │ (shared)    │
                          │   busy backoff        │          └─────────────┘
                          │           ▼           │          ┌─────────────┐
                          │  bench + browser      │─ CDP ───▶│ browser ×N  │
                          │   preflight + lease   │          │ (own, §5.4) │
                          │           ▼           │          └─────────────┘
                          │  files + index        │─ HTTPS ─▶┌─────────────┐
                          │  events + alerts      │          │ benches ×2  │
                          └───────────────────────┘          └─────────────┘
```

### 5.1 Scheduler

Owns everything `Pick next target` and `Record result` own today: registry refresh, eligibility by
freshness, cooldown, lease claim and reclaim, try accounting, parking, and the completion stamp.
Runs on a timer in-process. Rows A1–A4, B1–B9, C1–C2, E1–E7.

There is no per-section policy and no per-section backlog: the scheduler picks a *subject*, and
the runner decides which sections that subject's audit can actually run. A subject is as fresh as
its most recently completed section (`ReportIndex.sections()`), which is why a protocol gaining a
section does not silently make every subject look stale.

### 5.2 Runner

Rows D1–D5. Prompt assembly from the standard, the agent call, response extraction, and the
busy-retry. A worker pool replaces `Execute App Audit`:

- **static workers** need no bench and no browser, so they scale wide
- **functional workers** are bounded by the bench pool — two demo instances means two workers

That bound is a property of the resource, not a constant, and it falls out of leasing.

### 5.3 The agent stays shared — the busy retry must be ported, not deleted

An earlier draft of this document claimed that owning a real queue makes the 409-busy retry dance
disappear. **That is wrong and the correction matters.** `AppStore PR Review` stays in n8n and
calls the *same* `http://beacon-backend:9300/mcp` endpoint. A PR can arrive at any moment and take
the agent. Touchstone therefore faces external contention it does not control, and rows D4/D5 have
to be reimplemented as-is rather than designed away. Principle 5 still covers the correctness half:
a 409 must never burn a try.

### 5.4 Bench and browser leasing

**The app probes the bench before claiming it** (row D7). A login preflight costs one request and
would have prevented every wasted assay since 2026-08-05. If the pool is unhealthy: pause the
functional queue, mark queued functional assays `blocked` with
`blocked_reason='bench_unavailable'` — which by principle 5 consumes no try — and open **one**
alert.

Two corrections were read off the live system on 2026-08-19, and both are now in
`services/bench.ts`.

**Benches are discovered, not configured.** An earlier draft had a hand-written `benches:` list in
`config.yaml`, which is the wrong shape: n8n's own prompt says *"Demo hosts are wiped daily […]
**never hardcode a host** — pick a Ready one off the board at runtime"*. That board
(`app.nasselle.com/demo/admin/manage`) is backed by a JSON API, `/demo/api/demos`, carrying exactly
the facts the rule needs — `isProcessing`, `lastCleanupSuccess`, `hoursUntilCleanup`. Touchstone
reads the API for the roster and probes each instance itself. The static list survives only as an
override for pinning a fixed box in a test. A discovery that comes back empty keeps the previous
roster: the API being unreadable is our blindness, not their outage.

**`POST /api/firstfactor` does not authenticate against these hosts, and the old probe scored it as
healthy.** It answers `302 → /nhl-auth/oidc/login`; the demo instances sit behind OIDC, not
Authelia's first factor. A probe that reads a redirect as a pass is a false green in the one module
that exists to prevent false greens. **The probe is now the login flow itself** — start at
`/nhl-auth/oidc/login?redirect=/`, follow every hop by hand with a scoped cookie jar, and count
only a final `200` as healthy. It needs no password (the demo IdP mints a session without one) but
it does need the jar: without cookies the flow redirects forever, which the probe reports as
`auth · the login never completes` rather than as a timeout.

**Row D8 — more than an hour of runway.** The same prompt requires an instance that is not
mid-cleanup and has *"more than 1 hour, so the daily cleanup cannot wipe the run mid-audit (a full
run includes the Phase G uninstall-then-reinstall)"*. That rule lived only inside the prompt, so it
never reached §1.4. It is `BenchProber.leasable()`, and it is deliberately distinct from
`poolUp`: a bench can be perfectly healthy and still be the wrong bench to start a forty-minute
assay on. An unknown countdown does not qualify while the pool API is the source — "we could not
read the clock" is not "there is time" — while a hand-configured bench, which has no clock to read,
is exempt.

**What both corrections found, the first time they ran.** `demostaging1` answered healthy with 2.6
hours left; `demostaging2` answered **HTTP 500 from the login gate** while the board called it
`✅ Ready · 18.6h remaining`. That is the 2026-08-05 failure mode, live, and it is why the board is
a second opinion displayed beside our own probe rather than a source of truth.

**A lease is `(bench, browser)` together.** One browser per functional worker, taken and released
with the bench. The page-stealing race in §2.4 then cannot occur, because no two assays share a
browser by construction.

#### The browser sidecar, copied from Newsdesk with one divergence

Confirmed in scope on 2026-08-19: Touchstone embeds its own `browser-mcp` in its stack, the way
[Newsdesk](/d/workspace/sandbox/Newsdesk) does in `deploy/docker-compose.yundera.yml`.

Newsdesk runs its own `browser-mcp` container rather than using the shared box-wide `browsermcp`,
for exactly the reason §2.4 describes — *"that browser is busy with other work, and a publish that
got its tab stolen mid-compose would be a post half-typed into someone else's page."* Touchstone
takes the same position and most of the same configuration:

| Setting | Newsdesk | Touchstone |
| --- | --- | --- |
| image | `ghcr.io/worph/browser-mcp:1.1.5` | same floor — the tab registry (`/api/pages`), `hover`, and the per-tab screencast all arrive in 1.1.5 |
| `shm_size` | `2gb` | same — Chrome crashes on the 64M default |
| `MCP_PORT` | `9746` | same |
| `IDLE_TTL_MS` | `900000` | same — reap Chrome between runs |
| `PAGE_COLLECTOR` / `PAGE_TTL_MS` | `on` / `1800000` | same — sweep tabs nobody owns |
| exposure | none; reachable only from the backend on `pcs` | same — this is an unauthenticated browser-control API |
| **profile volume** | **persistent** `/data/chrome-profile` | **none — ephemeral, discarded between assays** |

That last row is the deliberate divergence. A persistent profile is right for Newsdesk: a stringer
reading a source benefits from a warm, logged-in session. For Touchstone it is unsafe. The
functional protocol asks whether the app has an auth gate; a session cookie surviving from a
previous assay makes an unprotected app look protected — a **false pass on the check that catches
auth bypass**. The agents already work around this by hand: the Prowlarr run used "three isolated
browser contexts" to rule out a stale `flow_id`. So: fresh context per assay, profile discarded
between assays, and any state that must survive (bench credentials) comes from configuration.

`N` browser containers for `N` functional workers, named `touchstone-browser-1…N`.

### 5.5 Notification — the one addition beyond parity

n8n posts to `notify-hub` and to a Talk room, and if you want to know what happened you open the
n8n executions list. Rows F1–F4 are parity. **F5 is not:** an in-app panel where a person can see
what the loop did, what failed, and why, without opening n8n at all.

Three layers, in the Newsdesk shape:

1. **The event log is authoritative.** Append-only, in the data dir, shown on the Activity page.
   Every tick, claim, dispatch, result, retry, block and probe writes a row. Newsdesk's two rules
   are worth copying verbatim: `message` is one sentence a human reads — no ids, no interpolated
   error strings, no JSON — and `detail` carries the technical payload, shown only on `warn` and
   `error`. Splicing an upstream error into `message` is the one thing that makes a log unreadable.
2. **Web push** (VAPID, Android and desktop; iOS explicitly out of scope) for the things worth
   interrupting someone over: an alert opening or resolving, and an assay that failed after its
   retry. Best-effort — a push that does not send is still a row in the log.
3. **Beacon MCP outlets** — Telegram, Discord, the Talk room — reached by service name on `pcs`,
   so Touchstone holds no third-party credentials. **Shipped unconfigured, and that is the
   decision** (2026-08-19): layers 1 and 2 are how the operator finds out, exactly as at Newsdesk,
   where MCP outlets carry *published work* and never operator notification. Rows F1–F4 are
   satisfied by the log and the push; this layer exists so that restoring the Telegram room is a
   config line.

Layer 1 must work when layers 2 and 3 are down. That is principle 7, and it is why the log is a
file rather than a notification that was already sent.

#### What is still missing against Newsdesk

The three layers above are built (P2). Measured against `/d/workspace/sandbox/Newsdesk`, which the
operator named as the model on 2026-08-19, three things are not:

- **PWA identity, and it is the load-bearing one.** Newsdesk ships a `manifest.webmanifest` and
  icons *and* gives them an anonymous route through the AppShield sidecar — ordered Caddy `handle`
  blocks send `/manifest.webmanifest` and `/icon*` straight to the backend, first match wins.
  Without that bypass Chrome's WebAPK minting server, which fetches those URLs from the public
  internet carrying no session of ours, gets a 302 to the OIDC login; minting fails and Android
  installs a bookmark shortcut with a Chrome badge instead of an app. Push on a phone is only as
  good as this. Lands with packaging, §8.
- **The error assistant.** Newsdesk marks selected codes `assistable: true` and offers a remedy
  button on those rows only, logging its own work as `REMEDY_APPLIED` / `ASSIST_FAILED` in the log
  it is fixing. Its restraint matters as much as the feature: `PUSH_NO_DEVICES` is a warn with
  nothing to remedy, and a button there teaches people to ignore the button where it counts.
  Touchstone's candidates are `BENCH_AUTH_FAILED`, `NOTIFY_FAILED`, `PUSH_UNCONFIGURED` and, once
  the runner exists, `AGENT_*`.
- **Deep-linked pushes.** Newsdesk's notifications say how many of their kind are waiting and link
  to the one that fired. Touchstone's push targets are already the right narrow set; they need to
  land on the subject rather than the app root.

### 5.8 Requirements are recorded as they are settled

The agent calls back while it works. `POST /api/v1/mcp` exposes three tools and no more:

| tool | what it does |
| --- | --- |
| `list_requirements` | the canonical ids for this run's protocol |
| `record_requirement` | one requirement settled — id, verdict, severity, note |
| `record_phase` | one functional phase — A, C, D, E8, E9, E10, F, G |

**There is deliberately no `record_result`.** The moment an agent can post its own verdict the
gate — *any Critical is non-compliant unconditionally* — becomes advisory, and a run that says
`compliant` walks past the rubric. The agent judges each requirement; Touchstone computes the
outcome.

**Why incremental at all.** The whole result used to ride home in one JSON blob, and on
2026-08-19 that lost three complete audits to parse failures and would have lost everything
from any run that died partway. Recording as you go fixes both: each call is validated where
the agent can still be told what it got wrong, and a run interrupted at requirement 12 of 16
keeps twelve facts instead of none. It happened on the first live test — the blob failed to
parse and `verified: 16 of 16` survived it.

**`list_requirements` solves id drift at the source.** Left to free text an agent writes
`cpu_shares` on one run and `cpu_shares set on all services` on the next, and *which apps fail
this?* quietly stops working. The protocol names the ids; the agent maps to them. An id it does
not know is still recorded, marked `unlisted`, which is how the list gets corrected.

**Authentication is a run-scoped token**, minted at dispatch, passed as an argument on every
call, dead when the run ends. Not a header and not a shared secret: this is the one surface
that points inward, and an unauthenticated "record an audit result" endpoint is a way to forge
audit results. A stale agent still writing after we gave up is rejected and visible.

#### Coverage is not compliance

The assay stores both, and they answer different questions:

```yaml
coverage: { verified: 16, applicable: 16, passed: 14, failed: 2, unverified: 0, risk: 2 }
verdict: non-compliant
top_severity: minor
```

`14/16` is how much of the checklist got checked. The verdict is gated on **severity** — one
Critical outranks fifteen passes, and no count can express that. Merging them would be the
subtle mistake here. `risk` is summed from the declared items using the protocol's own weights,
and when it disagrees with the agent's declared `risk_score` both are kept and the divergence
recorded rather than smoothed away.

### 5.7 The protocol lives here now

`data/protocols/*.md`, one file per document, frontmatter carrying `id`, `name`, `version`,
`kind` and `requires_bench`. `GET /protocols`, `PUT /protocols/:id`, and a screen that edits
them.

Three properties that are not incidental:

- **The whole text is embedded in the prompt**, not fetched. That removes an entire class of
  failure — an audit can no longer error because a wiki was slow — and it is what makes the
  rubric editable at all.
- **Saving bumps the version.** Every assay records the standard and version it was graded
  against, so an edit that left the number alone would make two different rubrics
  indistinguishable in the archive.
- **`requires_bench` is where genericity starts.** "Static" and "functional" are currently an
  axis hardcoded through the whole system; expressed as a property of a protocol it is one
  step from being a property of a *requirement*, which is what the generic model needs.

The exported copies carried `imported_from: docmost:<slug>` until 2026-08-20; nothing read it,
the Protocol screen showed it, and it outlived the wiki. `ProtocolStore` still parses the field
for any future import — no protocol on disk sets it.

### 5.6 Reports and outlets

An assay writes one markdown file per section under `<data>/reports/<origin>/<subject>/<iso>-<section>.md`, frontmatter
carrying the structured verdict, body carrying the report verbatim. That file is the archive of
record: sortable, greppable, backed up with the rest of the data dir, readable without the app.

**Docmost is gone — done 2026-08-19.** Not "exited at M5", not "optional publisher": there is no
code left in Touchstone that reads or writes a wiki, and no configuration that names one. The
report file *is* the report, and the app renders it.

What went, and what it means:

- **`services/importer.ts`, `tools/import.ts`, `scheduler/adopt.ts` and `parseRollup` are
  deleted.** Nothing reads the roll-up, so nothing inherits n8n's scheduling state, and the
  scheduler's cooldown anchor is its own recorded finishes.
- **The protocol came with it, and that was the part nobody had noticed.** The rubric every
  verdict is measured against was three wiki pages the *agent* fetched at run time —
  `In2NAGjv0h`, `LPwfKYUVig`, `7HxjTwe63H` — while Touchstone held a slug and a version number.
  Freezing the wiki would have stranded it. It is now `data/protocols/*.md`, exported once,
  amended in place to drop its publish-to-wiki instructions, embedded in the prompt, and
  **editable from the app that enforces it** (§5.7).
- **`Store QA — Results` is simply left alone.** There is nothing to freeze: nothing points at
  it any more.

---

## 6. API

Small on purpose. There is no ingest endpoint in the target state, because the runner is
in-process. A temporary one exists only during the transitional milestones in
[MVP.md §8](MVP.md#8-order-of-work) — and note that nothing in n8n can call it without an edit to
n8n, which §9 explains.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/subjects` | registry + current hallmark, both legs |
| `GET` | `/api/v1/subjects/:name` | one subject, both legs, latest assay each |
| `GET` | `/api/v1/reports/:subject/:file` | the markdown file, rendered and raw. `:subject` is the key `<origin>~<name>`; a bare name still resolves |
| `POST` | `/api/v1/assays` | request an assay now (subject) — the re-assay button. No depth: a run covers every section |
| `GET` | `/api/v1/benches` | pool health, last probe |
| `GET` | `/api/v1/events` | the log feed, filterable by level and category |
| `GET` | `/api/v1/alerts` | open alerts for the Activity page |
| `GET` | `/api/v1/trials` | the trials run so far, newest first |
| `POST` | `/api/v1/trials` | audit a `repo@ref` without touching a hallmark — R11, §7 |
| `GET` | `/api/v1/trials/:slug` | one trial, beside what the subject currently carries |
| `POST` | `/api/v1/push/subscribe` | web-push subscription |

### 6.1 The subject registry

Refreshed from the GitHub contents API for `Yundera/AppStore/Apps` on a timer, with the loop's
existing 55-entry `DEFAULT_APPS` list retained only as a cold-start fallback. Row B1.

### 6.2 Risk and severity come from the headline

Assay reports declare their own verdict — `**VERDICT: NON-COMPLIANT · Critical · risk_score 232**`
— and `Record result` in n8n takes it at face value. Touchstone must do the same. The current
importer instead *derives* the tier from prose it extracts, and on eight of twenty non-compliant
subjects it derived something milder than the report's own headline, promoting four Critical apps
to `compliant`. Principle 3 exists because of that bug: parse the headline, trust it, and never let
a derived value override it.

### 6.3 Verdict algebra

Carried over unchanged, because the protocol already specifies it:

| Severity | Meaning |
| --- | --- |
| **Critical** | security or data loss — auth bypass, account takeover, privilege escalation, data erasure |
| **Major** | contract break — missing required asset or `rationale.md`, name-regex violation, `:latest` on the main image |
| **Minor** | one-liner — missing or mis-tiered `cpu_shares`, unpinned helper image, missing descriptions |

`risk_score = 100·Critical + 10·Major + 1·Minor`. The score ranks a backlog; the tier and the gates
decide the verdict. Gate precedence is unchanged: any Critical forces non-compliant; otherwise any
fail sets the tier; an errored mandatory rule outranks both and can never yield `compliant`.

The one change: where today an errored mandatory *functional* rule produces `errored` for the whole
assay, Touchstone scopes that to the functional assay and lets the static assay stand on its own.

---

## 7. What stays in n8n

After phase 2, nothing in the conformance loop. `AppStore PR Review` and `AppStore release notes`
keep their own triggers and are untouched. The hourly tick is **deleted** — it is scheduling
policy, not a source.

### Trials, and the line they do not cross — 2026-08-20

`POST /trials` audits an arbitrary `repo@ref` and files the result under `data/trials/`, where
the report index never looks (R11). It is **not** PR Review, and the distinction is the reason
it survives the scope rule above: PR Review is an *orchestrator* — it decides when to run,
applies GitHub labels, writes the PR comment and publishes. All of that stays in n8n. Touchstone
offers the executor it could call, and **nothing calls it** until somebody deliberately wires
n8n to. The endpoint simply exists.

Two properties keep it from leaking into the conformance loop, both structural rather than
rules to remember:

- **A separate root and a separate index.** The scheduler and the subject registry are never
  handed the trials index, so a trial cannot move a hallmark, cannot age a subject's freshness
  and cannot become a schedulable subject via `archived: () => store.subjects()`.
- **The same `Runner` instance.** It is single-flight process-wide and `RunLedger.live()`
  assumes one open run, so a trial and an audit cannot collide — a trial asked for during an
  audit gets a 409. A second runner would also have falsified the browser lease, whose safety
  rests on "there is one run at a time".

**Trials are static-only**, and that is a fact about how apps are installed rather than a
shortcoming: a bench installs from its own catalogue, which serves whatever store that instance
is configured with rather than the ref under trial. The functional section is recorded `blocked`
with reason `store_not_installable`. It is still not a statement about the subject, so §2.3's
rule holds — but it is a statement about the *trial's configuration* rather than about infra,
which is the one place that wording strains. Repointing a bench's catalogue at a custom store
URL is the follow-on that would lift it.

**Nothing a model can call may choose the ref.** The chat's `run_assay` keeps its single
property, constrained to a registry member. §6.2's reasoning about verdicts extends here:
repo+ref is the one input that would turn "audit an app" into "run `gh` against a URL of the
model's choosing", with the result read as data inside an audit prompt.

---

## 8. Packaging

Copied from Newsdesk's compose, which is a solved problem. Four services:

- **`touchstone`** — AppShield sidecar terminating OIDC/Authelia SSO, the only public surface
- **`touchstone-backend`** — no Caddy labels, reachable only on the internal `pcs` network
- **`touchstone-mcp`** — optional `beaconify` sidecar making the admin surface agent-callable
- **`touchstone-browser-1…N`** — the browser pool, §5.4, nothing exposed

`name` == `container_name` == `hostname` == **`touchstone`** — all three are load-bearing, since
AppShield builds its redirect URIs from `os.hostname()` and the auth-registrar attests the app name
via the container's PTR record. `user: 1000:1000`, on `pcs` so Beacon is reachable by service name,
a **trusted-gate** env naming the sidecar so users are not asked for a second login, and a
`pre-install-cmd` creating and chowning one data dir — so a backup of one path is the whole system.

Shipped as an AppStore app, so Touchstone assays the store it lives in.

One thing to reconcile first: the running `newsdesk-browser` container is **not present in**
`/DATA/AppData/newsdesk/docker-compose.yml`. Copy from the *running* stack, not the stale file.

---

## 9. Phases

| Phase | Deliverable | Retires |
| --- | --- | --- |
| **0** ✅ | report files, index, read API, Overview + Subject detail | Docmost as a *reader* |
| **1** | scheduler, registry, lease, tries, parking, bench preflight, events + alerts + push | **`AppStore Continuous Store QA Loop`** |
| **2** | runner, agent call, busy retry, browser sidecar, `(bench, browser)` leasing | **`AppStore App Audit`** |

Phase 1 can ship while the audit workflow still executes assays — Touchstone calls its
`Webhook (programmatic)` trigger. That is the seam that makes phase 2 a change of driver rather
than a big bang.

**The seam is weaker than this document assumed, read off the workflow on 2026-08-19.** It cannot
hand the result back:

- `Webhook (programmatic)` (`POST /webhook/app-audit`) declares **no `responseMode`**, so n8n
  defaults to `onReceived` and answers "workflow got started" the moment it is hit. An external
  caller gets nothing.
- The synchronous path is `Called by sweep`, an `executeWorkflowTrigger` with
  `inputSource: passthrough`. That is how the QA Loop gets its result today, and Touchstone,
  being outside n8n, cannot use it.
- `Return to caller` returns `{app_name, verdict, severity, risk_score, summary, title, url,
  published}` — **no `report_markdown`**. The body lives only in the `Extract LLM response` node
  output and in the page `Publish to Docmost` writes.

So result recovery during phase 1 is one of three, in order of preference:

1. **Keep the Docmost importer for that window and delete it at phase 2.** No n8n edits, code that
   already runs, 15-minute lag. This is the recommendation, and it is why §5.6 calls the importer
   transitional rather than gone.
2. `GET /api/v1/executions/{id}?includeData=true` on n8n's REST API, which *does* carry
   `report_markdown` from `Extract LLM response`. Exits Docmost a milestone earlier at the cost of
   throwaway code. Worth it only if phase 1 runs for months.
3. Changing the webhook's response mode, or having the audit POST to §6's temporary ingest
   endpoint. Both are edits to n8n, and the first holds an HTTP connection open for the length of
   an assay.

If a Docmost-dependent window is unacceptable, the honest alternative is **merging phases 1 and 2**
and skipping the webhook seam. The seam exists to de-risk, and it de-risks less than was thought.

### The bench preflight — done in n8n on 2026-08-19

This was carried for weeks as "twenty lines, worth doing this week". It is now done, and it was
never twenty lines, because the endpoint it was specified against does not authenticate anything:
`POST /api/firstfactor` answers `302 → /nhl-auth/oidc/login`, so the specified probe would have
reported all-clear through the entire outage. §5.4 has the correction.

**What the operator approved and what shipped**, the one sanctioned waiver of the no-n8n-edits
rule:

| Node | Workflow | Change |
| --- | --- | --- |
| `Pick next target` | QA Loop | reads `/demo/api/demos`, runs the real OIDC login flow against each candidate with more than an hour of runway, and emits `demo_host`. No instance passes → `action='idle'`, so the tick claims nothing and burns no try |
| `Mark in-progress` | QA Loop | forwards `demo_host` |
| `Build prompt` | App Audit | uses the supplied host verbatim when given one; the unchanged path now also tells the agent to confirm the login before using an instance |

It fails **open** on its own faults — pool API unreadable, no HTTP helper — because a broken
preflight must leave the loop as it was rather than halt it, and it says so in the tick log. It
fails **closed** on a definite answer: the API listed instances and none let us in.

**What it is worth.** The board reports `✅ Ready` for an instance whose login gate returns 500,
and the prompt's "pick the MOST Time Remaining" rule prefers exactly that instance. The agent has
been recovering by falling back on its own — the 12:00 run on 2026-08-19 recorded *"Host
demostaging1 (demostaging2 auth gateway 500)"* — so this was costing a wasted first attempt per
run rather than a failed audit. The preflight removes the improvisation, makes the fallback an
instruction rather than a hope, and adds the gate for the case where nothing is usable, which is
the 2026-08-05 shape.

It also moves n8n *toward* the D7/D8 gate Touchstone implements, so the shadow-mode diff in phase 1
gets more comparable, not less.

---

## 10. Open questions

1. **Bench provisioning.** Touchstone leases benches it does not control. Should it be able to
   request a fresh one, or is depending on an externally managed pool acceptable?
2. **Who owns the standard?** If the rubric lives in Docmost, Touchstone points at it. If it lives
   in the AppStore repo next to `CONTRIBUTING.md`, it versions with the thing it governs. The
   second is more principled; the first is what exists.
3. **Browser pool size.** Two benches implies two functional workers implies two browser
   containers, at 2 GB each. Is that the right ceiling on a box that also runs the store?
