# The service, as one image.
#
# The SERVICE has no build step: Node 22.18+ strips TypeScript types on its
# own, so the source that the tests run is the source that runs in
# production — no transpile output to drift from it, and a stack trace
# points at a real line in a real file.
#
# The EMBED bundle is the one thing that must be built, because a browser on
# somebody else's storefront cannot strip types or resolve bare imports. It
# is built HERE rather than uploaded by hand, because the snippet the Studio
# hands merchants points at this service for `embed.js` — so the bundle has
# to ship with the service, or every pasted snippet 404s on every storefront.

# ── the embed bundle ────────────────────────────────────────────────────────
FROM node:22-alpine AS embed
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/embed/package.json packages/embed/
# Dev deps on purpose: esbuild is the bundler, and three/gltf-transform must
# be on disk for it to bundle them in. None of this reaches the runtime image
# — only the handful of files it emits.
RUN npm ci --ignore-scripts --workspace @allin/embed --include-workspace-root
COPY packages/embed/src packages/embed/src
RUN npx esbuild packages/embed/src/embed.ts \
      --bundle --format=esm --splitting --target=es2022 --minify \
      --outdir=packages/embed/dist --chunk-names=embed-[name]-[hash] \
 && cp packages/embed/src/embed.css packages/embed/dist/embed.css

# ── the service ─────────────────────────────────────────────────────────────
FROM node:22-alpine

# Only the manifests first, so a code change does not re-resolve the
# dependency tree. The workspace root's package-lock is the authority for
# every package, which is why both are copied.
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/embed/package.json packages/embed/
COPY packages/studio/package.json packages/studio/

# --omit=dev skips PGlite (a test-only WASM Postgres, ~30 MB) and the whole
# browser toolchain. --ignore-scripts because nothing here needs a postinstall
# and running arbitrary ones in a production image is a supply-chain hole.
RUN npm ci --omit=dev --ignore-scripts --workspace @allin/api --include-workspace-root

# The service imports the embed's validator and manifest types directly —
# one definition of what a valid product is, shared by the Studio, the
# runtime and the service.
COPY packages/api/src packages/api/src
COPY packages/api/sql packages/api/sql
COPY packages/embed/src packages/embed/src

# What a merchant's storefront actually loads — see the note at the top.
COPY --from=embed /app/packages/embed/dist packages/embed/dist

# node:alpine ships a `node` user. Running as root in a container that talks
# to the internet buys nothing and costs a lot on the day something is wrong.
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Straight to node — no npm wrapper, so signals reach the process and Fly's
# graceful shutdown is graceful.
CMD ["node", "packages/api/src/main.ts"]
