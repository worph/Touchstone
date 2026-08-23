# Touchstone — MVP

The MVP is **the smallest thing that lets us switch the n8n workflows off.**

That is a deliberate correction. The previous scope — a read-only page that renders imported
reports — was not a minimum *viable* product, because nothing depended on it and nothing could be
turned off once it shipped. It was a demo of the storage model. Useful, and already built, but
viable means *the old thing can stop running*.

---

## 1. The goal, in one sentence

> **The hourly conformance loop runs inside Touchstone — picking, claiming, assaying, recording and
> reporting — with both n8n workflows disabled and nothing lost.**

## 2. Acceptance test

The MVP is done when all of the following hold on the deployed instance, and it is complete when
somebody sets `AppStore Continuous Store QA Loop` and `AppStore App Audit` to **inactive** and the
store keeps being audited.

1. **The tick is ours.** Touchstone's own timer runs hourly. Disabling the n8n loop changes nothing
   observable except that the Docmost page stops updating.
2. **The backlog matches.** For the same 69 subjects and the same last-run data, Touchstone's
   eligibility calculation picks the same next target the n8n loop would have picked, under all
   five constants: `FRESH_DAYS=7`, `STUCK_DAYS=7`, `LEASE_MIN=120`, `COOLDOWN_MIN=55`,
   `MAX_TRIES=3`.
3. **A real assay completes end to end.** Touchstone builds the prompt, calls Claude Code at
   `http://beacon-backend:9300/mcp`, drives its own browser for the functional leg, and writes a
   report file whose verdict, tier and risk score equal the report's own headline.
4. **The bench outage cannot repeat.** With the demo pool returning 401, Touchstone probes
   `/api/firstfactor`, marks queued functional assays `blocked`, consumes **zero** tries, opens
   **one** alert, and keeps running static assays. This is the defect of record, and it is the
   single most important row on the list.
5. **Agent contention is survived.** A 409 from Claude Code — which a PR review can cause at any
   time — backs off, retries once, and if it still fails, restores the row without burning a try or
   stamping last-run.
6. **You can tell what happened without opening n8n.** The Activity page shows every tick, claim,
   dispatch, result and probe; a failure after retry pushes to your phone.

Point 4 is the one that matters. On 2026-08-06 the store read ✅1 ⛔19 ⚠️49; on 2026-08-07 it read
✅0 ⛔15 ⚠️54. The loop spent that day auditing four more apps into a column that says nothing about
them. If the MVP does not fix exactly that, it is not worth shipping.

## 3. Scope

### In — the parity rows

