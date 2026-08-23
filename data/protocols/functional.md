---
id: functional
name: Functional Review Protocol
version: 8
kind: leaf

# Where this section sits in a run, and what it cannot run without. `order` decides report
# order and which section carries the headline verdict (the lowest one does); `requires`
# replaced `depth: full` — the runner probes these capabilities and records this section as
# blocked, on its own, when they are missing.
order: 2
requires:
  - bench
  - browser

# The fixed phase plan, declared here rather than in code: the track the UI draws, the list
# the prompt asks the agent to report, and the ids the ledger accepts are this one list.
phases:
  - { id: A, label: session }
  - { id: C, label: fresh install }
  - { id: D, label: discover URL }
  - { id: E8, label: works immediately }
  - { id: E9, label: auth gate }
  - { id: E10, label: clean boot }
  - { id: F, label: zero-config usability }
  - { id: G, label: data persistence }

# Which headings in the agent's narrative report belong to this section, when the prose is
# split into one body per section. Case-insensitive regex sources.
report_headings:
  - ^functionality
  - ^functional\s+(leaf|review)

requirements:
  # The fixed phase plan. Unlike the static checklist these ARE owned by this protocol —
  # §4 names them and every one is mandatory — so the list is authoritative rather than a
  # mapping aid. Cleanup (§6) is deliberately NOT here: it is an obligation on the run, not
  # a property of the app, and a requirement id would let an untidy run fail an innocent app.
  - id: phase-a-session
    text: A — session established on the demo host
    requires: bench
  - id: phase-c-install
    text: C — fresh install completes
    requires: bench
  - id: phase-d-url
    text: D — app URL discovered
    requires: bench
  - id: phase-e8-works
    text: E8 — works immediately
    requires: bench
  - id: phase-e9-auth
    text: E9 — auth gate present
    requires: bench
  - id: phase-e10-clean-boot
    text: E10 — clean boot, no first-party errors
    requires: bench
  - id: phase-f-zero-config
    text: F — zero-config usability
    requires: bench
  - id: phase-g-persistence
    text: G — data survives an uninstall (which archives) then a restore-from-archive reinstall
    requires: bench
---

# Functional Review Protocol

The rubric for the **runtime** conformance of one AppStore app: install it on a demo PCS, drive
a real browser, and decide whether it actually works. One input — an app name — and one fixed
phase sequence, identical for every app, deriving everything app-specific at runtime and
hardcoding nothing. The *static / compose* items belong to the Static Review Protocol
(`static`).

The repo's own `CONTRIBUTING.md` Functionality checklist is the source of truth for what
"functional" means. **Hard rule: report a verdict, never merge or approve.** A human keeps the
merge button.

> Touchstone's copy. Docmost pages of the same name still drive *AppStore PR Review* in n8n;
> that is a separate fork and nothing here binds it. Per-app hints: **Functional QA — App KB**
> (`NeFOTSJPGH`).

## How results are recorded

There is no orchestrator and no result block — Touchstone composes the assay itself from what
you record, as you record it.

1. **`touchstone__record_phase` as each phase completes** — `pass`, `fail`, `errored` or `n-a`.
2. **`touchstone__list_requirements` first, then `touchstone__record_requirement`** for the
   checklist ids, the moment each settles, with a severity on every `fail`.
3. **Write this section's prose under a `## Functionality` heading.** Evidence, screenshots
   taken, the install duration and the host you ran on go in the records' notes and in that
   prose.

One result per phase, and there are only four:

| Result | Means |
| --- | --- |
| `pass` | ran, and the app satisfied it |
| `fail` | ran, and the app did not — a statement about the app |
| `errored` | could not run: infra failed, or the platform got in the way. **Never** the app's fault; the caller retries |
| `n-a` | a deterministic, input-forced impossibility. The only current case is G′ — migration, which this protocol does not run at all (§3) |

**There is no way to say you chose not to run a phase.** No `skipped`, no `not-attempted`, no
"optional deep", no economising on browser calls. `n-a` is for an impossibility, never a choice;
"skipped to save time" is a protocol violation. `needs-changes` and `needs-human` do not exist
either — never defer to a human: a runtime caveat is a `fail` with a severity and a note, or a
`pass` with the caveat stated in the prose. The headline verdict is the caller's gate to apply,
not yours to declare.

