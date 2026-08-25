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

The chrome follows Newsdesk: a light page, and the whole nav down the left on a desk. Below 860px
that column becomes a sticky header plus a bottom tab bar — the destinations fit as tabs, so
nothing hides behind a "more" sheet. The administrator chat is not one of them: it is `/`, the
page Touchstone opens on, and the brand — present in both the sidebar and the phone header — is
the link back to it.

```
┌──────────────┬───────────────────────────────────────────────┐
│ ▮≡ Touchstone│                                               │
│              │                                               │
│ CONFORMANCE  │                                               │
│  Store       │                   page                        │
│  Protocol    │                                               │
│  Trials      │                                               │
│              │                                               │
│ OPERATIONS   │                                               │
│  Automation  │                                               │
│  Activity  ● │                                               │
│              │                                               │
│ INSTANCE     │                                               │
│  Settings    │                                               │
│  Configurat. │                                               │
│              │                                               │
│ ┌──────────┐ │                                               │
│ │◴ SegmentP│ │                                               │
│ │ static + │ │                                               │
│ │ 7/24 · 4:│ │                                               │
│ └──────────┘ │                                               │
└──────────────┴───────────────────────────────────────────────┘
```

Seven destinations in three groups, plus subject detail reached by clicking. Everything else is a
filtered view of one of these — resist adding an eighth. Six of the seven are tabs on a phone;
**Configuration** is not, because it is a page you read once and reach from Settings rather than
one you switch between.

The **public board** (§2.6) is not one of them and is not in this nav. It is a separate frame at
`/public`, reached from the sidebar footer rather than from the tab bar: it is addressed to app
authors, not to the operator, and putting it in the nav would both crowd the phone's tabs and
suggest it is a page of this app rather than a view published out of it.

**Instance** is the third group, added 2026-08-23: not the standard and not the loop, but how
this particular box is set up — the one setting the app owns (§2.7) and the file it booted on
(§2.8). It is last because it is the group you visit least.

**Automation**, added 2026-08-20, is the one page that is not a view of the archive: it is a view
of the *driver*. That is why it did not fit inside Activity, which was the
obvious place for it. Activity answers "what happened"; the loop's page answers "what is about to
happen, and may it". Folding a switch that dispatches work into a log people scroll would put the
one irreversible control in the app somewhere it is read past.

**The strip above the footer is the run in flight**, and it is the only piece of chrome that is
not navigation. It appears when an audit starts, on every page, and disappears when the audit
ends — a permanent bar that usually reads "idle" is furniture people stop seeing, and then the one
time it matters they do not see it either. On a phone it is a pill in the sticky header, so it
costs no height. It carries the subject, the sections actually being run, `verified/canonical`, the
clock, and the last requirement or phase the agent settled; clicking it opens the subject, **where
the same card is drawn** — the strip promises live detail, and a click that landed on two section
cards saying "being assayed now" and nothing else did not keep that promise. The strip is
suppressed on Activity, where the card is the first thing on the page anyway.

The browser tab's **title** carries the same thing (`◴ SegmentPlayer · 7/24 · 4:12 — Touchstone`),
because the case this exists for is an operator who asked for a review and switched tabs. A
background tab shows no strip, no page and no badge.

---

### 2.1 Store — the table

Answers, in order: *is the loop running*, *what's broken*, *what do I fix first* — and, since
2026-08-23, *what is in the store at all*.

**It was the Overview, and the rename marks a change of question.** The Overview drew the
archive: one row per app that had been audited. That silently excluded every app nobody had got
to yet — 52 of 72 at the time — so the rows most in need of a first look were on no page, and
there was nowhere to start one from. `GET /subjects` now returns the union of the registry and
the archive, and every row carries an **audit** button. The triage the Overview did is
unchanged: risk still sorts descending, and the summary chips are still the filter.

Two things it deliberately does not do. It does not put the button on `/public` — the column is
an `action` render prop the operator page passes and the board does not, so it is absent from
the board's DOM rather than merely hidden (invariant 10). And it does not warn about the bench
pool per row: one open alert above the table says it once, because an audit with no bench still
runs and records those sections blocked, which costs the app nothing.

