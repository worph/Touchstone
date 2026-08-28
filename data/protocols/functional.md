---
id: functional
name: Functional Review Protocol
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

> Touchstone's copy. Docmost pages of the same name still drive *AppStore PR Review*; that is
> a separate fork and nothing here binds it.
>
> **How to operate the platform is not in here.** Routes, dialogs, the store's cache, where an
> app's first-run credentials are written down — that is the knowledge base, supplied with this
> protocol and indexed by `KB.md`. This file is the gate: what makes an app pass. Where the two
> disagree, this one governs.

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

The demo PCS runs **Maison**, the dashboard that replaced CasaOS: same app grid, same tiles,
same store format, same on-disk layout — so **nothing about which apps pass moves because the
dashboard changed**. How it behaves and how to drive it without misreading it is the knowledge
base's `maison.md`. What follows is only what it changes about *judging*.

- **Never fail an app for a Maison behaviour.** A backup picker where an install used to be, an
  archive left over from an earlier run, a tile marked `unmanaged`, a System-grid app that
  refuses Stop and Uninstall, a feature that went with CasaOS — these are the platform, not the
  subject. A phase that cannot proceed because of one is `errored`, never `fail`.
- **The store the box serves is a cached copy and can be hours old.** An audit that does not
  refresh may be installing a different version of the app from the one it was asked to audit,
  while `gh` shows it the current source — a divergence that is silent and looks exactly like a
  broken app. Phase C brackets the install with a refresh and a compose check for that reason.
- **One sign-in covers the dashboard and every protected app for 30 days.** That is what makes
  E9 the phase the platform makes easiest to fool; its tie-breaker is stated there.
- **An uninstall archives rather than deletes**, which is why Phase G is a restore and §6's
  cleanup has two halves.

## 3. Phase plan (identical for every app)

**A — Session**

1. `new_page` → `https://<DEMO>/` in a fresh isolated context, and sign in with `LOGIN`.
2. ✅ **pass** when the dashboard is up. A box that has never been set up is infra → `errored`,
   never a fault of the app.

**C — Fresh install**

**Before you install — refresh the store.** The box serves a cached copy, so this is what makes
the run be about the ref you were asked to audit rather than about whatever was current when the
process last started. Refresh from the store UI's own control; if none is exposed, say so in the
report and treat the compose check below as the thing standing in for it. This costs seconds and
is not optional.

**Unless the run supplied its own store.** A trial of files that are on no branch is given a
store URL of its own, and the run instructions name it. Install from *that* URL rather than by
browsing the catalogue: the catalogue serves whatever store the box is configured with, which is
not the thing under trial. No refresh is needed in that case — the URL is minted per trial and
has never been fetched by anything, so no cached copy of it can be stale — and the two checks
that bracket this phase still apply.

3. Install `APP` from the store — the **fresh** install, never a restore from an archive. Phase
   G is the only place an archive row is ever chosen.
4. Read the **Tips** dialog if the app offers one, and keep what it says. It is where an app's
   first-run URL, path or credentials are usually documented, and later phases are judged partly
   on what the app documents.
5. ✅ **pass** when the app settles as installed and ready to open, with no error. Record the
   duration. A failed install leaves its own diagnosis on the tile — read it before concluding
   anything; it is evidence.

**After it installs — confirm you audited the ref you were asked to audit.** Open the tile's
**Settings → Compose** and compare the `pre-install-cmd` and the service block against
`Apps/<APP>/docker-compose.yml` at `REF` as `gh` returns it. They must match.

- **They match** → carry on. This is the normal case and needs one line in the report.
- **They differ** → **stop the audit.** The box is running a different version of the app from
  the one under audit, so nothing after this point is evidence about `REF`. Return the JSON with
  verdict `errored` and a summary naming both versions — this is §2's "never fail an app for a
  Maison behaviour" in its most expensive form. Do **not** file a finding against the app, and
  do **not** reason about why the source you read and the behaviour you saw disagree: that
  disagreement *is* the finding, and its subject is the store, not the app.