*Why the licence was removed:* audits were declaring apps `functional` while Phases F and G were
skipped as "optional deep", so the two highest-consequence checks — zero-config and data
persistence — were never exercised at all.

### Say what you could not reach

A failing phase takes the later ones down with it. An app that will not start hides E9, E10, F
and G completely; an install that fails hides everything after C. Record those phases `errored`
— they could not run — and then **say so in one sentence at the top of your prose**, before any
finding:

> Coverage: phases A–C ran. D onward could not be reached, because the container exited at boot.
> The findings below are therefore not exhaustive.

This sentence is not a courtesy. Two readers depend on it and neither can recover it afterwards:

- **Whoever fixes the app.** The fix brief hands them the requirement ids to clear. A short list
  of findings from a run that got three phases in reads as *nearly done*, and they will ship one
  round of changes expecting to be finished.
- **The next audit's reader.** Clearing one failure lets the following run reach checks this one
  never attempted, so it will legitimately report findings that are new. Said in advance that is
  the process working. Left unsaid it reads as the audit contradicting itself, and the verdict
  loses its authority — which costs more than any single finding.

**Never write it when every phase ran.** "Not exhaustive" attached to a complete run is worse
than useless: it teaches the reader to skip the line on the run where it is true.

The same applies within a phase. If you could not check something because a precondition was not
met — no seed data, no second account, a control that never rendered — record the requirement
`unverified` rather than `pass`, and name the precondition. Absence of evidence is recorded as
absence of evidence; it is never recorded as a pass.

## 1. Inputs

| Param | Meaning | Example |
| --- | --- | --- |
| `APP` | App display name **exactly as in the store** | `Filebrowser` |
| `DEMO` | Demo PCS host, **supplied by the caller** | `demostaging1.inojob.com` |
| `LOGIN` | Platform SSO credentials — Maison has no login of its own | `demo` / `demodemo` |
| `BROWSER` | A `browser-mcp` sidecar, **supplied by the caller**, leased to this run alone | |

Derived at runtime, never hardcoded: `APP_URL`, discovered in Phase D. Fallback only:
`https://<slug>-<DEMO>/`, where `slug` is `APP` lowercased with spaces removed.

**The caller chooses the host and the browser; you choose neither.**

- **Do not open the Demo Management board and do not substitute another instance.** Touchstone
  probes each instance's login flow end to end before dispatching, which the board does not: on
  2026-08-19 the board reported an instance `✅ Ready` while its login gate answered HTTP 500,
  and the board's own "most time remaining" rule preferred exactly that one. If the supplied
  host does not work, mark the phases `errored` — that is infra, and the caller retries.
- **Never click `🧹 Trigger Cleanup`.** It resets a shared instance another run may be using.
- **Use only the supplied browser.** A shared browser's tabs belong to other work, and a tab
  stolen mid-install is recorded against the app. Use a fresh `isolatedContext` named
  `functional-<APP>-<runid>`.
- The runway rule lives in the caller: an instance with less than an hour before its daily
  cleanup is never dispatched, so a run cannot be wiped mid-Phase-G.

Name the host you ran on in the prose, so a failed run can be traced back to it.

## 2. The platform is Maison

The demo PCS runs **Maison**, the dashboard that replaced CasaOS. Same app grid, same tiles,
same store format, same on-disk layout — so **nothing about which apps pass moves because the
dashboard changed**. Four things this protocol drives do move:

| | Was (CasaOS) | Is (Maison) |
| --- | --- | --- |
| **Where the dashboard lives** | `casaos-<DEMO>` | `maison-<DEMO>`, **and the bare `<DEMO>`** |
| **Who asks for the password** | CasaOS's own accounts | the **platform SSO** — one sign-in for the dashboard, the admin page and every protected app, valid **30 days** |
| **Reaching the store** | a tile opening an in-page modal | a **route** — `/store`, `/store/<app-id>` |
| **What uninstall does** | removed the app; "keep data" left the folder | **always archives** the whole folder, never deletes |

