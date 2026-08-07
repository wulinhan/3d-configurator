# The service, as one image.
#
# No build step: Node 22.18+ strips TypeScript types on its own, so the
# source that the tests run is the source that runs in production — no
# transpile output to drift from it, and a stack trace points at a real line
# in a real file.

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

# node:alpine ships a `node` user. Running as root in a container that talks
# to the internet buys nothing and costs a lot on the day something is wrong.
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Straight to node — no npm wrapper, so signals reach the process and Fly's
# graceful shutdown is graceful.
CMD ["node", "packages/api/src/main.ts"]
