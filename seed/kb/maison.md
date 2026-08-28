---
id: maison
title: Driving Maison — the demo PCS dashboard
summary: >-
  How the platform behaves: routes, the single sign-on, the store's cached copy, what the
  install and uninstall dialogs actually do, and where an app's first-run credentials are
  written down.
sections:
  - functional
---

# Driving Maison

The demo PCS runs **Maison**, the dashboard that replaced CasaOS. Same app grid, same tiles,
same store format, same on-disk layout — so **nothing about which apps pass moves because the
dashboard changed**. What follows is how the platform behaves, so that a phase is not scored
against a UI you were expecting instead of the one that is there.

None of this decides a verdict. Where a note here and the protocol disagree, the protocol
governs.

## What moved from CasaOS

| | Was (CasaOS) | Is (Maison) |
| --- | --- | --- |
| **Where the dashboard lives** | `casaos-<DEMO>` | `maison-<DEMO>`, **and the bare `<DEMO>`** |
| **Who asks for the password** | CasaOS's own accounts | the **platform SSO** — one sign-in for the dashboard, the admin page and every protected app, valid **30 days** |
| **Reaching the store** | a tile opening an in-page modal | a **route** — `/store`, `/store/<app-id>` |
| **What uninstall does** | removed the app; "keep data" left the folder | **always archives** the whole folder, never deletes |

**Gone with CasaOS:** the Files app, the built-in terminal, disk/RAID and Samba management, the
global search bar, and the manual "install a customised app" form. If a step seems to need one
of those, it is being read wrong — and the absence of one is never a fault of the app under
audit. (The synthetic-pointer-event trick for prising open the old store modal went with it:
the store is a real route now, and a hand-dispatched event sequence must not be used.)

## Routes and navigation

- `https://<DEMO>/` — the dashboard. `https://maison-<DEMO>/` is the same page.
- `https://<DEMO>/store` — the catalogue.
- `https://<DEMO>/store/<app-id>` — one app, `<app-id>` being the compose project `name`, i.e.
  the lowercase slug.
- `https://<DEMO>/settings/backups` — the box-wide archive list.

Navigating beats clicking and survives a slow paint. The whole UI is in the accessibility tree,
so prefer `take_snapshot` and click uids — and use a **real** `click` on a uid for store and app
tiles.

## The session is platform-wide

The gate is the **platform SSO**, not a dashboard account: the login page offers *Log in with
Yundera* or *Local Account*, and one sign-in covers the dashboard, the admin page and every
protected app for **30 days**. The dashboard's own markers, once in, are `App Store` and
`System status`.

A **Getting Started** wizard at `admin-<DEMO>` means the box has never been set up. That is a
box that was not prepared, not an app that failed.

The consequence to hold on to: a session established on the dashboard carries straight into an
app's URL. An app that opens on its content may simply be riding it. The per-run isolated
context and the profile-less browser are the guard, and a second never-signed-in context is the
tie-breaker.

## The store the box serves is a cached copy, and it can be hours old

Maison holds the store zip (`APPSTORE_URL`, `.../archive/refs/heads/<branch>.zip`) **in the
running process** — there is no copy on disk — and re-reads it only on a refresh or a restart. A
commit to the store is therefore *not* visible to an install until one of those happens, and
demo instances restart once a day.

An audit that does not refresh is installing whatever the box last cached, which may be a
different version of the app from the one it was asked to audit — while `gh` shows the auditor
the current source. The divergence is silent and it looks exactly like a broken app.

*Recorded because it has already cost a day:* on 2026-08-20 a fix landed at 16:45 and two audits
at 17:29 and 20:34 installed the pre-fix compose from cache. Both correctly observed a real
reinstall failure, and both attributed it to an app whose source — which the agent could read,
and which was fixed — did not contain the defect. The same cycle passed on both demo hosts the
next morning, after the nightly restart.

### A store supplied with the run

A run auditing files that are on no branch is given a store URL of its own and told to open
`https://<DEMO>/store/<APP>?store=<that url>`.

Two things about that URL surprise people:

- **The address bar rewrites itself**, immediately, to
  `https://<DEMO>/store/<the store url without its scheme>/-/<apps_path>/<APP>`. That is Maison
  canonicalising the query parameter into its own route. It is not a failure, the navigation did
  not go wrong, and retyping the URL does not help. You are on the right page when the app's own
  name and an Install control are visible.
- **Maison warns that the app comes from a store you have not added**, and names the URL. The
  warning is correct and accepting it is part of the run.

Such a URL is minted per run and has never been fetched by anything, so no cached copy of it can
be stale and no refresh is needed.

## Installing

**Finding the card.** The store's search box matches name, tagline *and* category, so confirm a
card's heading matches the app name exactly rather than taking the first hit.

**The backup picker.** If the box already holds an archive of the app, clicking **Install** opens
a **menu** instead of installing: **Fresh install** at the top, then **Restore from backup** with
one row per archive. With no archives present the click installs straight away and no menu
appears.

**Tips.** An optional **Tips** dialog appears at install, and Maison also keeps it on the tile's
menu under **Tips**. *Read it, always.* It is where the platform puts an app's first-run
instructions, and in practice that is where an app's **initial credentials, first URL or first
setup step** are written down — the default account for FileBrowser is there, not in a log and
not in a command. An app whose starting point is only discoverable by reading container logs is
a different situation from one that documents it in Tips, and the two are easy to confuse if
the dialog is dismissed unread. Capture any URLs, paths or credentials it shows before moving
on.

**Progress.** A single progress bar rides the tile and the store's install pill: **Download**
(blue, real per-layer pull progress), then **Start** (green). Progress rides the live app list,
so it keeps advancing after the store panel is closed — closing the panel is not "continue in
background", it is just closing a panel. The install has settled when the tile shows an **Open**
action and no error.

**A failed install stays visible** as a red `!` on the tile, with the error in its tooltip; it
does not vanish. That tooltip is the install's own diagnosis and it is evidence — read it before
concluding anything.

**Confirming what was installed.** The tile's **Settings → Compose** shows the compose the box
actually ran, which is what a claim about a particular ref rests on.

## Uninstalling, and the archives it leaves

An uninstall **always archives**: the confirm dialog says the folder is renamed to
`<app>.<date>.archive` under `AppData/`, and offers *Compress the archive to a `.zip`* — leave
that **off**, a rename is instant and a zip is a full second copy that can take minutes. The
tile shows the same single bar in red: **Remove**, then **Archive**.

An archive carries the **whole** app folder — compose, override, `.env` and the data under
`AppData/<app>/`. Anything the app keeps outside its mapped volumes is not in it.

**Telling archives apart.** The rows under **Restore from backup** are labelled by **date
only**, so two archives made on the same day are indistinguishable there.
`https://<DEMO>/settings/backups` lists the same archives **with times**, and marks the ones
whose app is uninstalled. That page is also where archives are deleted.

## Things the platform does that are not the app's fault

A backup picker where an install used to be; an archive left over from an earlier run; a tile
marked `unmanaged`; a System-grid app that refuses Stop and Uninstall; the absence of a feature
that went with CasaOS. These are the platform.
