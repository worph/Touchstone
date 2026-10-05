# Touchstone — Automatic app pull requests (draft)

**Raised by the operator on 2026-10-02. Status: ✅ built the same day, all four phases — see requirements §24.**

Touchstone judges apps. This proposes that it also **repairs and adds** them: when it has
nothing to audit, it picks one piece of work (fix a non-compliant app, bring an outdated one
current, or integrate an app from an operator-written wishlist), develops the listing against a
live bench, validates it with the same rubric it judges everyone else by, and, if every scoring
section passes, opens **one pull request a day** on the AppStore from a bot account.

This is beyond parity and **reverses a deliberate drop**: `Findings → pull requests` is in
[architecture.md §1.4 G](architecture.md). It is the operator's call and it has been made;
this document says what it takes so that the reversal is a decision rather than drift. When it is
built, it gets a number in `requirements.md` (R17) and §1.4 G gets a note.

---

## 1. Decisions taken 2026-10-02

| # | Question | Answer |
| --- | --- | --- |
| D1 | Does the store team accept bot PRs? | Yes, the store team is us. Otherwise it is an ordinary PR. |
| D2 | How many? | **At most one PR opened per day.** Reviewing is manual and that is the capacity. |
| D3 | Which identity? | The **Mael** GitHub account, configured in Touchstone. |
| D4 | Push model | **A branch on the origin repo itself**, `touchstone/…`, with the PR opened from it. There is no fork. *Revised the same day:* fork-and-PR was the first answer, but it rules out fine-grained tokens (§4), and all that was wanted was to see the PR on GitHub. |
| D5 | Wishlist | **Operator only**, one file per item, processed one at a time, with a memory of when each was last tried and how it went. |
| D6 | Wishlist scope | **Integration only**: an existing Docker image becomes a store listing. Writing a new application is out of scope. |
| D7 | What counts as passing | **Every scoring section must be `compliant`**: `static`, `functional` (Yundera) and `functional@foss`. Readings (`currency`, `scores: false`) do not gate. |
| D8 | Commit author | **`Mael (Touchstone)`**, on Mael's account and noreply address. The person is accountable and the name says a machine wrote it. |
| D9 | Currency across major versions | **Yes, automatically**, as long as D7 passes. The validation trials are what make a major bump safe to propose, and the PR body flags it. |
| D10 | n8n `AppStore PR Review` | **Not touched.** It is out of scope here and will review the bot's PRs like anyone's. A second opinion is welcome. |
| D11 | Where it lives in the UI | **A Workshop page of its own**, *and* a place in the one Automation queue. Workshop work starts only when no audit request or trial is queued or running (§6.1). |
| D12 | Branch cleanup | **Touchstone deletes its own branches**, whether merged or closed. The repo-wide *Automatically delete head branches* setting is not turned on, because it would change behaviour for everyone's PRs to serve one bot's. |
| D13 | Label | **Every Touchstone PR carries `touchstone`**, and only Touchstone PRs do. |
| D14 | Org facts | Fine-grained tokens are **allowed**. `main` is **not protected** (§4.1 says what that means). |

---

## 2. Vocabulary

The rest of the codebase is careful with words, so this feature needs some too. These are
proposals; rename before building, not after.

- **proposal**: one candidate change to **one** app directory, on its way to becoming one PR.
  It has a **kind**: `fix`, `currency` or `wish`. One app per proposal and one proposal per PR,
  because a reviewer approves a PR as a whole.
- **wish**: one wishlist file, `data/wishlist/<name>.md`.
- **workshop**: the subsystem as a whole (selection, authoring session, validation, submission).
  A *workshop* makes things and the *touchstone* tests them, which is the separation §3 is about.
- **authoring session**: one agent run that edits a proposal's working copy against a bench.
  It is not an assay and it writes no report.
- **validation**: the trials run on a finished working copy. It is the only thing that can make
  a proposal `ready`.

---

## 3. The rule the design is built around: the workshop never judges its own work

Invariants 1 and 6 exist so that the rubric cannot become advisory. An agent that edits an app
and then re-runs the gate until it says *compliant* will learn to satisfy the auditor rather
than fix the app. Every protection below is **structural**, in the same way trials are kept out
of the hallmark:

1. **Validation is a trial, never an assay.** A proposal's verdicts are written under
   `data/trials/`, which the report index never reads. **Nothing the workshop does can move a
   hallmark.** A hallmark moves the normal way: a person merges the PR, the store offers the new
   compose (its blob sha changes), `subjectChanged` makes the app eligible again, and the
   ordinary loop audits it.
