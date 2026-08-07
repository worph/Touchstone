# Touchstone — Web UI

Status: **design**. Companion to [ARCHITECTURE.md](ARCHITECTURE.md); this document covers the
pages, what each is for, and the two model decisions the UI depends on — reports as files, and
notifications as incidents rather than an event storm.

---

## 1. Three principles the UI has to get right

### Blocked is not failed

This is the whole reason the UI exists. On 2026-08-05 the demo pool started rejecting every
credential, and 49 subjects went to `⚠️ errored` — a state that *reads* like a verdict about an
app and is nothing of the kind. Every one of them had a complete, correct static result
underneath.

So: **a subject shows two independent states, never one**, and *unknown* is visually distinct
from *bad*. Red means we checked and it failed. Grey-hatched means we could not check. A user
must never have to read a report to find out which they are looking at.

### One incident, not forty-nine alerts

The same outage would have produced 49 identical notifications. An environment failure is a
**stateful incident** — it opens, it accumulates impact, it resolves — not a stream of events.
Conformance outcomes are events. The Activity page shows both, separately.

### The report is a file

Reports are markdown on disk, rendered in the app. Not rows, not a wiki. The archive survives the
app; you can `grep` it, back it up with everything else in the data dir, and read it with `less`
if the UI is down.

---

## 2. Pages

```
Overview   Findings   Activity ●   Environment   Standards            ⚙
```

Five nav items, plus subject detail reached by clicking. Everything else is a filtered view of
one of these — resist adding a sixth.

---

### 2.1 Overview — the landing page

Answers, in order: *is the system healthy*, *what's broken*, *what do I fix first*.

```
┌ Touchstone ─────────────────────────────────────────────────────────────────┐
│ Overview   Findings   Activity ●3   Environment ⚠   Standards            ⚙  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   69 subjects          STATIC   ✅ 12   ⛔ 19   ⬜ 38 not yet    risk 1 407  │
│                    FUNCTIONAL   ✅  1   ⛔  0   ▨ 49 blocked  ⬜ 19 not yet   │
│                                                                              │
│   ⚠  Bench pool unavailable — functional queue paused 2d 4h    [ details ]   │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  sort  risk ▼      show  all ▾      ⌕ search                                │
│                                                                              │
│  SUBJECT               STATIC          FUNCTIONAL       RISK   LAST         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  OpenClaw              ⛔ Critical     ▨ blocked         232   1d      ▸    │
│  TINCatan              ⛔ Critical     ▨ blocked         134   7d      ▸    │
│  CasaOS                ⛔ Critical     ▨ blocked         131   6d      ▸    │
│  Tailscale             ⛔ Critical     ▨ blocked         122   7d      ▸    │
│  Caddy                 ⛔ Major        ▨ blocked          21   5d      ▸    │
│  Beacon                ⛔ Minor        ▨ blocked           2   6d      ▸    │
│  Radarr                ✅ compliant    ✅ compliant         0   7d      ▸    │
│  Prowlarr              ⬜ not yet run  ▨ blocked           —   —       ▸    │
└─────────────────────────────────────────────────────────────────────────────┘
```

> Figures in these mockups are illustrative and internally consistent, not authoritative.
> The real tallies come from the import; `blocked` and `not yet run` are four distinct
> functional states (`done`, `blocked`, `running`, never-assayed) and the mock folds
> `running` into the total.

- **Two status columns.** The single most important design decision on the page. In the state
  above, the functional column is uniformly `▨ blocked` and the story tells itself: *nothing is
  wrong with these apps' functional behaviour, we simply have not been able to look.*
- **Sorted by risk descending** by default, because the standard's own guidance is that the score
  exists to rank a fix backlog.
- **The environment banner appears only when something is wrong**, and links straight to
  Environment. When the pool is healthy the row is absent — no permanent yellow furniture that
  people learn to ignore.
- **Age, not timestamp**, in the last column. `7d` is actionable; `2026-07-30` requires arithmetic.
- Filters: severity, leg, stale-only, has-unverified-Critical.

---

### 2.2 Subject detail — one app

```
┌ ‹ OpenClaw ──────────────────────────────────────── risk 232   [ re-assay ▾ ]┐
│ Yundera/AppStore@main:Apps/OpenClaw                                          │
│ openclaw:2.1.0 · appshield:2.0.7 · compose 4f81de20 · commit 6b9af120        │
│                                                                              │
│  STATIC       ⛔ non-compliant · Critical      standard v3   ran 2026-08-05   │
│  FUNCTIONAL   ▨ blocked · bench unavailable    since 2026-08-05 · no try used │
│                                                                              │
│  history   ✅ ✅ ✅ ⛔ ⛔ ⛔ ⛔        ⚠ regressed 2026-07-24                  │
├──────────────── findings (7) ─────────────┬──────────── report ─────────────┤
│  D2   root + user dir, no rationale    ⛔ C│  # Yundera/AppStore — OpenClaw  │
│  E9   auth gate                        ？ U│                                 │
│  —    cpu_shares tier                  ⛔ m│  **Verdict: NON-COMPLIANT ·     │
│  —    volume/env descriptions          ⛔ m│  Critical · risk 232**          │
│  D1   permission strategy              ✅  │                                 │
│  …                                         │  ## Tech & Documentation …      │
│                                            │                                 │
│  ？ = unverified, pending a bench          │  [ raw ] [ download ] [ v ▾ ]   │
└────────────────────────────────────────────┴─────────────────────────────────┘
```

