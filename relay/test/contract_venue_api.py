#!/usr/bin/env python3
"""UI/API contract test: boots the relay and validates every UI-called
endpoint against venue-api/openapi.yaml.

The venue UI (venue-web/) is read-only and calls exactly three endpoints:
  GET /v1/offers               -> OfferList
  GET /v1/offers/{offerId}      -> OfferDetail
  GET /v1/auctions/{auctionId}   -> AuctionView

This test seeds a relay (scratch DATA_DIR, ephemeral port), drives a full
lifecycle (offers -> commitment -> ack -> lock proofs -> confirmations ->
auction -> ticks -> acceptance -> outcome), then validates each response
against the OpenAPI schemas with jsonschema, INCLUDING format checks
(uuid, date-time) and patterns (BaseUnits ^\\d+$).

Documented-but-unimplemented venue endpoints (NOT called by the UI yet) are
reported as stubs, not failures:
  GET /v1/quotes, GET /v1/fillers/{address}, GET /v1/tokens,
  GET /v1/log/checkpoints (the relay serves /v1/checkpoints instead)

Usage: python3 test/contract_venue_api.py   (from relay/)
Exit 0 = contract holds; non-zero = mismatch (with details).
"""
import json
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker

HERE = Path(__file__).resolve().parent      # relay/test/
RELAY_PKG = HERE.parent                      # relay/
REPO = RELAY_PKG.parent                      # repo root
SPEC = REPO / "venue-api" / "openapi.yaml"

failures = []


def fail(msg):
    failures.append(msg)
    print(f"FAIL: {msg}")


def ok(msg):
    print(f"ok: {msg}")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Relay:
    def __init__(self):
        self.data_dir = Path(tempfile.mkdtemp(prefix="venue-contract-"))
        self.port = free_port()
        self.proc = subprocess.Popen(
            ["node", "server.js"],
            cwd=str(RELAY_PKG),
            env={
                "PATH": "/usr/bin:/bin:/usr/local/bin",
                "PORT": str(self.port),
                "DATA_DIR": str(self.data_dir),
            },
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.base = f"http://127.0.0.1:{self.port}"
        # wait for boot
        for _ in range(100):
            try:
                self.get("/v1/health")
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("relay did not boot")

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
        shutil.rmtree(self.data_dir, ignore_errors=True)

    def _req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode())
            except Exception:
                return e.code, {}

    def get(self, path):
        return self._req("GET", path)

    def post(self, path, body):
        return self._req("POST", path, body)


def load_schemas():
    doc = yaml.safe_load(SPEC.read_text())
    schemas = doc["components"]["schemas"]
    # resolve local $refs (a $ref may carry sibling annotations like description)
    def resolve(node):
        if isinstance(node, dict):
            if node.get("$ref", "").startswith("#/components/schemas/"):
                target = resolve(schemas[node["$ref"].split("/")[-1]])
                merged = dict(target)
                for k, v in node.items():
                    if k != "$ref":
                        merged[k] = resolve(v)
                return merged
            return {k: resolve(v) for k, v in node.items()}
        if isinstance(node, list):
            return [resolve(v) for v in node]
        return node
    return {name: resolve(s) for name, s in schemas.items()}


def check(name, schema, instance):
    errs = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(instance))
    if errs:
        for e in errs[:5]:
            fail(f"{name}: {e.message} (at {list(e.path)})")
        return False
    ok(f"{name} validates against openapi.yaml")
    return True


def make_offer(offer_id, **kw):
    now = int(time.time())
    o = {
        "version": 1,
        "offerId": offer_id,
        "fillMode": "direct",
        "giveChain": "base",
        "giveAsset": "native",
        "giveAmount": "1000000",
        "wantChain": "solana",
        "wantAsset": "native",
        "wantAmount": "500000",
        "minFillAmount": "1000",
        "makerAddr": "0x1234567890abcdef1234567890abcdef12345678",
        "makerRecvAddr": "0x1234567890abcdef1234567890abcdef12345678",
        "takerAddr": None,
        "takerCredential": None,
        "arbiter": None,
        "fiatLeg": None,
        "hashlock": None,
        "makerTimelockSec": 7200,
        "takerTimelockSec": 3600,
        "commitWindowSec": 300,
        "expiry": now + 3600,
        "nonce": "n1",
        "signatures": {},
    }
    o.update(kw)
    return o