Useful routes: `https://<DEMO>/store` (catalog), `https://<DEMO>/store/<app-id>` (one app,
`<app-id>` being the compose project `name`, i.e. the lowercase slug), and
`https://<DEMO>/settings/backups` (the box-wide archive list, for cleanup). Navigating beats
clicking and survives a slow paint. The whole UI is in the accessibility tree, so prefer
`take_snapshot` and click uids — and use a **real** `click` on a uid for store and app tiles.

**Gone with CasaOS, and never a reason to fail an app:** the Files app, the built-in terminal,
disk/RAID and Samba management, the global search bar, and the manual "install a customised app"
form. If a phase seems to need one of those, the phase is being read wrong. (The
synthetic-pointer-event trick for prising open the old store modal is obsolete with it — the
store is a real route now, and a hand-dispatched event sequence must not be used.)

**Never fail an app for a Maison behaviour.** A backup picker where an install used to be, an
archive left over from an earlier run, a tile marked `unmanaged`, a System-grid app that refuses
Stop and Uninstall — these are the platform, not the subject. A phase that cannot proceed
because of one is `errored`, never `fail`.

**The store the box serves is a cached copy, and it can be hours old.** Maison holds the store
zip (`APPSTORE_URL`, `.../archive/refs/heads/<branch>.zip`) **in the running process** — there is
no copy on disk — and re-reads it only on a refresh or a restart. A commit to the store is
therefore *not* visible to an install until one of those happens, and demo instances restart
once a day. **An audit that does not refresh is auditing whatever the box last cached**, which
may be a different version of the app from the one it was asked to audit — while `gh` shows the
auditor the current source. That divergence is silent, it looks exactly like a broken app, and
it is the reason for the two checks that bracket Phase C below.

*Recorded because it has already cost a day:* on 2026-08-20 a fix landed at 16:45 and two audits
at 17:29 and 20:34 installed the pre-fix compose from cache. Both correctly observed a real
reinstall failure, and both attributed it to an app whose source — which the agent could read,
and which was fixed — did not contain the defect. The same cycle passed on both demo hosts the
next morning, after the nightly restart.

## 3. Phase plan (identical for every app)

**A — Session**

1. `new_page` → `https://<DEMO>/` in a fresh isolated context. The bare host opens the Maison
   dashboard directly; `https://maison-<DEMO>/` is the same page.
2. The gate is the **platform SSO**, not a dashboard account. Take whichever route the login
   page offers — *Log in with Yundera* (the `LOGIN` credentials) or *Local Account* — then
   `wait_for` `["App Store", "System status"]`, the dashboard's own markers. A **Getting
   Started** wizard at `admin-<DEMO>` means the box has never been set up: infra → `errored`.

**C — Fresh install**

**Before you install — refresh the store.** The box serves a cached copy (§2), so this is what
makes the run be about the ref you were asked to audit rather than about whatever was current
when the process last started. Refresh from the store UI's own control; if none is exposed,
say so in the report and treat the compose check below as the thing standing in for it. This
costs seconds and is not optional.

**Unless the run supplied its own store.** A trial of files that are on no branch is given a
store URL of its own, and the run instructions name it. Then install by opening
`https://<DEMO>/store/<APP>?store=<that url>` rather than by browsing the catalogue: the
catalogue serves whatever store the box is configured with, which is not the thing under trial.
Maison will warn that the app comes from a store you have not added — **that warning is correct
and accepting it is part of the run**. No refresh is needed in this case, and asking for one is
a mistake worth naming: the URL is minted per trial and has never been fetched by anything, so
there is no cached copy of it that could be stale. The two checks that bracket this phase still
apply — assert the installed compose is the one you audited.

3. Navigate to `https://<DEMO>/store`.
4. `take_snapshot`, find the card whose heading `== APP`, click its **Install** pill. The search
   box matches name, tagline *and* category, so confirm the heading matches `APP` exactly rather
   than taking the first hit.
