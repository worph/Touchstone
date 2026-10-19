# Touchstone.
#
# Two things this image has to get right, and both are about the data directory:
#
# 1. **Everything Touchstone owns lives under one path** — `/DATA` here, the volume in the
#    compose. Config, the rubric, the report archive, trials and runtime state are all under
#    it, so a backup of one path is the whole system (ARCHITECTURE §8).
# 2. **The rubric and the knowledge base are not in the image at all** (since 2026-10-19). They
#    live on the volume (`protocols/`, `kb/`) and nowhere else: a copy shipped here read like the
#    live standard and drifted from every box. A fresh volume boots with no rubric, logs
#    `PROTOCOL_MISSING`, and turns every run away (`no_protocol`) until the files are put there.
#
# Debian rather than Alpine: no native dependencies (the AppStore requires amd64 *and* arm64,
# which is why there is no SQLite here), but glibc keeps the build boring.
#
# 3. **A section may be performed by a script**, not only by the agent — `executor: x.sh` in a
#    protocol file. Those live beside the rubric on the volume so they can be changed without a
#    rebuild, which is the whole point; what they need to *run* cannot follow them there, so
#    `curl` and `jq` are installed below. Both are small, both are on amd64 and arm64, and
#    neither is a native dependency of the Node build.

FROM node:22-bookworm-slim AS build

WORKDIR /app

# Manifests first so a dependency-only change keeps the install layer cached.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive

COPY tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts ./
COPY src/ src/

# `yarn build` is vite → dist/web, then tsc → dist/server, then the copy of chat/prompt.md.
# That prompt is an asset rather than a module, so it does not come along with tsc — the
# build script handles it, and a new non-TS file under src/server/ needs the same treatment.
RUN yarn build

RUN yarn install --frozen-lockfile --non-interactive --production --ignore-scripts && yarn cache clean


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TOUCHSTONE_DATA_DIR=/DATA \
    TOUCHSTONE_PORT=8080 \
    TOUCHSTONE_HOST=0.0.0.0

WORKDIR /app

# What a `*.sh` executor needs. `ca-certificates` is not optional: without it every registry
# lookup fails TLS verification and every currency reading records `blocked`, which is honest
# and useless.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist         ./dist

# What a fresh install starts with besides its config: the workshop's authoring instructions
# and the wishlist's example, copied onto the volume on first boot and never overwritten. The
# rubric and the knowledge base are deliberately absent — see note 2 at the top.
COPY seed/ ./seed/

# `pcs` runs apps as 1000:1000 and the compose sets `user: 1000:1000`; node:22 already has a
# `node` user at that id. The mountpoint is created and chowned here so a first boot against an
# empty volume can write, and again by the compose's pre-install-cmd on the host side.
RUN mkdir -p /DATA && chown -R node:node /DATA /app
USER node

VOLUME ["/DATA"]
EXPOSE 8080

# Liveness only. Deliberately not a readiness probe: the agent, the browser and the bench pool
# all being unreachable is a legitimate running state — invariant 7 says the app must stay
# diagnosable with every outbound port broken — and a healthcheck that failed on it would have
# Docker restart a process that is working correctly and reporting the outage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TOUCHSTONE_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
