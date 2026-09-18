---
title: The FOSS stack
sections: [functional@foss]
---

# The FOSS stack

Reference for auditing on the **FOSS target**. It is not the rubric: nothing here adds a
requirement, excuses one or decides a verdict. Where this page and the protocol disagree, the
protocol governs — say so in the report and follow the protocol.

## It is the same Maison

The FOSS box runs the same dashboard as the demo pool: same app grid, same tiles, same store
format, same on-disk layout. Read off `demofoss1.nsl.sh` on 2026-09-17 — it serves `<title>Maison
</title>` from the same Vite bundle shape, at a different build (`index-DgefvmG9`, against the
demo pool's `index-CFIIX3k-`).

**So the sequence does not fork.** Everything `maison.md` says about installing, opening, reading
the Tips dialog, uninstalling-which-archives and restoring is true here. If you find yourself
reasoning about how this platform differs, the answer is almost always that it does not.

## What actually differs: the identity layer

The gate is the same — `/nhl-auth/oidc/login` — but what sits behind it is different software.
The demo pool uses the Yundera IdP; this box runs **Authelia** in front of **Dex**, which is the
substitution that makes the stack FOSS.

Two consequences, and only two:

- **The sign-in.** Follow the flow wherever it leads. As probed on 2026-09-17 it completes
  without a password prompt and lands back on Maison, exactly as the demo pool's does.
- **The session window.** `functional.md` §2 notes that one sign-in covers the dashboard and
  every protected app for 30 days. That is a fact about the *demo* IdP. Authelia's policy is its
  own, and nobody has measured it here — so do not reason from a number on either platform.
  `auth-gate` is judged from a **fresh context with no session**, which is true wherever the
  audit runs.

> ⚠️ **This page was written from an HTTP probe and a container listing, not from having driven
> the box.** If what you see disagrees with what is written here, what you see is right. Record
> the phase `errored`, say precisely what happened, and do not file a finding against the app —
> a platform this page describes wrongly is not an app's fault. Correcting this page is a KB
> edit, which moves no verdict and re-eligibles nobody.

## What is not known yet

- Whether this box is wiped on a schedule. The demo pool's daily cleanup is what guarantees app
  N+1 does not inherit app N's leftovers; **assume it is not wiped here**, which makes
  `functional.md` §7's cleanup load-bearing rather than tidiness. An archive left behind turns
  the next run's `install` into a restore prompt.
- Whether every store app installs identically. Only one app was present when the box was first
  inspected.
