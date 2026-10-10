# PoCW engine — multi-stage build, non-root runtime, production dependencies only.
ARG NODE_IMAGE=node:22.23.3-alpine3.23

# ── 1. Build: full deps + TypeScript compile ─────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Toolchain for native modules (better-sqlite3) in case no musl prebuild is available.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── 2. Production dependencies only (native addons compiled for this libc) ───
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── 3. Runtime ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ai-config.yml ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/data /app/tmp && chown node:node /app/data /app/tmp

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1

CMD ["node", "dist/server.js"]
