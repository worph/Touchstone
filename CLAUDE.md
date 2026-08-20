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
**bench** (a leasable demo instance), **leg** (`static` | `functional`), **alert** (a deduplicated
environment condition).

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
| `standards/*.yaml` | name, version, leg, depth per standard |
| `protocols/*.md` | **the rubric itself**, local markdown Touchstone owns and edits |
| `reports/<Subject>/<ISO>-<leg>.md` | **the assay record IS the frontmatter of the report file** |
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
- **`runner/`** — `prompt.ts` (assembles the protocol text into the prompt), `agent.ts` (the MCP
  call plus n8n's exact failure classification: `agent-auth` / `agent-busy` / `agent-error` /
  `parse-failed`), `index.ts` (one job in, one or two assay files out, a `RunOutcome` back).
- **`services/ledger.ts` + `routes/mcp.ts`** — the callback surface the agent uses to record each
  requirement *as it settles it*, so a run that dies at requirement 12 of 16 keeps twelve results.
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
- **`src/web/`** — React + Vite SPA, four pages (Overview, Subject detail, Activity,
  Administrator chat) plus Protocols. `src/web/data/client.ts` is the only thing that talks to the API. `@shared/*` aliases
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
2. **Legs are independent.** A dead bench degrades the functional leg only; the static assay stands
   on its own.
3. **No infra condition consumes a subject's retry budget or produces a verdict about the subject.**
   `agent_busy` and an unclaimable bench restore the subject *untouched* — no try burned, no
   last-run stamped. This is the rule that keeps an outage from parking thirteen innocent apps.
   Every other completion — **including an errored one** — stamps the finish time, or a reliably
   failing app starves the whole backlog by staying the stalest row forever.
4. **`blocked` is never a statement about the subject.** It means infra prevented the assay.
5. **The browser profile is ephemeral, by design.** No volume on the browser sidecar: a surviving
   session cookie makes an unprotected app look protected on the one check that catches auth
   bypass. This is the single deliberate divergence from Newsdesk's packaging.
6. **Nothing an agent or a model can call may write a verdict** — not the assay MCP surface
   (`routes/mcp.ts` has no `record_result`) and not the chat's tool registry. The agent judges each
   requirement; Touchstone computes the gate (any Critical ⇒ non-compliant, unconditionally). An
   agent that can post its own verdict makes the rubric advisory.
7. **The app stays diagnosable with every outbound port broken.** Activity must render with Beacon
   unreachable and push unconfigured.
8. **There is no queue.** The backlog is re-derived from last-run on every tick, so it cannot drift.
9. **Every assay records the standard version that judged it.**

## Safety switches (both default off)

- `scheduler.armed: false` — the tick still runs, decides and logs every hour, but claims and
  dispatches nothing. That dry run is the point: its pick is diffed against the live n8n loop's.
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
- **The index is built at boot.** Anything that changes report files from another process needs an
  API restart to be visible.
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
