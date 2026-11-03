# EECOHM Teacher Roulette

Teacher Roulette uses a React/Vite frontend and a persistent Node.js WebSocket backend. The backend owns game state, validates transitions, runs the exact 10-second operator-selection windows, selects random fallback outcomes with Node's cryptographic random generator, and finalizes payouts once. Admin and projector screens receive ordered state snapshots without polling.

## Local setup

1. Install dependencies:
   ```sh
   npm install
   ```
2. Copy `.env.example` to `.env.local` and set a unique administrator username and strong password.
3. Start the integrated Vite + WebSocket development server:
   ```sh
   npm run dev
   ```
4. On the host laptop open `http://localhost:5173/audience` for the projector. Open `http://<laptop-LAN-IP>:5173/admin` on the phone. Both devices must use the same host address and Wi-Fi network. `/risk` is the separate risk-stage view; it shows controls only in an authenticated admin session.

The admin login uses `ADMIN_EMAIL` as its username and `ADMIN_PASSWORD` as its password. The audience connection is read-only. Local development uses the same-origin WebSocket by default; set `VITE_WS_URL` to override it. Do not expose the development server to the public internet. The mobile browser works on a trusted LAN over HTTP, but PWA installation and offline app-shell caching require a secure context; use HTTPS for those features.

## Production deployment

The frontend and persistent WebSocket backend are separate services:

1. Create a Render Blueprint from `render.yaml`. The backend binds to Render's `PORT`, exposes `/health`, and stores state on the blueprint's persistent disk at `/var/data/game-state.json`.
2. Set `ADMIN_EMAIL` and a long, unique `ADMIN_PASSWORD` as Render secrets. Set `FRONTEND_ORIGIN` to the exact Vercel production origin. Never put secrets in Vercel variables prefixed with `VITE_`.
3. Verify `https://<your-render-service>.onrender.com/health` returns `{"status":"ok",...}`.
4. Import the Git repository into Vercel. Before its first production build, set `VITE_WS_URL=wss://<your-render-service>.onrender.com/ws` for Production (and Preview if needed). `vercel.json` configures the Vite build output and SPA routes.
5. Redeploy both services after setting environment variables, then check the frontend's admin and audience connection indicators. Add other trusted frontend origins using comma-separated exact origins in Render's `ALLOWED_ORIGINS`.

The Vercel production build intentionally fails if `VITE_WS_URL` is missing or is not a secure `wss://.../ws` endpoint, to prevent publishing a frontend that cannot synchronize with its game server.

The Render Blueprint provisions a paid web service with a persistent disk; the disk is necessary because the local filesystem of an ephemeral service is not durable. Render's deployment, hostname, secrets, and Vercel's `VITE_WS_URL` must still be configured in their dashboards. A Git push alone does not provision the Render service.

The backend uses one Node process as the authoritative command queue and persistent JSON state. Writes use a temporary file followed by an atomic rename. Run exactly one backend instance unless the state and command path is moved to a shared transactional database/pub-sub service. The built-in admin session token is stored in `sessionStorage` and expires after 12 hours. Use HTTPS/WSS for public deployment.

## Gameplay and synchronization

- One persistent WebSocket connection per screen; no primary polling.
- Admin actions include unique action and request IDs, are acknowledged, deduplicated, processed in server order, and rejected while disconnected.
- The server persists authoritative state to `GAME_STATE_PATH` (default `data/game-state.json`) and publishes state revisions after accepted commands.
- Admin starts each wheel with an open 10-second selection window. Teacher and multiplier selections can change until the server deadline; an early confirmation also locks the current choice. If no selection is made, the server chooses a cryptographically random outcome.
- The team records anonymous individual bets with configurable minimum, default, and maximum stakes. No participant names, accounts, profiles, or player login are collected.
- After the main wheel stops, the team records a separate collect-or-risk choice for each winning bet. Collect pays that stake times the configured match multiplier. Bets marked risk share the risk-wheel result; each payout is calculated from that bet's original stake.
- The risk wheel is available at `/risk` and contains only the 0X, 3X, and 4X outcomes. Confirmed payouts are displayed before the server returns both screens to the main game for the next round.
- Wheels remain stationary until an authenticated admin starts a spin. The audience display has a non-interactive SPIN status button directly below its wheel; only admin commands can start or repeat a spin.
- At lock, the server broadcasts the selected result and a shared deceleration timestamp. Both interfaces render the same wheel component and align preview, countdown, and stop animations to authoritative server timestamps.
- Each anonymous bet is stored separately with a generated ID, teacher, stake, decision, and payout. Bets are editable only before a round begins. Individual bet details, operator selections, round history, and audit records are excluded from audience snapshots.
- A result with no bets on the winning teacher displays `NO WINNING BETS ON THIS TEACHER!`, cannot enter the risk stage, and requires explicit admin confirmation.
- The admin shows live WebSocket round-trip latency, average/maximum observed RTT, command/failure counts, and reconnect duration.
- On reconnect, each screen automatically receives the latest authoritative state.
- Operator-selected main-wheel and risk-wheel outcomes are labelled as such and recorded in the persisted audit log with their action ID, result, round, and timestamp.

PWA offline caching is for the app shell only. Game commands are intentionally disabled unless the WebSocket server is connected.

## Verification

```sh
npm run build
npm run lint
```

With the development server running and the environment variables configured in the same shell, run the WebSocket load test:

```sh
npm run test:sync
```

The test server can be isolated from event data by setting `GAME_STATE_PATH` to a temporary file before starting it. The test exercises individual stake validation and snapshots, multiple payout outcomes, full 10-second selection windows and synchronized deceleration, pause/resume and deadline enforcement, audience privacy, random fallback outcomes, no-winning-bet confirmation, audit records, payout idempotency, disconnect/reconnect recovery, and automatic return to the main game. Test again on the target Wi-Fi/network and device/browser combination before relying on a strict latency target.
