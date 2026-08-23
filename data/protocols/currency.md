---
id: currency
name: Image Currency
kind: leaf

# Last of the three, and it needs nothing: no bench, no browser, no agent. `requires: []`
# means it runs whatever the state of the demo pool, which is the point — an app can be
# unauditable for a week and still have its images read.
order: 3
requires: []

# The procedure is the file beside this one. This protocol is the *policy* it reads, which is
# why the two are split: the thresholds below are what an operator changes, they version
# themselves on save, and every reading records the version that produced it.
executor: currency.sh

# **This section measures; it does not judge.** An image being 400 days behind is a fact
# about the world, not non-compliance — the app has not changed, the world has. Scoring it
# would re-rank the whole Overview by something that is not a finding, and ageing the
# subject off it would make a six-second reading look like a fresh audit.
scores: false

policy:
  # Images that belong to the platform rather than to the app. They are still read and still
  # shown — an app on an old AppShield is worth knowing about — but they do not colour the
  # app's badge, because they are not the app author's to fix.
  platform_images:
    - ghcr.io/yundera/appshield
    - ghcr.io/yundera/nginx-hash-lock

  # Behind by this many days before the reading reads as bad rather than as a nudge.
  # "Behind" is dated from when the *first* newer release appeared, not the newest one.
  stale_days: 180

  # Compare only within the pinned tag's own major line. An app on `postgres:16.13` is one
  # patch behind 16.14, not fourteen releases behind 18.6: a supported branch is a decision,
  # not neglect. Set true to count across majors as well.
  compare_majors: false

  # How many pages of a registry's tag list to walk before giving up and saying so. Ten pages
  # is a thousand tags on Docker Hub, which covers every image in the Yundera store.
  max_pages: 10

  # Per-image request timeout, seconds.
  timeout: 20

# None. A requirement here would put "your nginx is old" in the fix brief's findings list
# beside a Critical auth bypass, and would make an app with nothing wrong grow a fix report.
# What this section produces is a reading — a badge, a table and a summary — and the brief
# quotes it under its own heading. The channel exists (`requirements` in the executor
# contract) for a scripted section that genuinely judges; this one does not.
requirements: []
---

# Image Currency

How far behind its own upstream each service of an app is, and **for how long**.

This is not a rubric and there is nothing here for a model to read. The check is
`currency.sh`, sitting beside this file, and it is deterministic on purpose: comparing
`1.9.0` against `1.10.0`, counting releases and subtracting dates are exactly the operations
a language model is least reliable at, and a confidently wrong *"up to date"* is
unfalsifiable in a way an exception is not.

## What it reads

The app's `docker-compose.yml` — handed over when Touchstone already holds it (an upload
trial), fetched from the store's raw URL otherwise — and then, per image, the tag list of the
registry it comes from.

| Registry | Tags | Dates |
| --- | --- | --- |
| `docker.io` | yes | yes, per tag |
| `ghcr.io`, `lscr.io` | yes | fetched for the one tag that matters |
| `quay.io` | yes | yes, per tag |
| anything else | — | recorded `unknown`, with the registry named |

## The three numbers

- **behind** — how many comparable releases exist above the pinned one. Comparable means the
  same variant suffix (`-alpine` is compared with `-alpine`), the same precision, and — unless
  `compare_majors` is set — the same major line.
- **stale since** — the publication date of the **earliest** release newer than the pinned
  one. This is the one that answers *"how long has this app been out of date"*, and it is
  deliberately not the date of the newest release (that measures how busy upstream is) nor of
  the pinned one (that measures how old the image is).
- **days** — recomputed from `stale since` at render time, so the number on screen stays true
  between assays even though the reading is only taken when the app is audited.

## What it refuses to guess

`unknown` is a first-class answer and must never be shown as `current`:

- a tag pinned by digest — there is nothing to compare
- a floating tag (`nginx:alpine`, `postgres:17`) — the pin is a moving target, which is the
  static protocol's `pinned-image-tag` business and not this section's
- a tag that does not parse, or a registry with no readable tag list
- any registry error at all, including a rate limit — which records the whole section
  `blocked`, because "we could not look" is never "there is nothing to see"
