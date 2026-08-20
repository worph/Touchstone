# Touchstone — Additional Requirements

**Raised by the operator on 2026-08-20, from notes taken while reviewing the running app.**
Four scope questions in them were answered the same day and are recorded in §2.

This document is deliberately separate from [MVP.md](MVP.md). MVP is the *parity* specification —
"if n8n does not do it, it is not in the plan" — and every one of its 36 rows is now covered
([ARCHITECTURE.md §1.4](ARCHITECTURE.md#14-capability-inventory-and-parity-matrix)). Everything
below is **beyond parity**: none of it is a capability of the two workflows being replaced. Keeping
it in its own file preserves the property that made the parity rule useful, which is that you can
tell at a glance whether a thing is required to switch n8n off or required to make Touchstone good.

**What it costs to accept these.** R1, R5–R8 turn Touchstone from "a replacement for two n8n
workflows" into a conformance product with AppStore QA as its first tenant. `generic subject.kind,
pluggable tenants` is on the deliberately-dropped list in §1.4 G, and R1 in particular walks toward
it. The switch-off stops being the last milestone and becomes one milestone among several. That is
the operator's call and it has been made; it is written here so nobody re-derives it later as a
surprise.

---

## 1. Index

| # | Requirement | State today |
| --- | --- | --- |
| **R1** | No endpoint anywhere points at yunderalabs | ◑ five code sites, one of them the shipped default |
| **R2** | The protocol lives inside Touchstone as editable markdown | ✅ done 2026-08-19 |
| **R3** | Nothing anywhere depends on Docmost; plain `.md` files instead | ◑ one fallback branch remains |
| **R4** | Reports are markdown files in a folder, and the app says where | ◑ true on disk, invisible in the UI |
| **R5** | The agent (LLM MCP) is configurable from inside the app | ◑ configurable, but only by editing YAML |
| **R6** | The browser MCP sidecar is configurable from inside the app | ◑ same |
| **R7** | A notification page in the shape of Newsdesk's | ◑ Activity, deep links and assistable failures done; two parts missing |
| **R8** | A central LLM chat that administrates the app | ✅ built 2026-08-20, proved end to end |
| **R9** | The audit hands the dev team something they can act on | ✅ built 2026-08-20 — the fix report |
| **R10** | The app store is a configured value, and there may be several | ⬜ raised 2026-08-20 — §11 |
| **R11** | A ref can be audited without moving the subject's hallmark — a *trial* | ⬜ raised 2026-08-20 — §12 |

Legend: ✅ done · ◑ partial · ⬜ open

---

## 2. Decisions taken 2026-08-20

Four questions were put to the operator before this document was written. The answers are
requirements, not preferences, and the sections below are written against them.

| # | Question | Decision |
| --- | --- | --- |
| 1 | How far does "no connection to yunderalabs" cut? | **No endpoint may point at yunderalabs**, the box that hosts the n8n workflows being replaced. Clarified by the operator 2026-08-20: *yunderalabs is not Yundera*. GitHub and the demo pool are Yundera/Nasselle product infrastructure and stay. Tenant-neutrality — no Yundera defaults at all — is a follow-on, recorded in §3.4, not scheduled. |
| 2 | What should the MCP configuration screens do? | **Edit and apply in-app**, with a Test button that probes before saving. |
| 3 | What drives the admin chat? | **The Claude Code agent already used by the runner**, through the local Beacon. No new credential, no new outbound dependency. |
| 4 | Which Newsdesk notification parts are wanted? | **All four** — PWA install, assistable errors, "what to press now" action rows, deep-linked pushes. |

---

## 3. R1 — The local install reaches no yunderalabs service

> *"i would like our local config to be independent from yunderalab (no connexion at all)"*

### 3.1 What is true today

**`yunderalabs` is not `Yundera`.** That distinction was made by the operator on 2026-08-20 and it
decides this whole section. `yunderalabs` is the **host of the two n8n workflows being replaced** —
it also runs the Docmost wiki and the shared Beacon aggregator. `Yundera` is the product whose store
is being audited. Endpoints pointing at the *former* are what must go; the latter is the subject
matter and stays.

| Touchpoint | Where | Is it yunderalabs? |
| --- | --- | --- |
| `agent_url` default `http://beacon-backend:9300/mcp` | `store/config.ts:166,309` and again `runner/agent.ts:218` | **yes** — the Beacon *inside the yunderalabs stack*; it is the shipped default |
| `mcp__claude_ai_yunderalabs__call`, `…_nsl_sh__call`, `…Yunderateam__call` | `runner/agent.ts:79-81` | **yes** — aggregator tool names |
| `beacon:9300`, "the same beacon n8n uses to publish" | `runner/prompt.ts:77,100` | **yes** — written into the prompt as an instruction |
| Docmost slugs `In2NAGjv0h`, `LPwfKYUVig` | `runner/prompt.ts:100,106` | **yes** — the wiki is hosted there |
| `beacon-yunderalabs.telegram-mcp` / `discord-mcp` | `services/notify.ts:32-33` | **yes** — outlet tool names |
| Deploy target `touchstone-yunderalabs.nsl.sh` | `MVP.md` M7 | **yes** — see §3.5 |
| GitHub contents API, `Yundera/AppStore/Apps` | `store/registry.ts` | no — Yundera, and it is the subject |
| Demo pool `app.nasselle.com`, `demostaging*.inojob.com` | `store/config.ts:176-177` | no — Nasselle, and it is the bench |

The *running* dev install already reaches none of them: `config.yaml` overrides the agent to the
local Beacon and a hand-run assay was proved with no external dependency. **The defaults in the code
still point at yunderalabs**, which is what this requirement is about — a fresh install must not.

### 3.2 The requirement

**No code path, default value or prompt string in Touchstone may name a yunderalabs-hosted service.**
Concretely, in rough order of severity:

1. **The agent default changes.** `http://beacon-backend:9300/mcp` is the address n8n posts to from
   inside the yunderalabs stack, and it is hardcoded twice (`store/config.ts:166`, `runner/agent.ts:218`).
   It becomes the local Beacon, or it becomes empty and the app says "no agent configured" — which is
   a legitimate, visible state and is how R5's settings screen should present it.
2. **The prompt stops naming yunderalabs infrastructure.** `runner/prompt.ts` currently instructs the
   agent to reach everything through `beacon:9300` — "the same beacon n8n uses to publish" — and names
   the three `mcp__claude_ai_*` connectors. The endpoints the agent should use are the ones Touchstone
   leased for it and already passes in: `browser_endpoint` and `callback.url`.
3. **The Docmost fallback branch is deleted** — R3, which is the same edit as item 2.
4. **`runner/agent.ts:79-81` drops the aggregator tool-name list**, or takes it from config.
5. **`services/notify.ts:32-33` stops hardcoding `beacon-yunderalabs.*`.** An outlet names its own
   tool, or the aggregator prefix is a config value. Outlets are `[]` by default, so this removes a
   latent reference rather than changing behaviour.
6. **`DEMO_MANAGE` in `runner/prompt.ts:62` comes from `bench.board_url`** — not a yunderalabs issue,
   but the same class of defect: a URL in the prompt that the operator cannot change.

### 3.3 Acceptance

`grep -rai "yunderalabs\|docmost\|beacon-backend\|9300" src/` returns only comments describing
history — no default, no prompt string, no tool name. A fresh clone with no `config.yaml` boots,
reports the agent as unconfigured rather than silently dialling yunderalabs, and once pointed at a
local Beacon completes a static assay. Nothing in a packet capture reaches yunderalabs.

### 3.4 Recorded, not scheduled — tenant neutrality

The stronger reading of the note is that Touchstone should ship pointing at *nothing*: no
`Yundera/AppStore`, no `DEFAULT_APPS`, no nasselle pool URL, every one of them an empty config value
an operator fills in. That is the "generic conformance product" direction and it was explicitly
deferred on 2026-08-20. It is written here so that when R5/R6 build a settings screen, the screen is
designed to be able to carry those fields later without being rebuilt.

**Partly scheduled the same day, as R10.** The operator asked for several stores, and for a PR's
own store to be testable before the PR is validated. That reopens the first half of this item:
`Yundera/AppStore@main:Apps/` becomes a configured `origins:` entry rather than five hardcoded
sites. It does **not** claim tenant-neutrality — a Yundera origin still ships as the default, and
`DEFAULT_APPS` deliberately stays in code (`store/registry.ts:26-28` explains why: it is a copy of
what n8n falls back to, and a difference in it is a difference in what the two systems audit).

**The boundary, so this does not become the dropped feature.** §1.4 G drops `generic subject.kind,
pluggable tenants`, and R10 must not smuggle it back. An **origin is another repo in the same
AppStore format, judged by the same protocol files at the same version.** No `subject.kind`, no
per-origin rubric, no per-origin gate, no per-origin scheduler constants. The moment an origin
wants its own `protocols/` directory, that is pluggable tenants and it stays dropped.

### 3.5 The open one — where does Touchstone get deployed?

[MVP.md](MVP.md) M7 names `touchstone-yunderalabs.nsl.sh` as the deploy target. If no endpoint may
point at yunderalabs, the app being *hosted* there is at least worth a decision: it is not an
outbound dependency, but it does mean the replacement lives on the box whose workflows it replaces.
Options are to keep it (simplest — the agent and the bench are reachable from there), move it to one
of the pre-authorised test boxes (`holyhorse`, `watch`), or host it wherever the operator prefers.
**Unanswered; it does not block anything in §3.2.**

---

## 4. R2 — The protocol lives inside Touchstone, as editable markdown ✅

> *"I found the protocol isn't in Touchstone at all. It lives in Docmost ← ok that a difference that
> i want to document"* · *"i want it to live in a local mdfile that touchstone open and edit"* ·
> *"I don't see a way to edit the test protocol"*

**This is the difference the operator asked to have documented, so it is stated plainly:**

Until 2026-08-19 the rubric that every audit graded against **was not in this repository**. It was
three Docmost wiki pages — `In2NAGjv0h` (orchestrator), `LPwfKYUVig` (static leaf), `7HxjTwe63H`
(protocol) — that the agent fetched by slug at run time. Touchstone held a name and a version number
and nothing else. Two consequences nobody had written down:

- **The standard could not be edited from the app that enforces it.** The single thing an operator
  most needs to change lived in a different product.
- **The "exit Docmost" decision would have stranded it.** Freezing the wiki and deleting the importer
  would have left every audit fetching a page that was no longer maintained. "Edit the protocol" and
  "exit Docmost" were one task, and neither document said so.

**Delivered 2026-08-19.** The protocol is `data/protocols/*.md` — exported once, amended visibly to
drop its publish-to-wiki instructions, with `imported_from` in the frontmatter kept as provenance.
It is read fresh per run (`store/protocols.ts`), embedded in full in the prompt rather than fetched,
listed at `GET /api/v1/protocols`, edited through `PUT /api/v1/protocols/:id` with an optional
version bump, and exposed in the UI at `/protocol`. An edit takes effect on the next audit, not the
next boot, and a slow wiki can no longer error a run.

**Remaining under this heading: nothing.** R3 covers the one code path that still knows the slugs.

---

## 5. R3 — Docmost is gone everywhere, plain `.md` instead ◑

> *"I want to remove all the dependencies to docmost and use basic md files instead"* ·
> *"you may proceed to my insight implementation"*

Most of this is done: the importer, `adopt.ts`, `parseRollup`, the `docmost:` config block and the
`yarn sync` CLI are deleted; reports are local markdown; nothing reads or writes a wiki.

**What remains is one branch.** `runner/prompt.ts` keeps a no-inline-protocol path that instructs the
agent to `mcp__beacon__call` → `docmost-mcp__get_page` for slugs `In2NAGjv0h` and `LPwfKYUVig`
(lines 100 and 106). It exists for a good historical reason — with no protocol supplied the prompt is
byte-identical to the live n8n node, which is what kept the port diffable while both systems ran —
and it is dead in practice, because `index.ts` always constructs a `ProtocolStore`.

**Requirement:** delete the branch and the `protocolsInline` conditional with it. The prompt builder
takes the protocol as a required input and fails loudly if it is missing, rather than silently
falling back to a wiki that is being decommissioned.

**Accept the cost, and note it:** the prompt stops being byte-identical to the n8n node, so the D1
parity claim becomes "was byte-identical, deliberately diverged on 2026-08-20". Do this **after** the
shadow diff has been read, or the diff loses its baseline.

---

## 6. R4 — Reports are files, and the app says where ◑

> *"i see lots of results but i don't know where they are persisted on the disc, i would expect a
> folder composed of md reports"*

**The expectation is already the implementation.** Reports are
`data/reports/<origin>/<Subject>/<ISO-8601 with ':' → '-'>-<section>.md`, one file per assay, the YAML frontmatter
*is* the assay record, and the body is the report verbatim. There are 281 of them. Nothing else is
the archive — the in-memory index is a cache over these files and deleting `state/index.json` is
always safe.

**So this is a UI omission, not a storage one.** The requirement:

1. The subject detail page names the file path of each assay it lists.
2. The Overview or Activity page names the archive root once, plainly — *"281 reports under
   `/data/reports`"* — so an operator learns the shape of the store without reading a document.
3. The report viewer offers the raw markdown as well as the rendered form. `GET /reports/:subject/:file`
   already returns `raw`; the page does not surface it.

Do not add a download that the browser must generate — a published-page sandbox blocks those. A path
the operator can `cat` is the whole ask.

---

## 7. R5 / R6 — The two MCP dependencies are configurable in-app ◑

> *"i don't see configuration for the LLM MCP (claude code through beacon mcp)"* ·
> *"i don't see configuration for the browser mcp (even if it is a side car it is an external
> dependencie and need to be present)"*

### 7.1 What is true today

Both are configured, and both are *probed* — that landed on 2026-08-19 with `services/ports.ts`,
which asks each endpoint for `tools/list` because that is the surface the work actually uses
(`browser-mcp` serves a `/health` that answers 200 whether or not Chrome is reachable). Their health
shows on the Activity page beside the bench pool.

What does not exist is **any way to change them from inside the app.** `runner.agent_url`,
`runner.agent_tool`, `runner.agent_via` and the `browsers:` list live in `data/config.yaml` and are
read once at boot. There is no configuration route of any verb in `src/server/routes/`.

### 7.2 The requirement — decision 2: edit and apply

A **Settings page**, in the shape of Newsdesk's `Config.tsx`, that reads and writes the same values:

| Field | Key | Notes |
| --- | --- | --- |
| Agent endpoint | `runner.agent_url` | the local Beacon by default |
| Agent tool name | `runner.agent_tool` | namespaced when reached through an aggregator |
| Transport | `runner.agent_via` | `direct` \| `beacon` |
| Callback URL | `runner.callback_url` | how the agent reaches our MCP surface — the one inward arrow |
| Browser sidecars | `browsers[]` | name, url, enabled — one per functional worker |
| Bench pool | `bench.pool_url`, `bench.board_url` | already config; belongs on the same screen |

Requirements on the screen itself:

1. **A Test button per endpoint** that runs the real probe (`tools/list`) and reports the tool count,
   before saving. A green light that means "the URL parses" is the failure mode this codebase has
   been burned by twice.
2. **The write is atomic and comment-preserving where it can be.** `config.yaml` is hand-edited by
   operators; a save that reformats the file or drops its comments is a regression.
3. **Applied without a restart** where the value allows it — the probers already re-read their
   config each cycle; the runner's agent options are read per call.
4. **Secrets never round-trip to the browser.** Nothing here is a credential today, and the screen
   must not become the reason one is.
5. It renders and saves with every port down. Configuring the thing that is broken is exactly when
   you need the screen.

### 7.3 Acceptance

Point the browser endpoint at a wrong port from the UI, press Test, and be refused with the reason.
Point it back, save, and the next functional run leases the new sidecar with no restart.

---

## 8. R7 — A notification page in Newsdesk's shape ◑

> *"I would like a notifiaction page similar to what we have in Newsdesk"*

Touchstone's Activity page is already that shape: an authoritative local event log, deduplicated
alerts, the environment block, and web push — with the invariant that it renders with every outbound
port broken. Four parts of Newsdesk's are missing, and decision 4 asks for all four.

### 8.1 PWA install — manifest and icons

Newsdesk ships `manifest.webmanifest` plus a full icon set (`icon-192`, `icon-512`, maskable
variants, `apple-touch-icon`, `badge-96`) in `web/public/`. Without them Android installs a bookmark
rather than an app, and phone push is worth little. The manifest must be reachable **through the
AppShield anonymous bypass** — a manifest behind SSO is fetched unauthenticated by the browser and
fails.

**Carry Newsdesk's warning across:** the manifest `id` is the app's identity to the browser. Set it
once, before anyone installs; changing it later makes an installed Touchstone read as a different app
and a second icon appears.

### 8.2 Assistable errors

An error row on Activity can be handed to the model — "what is this, and what do I do about it" —
rather than read raw. This shares its backend with R8: the same agent, the same tool registry, a
different entry point. Build R8 first or build them together; do not build two model surfaces.

### 8.3 "What to press now" action rows

Newsdesk's `/now` is one line per thing needing a decision, one verb each, most overdue first, and
**the wording is decided by the server** so the push notification and the page can never describe the
same job differently. Touchstone's equivalents: a bench outage that needs an operator, a subject
parked after three tries, a protocol edit that has not been exercised, a port that has been
unreachable for an hour, a run that ended `parse-failed`.

The requirement is the invariant, not the list: **one server-side function produces both the action
rows and the push text.**

### 8.4 Deep-linked pushes ✅ already done

Checked 2026-08-20 and it is implemented end to end: `services/notify.ts:117` sets the payload URL to
`/s/<subject>` for any event carrying a subject and `/activity` otherwise, `services/push.ts` carries
`url` in the payload, and `src/web/public/sw.js` reads it on `notificationclick` — focusing an open
tab and navigating it, or opening a window. Nothing to build. It is listed here only because it was
asked for and the answer is "you already have it".

---

## 9. R8 — A central LLM chat that administrates Touchstone ✅

> *"I would like a central LLM chat to administrate (similar to what we have in NewsDesk)"*

**Built 2026-08-20 and proved end to end**, driven through a real Chrome: typed *"run a static
review on filebrowser"* into the chat, watched it resolve the name, start the audit, and five
minutes later take the push notification on the same browser.

### 9.1 The shape

Newsdesk's, ported: **Touchstone owns the loop and the tools; the model only chooses which to
call next.** It answers with one JSON object naming at most one tool, the server runs it, and
the result is written as a row *before* the next round reads it back — so the step the operator
sees and the step the model is shown next are the same row and cannot disagree.

| Piece | Where |
| --- | --- |
| the turn, its bounds, dispatch | `src/server/chat/loop.ts` |
| threads and messages, as JSONL | `src/server/chat/thread.ts` |
| the three tools + the `ChatTool` contract | `src/server/chat/registry.ts` |
| the catalogue the prompt shows | `src/server/chat/catalogue.ts` |
| the agent call and `extractJson` | `src/server/chat/driver.ts` |
| the prompt | `src/server/chat/prompt.md` |
| `GET`/`POST`(SSE)/`DELETE` | `src/server/routes/chat.ts` |
| the page, at `/chat` | `src/web/pages/AdminChat.tsx` |

Bounds, as Newsdesk sets them: **8 tool calls** and **120 s** per turn, **60 s** per model call,
tool results cut to 4 000 characters *in the prompt only* — the row keeps the full text.

### 9.2 What it stores

No database, so a thread is `state/chat/<id>.jsonl` and the set of them is
`state/chat/index.json`. Messages are strictly append-only; "new conversation" starts a new
thread and keeps the old file, because those rows record *why* something was done. A thread
idle for eight hours rolls on the next turn.

### 9.3 The three tools

`list_subjects`, `get_status`, `run_assay`. Each is a thin wrapper over what the API already
does — the chat is a way of reaching the app by conversation, not a second implementation of
it. **No tool writes a verdict**, for the same reason `routes/mcp.ts` has no `record_result`:
the moment a model can post an outcome, the protocol's gate stops being one.

### 9.4 The contention it has to survive

`run_assay` starts an audit that then holds the single agent for minutes — so the round in
which the model would have said "I started it" finds the agent busy. Ending on *"I could not
finish that"* would be true and misleading at once. So a turn that dies after doing real work
reports **the work** instead, and only then says it stopped. Covered by a test.

### 9.5 Not done

The confirmation round-trip — Newsdesk's `confirmWith`, where a destructive tool is *offered*
and the operator types a word to run it. Nothing in the current registry is destructive, so
there is nothing to guard; it becomes necessary the moment a tool can arm the scheduler or
rewrite the configuration.

## 9b. R9 — The audit hands the dev team something they can act on ✅

**Asked for 2026-08-20**, after the first end-to-end audit of SegmentPlayer: a button on the app
panel producing a markdown report that states the issue and proposes the fix, *"to serve as an LLM
prompt on the dev team so they can use that to fix the app"*.

It is not on the parity matrix — n8n has no equivalent — and it is not in ARCHITECTURE §1.4 G's
dropped list either. It is a new capability, asked for directly.

**Composed, not generated.** The decision put to the operator was agent-written versus composed
from the record; composed won. Every sentence comes out of the frontmatter the agent already
wrote — the finding, its severity, its evidence, the remedy where it proposed one — so the report
is instant, deterministic, works with the agent down, and re-derives nothing (invariant 1). Where
the audit proposed no remedy, the document **says so** rather than inventing one: a guessed fix in
a document whose purpose is to be executed is worse than none.

**Shape.** `# Fix <App>` → the subject (repo, ref, path, images, standard versions, per-section
verdict) → rules of engagement → findings worst-first with evidence quoted and remedy split out →
functional phases → what already passes and must not regress → **acceptance: the requirement ids
that must flip to `pass`**. Those ids are what make it a brief rather than a complaint.

**Where it lives.**

| Piece | Where |
| --- | --- |
| The composer, pure | `src/server/domain/fixreport.ts` (+ 17 tests) |
| The document | `GET /api/v1/subjects/:name/fix.md` — `text/markdown`, for a script or CI |
| The button and panel | `src/web/components/FixReport.tsx`, on the subject page |

The panel shows raw markdown, not rendered: the point is to take the text away, and rendered
markdown is markdown you cannot copy. Copy needs a secure context, so the button says `needs
https` rather than failing silently on a plain-http LAN address.

The button is hidden unless something is actually failing — gated on recorded findings, not on
the verdict, because an assay imported before the ledger has a verdict and no requirements, and
the report built from it would be headings with nothing underneath.

---

## 10. Sequencing

Nothing here blocks the n8n switch-off, and the switch-off does not block any of it. Suggested
order, cheapest and most-enabling first:

1. **R3** — delete the Docmost branch (after the shadow diff is read). Small, and it closes R1's
   largest item.
2. **R1** — the remaining yunderalabs references. Small.
3. **R4** — say where the reports are. Small, pure UI.
4. **R5/R6** — the settings page. Medium, and it is the store R8's `get_config`/`set_config` need.
5. **R7.1** — manifest and icons. Medium; deep links (R7.4) already work, so this is what makes
   phone push worth having.
6. ~~**R8** — the admin chat.~~ **Done 2026-08-20.** R7.2's assistable errors are now a second
   entry point onto a loop that already exists.
7. **R7.3** — action rows, once there is enough of a decision surface for the list to be non-trivial.

R10 and R11 sit outside that order: R10 is a prerequisite for R11 and neither blocks nor is
blocked by the switch-off.

---

## 11. R10 — The app store is a configured value, and there may be several ⬜

> *"i would like some configuration to either be able to change store or support multiple github
> store (or pass store as URL to protocol eg in case of PR we use custom store of the PR to test
> before validating)"* — operator, 2026-08-20

### 11.1 What is true today

`Yundera/AppStore@main:Apps/` is hardcoded in five places: `store/registry.ts:23`
(`GITHUB_APPS_URL`), `runner/prompt.ts:82` (`repo`, with `ref main` a bare string literal a few
lines below), `domain/assay.ts:165,286` (`subject_ref`, defaulted rather than written) and the
report H1 at `assay.ts:74,171`. Two of those — `PromptInput.repo` and `AssayInput.subjectRef` —
are already parameters that no caller has ever set, and `data/protocols/static.md:59` already
declares itself "repo-agnostic (works for any `<repo>`)". The rubric was written for this; only
the wiring collapsed it to a constant.

### 11.2 The requirement

An **origin** is `{id, repo, ref, apps_path}` in `config.yaml`. Subjects are identified by
`<origin>~<name>`; reports live at `data/reports/<origin>/<Subject>/<ISO>-<section>.md`; every
assay's `subject_ref` is written from the origin rather than defaulted. Several origins feed one
backlog under one set of scheduler constants.

Two rules the design turns on:

- **`DEFAULT_ORIGIN` is a code constant**, because a report file written before this existed gets
  its `origin` defaulted on read (in `coerceMeta`, exactly as `leg` → `section` is), and renaming
  the default would re-interpret the whole legacy archive. Config must contain an origin with that
  id, checked at boot — `config.ts`'s `merge()` replaces arrays wholesale, so an operator adding
  an origin would otherwise silently delete the default one.
- **The archive layout is a namespace, not a uniqueness rule.** Two origins may both ship a
  `FileBrowser`; they are two subjects, two rows and two schedule entries.

### 11.3 Acceptance

A second origin can be added to `config.yaml` and its apps appear as their own rows, with their
own schedule entries and their own reports, without a code change. One origin's GitHub outage does
not empty another's list and costs no subject a retry. With one origin configured, nothing about
the app's behaviour or appearance differs from before.

---

## 12. R11 — A ref can be audited without moving the hallmark — a *trial* ⬜

The PR half of the same request. A **trial** runs the same protocol through the same runner
against an arbitrary `repo@ref`, and writes under `data/trials/<slug>/` — a tree the report index
is never handed, so a trial cannot move a subject's hallmark, cannot enter the backlog and cannot
consume a retry. `AppStore PR Review` stays in n8n and keeps the labels, the comment and the
publishing; this is the executor it could call, and nothing calls it until someone wires it.

**Trials are static-only, and the blocked report says why.** `data/protocols/functional.md:189`
installs from the bench's own catalogue at `https://<DEMO>/store`, which serves whatever store
that Maison box points at — not the ref under trial. A functional result would be about `main`
while carrying the PR's name. The functional section is therefore recorded `blocked` with reason
`store_not_installable`, which is invariant 4's exact shape. Repointing a bench's catalogue at a
custom store URL is the follow-on that would lift this.

**Nothing a model can call may choose the ref.** The chat's `run_assay` keeps its single property,
constrained to a member of the registry. Invariant 6 says nothing an agent can call may write a
verdict or mint a section; the same reasoning covers repo+ref, which is the one input that turns
"audit an app" into "run `gh` against a URL of the model's choosing".

---

## Appendix A — A defect found while writing this ✅ fixed 2026-08-20

`src/server/index.ts:250` starts the bench prober only when `cfg.benches.length > 0`. But `benches:`
is the *override* for pinning a fixed box and correctly defaults to `[]`; the pool is **discovered**
from `bench.pool_url`. So under the intended configuration the prober never runs on its own: the app
logs *"no benches configured — the functional queue stays paused"* and the scheduler's D7/D8 gate
reads whatever `state/benches.json` last held.

Observed on 2026-08-20: `/api/v1/benches` was serving health stamped `2026-08-19T16:27` — sixteen
hours stale — and the hourly tick was idling on it. A hand-fired `POST /api/v1/benches/probe`
refreshed it immediately, so the prober itself is sound; only the boot wiring is wrong. The
consequence is that the open bench alert can never resolve on its own and the functional queue stays
paused after the pool recovers — a milder relative of the defect this project exists to fix.

**Fixed**: the gate now reads `cfg.benches.length === 0 && !cfg.bench.pool_url`. It proved itself
within the hour — at 09:37 on 2026-08-20 the log recorded `BENCH_RECOVERED · The demostaging1 bench
is letting us log in again`, which the old wiring could never have noticed.

---

## Appendix B — Recorded while building the chat

**Scheduling is per-subject, and one section can now outlive another.** An audit with no
bench completes the sections that need none and records the rest `blocked` (§10 of the plan, and
`domain/assay.ts`). But the finish is stamped against the *subject*, so the outstanding
section is not reconsidered until the subject is stale again — up to `fresh_days`, even if the
pool recovers a minute later. Per-section eligibility does not exist, and the 2026-08-20 section
rework deliberately did not add it: a per-section backlog turns `policy.ts` from a diffable port
of n8n's `Pick next target` into a pick that cannot be shadow-compared (ARCHITECTURE §5.1). Worth building before the scheduler is armed; harmless while audits are
hand-run.
