# syntax=docker/dockerfile:1

# ============================================================
# Stage 1: install dependencies
# ============================================================
ARG NODE_VERSION=24-slim

FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
  if [ -f package-lock.json ]; then \
    npm ci --no-audit --no-fund; \
  else \
    npm install --no-audit --no-fund; \
  fi

# ============================================================
# Stage 2: build (output: "standalone")
# ============================================================
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
# Build tidak butuh key, tapi kalau ada halaman yang dibuild dengan fetch
# ke IDX, key ini dipakai. Nilai asli tetap di-inject saat runtime.
ARG IDX_API_KEY=""
ENV IDX_API_KEY=${IDX_API_KEY}

RUN npm run build

# ============================================================
# Stage 3: runtime
# ============================================================
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV BS2_DB_PATH=/app/data/market.db

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Folder database — ditimpa bind mount ./data di docker-compose
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000

CMD ["node", "server.js"]