**The `older standard` chip** (2026-08-25) sits beside a subject's name when the last verdict on
that row was reached under a rubric that has since been edited, and `standard unknown` when the
assay predates revision tracking and names none. It is a caveat about the *question*, not a
finding about the app — the verdict is exactly as true as it was the day it was reached — so it
is a quiet warm chip rather than a column or a severity colour, and an up-to-date row draws
nothing at all. Clicking through keeps it: the same chip is on the subject page and on both
public pages, because a caveat that vanished on the way would read as having been withdrawn.
Behind it, the subject stops waiting out the seven-day freshness window and joins the backlog at
its ordinary position — Automation's queue says `standard revised since` on that row.

**The `app changed` chip** (2026-08-25) is the second of the two, and deliberately not the same
chip: `older standard` means the rubric was edited and we will ask again, `app changed` means the
app's `docker-compose.yml` was rewritten since the verdict was reached. To an operator that is a
choice of which thing to go and look at; to an app author on `/public` it is the difference
between "wait for us" and "that was you". A row may honestly carry both. It is blue where the
standard chip is warm, because it reports something about the subject rather than a shortfall in
it, and unlike the standard chip it draws nothing for `unknown` — that would appear on every
pre-2026-08-25 row at once to say only "this predates the feature", and clears itself within one
audit rotation anyway.

`/overview` redirects here.

```
┌ Touchstone ─────────────────────────────────────────────────────────────────┐
│ Store      Activity ●1                                                   ⚙  │
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
- **`◴ running` is overlaid, not stored.** The audit in flight is read from `/assays/current` and
  applied to the cells, the tallies and the `running` filter at render time. A full run whose bench
  vanished marks the *static* cell only — its functional half is not running and will be recorded
  blocked, and a cell that claimed otherwise would be a lie the page tells for four minutes and
  then contradicts.
- **`⚠ parked ·3`** is its own state, not an error: three tries used, waiting out `STUCK_DAYS`.
  Today this is legible only by reading `stuck after 3 tries` out of a wiki cell.
- **Age, not timestamp.** `7d` is actionable; `2026-07-30` requires arithmetic.
- Filters: severity, section, blocked-only, parked-only, stale-only.

---

#### The reading columns — `Currency`, and whatever follows it

A **reading** is a section that measures rather than judges (`scores: false`), and it gets a
column of its own between the verdict cells and `Verified`:

```
  SUBJECT               STATIC          FUNCTIONAL       CURRENCY          RISK   LAST
  ────────────────────────────────────────────────────────────────────────────────────
  Caddy                 ⛔ Major        ▨ blocked        ( 1 behind · 400d )   21   5d
  Radarr                ✅ compliant    ✅ compliant     ( current )            0   7d
  Immich                ✅ compliant    ▨ blocked        ( unknown )            0   3d