2. **The author cannot call the gate.** The authoring session's MCP surface (§6) has no
   `validate`, no `run_trial` and no `record_result`. It ends with `submit`, and Touchstone then
   queues the trials. The gate runs in **fresh agent sessions** that have no memory of the
   authoring work, which is already true of every trial.
3. **Touchstone opens PRs and never merges them.** The human merge is the real gate. The
   compliance report in the PR body is evidence for that person, not a verdict.
4. **The agent never holds the GitHub token.** The authoring agent runs in the claude-code
   container and edits the working copy only through Touchstone's callback surface. Touchstone
   alone talks to GitHub. The token never appears in a prompt, a tool result, a file the agent
   can read, or a command line.

Knowing the rubric is not the problem. A human developer reads `CONTRIBUTING.md` and the
standard too, so the author is given both, plus the KB. What is walled off is *producing* the
verdict.

---

## 4. The GitHub account: a fine-grained token, a branch on the origin repo

**Recommendation: a fine-grained personal access token on Mael's account, used from Node over
the GitHub REST API. No gh-cli, no `git` binary and no fork.**

### 4.1 Why not a fork

A fine-grained token is scoped to **one resource owner**. To open a PR the token has to be
scoped to the *target* repo's owner, so a token scoped to `Mael` (which owns the fork) cannot open
a PR on `Yundera/AppStore`. This is a known GitHub limitation, and the usual workaround is a
classic token, which can reach every repo the account can.

Mael is a member of the Yundera organisation, so the direct route is also the narrow one:

- **Resource owner:** `Yundera`. **Repository access:** only `AppStore`.
- **Permissions:** Contents read/write (to create the branch), Pull requests read/write,
  Metadata read.
- Touchstone pushes `touchstone/<kind>/<App>-<yyyymmdd>-<id6>` to the origin repo and opens the PR from
  it. The PR shows up on GitHub like any internal one, which was the actual requirement.

Two things are needed on GitHub's side, both one-time:

1. The Yundera org must **allow fine-grained tokens** (Settings → Personal access tokens). It
   may require an org owner to approve this token.
2. The `touchstone` label exists in the repo (D13). Create it **once by hand**. Creating labels
   through the API needs more than Pull requests write, and widening the token for a one-time
   act is the wrong trade.

**`main` is not protected (D14), so the guard is Touchstone's own code.** Contents write can
move any branch, `main` included. A token on an unprotected repo can therefore push straight to
production, and nothing on GitHub's side would stop it. So:

- **One function, `refFor(proposal)`, is the only producer of a ref name.** It returns
  `refs/heads/touchstone/<kind>/<App>-<yyyymmdd>-<id6>`. Every ref-writing call (create, delete) goes
  through one wrapper that refuses anything not matching `^refs/heads/touchstone/` **before the
  request is built**, and a test pins that the wrapper refuses `refs/heads/main`.
- **There is no "update ref" call anywhere.** Touchstone creates a branch once and deletes it
  once. A force-push is unspellable in the code, not merely unused.
- **The `<App>` part is the directory name**, which comes from a GitHub listing or a wish file.
  It is checked against the same `^[A-Za-z0-9][A-Za-z0-9._-]*$` rule as a subject, so `..` or a
  slash cannot walk the ref out of `touchstone/`.

**Recommended, not required:** a ruleset on `main` requiring a pull request. Note that it binds
*Mael*, not just the token, because GitHub cannot tell them apart. If Mael pushes to `main` by
hand today, that habit would have to go through a PR too, or Mael would need a bypass, and a
bypass would cover the token as well. That is the store team's call. The design does not
depend on it.

**Branches are Touchstone's to clean (D12).** Merged or closed, the PR poll that notices it
also deletes the branch, through the same guarded wrapper.

**Fallback**, if the org cannot allow fine-grained tokens: a classic token with `public_repo`,
still pushing to a branch on the origin repo. That needs no code change, only a wider credential.

### 4.2 Why not gh-cli or a clone

- `gh` is a binary with its own credential store under `~/.config/gh`. Every call would be a
  child process with arguments, which `exec.ts` deliberately avoids (input goes on stdin, never
  argv). It would also be a second place the credential lives. Everything this feature needs
  from GitHub is about six REST calls.