5. ⚠️ **The backup picker.** If the box already holds an archive of `APP`, the Install click
   opens a **menu** instead of installing: **Fresh install** at the top, then **Restore from
   backup** with one row per archive. Phase C is the *fresh* install — click **Fresh install**.
   Phase G is the only place an archive row is ever chosen. With no archives present the click
   installs straight away and no menu appears.
6. Optional **Tips** dialog — capture any URLs or paths it shows. Maison also keeps it on the
   tile's menu under **Tips**.
7. Watch the single progress bar on the tile and on the store's install pill: **Download**
   (blue, real per-layer pull progress), then **Start** (green). Progress rides the live app
   list, so it keeps advancing after the store panel is closed — closing the panel is not
   "continue in background", it is just closing a panel. ✅ **pass** when the tile settles with
   an **Open** action and no error. Record the duration.
8. A failed install **stays visible** as a red `!` on the tile with the error in its tooltip; it
   does not vanish. Read that tooltip before concluding anything — it is the install's own
   diagnosis, and it is evidence.

**After it installs — confirm you audited the ref you were asked to audit.** Open the tile's
**Settings → Compose** and compare the `pre-install-cmd` and the service block against
`Apps/<APP>/docker-compose.yml` at `REF` as `gh` returns it. They must match.

- **They match** → carry on. This is the normal case and needs one line in the report.
- **They differ** → **stop the audit.** The box is running a different version of the app from
  the one under audit, so nothing after this point is evidence about `REF`. Return the JSON with
  verdict `errored` and a summary naming both versions — this is §2's "never fail an app for a
  Maison behaviour", in its most expensive form. Do **not** file a finding against the app, and
  do **not** reason about why the source you read and the behaviour you saw disagree: that
  disagreement *is* the finding, and its subject is the store, not the app.

The second branch is the one that matters. An auditor who reads correct source and then watches
it fail has two irreconcilable facts and every incentive to invent a mechanism that reconciles
them. Checking here removes the incentive, because the real answer is available and cheap.

**D — Discover the app URL**

9. `APP_URL` by priority: (a) the tile's **Open** action — the URL Maison built from
   `x-compose-app.webui-host`/`webui-path`, or the `x-casaos` fallback — read back via
   `list_pages`; else (b) the Tips URL; else (c) the fallback formula. A tile offering no
   reachable address instead of an Open action means the app declares no resolvable web UI:
   record that, and try the formula before calling the app broken.

**E — Runtime checks (the core gate)** — open `APP_URL` in the same context and assert
**generically**, never against fixed selectors:

10. **E8 works immediately** — a real UI renders within a bounded `wait_for`. Not an error page,
    not an endless spinner, no "run this command / check the logs / edit this config" prerequisite.
11. **E9 auth gate** *(mandatory)* — a login or registration form is present, **or** a protected
    path redirects to an auth route. No auth → `fail`, unless `rationale.md` documents a public
    exception, which makes it a `pass` with the exception named in the note.

    ⚠️ **This is the phase the platform makes easy to fool.** One sign-in covers the dashboard,
    the admin page and every protected app for 30 days, so the session Phase A established
    carries straight into `APP_URL`: an app that opens on its content may simply be riding this
    run's session, and has proved nothing about its own gate. The per-run isolated context and
    the deliberately profile-less browser are the guard. **When in doubt, re-open the same path
    in a second, never-signed-in context** — that is the tie-breaker.

    The recommended gate for a new app is the **AppShield** OIDC sidecar
    (`ghcr.io/yundera/appshield`), which registers with the PCS `auth-registrar` and protects
    the app with the platform SSO. Such an app has **no login form of its own** — its gate is
    the redirect to the SSO, which a signed-in run never sees. Reference deployments:
    `Apps/ConvertX`, `Apps/Spliit`, `Apps/BrowserMCP`. An app's own built-in auth (Jellyfin,
    Immich onboarding) and Basic Auth are equally acceptable, as long as the gate is on by
    default.
12. **E10 clean boot** — `list_console_messages(error)` ≈ 0 first-party, and no first-party
    `5xx` in `list_network_requests`. A breach is a `fail` with a note, at the severity the
    breach deserves; it is not a reason to defer to a human.