def sign_acceptance(relay_dir, auction_id, tick, price, filler_addr):
    """Mint an ed25519 filler keypair and sign the acceptance core with node."""
    js = r"""
const crypto = require('node:crypto');
const { canonicalize } = require(process.env.RELAY_SRC + '/canonical');
const { acceptanceCore } = require(process.env.RELAY_SRC + '/auctions');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const body = {
  tick: Number(process.env.TICK), price: process.env.PRICE, f: '400000',
  fillerAddr: process.env.FILLER,
  fillerPubkey: publicKey.export({format:'der',type:'spki'}).toString('hex'),
};
body.sig = crypto.sign(null, Buffer.from(canonicalize(
  acceptanceCore(process.env.AUCTION_ID, body)), 'utf8'), privateKey).toString('hex');
console.log(JSON.stringify(body));
"""
    env = {
        "PATH": "/usr/bin:/bin:/usr/local/bin",
        "RELAY_SRC": str(Path(relay_dir) / "src"),
        "AUCTION_ID": auction_id, "TICK": str(tick),
        "PRICE": price, "FILLER": filler_addr,
    }
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, env=env, timeout=30)
    if out.returncode != 0:
        raise RuntimeError(f"acceptance signing failed: {out.stderr}")
    return json.loads(out.stdout)


