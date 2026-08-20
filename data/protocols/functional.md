---
id: functional
name: Functional Review Protocol
version: 3
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
  # §3 names them and the 2026-07-07 amendment makes every one mandatory — so the list is
  # authoritative rather than a mapping aid.
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
imported_from: docmost:7HxjTwe63H
imported_at: 2026-08-19
---
> **Reusable leaf — output-neutral.** Source of truth for the *functional / runtime* checks of an AppStore app: install it on a demo PCS, drive a real browser, decide whether it actually works. Consumed by the **AppStore PR Review** and **AppStore App Audit** orchestrators, which own ALL formatting, labels, and publishing. **Do not put GitHub labels, comment templates, or Docmost wiring here.** The *static / compose* checks live in the **Static Review Protocol** (`static`). Per-app hints: **Functional QA — App KB** (`NeFOTSJPGH`).
> **Status: VALIDATED end-to-end** (Immich incl. Phases F/G; Jellyfin depth=full e2e) on the CDP-based `browser-mcp` — the old instability cap is resolved. Renamed from “Functional Bot — Operating Protocol” on 2026-06-25 as part of the protocol-decomposition refactor.

---

# Functional Review Protocol

> **One input: an app name. One fixed phase sequence, identical for every app**, deriving everything app-specific at runtime (never hardcoded). This protocol **returns a neutral verdict + evidence to its caller** — it does not post comments, set labels, or write pages. The orchestrator does that.

## 1. Purpose & hard rule

Decide whether an app is **“functional”** per the repo's `CONTRIBUTING.md` Functionality checklist, by installing and exercising it live. **Hard rule:** report a verdict; never merge/approve — a human keeps the merge button.

## 2. Inputs & conventions

| Param | Meaning | Example |
| --- | --- | --- |
| `APP` | App display name **exactly as in the store** | `Filebrowser` |
| `DEMO` | Demo PCS host. The dashboard answers on the **bare host** and on `maison-<DEMO>` | `demostaging1.inojob.com` (or `demostaging2…`) |
| `LOGIN` | **Platform SSO** credentials — Maison has no login of its own (§2a) | `demo` / `demodemo` |
| `PRIOR_VERSION` *(opt)* | A previous, installable version for the **migration** phase (G′). Provided only by the PR orchestrator on a version bump; absent for audits. |  |

**Derived at runtime (never hardcode):** `APP_URL` — discovered in Phase D. Fallback only: `https://<slug>-<DEMO>/`, `slug` = lowercased `APP`, spaces removed.

**Engine:** all browser steps via Beacon → `browser-mcp` (Chrome CDP). Each run uses its **own** `isolatedContext: "functional-<APP>-<runid>"`. Prefer `take_snapshot` (uid-based) clicks; use a **real **`click`** on a uid** for store/app tiles — synthetic JS clicks do NOT fire the framework's handlers. Screenshot every PASS/FAIL as evidence.

## 2a. The dashboard is Maison, not CasaOS

The demo PCS runs **Maison**, the dashboard that replaced CasaOS. It looks and works like
CasaOS — same app grid, same tiles, same App Store — and the on-disk app layout is unchanged,
so nothing in the *rubric* moves. Four things this protocol drives do move, and each is
written into the phase that touches it:

| | Was (CasaOS) | Is (Maison) |
| --- | --- | --- |
| **Where the dashboard lives** | `casaos-<DEMO>` | `maison-<DEMO>`, **and the bare `<DEMO>`** |
| **Who asks for the password** | CasaOS's own accounts | the **platform SSO**, one sign-in for the dashboard, the admin page and every protected app, valid **30 days** |
| **Reaching the store** | a tile that opens an in-page modal | a **route** — `/store`, `/store/<app-id>` |
| **What uninstall does** | removed the app; "keep data" left the folder | **always archives** the whole folder, never deletes — so a plain reinstall lands on a clean slate (Phase G) |

Gone with CasaOS, and never a reason to fail an app: the **Files** app, the built-in
**terminal**, disk/RAID and Samba management, the global search bar, and the manual
"install a customised app" form (stacks are discovered automatically now). If a phase
seems to need one of those, the phase is being read wrong.