```

- **It is drawn quieter than a verdict, on purpose.** No solid fill and no glyph — a pill, a
  tint and the words. An app that is merely out of date must not read at a glance like one that
  failed the gate, because that is the conflation `scores: false` exists to prevent.
- **`unknown` is its own state**, dashed rather than pale-green. Half the value of a currency
  check is destroyed by a cell that reads *fine* when it means *we could not look* — the same
  rule as `blocked`, one layer out.
- **The column exists because the archive has one**, not because anything in the web knows the
  word "currency". `readingSections()` finds every section whose latest record carries
  `scores: false`; a second scripted check gets a column the day its first assay lands.
- **Sorting is `bad → warn → unknown → ok`.** `unknown` sits above `ok` and below `warn`: it is
  not good news, and it must not outrank a measurement that actually found something.

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
┌ ‹ OpenClaw ─────────────────────── risk 232  [ fix report ]  [ re-assay ▾ ]──┐
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

- **One card per section, then the report.** (Two today, because the protocol has two leaves; the
  page names them from the archive rather than from a fixed pair.) The report is the evidence and
  it is the whole page below the
  fold; there is no findings sidebar, because findings are prose inside the report
  ([ARCHITECTURE.md §1.4 G](ARCHITECTURE.md#g-deliberately-dropped)).
- **The blocked card names the reason and says `no try used`.** That sentence is the product.
- **`try N · trigger`** on each card, because "why did this run" and "how many attempts has it had"
  are questions the wiki table could only answer in emoji.
- `re-assay` is **one button and no menu**, and calls `POST /api/v1/assays` with a subject and
  nothing else. Its bench note reads the **shared run-status poller** rather than a fetch of its
  own — it used to call `GET /benches` once on mount, so the note was a snapshot from page load,
  and on 2026-08-23 an operator acted on one five minutes after it stopped being true. There is no depth to choose: a run audits every section of the protocol, and a
  section whose prerequisites are missing is recorded blocked — which costs the app nothing and is
  the honest record of what happened. When no bench is leasable the button says so beneath itself
  rather than disabling anything: the audit is still worth running, it will simply be narrower.
  It says **when** too — *"no bench — live sections will be recorded blocked · demostaging1 is 34
  min from its wipe at ~15:00 UTC and inside the 60 min guard — usable again shortly after it"* —
  because a note that names only the fault is the difference between a narrower audit and a dead
  end.
  (Until 2026-08-20 this was a `▾` menu offering `static only` / `static + functional`, mirroring
  n8n's `depth`. The choice was never real — the only reason to pick `static` was a dead pool, and
  the runner already handles that by itself.)
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
- **`fix report`** turns the audit round to face the person who has to change the app. It opens a
  panel of raw markdown — findings worst-first, the audit's own evidence quoted verbatim, the
  remedy it proposed where it proposed one, and the failing requirement ids as the acceptance
  criteria — with `copy` and `download`. The same document is `GET /api/v1/subjects/:name/fix.md`
  for a script or a CI job, so what someone pastes and what CI fetches cannot drift.
  - **Composed from the record, never regenerated.** Every sentence comes out of the frontmatter
    the agent wrote. Where the audit proposed no remedy the report says so; a guessed fix in a
    document whose purpose is to be executed is worse than none.
  - **Raw, not rendered.** The point of the panel is to take the text away, and rendered markdown
    is markdown you cannot copy correctly.
  - The button is absent unless something is actually failing, and gated on *recorded findings*
    rather than on the verdict: an assay imported before the ledger has a verdict and no
    requirements, and the report built from it would be headings with nothing underneath.
- **A reading panel per measuring section**, above the report: the badge, how long ago it was
  read, one line of summary, and the table the executor asked for. For `currency` that is one row
  per service — image, pinned tag, latest, how many releases behind, and **how long it has been
  behind**, which is computed on every render from the absolute date in the record rather than
  read out of it. That is the whole reason the check needs no schedule: the reading is taken when
  the app is audited, and the number on screen stays true in between. A blocked reading renders
  its reason and no table, exactly as a blocked assay does.
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

### 2.3 Activity — what is running, the log, alerts and the environment

The page you open when something has gone wrong, and the reason you never need the n8n executions
list again.

**Running now comes first.** The log cannot answer "what is happening": a run writes one row when
it starts and the next when it finishes, and for the six to ten minutes in between the page reads
as an idle system. With nothing running it says so, and names the last run rather than rendering
an empty box.

The card is one hierarchy, top to bottom: **the run** (subject, sections, settled, clock), **the
failure worth acting on**, **a row per section**, **the feed**, and last **where it is running**.
Three things that arrangement fixes, all of them reasons the earlier stacked version read as
strange:

- **One fraction over two sections is true of neither.** `18 of 25` cannot say that `static` is
  twelve-fourteenths done while `functional` has not started. Each section is counted against its
  own protocol's list instead, which is also the only form in which a bar means anything — and the
  same rule `LegCard` already followed by refusing to print the merged number.
- **A phase track belongs to the section that declared it**, indented under that row rather than
  floating beside the whole run, where eight untouched pills beside a moving counter read as a
  stalled audit. Unreached steps still show — a track that shows only what happened cannot show
  what is left — but they carry their id alone; only the step in hand spells its label out.
- **The failure is the thing anyone acts on**, so it leads. As a grey clause inside the count it
  was the smallest word on the card.

The bench, the browser and the start time are a diagnostic and sit last, in one line: between the
progress and the feed they split the two things that are actually moving, and a card with an
elapsed clock, an absolute start and relative row stamps left three time bases to reconcile.

```
┌ Activity ────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  RUNNING NOW  ◴                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ SegmentPlayer  static + functional          18 of 25 settled     4:12  │  │
│  │   ↑ the sections this run is actually attempting, named by the protocol │  │
│  │ ┌────────────────────────────────────────────────────────────────────┐ │  │
│  │ │ ✗ broad-mount-disclosure   major                           6m ago  │ │  │
│  │ └────────────────────────────────────────────────────────────────────┘ │  │
│  │ static      ▓▓▓▓▓▓▓▓▓▓▓▓▓░░  12 of 14 · 1 failing                      │  │
│  │ functional  ▓▓▓▓▓░░░░░░░░░░   6 of 11                                  │  │
│  │             (A session)(C fresh install)(D discover URL)(E8)(E9)(F)(G) │  │
│  │ ──────────────────────────────────────────────────────────────────     │  │
│  │  6m ago  broad-mount-disclosure          fail    major        static   │  │
│  │  7m ago  auth-default                    pass                 static   │  │
│  │ ──────────────────────────────────────────────────────────────────     │  │
│  │ started 10:24 · bench demostaging1.inojob.com · browser …:9746         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
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

