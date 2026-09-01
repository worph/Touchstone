# Touchstone — Additional Requirements

**Raised by the operator on 2026-08-20, from notes taken while reviewing the running app.**
Four scope questions in them were answered the same day and are recorded in §2.

This document is deliberately separate from the *parity* specification — "if the workflow being
replaced does not do it, it is not in the plan" — whose 36 rows are all covered
([architecture.md §1.4](architecture.md#14-capability-inventory-and-parity-matrix)). Everything
below is **beyond parity**: none of it was a capability of the two workflows Touchstone absorbed.
Keeping it in its own file preserves the property that made the parity rule useful, which is that
you can tell at a glance whether a thing was required to complete the replacement or is required
to make Touchstone good.

**What it costs to accept these.** R1, R5–R8 turn Touchstone from "a replacement for two
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
| **R10** | The app store is a configured value, and there may be several | ✅ built 2026-08-20 — §11 |
| **R11** | A ref can be audited without moving the subject's hallmark — a *trial* | ✅ built 2026-08-20 — §12 |
| **R12** | How far behind its own upstream each app is, and for how long | ✅ built 2026-08-22 — §14 |
| **R13** | What the standard said when it judged, and what changed since | ✅ built 2026-08-23 — §15 |
| **R14** | The administrator can change how this instance behaves, from inside it | ✅ built 2026-08-25 — §16 |
| **R15** | Supporting knowledge lives beside the rubric instead of inside it — a *knowledge base* | ✅ built 2026-08-28 — §17 |
| — | The rubric cleanup: one id space, severity defined, the static leaf's mechanics to the KB | ✅ done 2026-08-28 — §18 |
| — | The rubric is seeded from `seed/`, not committed as if it were the live standard | ✅ done 2026-08-28 — §19 |
| — | An app the store has stopped offering is marked, unscheduled, and deletable — *delisted* | ✅ done 2026-08-31 — §20 |
| **R16** | Every way of asking for the single agent is one queue, drained in order — and one verb | ✅ built 2026-09-01 — §21 |

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

Since 2026-08-31 a **browser** is asked a second question, because `tools/list` turned out to be
the same class of green light: it is answered by the sidecar's Node wrapper, and on 2026-08-24 that
wrapper stayed healthy for a week over a Chrome nothing could drive. `browserLiveness()` reads the
sidecar's `/api/status` and `/api/health` and marks the port unreachable on a positive wedge signal
— not on `running: false`, which is what a perfectly healthy idle-reaped browser reports.

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

## 11. R10 — The app store is a configured value, and there may be several ✅

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

## 12. R11 — A ref can be audited without moving the hallmark — a *trial* ✅

The PR half of the same request. A **trial** runs the same protocol through the same runner
against an arbitrary `repo@ref`, and writes under `data/trials/<slug>/` — a tree the report index
is never handed, so a trial cannot move a subject's hallmark, cannot enter the backlog and cannot
consume a retry. `AppStore PR Review` stays in n8n and keeps the labels, the comment and the
publishing; this is the executor it could call, and nothing calls it until someone wires it.

**Trials were static-only, and the blocked report said why.** A bench installs from its own
catalogue, which serves whatever store that Maison box points at — not the ref under trial — so a
functional result would be about `main` while carrying the PR's name. The functional section was
therefore recorded `blocked` with reason `store_not_installable`, which is invariant 4's exact
shape.

**That is finished as of 2026-08-22 — see §13 and §14.** Maison takes its store as a parameter, so
a trial publishes the archive it audited and hands the bench that. A trial is now a full audit,
static and functional both.

**Nothing a model can call may choose the ref.** The chat's `run_assay` keeps its single property,
constrained to a member of the registry. Invariant 6 says nothing an agent can call may write a
verdict or mint a section; the same reasoning covers repo+ref, which is the one input that turns
"audit an app" into "run `gh` against a URL of the model's choosing". **§13 keeps that property
and is worth reading against it**: an upload trial takes no repo and no ref, so there is still no
URL of the model's choosing and no `gh` pointed at one. What it does newly allow is a model
choosing the *content* audited, which is a different thing and is written down there rather than
left to be inferred from the absence of a rule against it.

---

## 13. Trialling files that are on no branch — 2026-08-22

The dev team's loop was: read the audit, change the app, **commit, push, wait for the store to be
re-read**, audit again. The middle step is slow (a full audit is ~8.5 min, and every iteration
needed a push first) and it is also where `functional.md`'s recorded 2026-08-20 incident lives —
a fix landed at 16:45 and two audits that evening installed the pre-fix compose from Maison's
in-process cache and attributed the failure to an app whose source was already correct.

**An upload trial removes the commit.** `open_trial` mints a session; each file is written with
`PUT /api/v1/uploads/<token>/<path>`; `run_trial` audits exactly those bytes and writes the result
under `data/trials/`, where the report index never looks — so it still cannot move a hallmark,
enter the backlog or consume a retry. The whole loop is callable over MCP, which is what the
operator asked for: QA reports a problem, the dev team reads it, changes files, re-runs, and reads
the result without leaving Claude Code.

Three decisions worth keeping:

- **The repo survives as a name.** `static.md` does not merely fetch from the repo, it judges
  against it — asset URLs must point at `<repo>@main`, and that repo's `CONTRIBUTING.md` is "the
  source of truth for what each item means". A trial with no repo at all would throw a false Major
  on every asset URL and apply a rubric whose terms it could not look up. So the name is carried
  and only the bytes are local. The ref is nominally `main` for the same reason: `prompt.ts`
  rebinds the asset rule to the ref under audit for any other value, which is right for a PR
  branch and wrong for files that were never on a branch.
- **A trial serves its own store, which is what lifts `store_not_installable`.** The session is
  zipped in GitHub's archive shape and served at an unguessable per-trial URL that the bench
  fetches over the public internet (`config.trials.public_base_url`, and an `ALLOWED_PATHS` entry
  so that one prefix is outside the SSO gate). Because the URL is minted per trial, Maison's store
  cache cannot be serving an older copy of it — the 2026-08-20 failure mode is removed rather than
  mitigated.
- **What this opens was decided rather than assumed.** An upload trial makes "an arbitrary compose
  a bench will install and run" reachable from an aggregator that authenticates nobody. The
  operator's judgement (2026-08-22) is that this grants nothing an anonymous visitor lacked: the
  benches are shared, publicly reachable and use published credentials. What that argument does
  *not* cover is handled as engineering — per-file and per-session byte caps, sessions that expire
  on their own, and a zip served `attachment` so uploaded bytes can never render on the origin
  that also serves the operator UI.

---

## 14. R12 — How out of date is each app, and since when — 2026-08-22

> *"review the version in the compose of each service, check the version online and compose a
> small report of if there is new version and the time the current version have not been up to
> date"*

**This is the fifth sanctioned exception to the parity rule** ([ARCHITECTURE §1.4](ARCHITECTURE.md#14-capability-inventory-and-parity-matrix)).
Neither n8n workflow does anything like it. It is here because the operator asked for it directly
and because the answer turned out to be cheap: over the 71 apps of the Yundera store the whole
check takes one to six seconds per app and needs no agent, no bench and no browser.

### 14.1 What it found on the day it was written

Not illustrative — this is the store, swept once with the shipped executor:

| | |
| --- | --- |
| apps read | 71 (2 blocked: `CasaOS` and `OpenClaw` are in the registry but no longer in `Apps/`) |
| **behind** | **42** |
| current | 18 |
| unknown | 9 |
| image rows | 138 — 67 behind, 35 current, 20 floating, 12 unknown, 4 past the 180-day line |
| worst | `Paperless-ngx` 871 days · `Tribler` 490 · `Caddy` 400 · `Nginx` 203 |
| incidental | 16 apps run `appshield:2.0.6` while 2 run `2.0.7` — the platform's own sidecar, out of step across the store, which nothing before this could see |

### 14.2 The three numbers

- **behind** — comparable releases above the pinned tag. Comparable means the same variant suffix,
  the same precision and (unless `compare_majors`) the same major line: `postgres:16.13` is one
  patch behind `16.14`, **not** fourteen releases behind `18.6`. A supported branch is a decision,
  not neglect.
- **stale since** — when the **earliest** newer release appeared. Deliberately not the newest
  one's date (that measures how busy upstream is) and not the pinned one's (that measures how old
  the image is). This is the number that answers the operator's question.
- **days** — recomputed *at render time* from `stale since`. This is what makes a cadence
  unnecessary: the record holds an absolute moment, so "400 days behind" stays true between
  assays even though the reading is taken only when the app is audited.

### 14.3 Where it runs, and why not on a timer

**Inside the audit that was happening anyway.** An earlier draft had a second scheduler lane
sweeping every subject every six hours; the operator's objection was that it would complicate the
UX for something they would not use, and it turned out to buy nothing — because `stale since` is
absolute, the only quantity that ages is the release *count*, and `FRESH_DAYS = 7` bounds that
already. So there is no timer, no `state/` file of its own, no page and no switch. `cadence:` is
not implemented; the seam that would carry it is one frontmatter field away if it is ever wanted.

### 14.4 Why a script and not a rubric

The check is deterministic, and the three arguments for keeping a model out of it are ordered by
weight — token cost is the weakest of them:

1. **A model is worse at exactly this.** Ordering `1.9.0` against `1.10.0`, counting 21 releases,
   subtracting dates. Not "overkill" — *worse*.
2. **A wrong green is unfalsifiable.** The value of the check rests entirely on `unknown` being
   honest. A script's failure mode is an exception you can see; a model's is a confident sentence.
3. **Non-determinism would make "it changed" meaningless.** A reading that jitters between runs
   cannot be told apart from the world moving.

And the residue that would have justified escalating to a model turned out not to be one. Of 108
distinct images, 87% are settled by three small tag grammars; the remainder is 11 floating tags
(a *different*, confidently stated finding — the pin moves, which is `pinned-image-tag`'s
business) and 3 digest pins, which have a correct deterministic answer too. Bounded, repeating
variety is where a rule beats a model permanently.

A model would earn its place on the questions a registry cannot answer — *is this project
abandoned, did it move, was that release a security fix* — and that would be a **second** section
with `executor: agent` reading this one's output, not a replacement for it.

**CVE lookup is out of scope**, decided 2026-08-22: it is the app team's responsibility, not the
store's. It would also need a real scanner (a native binary or a daily-refreshed database, against
the amd64+arm64 rule) and would bury the fix brief under dozens of unreachable base-image CVEs.

### 14.5 The shape it took: a section, performed by a file

The alternative designs were a rubric the agent reads (wrong cadence, wrong cost, wrong authority)
and a parallel subsystem with its own storage and pages (two ways to say an app is in trouble,
which eventually disagree). What shipped instead **widens the extension point that already
existed**: a protocol leaf now declares *who performs it*.

```yaml
executor: currency.sh      # default `agent` — every existing protocol is unchanged
scores: false              # measures rather than judges
policy: { stale_days: 180, compare_majors: false, platform_images: [...] }
```

```
data/protocols/currency.md   the policy    — versioned on save, editable in-app, recorded on every assay
data/protocols/currency.sh   the procedure — POSIX sh, curl and jq, edited on the volume
```

The record shape does not change, so the index, the hallmark, the Overview, the subject page,
`fix.md`, `/public`, the chat tools and **trials** all work with no knowledge that any of this
exists. A trial of a branch reports whether that branch bumps the image, for free.

The operator's constraint was **`*.sh` in the workspace only** — *"so we are not tempted to
hardcode a script in the app"*. It is the same argument that moved the rubric out of Docmost: the
thing most likely to need changing (a registry URL, a threshold, a tag rule) must not sit behind a
rebuild. There are exactly two executors — `agent`, and a named sibling script — and no third
form, no inline code and no path.

### 14.6 What it costs, stated

- **`curl` and `jq` in the image.** Both small, both arm64-clean, neither a native dependency of
  the Node build. `ca-certificates` with them, or every lookup fails TLS and every reading is
  honestly useless.
- **Testability changes shape.** A `.sh` is not unit-testable the way a pure function is. What
  replaces it is `test/currency.test.ts` — fixtures on stdin, assertions on stdout, running the
  real artifact, entirely offline.
- **The `.sh` has no version of its own.** So every assay records `executor_sha256`: without it an
  operator could change what the check does and leave nothing in the archive to say that two
  readings were produced by different procedures. That is invariant 9 applied to the half of a
  check that has no version number.
- **GHCR with more than ~10,000 tags reads `unknown`.** The OCI tag list is unordered, so
  "nothing newer exists" is only as good as how much of it was read. Finding a newer tag is
  positive evidence and survives truncation; finding none does not, and is not reported as
  `current`. Immich is the store's one example.

### 14.7 The rules that keep an executor from being a shell

`routes/mcp-admin.ts` is designed to be beaconified into an aggregator that authenticates nobody.
A script directory on the wrong side of that is not a bug, it is a remote shell. Four rules, each
with a test:

1. **No route may write a `.sh`.** True by construction — `ProtocolStore.save` writes `${id}.md`
   and `PUT /protocols/:id` is the only editor — and now asserted. This is what upgrades invariant
   6 from *a model cannot post a verdict* to *a model cannot post code*.
2. **Only an executor a `.md` names may run.** The directory is never scanned for things to
   execute; a dropped-in file does nothing until a protocol points at it.
3. **Basename only.** `^[A-Za-z0-9][A-Za-z0-9_-]*\.sh$` — no slash, no dot but the extension (so
   `..` is unspellable), no leading dash. An executor that fails this is recorded `blocked`, never
   quietly downgraded to the agent.
4. **Bounded, and fed on stdin.** Timeout, stdout cap, its own process group so a hung `curl` can
   be killed with its shell, and a minimal environment. Input never touches a command line —
   subject names come from a GitHub directory listing, so `; rm -rf ~` is a directory a stranger
   can open a pull request for.

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

## 14. One trial, and a full one — 2026-08-22

§13 left two shapes of trial: a `repo@ref` and an upload session. Each had its own spec builder,
slug, prompt branch and a `kind` discriminator, and only the second could run the functional
section. Both are now **one input — a store zip and an app inside it** — and every trial runs
the whole protocol.

**Why one input is also more correct, not only leaner.** A store zip is both halves of an audit
at once: the files the static section reads *and* the bytes the bench installs. A ref trial read
its bytes from a place the bench never installed from, which is precisely the disagreement
`functional.md` v6 had to add a hand-written compose assertion to catch. With one archive there
is nothing left to disagree. Whatever names the store — a GitHub branch archive, an upload
session — stops mattering past `buildSpec`.

**Every trial serves its own copy** rather than the bench being pointed at the caller's URL. The
2026-08-20 cache incident is then impossible by construction rather than mitigated: the URL is
minted per trial and has never been fetched. Pointing a bench at a branch archive would have
brought that failure back in a narrower form, since a branch's URL is stable across pushes.

**`store_not_installable` is gone.** A trial is gated by the same bench and browser probes as any
other run. The one exception is `trials.public_base_url` being unset — Touchstone cannot serve a
store it has no external address for — recorded as `store_url_unconfigured`, which names the
setting that fixes it rather than describing a limitation of trials.

**What is new, and what it cost.** Touchstone now dereferences a URL a caller chose, which
nothing here did before. `run_trial` is reachable from an admin MCP that authenticates nobody, so
without a guard "audit this store" would be a request-forgery primitive pointed at whatever else
this box can reach. `services/trialstore.ts` holds all three parts of the answer: a host
allowlist (GitHub archives plus our own address, with no way to configure "any"), a re-check at
every redirect hop, and a byte cap enforced on what arrived rather than on what `content-length`
claimed. The operator's judgement from §13 — that a bench is shared, publicly reachable and uses
published credentials, so an uploaded compose grants nothing an anonymous visitor lacked — covers
the *content* of a trial. It does not cover the *reach* of a fetch, which is why that is
engineering rather than an argument.

**Rubric anchor, not byte source.** `repo` survives because `static.md` judges asset URLs against
`<repo>@main` and reads that repo's `CONTRIBUTING.md` as the definition of every item. It is now
resolved from the configured origins rather than supplied by the caller: whose contribution rules
apply is a property of the store, not of the branch under trial — which is both one fewer input
and the more correct reading.

## 15. R13 — What the standard said when it judged, and what changed since — 2026-08-23

### 15.1 What was true before

A protocol's identity was an integer it carried in its own frontmatter, and `save()` bumped it.
Every assay recorded it — `standard_version: 7` — and on a box with a volume that number
resolved to **nothing**: the text of v7 was overwritten the moment somebody edited the rubric,
and the only surviving copy of it was in this repo's git history, which covers edits made in a
checkout and misses every edit made through the Protocols page.

Three separate defects, all of them in one field:

- **It could not be dereferenced.** The archive named a rubric nobody could read.
- **It lied both ways.** A save bumped it whether or not the content changed; a hand edit on
  the volume changed the content without touching it.
- **It did not cover the scripts.** A `*.sh` executor had no version at all — only
  `executor_sha256` on the assay, which likewise resolved to nothing.

### 15.2 The requirement

Traceability on the thing every verdict is measured against: **what changed, when, and why** —
and, for any hash an assay recorded, the bytes it names.

### 15.3 What it took

**One identity, not two.** The sha256 of the whole file — frontmatter included, because
`policy:` lives up there and a threshold is part of what a check does. Rubrics and scripts are
now identified the same way, which is also why `executor_sha256`'s old justification (that the
`.md` had a number and the `.sh` did not) has been deleted rather than edited.

**An append-only log with snapshots**, `data/protocols/.history/`: `log.jsonl` plus
`<file>/<seq>-<sha12>.<ext>`. Gitignored, and excluded from the image seed.

**Swept on observe, not on save.** Hash what is on disk at boot, after each save, and once
before a run reads the protocol; record only what differs from that file's newest entry. This
is the half that catches an edit made over SSH — the case the integer could never see. Such a
row is `observed` and carries **no reason**, in visible contrast to a `save`, which carries
the one the operator was required to give. `PROTOCOL_REVISED` puts it in Activity.

**No restore route.** Putting an old revision back is: open it, load it into the editor, save
it forward with its own reason. A rewind endpoint would let the admin MCP that authenticates
nobody quietly revert the standard every subsequent audit is judged against.

**A diff nobody had to install.** `src/shared/linediff.ts` — common prefix/suffix trim, LCS
over the middle, hunks with three lines of context. About seventy lines, no dependency, and
pure, so both frames could use it if the other one ever needs to.

### 15.4 A defect it surfaced on the day it shipped

`save()` reserialised the frontmatter through the YAML dumper, which **silently deleted every
comment in it**. `currency.md` documents all five policy knobs in those comments — thirty-five
lines of them — and one save through the app would have thrown them away. It predated this
work and nothing had noticed, because the file had only ever been hand-edited.

Fixed by carrying the frontmatter block over as bytes: `save()` replaces the prose and nothing
else. That also made invariant 11 structural rather than argued — the header is never
regenerated from parsed data, so no route can rewrite `executor:`, and a body opening with a
`---` fence cannot become frontmatter because there is always a block ahead of it.

### 15.5 What the archive keeps

Nothing is rewritten. Reports from before the cutover keep `standard_version`, and
`standardLabel()` renders `Static Review Protocol v7` for them and
`Static Review Protocol @9c1b3f2a4d55` for everything after. Restamping old reports with
hashes would claim those runs were judged by bytes we cannot produce.

### 15.6 Not done, deliberately

- **Deletion of a protocol file is not recorded.** The log's shape leaves room for it.
- **Nothing is pruned.** The history is the dereference target for invariant 9, and trimming
  it would break links from the archive. Seventy-three kilobytes of protocol and roughly
  fifteen edits in the project's life; revisit if that ever stops being true.
- **The public frame shows the hash but does not link it.** There is no protocol page under
  `/public`, and a link into the operator frame is a dead end for somebody with no account.


---

## 16. R14 — The administrator can change how this instance behaves — 2026-08-25

### 16.1 What was true before

Asked to make the re-audit window a fortnight, the chat answered:

> The cooldown lives on the Automation page, not in anything I can change from here — none of
> my tools write scheduler settings, they only read the schedule.

Half of that was wrong and the half that was right was worse. The Automation page could not
change it either: it had one switch — start and stop — and six read-only facts. Every number
that decides *when* Touchstone does anything lived in `data/config.yaml`, was read once at
boot, and changing one meant an SSH session, an edit and a restart, on a box whose whole
purpose is running unattended. The operator was being sent to a page that could not do it,
to change a file the app deliberately refuses to write.

That refusal was, and remains, right about `config.yaml`: `routes/settings.ts` serves it
read-only because it is handed to the services as values at boot, so a save button there
would change a file without changing behaviour. What was missing was the distinction between
a value nothing re-reads and a value something re-reads on every tick.

### 16.2 The requirement

An administrator — at the page, or in the chat, or over the admin MCP — can change what this
instance does, without editing a file on the volume and without a restart.

### 16.3 What it took: the **control**

A *control* is one configuration value that can be changed while Touchstone is running. The
bar for being one is mechanical rather than editorial: **something live has to read the value
again later.** `scheduler.fresh_days` is read on every tick and qualifies; `runner.agent_url`
is captured when the Runner is constructed and does not — which is why R5/R6 (§7) is still
open, and why this did not quietly close it.

Ten of them, in three groups:

| Key | What it decides |
| --- | --- |
| `scheduler.armed` | whether the loop claims and dispatches, or only decides and logs |
| `scheduler.tick_min` | how often it decides |
| `scheduler.cooldown_min` | how long it waits between audits |
| `scheduler.fresh_days` | how old a result may get before its app is due again |
| `scheduler.stuck_days` | how long a parked app is left alone |
| `scheduler.lease_min` | when a claim is assumed dead and reclaimed |
| `scheduler.max_tries` | consecutive errors before an app is parked |
| `runner.enabled` | whether audits run at all — the second safety switch |
| `runner.busy_backoff_min` | how long to wait before the one retry of a busy agent |
| `bench.min_remaining_min` | runway a demo instance needs before a functional audit claims it |

`domain/controls.ts` is the only place that knows what any of them means — the label, the
range, the sentence explaining what changing it does, and the live setter it drives. The
routes, the two chat tools and the page all render that array, so a new control is one entry
and appears on all three surfaces at once. It is the same bargain the chat's catalogue makes
with `CHAT_TOOLS`, and for the same reason: a list in two places is a list that will disagree.

Four rules hold it together.

1. **`config.yaml` stays the default.** An override is kept in `state/controls.json` and is
   re-applied at boot. Every row carries both values and which one is in force, because "why
   is this 14 when the file says 7" has to be answerable from the page. Deleting that one file
   returns the instance to what the file asks for.
2. **It applies to the live object, not only to the file.** A changed `tick_min` replaces the
   running timer; a changed `fresh_days` is read by the next decision. A setting that took
   effect at the next restart while the page said otherwise is the failure this replaces.
3. **A control is not a verdict.** Invariant 6 is about who may write an outcome, and nothing
   here writes one: these change *when* and *whether* audits happen, never what one concluded.
   `set_control` is marked `writes`, so an admin MCP under `read_only` does not serve it —
   which matters more here than for `run_assay`: an aggregator that authenticates nobody must
   not be able to disarm the loop.
4. **Every change is a row in the log** — `CONTROL_CHANGED`, naming the key, both values and
   the `by` that made it. `scheduler.armed` is the one exception to the write path: the
   scheduler has persisted that switch in `state/schedule.json` since the Automation page's
   button existed, so this layer drives it and lets the scheduler keep it, and does not log a
   second row on top of `SCHEDULER_ARMED`.

### 16.4 The surfaces

- `GET /controls`, `PUT /controls/:key`, `DELETE /controls/:key` — its own prefix rather than
  a branch of `/settings`, which already has a static `/settings/context` of the same shape.
- **Automation § Settings** — the numbers that page already reported as facts, made editable,
  rendered from the response. A number commits on Save rather than on each keystroke: typing
  `14` over `7` passes through `1`, and a control that applied it would put the timer on a
  cadence nobody asked for. `scheduler.armed` is excluded from that list because it is the
  switch at the top of the same page.
- **`get_controls` and `set_control`** in the chat, and therefore over the admin MCP. Seventeen
  tools now, twelve reading and five acting.

### 16.5 Not done, deliberately

- **The endpoints are still not controls.** `runner.agent_url`, `agent_tool`, `agent_via` and
  the `browsers:` list are read at construction, so putting them on this list would be exactly
  the lie the settings page refuses to tell. R5/R6 needs the Runner to re-read them per call —
  the mechanism to expose them afterwards now exists.
- **No control writes `config.yaml`.** An override sits beside it, and the file stays the thing
  a person edits and a fresh install boots into. Two writers for one value is how they come to
  disagree.
- **No per-control permissions.** There is one authenticated audience (UX §5), and the two
  safety switches are as reachable as the cadence. What separates them from the read surface
  is the `writes` mark that `read_only` filters on, not a role.


## 17. R15 — What an auditor needs to know, which is not what an app is judged by — 2026-08-28

### 17.1 What was true before

`functional.md` was 24 KB, and roughly a third of it was not a rubric. §2 "The platform is
Maison" described routes and dialogs. Phase C explained the backup picker, the Tips dialog and
what the install progress bar does. Phase G explained that the uninstall confirm offers to zip
the archive and that you should leave that off. There was a postmortem about a store cache in
the middle of it.

All of it is true and all of it is worth writing down. None of it says what makes an app pass.

Three costs, and the third is the one that forced the change:

1. **It reads as rubric.** Everything inside a document titled *Functional Review Protocol* looks
   like something apps are being judged on. An agent given 24 KB of it cannot tell which
   sentences are the gate.
2. **The gate is diluted.** The verdict criteria compete for attention with a paragraph about a
   progress bar.
3. **Writing a fact down re-versions the standard.** The protocol's identity is the sha256 of the
   file (invariant 9, R13). Recording *the Tips dialog is where credentials usually are* meant
   editing the rubric — which moves `moved_at`, makes every subject eligible for re-audit, and
   spends days of agent time re-running full audits because somebody documented a dialog.

The trigger was an audit of FileBrowser reporting that *the app's documented default account
must work on a fresh install, with no need to read logs or run commands* — when the default
credentials **were** documented, in the Tips dialog, which the run had dismissed unread. The
audit was not wrong about its own evidence. It had never been told where an app documents that.

### 17.2 The requirement

> A knowledge base beside the rubrics: markdown pages of supporting knowledge, with an index so
> the agent knows where to look. The rubric stays about the requirement gate.

### 17.3 What it took

`data/kb/`, a sibling of `data/protocols/` — not a folder inside it, because that directory is
scanned for sections and for executors and a page is neither.

- **`KB.md` is the index**, hand-written. "Where do I look" is a judgement, not a listing, so it
  is not generated. It rides along with the pages and never alone: an index is a table of which
  page to read for what, and handing it over with none of those pages attached describes
  material the agent has not been given.
- **Every other `*.md` is a page.** `sections:` in its frontmatter says which sections it bears
  on; declaring none means all. A static-only run — which is every run made while the demo pool
  is down — is therefore handed nothing about a dashboard it will not open.
- **It is appended to the prompt after the protocol**, under a fence that says what it is: *it
  never adds a requirement, never excuses one, and never decides a verdict; where it and the
  protocol disagree, the protocol governs.* The order is part of the claim — a page arriving
  before the rubric would read as a qualification of it.
- **Absent, nothing changes.** `forSections()` answers null when the volume has no KB and the
  prompt is byte-for-byte what it was before one existed, which is what keeps the archive's
  earlier reports comparable with the next one.

### 17.4 The line, and where the FileBrowser case actually landed

The motivating case is two statements, and they went to different files:

| | Where | Why |
| --- | --- | --- |
| *Maison shows a Tips dialog at install and keeps it on the tile menu; it is where an app's first URL, path or credentials are usually documented* | `kb/maison.md` | a fact about the platform — it tells the auditor where to look |
| *Credentials the platform surfaces — Tips, the store description, the app's own first screen — count as **documented**; finding the same value by reading logs or opening a shell does not* | `functional.md` §3 Phase F | it decides whether the app passes |

Putting the second in the KB would have made the KB an unversioned rubric, which is the exact
failure R13 was built to end. **The KB says where to look; the protocol says what makes it a
pass.**

### 17.5 Recorded, but not a standard

A KB page can change what an audit concludes. A hash on an assay that resolves to nothing is the
"the archive says v7 and no v7 exists" problem R13 fixed, so the KB is recorded — and it is
recorded *as what it is*:

- Every assay the agent produced carries **`kb_sha256`**, a digest over the pages it was actually
  shown. Over the *selection*, not the directory: two runs given different pages were reading
  different material, and a hash that could not tell them apart would be a hash of something
  nobody saw.
- A second `RevisionStore` over `data/kb/` keeps the bytes, with the same sweep-on-observe
  behaviour, so an edit made over SSH is recorded too. Two stores rather than one over two
  directories: revision file names are bare (`functional.md`), so one log could not say which
  `maison.md` it meant.
- **`domain/standards.ts` never reads it.** No `older standard` chip, and no re-eligibility: an
  edit to a reference page must not spend three days of agent time re-auditing 72 apps. That is
  invariant 12's argument, applied to the same class of thing.

The digest answers *was the agent reading the same material as today*; the history, being
time-ordered, answers *what did it say when this ran*. Those are the two questions anybody asks
of a document that was in the room.

### 17.6 What moved

`functional.md` 24.0 KB → 21.0 KB, and what left is the 8 KB of `kb/maison.md`: the CasaOS
comparison, the routes, the accessibility-tree advice, the store cache and its postmortem, the
`?store=` canonicalisation, the backup picker, Tips, the install progress bar, the uninstall
dialog, and the list of platform behaviours that are never an app's fault. What stayed is the
result vocabulary, the coverage sentence, the inputs, the phase plan with its pass criteria, the
gate, determinism, and the cleanup obligation.

### 17.7 Not done, deliberately

- **No route writes a KB page.** It is operator-authored on the volume, like `config.yaml`. If
  the chat is later given `edit_kb`, it goes through the shape `edit_protocol` has — a required
  reason, a recorded revision, dropped under `admin_mcp.read_only` — because prose that changes
  what the next audit concludes is the same class of thing whatever folder it is in.
- **No UI.** Nothing renders the KB or its history; the bytes and the log are on the volume. A
  page is worth building when there is more than one document to browse.
- **No per-page inclusion in the report.** The digest says which set was given, not which page
  the agent leaned on. Recording that would mean asking the agent, and an agent's account of
  what influenced it is not evidence.

## 18. The rubric cleanup — 2026-08-28

Operator feedback on reading the two protocols end to end, taken in one pass because each item
moves `moved_at` and four separate saves would have re-audited the archive four times.

### 18.1 One id space, not two

`functional.md` carried a `phases:` block keyed `A, C, D, E8, E9, E10, F, G` **and** a
`requirements:` list keyed `phase-a-session…` — two id spaces for the same eight facts. The
letters were a fossil of the document this rubric was exported from, and they had the holes to
prove it: no `B`, no `E1`–`E7`, gaps where an older sequence's steps used to be. Every reader
had to learn that "E8" meant "works immediately" instead of reading it.

`static.md` had never done this. Eighteen flat semantic ids — `permissions`, `caddy-wiring`,
`hook-idempotency` — one list, no letters. Functional was the outlier, so it was brought into
line rather than the other way round.

**A phase is not a different kind of thing from a requirement**; it is a requirement that also
happens to be an ordered step. So there is one list now, and a requirement that is a step says
so with `phase: <short label>`. `phasesOf()` derives the plan from it, a literal `phases:` block
still wins where a rubric carries one, and the ledger, the prompt and the UI track read the same
ids the rubric names.

Three code sites were carrying the letters and would have gone silently stale:

- **`prompt.ts` step 4** spelled out `A session, C fresh install, D discover URL…` in prose. It
  now names the section's declared plan, so a rubric that renames a step cannot end up telling
  the agent one set of ids while the ledger accepts another — and the per-step detail it
  duplicated is the rubric's to state.
- **`MANDATORY_PHASES`** in `domain/extract.ts` was a hardcoded set of letters, imported by
  `domain/assay.ts` and never read. Invariant 2 in miniature. Deleted.
- **`PHASE_ROW`**, the prose fallback used when the ledger recorded nothing, matched only
  letters. It now carries both vocabularies: the archive is not rewritten, and a loose match is
  safe because `sectionRan` keeps only ids the declared plan names.

`PHASE_LABEL` in `shared/activity.ts` was left alone deliberately — it decodes what old assays
say, and old assays still say `E8`.

### 18.2 `migration` is declared rather than invented

`G′` was prose telling the agent to record `n-a`, not a declared id. So the agent invented a
phase called `G'` on every run — observed on `yundera~Tuwunel`, 2026-08-28 — and the UI dropped
it, because `mergeTrack` maps over the declared plan and an unplanned id has nothing to attach
to. The protocol's own argument for recording it (*"a row that says so is the only thing keeping
it from looking like a phase that quietly passed"*) was being defeated by the row being
invisible. It is `migration` now: declared, permanently `n-a`, with the reason in its text.

### 18.3 Functional demanded a severity and never defined one ✅ fixed

The gap that mattered most, and the reason this went in ahead of the renaming. `static.md` §3
defines Critical / Major / Minor concretely with examples. `functional.md` said "with a severity
on every `fail`" three times and stopped — while `risk_score` is `100·Critical + 10·Major +
1·Minor` and **any** Critical is unconditionally non-compliant. The most consequential number in
a runtime audit came from whatever the agent felt at the time.

`functional.md` §4 now gives each requirement a **default tier** — `auth-gate` and
`data-persistence` Critical, the install-and-usability ones Major, `clean-boot` Minor, `session`
none because it is infra — and requires a stated reason to raise or lower, with `auth-gate` and
`data-persistence` never lowered. Mechanical default, argued deviation: the same shape as
static's D1–D5.

### 18.4 The static leaf had functional's old disease

Roughly a third of `static.md` §6–§7 was platform mechanics: which metadata block Maison reads
and which wins, what it parses and then ignores, when declared folders are created, when each
hook fires, and that hooks run inside the Maison container against the host daemon with `/DATA`
bind-mounted at the same path. That is knowledge-base material by §17's test — it tells the
auditor where to look, it does not say what makes an app pass.

It moved to `kb/maison-compose.md` (`sections: [static]`), so a functional-only run does not
carry it and a static-only run does. The verdict tables stayed, trimmed to the verdict: what to
check, what tier it fails at. `static.md` went 18.7 KB → 16.3 KB.

One paragraph deliberately stayed: *a read-only test in a hook reads the real host file*, and
the note that the opposite inference **has been drawn and shipped as a Major against an app
whose guard was correct**. The mechanism it rests on is in the KB; the instruction not to make
that mistake is a judging rule.

### 18.5 The Docmost and n8n fossils are gone

Both rubrics opened with a line about Docmost pages driving a workflow in n8n. `prompt.ts`
carried more: a whole branch fetching the orchestrator and its leaves from Docmost by slug and
applying "every dated Amendment section" as binding, a branch selecting a demo host off the
management board, and an opening rule justified by *"n8n handles all publishing"*.

All removed. The two protocol lines, and in the prompt: the wiki branch (unreachable — the
runner refuses a run with no protocol before `buildPrompt` is called), the host-selection branch
(the caller always supplies a probed host, and the board's own "most time remaining" rule once
preferred an instance whose login answered 500), and the publishing justification — the rule not
to publish is unchanged, but an agent told somebody else does it might reasonably wonder whether
to help.

One Docmost mention was **kept on purpose**: the prompt still says *do not call `docmost-mcp`
looking for the protocol*. The wiki is gone; the aggregator still lists the tool, so an agent
that decides the rubric must live somewhere canonical can still find something to fetch.

### 18.6 The duplicated recording section

Both rubrics carried a `## How results are recorded` block naming `touchstone__list_requirements`,
`touchstone__record_requirement` and `touchstone__record_phase` — a second copy of what
`prompt.ts` already emits whenever a callback exists. Tool names are a property of the runner:
rename one and the code changes while the rubric silently rots.

The tool mechanics were deleted from both. What stayed is what is genuinely normative and has to
be hash-recorded per section: what each value *means*, that there is no `skipped`, the coverage
sentence, never defer to a human. Functional now states both vocabularies explicitly — a
requirement takes a **verdict** (`pass` / `fail` / `n-a` / `unverified`), a step takes a
**result** (`pass` / `fail` / `errored` / `n-a`) — because the two tables previously looked
contradictory and were in fact about different things, with functional never stating its
requirement-level vocabulary at all.

**Not done:** moving those shared conventions into an orchestrator protocol, which would give
one copy instead of two. `kind: orchestrator` already exists and is given to every run, but **an
orchestrator's hash is recorded on no assay**, so normative text moved there becomes invisible
to `standard_sha256`. That is a prerequisite fix, not a detail to accept quietly.

## 19. Where the rubric lives, and who owns it — 2026-08-28

### 19.1 The bug that made the point

Adding one knowledge-base page broke a release. `deploy/Dockerfile` gained
`COPY data/kb/ ./seed/kb/`, but `.dockerignore` said

```
data/*
!data/protocols/
```

so `data/kb/` was never in the build context, `COPY` failed on an empty source, and v1.1.12
produced a tag with no image. Typecheck and tests were green; the packaging was not.

The lesson is not "remember the third file". It is that **a `COPY` whose source depends on an
exception in a second file breaks the first time somebody adds a directory** — which is a
property of shipping instance data alongside code, not an accident.

### 19.2 What was actually wrong

The rubric was committed at `data/protocols/` *and* shipped from there. Neither the seeding nor
the never-overwrite rule was wrong — the image's copy had had no effect on `yunderalabs` since
its first boot — but two things were:

- **The repo's copy looked like the live standard.** A box edits its own; that is the point of
  an editable rubric. The tracked file drifts from every instance the moment anyone uses the
  editor, while still being what a reviewer reads. On 2026-08-28 that cost real time: applying
  the functional/KB split meant pulling the box's file down and diffing *bodies* to discover its
  frontmatter had been re-serialised by an older build on 08-24, and that overwriting it would
  have reverted an operator's edit.
- **Development never ran the seeding code.** The checkout arrived with `data/protocols/`
  populated, so `ensureProtocolFiles` only ever executed in a container — a poor place to find
  out it does not work.

### 19.3 `seed/`

`data/protocols/` → `seed/protocols/`, `data/kb/` → `seed/kb/`, and **all** of `data/` is
gitignored. `PROTOCOL_SEED_DIR` and `KB_SEED_DIR` already resolved to `<REPO_ROOT>/seed/…`, so
the code did not move; the files moved to where it was already looking.

- The Dockerfile is one line, `COPY seed/ ./seed/`, and `.dockerignore` needs no carve-out:
  adding a seeded file is adding a file rather than editing three places.
- The name states the relationship. `seed/` is what a fresh install starts with. It is not what
  any box is running.
- Development seeds itself on first boot, so the path is exercised on every fresh checkout.

**The direction of truth, written down because it was only ever implied:** the box is the
original; `seed/` is the default the next fresh install begins from; bringing a box's
improvement back into `seed/` is a deliberate, reviewed act. The same rule `config.yaml` has
always followed.

### 19.4 Fail closed when a section produced nothing

`sectionRan` returned `{ ran: true }` for any section with no phase plan — "nothing to gate on".
True for the static checklist. False, and dangerous, for a section that declares
`requires: [bench, browser]`: it was dispatched against live infrastructure and came back with
no plan, no requirement and no prose, and that was being recorded as a completed audit of the
app. Fail-open in the one place the system is meant to fail closed (invariants 3 and 4).

It also has a shape. A rubric whose frontmatter the running build cannot read declares its steps
and derives none — which is exactly what `functional.md` would have done on v1.1.11, whose
`sectionsOf` reads a `phases:` block that no longer exists. The protocol edit was held back for
that reason; the guard means the next one fails visibly instead.

The test is **evidence, not shape**: a live section with no sequence still counts as run once it
has settled a single requirement, recorded any phase, or written prose. Only total silence is
blocked.

### 19.5 Still open

**A `schema_version` for the protocol file format.** `static.md` fails an app **Major** for
relying on `folders` or `hooks` without declaring `schema_version: 2`, and the stated reason is
that an older reader starts it silently without them. That is precisely what a rubric using
`phase:` does on a build that predates it. Touchstone should hold its own format to the rule it
grades apps against: a leaf declaring a schema the build does not know is recorded blocked with
a reason, rather than half-read. §19.4 is the cheap guard; this is the correct one.

**A drift indicator.** The revision log already knows — a file whose newest revision is `source:
seed` is pristine, anything else has diverged — so the Protocols page could say "edited on this
box, 2 revisions since the shipped default" instead of leaving it to be diffed by hand.

---

## 20. An app the store no longer offers — 2026-08-31

### 20.1 The report

CasaDash and CasaOS were removed from the AppStore. Both went on appearing in the Store table on
`yunderalabs`, with their verdicts and their risk, indistinguishable from the 71 apps still on
sale.

### 20.2 Why, and the half that was worse than cosmetic

The Store page is the union of the registry and the archive, which is §11's design and is right:
a store that goes unreachable must not blank 72 rows, so a subject that drops out of the live
list keeps its row through its reports. `SubjectRegistry.list()` implemented that by appending
every archived key under a configured origin, unconditionally.

The rule cannot tell two situations apart, and they mean opposite things:

- **the store is unreadable** — keep everything, change nothing; and
- **the store is readable and does not list this app** — it is gone.

Both arrive as an archived key with no live entry. Reading the second as the first is what put
the rows on the page.

The half that was not cosmetic is that `list()` is also the **scheduler's candidate set**
(`scheduler/index.ts` `subjects()`). A withdrawn app therefore stayed in the backlog for ever: it
would be picked as the stalest row, dispatched, fail to fetch a directory that is not there,
record an errored assay, stamp its finish time and go round again — spending agent time on an app
nobody can install, in front of apps that could be audited instead. CasaOS's last report is dated
2026-08-25, three days after it left the store.

### 20.3 Delisted

**A subject is `delisted` when the archive knows it, its origin is configured, that origin's last
fetch *succeeded*, and the live list does not contain it.** `SubjectRegistry.delisted()`.

The gate on `reachable()` is the whole safeguard, and it is the same asymmetry `subject_version`
uses for `unknown`: doubt must never delist. A GitHub outage that made every store unreadable
would otherwise retire the entire archive at once, take 72 apps out of the backlog and put a chip
on every row, and it would do it silently.

What follows from it:

- **It leaves `list()`**, so the scheduler stops picking it. Nothing else about scheduling
  changed; there is still no queue and no exception list (invariant 8).
- **It keeps every report it earned.** A verdict reached about an app that existed is not
  falsified by the app being withdrawn. The row stays on the Store page and on the board.
- **It is not a verdict.** It sums into no risk, sets no age, moves nothing. It qualifies the
  *subject*, where `older standard` and `app changed` qualify a *verdict* — which is why it is a
  third chip rather than a widened one, in its own slate colour, drawn first.
- **It is said once, when it happens** — a `SUBJECT_DELISTED` row on the refresh that noticed,
  not on every refresh after.

### 20.4 Saying it where the answer is composed

The chip fixes the page. It does not fix the question the operator actually asks, which arrives
through the admin MCP: *how is the store doing?* — answered by a model reading `get_board`,
`get_subject`, `get_fix_brief` and `get_report`. A model that cannot see that an app was withdrawn
folds its Critical into the roll-up and reports a store worse than it is.

So the tools say it, in the place a model reading half a long answer will still see:

- `get_board` marks the row **and takes it out of its own counts** — "N app(s) in the store …
  plus M DELISTED", because the mark alone does not prevent the arithmetic error.
- `get_subject`, `get_fix_brief` and `get_report` **lead** with one sentence saying what delisted
  means and asking for it to be left out of any roll-up. First line, because a report runs to
  hundreds of lines and a caveat below the fold does not arrive.
- `list_subjects` still lists it, marked — an operator naming CasaOS is owed "it was removed",
  not "no such subject", which reads as a typo.
- `run_assay` refuses it by name and says why, for the same reason.

### 20.5 Deleting one

`DELETE /subjects/:name` removes a subject's reports from disk and from the index, and drops the
scheduler's row for it. It is the only destructive verb in the app and the only thing that ever
takes something out of the archive.

Three guards, and the first is the feature rather than caution:

1. **It refuses anything that is not delisted.** `delisted()` already draws the one distinction
   that makes a delete safe, so a live app cannot be purged by a mistyped name or a stray click,
   and nothing at all is deletable while the store is unreachable.
2. **It refuses while that subject is being audited**, rather than racing the process that is
   about to write its next report.
3. **It is not reachable from the chat or the admin MCP.** `CHAT_TOOLS` has no delete, by the
   argument next to invariant 6: an irreversible delete over a surface that authenticates nobody
   is not a thing to hand out for symmetry. The button is on the Store page, on the delisted row,
   where the audit button would be — the two verbs are mutually exclusive by definition.

It logs `SUBJECT_PURGED` at `warn`, naming the subject and the file count. The archive is the
only record that an app was ever audited; its deletion has to leave one of its own.

### 20.6 Still open

**Nothing re-lists an app.** If a withdrawn app comes back to the store it simply stops being
delisted on the next refresh, joins the backlog again, and its old verdicts stand under the
`older standard` and `app changed` chips as usual. That is the right behaviour and it is
untested — no app has come back yet.

**The delete is one subject at a time.** Clearing an accumulation of withdrawn apps is one
confirm per row. Fine for two; a "delete all delisted" would need a different confirmation than
this one, and there is no evidence yet about how often it is wanted.

## 20. A completed audit that was thrown away — 2026-08-31

### 20.1 The bug that made the point

`yundera~UptimeKuma` was audited on 2026-08-28, 08-30 and 08-31. Every one of those runs
**succeeded**: `verdict: compliant`, 23 of 23 requirements settled, both sections, a full report
body. Touchstone discarded all three and logged `AGENT_UNAUTHENTICATED` — "the audit agent is not
logged in, so no audit can run" — over a Claude Code session whose OAuth credential was refreshing
on schedule and valid the whole time.

`classify()` in `runner/agent.ts` tested `AUTH_RE` against the **entire** agent response, report
body included, and returned before the envelope-parsing loop further down the same function was
ever reached. `AUTH_RE` matches `not logged in`. A functional section that *proves* an app's auth
gate writes exactly that phrase — *"the server returned the login page because we were not logged
in"* — so the audits most likely to be binned were the ones that had done their job.

The rule that prevents it coming back is one sentence: **a response that parses into a valid
report is never an infrastructure error.** An auth failure is two lines long and carries no JSON,
so it cannot reach `envelopeOf` and every failure branch below is left exactly as n8n wrote it.

### 20.2 What it cost, which was not one report

The classifier was one bug. What made it a five-day outage was four rules downstream that trusted
it, each defensible alone:

- **The subject was charged.** `agent-auth` mapped to `{ kind: 'error' }`, so three false failures
  burned `max_tries` and parked the app for `stuck_days`. `agent.ts`'s own header table had said
  `agent-auth` costs no try since the file was written; `record.ts` had always disagreed with it.
- **Nothing recorded that we had looked.** A failed run wrote no assay file, and `lastAttemptAt`
  reads the archive. So the re-audit flag set on 08-28 was never spent, `standardMoved` never
  settled, and the `older standard` chip could never clear — while `try_n` and `parked_at`, which
  live in `state/schedule.json`, moved every time.
- **The loop said nothing was wrong.** `decide()` reported `backlog empty — all 73 app(s) audited
  within 14d`, a claim about every subject in the registry, while a parked row had been skipped a
  few lines earlier without being audited at all.
- **No alert, and no control.** `AlertKey` declared `agent.unavailable` and nothing had ever
  opened it — `alerts.open` was called only from `services/bench.ts` — so three days of failing
  audits produced no card, while `get_status` reported *"Port agent: healthy"* because `ports.ts`
  probes with `tools/list`, which answers fine when a session is dead. Meanwhile the Automation
  page hid the flag on parked rows, on the correct reasoning that flagging one did nothing.

The operator's own summary was *"I feel like we have a big hole in our automation algorithm"*. The
algorithm was fine: the standard moved on 08-28 and the loop re-audited the store to the end of the
alphabet on 08-29/08-30 unprompted. Every symptom was this one regex and the four rules that
believed it.

### 20.3 What it took

- **Parse first.** `envelopeOf()` split out of `classify()` and called ahead of the failure
  branches. Its predicate tightened from "has a `report_markdown` or `verdict` key" to a non-empty
  body or a verdict in the enum, so `{"verdict": null}` cannot outrank a real failure and
  `{"error": "not-an-app"}` still falls through to `parse-failed`.
- **`agent_auth`, a `RunOutcome` of its own** — free of a retry (invariant 3) but stamping the
  cooldown, which is the one asymmetry with `agent_busy` and is there so a genuine outage cannot
  be marched through the whole registry one 26-minute failure at a time.
- **`Runner.recordAttempt`** — one `blocked` assay per section for `agent-error` and
  `parse-failed`, establishing invariant 14: charging a try implies writing an attempt record.
  `blocked` rather than a new status, because `ReportIndex.latest()` already filters it out of
  `lastDoneAt` while `latestAny()` feeds `lastAttemptAt` — exactly the two behaviours wanted.
- **The `agent.auth` alert**, opened by the runner on the first failure and resolved by the next
  usable answer, with `AGENT_UNAUTHENTICATED` dropped from `notify.ts`'s routes so one condition
  sends one notification.
- **Honest reason strings.** `TickDecision.parked`, and `backlog empty — 72 fresh, 1 parked`.
- **Evidence kept.** `dump()` writes for every failure class to `last-failed-response-<class>.txt`,
  and the error branch's `rawText` cap went from 2 000 to 20 000 — the phrase that caused all of
  this sat past the old cut, which is why five days of it left nothing to diagnose.
- **A flag releases a park**, so the control means something on the row that needs it most.
- **One vocabulary.** `assay now` and the flag, two verbs and two words, replacing five spellings.
  `AuditButton` is deleted; the Store table carries the flag.

### 20.4 Not done, deliberately

- **`parse-failed` still charges a try.** Unlike auth, retrying can genuinely fix a truncated
  answer, and E7's starvation rule needs something to eventually park an app whose reports never
  parse.
- **No deep auth probe** in `ports.ts` mirroring `browserLiveness()`. Same shape of problem, but a
  real probe costs a token per tick and the runner learns it for free on the next dispatch.
- **No dispatch gate while `agent.auth` is open**, the way the bench gate works. The cooldown stamp
  already prevents hammering; if that proves insufficient the gate is the next step, not the first.
- **No rewrite of `policy.ts`.** It was never the problem, and §20.2 is the evidence.

## 21. R16 — One agent, one queue, one verb — 2026-09-01

### 21.1 What was true before

Touchstone has **one** Claude Code endpoint and **four** ways to ask for it: `assay now`
(`POST /assays`), the re-audit flag (`POST /schedule/flag`), a trial (`POST /trials`), and the
scheduler's own backlog pick. Three of the four **refused** when the loop held the agent:

```
routes/assays.ts    if (runner.busy) 409 'an audit is already running'
trialrun.ts         if (runner.busy) 409 'a run is already in progress'
chat/registry.ts    run_assay / run_trial — the same refusal, as a sentence
```

A 409 is not an answer. It is the caller being told to press the button again later, with no
indication of when later is, and nothing recorded to say they ever asked. The flag was the only
one that degraded — because it never took the agent at all — so **the one control that always
worked was the one that appeared to do nothing**, and the two that read as decisive were the two
that broke. The operator's question was whether the flag and `assay now` were the same thing.
Nearly: they were the same *request* at two urgencies, and the urgency was not theirs to choose.

### 21.2 The requirement

Serialize the asks instead of refusing them. Every operator request joins one queue, drained
ahead of the backlog in **strict order of arrival**, whatever kind of thing it is. When the line
is empty a request still starts within seconds, so nothing gets slower. One button, `Audit`.

Five decisions, taken before any code:

| Question | Decision |
| --- | --- |
| Agent free, requests already waiting — does `Audit` jump? | **No.** It always enqueues; the tick decides. "Starts immediately" is the empty-line case, not a special path. |
| Trial vs subject request | **Strict order of arrival.** One line, one ordering key, because there is one agent. |
| `POST /assays { wait: true }` | **Dropped.** Honouring it meant keeping the direct-run path this change exists to delete. |
| Infra (no bench) at the head | **Blocks the line**, for trials as well as audits. |
| An audit that ran and failed | **Spent.** It leaves the queue and rejoins the ordinary backlog rotation with its try burned. No queue-level retry. |

### 21.3 The mechanism, and why invariant 8 survives

**One ordering key: when it was asked for.** A subject request is `SubjectSchedule.flagged_at`; a
trial request is its row's creation time. The head is whichever is older, and `decide()`'s branch
order becomes:

```
agent busy → request (trial or audit, oldest ask first) → cooldown → backlog empty → stalest
```

The audit half of the queue is **derived, not stored** — a subject is in the line exactly while
`flagged_at` is newer than its last attempt — which is what keeps invariant 8's actual property:
nothing has to remember to remove anything, and a run killed by a `tsx watch` restart leaves the
request correctly still queued rather than a row stuck at `running` for ever. `shared/trials.ts`
had cited invariant 8 by name as the reason a queue could not exist; it can, for the half that
can be derived. Trials are the stated exception, because a trial has no attempt record for a
timestamp to be spent against.

`armed` now gates **the backlog and nothing else**. That is not new behaviour dressed up —
`POST /assays` never consulted the switch — but it is newly visible, so the Automation page says
*"the backlog is not being worked; N requested audits will still run"* on the switch itself.

**The bench gate holds the line rather than skipping it**, and applies to trials too. A trial that
ran with a dead pool would answer the static half and record `functional` blocked, and a PR author
reading that reasonably concludes the app is fine. One rule for both verbs; the queue head names
what it is waiting for.

### 21.4 The rule that stops the kick being a spin loop

A queue is useless if it waits out `tick_min` after each item, so `Scheduler.record()` looks again
as soon as something finishes. Naïvely that is a livelock. Four `blocked` reasons return in
**milliseconds** without touching the agent (`runner_disabled`, `runner_busy`, `store_unreachable`,
`no_protocol`), and `agent_busy` and `agent_auth` cost no try and write no attempt record — so the
request is never spent and the next tick decides exactly what this one decided. An armed box with
`runner.enabled: false`, the shipped default, would rewrite `events.jsonl` past its 50 000-line
trim in seconds. `agent_auth` is the sharpest case: it *stamps the finish*, so a rule keyed on
that would re-dispatch a 26-minute failure back to back — defeating the exact guard E5b exists for.

**The kick fires only when the run wrote an attempt record** — `verdict` or `error`. This is
invariant 14 read forwards: the head of the queue has moved iff an attempt was recorded.

### 21.5 Four bugs it had to fix first

The design rides on `flagged_at` being a reliable request record. It was not.

- **`setFlagged` guarded on the stored field, not the derived state.** `flagged_at` is never
  cleared — `record.ts` carries it through every branch on purpose — so after one request and one
  audit the field is still set while `isFlagged()` correctly reads false. The guard therefore
  refused to write a *new* request for any subject that had ever carried one. Harmless while it
  only moved a glyph; fatal once it is the queue, because `Audit` would silently do nothing on
  exactly the apps an operator returns to.
- **`dispatchFailed` charged a try and wrote no attempt record** — a live violation of
  invariant 14 that CLAUDE.md believed closed. `Runner.recordFailedDispatch` closes it.
- **A park released only on the flag's transition**, so park-while-flagged was a dead control: no
  unpark, and `plan()` skips parked rows before any eligibility clause while still reporting the
  row as flagged. A row that says it is queued and can never be picked is the one thing a queue
  must not contain.
- **A crashed trial was stuck for ever.** `dispatchTrial`'s `.catch()` only logged, so the row
  kept its start time with no finish and `get_trial` answered "ask again shortly" indefinitely.
  `TrialRecord.began_at` distinguishes queued from running, and `TrialStore.reconcile()` closes
  the stranded rows at boot.

### 21.6 The vocabulary, third and last

One verb, one word: **`Audit`**. `AuditControl` replaces `AssayButton` and `FlagControl`; every
live row on the Store table carries it, which it could not before — a control that seizes the
single agent makes 73 rows into 72 disabled buttons and one footgun, and a control that queues is
safe on all of them. `flag_reaudit` leaves `CHAT_TOOLS` (18 → 17) and, by construction, the admin
MCP: it was a second spelling of `run_assay`. `POST /schedule/tick {forced}` is deleted — parity
row A3 — because a request is the same intention arrived at honestly, with a place in a line and
a row that can be withdrawn.

The Automation page splits its one list into **Requested** and **Backlog**. They answer different
questions: one is work the loop was told to do, drains in arrival order, ignores the cooldown and
runs whether or not the switch is on; the other is the rotation the loop works out for itself,
which the switch gates. Rendering them as one list is how an operator comes to believe a request
started something, or that stopping the loop stopped their audit.

### 21.7 Not done, deliberately

- **No queue page.** Automation already rendered a queue; a second page called Queue is the
  vocabulary problem one level up. It gets a count badge instead.
- **No rate limit on the cooldown bypass.** Twenty requests drain back to back on an agent shared
  with n8n's `AppStore PR Review`. That is what "in order, without delay" means; if it hurts, the
  answer is a `requests_spacing_min` control, not a re-litigation of the bypass.
- **No queue-level retry.** A failed audit is spent and rejoins the backlog, where `max_tries` and
  `parked_at` already handle repeated failure.
- **The thread a chat-started run reports back into is held in memory**, not persisted. The only
  thing persistence would buy is a note delivered after a restart, which cannot happen — a restart
  kills the run the note would be about.
