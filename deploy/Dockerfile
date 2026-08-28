# Touchstone.
#
# Two things this image has to get right, and both are about the data directory:
#
# 1. **Everything Touchstone owns lives under one path** — `/DATA` here, the volume in the
#    compose. Config, the rubric, the report archive, trials and runtime state are all under
#    it, so a backup of one path is the whole system (ARCHITECTURE §8).
# 2. **The rubric and the knowledge base are seeded, not baked.** `data/protocols/*.md` and
#    `data/kb/*.md` are committed to the repo, which is enough for a checkout and wrong for a
#    container: the volume starts empty. The image therefore carries its own copies at
#    `/app/seed/protocols` and `/app/seed/kb`, *outside* the volume, and `ensureProtocolFiles`
#    / `ensureKbFiles` copy them in on first boot without ever overwriting. The rubric is
#    editable in the app and versions itself on save, so an operator's edit must outrank the
#    image's copy — a redeploy that reverted it would silently change what every subsequent
#    assay is judged against.
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

# The shipped rubric *and its executors*, outside the volume. `PROTOCOL_SEED_DIR` resolves to
# `<REPO_ROOT>/seed/protocols`, and REPO_ROOT is `/app` here because the code runs from
# `/app/dist/server/`. `ensureProtocolFiles` copies both `.md` and `.sh` in on first boot and
# never overwrites either: an operator's edit outranks the image's copy, for the procedure for
# exactly the same reason it does for the policy.
COPY data/protocols/ ./seed/protocols/

# The knowledge base, on exactly the same terms — reference material the agent reads beside the
# rubric, seeded once and never overwritten, because an operator's page outranks the image's.
# `KB_SEED_DIR` resolves to `<REPO_ROOT>/seed/kb`. Without this the volume has no `kb/` and
# `forSections` answers null: the prompt is then byte-for-byte what it was before the KB
# existed, which is a supported state and therefore a silent one — hence this line.
COPY data/kb/ ./seed/kb/

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
