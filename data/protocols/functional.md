---
id: functional
name: Functional Review Protocol
version: 5
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

## 3. Phase plan (identical for every app)

**A — Session**

1. `new_page` → `https://<DEMO>/` in a fresh isolated context. The bare host opens the Maison
   dashboard directly; `https://maison-<DEMO>/` is the same page.
2. The gate is the **platform SSO**, not a dashboard account. Take whichever route the login
   page offers — *Log in with Yundera* (the `LOGIN` credentials) or *Local Account* — then
   `wait_for` `["App Store", "System status"]`, the dashboard's own markers. A **Getting
   Started** wizard at `admin-<DEMO>` means the box has never been set up: infra → `errored`.

**C — Fresh install**

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
16. **Reinstall from that archive.** Back in the store, click **Install**, let the picker open,
    and choose the newest row under **Restore from backup** (each row carries its date).
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
