# Touchstone — session handoff

**Sessions: 2026-08-07 (P1) and 2026-08-19 (P2).** Written so a future session can pick up
without the conversation.
This is session state, not design — the design lives in [README.md](README.md),
[ARCHITECTURE.md](ARCHITECTURE.md), [MVP.md](MVP.md), [IMPLEMENTATION.md](IMPLEMENTATION.md) and
[UX.md](UX.md), all of which were rewritten in the P1 session, updated in P2, and are current.

---

## 1. Where the work stopped

**P1 and P2 are complete. P1 is committed; P2 is not.**

```
branch main, P1 committed as 66e13cf; P2 uncommitted in the working tree
yarn typecheck   clean
yarn test        120 passed (120)      — 51 at the end of P1, 111 at the end of P2
yarn build       green, dist/web 266 KB + sw.js
```

The dev stack (`docker-compose.dev.yml`) is running: API on `:8081`, UI on `:5173`, Activity
page rendering with an empty log, no benches configured and push configured.

**P3 — the driver — is next.** It is scoped in [MVP.md §8](MVP.md#8-order-of-work) (M4) and in
the approved plan at `/root/.claude/plans/splendid-napping-dusk.md`.

---

## 2. What the P1 session changed, and why

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

## 4. What P2 delivered

**Eyes.** You can now see what the loop is doing, and a dead bench is legible as a dead bench,
before anything of ours starts making decisions.

| New | What it is |
| --- | --- |
| `store/state.ts` | atomic JSON writes, `O_APPEND` JSONL, and a reader that tolerates a torn tail |
| `services/events.ts` | the append-only log. Codes carry a declared `detail` shape, so tsc enforces the message/detail split rather than a comment asking for it |
| `services/alerts.ts` | open / refresh / resolve, deduplicated by a closed set of keys. No ack, no mute |
| `services/bench.ts` | the prober: `POST /api/firstfactor` per bench, plus the management board as a *second opinion* |
| `services/notify.ts` | the routing table → Beacon outlets, resolved from the live aggregator with `server_doc` |
| `services/push.ts` + `web/public/sw.js` | web push, VAPID generated on first boot into `state/push.json` |
| `routes/{events,alerts,benches,push}.ts` | the four endpoints, which answer empty rather than 404 when the services are absent |
| `pages/Activity.tsx`, `AlertCard`, `EventRow` | the page: open alerts, environment, log with level/category/subject filters |
| nav badge | open alerts + unread `error` rows, and nothing else |

**Moved, because `tsconfig.server.json` compiles only `src/`:** `tools/mcp.ts` →
`services/mcp.ts`, `tools/extract.ts` → `domain/extract.ts`, and `tools/import.ts` →
`services/importer.ts` with a `runImport()` entry point. `tools/import.ts` is now a 40-line argv
wrapper. The importer runs **in-process** on a 15-minute timer and upserts into the live index —
the boot-only index is why shelling out would have shown stale data.

**`data/config.yaml` is now seeded on first boot**, comments and all, with every value equal to
its built-in default: the scheduler disarmed, the runner disabled, `benches: []`. Seeding is
behaviourally inert; deleting the file leaves the app running identically.

### Three things worth knowing

1. **The 200-that-rejects.** The demo IdP answers `200` with `{"status":"KO"}` /
   `auth/invalid-credential` in the body. A prober reading only the status line reports the
   2026-08-05 outage as healthy — which is exactly the mistake the management board makes. The
   body check is in `probeBench` and has a test.
2. **Alerts were being routed twice**, found by running it rather than by reading it: an alert
   transition also *writes an event*, so `handleAlert` and `handleEvent` both sent. `ALERT_*`
   is now deliberately absent from the routing table, and `handleAlert` owns alerts end to end.
3. **`ARCHITECTURE.md` §1.4 E4 was stale** — it still said the risk score was derived from prose,
   which P1 fixed. Corrected to ✅ along with the D7 and F rows.

### What P2 did NOT do

- No browser pool and no agent probe. The environment block says so in a sentence rather than
  showing a green row it has not earned — the browser lands with functional leasing (P5), the
  agent check with the runner (P4).
- No tick, claim or assay events. The log has no codes for them: a log where `TICK_COMPLETED`
  sometimes means something else is a log whose filters lie. P3 and P4 add their own.

---

## 4b. Picking up P3

P3 is **the driver**: port `Pick next target` (9,374 chars) and `Record result` (5,473 chars)
into `src/server/scheduler/`, and validate by diff rather than by assertion.

The five constants are already in `data/config.yaml` at n8n's current values, and
`cfg.scheduler.armed` is the flag that arms it. Two things P2 leaves ready:

- **`prober.poolUp`** is the bench preflight D7 needs. A functional claim gates on it, and a
  bench-down result is `blocked` / `bench_unavailable`, which by principle 5 consumes no try.
- **The importer already runs every 15 minutes**, so shadow mode has live last-run data with
  zero changes to n8n.

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

## 4c. What P3 delivered — the driver, dry-run

`src/server/scheduler/` plus `store/registry.ts`. **23 parity rows closed**; the matrix now
reads ✅ for all of A1–A3, B1–B9, C1–C2, D7 and E5–E7, with E1 partial until the runner exists.

| File | What |
| --- | --- |
| `scheduler/policy.ts` | `decide()` — pure, no clock and no I/O, so a tick can be replayed and diffed |
| `scheduler/record.ts` | `recordResult` / `openClaim` — rows E1, E5–E7, C1, C2 |
| `scheduler/adopt.ts` | reads n8n's try counts and parks out of its roll-up — see below |
| `scheduler/index.ts` | the timer, `schedule.json`, the event log wiring |
| `store/registry.ts` | GitHub `Apps/`, `DEFAULT_APPS` cold start, archived subjects appended |
| `routes/schedule.ts` | `GET /schedule`, `POST /schedule/tick` |

**Where it stands against the live loop.** Both systems, same minute:

```
touchstone  ⏳ auditing Beacon — last run 2026-08-14, 5d ago     backlog 31
n8n         ⏸️ idle — no usable demo bench — demostaging2 …      backlog 31
```

Identical backlog and an identical cooldown anchor. The state lines differ because n8n's
14:00 tick was gated by its new preflight while ours had already ticked — a real difference
in what each was asked at that moment, not a policy divergence.

### Four things found by running it, none by reading it

1. **The importer had never fetched anything.** `refresh` defaults to false, so the "stay
   current with n8n" feed served a roll-up cached on 2026-08-06 for thirteen days. It now
   always re-fetches the roll-up, and re-fetches a subject's report page only when the row
   says it has been audited since. **`TOUCHSTONE_BEACON_URL` was also wrong in the dev
   compose** — `localhost:3000` inside `touchstone-dev` is that container, not the Beacon
   aggregator, so the first real fetch failed outright. It is `host.docker.internal:3000` now.
2. **Shadow mode was missing half its input.** We never run an audit, so we never record a
   result, so our try counts and parks stayed empty while n8n's are what constrain its
   choice — 69 backlog against n8n's 31. `adopt.ts` reads them out of the roll-up's Result
   column. Adopted rows carry `from_rollup: true` so a later import can correct an earlier
   one, and anything Touchstone recorded itself is never overwritten.
3. **Freshness has to come from the row, not the page.** The roll-up listed Spliit as audited
   on the 19th while the page it links to still declared the 12th. While n8n owns the loop its
   row is the scheduling truth, so `lastDoneAt` prefers `rollup_last_run`. That was the last
   app between 32 and 31. It is not principle 3 in reverse — verdict, tier and risk still come
   from the headline; only *when it last ran* comes from the row, and only until M5.
4. **The boot order matters.** The first tick has to come after the first import or it decides
   on an archive with no scheduling state at all.

### Two deliberate divergences from the plan

- **`try_n` is not in `AssayMeta`.** The matrix note on B6 assumed it would be. A try counter
  is a property of the scheduler's opinion about a subject, not of any assay, so it lives in
  `state/schedule.json` beside the claim and the park.
- **No per-leg policy.** ARCHITECTURE §5.1 sketches static and functional on different
  freshness windows. n8n picks a *subject* and runs `depth: full`; doing anything else would
  make the shadow diff incomparable. It waits for M6.

### Still ahead of arming

The diff has been run for one tick, not the ~150 the plan calls for. `data/state/schedule.json`
was deleted once during P3 (it held adopted rows only, and pre-dated the `from_rollup` marker);
deleting it is always safe and it re-adopts on the next import.

---

## 4d. What P4 delivered — the runner

`src/server/runner/` plus `domain/assay.ts`. **35 of 36 parity rows are now ✅**; the only one
left is D6, the browser for the functional leg.

| File | What |
| --- | --- |
| `runner/prompt.ts` | the protocol, **byte-identical** to the live n8n node |
| `runner/agent.ts` | the call, the SSE unwrap, and the four error classes branch for branch |
| `runner/index.ts` | job → prompt → agent → one retry on 409 → assay files → outcome |
| `domain/assay.ts` | one report, two assay files — now shared with the importer |
| `routes/assays.ts` | `POST /assays`, the hand-run validation path |

**The prompt was ported mechanically, not retyped.** That text *is* the audit protocol — every
verdict in the archive came from an agent reading those words — so it was transformed out of the
live node by script and then asserted equal to it for three input shapes. A test would have
caught a single changed character.

**The runner ships disabled** and `POST /assays` answers `409` with the config key to change,
rather than a 500. Validation is one hand-run assay, never a loop, because `AppStore PR Review`
is still in n8n on the same agent.

### Validated against the real agent

Three hand-run static assays through `POST /assays`, on the live yunderalabs agent:

```
Spliit  4m15s  parse-failed                      <- the answer was fine; the parser was not
Spliit  4m09s  parse-failed                      <- after the fence fix; still not
Ntfy    6m01s  non-compliant · Minor    · risk 1
Spliit  6m07s  non-compliant · Critical · risk 121
```

The last two are the whole path end to end: prompt → agent → declaration → assay file, with the
frontmatter carrying the agent's own verdict and the body its report verbatim. Spliit is the same
subject that failed twice, so the brace scan is confirmed as the fix rather than assumed.

Worth noting for anyone comparing runs: the agent scored Spliit 120 on the run that failed to
parse and 121 on the one that succeeded. Its judgement moves a little between runs, which is
another reason the archive keeps the assay's own declaration rather than recomputing anything.

### The manual trigger

`POST /assays` and `GET /assays/current`, with a working `re-assay ▾` on Subject detail — n8n's
`Audit an app` form, as a button. Two choices, `static only` and `static + functional`, the second
disabled with its reason when no bench is leasable.

It is **asynchronous on purpose**: `202` and then polling, because an audit runs five to ten
minutes and a proxy closing the socket at minute four looks exactly like a failed audit. `wait:
true` is still there for a shell that would rather block, and that form returns the rendered
report with the outcome — the point of a manual trigger is to read the thing.

A hand-run assay records against the schedule exactly as a scheduled one does, so running one by
hand does not leave the subject looking untouched for the next tick to pick straight back up.

### Three bugs worth keeping in mind

1. **`writeJsonAtomic` could silently lose a write.** The temp filename carried only the pid,
   which separates two *processes* and nothing at all inside one — and overlapping writes to the
   same file are routine here: a bench probe and the alert it raises, a tick and the result it
   records. Both wrote one scratch path, the first `rename` consumed it, the second failed
   `ENOENT` and its contents were gone. It surfaced as a test failing about one run in three, in
   a different file each time. The name is now unique per call.
2. **The JSON extractor threw away good answers, twice over.** Both defects are inherited
   from n8n's `Extract LLM response` and both cost the app a try:
   - It unwrapped *the first* ``` it found anywhere. `report_markdown` almost always contains a
     fenced block, so the "unwrap" sliced from inside the JSON string. A fence is only a
     wrapper when it comes **before** the object.
   - It took `lastIndexOf('}')` as the end of the object, which is right only when nothing
     follows it. Replaced with a brace scan that tracks string and escape state.

   Neither showed up in fixtures; both showed up on the first real answer. There is now a dump
   of any unparsable response at `state/last-unparsed-response.txt`, because 800 characters in
   a log line cannot tell a truncated report from a malformed one.
3. **The agent envelope differs by route.** n8n posts `tools/call` straight at
   `beacon-backend:9300` from inside the yunderalabs stack. Anything outside that network has to
   go through a Beacon aggregator's own `call` tool — a different envelope, not just a different
   address. `runner.agent_via` says which, and it is `direct` by default so production matches
   n8n exactly.

---

## 4e. D6 — the browser sidecar, and the ports

**Parity is complete: 36 of 36 rows.**

`touchstone-browser` is in `docker-compose.dev.yml` — `ghcr.io/worph/browser-mcp:1.1.5`,
`shm_size: 2gb`, `IDLE_TTL_MS`, `PAGE_COLLECTOR`, and **no profile volume**. That last one is
the deliberate divergence from Newsdesk: a session surviving between assays makes an
unprotected app look protected, which is a false pass on the check that catches auth bypass.

The runner leases it. Single-flight means taking the first healthy sidecar *is* the lease, so
two assays cannot share a browser by construction — §2.4's page-stealing race is impossible
rather than unlikely. A functional job with no sidecar is `blocked · browser_unavailable`,
which by principle 5 costs no try. The prompt names the leased endpoint and tells the agent
**not** to use the shared browser; with no lease it is still byte-identical to the n8n node,
and a test asserts both.

### What is not proven

The sidecar is built, probed and leased. **The agent has never actually driven it**, because
the agent runs on yunderalabs and this sidecar runs here — they have to share a network, and
that is the deploy the operator has reserved. Everything up to that boundary works; the last
mile is a deployment, not a feature.

### services/ports.ts — the third dependency finally has a face

The bench pool had a prober, an alert and a row since P2. The **agent** and the **browser** had
a line in `config.yaml` and nothing else, which is a bug in its own right: an audit needs all
three, and a dependency whose state you cannot see is one you learn about from a failed run.

The probe is `tools/list` over MCP for both, and it is the honest one — `browser-mcp` serves a
landing page on `/health` that answers `200` whether or not Chrome is reachable, which is
exactly the kind of green light this codebase has been burned by twice. A surface that answers
with no tools is reported unreachable, not healthy, and the agent port is additionally asked
whether the tool the runner will actually call is on it.

No alerts from this prober, on purpose: no browser means the functional queue is already paused
by the bench gate, and no agent means the failed assay says so itself. A third alert source
would turn one outage into three cards.

Live, on the Activity page:

```
agent        answering    4 tools · 5ms
browser-1    answering   29 tools · 8ms
demostaging1 not usable   HTTP 502 · board says 🔄 Processing · 23.0h
demostaging2 not usable   HTTP 500 · board says ✅ Ready · 15.0h
```

---

## 4f. Docmost is gone, and the protocol is a file

Two of the operator's seven points, and they turned out to be one task.

**Everything that talked to a wiki is deleted:** `services/importer.ts`, `tools/import.ts`,
`scheduler/adopt.ts` (+ its tests), `parseRollup` and the roll-up types, the `docmost:` config
block and its page cache, and the `yarn sync` script. `tools/` is empty and gone. The scheduler
no longer adopts n8n's try counts or takes its cooldown anchor from a wiki page — it uses its
own recorded finishes, and freshness reads `finished_at` alone.

**The protocol was the load-bearing part nobody had noticed.** The rubric was three Docmost
pages the *agent* fetched at run time; Touchstone held a slug and a version. It is now
`data/protocols/{orchestrator,static,functional}.md`, exported once by a throwaway script that
was deleted after it ran, with `imported_from: docmost:<slug>` kept as provenance.

The exported text told the agent to publish to the wiki, cross-link an App KB page and fetch
its own leaves. Rather than silently rewriting it, each file carries a visible **Local
amendment — Touchstone (2026-08-19)** block that supersedes those sections. An operator can
read exactly what changed and why, and edit it.

**The prompt embeds all three** instead of naming slugs — 32 KB with the functional leaf, and
an audit can no longer error because a wiki was slow. With no protocol supplied the prompt is
still byte-identical to the n8n node, and a test asserts both halves.

**The config is fully local.** `agent_tool: claude-code__query_claude` through the local Beacon
aggregator — the Claude Code in *this* container, not yunderalabs' — and the browser is the
local sidecar. Nothing in the running system reaches yunderalabs.

Proved end to end: a hand-run static assay on Ntfy, local agent, local protocol, no wiki —
`non-compliant · Minor · risk 3` in 7m34s, written to `data/reports/Ntfy/`.

### The editor

`GET /protocols`, `GET /protocols/:id`, `PUT /protocols/:id`, and a **Protocol** screen with a
tab per document, rendered markdown, and a plain textarea. Deliberately not a rich editor: the
files are markdown that an operator may also edit on disk or in git, and anything that rewrote
the source on save would fight that.

Saving bumps the version and writes a `PROTOCOL_EDITED` event. Round-tripped through the API:
v3 → v4 on save, `400` on an empty body, and the change on disk.

### One more teardown flake, same family

`bench.test.ts` failed about one run in five with `ENOTEMPTY` — `AlertStore.open` does not await
its own write, by design, so one landed while `rm -r` was walking the directory. Same fix as
`alerts.test.ts`: settle with `flush()` in teardown. Five clean suite runs since.

---

## 4g. The agent reports as it works

Stage 1 of the generic-requirements plan, built as an MCP surface on the operator's suggestion
rather than as an extension of the JSON contract — and it is the better design.

`POST /api/v1/mcp`: `list_requirements`, `record_requirement`, `record_phase`. No
`record_result`, ever — see ARCHITECTURE §5.8 for why. Run-scoped token, minted per dispatch,
argument on every call, dead when the run ends. `services/ledger.ts` holds the in-flight run;
`data/protocols/*.md` frontmatter now declares the canonical ids (16 for the static leaf, 8
phases for the functional one).

**The first live test justified the whole thing on its own.** The agent called
`list_requirements`, recorded all 16 canonical requirements plus one unlisted
(`cors-credentials-hardening`, correctly flagged) — and then the final JSON blob failed to
parse. Under the old contract that was six minutes discarded. Instead:

```
ASSAY_FAILED  {subject: Dufs, error: parse-failed, verified: 16, of: 16}
```

### The parse bug, third and final variant

The dump gave me the real payload this time, so the fix is against evidence rather than a
guess. All three failures were one bug — the parser looked for the object's *boundaries* using
fences, and `report_markdown` is markdown, so it contains fences:

1. it unwrapped the **first** ``` anywhere, which was usually inside the JSON string;
2. it took `lastIndexOf('}')` as the end, wrong the moment anything follows the object;
3. even unwrapping only a *leading* fence, it took the next ``` as the closing one — and that
   next fence was a ```yaml block inside the report.

All three vanish if the fence is ignored entirely: a fence marker contains no braces, so the
object still starts at a `{`, and a scanner that tracks string state finds its end regardless of
what follows. Candidate braces are tried in order, so prose containing a `{` before the object
costs an attempt rather than the run. The real failing answer is checked in as
`test/fixtures/agent/prose-then-fenced-json.txt` and asserted against.

Re-running the same audit after the fix: `non-compliant · risk 2`, 17 requirements and a
`coverage` block in the frontmatter.

### Stage 2 — the display

- **Overview** gains a `Verified` column, sortable, `—` for anything imported before the runner.
  Neutral-coloured on purpose: coverage is not compliance, and green would merge two questions.
- **Subject detail** gains a `requirements` section above the report — failures first, worst
  tier first, then unchecked, then passes folded behind a count. Canonical id, the agent's
  wording, its note, and an `unlisted` tag where the protocol does not name the id.
- **The re-assay button counts requirements**, not just minutes: `auditing… 7/16 · 3:20`.
- `GET /assays/current` carries `progress` from the live ledger.

Live on Dufs: `REQUIREMENTS 16/16 verified`, two `FAIL · MINOR` rows with the agent's reasoning,
one `N-A`, fourteen passes folded.

### Not done here

The endpoint is not beaconified yet, so the agent reaches it over HTTP rather than as a
discovered MCP server. ARCHITECTURE §8 already plans a `touchstone-mcp` beaconify sidecar; that
is where it belongs, and it is packaging rather than function.

---

## 5. Open items

- **P2 is not committed.** P1 is (`66e13cf`).
- **No bench is configured**, so the prober reports nothing and the functional queue stays
  paused. Credentials go under `benches:` in `data/config.yaml`; the demo pool is the one
  behind the management board in §6. Until then the Activity environment block says so rather
  than showing green.
- **No notify outlet is configured**, so alerts stay in the log. `notify.outlets` takes
  `{kind: telegram|discord, target}`.
- ~~**The `Store QA — Results` page**~~ — **resolved 2026-08-19: freeze it with a pointer.** Docmost
  is exited entirely; see the decisions below.
- **Who runs the `yunderalabs` rollout.** It is not one of the pre-authorised test PCS boxes
  (`holyhorse`, `watch`), so that is the user's to run.
- ~~**The n8n login preflight**~~ — **shipped 2026-08-19**, see §5c. It was
  *recommended* rather than merely noted — ARCHITECTURE §9 carries the third reason, which is that
  the false rows it prevents poison the very roll-up M4's shadow diff measures against. It waives
  the no-n8n-edits rule, so it stays the user's call.

---

## 5b. Decisions taken 2026-08-19

Three scope decisions, now encoded in ARCHITECTURE §1.4 (four sanctioned exceptions), §5.4, §5.5,
§5.6, §9, MVP §3 and §8, and UX §3.

1. **A Newsdesk-shaped notification system is in scope.** P2 already built the spine in that shape.
   What is *not* built, measured against `/d/workspace/sandbox/Newsdesk`: the PWA manifest and
   icons with the AppShield anonymous bypass (without it Android installs a bookmark, not an app,
   and phone push is worth little), the `assistable` error assistant, and deep-linked pushes.
2. **Touchstone embeds its own `browser-mcp` sidecar**, copied from Newsdesk's stack. The
   divergence holds: **ephemeral profile, no volume** — a surviving session is a false pass on the
   auth-gate check.
3. **Docmost is exited entirely.** Reports are local markdown rendered in the app; nothing is
   published, and `services/importer.ts` is deleted at M5 rather than kept behind a flag.
4. **Notification is internal only.** No Telegram/`notify-hub` fan-out: rows F1–F4 ask whether the
   operator finds out, and the log plus push answer it — which is how Newsdesk works, where MCP
   outlets carry published work and never operator notification. `services/notify.ts` stays with
   `outlets: []`. **The Telegram App Audit room (`-5438454538`) goes quiet when n8n is switched
   off**; restoring it is a config line.

### What changed in the code the same day

`services/bench.ts` was rewritten against the live system, and two things it assumed were wrong:

- **The pool is discovered, not configured.** `/demo/api/demos` is the JSON behind the management
  board and carries the roster, the cleanup state and the countdown. `benches:` in `config.yaml`
  is now an override for pinning a fixed box, and defaults to empty.
- **`POST /api/firstfactor` never authenticated.** It 302s to the OIDC gate, and the old probe
  scored a 302 as healthy — a false green in the module that exists to prevent false greens. The
  probe is the login flow now, cookie jar and all; without the jar it redirects forever (50 hops
  under curl, 6 with).
- **Row D8 is new**: not mid-cleanup, more than an hour of runway. It was inside n8n's prompt, so
  it never reached the parity matrix. `BenchProber.leasable()` owns it, separately from `poolUp`.

Run against the live pool the first time, this reproduced the defect of record immediately:

```
demostaging1   probe=healthy                                  board="✅ Ready · 2.6h remaining"
demostaging2   probe=unreachable  HTTP 500 from the login gate  board="✅ Ready · 18.6h remaining"
```

`yarn typecheck` clean, `yarn test` 120 passed (was 111), nothing committed.

**And one finding that changes M4**, read off `QjzNu9yWZ5005J7m` the same day: the audit's
`Webhook (programmatic)` declares no `responseMode`, so n8n answers `onReceived` and hands an
external caller nothing; the synchronous path is the `executeWorkflowTrigger` only n8n itself can
use; and `Return to caller` omits `report_markdown` anyway. M4 therefore recovers results through
the Docmost importer (recommended), or n8n's executions API, or by merging M4 into M5 and skipping
the seam. ARCHITECTURE §9 has all three.

---

## 5c. The n8n preflight, shipped 2026-08-19

The one sanctioned waiver of the no-n8n-edits rule, approved by the user. **Three nodes changed
across two live workflows**, each verified byte-identical against a locally syntax-checked and
behaviour-tested copy after applying:

| Node | Workflow | Change |
| --- | --- | --- |
| `Pick next target` | `uEmep2z22i5qv1OF` | reads `/demo/api/demos`, probes the real OIDC login flow on each candidate with `hoursUntilCleanup > 1` and `isProcessing !== true`, emits `demo_host`; none usable → `action='idle'` (no claim, no try) |
| `Mark in-progress` | `uEmep2z22i5qv1OF` | forwards `demo_host` in its return object |
| `Build prompt` | `QjzNu9yWZ5005J7m` | uses the supplied host verbatim; the fallback path now also tells the agent to confirm the login before using an instance |

**Backups** of both workflows as they were before the edit:
`/d/workspace/tmp-claude/n8n-backup-2026-08-19/`. The n8n MCP also exposes
`n8n_workflow_versions` with `rollback`.

**Tested before applying**, against the live pool, with a shim standing in for
`this.helpers.httpRequest`:

```
normal      -> host = https://demostaging1.inojob.com
               note = demostaging2 http-500 (17.8h), demostaging1 ok (1.8h)
no runway   -> idle, 'no usable demo bench — none of 2 with >999h left...'
all failing -> idle, 'no usable demo bench — demostaging2.inojob.com http-500 (17.8h)'
API down    -> audit proceeds, 'demo pool API unreadable — not gated'   (fails open)
```

**A correction to the case made for it.** I claimed every full audit was being steered into the
broken instance and failing. n8n's own 12:00 run that day says otherwise — its summary reads
*"Host demostaging1 (demostaging2 auth gateway 500)"*, so the agent was hitting the 500 and
falling back by itself, without being told to. The cost was a wasted first attempt per run, not a
failed audit. The change is still right — it removes an improvisation, makes the fallback an
instruction, and gates the all-dead case — but it was not stopping a fire.

The `demostaging2` 500 is independently corroborated by that summary, which is worth noting: it is
the agent, not Touchstone, reporting the same broken gate.

---

## 6. Reference — facts read off the running system

Cited so they can be re-checked when they drift. Read 2026-08-07.

| Thing | Value |
| --- | --- |
| Roll-up page | slug `B5ZBicxRSn`, page id `019f373d-c73f-7cdd-b720-3d26da849dbe` |
| Beacon / agent endpoint | `http://beacon-backend:9300/mcp` — shared with PR Review |
| Scheduling constants | `FRESH_DAYS=7`, `STUCK_DAYS=7`, `LEASE_MIN=120`, `COOLDOWN_MIN=55`, `MAX_TRIES=3` |
| Subject registry | `api.github.com/repos/Yundera/AppStore/contents/Apps`, dirs only; 55-entry `DEFAULT_APPS` as cold-start fallback |
| Demo board | `https://app.nasselle.com/demo/admin/manage` — reports `✅ Ready` while the login is broken |
| Demo pool API | `https://app.nasselle.com/demo/api/demos` — JSON: `id`, `url`, `isProcessing`, `lastCleanupSuccess`, `hoursUntilCleanup`. Two instances: `demostaging1`, `demostaging2` |
| Bench probe | **corrected 2026-08-19.** `POST /api/firstfactor` 302s to `/nhl-auth/oidc/login` and never authenticates — the old probe read that 302 as healthy. The probe is now the OIDC login flow from `/nhl-auth/oidc/login?redirect=/`, followed by hand with a cookie jar; only a final 200 is healthy |
| Bench claim rule | not mid-cleanup and **> 1h** `hoursUntilCleanup` — from n8n's prompt, now row D8 |
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
`src/server/domain/extract.ts`, which already do exactly that for imported Docmost pages.

---

## 7. Dev-loop gotchas

- **After a hand-run `yarn sync`, restart the container.** The index is built at boot. The
  in-process 15-minute importer added in P2 upserts into the live index and does not need this;
  the CLI does, because it is a different process.
- **`src/server/domain/extract.ts` defeats grep.** It contains a byte that makes grep treat the
  file as binary, so `grep -n "export" src/server/domain/extract.ts` prints *nothing at all* —
  not an error, not a zero count, just silence, which reads as "the symbol isn't there". Use
  `grep -a`. (It moved out of `tools/` in P2: `tsconfig.server.json` compiles only `src/`.)
- **Ports:** Vite 5173, API 8081. 8080 is the production default but is taken by ttyd in this
  container.
- **`yarn sync`, not `yarn import`.** `import` is a yarn-1 builtin and will not run the script.
