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
declares), **alert** (a deduplicated environment condition).

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
| `reports/<Subject>/<ISO>-<section>.md` | **the assay record IS the frontmatter of the report file** |
| `state/*.json`, `events.jsonl` | small mutable runtime state and the append-only log |
| `state/index.json` | cache only — deleting it must always be safe |

`data/reports/`, `data/state/` and `data/config.yaml` are gitignored; `test/fixtures/` is committed.

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
- **`domain/fixreport.ts`** — the audit composed into a brief for whoever has to fix the app,
  served as markdown by `GET /subjects/:name/fix.md`. It **quotes**: findings, severities,
  evidence and remedies all come out of the frontmatter, and where the agent proposed no remedy
  the report says so rather than inventing one.
- **`services/ports.ts`** — probes the two non-bench dependencies (agent, browser) by `tools/list`
  over MCP. `services/bench.ts` keeps its own prober because the bench pool is **discovered** from
  the pool API, not configured.
- **`services/events.ts` → `alerts.ts` → `notify.ts` / `push.ts`** — the local log is
  authoritative; alerts dedup an environment condition to one row; outlets and push are
  best-effort.
- **`src/server/chat/`** — the administrator chat: a bounded turn loop (`loop.ts`, 8 calls and
  120 s), file-backed threads (`thread.ts` → `state/chat/*.jsonl`), three tools wrapping the
  API (`registry.ts`), and the agent call (`driver.ts`) reusing `postToAgent` from the runner.
  `prompt.md` is an asset — `build:api` copies it into `dist/`, so a new non-TS file there
  needs the same treatment.
- **`src/web/`** — React + Vite SPA, five pages (Overview, Subject detail, Automation,
  Activity, Administrator chat) plus Protocols. `src/web/data/client.ts` is the only thing that talks to the API,
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