## 3. The fixed phase plan (identical for every app)

**Phase A — Session**

1. `new_page` → `https://<DEMO>/` in a fresh isolated context. The bare host opens the Maison dashboard directly; `https://maison-<DEMO>/` is the same page.
2. The gate in front of it is the **platform SSO**, not a dashboard account. Take whichever route the login page offers — **Log in with Yundera** (the `LOGIN` credentials) or **Local Account** — then `wait_for` `["App Store","System status"]`, the dashboard's own markers. A **Getting Started** wizard at `admin-<DEMO>` means the box has never been set up: that is infra → `errored`, not an app fault.
**Phase C — Fresh install**
3. Open the store by **navigating to **`https://<DEMO>/store`. It is a real route — no tile to hunt for, no modal to prise open. `https://<DEMO>/store/<app-id>` opens one app's detail page directly.
4. `take_snapshot` → find the card whose heading `== APP` → click its **“Install”** pill. The search box matches **name, tagline and category**, so confirm the heading matches `APP` exactly rather than taking the first hit.
5. ⚠️ **The backup picker.** If the box already holds an archive of `APP`, the Install click opens a **menu** instead of installing: **“Fresh install”** at the top, then **“Restore from backup”** with one row per archive. Phase C is the *fresh* install — click **“Fresh install”**. Phase G is the only place an archive row is ever chosen. With no archives present the click installs straight away and no menu appears.
6. Optional **Tips** dialog — capture any URLs/paths it shows. Maison also keeps it on the tile's menu under **Tips**.
7. Watch the **single progress bar** on the tile (and on the store's install pill): **Download** (blue, real per-layer pull progress), then **Start** (green). Progress rides the live app list, so it keeps advancing after the store panel is closed — closing the panel is not "continue in background", it is just closing a panel. ✅ **Install PASS** when the tile settles with an **Open** action and no error. Record duration.
8. A **failed install stays visible** as a red `!` on the tile, the error in its tooltip; it does not vanish. Read that tooltip before concluding anything — it is the install's own diagnosis, and it is evidence.

**Phase D — Discover app URL**
9. `APP_URL` by priority: (a) the tile's **Open** action — the URL Maison built from `x-compose-app.webui-host`/`webui-path`, or the `x-casaos` fallback — read back via `list_pages`; else (b) the Tips URL; else (c) the fallback formula. A tile offering **no reachable address** instead of an Open action means the app declares no resolvable web UI: record that, and fall back to the formula before calling the app broken.

**Phase E — Runtime checks (core gate)** — open `APP_URL` in the same context, assert **generically**:
10. **Works immediately** — renders a real UI within a bounded `wait_for`; not an error page, not an endless spinner, no “run this command / check logs / edit config” prerequisite.
11. **Auth enabled** *(mandatory)* — a login/registration form is present, OR a protected path redirects to an auth route. No auth → `FAIL` unless `rationale.md` documents a public exception (→ `SKIP` w/ note). ⚠️ **One sign-in now covers the dashboard, the admin page and every protected app for 30 days**, so the session Phase A established carries straight into `APP_URL`. An app that opens on its content *because this run is already signed in* has proved nothing about its own gate. The per-run isolated context and the profile-less browser exist for exactly this; when in doubt, re-open the same path in a second fresh context that has never signed in.
12. **Clean boot** — `list_console_messages(error)` ≈ 0 first-party; no first-party `5xx` in `list_network_requests`. Breaches → warning / `NEEDS_HUMAN`.
13. Screenshot.

**Phase F — Zero-config usability** *(optional deep)* — complete the obvious in-UI setup (e.g. create admin) to a usable screen **purely in-browser** → PASS “no manual config”; needs files/commands → FAIL.

**Phase G — Data persistence** — **on Maison an uninstall never deletes, it archives.** There is no "keep data" option to tick, and no plain reinstall that finds the old data still in place. The phase is therefore:

14. Create state in the app (account / item / `upload_file`) and write down exactly what to look for afterwards.
15. **Uninstall.** The confirm dialog says the folder is renamed to `<app>.<date>.archive` under `AppData/`, and offers **“Compress the archive to a **`.zip`**”** — leave it **off**: a rename is instant, a zip is a full second copy and can take minutes. The tile shows the same single bar in red: **Remove**, then **Archive**.
16. **Reinstall from that archive.** Back in the store, click **Install** → the picker opens → choose the newest row under **“Restore from backup”** (each row carries its date). Choosing **“Fresh install”** here lands on a clean slate and tests nothing.
17. Assert the state from 14 survived.

**What this proves, and why it is still the right test.** An archive carries the *whole* app folder — compose, override, `.env` and the data under `AppData/<app>/` — so a state location the app keeps **outside** its mapped volumes is not in the archive and does not come back. That is precisely the fault the phase was written to catch (the runtime counterpart of the Static leaf's §B persistence check), and it now catches it along the path a real user takes. A restore that comes back empty is a `fail` **against the app**, not against Maison.

**Phase G′ — Migration** *(conditional — only when *`PRIOR_VERSION`* is supplied)* — install `PRIOR_VERSION`, seed state, **upgrade to the target version**, assert data + functionality survive. Skipped entirely when no prior version is provided (e.g. audits run a single current version).

**Phase H — Verdict & cleanup**
18. Aggregate → neutral verdict (§4) + evidence (screenshots, per-phase results). **Return it to the caller** — do not post or archive it yourself.
19. **Cleanup (mandatory on every exit path, incl. failure):** uninstall `APP` (and any `PRIOR_VERSION`) — **and then delete the archives this run left behind**, from the app's **Backups** tab or **Settings → Backups**, where an uninstalled app's archives are listed and marked `uninstalled`. Uninstalling alone no longer leaves the instance as found: it leaves every archive the run created on the demo box's data disk, and the next run's Install click opens a backup picker because of it.

## 4. Verdict rubric (neutral)

- **not-functional** — any Phase-E failure (won't open / needs terminal steps / no auth & no documented exception).
- **needs-changes** — runtime OK, but the caller's static result has a failing item (the orchestrator supplies this; this leaf flags runtime-OK-with-caveat).
- **needs-human** — anything not conclusively determinable (ambiguous auth, threshold console errors, install timeout, unrecoverable browser session); attach screenshots.
- **functional** — all applicable checks PASS.
Return: `{ functional_verdict, phases: [{phase, result, note}], evidence: [...], install_seconds }`.

## 5. Worked example — `APP = "Immich"` (reference run, 2026-06-16, **on CasaOS**)

> Kept because the *shape* of a run is unchanged. Two steps below are pre-Maison and read
> differently today: the App Store is reached by navigating to `/store` rather than clicking a
> tile into a modal, and there is no “Tips dialog → Next Steps” step in the install path.

| Phase | Result |
| --- | --- |
| A | Logged into `demostaging1`, dashboard reached. |
| C | App Store tile (figure) → modal → **Immich** → Install → **Tips** dialog (gave `https://immich-demostaging1.inojob.com/`, import `/DATA/Gallery/`) → Next Steps → 0→100% → **“Open Immich”** tile. |
| D | `APP_URL = https://immich-demostaging1.inojob.com/`. |
| E8 | Loads to **“Welcome to Immich”** — no error/spinner/terminal. ✅ |
| E9 | **Auth gate ✅** — `/photos` redirected to `/auth/register`. |
| E10 | Console errors: **0**. ✅ |
| **Verdict** | **functional** on all browser-checkable criteria. |

## 6. Determinism & resilience

- “Same plan for every app” = same ordered phases + same pass criteria. Per-app variation (store card, `APP_URL`, the specific auth UI) is **discovered at runtime**, never branched.
- The agent absorbs UI differences by evaluating the **generic Phase-E assertions** rather than fixed selectors.
- One `isolatedContext` per run; the orchestrator reserves/serialises the two demo instances so parallel runs don't collide.
- **Resilience:** if the browser session becomes unrecoverable, do NOT abort — return whatever evidence was gathered with `functional_verdict = needs-human`. The orchestrator decides what to publish.

---

### Tip — reaching the store on Maison

**The synthetic-pointer-event technique is obsolete and must not be used.** It existed because
CasaOS's App Store tile was a non-anchor card with `href=null` and no route, so an a11y `click`
on it was a no-op and the modal had to be prised open with a hand-dispatched
`pointerdown→mousedown→pointerup→mouseup→click`. Maison has none of that: the store is a real
route.

- `https://<DEMO>/store` — the catalog.
- `https://<DEMO>/store/<app-id>` — one app's detail page, straight in. `<app-id>` is the compose
  project `name`, i.e. the lowercase slug, not the display title.
- `https://<DEMO>/settings/backups` — the box-wide archive list, for the Phase H cleanup.

Navigating there is more reliable than clicking, and it survives the dashboard being slow to
paint. The store panel is fully in the a11y tree, so the search box and every Install pill are
uids. Two caveats that do survive: the search matches **name, tagline and category** (not the
title alone), so install the app whose heading **exactly** matches `APP` rather than the first
result — and an Install click on an app with existing archives opens the backup picker instead
of installing (Phase C.5).

---

## Amendment — strict full-run (2026-07-07) — BINDING, supersedes §3/§4 where they conflict

**Why:** audits were declaring apps `functional` while Phases F/G were skipped as "optional deep / economical", so the highest-consequence checks (zero-config, data persistence) were never exercised. That license is removed.

1. **No optional phases.** Phases **F (zero-config usability)** and **G (data persistence)** are **mandatory** on every functional run, exactly like A/C/D/E/H. Every "optional deep", "economise on browser calls", "not attempted", "at your discretion" phrase above is void as a license to skip.
2. **Phase G is a real reinstall.** Create state → uninstall (keep data) → reinstall → assert state survived. **Cost/duration is not a reason to skip**; the harness must budget enough time (orchestrator `__beacon_timeout`) for the reinstall to complete rather than time out.
3. **Per-phase result is exactly one of **`pass`** / **`fail`** / **`errored`**.** There is **no **`skipped`** / **`not-attempted`** value** — it is inexpressible. If a phase cannot run because infra failed (host 502, browser session unrecoverable) mark it `errored` and the orchestrator retries the whole audit. The agent may never *choose* not to run a phase.
4. `n-a`** is allowed ONLY for a deterministic, input-forced condition, never a choice.** The sole current n-a case is **Phase G′ (migration) when no **`PRIOR_VERSION`** exists** — there is genuinely nothing to migrate from. "Skipped to save time" is not `n-a`; it is a protocol violation.
5. **Return schema:** `phases: [{ phase, result: pass|fail|errored, note }]` (G′ may be `n-a` only when `PRIOR_VERSION` is absent). `functional_verdict = functional` **requires every mandatory phase = **`pass`.
6. **Verdict mapping:** any mandatory phase `fail` → `not-functional`; any mandatory phase `errored` (or missing) → the audit is `errored` (retry), **not** a verdict; all `pass` → `functional`. `needs-human` survives only for genuinely ambiguous *observations* (e.g. threshold console errors) — **never** as a substitute for running a phase.
---

## Amendment — demo host selection (2026-07-17) — BINDING, supersedes §2 and §6 where they conflict

**Why:** `DEMO` was treated as a fixed host (`demostaging1.inojob.com`, baked into the App Audit `Build prompt` node). The demo PCS instances are **wiped on a daily cleanup cycle**, and an instance that is mid-cleanup still serves a login page while silently failing to install. Audits pointed at it reported "the install phase was never reachable" and were recorded as `errored` **against the app** — a false negative that says nothing about the app. Observed 2026-07-17: `demostaging1` sat in `🔄 Processing` while `demostaging2` was `✅ Ready`.

1. `DEMO`** is selected at runtime, never hardcoded.** Before Phase A, open the **Demo Management** board — [https://app.nasselle.com/demo/admin/manage](https://app.nasselle.com/demo/admin/manage) — via `browser-mcp` and read the instance cards. Each card carries: host, **status**, URL, User ID, **Next Cleanup**, **Time Remaining**, Last Cleanup.
2. **Only a **`✅ Ready`** instance may be used.** An instance showing `🔄 Processing` is mid-cleanup and is **not usable**, regardless of whether its login page responds.
3. **Respect **`Time Remaining`**.** Among Ready instances pick the one with the **most** time remaining, and require **> 1h** — a full run (incl. the Phase G uninstall→reinstall) must finish before the daily cleanup wipes it mid-audit. A Ready instance with ≤ 1h left does not qualify.
4. **If no instance qualifies**, mark the functional phases `errored` with note `no-demo-available` and return. This is an **infra** condition, not an app fault — the caller retries; it must not be recorded as a verdict about the app.
5. **Never click **`🧹 Trigger Cleanup`**.** It resets a shared instance that another run may be using. The cleanup obligation is unchanged: §3 Phase H.15 — uninstall the app *you* installed.
6. **Report the host used.** Name the selected instance in the evidence/notes so a failed run can be traced back to the instance it ran on.
> The pool is still the two `demostaging*.inojob.com` instances, so §6's serialisation note still applies — but the board, not this page, is the source of truth for which one is usable right now.

---

## Local amendment — Touchstone (2026-08-19) — BINDING, supersedes §2 and the demo-host amendment

**The caller supplies the host and the browser; the agent chooses neither.**

1. `DEMO` is given in the prompt. Touchstone probes each instance's login flow end to end
   before dispatching, which the management board does not — on 2026-08-19 the board reported
   an instance `✅ Ready` while its login gate answered HTTP 500, and the "pick the most Time
   Remaining" rule preferred exactly that one. **Do not open the board and do not substitute a
   different instance.** If the supplied host does not work, mark the phases `errored`; that is
   infra, and the caller retries.
2. The **browser** is likewise supplied: a sidecar leased to this run alone. Do not use a
   shared browser — its tabs belong to other work, and a tab stolen mid-install is recorded
   against the app.
3. The runway rule survives in the caller: an instance with less than an hour before its daily
   cleanup is never dispatched, so a run is not wiped mid-Phase-G.

---

## Amendment — Maison replaces CasaOS (2026-08-20) — BINDING, supersedes §3, §5 and the demo-host amendment where they conflict

**Why:** the demo PCS no longer runs CasaOS. It runs **Maison**, a from-scratch dashboard with
the same app grid, the same tiles and the same store format — but a different front door, a
different way in, and a genuinely different uninstall. The body above has been brought into
line; this amendment states the parts that are *policy* rather than mechanics, so they bind
even if an older copy of the body is read.

1. **The rubric does not change.** Maison consumes the unmodified store format, the on-disk app
   layout is the same, and `CONTRIBUTING.md` is still the source of truth. Nothing about which
   apps pass moves because the dashboard was replaced. In particular, the features CasaOS had
   and Maison dropped — Files, terminal, disk/RAID, Samba, the custom-app form — are **never**
   a finding against an app.

2. **Never fail an app for a Maison behaviour.** A backup picker where an install used to be, an
   archive left over from an earlier run, a tile marked `unmanaged`, an app in the **System**
   grid that refuses Stop and Uninstall — these are the platform, not the subject. A phase that
   cannot proceed because of one is `errored` (infra, retried by the caller), never `fail`.

3. **Phase G tests the archive path.** Uninstall always archives and never deletes, so the old
   "uninstall keep-data, then reinstall" sequence no longer exists and a plain reinstall proves
   nothing. The mandatory sequence is: seed state → uninstall (archive, **not** zipped) →
   Install → **Restore from backup** → assert the state came back. It still fails the app when
   state does not survive, for the same reason as before: an archive carries the whole app
   folder, so anything the app keeps outside its mapped volumes is not in it.

4. **Cleanup now has two halves.** Uninstalling is no longer enough to leave the box as found —
   the uninstall itself creates an archive. Every archive this run produced must also be deleted
   (`/settings/backups`, or the app's own **Backups** tab). An archive left behind changes the
   *next* run's Phase C, which is how one run's untidiness becomes another run's false result.

5. **One session covers everything for 30 days.** The platform SSO signs the run into the
   dashboard, the admin page and every protected app at once. Phase E9 is therefore easier to
   fool than it was: an app that opens on its content may simply be riding this run's session.
   The per-run isolated context and the deliberately profile-less browser are the guard; a
   second, never-signed-in context is the tie-breaker.
