---
id: orchestrator
name: AppStore App Audit — Orchestrator
version: 1
kind: orchestrator
imported_from: docmost:In2NAGjv0h
imported_at: 2026-08-19
---
> **Orchestrator — manual trigger.** Audits an app **already live** in an AppStore repo (no PR, no diff). Thin: it composes the two reusable leaves and owns where the result goes. Leaves: **Static Review Protocol** (`static`) and **Functional Review Protocol** (`functional`). Sibling orchestrator: **AppStore PR Review** (`fqwevKQFaL`). Last updated 2026-07-06.

# AppStore App Audit — Orchestrator

## Trigger & input

Standalone n8n workflow `AppStore App Audit (manual, form-triggered)` (`QjzNu9yWZ5005J7m`) — form trigger **or** `POST /webhook/app-audit`:

- `app_name` — free text; the exact app directory name.
- `repo` — defaults to `Yundera/AppStore`.
- `depth` — `static` (Static leaf only) | `full` (adds the Functional leaf).
- `dry_run` — default **on**: write a **draft** report, never the canonical page.
## Subject resolution

Validate `app_name` against `gh api repos/<repo>/contents/Apps` (`.[].name`). Not a real app dir → return `{ error: "not-an-app", app_name }` and stop. Otherwise the subject is `Apps/<app_name>/docker-compose.yml@main` — no diff, no base/head.

## Compose & run the leaves

1. **Static Review Protocol** (`static`) — always. Inputs: `compose_head = main`, **no **`compose_base` (so `scope = n-a`; scope detection is meaningless without a diff). Returns the neutral static result.
2. **Functional Review Protocol** (`functional`) — only when `depth = full`. Inputs: `APP = app_name`, `DEMO = demostaging1.inojob.com`. **No **`PRIOR_VERSION` → Phase G′ (migration) is skipped (single current version). Mandatory cleanup uninstalls what it installed.
## Map results → audit report

The orchestrator folds the two leaves into ONE headline verdict:

- App is functional AND every applicable CONTRIBUTING.md checklist item passes → **compliant**.
- Any applicable checklist item fails, and/or the app is not functional → **non-compliant** (list the specific failing items in the report body).
**Verdict policy (updated 2026-07-06):** the audit reports exactly one of **compliant / non-compliant** (or **errored** if it could not run). We are matching the repo guidelines + checklist, so **compliant** (which includes being functional) vs **non-compliant** is the framing — not functional/not-functional. There is **no **`needs-changes` value (a non-compliant app implicitly needs changes) and **no **`human-review` value: the agent commits to its opinion and the human decides what to do from the report. There is no “ask for human action” step. Use `errored` only when the audit could not be run at all (install or browser session failed irrecoverably) — a retry state, not a request for a human decision.

Report body = the shared review template (Tech & Documentation static section + Functionality section with the real Phase C/E/F/G results), minus PR-only lines, plus a header: **audit date · current store version · compose sha**. Cross-link the app's **App KB** fixture (`NeFOTSJPGH`) and bump its “last verified” date.

## Output (the only orchestrator branch)

- **Report tree:** **App Audits** (`wyi3Hb1MOx`). One page per app, **find-or-update by deterministic title** `<repo> — <app>` (em-dash), e.g. `Yundera/AppStore — Filebrowser`. `move_page` is broken in the MCP → set the parent at create time and match by title on re-runs; never create duplicates.
- `dry_run = on` → write to `<repo> — <app> (draft)` instead of the canonical page.
- No GitHub labels / `reco:` apply (no PR) — the report headline verdict carries it.
- Then forward the short summary + page link to Nextcloud Talk.
## Wiring constants (live)

- **Leaves:** Static `static` · Functional `functional`.
- **Report parent:** App Audits `wyi3Hb1MOx`; space UUID `019eb26c-dfac-7c35-ac4e-068b1ec18663`.
- **Agent engine:** Beacon `claude-code__query_claude` at **internal** `http://beacon:9300/mcp` (`__beacon_timeout: 14400`); docmost-mcp + browser-mcp reached via `mcp__beacon__call`. Never hardcode `beacon-*.nsl.sh/mcp?hash=` in a node — the hash rotates on every beacon reinstall.
- **Title scheme:** `<repo> — <app>` with an em-dash, matching the PR Reviews tree.
- **Verdict set:** `compliant` · `non-compliant` · `errored` (retry). **No** functional/not-functional, **no** needs-changes, **no** human-review.
- **Weekly roll-up:** the **Weekly Store QA Sweep** (`uEmep2z22i5qv1OF`) loops this workflow over every store app and records each verdict in **Weekly Store QA — Results** (`B5ZBicxRSn`).
---

## Amendment — verdict gate + risk score (2026-07-07) — BINDING, supersedes "Map results → audit report"

### A. `depth=full` runs ALL functional phases

including F (zero-config) and G (persistence). There is no partial functional pass. `depth=static` remains a legitimate operator scope, but it can **never** yield `compliant` — a static-only audit reports `static-pass (functional unverified)`, never `compliant`.

### B. Compliance gate (severity-gated, NOT score-gated)

1. Any finding `severity = Critical` → **NON-COMPLIANT**, unconditionally.
2. Else any `fail` (Major or Minor) or any `not-functional` phase → **NON-COMPLIANT**.
3. Else (functional AND every applicable item passes AND all mandatory phases ran) → **COMPLIANT**.
4. Any mandatory phase `errored`, or any mandatory result missing → **ERRORED** (retry); never `compliant`.
### C. Verdict label carries the top severity

`COMPLIANT` · `NON-COMPLIANT · Critical` · `NON-COMPLIANT · Major` · `NON-COMPLIANT · Minor` · `ERRORED`. The tier goes in the headline so the roll-up can triage — a takeover hole must never look like a missing `cpu_shares` field.

### D. Risk score (secondary — triage/trend ONLY, never decides pass/fail)

`score = 100·(#Critical fails) + 10·(#Major fails) + 1·(#Minor fails)`, higher = worse. Report it next to the label; record it in the Weekly roll-up for backlog ranking. It can never upgrade a Critical to a pass, and no pile of Minors can cross into Critical territory (weights are spaced so one Critical dominates any realistic Minor count).

### E. `errored` vs. rejected — the cause split (policy fork)

- **Infra genuinely blocked a phase** (host 502, browser dead) → **ERRORED**, retry; the app is not blamed.
- **Agent chose to skip a mandatory phase** (a skip slips past validation) → report **invalid** → cannot publish `compliant`; re-audit (if forced to a verdict, non-compliant).
This is the one open policy fork from the design discussion. If you prefer *any* missing result to stamp the app **non-compliant regardless of cause** (maximally strict, biased to false negatives over false positives), flip B4/E accordingly.

---

## Local amendment — Touchstone (2026-08-19) — BINDING, supersedes the Output and Wiring sections

This protocol used to live in Docmost and was fetched by the agent at run time. It is now a
local file that Touchstone reads, embeds in the prompt, and lets an operator edit. Three
consequences, and they override anything above that conflicts:

1. **Publish nothing.** There is no Docmost page, no App Audits tree, no roll-up table and no
   Talk message. The agent returns the JSON object described by the caller and stops.
   Touchstone writes the report to `data/reports/<app>/<timestamp>-<leg>.md` itself.
2. **Do not fetch the leaves.** The Static and Functional protocols are supplied inline in the
   same prompt. Do not attempt to read them, or any other page, from a wiki.
3. **Do not cross-link or update an App KB page.** That instruction assumed a wiki this
   installation does not have.

Everything else — the verdict gate, the severity tiers, the risk score, the phase rules — is
unchanged and still binding.