13. Screenshot every pass and every fail. Screenshots are the evidence.

**F — Zero-config usability** *(mandatory)* — complete the obvious in-UI setup (create the
admin account, accept the wizard) to a usable screen **purely in the browser** → `pass`. Needing
a file edited or a command run → `fail`.

**G — Data persistence** *(mandatory)* — on Maison an uninstall never deletes, it **archives**.
There is no "keep data" option to tick, and a plain reinstall lands on a clean slate and proves
nothing. The sequence is therefore:

14. Create state in the app — an account, an item, an `upload_file` — and write down exactly
    what to look for afterwards.
15. **Uninstall.** The confirm dialog says the folder is renamed to `<app>.<date>.archive` under
    `AppData/`, and offers *Compress the archive to a `.zip`* — leave it **off**: a rename is
    instant, a zip is a full second copy and can take minutes. The tile shows the same single
    bar in red: **Remove**, then **Archive**.
16. **Reinstall from the archive your own uninstall just made** — not "the newest one".
    Back in the store, click **Install** and let the picker open. The rows under **Restore from
    backup** are labelled by **date only**, so two archives made on the same day are
    indistinguishable there; `https://<DEMO>/settings/backups` lists the same archives **with
    times** and is how you tell them apart. If a row you did not create is present, or you
    cannot establish which row is yours, the phase is `errored` — restoring somebody else's
    archive reinstalls *their* compose (an archive carries the whole app folder), which tests a
    version you were never asked to audit and reports the result against this one.
    §6's cleanup exists so this situation does not arise; when it does anyway, it is the
    platform and the previous run, never the app.
    Choosing **Fresh install** here lands on a clean slate and tests nothing.
17. Assert the state from step 14 survived.

*What this proves.* An archive carries the **whole** app folder — compose, override, `.env` and
the data under `AppData/<app>/` — so a state location the app keeps **outside** its mapped
volumes is not in the archive and does not come back. That is exactly the fault the phase exists
to catch, and it now catches it along the path a real user takes. A restore that comes back
empty is a `fail` **against the app**, not against Maison. Cost and duration are never a reason
to skip it; the harness budgets the time.

**G′ — Migration** *(never run here — record `n-a`)* — a migration test installs the version
a user is running today, seeds state, upgrades to the new one and asserts both data and function
survive. That needs two versions and an audit has one: this protocol runs `main` as it stands,
and Maison cannot install an earlier version anyway — the manual "install a customised app" form
went with CasaOS (§2).

**The PR path owns migration**, because a version bump is what a PR *is*: it carries both refs,
so it is the only caller that can supply a prior version. Record G′ `n-a` with that as the
reason — *migration is covered on version bump by the PR review, not by this audit* — rather than
"no `PRIOR_VERSION` supplied", which reads as an accident instead of a division of labour. State
it in the prose too. It is a standing limit on what a store audit covers, and a row that says so
is the only thing keeping it from looking like a phase that quietly passed.

What an audit *does* exercise of the same fault: Phase G installs the app, seeds it, and then
runs its install hooks a second time against data that already exists — the failure mode most
upgrades actually trip on. The static leaf carries the matching rule, *install hooks are safe to
rerun on every reinstall and upgrade*. Neither is a substitute for G′; both mean the gap is
narrower than the `n-a` row suggests.

**H — Cleanup.** See §6. Mandatory on every exit path, including failure.

## 4. Gate

Every mandatory phase must `pass` for the app to be functional. Any mandatory phase `fail` makes
the app non-compliant; any mandatory phase `errored` or missing makes the **audit** errored and
retried — it is not a verdict about the app. Record the phases; the caller applies this.

## 5. Determinism

- "Same plan for every app" means the same ordered phases and the same pass criteria. Per-app
  variation — the store card, `APP_URL`, the specific auth UI — is **discovered at runtime**,
  never branched on.
- Absorb UI differences by evaluating the generic Phase-E assertions, not by hunting for
  selectors you saw last time.
