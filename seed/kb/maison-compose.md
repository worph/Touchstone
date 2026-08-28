---
id: maison-compose
title: What Maison reads from a compose file
summary: >-
  The platform side of an app's compose: which metadata block wins, what is parsed and then
  ignored, when declared folders are created, and when and where install hooks actually run.
sections:
  - static
---

# What Maison reads from a compose file

The dashboard that installs these apps is **Maison**. Judging a compose means knowing which
parts of it the platform actually consumes, and when. None of this decides a verdict — the
rubric does — but a rule applied to a field nothing reads is a finding about nothing.

## Two metadata blocks, and which one wins

Maison consumes the **unmodified CasaOS store format**, and reads its own Compose extension
`x-compose-app` **alongside** `x-casaos` rather than in place of it.

- An app carrying only `x-casaos` is correct and installs fine.
- An app carrying only `x-compose-app` is also correct.
- With both present, `x-compose-app` **wins field by field**, falling back to `x-casaos` for
  anything it omits. The block that will actually be used is the merge of the two, in that
  order.

**What is parsed and then ignored.** The *per-service* `x-casaos` description lists — `envs:`,
`volumes:`, `ports:`, `devices:` — are read and then never consumed: the CasaOS per-field
config form they fed does not exist in Maison, so those `description:` entries reach no user.
They are inert in both directions — an old app that has them and a new app that does not are
both behaving correctly.

## The web UI fields

- **`webui-host`** is the host the tile's click URL is built from, and Maison clones the app's
  Caddy route group onto every extra domain the deployment answers on. So it tracks the route
  only while it matches the service's own `caddy_0` label — same string, same `${domain}`
  placeholder.
- **`webui-port`** is the **URL** port, not the container port. In the normal gateway case it
  is empty, which is correct.
- **`index`** is the path appended to that host.

## Declared folders

`x-compose-app.folders` is how an app says which directories it needs. They are created, owned
and moded **before images are pulled, before any hook runs and before the containers start** —
on the first boot and on every boot after it.

Why this exists rather than being inferred: Compose creates a missing bind-mount source as an
empty **root-owned** directory, so an app that then drops to `$PUID:$PGID` cannot write to its
own config volume — the classic permission-denied first start. **Maison does not read
`volumes:` and guess**, because no heuristic can tell a directory from a config file. A
directory the app needs is a directory the app declares.

- `mode:` must be **quoted** (`"0755"`). Unquoted, YAML types it as an octal int, the leading
  zero is gone before Maison sees it, and the install is rejected.
- Paths must be absolute, inside `/DATA`, with every variable resolvable — a relative path, a
  path outside the data root or an unresolvable `${VAR}` fails the up.
- `recursive: true` walks the tree. On a directory the app did not create — a restored backup,
  a media library another app wrote — that is the point of it. On a large tree that is already
  correctly owned it is a walk proportional to the tree.

**`schema_version`** must be `2` for an app relying on `folders` or `hooks`. An older Maison
reading a missing or `1` schema starts the app silently *without* its directories, which is the
first-start failure the declaration exists to prevent. An app relying on neither needs no
`schema_version` at all.

## Install hooks: when, and where

`x-compose-app.hooks` (`pre_install` / `post_install` / `pre_up` / `post_up`) generalise the
older `pre-install-cmd` / `post-install-cmd` and **win over them** when both are present. Both
forms go through the same machinery.

**When they run.** `pre_install` once, after images are pulled and before the first up;
`post_install` once, right after it. `pre_up` and `post_up` bracket **every** up — install,
every later start, a store update, and saving the app's config.

**Failure semantics.** `pre_install` and `pre_up` are **fatal**; `post_install` and `post_up`
are logged and swallowed. So anything flaky in a `pre_up` blocks the app on *every* start, not
just the first.

**Where they run — and the consequence people get wrong.** Hooks execute through `/bin/bash -c`
**inside the Maison container**, working directory set to the app's folder, but talking to the
**host** Docker daemon over `DOCKER_HOST`. So `/DATA` in a `docker run -v` names a **host**
path.

`/DATA` is also bind-mounted into that container at the same path, so a hook and the host see
*one* filesystem: `/DATA/AppData/<app>/…` means the same bytes in both. Two things follow:

- A plain `mkdir /DATA/...` in a hook creates the directory in the **right place** with the
  **wrong owner** — `root:root`, where everything else under `/DATA` is the PCS user.
- **A read-only test in a hook reads the real host file.** `[ -f /DATA/AppData/$AppID/db/x.db ]`
  sees exactly the file the `docker run -v` beside it mounts. A hook's `[ -f ]`, `[ -d ]` or
  `test` is **not** looking at some separate container filesystem, and it is not ineffective.

## Bookkeeping fields Maison writes itself

`store`, `store-app-id` and `generated-routes` are written into an *installed* app's override
file by Maison. They belong to an installation, not to a store entry.

**`view: system`** is reserved for platform components: Maison refuses Stop and Uninstall on
such an app and skips it in backups.
