# Touchstone — session handoff

**Session date: 2026-08-07.** Written so a future session can pick up without the conversation.
This is session state, not design — the design lives in [README.md](README.md),
[ARCHITECTURE.md](ARCHITECTURE.md), [MVP.md](MVP.md), [IMPLEMENTATION.md](IMPLEMENTATION.md) and
[UX.md](UX.md), all of which were rewritten during this session and are current.

---

## 1. Where the work stopped

**P1 is complete and verified. Nothing is committed.**

```
branch main, working tree dirty — 51 files changed
yarn typecheck   clean
yarn test        51 passed (51)
yarn build       green, dist/web 280 KB
```

The dev stack (`docker-compose.dev.yml`) is running and serving the corrected corpus on
`:8081` (API) and `:5173` (UI).

**P2 is next.** It is scoped in [MVP.md §8](MVP.md#8-order-of-work) and in the approved plan at
`/root/.claude/plans/splendid-napping-dusk.md`.

---

## 2. What this session changed, and why

### 2.1 The starting picture

The task was a status check of code against docs. Two things came out of it:

- **MVP-0 was built and running while every doc said "Design. Nothing is built yet."** All four
  of its acceptance criteria held against real data.
- **The importer was lying.** It derived each verdict from prose it extracted, and on eight of
  twenty non-compliant subjects derived something milder than the report's own headline —
  promoting OpenClaw, TINCatan, Guacamole and ClaudeCode to `compliant` while their pages said
  Critical. `groupByRule` was also implemented twice, with the acceptance test pointed at the
  copy the API did not serve.

### 2.2 The comparison against n8n

Pulled from the live instance rather than from the docs. Four workflows are active; two are in
scope:

| Workflow | ID | Nodes | Scope |
| --- | --- | --- | --- |
| AppStore Continuous Store QA Loop | `uEmep2z22i5qv1OF` | 12 | ✅ the driver |
| AppStore App Audit | `QjzNu9yWZ5005J7m` | 19 | ✅ the executor |
| AppStore PR Review | `tOclUcWTrfQN6j1N` | 17 | ❌ excluded by the user |
| AppStore release notes | `XJsURBnt7aIUhQVn` | — | ❌ produces no assay |

**The bench outage is not historical — it compounds hourly.** Two consecutive readings of the
same roll-up:

| | ✅ | ⛔ | ⚠️ errored | parked |
| --- | --- | --- | --- | --- |
| 2026-08-06 | 1 | 19 | 49 | 12 |
| 2026-08-07 | 0 | 15 | **54** | **13** |

`grep firstfactor` over the loop workflow returns **zero hits** — the twenty-line login
preflight recommended in ARCHITECTURE.md §9 has still not been added. That fix is independent
of this whole project and is the only thing that stops the counter climbing today.

**Capability coverage before P1:** Touchstone covered the *record and read* half and **0% of
the drive half** — triggering, scheduling policy, execution. That was by design, not shortfall:
the old IMPLEMENTATION.md said so explicitly.

### 2.3 Decisions the user made

These reshaped the project and should not be re-litigated without them:

1. **PR Review is out of scope.** It stays in n8n. This removed the old phase 3 (PR gate, check
   API, `scope: pr-diff`) from the plan entirely.
2. **Strict n8n parity.** Findings-as-rows, rule codes, the Findings page, `unverified` and the
   suspected-Critical queue, history, regression detection, the history strip, the Standards
   page and drift detection, findings→PRs, and incident ack/mute are all **deliberately
   dropped**. I flagged that these were the things that made the replacement worth doing; the
   user reaffirmed. Recorded in [ARCHITECTURE.md §1.4 G](ARCHITECTURE.md#g-deliberately-dropped).
3. **The MVP is full replacement**, not a viewer — scheduler *and* runner *and* browser.
4. **Deployment is out of scope.** *"i want to build until we are ready to replace, then i will
   review."* Packaging, deploy and the switch-off all wait.

### 2.4 The docs were rewritten around a parity rule

`ARCHITECTURE.md` §1 now opens with the **capability inventory and parity matrix** — 30
numbered rows (A triggering, B scheduling, C claim, D execution, E recording, F notification,
G dropped), each marked ✅/◑/⬜. **That matrix is the specification: n8n cannot be switched off
until every row is covered, and anything not on it is not built.** Every later section cites
the rows it closes.

Two corrections went in that a future session should not undo:

- **§5.3 — the agent-busy retry cannot be designed away.** PR Review stays in n8n and calls the
  *same* `http://beacon-backend:9300/mcp`. An earlier draft claimed an in-process queue removes
  the 409 dance; it does not, and rows D4/D5 have to be ported as-is.
- **§6.2 — the assay's own declaration is authoritative.** This is now principle 3, and it is
  the design fix for the importer bug above.

`MVP.md` was rewritten around *viable means the old thing can stop running*. `UX.md` went from
five pages to three (Overview, Subject detail, Activity). The browser sidecar and notification
panel are modelled on Newsdesk, with one deliberate divergence — **ephemeral browser profile**,
because a surviving session cookie is a false pass on the E9 auth-gate check.

---

## 3. What P1 delivered

**Goal: the archive stops lying, and out-of-scope code stops being maintained.**

Deleted `domain/findings.ts`, `domain/regression.ts`, `pages/Findings.tsx`, `HistoryStrip`,
`lib/anchors.ts`, `tools/query.ts`, ~320 lines of `tools/extract.ts`, the 46 rule definitions in
`data/standards/*.yaml`, the findings half of the shared contract, and the three
findings-oriented query methods on `ReportIndex`. Full list in
[MVP.md §4](MVP.md#4-what-p1-removed--done).

**The importer is now headline-authoritative** and the result is verified two ways — by the
suite, and by an independent script comparing every subject against its roll-up row:

```
OpenClaw   before: compliant     · none     · risk 0
           after:  non-compliant · critical · risk 232

20 subjects the roll-up marks non-compliant
  20 imported at the same tier or worse
   0 imported MILDER              <-- was 8
```

### Three things found while doing it

**The strict guard caught a real case on the first run.** Making an unparsable headline a hard
error (rather than a silent `compliant`) stopped the import on DocmostMCP: its headline reads
`ERRORED (audit could not complete — functional half unrunnable) · top severity Major`, and the
window between the verdict word and the tier was 40 characters. Now 120.

**A combined `errored` verdict has to be scoped to the leg that caused it.** In this corpus that
leg is almost always functional. DocmostMCP argues it in its own words — *"`non-compliant` would
wrongly attribute an infra outage to DocmostMCP, even though the static half independently found
a Major fail"* — and its headline still carries `Major · risk 12` from the static findings that
did complete. So when the functional leg never ran, `errored` is not a statement about the
static leg. This turned **ten bogus `errored` static legs into real verdicts** and is
ARCHITECTURE.md §2.5 applied to the migration.

**Two data defects.** `subject_ref` was matching `ref` inside "referrer", "reference" and
"therefore" — ten of sixty-nine subjects imported a git ref of `erence` or `errer` — and `scope`
matched unlabelled prose. Both now require a real separator.

### Beyond the plan

Removed the client-side fixture fallback and `src/web/fixtures/**`: a synthetic 69-subject
dataset that shipped **1.1 MB into the production bundle** and modelled a schema the app no
longer has. The server already answers from `domain/fixtures.ts` when its index is empty, so
there is now one copy of that logic instead of two. **Build: 1.4 MB → 280 KB.** Also pruned 38
dead CSS rules.

Left alone deliberately: `--ok-dim`, `--minor-dim` and `--unverified-dim` are unused but part of
a symmetric palette that P2's alert cards will want back.

### Current live state

```
69 subjects · total risk 2405
static      12 compliant · 57 non-compliant
functional  58 blocked · 7 compliant · 4 non-compliant
top risk    Tailscale 253, OpenClaw 232, Samba 212, CasaOS 131, TINCatan 123
```

Those match the roll-up. `/api/v1/findings` is gone and returns 404.

---

## 4. Picking up P2

P2 is **eyes**: event log, alerts, bench prober, Activity page, web push, and a 15-minute
polling importer. No deployment — it runs on the dev container, which already reaches
`beacon-yunderalabs.*` through the local Beacon aggregator.

**Two prerequisites discovered in P1, both easy to trip over:**

1. **The index is built at boot and never refreshed.** Running `yarn sync` rewrites
   `data/reports/**` but the running API keeps serving the old records — which looks exactly
   like the importer having failed. So P2's polling importer must run **in-process** and
   `upsert` into the live `ReportIndex`, not shell out. (Meanwhile: `docker restart
   touchstone-dev` after any manual import.)
2. **`store/config.ts` only reads `data/config.yaml`.** First-boot seeding does not exist and is
   required the moment the prober needs bench credentials.

**The safety rule holds through every phase** (see
[the plan](/root/.claude/plans/splendid-napping-dusk.md)): no writes to Docmost ever, no changes
to any n8n workflow, scheduler ships dry-run behind a config flag, runner ships disabled.
Validation is a single hand-run assay, never a loop — two systems auditing the same app contend
for the shared agent.

**P3's validation technique is worth preserving.** The roll-up states n8n's own decision in its
`- **State:**` line (`⏳ auditing X — <reason>`), so the ported scheduler can run dry-run
alongside the live loop and diff its pick against n8n's over ~150 real ticks before anything is
armed. Both read the same last-run data, so a divergence is a real bug rather than a timing
artefact.

---

## 5. Open items

- **Nothing is committed.** 51 files changed on `main`.
- **The `Store QA — Results` page** — freeze it with a pointer to Touchstone, or keep publishing
  it from a Docmost outlet? Undecided; deferred to the user's review.
- **Who runs the `yunderalabs` rollout.** It is not one of the pre-authorised test PCS boxes
  (`holyhorse`, `watch`), so that is the user's to run.
- **The n8n login preflight** still is not there, and is independent of all of the above.

---

## 6. Reference — facts read off the running system

Cited so they can be re-checked when they drift. Read 2026-08-07.

| Thing | Value |
| --- | --- |
| Roll-up page | slug `B5ZBicxRSn`, page id `019f373d-c73f-7cdd-b720-3d26da849dbe` |
| Beacon / agent endpoint | `http://beacon-backend:9300/mcp` — shared with PR Review |
| Scheduling constants | `FRESH_DAYS=7`, `STUCK_DAYS=7`, `LEASE_MIN=120`, `COOLDOWN_MIN=55`, `MAX_TRIES=3` |
| Subject registry | `api.github.com/repos/Yundera/AppStore/contents/Apps`, dirs only; 55-entry `DEFAULT_APPS` as cold-start fallback |
| Demo board | `https://app.nasselle.com/demo/admin/manage` — reports `✅ Ready` while credentials are rejected |
| Bench probe | `POST /api/firstfactor`; 401 → `bench.auth`, timeout/5xx → `bench.unreachable` |
| Browser sidecar | `ghcr.io/worph/browser-mcp:1.1.5` floor — tab registry, `hover`, per-tab screencast |

**The agent returns JSON, not markdown.** `Build prompt` demands a strictly-valid object and
`Extract LLM response` parses it:

```
{ app_name, title, verdict, severity, risk_score, summary, report_markdown }
```

`verdict` ∈ `compliant | non-compliant | errored`; `severity` is capitalised
(`Critical | Major | Minor | none`); `report_markdown` is what gets published verbatim — so the
headline the importer parses was *generated from* these fields. **P4's runner consumes the JSON
directly and parses no markdown at all.** Error classification to reproduce exactly:
`agent-auth` (auth regex), `agent-busy` (not auth, and contains `409` / `conflict` /
`in progress`), `agent-error`, `parse-failed`.

`depth` has only `static` and `full` — there is no functional-only mode. P5 calls `depth: full`
and splits the one response into two assay files with `shapeReport` / `splitSections` in
`tools/extract.ts`, which already do exactly that for imported Docmost pages.

---

## 7. Dev-loop gotchas

- **After any import, restart the container.** See §4.1. `tsx watch` only restarts on `src/`
  changes, so an import alone will not refresh the index.
- **`tools/extract.ts` defeats grep.** It contains a byte that makes grep treat the file as
  binary, so `grep -n "export" tools/extract.ts` prints *nothing at all* — not an error, not a
  zero count, just silence, which reads as "the symbol isn't there". Use `grep -a`.
- **Ports:** Vite 5173, API 8081. 8080 is the production default but is taken by ttyd in this
  container.
- **`yarn sync`, not `yarn import`.** `import` is a yarn-1 builtin and will not run the script.
