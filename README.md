# Touchstone

**A conformance agent.** Touchstone holds a versioned *standard*, runs *assays* against *subjects*,
and issues a *hallmark* — a verdict a subject carries until the next assay contradicts it.

Its first tenant is the [Yundera AppStore](https://github.com/Yundera/AppStore): every app in the
store is assayed against the store's contribution rules, statically (the compose file and its
metadata) and functionally (a real install on a demo instance, driven through a browser).

> A touchstone is the stone you rub gold against to judge its purity from the streak it leaves.
> It is also the ordinary word for *a standard by which something is judged*. The app is both the
> instrument and the keeper of the standard — which is exactly its central table.

---

## What it replaces

Touchstone was not a new idea. The job was already being done, correctly, by two workflows on
`yunderalabs` that had audited 69 apps:

| Workflow | Role |
| --- | --- |
| `AppStore Continuous Store QA Loop` | hourly tick — derives the backlog, claims one app, records the result |
| `AppStore App Audit` | builds the prompt, calls Claude Code, publishes the report |

**Touchstone was written to absorb those two and nothing else**, and it has: it runs the loop now.
PR review and release notes were never in scope and are somebody else's.

That constraint was the project's organising rule, and the capability inventory it produced —
[docs/architecture.md §1.4](docs/architecture.md#14-capability-inventory-and-parity-matrix) — is
still the record of what the replacement had to cover, and of what was deliberately left out.

## Why it is worth replacing

The audits are good. Four things around them are not.

**1. The database is a wiki page.** State lives in a Docmost table, read back with a
six-capture-group regex, with retry counters parsed out of strings like `⚠️ errored · try 2` and
lease expiry parsed out of `since 2026-08-06T07:00Z`. Emoji are load-bearing. Adding a field means
touching two regexes.

**2. One assay conflates two independent verdicts.** Static and functional are two protocols
producing two results, collapsed into one headline. A mandatory functional phase that errors can
never yield `compliant`, so a bench outage overrides a complete and correct static result.

**3. Infra failure is recorded as app failure.** On 2026-08-05 the demo instance pool began
rejecting every credential. The loop has no preflight, so it kept claiming targets and burning
retry budget on a condition that had nothing to do with any app:

| | ✅ compliant | ⛔ non-compliant | ⚠️ errored | parked as stuck |
| --- | --- | --- | --- | --- |
| **2026-08-06** | 1 | 19 | 49 | 12 |
| **2026-08-07** | 0 | 15 | **54** | **13** |

It is not a historical incident. It compounds hourly, and it is still compounding. A twenty-line
login preflight would stop it today, independent of this project — see
[docs/architecture.md §9](docs/architecture.md#9-phases).

**4. The browser is shared, and it is contended.** Three consecutive reports independently record
another audit stealing page selection mid-run. Two assays sharing one browser is a correctness
hazard, not a nuisance: an assay can act on another assay's page and record the result as its own.

## What it does

Two independent legs, run as separate assays against separate standards:

- **Static** — reads the compose file and its metadata against the contribution rules. Needs no
  demo instance and no browser. Cheap.
- **Functional** — installs the app on a leased demo instance and drives it through a private
  browser: does it come up, is there an auth gate, does it boot clean, does data survive an
  uninstall-keep-data → reinstall cycle. Expensive; bounded by the bench pool.

A subject's hallmark composes the two. Either leg can be blocked or deferred without invalidating
the other.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **subject** | the thing being judged — an AppStore app |
| **standard** | a versioned rubric; the static and functional protocols are two standards |
| **assay** | one run of one standard against one subject |
| **hallmark** | the verdict a subject carries: compliant, or non-compliant at a severity |
| **bench** | a leasable demo instance the functional leg installs onto |
| **alert** | a deduplicated environment condition — one outage is one alert |

---

## Status

**Phase 0 built. Phases 1 and 2 designed.** Nothing has been retired yet.

| Phase | Deliverable | Retires |
| --- | --- | --- |
| **0** ✅ | report files, in-memory index, read API, Overview + Subject detail | Docmost as a *reader* |
| **1** ✅ | scheduler, registry, lease, tries, parking, bench preflight, log + alerts + push | the QA Loop workflow |
| **2** ✅ | runner, agent call, busy retry, browser sidecars, `(bench, browser)` leasing | the App Audit workflow |

- [docs/architecture.md](docs/architecture.md) — the capability inventory, the domain model, decisions and rationale
- [docs/requirements.md](docs/requirements.md) — what the operator asked for **beyond** parity, and its status
- [UX.md](UX.md) — the pages and their degraded states

Phase 0 was scoped before the parity rule and built some things that are not in the product —
findings-as-rows, the Findings page, history and regression detection. Those were removed, and
[docs/architecture.md §1.4 G](docs/architecture.md) records what went and why.

## Testing a build before it is tagged

The AppStore entry pins an exact version — `ghcr.io/worph/touchstone:1.1.0`, never `latest`, because
a store app that floats would change under an operator between two identical installs. That image
only exists once a `v*` tag is pushed and `docker-publish.yml` has built it, so the normal release
order is **tag, then bump the store entry**.

That order is wrong when the point is to *look at* the build first. Pushing a tag to see whether a
feature works publishes an image to a public registry and burns a version number on the answer
being "no". To try a build on a real box without tagging anything, ship the image over SSH instead:

```bash
# 1. Build for the box's architecture. `docker build` produces a SINGLE arch — fine for one
#    machine, never for the store, which requires amd64 *and* arm64 (hence the buildx/QEMU
#    steps in the workflow). Check with `ssh <box> uname -m`.
docker build -f deploy/Dockerfile -t ghcr.io/worph/touchstone:1.1.0-rc1 .

# 2. Send it. There is no registry in the middle, so this is a stream, not an scp of a file:
#    ~450 MB uncompressed, roughly 95 MB over the wire.
docker save ghcr.io/worph/touchstone:1.1.0-rc1 | gzip -1 | \
  ssh admin@<box> 'gunzip | docker load'

# 3. On the box: keep a copy you can put back, then point the compose at the loaded tag.
ssh admin@<box>
C=/DATA/AppData/casaos/apps/touchstone/docker-compose.yml
sudo cp "$C" "$C.bak-pre-rc1"
sudo sed -i 's|touchstone:1\.1\.0|touchstone:1.1.0-rc1|' "$C"

# 4. Bring it up — and supply PUID/PGID/TZ yourself. See the warning below; without them
#    `user: $PUID:$PGID` expands to `:` and the container starts as the wrong user or not
#    at all. 1000:1000 is the PCS user; confirm with `docker inspect touchstone-backend
#    --format '{{.Config.User}} {{range .Config.Env}}{{println .}}{{end}}' | grep -E '^TZ='`.
sudo env PUID=1000 PGID=1000 TZ=Europe/Berlin docker compose -f "$C" up -d
```

Five things to know about a box in this state:

- **⚠️ `$PUID`, `$PGID` and `$TZ` are not in any file Compose reads.** CasaOS substitutes them
  when *it* deploys an app, and `/DATA/AppData/casaos/.env` does not carry them — so a bare
  `docker compose up -d` run by hand silently resolves them to the empty string. Read the values
  off the running container before you touch anything, and pass them with `env` as above. This is
  the one step that fails quietly rather than loudly.

- **Do not run `docker compose pull` on it.** The `-rc` tag exists only in that box's local image
  store, so a pull fails to resolve it and can leave the stack half-updated. Use
  `up -d <service>` — Compose does not pull an image it already has.
- **Use a tag that cannot collide with a release.** `-rc1` and friends are never produced by
  `docker-publish.yml`, so nothing later overwrites what you are looking at, and nobody mistakes
  the box for running a shipped version. Never test under `latest`.
- **CasaOS owns that file.** Reinstalling or updating the app from the store rewrites it, which is
  also the clean way back: restore the released tag and `up -d` again.
- **Nothing about this reaches the store.** `Apps/Touchstone/docker-compose.yml` in AppStoreLab
  keeps pointing at the released version throughout; the `-rc` tag lives on one box and is
  deliberately not installable anywhere else.

When the build is approved, the normal order resumes — push `vX.Y.Z`, let CI build the multi-arch
image, then bump the store entry.

## Prior art in the house

Touchstone follows **Newsdesk**: a packaged app that owns the domain — data model, state, agent
invocation, UI, outlets — with n8n reduced to thin adapters. The packaging is copied wholesale:
AppShield sidecar for SSO, a single data dir, the `pcs` network for service-name access to Beacon,
unprivileged `1000:1000` runtime, a `beaconify` sidecar for the admin surface, and its own
`browser-mcp` container rather than the shared box-wide one.

The notification design is copied too — an authoritative local event log, best-effort Beacon
outlets, and web push — including the rule that the app must stay fully diagnosable with every
outbound port broken.

The one deliberate divergence is the browser profile: Newsdesk's persists, Touchstone's is
discarded between assays, because a surviving session cookie would make an unprotected app look
protected on the one check that catches auth bypass. See
[docs/architecture.md §5.4](docs/architecture.md#54-bench-and-browser-leasing).

## Non-goals

- **Not a CI runner.** Touchstone judges conformance to a standard; it does not run the subject's
  own test suite.
- **Not a PR gate.** PR review is a different workflow and was never in scope.
- **Not a findings database.** Findings are prose inside the report, as they are today. Rule codes,
  cross-subject aggregation and regression detection were designed and are deliberately dropped —
  [docs/architecture.md §1.4 G](docs/architecture.md#g-deliberately-dropped).
- **Not a general web crawler.** The browser exists to install and exercise apps on a bench, and its
  profile is thrown away between assays.
