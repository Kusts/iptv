# syntax=docker/dockerfile:1
#
# @iptv/web image (Next.js, `output: "standalone"` — see
# apps/web/next.config.mjs).
#
# Layout: base (pinned toolchain) → deps (lockfile install) → build (next
# build) → runtime (standalone server + static assets, no node_modules copy,
# no compiler).
#
# What the runtime stage actually copies, per the Next.js standalone layout:
#   .next/standalone/**  server.js + the traced node_modules subset
#   .next/static         hashed client assets (NOT inside standalone)
# `public/` is copied too when present (this repo has none today, so the COPY
# is optional-guarded below and a missing directory is not a build failure).
#
# `NEXT_PUBLIC_*` values are INLINED AT BUILD TIME. The browser base URL of the
# API therefore has to be present when this image is built, not only when it
# runs — pass it as a build arg (see deploy/staging/docker-compose.staging.yml:
# the `web` service declares `build.args`).
#
# Base image is digest-pinned (same convention as deploy/infisical).
# Refresh with: docker buildx imagetools inspect node:22-alpine

ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS base
# No NODE_ENV here: pnpm would skip devDependencies (see apps/api/Dockerfile).
ENV PNPM_HOME=/pnpm \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate && pnpm --version

# Every workspace manifest is needed: the lockfile lists all importers.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/browser-worker/package.json apps/browser-worker/package.json
COPY packages/ai-runtime/package.json packages/ai-runtime/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/secrets/package.json packages/secrets/package.json
COPY packages/workflows/package.json packages/workflows/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
# Public (browser-visible) API base URL: inlined at build time.
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
COPY apps/web apps/web
RUN pnpm --filter @iptv/web build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# The standalone bundle mirrors the monorepo layout from the trace root, so
# `server.js` lands at `apps/web/server.js` and the hashed client assets stay
# OUTSIDE it. Both assumptions are re-checked on the first real `docker build`
# (see docs/10-operations/runbooks/staging-deploy.md).
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
# apps/web/public does not exist in this repo today, so nothing is copied here.
# When it is added, add the standard line back:
#   COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(function(r){if(!r.ok)process.exit(1)}).catch(function(){process.exit(1)})"

CMD ["node", "apps/web/server.js"]