Every row from [ARCHITECTURE.md §1.4](ARCHITECTURE.md#14-capability-inventory-and-parity-matrix)
marked ⬜ or ◑, grouped by the milestone that closes it:

| Group | Rows | What lands |
| --- | --- | --- |
| **Triggering** | A1–A4 | hourly timer, programmatic webhook, forced-list form, re-assay action |
| **Scheduling** | B1–B9 | registry from GitHub, eligibility, cooldown, lease + reclaim, tries, parking, single-flight, no-queue |
| **Claim** | C1–C2 | write `running`; never stamp last-run at claim |
| **Runner** | D1–D5 | prompt, agent call, response extraction, busy detection, backoff + one retry — **done** |
| **Bench & browser** | D6–D8 | preflight before claiming; **> 1h of runway**; own browser sidecar; `(bench, browser)` leasing |
| **Recording** | E1, E4–E7 | result path, headline-authoritative verdict, busy restores the row, parking, completion stamp |
| **Notification** | F1–F5 | the in-app log, alerts and push. **Not** the Telegram/`notify-hub` fan-out: F1–F4 ask whether the operator finds out, and the Activity page answers it — ARCHITECTURE §1.4 F |

Plus the four sanctioned exceptions in
[ARCHITECTURE.md §1.4](ARCHITECTURE.md#14-capability-inventory-and-parity-matrix). Three of them
were confirmed on 2026-08-19 and carry work beyond the rows above:

| Exception | What lands | Milestone |
| --- | --- | --- |
| Newsdesk-shaped notifications | PWA manifest + icons with the AppShield anonymous bypass; the `assistable` error assistant; deep-linked pushes | M7 (PWA), M5 onward (assistant) |
| Own browser sidecar | `touchstone-browser-1…N`, ephemeral profile — ARCHITECTURE §5.4 | M6 |
| Exit Docmost | nothing published, and `services/importer.ts` **deleted** once the runner is in-process | M5 |

### Already done — phase 0

| Row | What |
| --- | --- |
| B2 | frontmatter index replaces the roll-up regex |
| E2, E3 | report files replace the wiki row and the wiki page |
| E8 | the Overview page replaces the rendered roll-up |

### Out — deliberately

Everything in [ARCHITECTURE.md §1.4 G](ARCHITECTURE.md#g-deliberately-dropped): findings as rows,
the Findings page, `unverified`, the suspected-Critical queue, history, regressions, the history
strip, Standards and drift detection, the PR gate, findings→PRs, incident ack/mute, generic tenancy.

**None of these are in the workflows being replaced.** They were designed for a product that was
going to be more than a replacement; that is a later conversation, and carrying them now costs
schedule against the only thing that matters, which is turning n8n off.

## 4. What P1 removed — done

Phase 0 shipped against the old scope. These implemented dropped capabilities and have been
deleted; the entry is kept so the absence is a decision on the record rather than a gap.

| Removed | Implemented |
| --- | --- |
| `src/server/domain/findings.ts` + the `/findings` route | findings-as-rows, `GET /findings` |
| `src/server/domain/regression.ts` (+ test) | regression detection — never wired to anything |
| `src/web/pages/Findings.tsx`, `components/HistoryStrip.tsx`, `lib/anchors.ts` | the Findings page, the history strip, finding→heading matching |
| `tools/query.ts` | the findings CLI |
| ~320 lines of `tools/extract.ts` | the rule vocabulary and prose→finding normalisation |
| the `rules:` blocks of `data/standards/*.yaml` | 46 rule codes and their regex matchers |
| `Finding`, `LocatedFinding`, `RuleGroup`, `FindingStatus`, `SEVERITY_WEIGHT` | the findings contract |
| `ReportIndex.groupByRule()` / `.latestFindings()` / `.findingSources()` | a second, divergent grouping the acceptance test was pointed at instead of the one the API served |
| `severity.ts`'s `gate`, `riskScore`, `topSeverity`, `isFailing` | deriving a verdict from findings |
| `src/web/fixtures/**` and the client-side fixture fallback | a synthetic 69-subject dataset that shipped 1.1 MB into the production bundle and modelled a schema the app no longer has. The server already answers from `domain/fixtures.ts` when its index is empty. |

The build went from 1.4 MB to 280 KB, and `data/standards/*.yaml` now carries what P4 actually
needs: the Docmost slug of each protocol, the `depth` to pass the agent, and the bench-selection
policy — a pointer and a version, not a second copy of a rubric that lives elsewhere.

**What survives and is directly reusable:** `store/reports.ts`, `store/index.ts`,
`store/config.ts`, `domain/severity.ts` (ordering only), `domain/hallmark.ts`,
`domain/markdown.ts`, the subject and report routes, `server/index.ts`, `tools/mcp.ts` (the Beacon
client the runner needs), `parseRollup` / `shapeReport` / `parseHeadline` / `parsePhases` in
`tools/extract.ts`, the Overview and Subject pages, `StatusCell`, `MarkdownView`, `Shell`, and
`docker-compose.dev.yml`.

`tools/import.ts` stays as a **one-shot migration** — run to bring the existing corpus onto disk,
then deleted. P1 rewrote its scoring: verdict, tier and risk now come from the report's own
headline, and from the roll-up row where there is no report page. Two things fell out of doing so:

- **`parseHeadline` was too strict.** DocmostMCP writes `ERRORED (audit could not complete —
  functional half unrunnable) · top severity Major`, and the window between the verdict word and
  the tier was 40 characters. It is now 120.
- **A combined `errored` verdict has to be scoped to the leg that caused it.** In this corpus that
  leg is almost always functional, and DocmostMCP says so in as many words: *"`non-compliant` would
  wrongly attribute an infra outage to DocmostMCP, even though the static half independently found
  a Major fail."* When the functional leg never ran, `errored` is not a statement about the static
  leg, so the static leg stands on its own tier. This is ARCHITECTURE.md §2.5 applied to the
  migration, and it is why the archive now has zero `errored` static legs where it had ten.

Two smaller data defects went with it: `subject_ref` was matching `ref` inside "referrer",
"reference" and "therefore" — ten of sixty-nine subjects imported a git ref of `erence` or `errer`
— and `scope` was matching unlabelled prose. Both now require a real separator.

## 5. Contracts

### Report file

`data/reports/<origin>/<Subject>/<ISO with ':' → '-'>-<section>.md`

```yaml
---
subject: OpenClaw            # the BARE app name. Identity is `<origin>~<subject>`
origin: yundera              # which store it came from — `config.yaml`'s `origins[].id`
section: static              # the leaf protocol that judged it — `data/protocols/static.md`
standard: Static Review Protocol
standard_sha256: 9c1b3f2a…    # the sha256 of the protocol file that judged it — invariant 9
                             # `standard_version: 3` on files written before 2026-08-23
status: done                 # queued | running | done | blocked
verdict: non-compliant       # compliant | non-compliant | errored | deferred | null
top_severity: critical       # critical | major | minor | none   ← from the headline
risk_score: 232              #                                    ← from the headline
risk_score_computed: 241     # ONLY when it disagrees with the line above — see §5.1
combined_score_of:           # on the primary: the sections `risk_score` covers
  - static
  - functional
blocked_reason: null         # bench_unavailable | agent_busy | browser_unavailable
try_n: 1
trigger: schedule            # schedule | webhook | form | reassay
bench: null                  # the demo instance, when this section needed one
browser: null                # the sidecar it drove, when this section needed one
subject_ref: Yundera/AppStore@main:Apps/OpenClaw
commit: 6b9af120ba7f
images: [openclaw:2.1.0]
started_at: 2026-08-05T09:14:22Z
finished_at: 2026-08-05T09:29:41Z
bench_host: https://demostaging1.inojob.com
bench_build: index-C_5OE2_1  # which build of the platform produced this — see §5.2
---

# Yundera/AppStore — OpenClaw
…report body verbatim…
```

Unknown keys are preserved on read and rewritten on write. The body is never parsed by the indexer,
and — since findings are no longer extracted — never parsed by anything except the renderer.

There is no `findings:` list. That is the single biggest change from the previous contract.

#### 5.1 The three fields about the score

A run declares **one** verdict, one tier and one risk score, so they land on the first section and
the rest carry `combined_score_on` pointing at it (ARCHITECTURE §4; attributing the score to each
section would multiply the archive's risk by the number of sections). The consequence is that the
primary's frontmatter holds two numbers with **different scopes**:

| Field | Scope | Present |
| --- | --- | --- |
| `risk_score` | the whole run | always; on non-primary sections it is `0` |
| `coverage.risk` | *this section's* items only | when the section recorded any |
| `risk_score_computed` | the whole run's items, summed by Touchstone | only when it ≠ `risk_score` |
| `combined_score_of` | which sections `risk_score` covers | on the primary of a multi-section run |
| `combined_score_on` | where this section's score went | on every non-primary section |

`combined_score_of` exists because the first two read as an arithmetic error otherwise. A static
assay carrying `risk_score: 30` beside `coverage.risk: 20` is correct — the missing 10 is the
functional section's, counted once, on this file — but nothing on the record said so, and a reader
who spots one contradiction starts doubting the findings too.

`risk_score_computed` is the **computed** half of a disagreement. The declared half is authoritative
(invariant 1) and already sits in `risk_score`, so recording the declared value here — which is what
happened until 2026-08-23 — wrote the same number twice and left the disagreement invisible, in the
one field whose whole purpose was to make it visible. The Subject page rendered the mismatch line
from `coverage.risk`, a third number that was never the one being compared.

#### 5.2 `bench_build` — which platform produced this verdict

`bench_host` traces a result to a box. `bench_build` traces it to a moment in that box's life: it is
the content hash of the UI bundle the bench served when the prober last logged in
(`buildFrom` in `services/bench.ts`).

It is a **fingerprint, not a version**, and must never be rendered as one. Maison ships from
`go build -trimpath -ldflags="-s -w"` with no version symbol, publishes no `/version`, and puts
every API route behind the OIDC gate — there is no number to ask for. What it does serve is a Vite
bundle whose filename is a content hash, which changes when the platform is redeployed and is stable
across restarts. That is enough to answer the one question the archive could not: *did the platform
differ between these two runs?*

Why it was added: on 2026-08-22 AnnasTorrents went compliant → Critical, and SegmentPlayer newly
failed `cpu-shares`, both on app bytes that had not changed. With only `bench_host` on the record
there was nothing to separate an app regression from environment drift, so the drift was attributed
to the apps. `blocked` already means "infra, not the subject" (invariant 4); this is the same idea
for a *silent* environment change, which produces a verdict rather than a block and is therefore far
more dangerous.

Nothing gates on it. Absent means the probe could not read one, which is a fact about the probe. A
**blocked** section carries neither `bench_host` nor `bench_build`: it never reached a bench, so it
has no environment to describe.

**`origin` arrived on 2026-08-20**, when the app store became a configured value rather than five
hardcoded strings. A file written before then has none, and `coerceMeta` fills it with the default
origin on read — the same move as `leg` → `section` below, and for the same reason: the archive was
not rewritten. That default is also what lets the one-time move of `reports/<Subject>/` into
`reports/<origin>/<Subject>/` be tidying rather than something correctness depends on. Note that
`subject` stays the **bare** name; the composite key lives on the index record, not in the file.

**`section` replaced `leg` on 2026-08-20** and the set is open: it is the `id` of a leaf in
`data/protocols/`, not a two-value enum. Files written before then carry `leg:` instead, and
`parseReportMeta` fills `section` from it on read — the archive was not rewritten, and nothing
downstream has to know which spelling a file used. `requirements[].section` records which
section settled each item, resolved from the protocol that listed the id rather than from the
agent.

### HTTP API

See [ARCHITECTURE.md §6](ARCHITECTURE.md#6-api). Errors are `{ error: string }` with a sane status
code. No pagination — 69 subjects.

## 6. Workstreams

Three streams, disjoint directories.

| Stream | Owns | Closes rows |
| --- | --- | --- |
| **A — scheduler** | `src/server/scheduler/**`, `src/server/store/registry.ts` | A1–A4, B1–B9, C1–C2, E1, E5–E7 |
| **B — runner** | `src/server/runner/**`, `src/server/services/{bench,browser,mcp}.ts` | D1–D7, E4 |
| **C — notification & UI** | `src/server/services/{events,alerts,notify,push}.ts`, `src/web/**` | F1–F5 |

A and B meet at one interface — the scheduler hands the runner a claimed subject and gets back a
verdict or a `blocked_reason`. It does not say *what* to audit: the runner reads the protocol
files, runs every section whose `requires:` it can satisfy, and records the rest as blocked. Both write through the store; neither
touches the filesystem directly.

## 7. Definition of done per stream

**A — scheduler.** A table-driven test replays the 69-row corpus through the five constants and
asserts the chosen target matches what `Pick next target` chooses for the same input. A lease
older than `LEASE_MIN` is reclaimed. `agent_busy` and `bench_unavailable` leave `try_n` unchanged
and leave last-run untouched; every other completion stamps it. Three consecutive errors park the
subject for `STUCK_DAYS`.

**B — runner.** A real assay against a real bench produces a file whose `top_severity` and
`risk_score` equal the report headline's, asserted against a fixture whose headline and prose
disagree. A 409 backs off, retries once, then blocks without burning a try. Each functional assay
gets its own browser container and the profile is empty at the start of every run — asserted, not
assumed, because a stale session is a false pass on the auth-gate check. **A bench is claimed only
when the login flow completed *and* it has more than an hour of runway and is not mid-cleanup**
(D7/D8): healthy is not the same question as claimable, and an instance the daily cleanup wipes
halfway through Phase G costs a whole assay.

**C — notification & UI.** Every scheduler and runner transition writes an event whose `message` is
one sentence with no ids and no interpolated error text. A bench outage produces exactly one open
alert however many assays it blocks. The Activity page renders with Beacon unreachable and push
unconfigured — principle 7. Overview keeps `blocked` visually distinct from `non-compliant`.

## 8. Order of work

| # | Milestone | Done when |
| --- | --- | --- |
| **M1** | delete the out-of-scope code; simplify the importer to headline-authoritative | the corpus re-imports with verdicts matching the roll-up |
| **M2** | events + alerts + Activity page + push | you can watch the *existing* n8n loop, via a temporary ingest endpoint |
| **M3** | bench prober + preflight + alert | the outage shows as one alert with the functional queue paused |
| **M4** | scheduler, calling n8n's `Webhook (programmatic)` to execute | **the QA Loop workflow can be disabled** — *built and running dry; needs the shadow diff, then arming* |
| **M5** | runner: prompt, agent call, busy retry; **the importer is deleted** | assays execute in-process; Docmost is fully exited — *built and validated by a hand-run assay; the importer stays until the scheduler is armed* |
| **M6** | browser sidecar + `(bench, browser)` leasing | functional assays run on a private, empty-profile browser — *built, probed and leased; the agent driving it needs both on one network, i.e. the deploy* |
| **M7** | packaging behind AppShield, PWA manifest + icons through the sidecar bypass | reachable at `touchstone-yunderalabs.nsl.sh`; installable on a phone; **the App Audit workflow can be disabled** |

M4 is the first milestone that retires something, and M2/M3 exist before it because a scheduler
that cannot tell you what it did, or cannot tell a dead bench from a bad app, reproduces the bug it
was built to fix.

**M4 cannot read its own results back.** The audit webhook is fire-and-forget and `Return to
caller` drops `report_markdown` — ARCHITECTURE §9 has the detail and the three ways through. The
recommendation is to keep the Docmost importer alive across M4 and delete it at M5, which is why
"exit Docmost" completes at M5 rather than M4. If that window is unwelcome, merge M4 and M5 and
skip the seam.

### Before any of it

~~The twenty-line login preflight in the existing `Pick next target`.~~ **Done 2026-08-19**, and it
was not twenty lines: the endpoint it was specified against never authenticated anything. The
shipped change gates the tick on a real OIDC login probe and hands the audit a verified
`demo_host`, across three nodes in two workflows. ARCHITECTURE §9 has the detail and the reason it
is the one sanctioned waiver of the no-n8n-edits rule.