- **Commits are made without a clone**, through the Git Data API:
  1. `GET /repos/{repo}/git/ref/heads/{ref}` returns the base commit, which is the sha the
     proposal was built on.
  2. `POST …/git/blobs` uploads each changed file as base64, so binary icons and screenshots
     work too.
  3. `POST …/git/trees` with `base_tree` = the base commit's tree. A deletion is an entry with
     `sha: null`.
  4. `POST …/git/commits`, with author `Mael (Touchstone)` (D8).
  5. `POST …/git/refs` → `refs/heads/touchstone/<kind>/<App>-<yyyymmdd>-<id6>`. The six-character
     proposal id suffix keeps two proposals for one app on one day from colliding.
  6. `POST /repos/{repo}/pulls` from that branch into the origin's ref.
- **The "local clone" is the archive Touchstone already downloads.** `trialstore.ts` fetches the
  origin's zip at its ref, and `extractApp` / `packAppStore` already take one app out and put it
  back. A full `.git` would add the `git` binary to the image, put a token-bearing remote on disk
  and require locking for concurrent worktrees, all to produce a diff the Git Data API takes as a
  list of files.

### 4.3 Configuration

`config.yaml`, read at boot:

```yaml
github:
  token: ""            # or TOUCHSTONE_GITHUB_TOKEN; masked by redactConfig (key name matches `token`)
  login: Mael          # checked against GET /user, so a token for the wrong account is an alert
  commit_name: Mael (Touchstone)
  commit_email: ""     # the account's noreply address if empty

workshop:
  origin: yundera      # the origin that receives PRs; other origins are never proposed against
  armed: false         # safety switch, default off (§10)
  prs_per_day: 1       # a control (§10)
  max_rounds: 3        # authoring + validation rounds per proposal before it is given up
  session_minutes: 90  # hard limit on one authoring session
```

The branch is created on the configured origin's `repo`, and the PR targets its `ref`. Nothing
else is configured.

**The token can also be set on the Workshop page** (added 2026-10-05), and that one wins: it is
kept in `data/github-token` (`0600`, beside `config.yaml` because a person typed it) and
overrides `github.token` / `TOUCHSTONE_GITHUB_TOKEN` the way `state/controls.json` overrides
the config file. Setting it swaps the client and runs the §4.4 probe in the same response, so
a token that cannot push is stored and said to be failing rather than refused. Clear puts the
boot token back. It is **write-only** — `PUT|DELETE /workshop/github`, nothing returns it, and
it is not a control or a chat tool, so the admin MCP cannot set it (§10). `GITHUB_TOKEN_SET` /
`GITHUB_TOKEN_CLEARED` record who, never what.

### 4.4 Health and budget

**Its health is a probe, like the agent's.** `GET /user` (login matches, token valid) and
`GET /repos/{repo}` (`permissions.push` is true) and `GET …/labels/touchstone` (the label
exists, D13) run at boot and every few minutes, and open a
`github.auth` alert on failure. A missing label does not block submission: the PR is opened
unlabelled and the alert says so. Settings and the Workshop page show "configured as Mael" or why
not.

**Rate limit.** An authenticated token gets 5,000 requests an hour, compared with 60 an hour for
the unauthenticated budget that `registry.ts` and `storedoc.ts` share. It is tempting to move
those reads onto the token too. **Do not, at first.** If the bot account ever has a problem, the
registry would become unreachable and auditing would stop (invariant 3). The token is for the
workshop.

---

## 5. What gets worked on, and in what order

### 5.1 The three kinds, by priority

Each tick derives its candidates afresh, as invariant 8 asks: nothing is enqueued. The only
stored state is the **memory** in §5.3.

1. **`fix`**: an app on the workshop's origin whose hallmark is **non-compliant on any scoring
   section**. Further conditions:
   - The verdict must be under the **standard in force**. A verdict carrying `older standard` is
     audited first, not fixed, because fixing against a rubric that has since moved is fixing
     the wrong thing.
   - The app must not be delisted.
   - Order: most Critical findings first, then highest risk, then the oldest verdict.
2. **`currency`**: an app whose `currency` reading says it is behind upstream **and which is
   compliant today**. A non-compliant app cannot pass D7 whatever its version, and it is already
   a `fix` candidate. Order: furthest behind first. **Major versions are in scope (D9).** The
   validation trials are what make a major bump proposable at all: if the new major breaks
   install, first boot or persisted data, `functional` says so. The PR title and body say
   `major` plainly, and the agent is asked to read the upstream release notes for migrations and
   quote them. **One change per PR**: a fix never bumps a
   version and a bump never fixes findings, because a reviewer has to be able to tell which
   change broke the app.
