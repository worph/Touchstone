# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Touchstone is a **conformance agent**: it holds a versioned standard, runs *assays* against
*subjects* (apps in the Yundera AppStore), and issues a *hallmark* — the verdict a subject carries
until the next assay contradicts it. It was built to absorb exactly two workflows — the store QA
loop that drove the audits and the audit executor itself — and it has: Touchstone runs them now.
`AppStore PR Review` and release notes were never in scope and are somebody else's.

**The parity matrix in [docs/architecture.md §1.4](docs/architecture.md) is the record of what
that took**, and is still the first place to look before adding a capability: §1.4 G lists what
was **deliberately dropped** (findings-as-rows, rule codes, cross-subject aggregation, regression
detection, history views), and re-adding one of those is a decision rather than an oversight.
New capability beyond parity belongs in `docs/requirements.md`, numbered, with what it cost.

Vocabulary used throughout the code: **subject** (an app), **standard** (a versioned rubric),
**assay** (one run of one standard against one subject), **hallmark** (the composed verdict),
**target** (**a platform a verdict is about** — `yundera`, `foss`; `config.targets[]`. Not a
*capability*, which is what kind of resource a section needs (`bench`, `browser`), and not a
*pool*, which is where interchangeable instances come from. One string was all three until
2026-09-18, and the code had to sniff a `bench.` prefix to tell them apart. A rubric declares
`targets:` and is expanded by `sectionsOf()` into one section per platform — the **default
target keeps the bare section id** (`functional`), others get a composite (`functional@foss`) —
and every assay records `target`, so nothing parses an id to learn what it is about. **A section
is target-scoped iff its verdict is about a platform**: `static` judges bytes in a repo, so the
same compose read twice is one finding and it carries no target at all), **bench** (a leasable
demo instance of one target), **section** (one leaf of the protocol — one rubric, one
assay file; `static` and `functional` today, but the set is whatever `data/protocols/*.md`
declares), **alert** (a deduplicated environment condition), **origin** (an app store — one
`{repo, ref, apps_path}` a subject comes from, labelled "Store" in the UI; **not** `store/`,
which is the filesystem layer, and **not** `AssayStore`, which is the read interface the routes
take), **trial** (a one-shot audit of **one store zip and one app inside it** — a GitHub branch
archive, or files uploaded straight into a session — written under `data/trials/` and never read
by the report index, so it cannot move a hallmark. **Its subject need not be a subject**: any app
directory name in the archive is auditable, including one no store has ever offered, which is
what makes a new app checkable before anybody commits it. That is the line between the two verbs
— `run_assay` audits an app *a store offers*, a trial audits *bytes* — and it is the one a
caller gets wrong, so it is said in the admin MCP's `instructions`, in `run_assay`'s refusal and
in the chat prompt as well as here), **board** (the read-only public view of
every subject's hallmark, at `/public`, addressed to app authors rather than to the operator),
**executor** (who performs a section — `agent`, or a `*.sh` beside the protocol that declared it),
**reading** (what a section that *measures* produces rather than judging: `scores: false` in its
frontmatter, a badge and a table, invisible to the hallmark — `currency` is the first),
**control** (one configuration value that can be changed while Touchstone is *running* —
`domain/controls.ts` — as opposed to the rest of `config.yaml`, which is read once at boot; the
bar is mechanical, something live has to re-read the value, and the override lives in
`state/controls.json` so the file stays the default), **standard in force** (the revision of each
rubric that would judge a subject *today*, and when
that last changed — `domain/standards.ts`; a verdict reached under an older one carries an
`older standard` chip and stops waiting out `fresh_days`), **knowledge base** (supporting knowledge for an audit that is *not* the standard — how the
platform behaves, where an app documents its first credentials; `data/kb/*.md`, indexed by
`KB.md`, handed to the agent after the rubric under a fence saying the rubric governs on
conflict. It never judges, so it moves no verdict and re-eligibles nobody, and it is still
recorded: each assay carries `kb_sha256`), **delisted** (a subject the archive knows and a
*readable* store no longer offers — `SubjectRegistry.delisted()`. Not a verdict and not a
finding: it qualifies the subject rather than any assay of it. It keeps every report it earned
and its row on the Store page and the board, and it leaves `registry.list()`, which is also the
scheduler's candidate set — a withdrawn app would otherwise be picked as the stalest row for
ever, fail to fetch, and re-enter the backlog. Gated on `reachable()`, so an unreadable store
delists nobody), **request** (an operator asking for one
more audit of one subject — `SubjectSchedule.flagged_at`, the third way past the freshness window
and the only one that is not about the world changing. It is spent by the next attempt, whatever
that attempt concluded, so nothing has to remember to clear it. It **releases a park**, since
2026-08-31, because a park is an automatic judgement about a failing app and a person asking
outranks it. And since 2026-09-01 it **goes to the front**: requests are worked before the
backlog, in the order they were asked for, bypassing the cooldown but not the bench gate. The
field is still called `flagged_at` on disk and the events are still `SUBJECT_FLAGGED` —
identifiers are stable, vocabulary moved), **queue** (the requests, oldest ask first, audits and
trials in one line, served in ask order as (bench, browser) pairs come free — `policy.requests()`,
`GET /schedule`'s `requests`. Derived, except for its trial half; see invariant 8), **lease** (a
*(bench, browser)* pair one run holds for its whole duration — `services/leases.ts`. Since
2026-10 runs are concurrent and **capacity is whatever pairs are free**: two Yundera benches and
one browser is one run at a time, add a sidecar and it is two. Never a configured number. A pool
whose benches are all *held* is `full`, not `gated` — busy is not broken, and only `gated` feeds
the bench alert. Requirements §23), **workshop** (the one part of Touchstone that *makes*
rather than judges: it authors a change to one app's store listing against a leased bench,
validates it with trials, and opens it as a pull request under the configured GitHub account —
`services/workshop.ts`, docs/auto-app-pr.md, requirements §24), **proposal** (one such change
to one app, on its way to one PR; kind `fix`, `currency` or `wish`; it **never judges its own
work** — its verdicts are trials, so nothing it does moves a hallmark until a person merges),
**wish** (one operator-authored file in `data/wishlist/`, an existing Docker image to integrate
as a new listing — integration only, never writing an app), **task memory** (what the workshop
last tried for one task key and against which input; a task it gave up on waits for its input —
the app, the standard, the wish file — to change, the same way the standard moving re-eligibles
an app. Infra outcomes are never remembered).

**One verb, one word: `Audit`.** `AuditControl`, `POST /assays`. It writes a request and asks
the scheduler to look; the tick decides whether that means now or third in line, and the row
says which. Every live row on the Store table carries it, the subject page carries it, the
Automation queue carries it.

This is the third vocabulary and the last. It was five spellings for two actions until
2026-08-31 (`audit` / `re-assay` / `Run first assay` beside `flag for re-audit` / `flag`), then
two spellings for two actions — `assay now` took the agent, the flag queued — and that was still
wrong, because **the distinction was never the operator's to make**. Whether an audit starts now
or waits is a fact about the line, not a choice at the point of pressing. Worse, the verb that
always worked was the one that looked like it did nothing, and the two that read as decisive
(`assay now`, `run trial`) both failed with a 409 whenever anything else held the agent — so the
operator learned to press the ones that break. `flag_reaudit` is gone from the chat tools for the
same reason: it was a second spelling of `run_assay`.

A subject's identity is `<origin>~<name>` — `yundera~FileBrowser`. The separator is `~` because
it is unreserved in `encodeURIComponent` and therefore survives a URL untouched, which is what
lets every route keep the single-segment shape it already had. `src/shared/subject.ts` owns the
key, and `SubjectKey` is a branded type so the compiler catches a bare name used as a key.

`leg` is the old name for a section and survives only in report files written before
2026-08-20, in the two-column Overview, and in `Leg`/`LEGS` in `domain/hallmark.ts`. New code
says `section`. There is **no `depth`** in the sense that was removed: a run's section scope is derived by the
scheduler from what is due on one **line**, never supplied by a caller — `POST /assays` still
takes only a subject — and a section whose `requires:` cannot be satisfied is recorded blocked
rather than narrowing the run. `depth` was somebody at the point of pressing choosing to audit
half the rubric; a scope is the line's own answer to what is due on it, which is the same
distinction the `Audit` verb collapse made. A **line is a target**: a section with none rides the
default target's run, because its verdict does not depend on the platform and auditing it per
target would write one finding twice and double-count its risk.

## Commands

```bash
yarn dev            # concurrently: API (tsx watch, :8081) + Vite (:5173)
yarn dev:api        # API only
yarn dev:web        # Vite only
yarn build          # vite build → dist/web, then tsc -p tsconfig.server.json → dist/server
yarn start          # node dist/server/index.js  (serves API + SPA on one port)
yarn typecheck      # tsc --noEmit over src, test, vite.config.ts
yarn test           # vitest run
yarn test src/server/scheduler/policy.test.ts        # one file
yarn test -t 'reclaims a stale lease'                # one test by name
```

Tests live next to the code (`src/**/*.test.ts`) and in `test/` for archive-level tests over the
committed fixture corpus (`test/fixtures/reports/`). `vitest.config.ts` exists solely to override
`vite.config.ts`'s `root` (which is `src/web`) back to the repo root — do not delete it.

### Dev stack

`yarn dev` inside the claude-code container binds ports the Windows host browser cannot see
(`network_mode: host` = the Docker VM's network). Development therefore runs in a published-port
container:

```bash
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml logs -f
```

- **Vite 5173, API 8081.** 8080 is the production default but is taken by ttyd here; Vite proxies
  `/api` → 8081 to match.
- The compose file also runs Touchstone's **own** `browser-mcp` sidecars — `browser` on 9746 and
  `browser-2` on 9747 — not the shared box-wide `browsermcp`, and deliberately **without a
  profile volume** (see Invariants). Two sidecars are what let two audits run at once.
  `browser-2` is on its **own network**, not `service:dev`: the image hard-codes Xvfb `:99`,
  VNC 5900, websockify 6080 and CDP 9222, and a second instance in dev's namespace collides on
  all of them.
- `docker-compose.dev.yml` is development only. Production packaging is the AppShield sidecar
  stack in ARCHITECTURE.md §8 and is a separate file that does not exist yet.

## Architecture

One Fastify process. `src/server/index.ts` is the whole composition root: it seeds and loads
config, builds the index, constructs every service in dependency order, wires them **by callback
rather than an event bus**, registers routes under `/api/v1`, serves the built SPA, and starts the
timers. Read it first — it is the map.

```
scheduler (timer) ──dispatch──▶ runner ──MCP──▶ Claude Code agent
      │                            │      ──MCP──▶ browser-mcp sidecars
      │                            │      ──HTTPS─▶ demo benches
      └──▶ store (files + index) ◀─┘
           events → alerts → notify (push, best-effort outlets)
```

### Storage: files, no database

There is no DB, no Redis, no SQLite (the AppStore requires `architectures: [amd64, arm64]`, so no
native deps). Everything is files under `data/` (`TOUCHSTONE_DATA_DIR`, default `<repo>/data`):

| Path | What |
| --- | --- |
| `config.yaml` | hand-edited; seeded inert on first boot by `ensureConfigFile`. Displayed — redacted, never posted — by the lower section of the Settings page |
| `context.md` | the **administrator's standing instructions**, prepended to the chat's prompt every turn. Beside `config.yaml` rather than under `state/` because everything in there is regenerable and this is the one operator-authored string with no other copy. Written by the Settings page, gitignored |
| `github-token` | the workshop's GitHub token **as set on the Workshop page** — `store/githubtoken.ts`, `0600`. Overrides `github.token` / `TOUCHSTONE_GITHUB_TOKEN`; deleting it (or Clear) falls back to them. Beside `config.yaml` for `context.md`'s reason. Write-only over HTTP (`PUT|DELETE /workshop/github`) and deliberately not a control or chat tool, so the admin MCP cannot choose whose name PRs are opened under |
| `kb/KB.md`, `kb/*.md` | **the knowledge base** — what an auditor needs in order to *operate* the platform rather than to judge an app: routes, what a dialog does, where an app documents its first credentials. `KB.md` is the hand-written index; a page declaring `sections:` is given only to a run auditing one of them, and a run no page applies to is given nothing at all — an index describing pages the agent does not have is worse than silence. Appended to the prompt after the rubric, under a fence saying the rubric governs on conflict. It is **not** the standard: `domain/standards.ts` never reads it, so an edit puts no chip on a row and makes nobody eligible for re-audit — and it is still recorded, because it can change what an audit concludes |
| `kb/.history/` | the same append-only log the protocols have, over the KB. What makes an assay's `kb_sha256` resolve to bytes: the digest says *whether* the material moved, this log — being time-ordered — says what it said when a given assay ran |
| `protocols/*.sh` | **the procedure**, for a leaf whose `executor:` names one. A sibling of the rubric that declares it, on the volume, so a threshold or a registry URL is an edit rather than a rebuild. **No route can write one** — `save()` writes `${id}.md`, which is what keeps invariant 6 from widening into "a model cannot post code" |
| `protocols/.history/` | **what the rubric used to say** — `log.jsonl` plus a snapshot per revision, so the sha256 an assay recorded resolves to bytes. Swept at boot, after a save and before a run reads the protocol, so an edit made over SSH is recorded too (as `observed`, with no reason, which is the honest thing to show). Append-only and **not restorable through any route**: putting an old revision back is an ordinary save of that text, forward |
| `protocols/*.md` | **the rubric itself**, the definition of the sections, and — as the sha256 of the whole file, frontmatter included — the revision every assay records: a leaf's `id` is a section id, and its `order`, `requires`, `report_headings` and `requirements` are what the runner reads — the phase plan among them, derived from the requirements that carry a `phase:` rather than listed a second time (`phasesOf`). There is no separate `standards/` — a second file could only disagree with the rubric it versioned. A save replaces the **prose** and carries the frontmatter over as bytes, so an operator's YAML comments survive and no route can rewrite `executor:` |
| `reports/<origin>/<Subject>/<ISO>-<section>.md` | **the assay record IS the frontmatter of the report file**. The origin level is a namespace, not a uniqueness rule: two stores may both ship a `FileBrowser` |
| `trials/<slug>/<Subject>/<ISO>-<section>.md` | a **trial** — the same run against a store zip, written where the report index never looks, so it cannot move a hallmark or enter the backlog. The slug doubles as a synthetic origin, so the path machinery is unchanged |
| `trials/<slug>/store.zip` | that trial's own copy of the archive it audited, re-served at `/api/v1/trialstore/<store_token>.zip` for the bench to install. Inside the trial's directory because the index only ever picks up `*.md`, so it is invisible to it and dies with the trial |
| `uploads/<id>/` | a session's files — a **working copy**, not a whole app: a trial lays them over `Apps/<Subject>/` as the subject's origin has it and zips the result, so a file here replaces its counterpart and one that is absent is inherited. A sibling of `trials/`, never inside it: a trial's own directory is scanned as a report tree |
| `state/*.json`, `events.jsonl` | small mutable runtime state and the append-only log |
| `workshop/proposals/<id>/` | a proposal's **working copy**, content-addressed: `objects/<sha256>`, `base.json` and `work.json` (path → sha). A deletion is a missing key, which an upload session could never say; the trial zip and the commit are made from one map. Plus `evidence/` (the passing reports, copied so trial eviction cannot take a PR's evidence) and `feedback.md`. `workshop/author.md` is the operator's standing authoring instructions, seeded from `seed/workshop/` |
| `wishlist/*.md` | **the wishlist** — one file per app to integrate, operator-authored on the volume. No route or tool writes one. `_`-prefixed files are examples |
| `state/workshop.json` | proposals, task memory, and the `workshop.armed` override |
| `state/controls.json` | **what somebody changed while it was running** — the override for each *control*, re-applied at boot. `config.yaml` stays what a fresh install boots into, so deleting this one file puts every setting back. `scheduler.armed` is deliberately **not** here: the scheduler has kept that switch in `state/schedule.json` since the Automation page had a button, and two files claiming one switch is how they come to disagree |
| `state/index.json` | cache only — deleting it must always be safe |

**The whole of `data/` is gitignored, and `seed/` is what the repo tracks.** `seed/protocols/`
and `seed/kb/` are what a *fresh install* starts with: the image copies them to `/app/seed/` and
`ensureProtocolFiles` / `ensureKbFiles` copy them onto the volume on first boot, **never
overwriting**. So the tracked file is a default, not the live standard — a box edits its own the
moment anyone uses the editor, and the two are reconciled by a deliberate backport, never a sync.
Development takes the same path: a fresh checkout has no `data/`, so it seeds itself exactly as a
container does. `test/fixtures/` is committed.

**Rule: nothing outside `src/server/store/` touches the filesystem.** Routes, the scheduler and the
runner get the index or a store object, never a path. The thing being replaced failed partly
because its data access was smeared through two 200-line n8n Code nodes.

### The pieces

- **`store/index.ts`** — the in-memory `ReportIndex` over `reports/**`. Built at boot by parsing
  **frontmatter only**; bodies are read lazily per request by the viewer. `state/index.json` is an
  (size, mtime)-keyed cache; any doubt about an entry re-parses the file.
- **`scheduler/`** — `policy.ts` is the **pure** port of n8n's `Pick next target`
  (`busy → forced → cooldown → backlog empty → pick the stalest`; the bench gate sits *after* that
  chain, where the port put it so the pick could be diffed against the workflow it replaced). `record.ts` is the pure port of `Record result`.
  `index.ts` does all the world-reading and owns `state/schedule.json` and the timer.
  **Two picks live in `policy.ts`.** With `PolicyInput.free` (a lease registry wired, which
  production always has) `decideConcurrent` walks the queue — requests by ask time, then the
  backlog — starting one run per free pair, each **line holding at its own head** and waiting
  out its **own** cooldown (`last_finished_by_line`). Without it, `decideSingle` is the old
  single-flight pick, kept so a rig with no lease registry cannot start two runs onto one bench.
  The tick **reserves** each pair synchronously before handing the job over (the runner's
  `execute()` awaits before it resolves capabilities, and a tick in that gap would double-book),
  and `Runner.run()` **releases** it on every exit path. `record()` takes the line from the job:
  one subject may hold claims on both platforms at once.
- **`store/revisions.ts`** — the protocol's history. Identity is the **sha256 of the file**,
  for a rubric and its script alike; this is what makes that hash resolve to bytes. The sweep
  reads what is on disk rather than hooking the save, which is the only way an edit made over
  SSH is ever seen. There is no restore verb — see invariant 9 and `routes/protocols.ts`.
- **`store/protocols.ts`** — the protocol files, and `sectionsOf()`, which turns the leaves into
  the `ProtocolSection[]` every other piece reads. This is the **only** place frontmatter is
  interpreted, so a new field has exactly one place to be understood.
- **`domain/protocoledit.ts`** — the one path a protocol is saved by. A save is three things
  that have to happen together — replace the prose, sweep the history so the bytes are recorded
  *with the reason*, log `PROTOCOL_EDITED` — and there are now two callers: `PUT /protocols/:id`
  and the chat's `edit_protocol`. A second caller that forgot the sweep would leave the edit
  recorded as `observed`, with nothing to say for itself, which is the hole the history exists
  to close. `via` is a label on the row, never a permission: what a chat may save is what the
  editor may save, because it is the same function.
- **`services/storedoc.ts`** — reads a file out of a **configured** origin's repo, at its pinned
  ref, through the same builder the app list uses (`contentUrlFor`). Deliberately not a second
  `trialstore.ts`: the host is a constant here and the repo comes from `config.yaml`, so a
  caller supplies only a path and there is no request-forgery primitive to build. It reads
  GitHub unauthenticated — public repos only, no credential to exfiltrate — and caches for five
  minutes because that 60-an-hour budget is `store/registry.ts`'s too, and an origin driven
  unreachable stops the runner dispatching.
- **`runner/`** — `prompt.ts` (assembles the sections being run into the prompt), `agent.ts` (the
  MCP call plus n8n's exact failure classification: `agent-auth` / `agent-busy` / `agent-error` /
  `parse-failed`), `index.ts` (one job in, one assay file per section out, a `RunOutcome` back).
  `execute()` resolves sections → capabilities → what runs and what is recorded blocked; there is
  no depth parameter anywhere in the chain.
- **`services/ledger.ts` + `routes/mcp.ts`** — the callback surface the agent uses to record each
  requirement *as it settles it*, so a run that dies at requirement 12 of 16 keeps twelve results.
  It also resolves each record's **section** from the canonical list, which is what lets one
  agent response become one assay per section without parsing the prose for headings.
- **the re-audit flag** — `SubjectSchedule.flagged_at`, `POST /schedule/flag`,
  `Scheduler.setFlagged()`, `isFlaggedForReaudit()` in `policy.ts`. The **third** way past the
  freshness window, beside the standard moving and the app changing, and the only one that is
  not about the world: an operator saying *look at this one again*. It exists because a
  `blocked` section stamps nothing and costs nothing (invariant 3) while a *sibling* section
  that completed sets the last-run date, so the whole subject reads fresh on the strength of
  the half of the audit that ran — and no automatic rule may fix that, because one that made
  a blocked section eligible would re-pick that app every cooldown until the bench came back
  and starve the other 72. It is a **timestamp, not a boolean**, and it stops counting once a
  later *attempt* exists: the next look spends it whatever that look concluded, nothing has to
  remember to clear it, and a flag set while a run is already in flight survives that run
  (the comparison is against the attempt's **start**). `record.ts` therefore never clears it —
  a finisher cannot tell whether the flag arrived before it started. **Unlike** the other two
  it goes to the *front*: a rubric edit and a compose change are facts about the world and can
  wait for the rotation, while a request is a person waiting for an answer. It bypasses the
  cooldown and releases a park; it does not bypass the bench gate, which holds the whole line
  rather than skipping — a request that cannot run says why instead of producing a verdict about
  half the rubric. `POST /assays` is now the only thing that writes it, so there is one verb.
- **`routes/mcp-admin.ts`** — the *same* eighteen tools, served as an MCP server at
  `POST /api/v1/mcp/admin` so an agent can ask them: it renders `CHAT_TOOLS` into `tools/list`
  and hands `tools/call` to the same handlers with the chat's own `ChatToolContext`. It also
  carries the surface's `instructions` — what `initialize` returns, read once before any tool
  description. That block exists for the one thing a description cannot say: **which** tool a
  question belongs to. Each description argues for its own tool and is read alone, so a caller
  that reached for the wrong one is refused by the wrong one and never sees the right one's
  text; keep it to that fork (audit an app a store offers, versus trial bytes) rather than
  letting it grow into a summary of eighteen tools that then has to be kept in step with them. There is
  no second definition of what an agent may ask this app, which is the point — a second one
  would be a second thing to keep in step with invariant 6. **Off unless `admin_mcp.enabled`**,
  and disabled it registers no route at all: it is meant to be beaconified into an aggregator
  that authenticates nobody, so turning it on is a statement about the box. `read_only` drops
  every tool marked `writes` (`run_assay`, `open_trial`, `run_trial`, `edit_protocol`,
  `set_control`) from the list *and*
  refuses them if asked for anyway — the filter reads the mark rather than a list of names,
  so a new write tool is covered the day it lands; `token` is a bearer a beaconify sidecar can inject. `routes/rpc.ts` is the MCP
  envelope both surfaces share — `initialize`, `tools/list`, `tools/call`, and a `202` for the
  notification, which is what a discovery client waits for.
- **`store/kb.ts`** — the knowledge base. It exists because `functional.md` was 24 KB and a
  third of it described Maison rather than the gate: every fact about the dashboard read as one
  more thing apps were judged on, and a fact learned the hard way could only be recorded by
  editing the standard — which re-versions it and re-eligibles every subject. So reference
  material is a **sibling** of `protocols/`, never a folder inside it (that directory is scanned
  for sections and executors), it mints no section and carries no requirements, and the runner
  selects per run from `sections:` so a static-only audit carries nothing about a dashboard it
  will not open. `forSections()` returns **null** when the volume has no KB — the prompt is then
  byte-for-byte what it was before one existed.
- **`services/workshop.ts` + `store/workshop.ts` + `services/github.ts` + `routes/mcp-workshop.ts`**
  — the workshop (requirements §24, docs/auto-app-pr.md). `github.ts` is **the only code that
  writes to GitHub**, and `main` on the store is unprotected, so its guard is the guard: every
  ref write goes through `assertOwnRef` (only `refs/heads/touchstone/<kind>/<App>-…`), there is
  no update-ref call, and the token is scrubbed from every error. `mcp-workshop.ts` is the
  author's surface — edit the working copy, `stage` it for the bench, end with `submit` or
  `cannot` — and is a **separate route** from `/mcp` so the auditor never sees `write_file` and
  the author never sees `record_requirement`. The scheduler offers the workshop a slot **last**
  (`PolicyInput.workshop`): never while a request is queued or running, and for idle work never
  while an audit runs or armed backlog is due. Validation is one trial per scoring target,
  derived from the protocol; `TrialRunDeps.finished(slug)` is how a round learns it ended.
  Pure rules — `judgeValidation`, `quota`, `refFor`, `candidates` — are in `domain/workshop.ts`.
- **`domain/fixreport.ts`** — the audit composed into a brief for whoever has to fix the app,
  served as markdown by `GET /subjects/:name/fix.md`. It **quotes**: findings, severities,
  evidence and remedies all come out of the frontmatter, and where the agent proposed no remedy
  the report says so rather than inventing one.
- **`domain/standards.ts`** — the standard **in force**, and the one place the recorded
  `standard_sha256` is read back. It answers two questions from one read, and keeping them
  apart is the whole design: `sections` (each rubric's hash now) is compared against the sha
  the last **verdict** carries, which is what puts an `older standard` chip on a row; `moved_at`
  (when the judging set last changed) is compared against the subject's last **attempt**, which
  is what makes it eligible for re-audit without waiting out `fresh_days`. They cannot be one
  predicate: a permanently blocked section keeps its old `done` record for ever, so a scheduler
  reading verdicts would re-pick that subject every cooldown until somebody fixed the bench —
  attempting has to settle the scheduling question even when the attempt blocked, while the chip
  goes on qualifying the verdict on display. `scores: false` sections cannot move `moved_at`
  (invariant 12) and a `seed` revision is not an edit, so a first boot does not re-eligible the
  archive. The orchestrator counts and carries no chip: its prose is in the prompt, but no assay
  records its hash, so re-eligibility is derivable and a badge would be invented.
- **`store/registry.ts`** — one list per configured origin, so one store's GitHub outage cannot
  empty another's. `reachable()` means *the last fetch succeeded*, and the runner asks it before
  dispatching: auditing against a store we cannot read would error and burn the subject's try
  for an infra condition, which invariant 3 forbids.
  It also carries **what version of each app the store offers** — the git blob sha of
  `<apps_path>/<App>/docker-compose.yml` — from **one** `git/trees/{ref}?recursive=1` call per
  origin per refresh. Not `commits?path=` per app: that is 69 requests against a 60-an-hour
  unauthenticated ceiling shared with `services/storedoc.ts`, and an origin driven unreachable
  stops the runner dispatching, so the naive version would break auditing rather than sharpen
  it. Not the app **directory**'s sha either, though the contents listing already carries it
  free — a directory is the compose plus ~3 MB of icon and screenshots, so a screenshot refresh
  would re-audit the app. The tree fetch runs *after* the app list and cannot fail the refresh:
  the list is what gates dispatch, and a version lookup is not allowed to stop an audit.
  It also answers **which archived subjects the store has stopped offering** — `delisted()`,
  gated on `reachable()` so an outage delists nobody, and subtracted from `list()` so a
  withdrawn app leaves the backlog rather than being picked, failing to fetch and re-picked for
  ever. `DELETE /subjects/:name` (`routes/index.ts` → `ReportIndex.purgeSubject`) is the only
  thing that ever takes a report out of the archive, and it refuses any subject `isDelisted()`
  does not name — which is what makes it safe to put a button on.
- **`routes/public.ts`** — `/public/subjects`, one subject, and its `fix.md`: the only prefix meant
  to be readable by somebody who does not operate Touchstone, and therefore the only one that may
  be excluded from the SSO sidecar (ARCHITECTURE §8.1). It is **read-only by construction** — an
  `onRoute` hook throws at boot on any verb but GET/HEAD — and it composes nothing of its own:
  `hallmarks()` and `buildFixReport()`, the same functions the operator routes call. There is no
  public report-file endpoint, so it hands out no address it will not serve.
- **`store/trials.ts` + `routes/trials.ts` + `services/trialrun.ts` + `services/trialstore.ts`** —
  trials. **One input**: a store zip and an app inside it. An upload session is a way of
  *producing* that zip rather than a second kind of trial, so past `buildSpec` there is one
  record, one slug and one pipeline. A store zip is both halves of an audit at once — the files
  the static section reads and the bytes the bench installs — which is why the collapse also
  removed a correctness problem: a ref trial used to read its bytes from a place the bench never
  installed from. Every trial saves the archive it fetched and serves *that*, so Maison's
  in-process store cache can never hold an older copy (the URL is minted per trial).
  **An upload session is an overlay, not the app** (2026-09-07): `buildSpec` fetches
  `Apps/<Subject>/` from the subject's own origin and `zipStore` lays the session over it, so the
  files the prompt lists and the files the bench installs both inherit whatever the caller did not
  send. That is one `Map`, deliberately — inheriting into the prompt but not the served zip would
  have the auditor reading an icon the running app does not have. Inheritance is best-effort and
  never a precondition: an app no origin offers, an unreachable origin and a rate limit all fall
  back to the session's own bytes, which is what shipped before it existed. The index
  over trials is built per request with `cacheFile: null`, because `defaultCacheFile()` resolves
  to the *same* path for `data/reports` and `data/trials`.
  `services/trialstore.ts` is **the only place Touchstone dereferences a caller-chosen URL**, so
  it is the only place with a host allowlist (GitHub archives + `trials.public_base_url`), a
  re-check at every redirect hop, and a byte cap enforced on what arrived rather than on what
  `content-length` claimed. Widening that allowlist turns "audit this store" into a request
  forgery primitive, because `run_trial` is reachable from an admin MCP that authenticates
  nobody.
- **`runner/exec.ts` + `domain/scripted.ts`** — the second executor. A leaf declaring
  `executor: currency.sh` is performed by that file: input on **stdin** (never argv — subject
  names come from a GitHub directory listing), one JSON object back on stdout, and the same
  `{meta, body}` the agent path produces. `exec.ts` is the contract and the sandbox (timeout, its
  own process group, stdout cap, a minimal environment); `scripted.ts` composes the assay and
  enforces the two rules that matter — **a script never declares a verdict** (it records
  requirements and Touchstone computes the gate) and **a failure to look is `blocked`**, whether
  the script said so or died saying nothing. It knows a section produced rows and a badge; it does
  not know what an image is, which is what lets the next deterministic check be two files on the
  volume. `data/protocols/currency.{md,sh}` is the first one — REQUIREMENTS §14.
- **`domain/controls.ts` + `store/controls.ts` + `routes/controls.ts`** — **the configuration an
  administrator may change without a restart.** `domain/controls.ts` is the only place that knows
  what a control *means* — its label, range, live setter and the sentence saying what changing it
  does — and the routes, the chat's two tools and the Automation page all render that one array,
  so a new control appears on three surfaces with no edit to any of them. The bar for being a
  control is mechanical: **something live has to read the value again later.**
  `scheduler.fresh_days` is read every tick and qualifies; `runner.agent_url` is captured when the
  Runner is built and does not, which is why it is not on the list and why putting it there would
  recreate exactly the lie `routes/settings.ts` refuses to tell. A write goes to the *live object*
  first and the file second — a setter that threw must not leave a stored value the next boot
  would apply. Every change is a `CONTROL_CHANGED` row naming the key, both values and the `by`;
  `set_control` is marked `writes`, so an admin MCP under `read_only` cannot disarm the loop.
- **`store/context.ts` + `routes/settings.ts`** — the two things about *this instance* the app
  shows you. The context prompt is the half Touchstone owns and a page may write; `config.yaml`
  is the half a person edits on the volume and is **read-only here on purpose** — it is loaded
  once at boot and handed to the services as values, so a save button would change a file
  without changing behaviour. `redactConfig` (in `store/config.ts`) masks on **key names**
  rather than values, because `config.yaml` merges over the defaults with an index signature:
  whatever an operator puts in it otherwise comes straight back out of `GET /config`.
- **`services/ports.ts`** — probes the two non-bench dependencies (agent, browser) by `tools/list`
  over MCP, and a **browser by one more thing on top**: `tools/list` is served by the sidecar's
  Node wrapper, which stays up and cheerful while Chrome is unreachable underneath it. So
  `browserLiveness()` reads the sidecar's own `/api/status` and `/api/health` and downgrades the
  port on a **positive** wedge signal only — health claiming `chrome: running` while nothing can
  be driven, or the sidecar saying `wedged`/`failing` itself. `running: false` alone is *not* a
  fault: it is the normal state after the idle reaper frees Chrome's RSS, and reading it as an
  outage would block every functional section between audits. Anything unreadable — a 404, an
  endpoint that is not ours — is "cannot tell", never "broken". This is the gate that was missing
  on 2026-08-24, when a CDP-wedged sidecar answered `tools/list` for a week and six audits were
  dispatched into it. `services/bench.ts` keeps its own prober because the bench pool is
  **discovered** from the pool API, not configured.
- **`services/events.ts` → `alerts.ts` → `notify.ts` / `push.ts`** — the local log is
  authoritative; alerts dedup an environment condition to one row; outlets and push are
  best-effort. An alert and its event must not *both* route to an outlet, or one condition
  sends two notifications and the dedup buys nothing — which is why `AGENT_UNAUTHENTICATED` is
  `{ beacon: false, push: false }` in `ROUTES` now that `agent.auth` exists. **`agent.auth` is
  opened by the runner, not by a prober**, and that is not an oversight in `ports.ts`: its
  probe is `tools/list`, which a Claude Code endpoint answers perfectly well while its session
  is dead, so the only code that ever learns the truth is the code making the call. It is the
  same shape as the browser wedge `browserLiveness()` exists for — a wrapper answering
  cheerfully while the thing underneath is broken.
- **`src/server/chat/`** — the administrator chat: a bounded turn loop (`loop.ts`, 8 calls and
  120 s), file-backed threads (`thread.ts` → `state/chat/*.jsonl`), eighteen tools wrapping the
  API (`registry.ts`), and the agent call (`driver.ts`) reusing `postToAgent` from the runner.
  Thirteen of the eighteen **read** (`get_workshop` is the thirteenth; the workshop's verbs are
  deliberately *not* tools — they open pull requests under a person's identity), and most of those read what is *written down* — the board, the
  archive, a report file, the fix brief, the log, the backlog — not the live process, which a
  `tsx watch` restart empties while the operator is still waiting for the run it started
  (HANDOFF §5k). Four of them are the same question at four depths, which is why their
  descriptions work so hard to stay distinct: `get_board` (every app), `get_subject` (one
  app), `get_fix_brief` (its findings), `get_report` (the file, and the only place the
  evidence behind a *passing* requirement survives). The five that act are `run_assay`, the
  trial pair `open_trial` / `run_trial`, `edit_protocol` and `set_control`. There were six
  until 2026-09-01: `flag_reaudit` asked for an app to be audited *again* while `run_assay`
  asked for it *now*, and the request queue collapsed the two — whether it starts now is the
  line's answer, not the caller's. A run asked for in a turn appends a `note` row back into
  that thread when it finishes, so the conversation knows what became of its own work; because
  the run may start minutes later from a tick, the thread is held in an in-memory map in the
  composition root rather than carried through the request, which is one timestamp with
  nowhere to put a conversation id.
  **`get_protocol` / `get_store_file` / `edit_protocol` are the standard and the store it
  tracks.** They exist because "are the protocols still current against the AppStore's
  CONTRIBUTING.md?" was unanswerable: the chat could see neither side and inferred from
  clauses that recent audits happened to quote. `get_store_file` is *not* a URL fetcher — the
  host is a constant, the repo and ref come from `config.yaml`, and the caller supplies only a
  path, which is why `services/trialstore.ts` remains the only place a caller-chosen URL is
  dereferenced. It caches for five minutes because unauthenticated GitHub allows 60 requests
  an hour and `store/registry.ts` spends from the same budget: a chatty turn must not be able
  to make an origin unreachable and stop the runner (invariant 3). `edit_protocol` prefers an
  anchored `find`/`replace` over a whole body — `functional.md` is 27 KB, and a rewrite that
  drops a paragraph is indistinguishable from one that meant to.
  `prompt.md` is an asset — `build:api` copies it into `dist/`, so a new non-TS file there
  needs the same treatment. It carries a `{{CONTEXT}}` placeholder for the operator's own
  standing instructions (`data/context.md`, edited on Settings), read **once per turn** and
  substituted **last** — a context containing `{{HISTORY}}` must reach the model as those
  characters rather than as the conversation. No tool reads or writes it: standing instructions
  a model can rewrite are not standing instructions.
- **`src/web/`** — React + Vite SPA in **two frames**. The operator frame is `Shell` and eight pages (Workshop at `/workshop` is the eighth; Configuration folded into Settings)
  (Administrator chat at `/`, **Store** at `/store`, Subject detail, Automation, Activity,
  Trials, Settings at `/settings` — the context prompt above the read-only `config.yaml`, which was its own Configuration page until 2026-10-05; `/config` redirects) plus Protocols — the chat is the front page and therefore has no nav row of its own,
  the brand being the way back to it; `/chat` redirects to `/`. The
  **public frame** is `PublicFrame` and two read-only pages under `/public` (the board and one
  app), addressed to app authors rather than to the operator. `main.tsx` splits them with two
  layout routes rather than a flag, so a public page cannot render operator chrome — it is not in
  its tree. `components/SubjectTable.tsx` is shared by both tables on purpose: an author must be
  reading the operator's verdicts, not a restyled copy of them — which is why the Store page's
  per-row control is an `action` render prop the *caller* supplies rather than a flag
  the table reads: the board passes nothing, so the column is not in its DOM at all
  (invariant 10). That control is **`AuditControl`** (variant `row`), or a delete on a delisted
  row. Every live row carries it now: the reason it could not before was that a control seizing
  the single agent made seventy-three rows into seventy-two disabled buttons and one footgun,
  and a control that *queues* is safe on all of them. Its state comes from a `GET /schedule`
  join rather than from `SubjectState`, because a field on the row type would also be a field on
  `/public/subjects`, and a board addressed to app authors must not publish which of their apps
  the operator has queued. The **Store page is the former Overview**, answering a different question:
  `GET /subjects` returns the union of the registry and the archive, so an app that has never
  been audited gets a row and a button instead of being missing — 52 of 72 apps were invisible
  to the operator while that route composed `store.all()` alone. `/public/subjects` still does
  compose the archive alone, deliberately: a board addressed to app authors must not publish a
  backlog with their name on it. `/overview` redirects to `/store`.
  `src/web/data/client.ts` is the only thing that talks to the API,
  and `data/runStatus.ts` is the **single poller** for the run in flight — the shell strip, the
  Store page's `◴ running` cells and audit buttons, and Activity's card, all subscribe to it rather
  than polling `/assays/current` themselves. `@shared/*` aliases
  `src/shared/` in both the Vite and Vitest configs; the server imports it with `.js` specifiers.
  Hand-written CSS, no framework: **every colour is a token in `styles/base.css`** — the light
  "desk" palette is Newsdesk's, and the `prefers-color-scheme: dark` block below it redefines the
  same names and nothing else. A hard-coded hex anywhere else is a bug; `components.css` and
  `markdown.css` only ever reference the tokens. `components/Shell.tsx` owns the sidebar, the
  phone header and the tab bar.

## Invariants — do not "fix" these

1. **The agent's declaration is authoritative.** Verdict, tier and risk come from the headline /
   the agent's JSON contract, parsed once. Nothing re-derives them from prose. A previous importer
   did derive them and silently promoted four Critical apps to `compliant`.
2. **Sections are independent, and nothing enumerates them in code.** The set of sections comes
   from the protocol files; a missing capability costs exactly the sections that declared
   `requires: [that capability]`, and each is written `blocked` on its own while the rest of the
   run proceeds. Adding `data/protocols/security.md` adds a section, with no code change.
3. **No infra condition consumes a subject's retry budget or produces a verdict about the subject.**
   `agent_busy`, an unclaimable bench and — since 2026-08-31 — `agent_auth` restore the subject
   *untouched*: no try burned. This is the rule that keeps an outage from parking thirteen
   innocent apps, and `agent-auth` was violating it for as long as it existed, which is what
   parked `UptimeKuma` for a week over an agent that was never logged out. Every other
   completion — **including an errored one** — stamps the finish time, or a reliably failing app
   starves the whole backlog by staying the stalest row forever. `agent_auth` is the one hybrid
   and deliberately so: free, but it *does* stamp the finish, because unlike a 409 it has
   already spent a full agent call, and without the cooldown anchor a dead endpoint would be
   marched through the whole registry one 26-minute failure at a time.
4. **`blocked` is never a statement about the subject.** It means infra prevented the assay, or
   that the agent's answer could not be used (`agent_error`, `parse_failed`) — never that
   anything is wrong with the app.
5. **The browser profile is ephemeral, by design.** No volume on the browser sidecar: a surviving
   session cookie makes an unprotected app look protected on the one check that catches auth
   bypass. This is the single deliberate divergence from Newsdesk's packaging.
6. **Nothing an agent or a model can call may write a verdict, or mint a section** — not the
   assay MCP surface (`routes/mcp.ts` has no `record_result`) and not the chat's tool registry.
   A canonical id's section comes from the protocol that listed it, and a section the agent
   invents is recorded against the run's primary section and marked `unlisted`: a section the
   gate does not know to read is a place a Critical could hide. The agent judges each
   requirement; Touchstone computes the gate (any Critical ⇒ non-compliant, unconditionally). An
   agent that can post its own verdict makes the rubric advisory.
   Since 2026-08-23 the chat *may* edit a rubric's **prose** (`edit_protocol`), and that does
   not widen this: `ProtocolStore.save()` carries the frontmatter over as bytes rather than
   re-emitting it, so no caller can mint a section, name an `executor:` or flip `scores:`. What
   an edit moves is what the **next** audit is judged by — recorded as a revision with a
   required reason, and dropped entirely from the admin MCP under `read_only`. It cannot move
   an audit that has already run.
7. **The app stays diagnosable with every outbound port broken.** Activity must render with Beacon
   unreachable and push unconfigured.
8. **There is no queue of work the loop invented for itself.** The backlog is re-derived from
   last-run on every tick, so it cannot drift. What an operator *asks* for is a queue, and
   since 2026-09-01 there is one — but the audit half of it is still derived, not stored: a
   subject is in the line exactly while its `flagged_at` is newer than its last attempt, which
   is the same predicate the pick uses and the same one the button reads back. Nothing has to
   remember to remove anything, and a run killed mid-flight leaves the request correctly still
   queued. **Trials are the deliberate exception**: a trial has no subject row and no attempt
   record to spend a timestamp against, so its place in the line is a fact on disk
   (`began_at` unset). That is a decision, recorded here, not an oversight — `shared/trials.ts`
   used to cite this invariant as the reason a queue could not exist at all.
9. **Every assay records the standard *revision* that judged it, and that revision is
   retrievable.** The identity is the sha256 of the protocol file — and of the executor when a
   script performed it — not a number the file carries. An integer only moved when somebody
   used the editor, moved whether or not the content changed, and named text that no longer
   existed; `store/revisions.ts` keeps the bytes, so the hash resolves.
10. **`/public` is read-only, and not by convention.** Nothing under that prefix — route or page —
    may write, and the check is at boot rather than at review time. It is the surface app authors
    see, so it is also the one place where an accidental control would be reachable by somebody
    with no account. Anything the board needs is a GET or it does not ship.
11. **An executor is a `*.sh` beside the protocol that names it, and nothing else.** No path, no
    inline script, no interpreter choice, and — the load-bearing half — **no route may write
    one**. `PUT /protocols/:id` writes `${id}.md`, so the admin MCP that authenticates nobody
    cannot put code on disk however it edits a rubric. An executor that fails the name check is
    recorded `blocked`, never downgraded to the agent: a typo in one character would otherwise
    turn a deterministic check into a model guessing at the same question, and the archive would
    look identical.
12. **`scores: false` means invisible to the hallmark, in all three senses.** Not summed into
    risk, not allowed to set `age_days`, and not allowed to move the backlog. The second is the
    subtle one: a currency reading takes six seconds and rides every audit, so if it could stamp
    freshness then every app would read as recently *audited* the moment it was *measured*. The
    third followed it — an edit to a reading's rubric or script does not make subjects eligible
    for re-audit (`domain/standards.ts`), or a threshold change in `currency.sh` would spend
    three days of agent time re-running full audits to re-measure something the next ordinary
    run re-measures for free.
13. **The knowledge base never judges.** It is handed to the agent after the rubric, under a
    fence saying the rubric governs on conflict, and it may not add a requirement, excuse one,
    or decide a verdict. Two things follow and both are load-bearing: it is **not** the standard
    (no chip, no re-eligibility — an edit to a reference page must not spend three days of agent
    time re-auditing 72 apps, which is invariant 12's argument again), and it is **still
    recorded** (`kb_sha256` on every assay the agent produced, bytes in `data/kb/.history/`),
    because a page that changes what an audit concludes while leaving no trace is the "the
    archive says v7 and no v7 exists" problem wearing a different hat. When a KB page turns out
    to be deciding something — *credentials in Tips count as documented* — that sentence belongs
    in the protocol, as a revision with a reason. The KB says where to look; the rubric says
    what makes it a pass.

14. **Only a delisted subject may be deleted, and no model may delete one.** The archive is
    permanent by design; `DELETE /subjects/:name` is the single hole in that, and the guard is
    `SubjectRegistry.isDelisted()` — the store was *read* and does not list this app. So a live
    app cannot be purged by a mistyped name, and during a store outage nothing is deletable at
    all, because an unreadable store delists nobody. The verb is HTTP-only: `CHAT_TOOLS` has no
    delete and therefore neither does the admin MCP, by invariant 6's neighbouring argument —
    an irreversible delete over a surface that authenticates nobody is not handed out for
    symmetry. It logs `SUBJECT_PURGED` at `warn`, because the archive was the only record that
    the app was ever audited.
14. **Charging a try implies writing an attempt record.** An outcome either costs the subject
    nothing and records nothing, or costs a try and leaves a record `lastAttemptAt` can see.
    Never one without the other. The scheduler holds *two* answers to "did we attempt this
    app?" — `try_n`/`parked_at` in `state/schedule.json`, and `lastAttemptAt` derived from the
    archive — and a failed run used to move the first and not the second. Everything that asks
    "have we looked since X" reads the second: the re-audit flag, `standardMoved`,
    `subjectChanged`. So a charged failure walked a subject toward parking while its flag
    stayed set for ever, its `older standard` chip never cleared and no rule would re-audit it.
    `Runner.recordAttempt` closes it by writing one `blocked` assay per section — which is why
    invariant 4 now names two reasons that are not infrastructure. The converse holds too:
    `agent_auth` charges nothing, so it records nothing, or an outage would spend every
    subject's flag on runs that established nothing.

## Safety switches (all three default off)

- `scheduler.armed: false` — the tick still runs, decides and logs every hour, and **works no
  backlog**. Since 2026-08-20 it is also settable at runtime from the Automation page, which
  persists an **override** into `state/schedule.json`; absent, the config value stands. Stopping
  means "claim nothing further" and deliberately leaves the audit in flight alone.
  **It gates the backlog and nothing else.** Requested audits and trials still drain while it is
  off, which is not new behaviour dressed up — `POST /assays` never consulted this switch — but
  it is newly *visible*, so the Automation page says so on the switch itself. The switch stops
  the loop helping itself; it is not a lock on the agent, and an operator who disarms and then
  presses Audit is asking for that one audit. It is therefore **no longer a dry run** in the
  sense the cutover used: to stop everything, disarm *and* clear the queue.
- `runner.enabled: false` — refuses every job and says so, and is the one condition `POST /assays`
  and `POST /trials` still **refuse rather than queue**: it is off on purpose, waiting does not
  fix it, and a request enqueued into work that can never run would sit at the head of the line
  for ever. Validation is a **single hand-run assay**
  through `POST /api/v1/assays`, never a loop: other work shares this agent endpoint, and two
  systems auditing at once contend for it. Since 2026-08-25 it is settable
  at runtime too, as a **control** — the override is `state/controls.json`'s, the config value is
  still what a fresh boot falls back to, and the flag is read when a job arrives, so turning it off
  leaves the audit in flight alone.

- `workshop.armed: false` — the workshop authors only what a person proposes and opens a pull
  request only when a person presses Open PR. Armed, it picks its own work when the queue is
  quiet and submits ready proposals within `workshop.prs_per_day`. Persisted in
  `state/workshop.json`. **Operator-only**: it and `workshop.prs_per_day` carry
  `ControlDef.operatorOnly`, so the chat's `set_control` — and therefore the admin MCP —
  refuses them. Arming it is how pull requests under a person's GitHub identity start being
  opened, and no model may cause that.

The first two are therefore reachable from the Automation page, from the chat (`set_control`) and — unless
`admin_mcp.read_only` — over the admin MCP; the third only from the Workshop and Automation pages. That is deliberate, and it does not change the rule
below: **do not arm or disarm any of them without the user's say-so** — and never raise
`workshop.prs_per_day` or press Open PR on a live box without it either. Touchstone is what drives the
audits now, so a switch flipped in passing is not a dry run any more — it is the loop.

## Gotchas

- **`src/server/domain/extract.ts` defeats grep.** It contains a byte that makes grep treat the
  file as binary, so `grep -n export src/server/domain/extract.ts` prints *nothing at all* — not an
  error, just silence, which reads as "the symbol isn't there". Use `grep -a`.
- **Restarting `dev` orphans the browser sidecar.** `browser` runs in the dev container's
  network namespace (`network_mode: service:dev`), so
  `docker compose -f docker-compose.dev.yml restart dev` leaves it attached to a namespace that
  no longer exists: the container still reports healthy, and `/benches` reports `browser-1`
  `unreachable` with `fetch failed`. Restart `browser` too, then `POST /api/v1/benches/probe`.
  A run started in that state records the sections that need a browser as blocked — which is
  correct, and is not the app's fault.
- **The index is built at boot.** Anything that changes report files from another process needs an
  API restart to be visible.
- **`yarn dev` runs the API under `tsx watch`, so any edit under `src/server/` restarts it and
  kills every audit in flight** — several now — no report, no completion event, and the agent
  goes on recording against a ledger token that no longer exists. Finish server edits before
  dispatching a run.
- The repo layout listed in IMPLEMENTATION.md §3 predates P2–P4 and names files that no longer
  exist (`scheduler/tick.ts`, `eligibility.ts`, `lease.ts`, `services/browser.ts`, `tools/import.ts`).
  The tree on disk is the truth; the doc's *rules* still hold.
- `noUncheckedIndexedAccess` is on. Indexed reads are `T | undefined`.
- Report filenames use ISO-8601 with `:` → `-` so they sort lexically and are portable.

## Documents

| File | What it is for |
| --- | --- |
| `README.md` | what Touchstone is, what it replaces, why |
| `docs/architecture.md` | **the parity matrix (§1.4), domain model, principles, decisions, packaging, phases** |
| `docs/requirements.md` | operator requirements **beyond** parity and their status |
| `UX.md` | the pages and their degraded states |

The docs were consolidated into those four; `MVP.md`, `IMPLEMENTATION.md` and `HANDOFF.md` are
gone, and cross-references to `ARCHITECTURE.md` (including inside the remaining files and in the
source comments) mean `docs/architecture.md`. When a design decision changes, update the doc that
owns it.
