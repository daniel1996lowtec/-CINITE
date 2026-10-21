# CI Craft 2.8 — Production Deployment & Persistent Database Guide

This guide explains how to deploy **CI Craft 3D Battle Royale** to a permanent public hosting service with HTTPS, Secure WebSockets (`wss://`), and durable server-side PostgreSQL (or persistent-volume SQLite) career progression.

---

## 1. Architecture Overview

`server/multiplayerServer.mjs` is a single unified Node.js (>= 22) production server that:
1. Serves the compiled static Three.js frontend (`dist/` and `public/models/soldier.glb`).
2. Upgrades `/ws` connections to authoritative WebSocket (`ws://` in dev, `wss://` over HTTPS in production).
3. Exposes REST endpoints for health checks (`GET /health`), room creation/discovery (`POST /api/room/create`, `GET /api/room`), and persistent account authentication & cross-device passkey linking (`POST /api/account/init`, `POST /api/account/restore`, `POST /api/account/cosmetics`, `GET /api/progression`).
4. Persists all verified career progression (`xp`, `level`, `matchesPlayed`, `wins`, `eliminations`, `damageDealt`, `bestPlacement`, `cosmetics`, `unlockedOutfits`) via `server/database.mjs`:
   - **PostgreSQL (`DATABASE_URL`)**: Used automatically when `DATABASE_URL` is set.
   - **On-Disk SQLite (`SQLITE_DB_PATH`)**: Used automatically (`./data/cicraft.sqlite` in WAL mode) when `DATABASE_URL` is not set.

> **Important Hosting Note**: Because CI Craft uses stateful real-time WebSocket rooms, you must deploy to a hosting provider that supports **persistent long-lived Node.js processes and WebSockets** (such as **Render**, **Railway**, **Fly.io**, or a **Docker VPS**). Serverless function hosts that terminate connections after 10–60 seconds (such as Vercel Serverless Functions or Netlify Functions) are not suitable for hosting the WebSocket room server.

---

## 2. Required Environment Variables

Configure these in your hosting dashboard (never commit real secrets to Git):

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Yes | `production` | Enables production runtime behavior. |
| `PORT` | Auto | `2567` | TCP port bound by the HTTP + WebSocket server (injected automatically by Render/Railway/Fly). |
| `HOST` | No | `0.0.0.0` | Network interface to bind. |
| `DATABASE_URL` | Recommended | *(empty -> SQLite)* | PostgreSQL connection URL (`postgresql://user:pass@host:5432/dbname?sslmode=require`). |
| `ACCOUNT_TOKEN_SECRET` | Yes (Prod) | *(auto-saved in `./data/.server_secret`)* | 64-character hex secret for HMAC-SHA256 account token signing. Generate via `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `SQLITE_DB_PATH` | Optional | `./data/cicraft.sqlite` | Path for on-disk SQLite database when `DATABASE_URL` is not set. |
| `ALLOWED_ORIGINS` | Optional | *(all)* | Comma-separated list of allowed HTTP/WS origins (e.g., `https://cicraft.onrender.com`). |

---

## 3. Option A: Deploy to Render (Recommended — Blueprint Included)

This repository includes `render.yaml` which configures both the Node.js Web Service and a managed PostgreSQL database.

1. Push your branch/repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com/), click **New +** -> **Blueprint** and select this repository.
3. Render will automatically read `render.yaml` and configure:
   - **Build Command**: `npm ci && npm run build && npm run db:migrate`
   - **Start Command**: `npm run start`
   - **Health Check Path**: `/health`
   - **Environment Variables**: `NODE_ENV=production`, `ACCOUNT_TOKEN_SECRET` (auto-generated), and `DATABASE_URL` (linked to `cicraft-postgres`).
4. Once deployed, open your `https://<your-service>.onrender.com` URL. Both HTTPS and `wss://<your-service>.onrender.com/ws` work automatically.

---

## 4. Option B: Deploy to Railway (`railway.json` Included)

1. Install the Railway CLI or connect your GitHub repository in the [Railway Dashboard](https://railway.app/).
2. Add a **PostgreSQL** plugin service to your Railway project (Railway automatically injects `DATABASE_URL`).
3. Set `ACCOUNT_TOKEN_SECRET` in the Variables tab:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. Railway automatically uses `railway.json`:
   - **Build Command**: `npm ci && npm run build && npm run db:migrate`
   - **Start Command**: `npm run start`
   - **Healthcheck Path**: `/health`
5. Generate a public domain in Railway Settings -> Networking.

---

## 5. Option C: Deploy with Docker / VPS / Fly.io (`Dockerfile` Included)

```bash
# 1. Build the production Docker image
docker build -t cicraft-battle-royale:2.8 .

# 2. Run with a persistent volume for SQLite (or pass -e DATABASE_URL="postgresql://...")
docker run -d \
  --name cicraft-server \
  --restart unless-stopped \
  -p 2567:2567 \
  -e NODE_ENV=production \
  -e ACCOUNT_TOKEN_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  -v cicraft_data:/app/data \
  cicraft-battle-royale:2.8
```

---

## 6. Post-Deployment Verification Commands

Once deployed to your public URL (replace `https://your-app.example.com` below), run:

```bash
# 1. Verify server health & database persistence status
curl -s https://your-app.example.com/health

# 2. Verify private room creation
curl -s -X POST https://your-app.example.com/api/room/create

# 3. Verify persistent account provisioning
curl -s -X POST https://your-app.example.com/api/account/init \
  -H "Content-Type: application/json" \
  -d '{"callsign":"Commander_CI"}'
```