**Every alert carries an `impact` line, and it says when the condition lifts.** A card naming
only the fault leaves the operator with nothing to do and nothing to wait for — which is what
happened on 2026-08-23, when a bench alert sat open all day beside a pool that had recovered
mid-morning. So `impact` is now always set (it used to be dropped whenever *anything* was still
leasable, i.e. in the ordinary half-broken case) and always ends with the pool window:
*"sections that need a bench will be recorded blocked · no try consumed · demostaging1 is
mid-cleanup — usually back within minutes"*. It is composed once, in `services/bench.ts`
(`describeWindow`), and quoted by the Activity card, the Store banner, the push notification
and the chat — four surfaces, one sentence, no restatement.

Note what the alert **cannot** tell you, and why the log has to: `bench.unreachable` is keyed on
*a box being broken*, not on *whether a functional section can run*. With one bench wedged and
another healthy it stays open, so its resolution never fires for a partial recovery. That gap is
why the scheduler logs `TICK_BENCH_GATED` / `TICK_BENCH_UNGATED` as **transitions** — once when
the gate closes, once when it opens, never once per tick.

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

### 2.4 Automation — the loop, and the switch

The scheduler has driven the backlog since P3 and decided every hour. This page is the control
surface for it: since 2026-08-25 nothing about the loop needs `config.yaml` and a restart. Four
blocks, in the order the questions arrive — is it on, what did it decide, what is it deciding by,
and what does that make the queue.

```
┌──────────────────────────────────────────────────────────────┐
│ AUTOMATED MODE                                               │
│ ● Stopped                                        [  Start  ] │
│   Nothing is dispatched automatically. Audits still run      │
│   when you start one by hand.                                │
├──────────────────────────────────────────────────────────────┤
│ LAST DECISION                                 [ decide now ] │
│ ⏳ auditing AIOStreams — never run                            │
│ 2026-08-20 17:19 · just now · next check in 59m              │
│ ┌────────┬─────────┬──────────┬────────┬────────┬──────────┐ │
│ │BACKLOG │ NEXT UP │ COOLDOWN │ CHECKS │ RE-AUD │ GIVES UP │ │
│ │66 of 69│AIOStream│ clear    │  60m   │   7d   │ 3 tries  │ │
│ └────────┴─────────┴──────────┴────────┴────────┴──────────┘ │
├──────────────────────────────────────────────────────────────┤
│ SETTINGS                                                     │
│ ┌ AUTOMATED MODE ────────────────────────────────────────┐   │
│ │ Decides every        scheduler.tick_min   [  60 ] min  │   │
│ │   How often the loop looks at the backlog…      [Save] │   │
│ ┃ Re-audits after      scheduler.fresh_days [  14 ] days │   │
│ │   How old a result may be before an app…        [Save] │   │
│ │   Changed here. config.yaml says 7. use that instead    │   │
│ └────────────────────────────────────────────────────────┘   │
│ ┌ THE RUNNER ────────────────────────────────────────────┐   │
│ │ Runner               runner.enabled            [ Off ] │   │
│ └────────────────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────────────┤
│ QUEUE  69                                                    │
│  1  AIOStreams      never audited      no result on file     │
│  2  AnnasTorrents   never audited      no result on file     │
│  ·  Caddy           recently audited   last 2026-08-19 11:04 │
└──────────────────────────────────────────────────────────────┘
```

**The switch reads as a state first and a button second.** "Running" or "Stopped" is what the eye
lands on; the button says what pressing it would change to. Stopped carries `--unknown`, never
`--crit`: it is the shipped default and a perfectly good state, and painting it as a fault teaches
people to arm the loop to make the page stop shouting.