3. **`wish`**: a wishlist file whose app is not offered by any origin. Order: file order
   (`order:` in its frontmatter, then name), so the operator decides.

### 5.2 Always skipped

- An app with **any open PR** on the origin repo touching `Apps/<App>/`, whoever opened it. One
  search call (`GET /search/issues?q=repo:… is:pr is:open`) per tick, cached alongside the store
  list.
- An app with an open **Touchstone** PR, until that PR is merged or closed.
- Anything whose memory says it was given up and whose input has not changed since (§5.3).

### 5.3 Memory: what was tried, against what

`state/workshop.json` keeps one row per **task key** (`fix:yundera~X`, `currency:yundera~X`,
`wish:<file>`):

```
{ input_sha, attempts, last_attempt_at, outcome, reason?, proposal_id?, pr_url? }
```

`input_sha` is **what the task was about** when it was tried:
- for `fix`, the compose blob sha plus the standard-in-force hashes;
- for `currency`, the compose blob sha plus the upstream tag the reading named;
- for `wish`, the sha256 of the wish file.

Rules:

- **A task is eligible when its input has changed since the last attempt, or it has never been
  tried.** The operator retries a wish by editing its file, the same way an edit to the standard
  makes apps eligible for re-audit. Nobody has to remember to clear anything.
- `outcome` is one of:
  - `pr_opened`
  - `cannot` (the agent stated why it could not be done, §6)
  - `failed_validation` (rounds exhausted)
  - `infra` (bench, agent or GitHub unavailable)
- **`infra` costs nothing and records nothing**, which is invariant 3 and the second invariant 14
  applied to the workshop. Every other outcome sets `last_attempt_at` and parks the task until
  its input changes.
- A PR **closed without merging** parks its task until the input changes. The reviewer said no,
  and proposing the same diff again tomorrow is spam.
- The operator can clear a task's memory from the UI (the workshop's equivalent of *Audit*).

---

## 6. The authoring session

### 6.1 When it may start: last in the one queue

D11 makes the workshop a **tenant of the Automation queue**, not a second loop beside it. The
queue's order becomes:

1. requests (audits and trials, in ask order). **A proposal's own validation trials are ordinary
   trials here** (§7), so they queue and drain like any other;
2. the backlog;
3. **the workshop**: at most one entry, either the candidate it would start or the session it is
   running.

A workshop entry starts only when **all** of these hold:

- the workshop is armed;
- **nothing else is in the pipe**: no audit request or trial queued *or running*, and no due
  backlog on any line. This is stricter than "a free pair exists" on purpose. The workshop is
  the only work Touchstone gives itself that nobody asked for, so it waits for real quiet rather
  than sharing benches with somebody waiting for an answer;
- **the PR quota is unspent** and no proposal is already `ready` waiting for the next slot.
  With a cap of one a day, building more than one ahead is wasted bench time, and the candidate
  ranking may have changed by then;
- a free (bench, browser) pair exists on the default target;
- no other authoring session is running. At most one proposal is ever in flight.

It holds at most one pair. An authoring session cannot be paused, so a request arriving
mid-session waits at most `session_minutes`, and the queue shows it waiting *behind the
workshop*, with the reason. The same rule (wait for quiet) applies between rounds: a validation
that failed does not start round two while a request is queued.

`GET /schedule` gains a `workshop` entry so the queue, the shell strip and `runStatus.ts` render
it with no second poller.

### 6.2 The working copy is an upload session

This is the reuse that makes the feature cheap. An upload session (`uploads/<id>/`) is already
"files laid over `Apps/<Subject>/` as the origin has it", and a trial already knows how to zip,
serve and install that. So:

- `fix` and `currency` proposals open a session over the existing app;
- a `wish` proposal opens a session over **nothing**. A trial's subject need not be a subject,
  which is exactly what lets a new app be checked before anyone commits it.

### 6.3 The workshop MCP surface

The surface follows the shape of `routes/mcp.ts`: a per-session bearer token, valid only while
the session is live. Tools:

