---
id: functional
name: Functional Review Protocol
kind: leaf

# Where this section sits in a run, and what it cannot run without. `order` decides report
# order and which section carries the headline verdict (the lowest one does); `requires` is
# what the runner probes before dispatching — this section is recorded blocked, on its own,
# when they are missing.
order: 2
requires:
  - bench
  - browser

# Which headings in the agent's narrative report belong to this section, when the prose is
# split into one body per section. Case-insensitive regex sources.
report_headings:
  - ^functionality
  - ^functional\s+(leaf|review)

requirements:
  # The canonical ids, and — because each carries a `phase:` — the phase plan too. ONE list.
  # There used to be two: a `phases:` block keyed A, C, D, E8, E9, E10, F, G and this list
  # keyed phase-a-session and friends. Two id spaces for the same eight facts, and the letters
  # had holes in them (no B, no E1-E7) left by an older document's steps, so every reader had
  # to learn that "E8" meant "works immediately" instead of reading it. `phase:` is the short
  # label the run's progress track shows; the order here is the order they run in.
  #
  # Unlike the static checklist these ids ARE owned by this protocol - the gate below names
  # them and every one is mandatory - so the list is authoritative rather than a mapping aid.
  # Cleanup is deliberately NOT here: it is an obligation on the run, not a property of the
  # app, and a requirement id would let an untidy run fail an innocent app.
  - id: session
    text: A session is established on the demo host
    phase: session
    requires: bench
  - id: install
    text: A fresh install completes
    phase: fresh install
    requires: bench
  - id: app-url
    text: The app's URL is discoverable from the platform
    phase: discover URL
    requires: bench
  - id: works-immediately
    text: The app works immediately - a real UI, with no command to run or log to read first
    phase: works immediately
    requires: bench
  - id: auth-gate
    text: An authentication gate is present and on by default
    phase: auth gate
    requires: bench
  - id: clean-boot
    text: Clean boot - no first-party console errors and no first-party 5xx
    phase: clean boot
    requires: bench
  - id: zero-config
    text: The app reaches a usable state purely in the browser
    phase: zero-config usability
    requires: bench
  - id: data-persistence
    text: Data survives an uninstall (which archives) and a restore-from-archive reinstall
    phase: data persistence
    requires: bench
  # Declared so that it is recorded rather than invented. An audit has one version and a
  # migration test needs two, so this is permanently `n-a` here and the PR path owns it - and
  # a declared `n-a` is visible where a phase the agent made up is not: an unplanned id is
  # dropped by the progress track, which is what was happening to the old free-hand "G'".
  - id: migration
    text: Data and function survive an upgrade from the version a user runs today (never run here - n-a)
    phase: migration
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

> **How to operate the platform is not in here.** Routes, dialogs, the store's cache, where an
> app's first-run credentials are written down — that is the knowledge base, supplied with this
> protocol and indexed by `KB.md`. This file is the gate: what makes an app pass. Where the two
> disagree, this one governs.

## How results are recorded

There is no result block — Touchstone composes the assay from what you record, as you record
it. The run's own instructions name the tools and when to call them; what follows is what the
values *mean*, which is this protocol's to define.

Every requirement here is also a step in the sequence, so each settles twice: as a **verdict**
about the app, and as a **result** for the step.

| Verdict (the requirement) | Means |
| --- | --- |
| `pass` | checked, and the app satisfied it |
| `fail` | checked, and it did not — a statement about the app. **Always** carries a severity (§4) |
| `n-a` | the item cannot apply to this app. Never "I chose not to check it" |
| `unverified` | you could not settle it. Never `pass` something you could not check |

| Result (the step) | Means |
| --- | --- |
| `pass` | ran, and the app satisfied it |
| `fail` | ran, and the app did not |
| `errored` | could not run: infra failed, or the platform got in the way. **Never** the app's fault; the caller retries |
| `n-a` | a deterministic, input-forced impossibility. The standing case is `migration`, which this protocol never runs |

Write this section's prose under a `## Functionality` heading. Evidence, screenshots taken, the
install duration and the host you ran on go in the records' notes and in that prose.

**There is no way to say you chose not to run a step.** No `skipped`, no `not-attempted`, no
"optional deep", no economising on browser calls. `n-a` is for an impossibility, never a choice;
"skipped to save time" is a protocol violation. `needs-changes` and `needs-human` do not exist
either — never defer to a human: a runtime caveat is a `fail` with a severity and a note, or a
`pass` with the caveat stated in the prose. The headline verdict is the caller's gate to apply,
not yours to declare.

