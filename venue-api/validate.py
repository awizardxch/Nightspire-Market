#!/usr/bin/env python3
"""Structural validation for the Nightspire Marketplace Venue API contract.

1. openapi.yaml parses as YAML and has valid OpenAPI structure
   (openapi/info/paths/components; every local $ref resolves).
2. The seven venue endpoints and the key reusable schemas exist.
3. Each examples/*.json parses and validates (jsonschema) against the
   response schema of its endpoint.
"""
import json
import re
import sys
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent
SPEC = ROOT / "openapi.yaml"

EXPECTED_PATHS = {
    "/v1/offers": ["get"],
    "/v1/offers/{offerId}": ["get"],
    "/v1/quotes": ["get"],
    "/v1/auctions/{auctionId}": ["get"],
    "/v1/fillers/{address}": ["get"],
    "/v1/tokens": ["get"],
    "/v1/log/checkpoints": ["get"],
}

EXPECTED_SCHEMAS = [
    "CrossChainOffer", "OfferWithAdvisory", "OfferAdvisory", "OfferBadges",
    "FillView", "OfferDetail", "OfferList",
    "AuctionTick", "Acceptance", "AuctionOutcome", "AuctionView",
    "FillerProfile", "TokenEntry", "TokenList", "QuoteResponse",
    "Checkpoint", "CheckpointList", "ChainId", "BaseUnits",
    "FillMode", "OfferStatus", "FillPhase", "Standing",
    "LegValidationStatus", "Error",
]

# example file -> (path, method, status, schema inside the 200 response)
EXAMPLES = {
    "offer-partial-fill.json": ("/v1/offers", "get", "200", "OfferList"),
    "offer-mediated-arbiter.json": ("/v1/offers/{offerId}", "get", "200", "OfferDetail"),
    "auction-outcome.json": ("/v1/auctions/{auctionId}", "get", "200", "AuctionView"),
}

failures = []


def fail(msg):
    failures.append(msg)
    print(f"FAIL: {msg}")


def ok(msg):
    print(f"ok: {msg}")


def collect_refs(node, refs):
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            refs.add(ref)
        for v in node.values():
            collect_refs(v, refs)
    elif isinstance(node, list):
        for v in node:
            collect_refs(v, refs)


def main():
    # 1. YAML parses
    try:
        doc = yaml.safe_load(SPEC.read_text())
    except Exception as e:  # noqa: BLE001
        fail(f"openapi.yaml does not parse as YAML: {e}")
        return 1
    ok("openapi.yaml parses as YAML")

    # 2. top-level OpenAPI structure
    if not isinstance(doc, dict):
        fail("document root is not a mapping")
        return 1
    if not re.fullmatch(r"3\.1\.\d+", str(doc.get("openapi", ""))):
        fail(f"openapi version is not 3.1.x: {doc.get('openapi')!r}")
    else:
        ok(f"openapi version {doc['openapi']}")
    info = doc.get("info", {})
    if info.get("title") != "Nightspire Marketplace Venue API":
        fail(f"info.title mismatch: {info.get('title')!r}")
    else:
        ok("info.title = Nightspire Marketplace Venue API")
    if not str(info.get("version", "")).startswith("1.0.0"):
        fail(f"info.version mismatch: {info.get('version')!r}")
    else:
        ok(f"info.version = {info.get('version')}")
    for key in ("paths", "components"):
        if key not in doc:
            fail(f"missing top-level key: {key}")
    if failures:
        return 1
    ok("top-level keys present (paths, components)")

    # 3. expected endpoints
    paths = doc["paths"]
    for path, methods in EXPECTED_PATHS.items():
        if path not in paths:
            fail(f"missing path {path}")
            continue
        for m in methods:
            if m not in paths[path]:
                fail(f"missing {m.upper()} {path}")
        else:
            ok(f"{path} present")

    # 4. expected schemas
    schemas = doc["components"].get("schemas", {})
    for name in EXPECTED_SCHEMAS:
        if name not in schemas:
            fail(f"missing schema {name}")
    if not any(f.startswith("missing schema") for f in failures):
        ok(f"all {len(EXPECTED_SCHEMAS)} expected schemas present")

    # 5. all local $refs resolve
    refs = set()
    collect_refs(doc, refs)
    local_refs = {r for r in refs if r.startswith("#/components/schemas/")}
    for r in sorted(local_refs):
        name = r.split("/")[-1]
        if name not in schemas:
            fail(f"unresolved $ref: {r}")
    if not any("unresolved $ref" in f for f in failures):
        ok(f"all {len(local_refs)} local $refs resolve")

    # 6. examples parse + validate against response schemas
    # Build a resolver-friendly schema store from components
    store = {
        "#/components/schemas/" + name: schema
        for name, schema in schemas.items()
    }

    class _RefOnlyResolver:  # minimal: jsonschema resolves via registry instead
        pass

    from jsonschema import validators

    def validator_for(schema_name):
        # Inline all local refs by deep-copying schema with definitions
        schema = json.loads(json.dumps(schemas[schema_name]))
        schema["$defs"] = {n: s for n, s in schemas.items() if n != schema_name}

        def _rewrite(node):
            if isinstance(node, dict):
                ref = node.get("$ref")
                if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
                    target = ref.split("/")[-1]
                    node.clear()
                    node["$ref"] = f"#/$defs/{target}"
                for v in node.values():
                    _rewrite(v)
            elif isinstance(node, list):
                for v in node:
                    _rewrite(v)

        _rewrite(schema)
        return Draft202012Validator(schema)

    for fname, (path, method, status, schema_name) in EXAMPLES.items():
        fpath = ROOT / "examples" / fname
        try:
            payload = json.loads(fpath.read_text())
        except Exception as e:  # noqa: BLE001
            fail(f"{fname} does not parse as JSON: {e}")
            continue
        ok(f"{fname} parses as JSON")
        try:
            resp_schema = paths[path][method]["responses"][status]["content"][
                "application/json"
            ]["schema"]
        except KeyError as e:
            fail(f"{fname}: response schema lookup failed at {e}")
            continue
        # sanity: the operation's schema should reference the expected schema
        ref = resp_schema.get("$ref", "")
        if schema_name not in ref:
            fail(f"{fname}: operation schema {ref!r} != expected {schema_name}")
            continue
        validator = validator_for(schema_name)
        errors = sorted(validator.iter_errors(payload), key=lambda e: list(e.path))
        if errors:
            for e in errors[:8]:
                fail(f"{fname}: {'/'.join(map(str, e.path)) or '<root>'}: {e.message[:160]}")
        else:
            ok(f"{fname} validates against {schema_name}")

    # 7. spot-checks on key enums the UI depends on
    chain_enum = schemas["ChainId"].get("enum", [])
    for c in ("robinhood", "base", "ethereum", "solana", "chia",
              "robinhood-testnet", "base-sepolia", "ethereum-sepolia",
              "solana-devnet", "chia-testnet11"):
        if c not in chain_enum:
            fail(f"ChainId missing {c}")
    if not any(f.startswith("ChainId missing") for f in failures):
        ok("ChainId enum covers mainnet + testnet variants")
    if schemas["AuctionView"]["properties"]["winnerRule"].get("const") != \
            "sort (tick ASC, sha256(fillerAddr) ASC)":
        fail("AuctionView.winnerRule const mismatch")
    else:
        ok("AuctionView.winnerRule const matches spec §8")

    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
