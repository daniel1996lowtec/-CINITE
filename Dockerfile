FROM node:22.14.0-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Database migrations intentionally do NOT run during the image build: the
# production DATABASE_URL is only reachable at container runtime. The server
# runs the idempotent migrations on startup (see server/multiplayerServer.mjs).
RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
# PORT is intentionally not hardcoded: hosting platforms (Render/Railway/Fly)
# inject PORT at runtime. Locally the server falls back to 2567.
EXPOSE 2567

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 2567) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/multiplayerServer.mjs"]