| Tool | What it does |
| --- | --- |
| `list_files`, `read_file` | the working copy, inherited files included |
| `write_file`, `delete_file` | **confined to `Apps/<App>/`**: normalised path, no `..`, no absolute paths, a byte cap per file and per session |
| `read_store_file` | `storedoc.ts`: `CONTRIBUTING.md`, other apps as examples |
| `stage` | zips the working copy, serves it at a fresh trialstore URL, and returns that URL plus the leased bench's host, so the agent can install it on the bench through the browser it already holds |
| `submit(summary)` | ends the session and hands the working copy to validation. `summary` becomes the "what changed and why" section of the PR body |
| `cannot(reason)` | ends the session with an honest statement that this cannot be done in a listing (the upstream image has no authentication, needs privileged mode, has no amd64+arm64 build, …). The task is parked with the reason shown, and it is a **legitimate outcome, not a failure** |

The agent's prompt is assembled from:
- the kind's brief: the fix brief (`fixreport.ts`), the currency reading's row, or the wish file;
- `CONTRIBUTING.md` at the origin's ref;
- the scoring rubrics and the KB, under the same fence the runner uses;
- an operator-editable instruction file, `data/workshop/author.md`, seeded from
  `seed/workshop/` like protocols. It is not a standard, and it does not re-version anything.

It has its own web access for upstream READMEs, image tags and icons, but not Touchstone's token.

### 6.4 Rounds

`submit` → validation (§7). If validation fails and fewer than `max_rounds` rounds have run, a
**new** session opens on the same working copy, given the failing trials' fix brief. That is
what a human developer does with a review, and the walls in §3 still hold because each trial is a
fresh session the author cannot reach. Rounds exhausted → `failed_validation`, and the task is
parked.

---

## 7. Validation (D7)

On `submit`, Touchstone enqueues **two trials** of the working copy as ordinary queued
requests, in ask order like every other trial:

- a trial on **yundera** runs `static` and `functional` (`static` rides the default target);
- a trial on **foss** runs `functional@foss`.

**Pass = every scoring section is `compliant`.** A `blocked` section is **not a pass**:
- If it was blocked by infrastructure, the proposal waits and the trial is retried, at no cost
  to the task (invariant 3).
- If it was blocked by `agent_error` / `parse_failed`, it counts as a failed round. It
  established nothing, and "nothing" cannot be put in a PR as evidence.

---

## 8. Submission

A `ready` proposal is submitted when **the quota allows**: no Touchstone PR opened in the last
24 hours (a rolling window, so there is no time zone to argue about). Submission:

1. Read the origin's ref. If `Apps/<App>/` changed **since the proposal's base sha**,
   discard the proposal and mark the task `infra`, not charged. It was validated against bytes
   that no longer exist, and the change upstream changes its input sha anyway.
2. Commit the working copy's diff against the base through the Git Data API (§4), and create
   the branch.
3. Open the PR:
   - **Title:** `[touchstone] <App>: <fix compliance | update to vX | add app>`.
   - **Label:** `touchstone` (D13), applied right after the PR is created
     (`POST …/issues/{n}/labels`, allowed with Pull requests write).
   - **Body:**
     - the agent's summary;
     - a per-section table (section, target, verdict, risk, trial id);
     - for `fix`, a list of findings before and after;
     - the full trial reports inside `<details>`, cut to GitHub's 65,536-character limit with a
       note where they were cut;
     - the standard revision hashes the trials recorded.
   - **Composed by Touchstone from frontmatter**, like `fixreport.ts`: it quotes, it does not
     invent.
4. Log a `PROPOSAL_SUBMITTED` event with the PR URL, and mark the subject page and the Store row
   with a `PR #n open` chip (operator frame only; the board publishes nothing about PRs, see
   invariant 10's reasoning about not publishing the operator's queue).

**PR state** is polled with the same cadence and budget as the registry: open, merged or closed.
- **Merged**: Touchstone deletes the branch (D12). Otherwise nothing: the store changes and the
  ordinary loop audits it, which is how the hallmark moves.
- **Closed without merging**: the task is parked until its input changes (§5.3), and Touchstone
  deletes its `touchstone/…` branch.

---

## 9. The wishlist

`data/wishlist/*.md`, one file per wish, **operator-authored on the volume** like the KB and
`config.yaml`.

- **No route writes one** and no chat tool does: an admin MCP that authenticates nobody must not
  be able to queue a new app for the bot account to propose.
- Seeded empty, with a commented example.