- **The history strip is the thing you cannot have today.** Seven glyphs, one per assay, and a
  regression marker. This is why assays are append-only.
- **Findings list and report side by side.** Clicking a finding scrolls the rendered report to the
  matching section — the finding is the index, the report is the evidence.
- **`？ unverified` is styled distinctly from both pass and fail**, because it means *suspected
  Critical, unproven*. Hovering shows the suspicion: for OpenClaw and the *arr family, the
  `DisabledForLocalAddresses` reverse-proxy bypass that phase E9 would have settled.
- **Version picker** on the report pane walks back through prior assays' reports.
- `re-assay ▾` offers static / functional / both. Functional is disabled with a tooltip when the
  pool is down, rather than silently queueing something that cannot run.

---

### 2.3 Findings — the cross-subject view

The view that justifies the findings table. Two modes:

```
┌ Findings ──────────────────────────── grouped by rule ▾   ⌕ ─────────────────┐
│                                                                              │
│  RULE   TITLE                              SUBJECTS   SEV   RISK             │
│  ─────────────────────────────────────────────────────────────────────────   │
│  —      cpu_shares on reserved tier 10          5     m       5   ▾          │
│         ↳ Radarr · Sonarr · Lidarr · Prowlarr · qBittorrent                  │
│  —      no volume/env descriptions             14     m      14   ▸          │
│  D2     root + user dir, no rationale.md        6     M      60   ▸          │
│  E9     auth gate unverified                   11     ？    (1100) ▸          │
│  D1     root, AppData-only                      9     ✅      0   ▸          │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Grouped by rule** is the default, and the `cpu_shares` row is the proof it works: five
  subjects, one fix, one pass. Today that fact exists only as a sentence inside one report.
  Note that Radarr appears in that group while carrying `✅ compliant` elsewhere — the two
  cannot both be right, and the disagreement is real: Radarr was assayed on 2026-07-30 and
  the family-wide `cpu_shares` observation was first made in the Prowlarr report a week
  later. Either the rubric moved or the earlier assay missed it, which is precisely why
  every assay records `standard_version`. The UI should not hide the contradiction.
- The `E9 unverified` row with a parenthesised risk is the **suspected-Critical queue** — what to
  drain the moment the bench pool comes back. Parenthesised because it is potential, not counted.
- Second mode is a flat list sorted by severity then risk, for working through a backlog subject
  by subject.
- Saved filters: *suspected Criticals*, *regressions*, *one-liners* (Minor, quick wins).

---

### 2.4 Activity — incidents and events

Exactly what you asked for, split in two because the two behave differently.

```
┌ Activity ────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  OPEN INCIDENTS (1)                                                          │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ ⚠  Bench pool authentication failing            open · since 2026-08-05│  │
│  │    401 /api/firstfactor on demostaging1 + demostaging2                 │  │
│  │    Firebase IdP: auth/invalid-credential                               │  │
│  │    Tried: demo/demodemo · demo@yundera.com/Demo123!                    │  │
│  │    impact  49 assays blocked · 0 tries consumed · functional paused    │  │
│  │    last probe 3m ago                    [ ack ] [ mute 24h ] [ probe ] │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  EVENTS                          all ▾   conformance ▾   environment ▾       │
│  11:02  ⛔  new Critical      OpenClaw    D2 root + user dir, no rationale ▸  │
│  09:40  ↩   regression        Spliit      ✅ compliant → ⛔ Critical        ▸  │
│  08:15  ✅  now compliant     Radarr      static + functional              ▸  │
│  07:16  ·   assay finished    Prowlarr    static · no change               ▸  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Incidents** are stateful and deduplicated by key, so a two-day outage is one card that
accumulates impact — not 49 rows. Keys: `bench.auth`, `bench.unreachable`, `agent.unavailable`,
`browser.crashloop`, `standard.drift`. An incident auto-resolves when its probe succeeds, and the
resolution is itself worth pushing: *"bench pool recovered, 49 assays requeued."*

**Events** are point-in-time and are what you asked for on the compliance side:

| Event | When |
| --- | --- |
| `verdict.critical` | an assay produces a new Critical finding |
| `verdict.regression` | hallmark got worse than the previous assay — the highest-signal event in the system |
| `verdict.compliant` | a subject reaches compliant, either leg |
| `verdict.changed` | tier changed in either direction, not covered above |
| `assay.finished` | every completed assay, no change — in-app only |

**Routing** is per class, configured in Settings:

| | in-app | Telegram / Discord |
| --- | --- | --- |
| incident opened / resolved | ✓ | ✓ immediately |
| `verdict.critical` | ✓ | ✓ |
| `verdict.regression` | ✓ | ✓ |
| `verdict.compliant` | ✓ | ✓ (it is nice to hear good news) |
| `assay.finished` | ✓ | — |

