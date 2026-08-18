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
| **Runner** | D1–D5 | prompt, agent call, response extraction, busy detection, backoff + one retry |
| **Bench & browser** | D6–D7 | preflight before claiming; own browser sidecar; `(bench, browser)` leasing |
| **Recording** | E1, E4–E7 | result path, headline-authoritative verdict, busy restores the row, parking, completion stamp |
| **Notification** | F1–F5 | tick/error/success/run-log outlets, plus the in-app log and push |

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

`data/reports/<Subject>/<ISO with ':' → '-'>-<leg>.md`

```yaml
---
subject: OpenClaw
leg: static
standard: Static Review Protocol
standard_version: 3
status: done                 # queued | running | done | blocked
verdict: non-compliant       # compliant | non-compliant | errored | deferred | null
top_severity: critical       # critical | major | minor | none   ← from the headline
risk_score: 232              #                                    ← from the headline
blocked_reason: null         # bench_unavailable | agent_busy | browser_unavailable
try_n: 1
trigger: schedule            # schedule | webhook | form | reassay
bench: null                  # demostaging1 | demostaging2 | null for static
browser: null                # touchstone-browser-1 | null for static
subject_ref: Yundera/AppStore@main:Apps/OpenClaw
commit: 6b9af120ba7f
images: [openclaw:2.1.0]
started_at: 2026-08-05T09:14:22Z
finished_at: 2026-08-05T09:29:41Z
---

# Yundera/AppStore — OpenClaw
…report body verbatim…
```

Unknown keys are preserved on read and rewritten on write. The body is never parsed by the indexer,
and — since findings are no longer extracted — never parsed by anything except the renderer.

There is no `findings:` list. That is the single biggest change from the previous contract.

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

A and B meet at one interface — the scheduler hands the runner a claimed `(subject, leg, bench,
browser)` and gets back a verdict or a `blocked_reason`. Both write through the store; neither
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
assumed, because a stale session is a false pass on the auth-gate check.

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
| **M4** | scheduler, calling n8n's `Webhook (programmatic)` to execute | **the QA Loop workflow can be disabled** |
| **M5** | runner: prompt, agent call, busy retry | assays execute in-process; the audit workflow is only a fallback |
| **M6** | browser sidecar + `(bench, browser)` leasing | functional assays run on a private, empty-profile browser |
| **M7** | packaging behind AppShield | reachable at `touchstone-yunderalabs.nsl.sh`; **the App Audit workflow can be disabled** |

M4 is the first milestone that retires something, and M2/M3 exist before it because a scheduler
that cannot tell you what it did, or cannot tell a dead bench from a bad app, reproduces the bug it
was built to fix.

### Before any of it

The twenty-line login preflight in the existing `Pick next target`. It is not part of Touchstone,
it stops the bleeding now, and every milestone above assumes the outage is understood rather than
ongoing. As of 2026-08-07 it still has not been added.