```markdown
---
name: Immich            # the Apps/<name>/ directory it would become; must not collide with a store app
image: ghcr.io/immich-app/immich-server   # where to start; the agent picks a pinned tag
order: 10               # optional; lower first
---
Self-hosted photo and video backup. Interesting because … Needs Postgres + Redis
(the upstream compose has them). Default admin is created on first visit — check the
auth gate carefully.
```

**Integration only (D6).** The agent may write a compose file, `x-casaos` metadata,
descriptions, and fetch an icon and screenshots from the upstream project. It may not build an
image, write application code, or point at an image built from its own Dockerfile. A wish whose
image does not exist, has no multi-arch build, or cannot be made to pass without code changes is
a `cannot`, with the reason, and it stays parked until somebody edits the file.

Each wish's last attempt, outcome and reason is shown beside it, which is the "remember when we
last processed this file" requirement.

---

## 10. Switches and controls

- **`workshop.armed: false`** is a third safety switch with the same semantics as
  `scheduler.armed`: the tick still decides and logs what it *would* work on, and works nothing.
  It is settable at runtime and persists as an override. Disarming leaves a session in flight
  alone. As with the other two: **do not arm it without the operator's say-so.**
- **`workshop.prs_per_day`** is a *control* (`domain/controls.ts`). It passes the mechanical bar
  because submission re-reads it. Setting it to 0 means "build and validate, but never submit",
  which is the dry run (§12, phase 1).
- **The Workshop page** (D11), operator frame, beside Trials. It shows:
  - the GitHub identity and its probe;
  - the switch and the quota (with the time of the next slot);
  - the candidates in priority order, with why each is or is not eligible;
  - the proposal in flight: its round, its bench and the live browser;
  - `ready` proposals with their diff and validation trials;
  - the history of PRs and their states;
  - the wishlist with each file's memory.

  Clearing a task's memory is a button here and nowhere else.
- **The chat and the admin MCP** get **read** tools only: `get_workshop` (candidates, memory,
  the proposal in flight, ready proposals, open PRs). There is no tool to submit, approve or
  clear a task's memory. A PR under a real person's GitHub identity is an outward-facing,
  hard-to-reverse action, and the admin MCP authenticates nobody. This is the same argument as
  the second invariant 14 makes about delete.

---

## 11. Against the invariants

| Invariant | How the workshop keeps it |
| --- | --- |
| 1 / 6: the agent's declaration is authoritative, and no agent writes a verdict | The author has no gate tool. Validation is a fresh trial, and the gate is computed as for any assay |
| 3: infra costs no try | `infra` outcomes are free and unrecorded. A GitHub, bench or agent outage parks nothing |
| 8: no invented queue | Candidates are derived each tick from hallmarks, readings and wish files. The memory is a record of attempts, like `lastAttemptAt` |
| 10: `/public` is read-only | Nothing workshop-related is under `/public`, and PR chips are not on the board |
| 11: an executor is a `*.sh` nobody can write | The working copy is only ever **zipped and served**, never executed by Touchstone. Writes are confined to `Apps/<App>/` inside an upload session, which is nowhere near `protocols/` |
| 13: the KB never judges | Unchanged. The author reads it, and the gate is the rubric |
| 14 (second): charging a try writes an attempt record | Every charged outcome writes its memory row. `infra` writes none |
| *Nothing outside `store/` touches the filesystem* | `store/workshop.ts` (memory) and `store/wishlist.ts` sit beside `store/uploads.ts` |

---

## 12. Phases

Build trust before autonomy. Each phase is useful on its own.

1. **Hand-started fixes, dry run.**
   - GitHub configuration and probe.
   - The workshop MCP surface.
   - A **Propose fix** button on a non-compliant subject's page.
   - Validation trials.
   - A `ready` proposal shown with its diff and trial results.
   - **The operator presses Open PR.** The quota still applies.
   - Nothing is picked automatically.
2. **Automatic submission** under the quota once a proposal is `ready`, plus the **`currency`**
   kind, which is mostly a scripted tag bump with the agent used only to install and check.
3. **Idle-time selection** (§5–6.1): the workshop picks its own `fix` / `currency` work when the
   line is idle.
4. **The wishlist.** It is the hardest of the three: a whole listing with icon, screenshots and
   multi-language descriptions. It needs phases 1–3 to have shown the authoring is good enough.

---

## 13. Open questions

None blocking. The one thing left to the store team is whether to put a ruleset on `main`
(§4.1). The design does not rely on it.
