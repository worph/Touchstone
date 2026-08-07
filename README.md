# Touchstone

**A conformance agent.** Touchstone holds a versioned *standard*, runs *assays* against
*subjects*, records *findings*, and issues a *hallmark* — a verdict a subject carries until the
next assay contradicts it.

Its first tenant is the [Yundera AppStore](https://github.com/Yundera/AppStore): every app in the
store is assayed against the store's contribution rules, statically (the compose file and its
metadata) and functionally (a real install on a demo instance, driven through a browser).

> A touchstone is the stone you rub gold against to judge its purity from the streak it leaves.
> It is also the ordinary word for *a standard by which something is judged*. The app is both the
> instrument and the keeper of the standard — which is exactly its central table.

---

## Why it exists

The job is already being done, by an n8n workflow pair on `yunderalabs` that has audited 69 apps.
It works, and its core scheduling idea is right. But it keeps its state in a **Docmost wiki page**,
read back with a six-capture-group regex, with retry counters parsed out of strings like
`⚠️ errored · try 2` and lease expiry parsed out of `since 2026-08-06T07:00Z`. Emoji are
load-bearing.

That design has three consequences Touchstone exists to fix.

**1. There is no history.** The table holds one row per app, overwritten on every run. You cannot
ask whether store risk is rising, when an app first went critical, or — the event that matters
most — whether an app that was compliant has regressed.

**2. Findings are prose, so they cannot be aggregated.** `cpu_shares: 10` is the reserved
System-Background tier and is wrong on Radarr, Sonarr, Lidarr, Prowlarr *and* qBittorrent. One
report says so, in a sentence, in the middle of a page. Nobody can see it from the roll-up. As
rows, it is one `GROUP BY rule_id`.

**3. Infra failures are recorded as app failures.** On 2026-08-05 the demo instance pool began
rejecting every credential. Over the next two days the loop ran **49 audits that all failed at
phase A**, before anything was installed, burning retry budget and parking 12 apps as "stuck after
3 tries" for a reason that had nothing to do with them. The tally at the time of writing:

| ✅ compliant | ⛔ non-compliant | ⚠️ errored |
| --- | --- | --- |
| 1 | 19 | 49 |

Every one of those 49 completed its **static** leg and produced real, actionable findings — buried
under an `ERRORED` headline. Touchstone splits the legs so an unavailable bench pauses the
functional queue instead of poisoning the verdict.

---

## What it does

Two independent legs, run as separate assays against separate standards:

- **Static** — reads the compose file and its metadata against the contribution rules. Needs no
  demo instance and no browser. Cheap; runs on every commit that touches a subject.
- **Functional** — installs the app on a leased demo instance and drives it through a browser:
  does it come up, is there an auth gate, does it boot clean, does data survive an
  uninstall-keep-data → reinstall cycle. Expensive; runs weekly and on release.

A subject's hallmark composes the two. Either leg can be stale, deferred, or blocked without
invalidating the other.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **subject** | the thing being judged — an AppStore app, initially |
| **standard** | a versioned rubric; the static and functional protocols are two standards |
| **rule** | one checkable item within a standard, with a stable code |
| **assay** | one run of one standard against one subject |
| **finding** | one rule's result within an assay — `pass`, `fail`, `n-a`, `advisory`, `unverified` |
| **hallmark** | the verdict a subject carries: compliant, or non-compliant at a severity |
| **bench** | a leasable demo instance the functional leg installs onto |

The model is generic on purpose. `subject.kind` and the standards are pluggable; the AppStore is
the first tenant, not the schema.

---

## Status

**Design.** Nothing is built yet.

- [ARCHITECTURE.md](ARCHITECTURE.md) — domain model, components, decisions and rationale, phasing
- [UX.md](UX.md) — the web UI: pages, the incident/event split, reports as files
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — MVP scope, stack, schema, ingest contract, order of work

The existing n8n loop keeps running unchanged until phase 1, and its data is imported rather than
discarded — 69 table rows and ~55 report pages of real history are the first test of the schema.

## Prior art in the house

Touchstone follows the split that produced **Newsdesk**: n8n collapsed to thin source adapters
that do nothing but fetch on a timer and `POST` one payload, while the domain — data model, state,
agent invocation, UI, outlets — moved into a packaged app. Newsdesk's stringers are six nodes
each. Touchstone's adapters should be the same size.

The packaging is copied wholesale: AppShield sidecar for SSO, a single data dir, the
`pcs` network for service-name access to Beacon, unprivileged `1000:1000` runtime. The one
deliberate divergence is the browser profile — see
[ARCHITECTURE.md § Bench and browser leasing](ARCHITECTURE.md#bench-and-browser-leasing).

## Non-goals

- **Not a CI runner.** Touchstone judges conformance to a standard; it does not run the subject's
  own test suite.
- **Not a remediation daemon — yet.** Turning findings into pull requests is phase 4, and is
  deliberately gated behind having trustworthy findings first.
- **Not a general web crawler.** The browser exists to install and exercise apps on a bench, and
  its state is thrown away between assays.