*Why the licence was removed:* audits were declaring apps `functional` while `zero-config` and
`data-persistence` were skipped as "optional deep", so the two highest-consequence checks were
never exercised at all.

### Say what you could not reach

A failing step takes the later ones down with it. An app that will not start hides `auth-gate`,
`clean-boot`, `zero-config` and `data-persistence` completely; an install that fails hides
everything after it. Record those steps `errored` — they could not run — and then **say so in
one sentence at the top of your prose**, before any finding:

> Coverage: session and install ran. Everything from `app-url` on could not be reached, because
> the container exited at boot. The findings below are therefore not exhaustive.

This sentence is not a courtesy. Two readers depend on it and neither can recover it afterwards:

- **Whoever fixes the app.** The fix brief hands them the requirement ids to clear. A short list
  of findings from a run that got three phases in reads as *nearly done*, and they will ship one
  round of changes expecting to be finished.
- **The next audit's reader.** Clearing one failure lets the following run reach checks this one
  never attempted, so it will legitimately report findings that are new. Said in advance that is
  the process working. Left unsaid it reads as the audit contradicting itself, and the verdict
  loses its authority — which costs more than any single finding.

**Never write it when every step ran.** "Not exhaustive" attached to a complete run is worse
than useless: it teaches the reader to skip the line on the run where it is true.

The same applies within a step. If you could not check something because a precondition was not
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
  broken app. `install` brackets itself with a refresh and a compose check for that reason.
- **One sign-in covers the dashboard and every protected app for 30 days.** That is what makes
  `auth-gate` the step the platform makes easiest to fool; its tie-breaker is stated there.
- **An uninstall archives rather than deletes**, which is why `data-persistence` is a restore
  and §7's cleanup has two halves.

## 3. The sequence (identical for every app)

One heading per requirement, in the order they run. The id in each heading is the id you
record against.

**`session`**

1. `new_page` → `https://<DEMO>/` in a fresh isolated context, and sign in with `LOGIN`.
2. ✅ **pass** when the dashboard is up. A box that has never been set up is infra → `errored`,
   never a fault of the app.

**`install`** — fresh install

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

**`app-url`** — discover the app URL

6. `APP_URL` by priority: (a) the tile's **Open** action — the URL Maison built from
   `x-compose-app.webui-host`/`webui-path`, or the `x-casaos` fallback — read back via
   `list_pages`; else (b) the Tips URL; else (c) the fallback formula. A tile offering no
   reachable address instead of an Open action means the app declares no resolvable web UI:
   record that, and try the formula before calling the app broken.

The next three are the core gate. Open `APP_URL` in the same context and assert **generically**,
never against fixed selectors:

7. **`works-immediately`** — a real UI renders within a bounded `wait_for`. Not an error page,
    not an endless spinner, no "run this command / check the logs / edit this config" prerequisite.
8. **`auth-gate`** *(mandatory)* — a login or registration form is present, **or** a protected
    path redirects to an auth route. No auth → `fail`, unless `rationale.md` documents a public
    exception, which makes it a `pass` with the exception named in the note.

    ⚠️ **This is the step the platform makes easy to fool.** The session `session` established
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
9. **`clean-boot`** — `list_console_messages(error)` ≈ 0 first-party, and no first-party
    `5xx` in `list_network_requests`. A breach is a `fail` with a note, at the severity the
    breach deserves; it is not a reason to defer to a human.
10. Screenshot every pass and every fail. Screenshots are the evidence.