- One `isolatedContext` per run. The caller serialises the demo instances so two runs cannot
  collide on one.
- **Resilience with no escape hatch.** If the browser session becomes unrecoverable, do not
  abort and do not reach for a human: record the phases you reached, mark the rest `errored`,
  write up what you have. Infra is the caller's problem to retry.

## 6. Cleanup — two halves

Uninstalling is no longer enough to leave the box as found, because the uninstall itself creates
an archive.

1. Uninstall `APP` from the demo host.
2. **Delete every archive this run produced** — from the app's own **Backups** tab, or
   **Settings → Backups** (`/settings/backups`), where an uninstalled app's archives are listed
   and marked `uninstalled`.

An archive left behind turns the *next* run's Phase C install into a restore prompt. That is how
one run's untidiness becomes another run's false result.

---

## Changelog — not part of the rubric

- **v8 (2026-08-23)** — **say what you could not reach.** A run whose early phases fail never
  attempts the later ones, and until now nothing required the report to admit it: a three-phase
  run and a complete one produced findings lists that looked alike. Two readers were misled by
  that — whoever fixes the app, who reads a short list as nearly done; and whoever reads the next
  audit, which legitimately finds more once the first failure is cleared, and without the
  disclosure reads as the audit contradicting itself. Now a run that could not reach a phase
  opens its prose with one sentence naming what ran and what did not, and is explicitly forbidden
  from writing that sentence when everything ran.
- **v7 (2026-08-22)** — a run may now supply its **own store**, and Phase C says how to install
  from it: `https://<DEMO>/store/<APP>?store=<url>`, accepting Maison's "store you have not
  added" warning as expected. This is what lets a trial of files that are on no branch run its
  live section at all — previously it was recorded `blocked` as `store_not_installable`, on the
  correct grounds that a bench installs from its own catalogue and would have reported a result
  about `main` under the trial's name. It also removes the v6 failure mode rather than
  mitigating it: a per-trial URL has never been fetched by anything, so there is no cached copy
  of it to be stale, and no refresh to forget.
- **v6 (2026-08-21)** — the store the box serves is a cached copy, and an audit that does not
  account for that can audit a different version of the app than the one it was asked to (§2).
  Phase C is now bracketed by a **store refresh** before and a **compose assertion** after: read
  the installed compose back off the tile and compare it against the source at `REF`, and on a
  mismatch return `errored` naming both versions rather than filing anything against the app.
  Phase G.16 restores **the archive this run just created** rather than "the newest row" — the
  picker labels archives by date alone, and restoring another run's archive reinstalls that
  run's compose. Written after a fix landed at 16:45 on 2026-08-20 and two audits that same
  evening tested the pre-fix compose from cache, correctly observed the failure it caused, and
  attributed it to an app whose source no longer had the defect.
- **v5 (2026-08-20)** — migration (G′) is stated as belonging to the PR path rather than to an
  audit, and its `n-a` now carries that reason instead of "no `PRIOR_VERSION` supplied". Dropped
  the `PRIOR_VERSION` input and its mention in cleanup: nothing here ever supplies one, and
  Maison has no way to install an earlier version.
- **v4 (2026-08-20)** — folded four stacked amendments (strict full-run 2026-07-07, demo-host
  selection 2026-07-17, Touchstone 2026-08-19, Maison 2026-08-20, Touchstone 2026-08-20) into
  one present-tense body and deleted what they had superseded: the `functional` /
  `not-functional` / `needs-changes` / `needs-human` vocabulary, the
  `{ functional_verdict, phases, evidence, install_seconds }` return shape, the board-reading
  host-selection procedure, and the pre-Maison Immich worked example. Reconciled with
  `CONTRIBUTING.md` at `6758715`: E9 now names AppShield, whose apps have no login form of
  their own and are therefore the easiest kind to mis-pass on a signed-in session.
- **v3 (2026-08-20)** — Maison replaces CasaOS: store routes, archive-based Phase G, two-half
  cleanup.
- **v2 and earlier** — the fixed phase plan, mandatory F and G, per-phase pass/fail/errored.
  Imported from Docmost on 2026-08-19.
