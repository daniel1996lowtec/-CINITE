# ---- Build stage: full install (incl. TypeScript/Vite/@types/three) + compile ----
FROM node:22.14.0-bookworm-slim AS build

WORKDIR /app

# `.npmrc` (include=dev) plus the explicit flag guarantee devDependencies are
# installed even when the build environment sets NODE_ENV=production, which
# would otherwise omit them and fail compilation with TS7016 errors.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev

COPY . .
# Database migrations intentionally do NOT run during the image build: the
# production DATABASE_URL is only reachable at container runtime. The server
# runs the idempotent migrations on startup (see server/multiplayerServer.mjs).
RUN npm run build

# ---- Runtime stage: production dependencies only ----
FROM node:22.14.0-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
# PORT is intentionally not hardcoded: hosting platforms (Render/Railway/Fly)
# inject PORT at runtime. Locally the server falls back to 2567.

# No `.npmrc` here on purpose: `--omit=dev` must win so the runtime image
# contains production dependencies only (pg, three).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/public ./public

EXPOSE 2567

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 2567) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/multiplayerServer.mjs"]