**Stop means "claim nothing further" — never "abandon the run".** When an audit is in flight the
page says so before the button is pressed, because the other reading is that Stop kills it. Tearing
a run down mid-flight burns a try (principle 3 gives it back only for infra conditions), orphans
the ledger token the agent is still writing against, and holds the claim until `lease_min` expires.

**`runner.enabled` is a second switch and stays one.** An armed scheduler with a disabled runner
claims a subject and is told the runner is off — a real state, and the page names it rather than
letting someone press Start and watch nothing happen. Start does not turn the runner on, because
that switch also gates hand-run audits and a start button that quietly enabled the manual path
would be doing something nobody asked for. It is settable in the Settings block below, next to the
sentence saying what it gates — which is the point of it being there rather than beside Start.

**The queue lists every app, not just the backlog.** "Why is my app not being tested" is the
question this page exists to answer, and an app missing from the list answers nothing: a subject
with no position carries the reason it has none — recently audited, parked, or being audited now.
The order is the pick's own, derived from the same `plan()` the scheduler decides with, so position
1 is the app the next unblocked tick claims rather than a second guess at it.

**Pressing Start decides immediately** rather than waiting for the top of the hour, so the button
either produces a claim or says in one clause why it did not. An hour of silence is not an answer.

**Cadence is shown as facts and changed underneath.** The six facts read at a glance; the
**Settings** block below them is the same numbers with a box beside each one. The note under the
facts still says the thing the numbers do not: a full pass is *n* apps at `cooldown_min` apart, and
the loop idles once everything is fresher than `fresh_days`. Wanting a perpetual carousel means
lowering `fresh_days`, not adding a mode — the pick stays the pure n8n port it is diffed against.

**The Settings block is rendered from what the API returned**, never from a list in the page: the
label, the unit, the range and the sentence explaining what changing it does all arrive on the row,
because `domain/controls.ts` is the only place allowed to know them. A number commits on **Save**
rather than on each keystroke — typing `14` over `7` passes through `1`, and applying that would
put the timer on a cadence nobody asked for. A row differing from `config.yaml` is marked on its
left edge, says what the file asks for, and offers the way back; the alternative is an instance
quietly running on something the file does not mention. `scheduler.armed` is deliberately absent
from the list — it is the switch at the top of this page, and a second copy of it would be two
places to press, one of them further from the sentence explaining what stopping does.

---

### 2.5 Trials — would this store pass?

