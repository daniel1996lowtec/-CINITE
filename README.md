# CI Craft — 3D Battle Royale (`v3.0`)

A browser-based **3D Stylized Third-Person Battle Royale** built with **TypeScript, Three.js, Vite, Web Audio API, and an Authoritative Node.js Multiplayer Room Server**.

---

## 🎮 Full Upgrade Highlights (Stages A–E)

### 1. High-Quality Stylized 3D World (8 Named POIs + Instanced Foliage + Day/Sunset/Night)
- **8 Named POIs with Unique Architecture & Interiors**:
  1. **Pipeline Plaza** (Central Town with glowing monument crystal, street lamps & 4 multi-story houses)
  2. **Docker Docks** (Southwest Harbor with wooden pier over ocean, shipping containers & warehouse)
  3. **Kubernetes Keep** (Northeast Citadel with 4 medieval corner guard towers)
  4. **Git Grove** (Northwest Forest with elevated wooden watchtower, ramps & cherry-blossom trees)
  5. **Server Silos** (Southeast Industrial Complex with 3 towering neon-ringed cylindrical silos)
  6. **Mirror Lake** (Scenic inland lake with treasure islet & wooden bridge crossing the river)
  7. **Frontend Farms** (Northern Farmstead with classic Red Barn, rotating Windmill, hay bales, golden crop rows & harvestable wooden fences)
  8. **Legacy Ruins** (Southern Abandoned Stone Temple with raised dais, moss-capped columns, broken pillars & ancient altar chest)
- **Instanced Foliage & Distant Horizon Islands**:
  - **640+ Instanced Grass Tufts & Wildflowers** rendered via `THREE.InstancedMesh` in just 2 GPU draw calls.
  - **8 Distant Mountain Islands** with snow caps along the outer ocean horizon.
  - **Day / Sunset / Night Lighting Presets** (`☀️ Bright Day`, `🌇 Golden Sunset`, `🌙 Cyber Night`) dynamically recoloring sky dome gradients, sun disc, fog, hemisphere light, and directional shadows.

### 2. Player Character, Movement-Based Rotation & Camera
- **Decoupled Movement & Aim Orientation (`facingYaw` vs `yaw`)**:
  - When moving freely, the character body rotates smoothly toward the movement vector (`facingYaw`) while the head tracks the camera look direction.
  - When aiming down sights (`Right-Click`), firing (`Left-Click`), or previewing a build, the character snaps into a combat stance aligned with the camera (`yaw`).
- **Weapon Pickup / Equip Animation**:
  - Smooth weapon spin/raise transition whenever picking up or switching weapons.
- **Over-the-Shoulder Third-Person Camera**:
  - Raycast obstacle collision prevention, smooth ADS zoom, and weapon recoil kick + recovery.

### 3. Complete Combat System (5 Firearm Classes + Harvester + Consumables)
- **Weapons**:
  - **Cyber Pistol** (Fast semi-automatic sidearm with high headshot multiplier)
  - **Pulse Rifle** (Automatic mid-range assault rifle)
  - **Scatter Pump** (8-pellet close-range spread shotgun)
  - **Hyper SMG** (High-fire-rate close-quarters submachine gun)
  - **Rail Sniper** (High-damage precision rifle with deep scope zoom)
  - **CI Harvester** (Melee harvesting tool) + **Shield Potion (+50)** & **Nano Medkit (+50)**
- **Damage Feedback**:
  - Floating 3D damage numbers, headshot hitmarkers, target hit-flash, directional red screen vignette flash, and synthesized damage-taken audio.

### 4. Smarter Enemy Bots with Whisker Obstacle Pathfinding
- **6 Tactical AI States**: `PATROLLING`, `ROAMING`, `LOOTING`, `ENGAGING`, `TAKING_COVER`, and `FLEEING_STORM`.
- **Whisker Raycast Obstacle Avoidance**: Bots probe forward and angled left/right whisker rays (`±50°`) to steer smoothly around buildings, walls, and towers.
- **Difficulty-Scaled Reaction Times & Accuracy**: Bots have realistic reaction timers when spotting a target before opening fire, select optimal weapons for range, and build defensive cover when hit.

### 5. Building & Harvesting (`Wall`, `Ramp`, `Floor`, `Roof`)
- **4 Build Pieces**:
  - `[Q]` **Wall** | `[E]` **Ramp** | `[C]` **Floor** | `[V]` **Roof (Pyramid)** | `[G]` **Cycle Material (`Wood` / `Stone` / `Metal`)**
- **3D Holographic Placement Preview & Validation**:
  - Validates terrain bounds, water depth, and duplicate cell occupancy (`cyan` = valid, `red` = invalid/insufficient resources).
- **Zero Memory Leaks on Match Restart**:
  - `world.resetDynamicStructures()` cleans up all player/bot-built meshes and colliders between matches.

### 6. Real Online Multiplayer Architecture + Spectator Mode
- **Starter Loadout Selection**: Choose between *Balanced*, *Breacher*, *Recon*, and *Architect* loadouts in the lobby.
- **Live Spectator Mode**: When eliminated, click **👁️ SPECTATE LIVE** (or press `[N]`) to follow remaining combatants in 3D until the match finishes.
- **Authoritative WebSocket Room Server (`server/multiplayerServer.mjs`)**:
  - Synchronizes room codes (`CICRAFT-1`), player identity, reconnection via `sessionToken`, 20Hz player movement/rotation state, and remote structure building without breaking single-player mode.

---

## 🚀 Running Locally

```bash
# Install dependencies
npm install

# Start Vite development server on 0.0.0.0:5173
npm run dev

# (Optional) Start Authoritative Multiplayer Room Server on 0.0.0.0:2567
npm run server

# Start Production HTTP + WebSocket Server + Static Frontend on 0.0.0.0:2567
npm run build
npm run db:migrate
npm run start

# Run TypeScript check and production build
npm run typecheck
npm run build
```

---

## 🌐 CI Craft 2.8 — Permanent Online Multiplayer & Persistent Accounts

- **Durable Database Persistence (`server/database.mjs` & `server/migrate.mjs`)**:
  - Supports managed **PostgreSQL** (`DATABASE_URL`) in cloud production and durable on-disk **SQLite WAL** (`./data/cicraft.sqlite`) out of the box.
  - Persists `xp`, `level`, `matchesPlayed`, `wins`, `eliminations`, `damageDealt`, `bestPlacement`, `cosmetics`, and `unlockedOutfits` across server restarts.
- **Cryptographic Account Identity & Cross-Device Passkey**:
  - Uses HMAC-SHA256 signed `accountToken`s (`ACCOUNT_TOKEN_SECRET`) and SHA-256 hashed Cross-Device Passkeys (`acc_xxxxxx:XXXX-XXXX-XXXX`) so players can link and restore their career profile across browsers and devices via the **🔑 ACCOUNT PASSKEY** panel in the Lobby.
- **Production Deployment Configs**:
  - Includes `render.yaml` (Render Web Service + Managed PostgreSQL), `railway.json` (Railway deployment config), `Dockerfile`, `.env.example`, and full instructions in [`DEPLOYMENT.md`](./DEPLOYMENT.md).

