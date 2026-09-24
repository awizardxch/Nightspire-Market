# Nightspire Market — venue UI

A static, **read-only** offer board for the Nightspire cross-chain marketplace.
No build step, no dependencies, no wallet connection, no signing.

## Run it

```bash
cd venue-web
python3 -m http.server 8080
# open http://localhost:8080
```

Start the relay first (default `http://localhost:8787`):

```bash
cd ../relay
node server.js
```

Point the page at a different relay with the **Relay** box in the header,
or via `?relay=http://host:port`. The relay must send
`Access-Control-Allow-Origin` (it does — see `relay/server.js` `send()`).

## What it does

- **Offer board** (`#/`): live `OfferList` with chain / fill-mode / mediated /
  fiat-only filters and pagination; per-offer advisory progress (filled vs
  remaining) and status badges.
- **Offer detail** (`#/offer/{offerId}`): full terms, `OfferDetail` fills with
  phase badges (committed → makerLocked → takerLocked → claimed), lock-proof
  evidence, offer signature statuses, mediated/fiat warnings, and
  **copy-only** actions: copy offer JSON, copy a fill-commitment template,
  deep link to the offer.
- **Auction** (`#/auction/{auctionId}`): `AuctionView` with tick table,
  acceptances re-sorted in your browser by the deterministic winner rule
  (`tick ASC, sha256(fillerAddr) ASC`), signed outcome + exclusive window, and
  a **"Verify tick chain in browser"** button that recomputes every tickHash,
  the `prevTickHash` linkage from `GENESIS`, and every ed25519 relay signature
  against the relay's pinned identity key from `/v1/health` (WebCrypto; graceful
  fallback message when unavailable).
- **How fills work** (`#/about`): the read-only fill flow.

## Read-only guarantee

`app.js` only ever issues **HTTP GET** requests. There is no POST/PUT/DELETE,
no key handling, no transaction submission anywhere in this directory. To fill
an offer, copy the terms and sign in your own wallet or agent, then submit
through your own tooling. Relay data is advisory — verify signatures and
chain state locally before locking funds (spec §12).

## Endpoints used (all GET, from `venue-api/openapi.yaml`)

- `/v1/offers` → `OfferList` (filters + pagination)
- `/v1/offers/{offerId}` → `OfferDetail` (offer + fills)
- `/v1/auctions/{auctionId}` → `AuctionView` (ticks + acceptances + outcome)
- `/v1/health` → relay identity (public key for in-browser verification)

The page is tested headlessly against a seeded relay
(`node --check` + render harness: 19/19 checks, including the WebCrypto
tick-chain verification path).
