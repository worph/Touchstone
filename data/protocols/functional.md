---
id: functional
name: Functional Review Protocol
version: 2
kind: leaf
leg: functional
requires_bench: true
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
    text: G — data survives uninstall-keep-data then reinstall
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
| `DEMO` | Demo PCS host | `demostaging1.inojob.com` (or `demostaging2…`) |
| `LOGIN` | Demo credentials | `demo` / `demodemo` |
| `PRIOR_VERSION` *(opt)* | A previous, installable version for the **migration** phase (G′). Provided only by the PR orchestrator on a version bump; absent for audits. |  |

**Derived at runtime (never hardcode):** `APP_URL` — discovered in Phase D. Fallback only: `https://<slug>-<DEMO>/`, `slug` = lowercased `APP`, spaces removed.

**Engine:** all browser steps via Beacon → `browser-mcp` (Chrome CDP). Each run uses its **own** `isolatedContext: "functional-<APP>-<runid>"`. Prefer `take_snapshot` (uid-based) clicks; use a **real **`click`** on a uid** for store/app tiles — synthetic JS clicks do NOT fire the Vue handlers. Screenshot every PASS/FAIL as evidence.

## 3. The fixed phase plan (identical for every app)

**Phase A — Session**

1. `new_page` → `https://<DEMO>/` in a fresh isolated context.
2. If a password field is present → `fill_form` `LOGIN` → click **Login** → `wait_for` `["System status","App Store"]`.
**Phase C — Fresh install**
3. Open the App Store: real-`click` the **App Store tile's icon **`figure` (in `.app-card`) → opens an **in-page modal**. ⚠️ Do NOT use **“Explore Apps”** — it opens the Yundera **blog** in a new tab (`close_page` it).
4. `take_snapshot` the modal → find the card whose heading `== APP` → click its **“Install”**.
5. Optional **“Tips / Setup Information”** dialog → click **“Next Steps”**; capture any URLs/paths it shows.
6. Wait for the **“Installing …”** progress modal (0→100%, mirrored by a dashboard widget); “Continue in background” + poll; **reload dashboard**. ✅ **Install PASS** when an **“Open …”** tile appears and no error. Record duration.

**Phase D — Discover app URL**
7. `APP_URL` by priority: (a) the Tips-dialog URL; else (b) open the **“Open …”** tile and read the new page/tab URL via `list_pages`; else (c) the fallback formula.

**Phase E — Runtime checks (core gate)** — open `APP_URL` in the same context, assert **generically**:
8. **Works immediately** — renders a real UI within a bounded `wait_for`; not an error page, not an endless spinner, no “run this command / check logs / edit config” prerequisite.
9. **Auth enabled** *(mandatory)* — a login/registration form is present, OR a protected path redirects to an auth route. No auth → `FAIL` unless `rationale.md` documents a public exception (→ `SKIP` w/ note).
10. **Clean boot** — `list_console_messages(error)` ≈ 0 first-party; no first-party `5xx` in `list_network_requests`. Breaches → warning / `NEEDS_HUMAN`.
11. Screenshot.

**Phase F — Zero-config usability** *(optional deep)* — complete the obvious in-UI setup (e.g. create admin) to a usable screen **purely in-browser** → PASS “no manual config”; needs files/commands → FAIL.

**Phase G — Data persistence** *(optional deep)* — create state (account/item/`upload_file`) → **uninstall (keep data)** → **reinstall** → assert state survived.

**Phase G′ — Migration** *(conditional — only when *`PRIOR_VERSION`* is supplied)* — install `PRIOR_VERSION`, seed state, **upgrade to the target version**, assert data + functionality survive. Skipped entirely when no prior version is provided (e.g. audits run a single current version).

**Phase H — Verdict & cleanup**
14. Aggregate → neutral verdict (§4) + evidence (screenshots, per-phase results). **Return it to the caller** — do not post or archive it yourself.
15. **Cleanup (mandatory on every exit path, incl. failure):** uninstall `APP` (and any `PRIOR_VERSION`) to leave the instance exactly as found.

## 4. Verdict rubric (neutral)

- **not-functional** — any Phase-E failure (won't open / needs terminal steps / no auth & no documented exception).
- **needs-changes** — runtime OK, but the caller's static result has a failing item (the orchestrator supplies this; this leaf flags runtime-OK-with-caveat).
- **needs-human** — anything not conclusively determinable (ambiguous auth, threshold console errors, install timeout, unrecoverable browser session); attach screenshots.
- **functional** — all applicable checks PASS.
Return: `{ functional_verdict, phases: [{phase, result, note}], evidence: [...], install_seconds }`.

## 5. Worked example — `APP = "Immich"` (reference run, 2026-06-16)

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

### Tip — opening the CasaOS App Store modal (use at your discretion)

If the App Store modal won't open or its tiles aren't addressable (the dashboard "App Store" tile is a non-anchor card with `href=null` and no route, so an a11y `click` on the label is a no-op), use the verified technique in **[CasaOS App Store — driving the install modal](https://docmost-yunderalabs.nsl.sh/s/general/p/ReXEiE7StT)**: dispatch a full `pointerdown→mousedown→pointerup→mouseup→click` sequence on the tile's `.tooltip-trigger` via `evaluate_script`. Once open, the modal is fully in the a11y tree (search box + every Install button become uids). Caveat: the store search matches **descriptions, not just titles** (and the Featured row always shows), so install the app whose `h6` heading **exactly** matches the name — not the first result.

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