The second branch is the one that matters. An auditor who reads correct source and then watches
it fail has two irreconcilable facts and every incentive to invent a mechanism that reconciles
them. Checking here removes the incentive, because the real answer is available and cheap.

**D — Discover the app URL**

6. `APP_URL` by priority: (a) the tile's **Open** action — the URL Maison built from
   `x-compose-app.webui-host`/`webui-path`, or the `x-casaos` fallback — read back via
   `list_pages`; else (b) the Tips URL; else (c) the fallback formula. A tile offering no
   reachable address instead of an Open action means the app declares no resolvable web UI:
   record that, and try the formula before calling the app broken.

**E — Runtime checks (the core gate)** — open `APP_URL` in the same context and assert
**generically**, never against fixed selectors:

7. **E8 works immediately** — a real UI renders within a bounded `wait_for`. Not an error page,
    not an endless spinner, no "run this command / check the logs / edit this config" prerequisite.
8. **E9 auth gate** *(mandatory)* — a login or registration form is present, **or** a protected
    path redirects to an auth route. No auth → `fail`, unless `rationale.md` documents a public
    exception, which makes it a `pass` with the exception named in the note.

    ⚠️ **This is the phase the platform makes easy to fool.** The session Phase A established
    carries straight into `APP_URL`, so an app that opens on its content may simply be riding
    this run's sign-in and has proved nothing about its own gate. The per-run isolated context
    and the deliberately profile-less browser are the guard. **When in doubt, re-open the same
    path in a second, never-signed-in context** — that is the tie-breaker.

    The recommended gate for a new app is the **AppShield** OIDC sidecar
    (`ghcr.io/yundera/appshield`), which registers with the PCS `auth-registrar` and protects
    the app with the platform SSO. Such an app has **no login form of its own** — its gate is
    the redirect to the SSO, which a signed-in run never sees. Reference deployments:
    `Apps/ConvertX`, `Apps/Spliit`, `Apps/BrowserMCP`. An app's own built-in auth (Jellyfin,
    Immich onboarding) and Basic Auth are equally acceptable, as long as the gate is on by
    default.
9. **E10 clean boot** — `list_console_messages(error)` ≈ 0 first-party, and no first-party
    `5xx` in `list_network_requests`. A breach is a `fail` with a note, at the severity the
    breach deserves; it is not a reason to defer to a human.
10. Screenshot every pass and every fail. Screenshots are the evidence.

**F — Zero-config usability** *(mandatory)* — complete the obvious in-UI setup (create the
admin account, accept the wizard, sign in with the account the app documents) to a usable screen
**purely in the browser** → `pass`. Needing a file edited or a command run → `fail`.

**What counts as documented.** An app may hand its first credentials, URL or setup step to the
operator through anything the platform itself surfaces — the **Tips** dialog, the store
description, the app's own first screen. Any of those is *documented*, and following it is part
of zero-config rather than a deduction against the app. Reading container logs, opening a shell
or editing a file to find the same value is not, and is a `fail`. Before judging a first login,
check what the app documented: the value is often in Tips, and an audit that never opened it is
reporting on a step it did not take. Name in the prose where you found it, or that there was
nowhere.

**G — Data persistence** *(mandatory)* — on Maison an uninstall never deletes, it **archives**.
There is no "keep data" option to tick, and a plain reinstall lands on a clean slate and proves
nothing. The sequence is therefore:

11. Create state in the app — an account, an item, an `upload_file` — and write down exactly
    what to look for afterwards.
12. **Uninstall the app**, which archives it.
13. **Reinstall from the archive your own uninstall just made** — not "the newest one", and
    never a fresh install, which lands on a clean slate and tests nothing. If an archive you did
    not create is present, or you cannot establish which one is yours, the phase is `errored`:
    restoring somebody else's archive reinstalls *their* compose — an archive carries the whole
    app folder — which tests a version you were never asked to audit and reports the result
    against this one. §6's cleanup exists so this does not arise; when it does anyway, it is the
    platform and the previous run, never the app.
14. Assert the state from step 11 survived.

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
went with CasaOS.

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
