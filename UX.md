# Touchstone — Web UI

Status: **Overview, Subject detail and Activity built.** Companion to
[ARCHITECTURE.md](ARCHITECTURE.md). This document covers the pages and the two model decisions the
UI depends on — reports as files, and one alert instead of forty-nine.

**Three pages.** The earlier design had five. Findings and Standards are gone with the
capabilities behind them ([ARCHITECTURE.md §1.4 G](ARCHITECTURE.md#g-deliberately-dropped)), and
Environment folded into Activity because benches, browsers and the agent are things you look at
when something has gone wrong, which is the same moment you look at the log.

---

## 1. Three principles the UI has to get right

### Blocked is not failed

This is the whole reason the UI exists. On 2026-08-05 the demo pool started rejecting every
credential, and dozens of subjects went to `⚠️ errored` — a state that *reads* like a verdict about
an app and is nothing of the kind. Every one of them had a complete, correct static result
underneath, and by 2026-08-07 the count had grown from 49 to 54.

So: **a subject shows two independent states, never one**, and *unknown* is visually distinct from
*bad*. Red means we checked and it failed. Grey-hatched means we could not check. A user must never
have to read a report to find out which they are looking at.

### One alert, not forty-nine notifications

The same outage would have produced 49 identical messages. An environment failure is a **stateful
alert** — it opens, it refreshes, it resolves — not a stream. Assay outcomes are events. Activity
shows both, separately.

### The report is a file

Reports are markdown on disk, rendered in the app. Not rows, not a wiki. The archive survives the
app; you can `grep` it, back it up with everything else in the data dir, and read it with `less` if
the UI is down.

---

## 2. Pages

```
Overview   Activity ●                                                    ⚙
```

Two nav items, plus subject detail reached by clicking. Everything else is a filtered view of one
of these — resist adding a third.

---

### 2.1 Overview — the landing page

Answers, in order: *is the loop running*, *what's broken*, *what do I fix first*.

```
┌ Touchstone ─────────────────────────────────────────────────────────────────┐
│ Overview   Activity ●1                                                   ⚙  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   69 subjects          STATIC   ✅ 12   ⛔ 19   ⬜ 38 not yet    risk 1 407  │
│                    FUNCTIONAL   ✅  1   ⛔  0   ▨ 49 blocked  ⬜ 19 not yet   │
│                                                                              │
│   ◴ auditing Prowlarr · static · try 1 · 4m        next tick in 21m          │
│   ⚠  Bench pool unavailable — functional queue paused 2d 4h    [ details ]   │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  sort  risk ▼      show  all ▾      ⌕ search                                │
│                                                                              │
│  SUBJECT               STATIC          FUNCTIONAL       RISK   LAST         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  OpenClaw              ⛔ Critical     ▨ blocked         232   1d      ▸    │
│  TINCatan              ⛔ Critical     ▨ blocked         134   7d      ▸    │
│  Caddy                 ⛔ Major        ▨ blocked          21   5d      ▸    │
│  Prowlarr              ◴ running       ▨ blocked           —   6d      ▸    │
│  Beacon                ⛔ Minor        ▨ blocked           2   6d      ▸    │
│  Radarr                ✅ compliant    ✅ compliant         0   7d      ▸    │
│  ConvertX              ⚠ parked ·3     ▨ blocked           —   5d      ▸    │
│  Nginx                 ⬜ not yet run  ▨ blocked           —   —       ▸    │
└─────────────────────────────────────────────────────────────────────────────┘
```

> Figures are illustrative. `blocked`, `running`, `parked` and never-assayed are four distinct
> states and the mock shows all of them.

- **Two status columns.** The single most important design decision on the page. In the state
  above, the functional column is uniformly `▨ blocked` and the story tells itself: *nothing is
  wrong with these apps' functional behaviour, we simply have not been able to look.*
- **The loop line** replaces opening n8n to find out what the tick did. It shows the current claim
  with its try counter and age, and when the next tick fires. When nothing is claimed it says so.
- **Sorted by risk descending** by default, because the standard's own guidance is that the score
  exists to rank a fix backlog.
- **The environment banner appears only when something is wrong**, and links to Activity. When the
  pool is healthy the row is absent — no permanent yellow furniture that people learn to ignore.
- **`⚠ parked ·3`** is its own state, not an error: three tries used, waiting out `STUCK_DAYS`.
  Today this is legible only by reading `stuck after 3 tries` out of a wiki cell.
- **Age, not timestamp.** `7d` is actionable; `2026-07-30` requires arithmetic.
- Filters: severity, leg, blocked-only, parked-only, stale-only.

---

#### The `Verified` column

`14/16` — how much of the checklist actually got checked. It sits beside Risk and **is not a
second verdict**: the gate is severity-based, so a subject can be 16/16 and non-compliant, or
3/16 with nothing wrong yet. It is therefore rendered in the neutral text colour whatever the
numbers say; the only thing that changes appearance is *incompleteness*, because an assay that
could not check everything is the one state a reader must not skim past.

Assays imported before 2026-08-19 show `—`. There is no honest way to backfill it — deriving it
from the report prose is precisely the mistake the archive was cleaned of in P1.

### 2.2 Subject detail — one app

```
┌ ‹ OpenClaw ──────────────────────────────────────── risk 232   [ re-assay ▾ ]┐
│ Yundera/AppStore@main:Apps/OpenClaw                                          │
│ openclaw:2.1.0 · appshield:2.0.7 · commit 6b9af120                           │
│                                                                              │
│  STATIC       ⛔ non-compliant · Critical      standard v3   ran 2026-08-05   │
│               try 1 · schedule                                               │
│  FUNCTIONAL   ▨ blocked · bench unavailable    since 2026-08-05 · no try used │
│                                                                              │
├────────────────────────── report ───────────────────────────────────────────┤
│  # Yundera/AppStore — OpenClaw                                               │
│                                                                              │
│  **VERDICT: NON-COMPLIANT · Critical · risk_score 232**                      │
│                                                                              │
│  ## Tech & Documentation …                                                   │
│                                                                              │
│  [ rendered | raw ]  [ download ]                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Two leg cards, then the report.** The report is the evidence and it is the whole page below the
  fold; there is no findings sidebar, because findings are prose inside the report
  ([ARCHITECTURE.md §1.4 G](ARCHITECTURE.md#g-deliberately-dropped)).
- **The blocked card names the reason and says `no try used`.** That sentence is the product.
- **`try N · trigger`** on each card, because "why did this run" and "how many attempts has it had"
  are questions the wiki table could only answer in emoji.
- `re-assay ▾` offers **static only** or **static + functional**, and calls `POST /api/v1/assays`.
  The functional choice is disabled with the reason when no bench is leasable, rather than
  silently queueing something that cannot run. (Two choices rather than three: n8n's `depth` has
  only `static` and `full`, and a functional-only run is not a thing either system can do.)
- **The button does not hold the request open.** An audit runs for five to ten minutes; a browser
  request held that long is at the mercy of every proxy in front of it, and a socket closed at
  minute four is indistinguishable from a failed audit. `POST /assays` answers `202`, the button
  polls `GET /assays/current`, and it counts the minutes up rather than showing a spinner that
  reads as hung. When the run finishes the page pulls the new report in without a reload.
- While an audit is running the button counts requirements as well as minutes — `auditing…
  7/16 · 3:20` — because the agent records each one as it settles it. That is the difference
  between a wait and a black box, and it is why the reporting is incremental at all. When
  something is already failing it says how many.
- While an audit is running — anyone's — the button says which app has the agent instead of
  failing on submit. Beside it, the last run for this subject in one clause: `last run:
  non-compliant · risk 1`, or `the agent was busy — nothing was charged`, which is not a failure
  and must not read as one.
- **A `requirements` section above the report**, when the assay has one. Ordered by what a
  reader is looking for rather than by id: failures first and worst tier first, then anything
  that could not be checked, then the passes — which are folded behind a count, because a page
  that opens on fourteen greens has buried its own point. Each row carries the canonical id,
  the agent's own wording, and its note. An id the protocol does not list is shown and tagged
  `unlisted`, which is how the protocol's list gets corrected rather than quietly diverging.
- When the agent's declared risk and the sum of its items disagree, the header says so and
  keeps both. Picking one would look more certain than we are.
- No history strip and no version picker — nothing reads past assays
  ([ARCHITECTURE.md §4](ARCHITECTURE.md#reports-accumulate-nothing-reads-history)). Older files
  remain on disk for anyone who wants to `grep` them.

---

### 2.3 Activity — the log, alerts and the environment

The page you open when something has gone wrong, and the reason you never need the n8n executions
list again.

```
┌ Activity ────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  OPEN ALERTS (1)                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ ⚠  Bench pool authentication failing            open · since 2026-08-05│  │
│  │    401 /api/firstfactor on demostaging1 + demostaging2                 │  │
│  │    Firebase IdP: auth/invalid-credential                               │  │
│  │    functional queue paused · 0 tries consumed                          │  │
│  │    last probe 3m ago                                        [ probe ]  │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ENVIRONMENT                                                    [ probe all ]│
│  demostaging1.inojob.com   ⛔ auth failing   last ok 2026-08-04 18:22        │
│      probe POST /api/firstfactor → 401   ·   board says ✅ Ready             │
│  demostaging2.inojob.com   ⛔ auth failing   last ok 2026-08-04 11:05        │
│  touchstone-browser-1      ● idle    profile empty                           │
│  touchstone-browser-2      ● idle    profile empty                           │
│  claude-code               ● ready   shared with PR Review                   │
│                                                                              │
│  LOG                                    all ▾   level ▾   subject ▾          │
│  11:02  ⚠  Prowlarr functional could not start: the demo pool is down    ▸  │
│  11:02  ·  Claimed Prowlarr for a static assay, attempt 1                ▸  │
│  11:00  ·  Tick: 41 subjects eligible, cooldown clear                       │
│  10:44  ⛔  OpenClaw is non-compliant at Critical                         ▸  │
│  10:12  ⚠  Claude Code was busy; retried once and gave up without a try  ▸  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Alerts** are stateful and deduplicated by key, so a two-day outage is one card that refreshes —
not 49 rows. Keys: `bench.auth`, `bench.unreachable`, `agent.unavailable`, `browser.unavailable`.
An alert auto-resolves when its probe succeeds, and the resolution is itself worth pushing:
*"bench pool recovered, functional queue resumed."* There is no ack and no mute.

**Environment** sits on the same page because you look at it in the same moment. The line
**`board says ✅ Ready`** next to a failing probe is deliberate: the management board is known not
to detect this failure mode, and the UI should show the disagreement rather than trust either
source silently. `profile empty` next to a browser is likewise an assertion, not decoration — a
non-empty profile is a false-pass risk on the auth-gate check.

**The log** is authoritative and local. Every tick, claim, dispatch, result, retry, block and probe
writes a row. Two rules, copied from Newsdesk:

- the message is **one sentence a human reads** — no ids, no interpolated error strings, no JSON
- the technical `detail` is behind the `▸`, and only on `warn` and `error`

It must render with Beacon unreachable and push unconfigured. An app that can only tell you what is
wrong by successfully sending a message is an app that goes quiet exactly when you need it.

### Routing

| | log | Beacon (Telegram / Discord / Talk) | push |
| --- | --- | --- | --- |
| tick summary | ✓ | — | — |
| assay finished | ✓ | ✓ | **✓** |
| assay failed / blocked | ✓ | ✓ | ✓ |
| alert opened / resolved | ✓ | ✓ immediately | ✓ |
| everything else | ✓ | — | — |

The nav badge counts open alerts and unread `error` rows, and nothing else — a badge that counts
routine completions is a badge people stop reading.

**`assay finished` began pushing on 2026-08-20**, where this table had said it should not. That
row was written for a loop grinding through 69 subjects unattended; the case that decided it is
an operator who *asks* for a review — from the administrator chat, or the re-assay button — and
walks away. For them the finished audit is the entire point of being notified, and an audit
outlasts the page they asked from. The ceiling is one an hour even with the scheduler armed. If
that ever becomes too many, the fix is to push only operator-initiated runs, which needs a
`trigger` on the job — not to mute the thing people asked to be told about.

**Every way an audit can end is on the list**, including `blocked`. A table covering only the
happy path makes silence ambiguous: an operator who hears nothing cannot tell a slow run from a
dead one, and the whole reason the runner separates `blocked` from `failed` is so the answer can
be *"the demo pool is down"* rather than *"your app is broken"*.

---

## 3. Reports as files

Docmost stops being storage. Layout inside the data dir:

```
/data/
  reports/
    OpenClaw/
      2026-08-05T09-14-22Z-static.md
      2026-08-05T09-31-08Z-functional.md
    Prowlarr/
      2026-08-06T07-00-16Z-static.md
  state/                             alerts, events, benches, cached index — all regenerable
```

Sortable, greppable, one directory per subject. Each file carries YAML frontmatter so it is
self-describing — the full shape is in [MVP.md §5](MVP.md#5-contracts).

**The folder is the archive of record; the index over it is disposable.** There is no database. That
is the property that makes dropping Docmost safe: losing everything in `state/` costs a reindex.

### The markdown viewer

The reports are table-heavy and structured, so the viewer needs, in priority order:

1. **Tables** — every report has phase and checklist tables; these must render properly and scroll
   horizontally on narrow screens rather than breaking the layout
2. **Heading anchors** — for deep-linking into a section
3. Code spans and fenced blocks — compose fragments, paths, image refs
4. Blockquotes — verdict callouts
5. External links — target `_blank`

Plus `raw` / `download` toggles. Render server-side from the file on request; no build step and no
cache to invalidate, so a file edited on disk shows up on reload.

**Docmost is not an outlet at all** — decided 2026-08-19, superseding an earlier draft that kept a
roll-up publisher behind a flag. Nothing is published to the wiki and, once the runner is
in-process, nothing is read from it. The rendered file above is where a report is read, and
`Store QA — Results` is frozen with a pointer at cutover. See ARCHITECTURE §5.6.

---

## 4. Degraded and empty states

These matter more than usual, because the system's normal condition includes "large parts unknown."

| State | What the UI shows |
| --- | --- |
| No assays yet | Overview lists subjects as `⬜ not yet run` with a *Run first assay* action. Never an empty page. |
| Bench pool down | Banner + functional column uniformly `▨ blocked`. Functional re-assay disabled with the reason. Static work continues visibly. |
| Assay running | Row shows `◴ running · 4m` with the try counter and bench; live, no reload needed. |
| Subject parked | `⚠ parked ·3` with the date it is released. Not styled as an error. |
| Agent busy | Log row and a `agent.unavailable` alert if it persists. The row is restored, not failed. |
| Report file missing | The leg card still renders from the index; the report pane says the file is gone and offers a re-assay. |
| Beacon or push down | Everything still renders. Undelivered notifications are marked in the log. |

---

## 5. Deliberately not in the UI

- **No findings table, no Findings page, no rule codes.** Findings are prose inside the report, as
  they are today.
- **No history strip, no charts, no regression markers.** Nothing reads past assays.
- **No Standards page.** The rubric is versioned content owned elsewhere.
- **No PR or gate surface.** That workflow stays in n8n.
- **No editing of the standard in the UI.**
- **No per-user accounts or roles.** AppShield already authenticated the visitor, and the trusted
  gate makes that count. One shared authenticated view.