def main():
    schemas = load_schemas()
    relay = Relay()
    try:
        # ---------- seed: two offers ----------
        oid1, oid2 = str(uuid.uuid4()), str(uuid.uuid4())
        s, r = relay.post("/v1/offers", make_offer(oid1))
        assert s == 201, f"offer1 post failed: {s} {r}"
        s, r = relay.post("/v1/offers", make_offer(
            oid2, fillMode="solver",
            arbiter="0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            fiatLeg={"currency": "USD", "rails": "ach", "providerId": "ramp-1"},
        ))
        assert s == 201, f"offer2 post failed: {s} {r}"
        ok("seeded 2 offers (direct + solver/mediated/fiat)")

        # ---------- seed: fill lifecycle on offer1 ----------
        commit = {"f": "200000", "fillNonce": "contract-n1",
                  "takerAddrs": {"giveChain": "base", "wantChain": "solana"}}
        s, r = relay.post(f"/v1/offers/{oid1}/commitments", commit)
        assert s in (200, 201), f"commitment failed: {s} {r}"
        fill_id = r["fillId"]
        ack = {"fillNonce": "contract-n1", "f": "200000",
               "reservedUntil": int(time.time()) + 300}
        s, r = relay.post(f"/v1/offers/{oid1}/acks", ack)
        assert s in (200, 201), f"ack failed: {s} {r}"
        h = "ab" * 32
        for side, chain, txid in (("maker", "base", "0xaaa"), ("taker", "solana", "sol-tx-1")):
            s, r = relay.post("/v1/lock-proofs",
                              {"fillId": fill_id, "chain": chain, "txid": txid, "h": h, "side": side})
            assert s in (200, 201), f"mirror {side} failed: {s} {r}"
            s, r = relay.post("/v1/lock-proofs/confirm",
                              {"fillId": fill_id, "side": side, "chain": chain, "txid": txid,
                               "blockHeight": 4242, "h": h, "watcherId": "contract-test"})
            assert s in (200, 201), f"confirm {side} failed: {s} {r}"
        ok("seeded fill lifecycle: committed -> makerLocked -> takerLocked -> claimed")

        # ---------- seed: auction on offer2 ----------
        s, r = relay.post("/v1/auctions", {"offerId": oid2, "startPrice": "1500000",
                                           "auctionWindowSec": 60, "auctionFloorBps": 500,
                                           "lockWindowSec": 120})
        assert s == 201, f"auction open failed: {s} {r}"
        auc = r["auctionId"]
        relay.post(f"/v1/auctions/{auc}/ticks", {})
        s, r = relay.post(f"/v1/auctions/{auc}/ticks", {})
        tick_price = r["tick"]["price"]
        acc = sign_acceptance(RELAY_PKG, auc, 2, tick_price,
                              "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        s, r = relay.post(f"/v1/auctions/{auc}/acceptances", acc)
        assert s in (200, 201), f"acceptance failed: {s} {r}"
        s, r = relay.get(f"/v1/auctions/{auc}/outcome")
        assert s == 200, f"outcome failed: {s} {r}"
        ok("seeded auction: 2 ticks + signed acceptance + outcome (settled)")

        # ---------- contract checks ----------
        # 1. GET /v1/offers -> OfferList
        s, body = relay.get("/v1/offers")
        assert s == 200, f"GET /v1/offers -> {s}"
        good = check("GET /v1/offers", schemas["OfferList"], body)
        if good:
            assert body["total"] == 2 and len(body["offers"]) == 2
            assert body["page"] == 1 and isinstance(body["limit"], int)
            # badges on the mediated/fiat offer
            o2 = next(o for o in body["offers"] if o["offerId"] == oid2)
            assert o2["badges"]["isMediated"] is True
            assert o2["badges"]["hasFiatLeg"] is True
            assert o2["advisory"]["status"] == "open"
            # expiry is a string per the contract (relay stores an integer)
            assert isinstance(o2["expiry"], str)
            ok("OfferList pagination/filter/badges/advisory spot-checks")

        # 2. GET /v1/offers with filters + pagination
        s, body = relay.get("/v1/offers?fillMode=solver&limit=1&page=1")
        assert s == 200 and body["total"] == 1 and len(body["offers"]) == 1
        assert body["offers"][0]["fillMode"] == "solver"
        s, body = relay.get("/v1/offers?mediated=true")
        assert s == 200 and body["total"] == 1
        s, body = relay.get("/v1/offers?page=5&limit=10")
        assert s == 200 and body["offers"] == [] and body["total"] == 2
        ok("GET /v1/offers filters + pagination")

        # 3. GET /v1/offers/{offerId} -> OfferDetail
        s, body = relay.get(f"/v1/offers/{oid1}")
        assert s == 200, f"GET /v1/offers/{{id}} -> {s}"
        if check("GET /v1/offers/{offerId}", schemas["OfferDetail"], body):
            assert body["offer"]["offerId"] == oid1
            assert len(body["fills"]) == 1
            fv = body["fills"][0]
            assert fv["fillId"] == fill_id
            assert fv["phase"] == "claimed"
            assert fv["hashlock"] == h
            assert fv["lockProofs"]["makerLock"] == {"txid": "0xaaa", "blockHeight": 4242}
            assert fv["lockProofs"]["takerLock"]["blockHeight"] == 4242
            ok("OfferDetail fills spot-checks (claimed + lock proofs)")

        # 4. GET /v1/auctions/{auctionId} -> AuctionView
        s, body = relay.get(f"/v1/auctions/{auc}")
        assert s == 200, f"GET /v1/auctions/{{id}} -> {s}"
        if check("GET /v1/auctions/{auctionId}", schemas["AuctionView"], body):
            assert body["status"] == "settled"
            assert len(body["ticks"]) == 2
            assert re.fullmatch(r"\d+", body["ticks"][0]["price"]), "tick price not BaseUnits"
            assert len(body["acceptances"]) == 1
            assert body["outcome"]["winner"] == "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            assert body["winnerRule"] == "sort (tick ASC, sha256(fillerAddr) ASC)"
            ok("AuctionView settled/outcome/winnerRule spot-checks")

        # 5. 404s carry the Error schema
        s, body = relay.get("/v1/offers/does-not-exist")
        assert s == 404
        check("GET /v1/offers/{id} 404", schemas["Error"], body)
        s, body = relay.get("/v1/auctions/does-not-exist")
        assert s == 404
        check("GET /v1/auctions/{id} 404", schemas["Error"], body)

        # ---------- documented stubs (not called by the UI) ----------
        print("\n--- documented-but-unimplemented venue endpoints (UI does not call these) ---")
        for path, note in [
            ("/v1/quotes", "no quote engine"),
            ("/v1/fillers/0xabc", "no filler registry"),
            ("/v1/tokens", "no token registry"),
            ("/v1/log/checkpoints", "relay serves /v1/checkpoints instead"),
        ]:
            s, _ = relay.get(path)
            print(f"  {path} -> HTTP {s} ({note})")
    finally:
        relay.close()

    if failures:
        print(f"\nCONTRACT FAILED: {len(failures)} mismatch(es)")
        return 1
    print("\nCONTRACT OK: all UI-called endpoints conform to venue-api/openapi.yaml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