The nav badge counts unacknowledged incidents plus unread high-severity events, and nothing else —
a badge that counts routine completions is a badge people stop reading.

---

### 2.5 Environment — benches, browsers, agent

Where "the demo needs auth" is stated plainly rather than inferred.

```
┌ Environment ─────────────────────────────────────────────────────────────────┐
│  BENCHES                                                          [ probe ]  │
│  demostaging1.inojob.com   ⛔ auth failing   last ok 2026-08-04 18:22        │
│      probe POST /api/firstfactor → 401   ·   board says ✅ Ready             │
│  demostaging2.inojob.com   ⛔ auth failing   last ok 2026-08-04 11:05        │
│                                                                              │
│  BROWSERS                                                                    │
│  browser-1   ● idle    profile wiped 11:02                                   │
│  browser-2   ● idle    profile wiped 09:40                                   │
│                                                                              │
│  AGENT                                                                       │
│  claude-code   ● ready    2 workers · 0 running · queue 0 static, 44 blocked  │
└──────────────────────────────────────────────────────────────────────────────┘
```

The line **`board says ✅ Ready`** next to a failing probe is deliberate: the management board is
known not to detect this failure mode, and the UI should show the disagreement rather than trust
either source silently.

---

### 2.6 Standards

The rubric, its versions, and its rules — with a drift indicator when the source content hash no
longer matches what produced the current hallmarks.

```
┌ Standards ───────────────────────────────────────────────────────────────────┐
│  Static Review Protocol       v3   in force   47 rules   ⚠ source edited      │
│  Functional Review Protocol   v2   in force   10 phases                       │
│                                                                              │
│  RULE   TITLE                                 SEV    FAILING   ASSAYED UNDER  │
│  D1     root, AppData-only                     —          0    v3             │
│  D2     root + user dir requires rationale     M          6    v3             │
│  E9     auth gate present                      C          0    v2  ？11        │
└──────────────────────────────────────────────────────────────────────────────┘
```

Clicking a rule opens Findings filtered to it. `⚠ source edited` means the rubric changed without
a version bump — the case that quietly invalidates verdicts.

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
    …
  state/                             incidents, events, cached index — all regenerable
```

Sortable, greppable, one directory per subject. Each file carries YAML frontmatter so it is
self-describing:

```yaml
---
subject: OpenClaw
leg: static
standard: Static Review Protocol
standard_version: 3
verdict: non-compliant
top_severity: critical
risk_score: 232
subject_ref: Yundera/AppStore@main:Apps/OpenClaw
commit: 6b9af120ba7f
images: [openclaw:2.1.0, appshield:2.0.7]
started_at: 2026-08-05T09:14:22Z
finished_at: 2026-08-05T09:29:41Z
findings:
  - {rule: D2, severity: critical, status: fail}
  - {rule: E9, severity: critical, status: unverified}
---
```

**The folder is the archive of record; the index over it is disposable.** There is no database —
the index is built by scanning frontmatter at boot and held in memory. That is the property that
makes dropping Docmost safe: losing everything in `state/` costs a reindex, not history.

### The markdown viewer

The reports are table-heavy and structured, so the viewer needs, in priority order:

1. **Tables** — every report has phase tables and checklist tables; these must render properly and
   scroll horizontally on narrow screens rather than breaking the layout
2. **Heading anchors** — so a finding row can deep-link into its section
3. Code spans and fenced blocks — compose fragments, paths, image refs
4. Blockquotes — verdict callouts
5. External links — target `_blank`

Plus `raw` / `download` toggles, and a version picker. Render server-side from the file on
request; no build step, no cache to invalidate — a file edited on disk shows up on reload, which
is a useful debugging property.

**Docmost becomes an optional outlet**, off by default: publish a rendered roll-up for people who
live in the wiki, but nothing in Touchstone reads it back.

---

## 4. Degraded and empty states

These matter more than usual here, because the system's normal condition includes "large parts
unknown."

| State | What the UI shows |
| --- | --- |
| No assays yet | Overview lists subjects as `⬜ not yet run` with a *Run first assay* action. Never an empty page. |
| Bench pool down | Banner + functional column uniformly `▨ blocked`. Functional re-assay disabled with the reason. Static work continues visibly. |
| Assay running | Row shows `◴ running · 4m` with the worker and bench; live, no reload needed. |
| Standard drifted | Banner on Standards, and affected hallmarks get a small `stale rubric` marker. |
| Report file missing | Findings still render from the DB; report pane says the file is gone and offers a re-assay. |

---

## 5. Deliberately not in v1

- **No editing of the standard in the UI.** The rubric is versioned content owned elsewhere;
  Touchstone points at it and hashes it. See ARCHITECTURE.md open question 2.
- **No per-user accounts or roles.** AppShield already authenticated the visitor, and the trusted
  gate makes that count. One shared authenticated view.
- **No PR/gate surface.** That is phase 3, and it belongs on the PR, not in this app.
- **No charts.** Risk over time is tempting and premature — the history strip carries the signal
  that matters (did it get worse) without a charting dependency. Revisit once there is more than a
  few weeks of history.