**`zero-config`** — zero-config usability *(mandatory)* — complete the obvious in-UI setup (create the
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

**`data-persistence`** *(mandatory)* — on Maison an uninstall never deletes, it **archives**.
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
    against this one. §7's cleanup exists so this does not arise; when it does anyway, it is the
    platform and the previous run, never the app.
14. Assert the state from step 11 survived.

*What this proves.* An archive carries the **whole** app folder — compose, override, `.env` and
the data under `AppData/<app>/` — so a state location the app keeps **outside** its mapped
volumes is not in the archive and does not come back. That is exactly the fault the phase exists
to catch, and it now catches it along the path a real user takes. A restore that comes back
empty is a `fail` **against the app**, not against Maison. Cost and duration are never a reason
to skip it; the harness budgets the time.

**`migration`** *(never run here — record `n-a`)* — a migration test installs the version
a user is running today, seeds state, upgrades to the new one and asserts both data and function
survive. That needs two versions and an audit has one: this protocol runs `main` as it stands,
and Maison cannot install an earlier version anyway — the manual "install a customised app" form
went with CasaOS.

**The PR path owns migration**, because a version bump is what a PR *is*: it carries both refs,
so it is the only caller that can supply a prior version. Record `migration` as `n-a` with that
as the reason — *migration is covered on version bump by the PR review, not by this audit* — rather than
"no `PRIOR_VERSION` supplied", which reads as an accident instead of a division of labour. State
it in the prose too. It is a standing limit on what a store audit covers, and a row that says so
is the only thing keeping it from looking like a phase that quietly passed.

What an audit *does* exercise of the same fault: `data-persistence` installs the app, seeds it, and then
runs its install hooks a second time against data that already exists — the failure mode most
upgrades actually trip on. The static leaf carries the matching rule, *install hooks are safe to
rerun on every reinstall and upgrade*. Neither is a substitute for a real migration test; both mean the gap is
narrower than the `n-a` row suggests.

**Cleanup.** See §7. Mandatory on every exit path, including failure.

## 4. Severity — on every `fail`

A `fail` without a severity is not a finding, it is a complaint: the tier is what the caller
sums into `risk_score` (100 per Critical, 10 per Major, 1 per Minor) and **any Critical makes
the app non-compliant unconditionally**. Until 2026-08-28 this protocol demanded a severity on
every fail and never said what the tiers meant, so the most consequential number in a runtime
audit came from whatever the agent felt at the time. It is mechanical now.

**Each requirement has a default tier. Start there.**

| Requirement | Default on `fail` | Because |
| --- | --- | --- |
| `auth-gate` | **Critical** | an app reachable without signing in is exposed the moment it is installed. This is the one the platform makes easy to get wrong in the app's favour (§3), so a `fail` here is never softened |
| `data-persistence` | **Critical** | state that does not come back is data loss, and the user finds out after it is gone |
| `install` | **Major** | the app cannot be installed as shipped — no security or data risk, but the store contract is broken |
| `works-immediately` | **Major** | installs, does not work. Same reasoning |
| `app-url` | **Major** | the app declares no reachable address, so nothing can use it |
| `zero-config` | **Major** | reaching a usable state needs a shell or a file edit, which the store promises it does not |
| `clean-boot` | **Minor** | first-party errors that do not break a primary function |
| `session` | *no severity* | a session that cannot be established is `errored` infra, never a fault of the app |
| `migration` | *no severity* | permanently `n-a` here |

**Then raise or lower it, and say why in the note.** The defaults are the common case, not a
lookup table to hide behind:

- **Raise to Critical** when a Major-by-default failure turns out to lose data or expose
  something — `zero-config` that only completes by putting a credential in a world-readable
  place, a `clean-boot` error that is a stack trace with a secret in it.
- **Lower to Minor** when a Major-by-default failure is cosmetic in effect — a broken link in a
  part of the UI nothing depends on, an install that succeeds on retry and says why.
- **Never lower `auth-gate` or `data-persistence`.** If you believe one deserves less, what you
  have is a `pass` with a caveat or an `n-a`, and the argument belongs in the prose where a
  human will read it.

Severity describes the **failure**, not the app: three Minors are not a Major, and a Critical is
not made less critical by everything else passing.

## 5. Gate

Every requirement except `migration` is mandatory and must `pass` for the app to be functional.
Any mandatory `fail` makes the app non-compliant, and a Critical does so unconditionally (§4).
Any mandatory `errored` or missing result makes the **audit** errored and retried — that is a
statement about the environment, never a verdict about the app. Record the requirements; the
caller applies this.

## 6. Determinism

- "Same sequence for every app" means the same ordered steps and the same pass criteria. Per-app
  variation — the store card, `APP_URL`, the specific auth UI — is **discovered at runtime**,
  never branched on.
- Absorb UI differences by evaluating the generic assertions of `works-immediately`, `auth-gate`
  and `clean-boot`, not by hunting for selectors you saw last time.
- One `isolatedContext` per run. The caller serialises the demo instances so two runs cannot
  collide on one.
- **Resilience with no escape hatch.** If the browser session becomes unrecoverable, do not
  abort and do not reach for a human: record the steps you reached, mark the rest `errored`,
  write up what you have. Infra is the caller's problem to retry.

## 7. Cleanup — two halves

Uninstalling is no longer enough to leave the box as found, because the uninstall itself creates
an archive.

1. Uninstall `APP` from the demo host.
2. **Delete every archive this run produced** — from the app's own **Backups** tab, or
   **Settings → Backups** (`/settings/backups`), where an uninstalled app's archives are listed
   and marked `uninstalled`.

An archive left behind turns the *next* run's `install` into a restore prompt. That is how
one run's untidiness becomes another run's false result.
