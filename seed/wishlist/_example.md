---
# One file per wish. Files whose name starts with `_` (like this one) are ignored.
# Copy this to e.g. `immich.md`, edit, and the workshop will pick it up when it is idle.
name: Immich                                  # the Apps/<name>/ directory it would become
image: ghcr.io/immich-app/immich-server       # where to start; the agent pins a tag
order: 10                                     # optional; lower is picked first
---
Self-hosted photo and video backup. Why it is worth having, anything the agent should know:
companion services (Postgres, Redis — the upstream compose has them), where the default
admin is created, what to check carefully.

Integration only: an existing image becomes a listing. If that cannot be done without writing
code, the workshop records why and waits for this file to change.
