# Deploying Nightspire Market (Vercel + Railway)

Two services, one repo:

| Service | Code | Host | Why |
|---|---|---|---|
| Relay — venue API + auction ticks | `relay/` (Node, stdlib only) | Railway | Long-running process with streaming endpoints; doesn't fit serverless |
| Venue web — offer board UI | `venue-web/` (static HTML/JS/CSS) | Vercel | Pure static site, no build step |

The venue page is **read-only**: it only issues `GET` requests. Fills are built
and signed in the user's own wallet — see `venue-web` → "How fills work".

## 1. Relay on Railway

1. Railway → **New Project** → **Deploy from GitHub repo** →
   `awizardxch/Nightspire-Market`.
2. Service **Settings** → **Root Directory**: `relay/`.
   (Nixpacks auto-detects Node and runs `npm start` → `node server.js`.
   Railway injects `PORT`; the relay already listens on `process.env.PORT`.)
3. **Settings** → **Networking** → generate a public domain.
   Note the URL, e.g. `https://nightspire-relay.up.railway.app`.
4. **Healthcheck**: set the healthcheck path to `/v1/health`.
5. **Persistence (recommended)**: add a **Volume**, mount path `/data`, and set
   the env var `DATA_DIR=/data`. Offers and the relay identity key are stored
   under `DATA_DIR`; without a volume they vanish on restart/redeploy
   (the board still works, it just starts empty each time).
6. Deploy, then confirm: `curl https://<your-relay-url>/v1/health`.

### Seed sample offers (one-time)

From a checkout of this repo (needs Node 24+):

```bash
cd relay
node scripts/seed_offers.js https://<your-relay-url>
```

Posts two signed sample offers (`sample-offer-evm`, `sample-offer-sol`,
30-day expiry) with `VERIFIED` signature statuses. Idempotent — re-running
skips offers that already exist. Real offers are posted by makers' own
tooling via `POST /v1/offers` (see `relay/scripts/smoke.sh` for the format).

## 2. Venue web on Vercel

1. Vercel → **Add New** → **Project** → Import `awizardxch/Nightspire-Market`.
2. **Root Directory**: `venue-web`.
3. **Build Command**: `node build.mjs`. (No output directory — it's static;
   the build step just bakes the relay URL into `config.js`.)
4. **Environment Variables**: add `NIGHTSPIRE_RELAY_URL` =
   `https://<your-railway-url>`. The site is fixed to this relay at build
   time — there is no relay input or switching in the UI. (Fork the repo
   to point a deployment somewhere else.)
5. Deploy and open the site: the board loads straight from the relay, with
   only a small connection-status pill in the header.

## Notes

- The relay already sends `Access-Control-Allow-Origin: *`, so the Vercel
  frontend can call it cross-origin with no extra config.
- The relay generates its Ed25519 identity key on first boot
  (`<DATA_DIR>/relay-key.json`). The venue page fetches the current key from
  `/v1/health` for in-browser tick-chain verification — pinning a stable key
  is exactly what the Railway volume is for.
- Auction tick streams (`GET /v1/auctions/{id}/stream`) are long-lived
  connections: that's why the relay lives on Railway, not Vercel serverless.
