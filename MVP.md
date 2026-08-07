# Touchstone — MVP-0

The first thing worth looking at. Scoped so it can be built in parallel and iterated on, not so it
is complete.

---

## 1. The goal, in one sentence

> **See the real conformance state of the AppStore in a web page, sourced from files, without
> opening Docmost.**

Read-only. No scheduling, no ingest, no notifications. It replaces the roll-up page as *the thing
you look at*, and it proves the model — files as the archive, an index in memory, findings as rows
— against real data before anything is built on top.

## 2. Acceptance test

MVP-0 is done when, on a laptop with no server access:

1. `yarn import` pulls the current roll-up and every linked report out of Docmost into
   `data/reports/**` as markdown with frontmatter.
2. `yarn dev` serves a page listing **69 subjects with two status columns**, sorted by risk, where
   the functional column reads `blocked` for the **58** that never got a bench.
3. Clicking **OpenClaw** shows its findings alongside its rendered report.
4. The Findings page shows **`cpu_shares` on reserved tier 10 → 9 subjects** (8 observed plus
   qBittorrent, named by another report and therefore `unverified`), discovered by query rather
   than by someone having read a report.

> Points 2 and 4 originally read 49 and 5 — the figures visible in the Docmost roll-up. The import
> found more of both, for reasons worth keeping: the roll-up's ⚠️ 49 counts *audits* that errored,
> but nine further subjects earned a `⛔ Critical` headline from static findings alone while their
> functional leg was equally bench-denied, so their blocked leg was never counted. That conflation
> of "we could not check" with "we checked" is the thing this product exists to fix, and it was
> hiding nine cases in the source data. The cpu_shares cluster is likewise larger than the one
> report that noticed it claimed.

Point 4 is the one that matters. It is a fact that exists today only as one sentence buried in one
report, and if the UI surfaces it on day one the whole premise is validated.

## 3. Scope

### In

| | Feature |
| --- | --- |
| 1 | Report files: write + read markdown with YAML frontmatter |
| 2 | In-memory index over `reports/**`, built at boot from frontmatter only |
| 3 | Docmost importer — one-shot, idempotent, re-runnable on a timer to stay fresh |
| 4 | Read API: subjects + hallmarks, subject history, report body, grouped findings |
| 5 | **Overview** — the two-column status table |
| 6 | **Subject detail** — findings list + rendered report + history strip |
| 7 | **Findings** — grouped by rule |

Feature 3 is what keeps MVP-0 *live* without touching n8n: the loop keeps publishing to Docmost,
and Touchstone pulls every 15 minutes. The push ingest endpoint replaces it in MVP-1, and only
then does the n8n workflow gain a node.

### Out — deliberately

Ingest endpoint · bench prober · incidents · notifications · Environment page · Standards page ·
re-assay button · scheduler · queue · packaging and deploy · auth (runs on localhost for now).

Everything on that list is designed in [ARCHITECTURE.md](ARCHITECTURE.md) and
[UX.md](UX.md) already; none of it is needed to look at the data.

## 4. Workstreams and file ownership

Three streams, disjoint directories, no shared files. `package.json`, `tsconfig.json`,
`vite.config.ts`, `index.html` and `src/shared/types.ts` are **scaffold — already written, do not
modify**. Every dependency any stream needs is already declared.

| Stream | Owns | Depends on |
| --- | --- | --- |
| **A — store & import** | `src/server/store/**`, `tools/**`, `test/**` | types |
| **B — domain & API** | `src/server/domain/**`, `src/server/routes/**` | types, A's interfaces |
| **C — web** | `src/web/**` | types, the API contract below |

B and C code against the contract, not against each other's implementations. Integration is a
separate, short pass once all three land.

## 5. Contracts

Both are frozen for MVP-0. Types live in `src/shared/types.ts`.

### Report file

`data/reports/<Subject>/<ISO with ':' → '-'>-<leg>.md`

```yaml
---
subject: OpenClaw
leg: static
standard: Static Review Protocol
standard_version: 3
status: done                 # done | blocked | running
verdict: non-compliant       # compliant | non-compliant | errored | deferred | null
top_severity: critical       # critical | major | minor | none
risk_score: 232
blocked_reason: null
subject_ref: Yundera/AppStore@main:Apps/OpenClaw
commit: 6b9af120ba7f
images: [openclaw:2.1.0]
started_at: 2026-08-05T09:14:22Z
finished_at: 2026-08-05T09:29:41Z
findings:
  - rule: D2
    title: root + user dir, no rationale.md
    severity: major
    status: fail
    note: mounts /DATA/Downloads and /DATA/Media as root
---

# Yundera/AppStore — OpenClaw
…report body verbatim…
```

Unknown frontmatter keys are preserved on read and rewritten on write. The body is never parsed by
the indexer.

### HTTP API

```
GET  /api/v1/subjects
     → SubjectState[]                     one row per subject, both legs, risk, staleness

GET  /api/v1/subjects/:name
     → { subject, history: AssayRecord[] }   newest first, both legs interleaved

GET  /api/v1/reports/:subject/:file
     → { meta: AssayMeta, html: string, raw: string }

GET  /api/v1/findings?group=rule
     → RuleGroup[]                        latest assay per (subject, leg) only
                                          grouped on (rule, title, status) — see types.ts

GET  /api/v1/findings?status=unverified
     → LocatedFinding[]                   the suspected-Critical queue
```

Errors are `{ error: string }` with a sane status code. No pagination in MVP-0 — 69 subjects.

## 6. Definition of done per stream

**A — store & import**
`readReport` / `writeReport` round-trip a real archived report byte-for-byte in the body and
value-for-value in the frontmatter. `buildIndex(dir)` returns every assay in under a second for the
imported corpus. `yarn import` populates `data/reports/**` from Docmost and is safe to run twice.
Fixtures for at least five real reports committed under `test/fixtures/`.

**B — domain & API**
Severity ordering and risk score match the standard (`100·Critical + 10·Major + 1·Minor`).
`hallmark()` picks the latest `done` assay per `(subject, leg)`. The four endpoints return the
contract shapes against a fixture directory. Markdown → HTML rendering escapes HTML in source and
emits heading anchors.

**C — web**
The three pages, matching the layouts in [UX.md](UX.md). `StatusCell` renders *failed* and
*unknown* as visibly different things — the single most important visual decision in the app.
Tables inside rendered reports scroll horizontally instead of breaking the page. Works against a
static JSON fixture so it can be built before the API is finished.

## 7. After MVP-0

In order, each a short iteration: push ingest + the n8n fan-out node → bench prober + incidents +
Activity → notifications → packaging behind AppShield. Then phase 1 of
[ARCHITECTURE.md §10](ARCHITECTURE.md#10-phases) — moving the scheduler in.
