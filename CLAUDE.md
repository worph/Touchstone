# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Touchstone is a **conformance agent**: it holds a versioned standard, runs *assays* against
*subjects* (apps in the Yundera AppStore), and issues a *hallmark* — the verdict a subject carries
until the next assay contradicts it. It exists to absorb exactly two n8n workflows
(`AppStore Continuous Store QA Loop` — the driver, and `AppStore App Audit` — the executor) and
nothing else. `AppStore PR Review` and release notes stay in n8n and are out of scope.

**The parity matrix in [ARCHITECTURE.md §1.4](ARCHITECTURE.md) is the specification.** n8n cannot
be switched off until every row is covered, and anything not on it is not being built. Before
adding a capability, check whether it is on that matrix or in §1.4 G ("deliberately dropped" —
findings-as-rows, rule codes, cross-subject aggregation, regression detection, history views).

Vocabulary used throughout the code: **subject** (an app), **standard** (a versioned rubric),
**assay** (one run of one standard against one subject), **hallmark** (the composed verdict),
**bench** (a leasable demo instance), **section** (one leaf of the protocol — one rubric, one
assay file; `static` and `functional` today, but the set is whatever `data/protocols/*.md`
declares), **alert** (a deduplicated environment condition), **origin** (an app store — one
`{repo, ref, apps_path}` a subject comes from, labelled "Store" in the UI; **not** `store/`,
which is the filesystem layer, and **not** `AssayStore`, which is the read interface the routes
take), **trial** (a one-shot audit of **one store zip and one app inside it** — a GitHub branch
archive, or files uploaded straight into a session — written under `data/trials/` and never read
by the report index, so it cannot move a hallmark), **board** (the read-only public view of
every subject's hallmark, at `/public`, addressed to app authors rather than to the operator).

A subject's identity is `<origin>~<name>` — `yundera~FileBrowser`. The separator is `~` because
it is unreserved in `encodeURIComponent` and therefore survives a URL untouched, which is what
lets every route keep the single-segment shape it already had. `src/shared/subject.ts` owns the
key, and `SubjectKey` is a branded type so the compiler catches a bare name used as a key.

`leg` is the old name for a section and survives only in report files written before
2026-08-20, in the two-column Overview, and in `Leg`/`LEGS` in `domain/hallmark.ts`. New code
says `section`. There is **no `depth`**: a run audits every section, and a section whose
`requires:` cannot be satisfied is recorded blocked rather than narrowing the run.

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
- The compose file also runs Touchstone's **own** `browser-mcp` sidecar on 9746 — not the shared
  box-wide `browsermcp`, and deliberately **without a profile volume** (see Invariants).
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
| `config.yaml` | hand-edited; seeded inert on first boot by `ensureConfigFile` |
| `protocols/*.md` | **the rubric itself**, the definition of the sections, and the version every assay records: a leaf's `id` is a section id, its `order`, `requires`, `phases` and `report_headings` are what the runner reads. There is no separate `standards/` — a second file could only disagree with the rubric it versioned |
| `reports/<origin>/<Subject>/<ISO>-<section>.md` | **the assay record IS the frontmatter of the report file**. The origin level is a namespace, not a uniqueness rule: two stores may both ship a `FileBrowser` |
| `trials/<slug>/<Subject>/<ISO>-<section>.md` | a **trial** — the same run against a store zip, written where the report index never looks, so it cannot move a hallmark or enter the backlog. The slug doubles as a synthetic origin, so the path machinery is unchanged |
| `trials/<slug>/store.zip` | that trial's own copy of the archive it audited, re-served at `/api/v1/trialstore/<store_token>.zip` for the bench to install. Inside the trial's directory because the index only ever picks up `*.md`, so it is invisible to it and dies with the trial |
| `uploads/<id>/` | a session's files, which a trial zips into a store. A sibling of `trials/`, never inside it: a trial's own directory is scanned as a report tree |
| `state/*.json`, `events.jsonl` | small mutable runtime state and the append-only log |
| `state/index.json` | cache only — deleting it must always be safe |

`data/reports/`, `data/trials/`, `data/state/` and `data/config.yaml` are gitignored;
`test/fixtures/` is committed.

**Rule: nothing outside `src/server/store/` touches the filesystem.** Routes, the scheduler and the
runner get the index or a store object, never a path. The thing being replaced failed partly
because its data access was smeared through two 200-line n8n Code nodes.

### The pieces

- **`store/index.ts`** — the in-memory `ReportIndex` over `reports/**`. Built at boot by parsing
  **frontmatter only**; bodies are read lazily per request by the viewer. `state/index.json` is an
  (size, mtime)-keyed cache; any doubt about an entry re-parses the file.
- **`scheduler/`** — `policy.ts` is the **pure** port of n8n's `Pick next target`
  (`busy → forced → cooldown → backlog empty → pick the stalest`; the bench gate sits *after* that
  chain so the pick stays diffable against n8n). `record.ts` is the pure port of `Record result`.
  `index.ts` does all the world-reading and owns `state/schedule.json` and the timer.
- **`store/protocols.ts`** — the protocol files, and `sectionsOf()`, which turns the leaves into
  the `ProtocolSection[]` every other piece reads. This is the **only** place frontmatter is
  interpreted, so a new field has exactly one place to be understood.
- **`runner/`** — `prompt.ts` (assembles the sections being run into the prompt), `agent.ts` (the
  MCP call plus n8n's exact failure classification: `agent-auth` / `agent-busy` / `agent-error` /
  `parse-failed`), `index.ts` (one job in, one assay file per section out, a `RunOutcome` back).
  `execute()` resolves sections → capabilities → what runs and what is recorded blocked; there is
  no depth parameter anywhere in the chain.
- **`services/ledger.ts` + `routes/mcp.ts`** — the callback surface the agent uses to record each
  requirement *as it settles it*, so a run that dies at requirement 12 of 16 keeps twelve results.
  It also resolves each record's **section** from the canonical list, which is what lets one
  agent response become one assay per section without parsing the prose for headings.
- **`routes/mcp-admin.ts`** — the *same* twelve tools, served as an MCP server at
  `POST /api/v1/mcp/admin` so an agent can ask them: it renders `CHAT_TOOLS` into `tools/list`
  and hands `tools/call` to the same handlers with the chat's own `ChatToolContext`. There is
  no second definition of what an agent may ask this app, which is the point — a second one
  would be a second thing to keep in step with invariant 6. **Off unless `admin_mcp.enabled`**,
  and disabled it registers no route at all: it is meant to be beaconified into an aggregator
  that authenticates nobody, so turning it on is a statement about the box. `read_only` drops
  every tool marked `writes` (`run_assay`, `open_trial`, `run_trial`) from the list *and*
  refuses them if asked for anyway — the filter reads the mark rather than a list of names,
  so a new write tool is covered the day it lands; `token` is a bearer a beaconify sidecar can inject. `routes/rpc.ts` is the MCP
  envelope both surfaces share — `initialize`, `tools/list`, `tools/call`, and a `202` for the
  notification, which is what a discovery client waits for.
- **`domain/fixreport.ts`** — the audit composed into a brief for whoever has to fix the app,
  served as markdown by `GET /subjects/:name/fix.md`. It **quotes**: findings, severities,
  evidence and remedies all come out of the frontmatter, and where the agent proposed no remedy
  the report says so rather than inventing one.
- **`store/registry.ts`** — one list per configured origin, so one store's GitHub outage cannot
  empty another's. `reachable()` means *the last fetch succeeded*, and the runner asks it before
  dispatching: auditing against a store we cannot read would error and burn the subject's try
  for an infra condition, which invariant 3 forbids.
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
  in-process store cache can never hold an older copy (the URL is minted per trial). The index
  over trials is built per request with `cacheFile: null`, because `defaultCacheFile()` resolves
  to the *same* path for `data/reports` and `data/trials`.
  `services/trialstore.ts` is **the only place Touchstone dereferences a caller-chosen URL**, so
  it is the only place with a host allowlist (GitHub archives + `trials.public_base_url`), a
  re-check at every redirect hop, and a byte cap enforced on what arrived rather than on what
  `content-length` claimed. Widening that allowlist turns "audit this store" into a request
  forgery primitive, because `run_trial` is reachable from an admin MCP that authenticates
  nobody.
- **`services/ports.ts`** — probes the two non-bench dependencies (agent, browser) by `tools/list`
  over MCP. `services/bench.ts` keeps its own prober because the bench pool is **discovered** from
  the pool API, not configured.
- **`services/events.ts` → `alerts.ts` → `notify.ts` / `push.ts`** — the local log is
  authoritative; alerts dedup an environment condition to one row; outlets and push are
  best-effort.
- **`src/server/chat/`** — the administrator chat: a bounded turn loop (`loop.ts`, 8 calls and
  120 s), file-backed threads (`thread.ts` → `state/chat/*.jsonl`), twelve tools wrapping the
  API (`registry.ts`), and the agent call (`driver.ts`) reusing `postToAgent` from the runner.
  Nine of the twelve **read**, and most of those read what is *written down* — the board, the
  archive, a report file, the fix brief, the log, the backlog — not the live process, which a
  `tsx watch` restart empties while the operator is still waiting for the run it started
  (HANDOFF §5k). Four of them are the same question at four depths, which is why their
  descriptions work so hard to stay distinct: `get_board` (every app), `get_subject` (one
  app), `get_fix_brief` (its findings), `get_report` (the file, and the only place the
  evidence behind a *passing* requirement survives). The three that act are `run_assay` and
  the trial pair, `open_trial` / `run_trial`. A run started from a turn
  appends a `note` row back into that thread when it finishes, so the conversation knows what
  became of its own work.
  `prompt.md` is an asset — `build:api` copies it into `dist/`, so a new non-TS file there
  needs the same treatment.
- **`src/web/`** — React + Vite SPA in **two frames**. The operator frame is `Shell` and six pages
  (Administrator chat at `/`, Overview at `/overview`, Subject detail, Automation, Activity,
  Trials) plus Protocols — the chat is the front page and therefore has no nav row of its own,
  the brand being the way back to it; `/chat` redirects to `/`. The
  **public frame** is `PublicFrame` and two read-only pages under `/public` (the board and one
  app), addressed to app authors rather than to the operator. `main.tsx` splits them with two
  layout routes rather than a flag, so a public page cannot render operator chrome — it is not in
  its tree. `components/SubjectTable.tsx` is shared by both tables on purpose: an author must be
  reading the operator's verdicts, not a restyled copy of them.
  `src/web/data/client.ts` is the only thing that talks to the API,
  and `data/runStatus.ts` is the **single poller** for the run in flight — the shell strip, the
  Overview's `◴ running` cells, Activity's card and the re-assay button all subscribe to it rather
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
   `agent_busy` and an unclaimable bench restore the subject *untouched* — no try burned, no
   last-run stamped. This is the rule that keeps an outage from parking thirteen innocent apps.
   Every other completion — **including an errored one** — stamps the finish time, or a reliably
   failing app starves the whole backlog by staying the stalest row forever.
4. **`blocked` is never a statement about the subject.** It means infra prevented the assay.
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
7. **The app stays diagnosable with every outbound port broken.** Activity must render with Beacon
   unreachable and push unconfigured.
8. **There is no queue.** The backlog is re-derived from last-run on every tick, so it cannot drift.
9. **Every assay records the standard version that judged it.**
10. **`/public` is read-only, and not by convention.** Nothing under that prefix — route or page —
    may write, and the check is at boot rather than at review time. It is the surface app authors
    see, so it is also the one place where an accidental control would be reachable by somebody
    with no account. Anything the board needs is a GET or it does not ship.

## Safety switches (both default off)

- `scheduler.armed: false` — the tick still runs, decides and logs every hour, but claims and
  dispatches nothing. That dry run is the point: its pick is diffed against the live n8n loop's.
  Since 2026-08-20 it is also settable at runtime from the Automation page, which persists an
  **override** into `state/schedule.json`; absent, the config value stands. Stopping means "claim
  nothing further" and deliberately leaves the audit in flight alone.
- `runner.enabled: false` — refuses every job and says so. Validation is a **single hand-run assay**
  through `POST /api/v1/assays`, never a loop: `AppStore PR Review` is still in n8n on the same
  agent endpoint and two systems auditing at once contend for it.

Because n8n is still driving, **do not arm either without the user's say-so**, and do not edit the
live n8n workflows — the one sanctioned waiver (the login preflight, 2026-08-19) was explicitly
approved and is documented in HANDOFF.md §5c.

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
  kills the audit in flight** — no report, no completion event, and the agent goes on recording
  against a ledger token that no longer exists. Finish server edits before dispatching a run.
- The repo layout listed in IMPLEMENTATION.md §3 predates P2–P4 and names files that no longer
  exist (`scheduler/tick.ts`, `eligibility.ts`, `lease.ts`, `services/browser.ts`, `tools/import.ts`).
  The tree on disk is the truth; the doc's *rules* still hold.
- `noUncheckedIndexedAccess` is on. Indexed reads are `T | undefined`.
- Report filenames use ISO-8601 with `:` → `-` so they sort lexically and are portable.

## Documents

| File | What it is for |
| --- | --- |
| `README.md` | what Touchstone is, what it replaces, why |
| `ARCHITECTURE.md` | **the parity matrix (§1.4), domain model, principles, decisions** |
| `MVP.md` | scope, the frontmatter contract (§5), the M1–M7 milestone order (§8) |
| `IMPLEMENTATION.md` | stack, storage, config, packaging — layout section is stale |
| `UX.md` | the pages and their degraded states |
| `REQUIREMENTS.md` | operator requirements **beyond** parity (R1–R8) and their status |
| `HANDOFF.md` | session state: what each phase delivered, open items, live-system facts |

`HANDOFF.md` is session state, not design. When work lands, update it; when a design decision
changes, update the design doc that owns it.