Every other screen answers *what does this app carry*. This one answers *what would it carry*,
about code that is not in the store yet — a PR, a fork, a working copy. That is why a trial's
result is filed on its own and never touches a hallmark, and why the page has to keep saying so:
a verdict that looks like the others but quietly means something else is worse than no verdict at
all.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ TRIALS                                                                     │
│ Store zip                                                                  │
│ [https://github.com/Owner/AppStore/archive/…/pr-812.zip                  ] │
│ App [Widget ]                                            [  Run trial  ]   │
├────────────────────────────────────────────────────────────────────────────┤
│  APP     STORE            STATIC   FUNCTIONAL  CURRENCY  VER.  RISK  START  │
│  Widget  …/pr-812.zip     ▣ Major  ▨ no bench  118d      18/18   30  1h   ›│
│  Ntfy    upload sess-9f2a ⬜        ⬜           —          —     —  24m   ›│
│  └ not run — the agent was busy                                            │
└────────────────────────────────────────────────────────────────────────────┘
        ↓  /trials/<slug>
┌──────────────────────────────────────────────────────────────┐
│ ‹ Widget                                     30 RISK [Remove]│
│ Apps/Widget from …/pr-812.zip                                │
│ [judged against Yundera/AppStore] [new app · nothing to      │
│  compare] [Static Review Protocol 4f2a…] [finished 1h ago]   │
├───────────────────────────┬──────────────────────────────────┤
│ STATIC   ▣ Major risk 30  │ FUNCTIONAL  ▨ bench unavailable  │
│ ran 2026-08-23 · 1h ago   │ no try used                      │
├───────────────────────────┴──────────────────────────────────┤
│  THIS STORE, AGAINST WHAT THE APP CARRIES NOW                │
│  SECTION      THIS STORE          CURRENTLY                  │
│  static       ⛔ non-compliant     ✅ compliant                │
│  functional   ▨ blocked           ✅ compliant                │
├──────────────────────────────────────────────────────────────┤
│  IMAGE CURRENCY  118d behind · read today   [table of rows]  │
├──────────────────────────────────────────────────────────────┤
│  REQUIREMENTS  18/18 verified   [failures first, passes fold]│
├──────────────────────────────────────────────────────────────┤
│  REPORT  [static|functional|currency] [rendered|raw] [dl]    │
└──────────────────────────────────────────────────────────────┘
```

- **One input, matching the API.** A store zip and an app inside it. The form does not ask for a
  repository: whose `CONTRIBUTING.md` the app is judged against is a property of the store it
  belongs to, resolved from the configured origins, not something to retype per trial.
- **A trial is a full audit.** Both sections run — Touchstone serves the exact archive it audited
  and the bench installs that. The functional row is a real verdict, not a permanent `blocked`.
- **The list draws the Store page's columns, because they are the same facts.** A column per
  section, a column per reading, coverage and risk — off the trial's own reports, composed by the
  same function the Store page's rows come from. It used to be one `Result` cell taken from the
  *record*, which says how the job ended and not what it found: a trial whose static section
  failed and whose functional section was blocked showed one word, and the half nobody could
  check looked like the half that passed. Two columns the Store page has are deliberately
  absent — `Last`, because a trial is one-shot and `Started` already is that column, and the
  audit button, because you do not re-run a trial, you run a new one against a new zip. So are
  the summary strip and the filters: a population to triage is what a hallmark board is.
- **A trial has its own address.** `/trials/<slug>`, so a result can be pasted into the PR it is
  about and survive a reload. The detail is the subject page's furniture — section cards,
  reading panels, the requirement list, the report viewer with a tab per section — around the one
  panel that is this page's alone.
- **Two columns, and the right one never changes.** The comparison is the whole point: a verdict
  on a branch means little until you know whether it is better or worse than the thing it would
  replace. `Currently` is the subject's existing hallmark, unaffected by anything on this page.
- **The one degraded state names its own remedy.** With `trials.public_base_url` unset there is
  no address a bench could fetch the store from, so the functional row is `blocked` and carries
  the setting inline rather than a tooltip. A bare `▨ blocked` beside a real verdict reads as a
  fault, and this one is a fact about this box's configuration.
- **A branch that adds a *new* app has nothing to compare against**, which is a normal PR. The
  page says so rather than showing an empty column with no explanation.
- **Uploads are not on this page.** The no-commit fix loop (`open_trial` → PUT files →
  `run_trial`) is MCP-only, because its caller is an agent fixing an app rather than an operator
  reviewing one. It produces a store zip like any other and lands in the same list.
- **A row that produced no report says so under its own name.** The section columns are the
  answer whenever the run wrote something down; a trial that errored before the first assay, or
  that the agent was too busy to take, has nothing but empty cells, and the note is the only
  place the row can say why.
- **Told apart by words and structure, not by a downgraded cell.** The header says a trial moves
  nothing, the comparison's third column is labelled `Currently`, and there is no summary strip.
  Drawing a trial's `blocked` differently from the archive's would be two notations that
  eventually disagree about what `blocked` means — which is the failure `SubjectTable` exists to
  prevent.

---

### 2.6 The public board — `/public`, for the people being judged

Every other page in this document is written for the operator. This one is written for the app
author, and it is the only surface Touchstone has that is meant to leave the building: a
read-only view of what each app currently carries, so the standard is something a developer can
look up rather than something they hear about when a review fails.

```
┌──────────────────────────────────────────────────────────────┐
│ ▮≡ Touchstone │ app conformance                              │
├──────────────────────────────────────────────────────────────┤
│  3 SUBJECTS   STATIC ✓1 compliant ⛔2 failing  ▨0            │
│               FUNCTIONAL ✓1 ⛔1 ▨1              34 TOTAL RISK │
├──────────────────────────────────────────────────────────────┤
│  SUBJECT       STATIC    FUNCTIONAL  VERIFIED  RISK   LAST    │
│  FileBrowser   ▣ Major   ⛔ none       26/27     30   today  ›│
│  Ntfy          ▣ Minor   ⬜ not run    16/16      4   today  ›│
│  SegmentPlayer ✓ compl.  ✓ compl.     23/23      0   today  ›│
├──────────────────────────────────────────────────────────────┤
│  ✓ compliant  ⛔ failed  ▨ blocked — could not check  ⬜ not  │
├──────────────────────────────────────────────────────────────┤
│  Blocked is not failed. A hatched cell means the check could │
│  not be made… Nothing on this page can be changed from it.   │
└──────────────────────────────────────────────────────────────┘
```

- **It is the Store page's table, not a summary of it.** Same rows — minus the ones the archive
  has never heard of — same cells, same tallies, out of
  the same `SubjectTable` component and the same `hallmarks()` call. The claim the board makes to
  an author is that they are reading the verdict the operator reads; two compositions would be two
  opinions, and the published one would be the one nobody checks.
- **No shell.** `/public/*` does not wear the operator chrome — no nav to pages that dispatch
  runs, no alert badge, no run strip. The split is a layout route in `main.tsx` rather than a flag
  on `Shell`, so a public page *cannot* render operator chrome: it is not in its tree.
- **No actions, and no way to add one.** Nothing here posts. The page reaches exactly three
  endpoints, all GET, all under `/api/v1/public/`, and that plugin refuses at boot to register a
  write verb (`routes/public.ts`). "Read-only" is a check that fails the build, not a convention.
- **What is deliberately absent**, beyond the buttons: the live-run overlay (`◴ running` is a fact
  about the machine, not about the app, and it comes from an operator endpoint), the alert banner
  and the blocked backlog (environment conditions — the operator's problem, noise to somebody
  looking up one app), and the report source (the evidence is quoted into the fix brief instead).
- **Filtering and sorting stay**, in the URL as on the Overview, because `/public?show=failing` is
  a useful thing to send somebody. Filtering a view is not an action against the system.
- **`blocked` gets the most explanation it gets anywhere.** For the operator it is a reminder; here
  it is the first time most readers meet the word, and "we could not check" being mistaken for
  "your app failed" is the single worst outcome this page can produce. Hence the legend inside the
  panel *and* the sentence in the footer.

#### 2.6.1 One app — `/public/s/<origin>~<Name>`

The same three things a maintainer needs, in the order they want them: the hallmark per section
with the standard version that judged it, the requirements the audit settled (failures first), and
the **fix brief** — the audit's own findings, evidence and proposed remedies, fetched from
`/public/subjects/:name/fix.md` rather than composed again in the browser.

No history, no report source, no re-assay. An author cannot ask for a re-run from here, and that is
the intent: the loop decides what is audited and when. A hallmark is what the subject carries now,
which is what a hallmark *is*.

---

### 2.7 Settings — what the administrator is told before it answers

One editable thing: the **context prompt**, `data/context.md`. It is prepended to the
administrator chat's prompt on every turn — which box this is, which stores matter here, what
the operator wants left alone — and it exists because the alternative was retyping the same
paragraph at the top of every conversation.

```
┌──────────────────────────────────────────────────────────────┐
│ ADMINISTRATOR CONTEXT  /data/context.md    [revert] [ save ] │
│ Loaded into the administrator's prompt before every message. │
│ [ 412 / 16,000 bytes ] [ saved 23/08 13:18 ] [ unsaved ]     │
├──────────────────────────────────────────────────────────────┤
│  This instance audits the Yundera store on holyhorse, which  │
│  is a test box — nothing on it is customer data. …           │
└──────────────────────────────────────────────────────────────┘
```

- **It says what it is not.** Background, not authority: it cannot record a verdict and it cannot
  give the chat a tool the registry does not have. A text box that looks like it configures the
  audit would be read as configuring the audit.
- **The byte count is on screen, not at the limit.** A turn carries this, the tool catalogue, the
  live status and the conversation in one prompt, so the ceiling is a fact about the page rather
  than an error message discovered on save.
- **It takes effect on the next message**, not the next conversation and not the next restart —
  the file is read per turn. The page says so after a save, because "loaded on each new
  conversation" is the obvious wrong guess.
- **Empty is normal.** A fresh instance has no standing instructions and does not look broken for
  it; the placeholder is an example, not a default.

### 2.8 Configuration — what this process booted on

The effective config as JSON: the defaults with `config.yaml` merged over them, which is what the
app is *running on* rather than what the file says on its own.

- **Read-only, and not as a limitation.** `config.yaml` is loaded once at boot and handed to the
  services as values, so a save button here would change a file without changing behaviour until
  a restart — worse than no button. The page gives the path and the time it was read.
- **Credentials never reach the browser.** Redaction is on the server and matches on key names,
  because `config.yaml` merges over the defaults with an index signature — whatever an operator
  put in it would otherwise come straight back out. A credential that is *set* reads as `••••••••`
  and one that is not reads as empty: they are different problems.
- **It is a page you read, not one you switch to**, so it keeps its sidebar row and gives up its
  tab on the phone. Settings links to it.

---

## 3. Reports as files

Docmost stops being storage. Layout inside the data dir:

```
/data/
  reports/
    yundera/                         one directory per store — `config.yaml`'s `origins[].id`
      OpenClaw/
        2026-08-05T09-14-22Z-static.md
        2026-08-05T09-31-08Z-functional.md
      Prowlarr/
        2026-08-06T07-00-16Z-static.md
  state/                             alerts, events, benches, cached index — all regenerable
```

Sortable, greppable, one directory per subject inside one directory per store. Each file carries
YAML frontmatter so it is self-describing — the full shape is in [MVP.md §5](MVP.md#5-contracts).

The store level is a **namespace, not a uniqueness rule**: two stores may each ship a `FileBrowser`,
and they are two subjects with two folders and two rows. Nothing in the UI mentions a store while
only one is configured — a column that always reads the same word is furniture.

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
| No assays yet | The Store page lists every tracked subject as `⬜ not yet run`, each with its own **audit** button. Never an empty page — the registry alone fills it. |
| Bench pool down | The open alert's own `impact` as the banner's second line — what is stopped, that no try is consumed, and **when the pool is usable again**. Functional column uniformly `▨ blocked`. Re-assay stays **enabled** and says the same window beneath itself: the audit is still worth running, it will simply be narrower. Static work continues visibly. |
| Assay running | The row shows `◴ running · 7/24`, the shell shows the strip, the tab title shows the clock, and both Activity and the subject's own page show the card. All of them come from `GET /assays/current` and none from a file: the runner writes a report when it has a verdict, so a run in progress has no record and must not be given a placeholder one. |
| Subject parked | `⚠ parked ·3` with the date it is released. Not styled as an error. |
| Agent busy | Log row and a `agent.unavailable` alert if it persists. The row is restored, not failed. |
| Report file missing | The section card still renders from the index; the report pane says the file is gone and offers a re-assay. |
| Beacon or push down | Everything still renders. Undelivered notifications are marked in the log. |
| No scheduler wired up | Automation says so and offers no button. `armed: null` is not `armed: false` — one has a Start button and the other has nothing to start. |
| Automation not refreshing | A notice, and the page keeps its last state: this is the view, not the driver, and the loop carries on. |
| No context prompt written | Settings shows an empty box with an example placeholder, and the administrator's prompt carries no context section at all — a heading over nothing invites the model to wonder what it was supposed to have been told. |
| Context unreadable mid-turn | The turn answers without it. The operator asked a question and is owed an answer; losing it to a permission bit on a file of background prose would be the worse failure. |
| API running without a config | Configuration says the page was handed nothing, which is not the same as nothing being configured. |

---

## 5. Deliberately not in the UI

- **No findings table, no Findings page, no rule codes.** Findings are prose inside the report, as
  they are today.
- **No history strip, no charts, no regression markers.** Nothing reads past assays.
- **No Standards page.** The rubric is versioned content owned elsewhere.
- **No PR or gate surface.** That workflow stays in n8n.
- **No editing of `config.yaml` in the UI.** It is read at boot and handed to the services as
  values; a form that wrote it would be a switch that appears to do something until a restart.
  It is displayed (§2.8), never posted. What *is* editable is the closed list of **controls** —
  values something live re-reads, kept as an override in `state/controls.json` beside the file
  rather than written into it (§2.4, requirements §16). A value with no live reader is not on
  that list, which is what keeps the distinction honest rather than gradual.
- **No tool for the administrator to read or write its own context.** The chat's registry has
  seventeen tools and none of them touch `data/context.md`. Standing instructions a model can
  rewrite are not standing instructions, and invariant 6 is the general form of that.
- **No per-user accounts or roles.** AppShield already authenticated the visitor, and the trusted
  gate makes that count. One shared authenticated view — plus `/public` (§2.6), which is
  unauthenticated by design and carries no control at all. There are two audiences, not two
  permission levels: the boundary is a path prefix, not a role.
