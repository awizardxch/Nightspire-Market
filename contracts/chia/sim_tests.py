#!/usr/bin/env python3
"""Nightspire Chia HTLC — simulator test suite (consensus lane).

Runs the committed htlc.hex against `chia._tests.util.spend_sim`: the real
mempool manager and coin store from chia-blockchain, with real BLS AGG_SIG_ME
signatures. Where `run_tests.py` checks condition *structure* with `brun`,
this suite checks what consensus actually does with those conditions, and
pins the refusal code of every attack beside its honest control:

  * a 33-byte (or 1-byte) preimage is refused even though sha256 matches
  * a refund whose PAYLOAD is not () is refused
  * AMOUNT below (or above) the coin's value is refused: ASSERT_MY_AMOUNT_FAILED
  * before TIMELOCK a claim is accepted and a refund is refused
    (ASSERT_SECONDS_RELATIVE_FAILED); after it a claim is refused
    (ASSERT_BEFORE_SECONDS_RELATIVE_FAILED) and a refund is accepted
  * a lock and its claim in ONE bundle are refused (EPHEMERAL_RELATIVE_CONDITION)
    and accepted as two bundles
  * created coins are discoverable through the CREATE_COIN hint
  * an arbitrate payout pair with a trailing element is refused

Requires chia-blockchain (not in requirements.txt — it is a full-node
package, far heavier than the brun toolchain). Without it this script exits 2.

    python3 sim_tests.py [path/to/htlc.hex]

NO network: the simulator is an in-process chain. Keys are throwaway.
"""
import asyncio
import hashlib
import logging
import sys
from pathlib import Path

try:
    from chia._tests.util.spend_sim import sim_and_client
    from chia.types.blockchain_format.coin import Coin
    from chia.types.blockchain_format.program import Program
    from chia.types.coin_spend import make_spend
    from chia.types.mempool_inclusion_status import MempoolInclusionStatus as MIS
    from chia_rs import AugSchemeMPL, G2Element, SpendBundle
    from chia_rs.sized_bytes import bytes32
except ImportError as e:  # pragma: no cover - environment check
    sys.stderr.write(
        f"sim_tests.py: chia-blockchain is not importable ({e}).\n"
        "Install chia-blockchain (e.g. `pip install chia-blockchain==2.5.6` in a "
        "separate venv) to run the simulator lane. Exiting 2: NOT a pass.\n")
    sys.exit(2)

HERE = Path(__file__).resolve().parent
HEX_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "htlc.hex"
MOD = Program.fromhex(HEX_PATH.read_text().strip())
TIMELOCK = 300  # seconds — short so the simulator can pass it

# Throwaway keys — generated fresh, never persisted, never funded.
SK_C = AugSchemeMPL.key_gen(b"\x11" * 32); PK_C = SK_C.get_g1()   # claimer
SK_R = AugSchemeMPL.key_gen(b"\x22" * 32); PK_R = SK_R.get_g1()   # refunder
SK_A = AugSchemeMPL.key_gen(b"\x33" * 32); PK_A = SK_A.get_g1()   # arbiter
CLAIM_PH = bytes32(b"\xaa" * 32)
REFUND_PH = bytes32(b"\xbb" * 32)
FILL_ID = bytes32(b"\xcc" * 32)
PH1, PH2 = bytes32(b"\xdd" * 32), bytes32(b"\xee" * 32)
S32 = b"s" * 32                     # honest 32-byte preimage
ANYONE = Program.to(1)              # (1): returns its solution as the conditions

RESULTS = []


def ib(n):
    """CLVM minimal big-endian; the canonical zero is the empty atom."""
    if n == 0:
        return b""
    return n.to_bytes((n.bit_length() + 8) // 8, "big", signed=True)


def sig_msg(tag, dest_ph, amount):
    return hashlib.sha256(b"NS-HTLC-v1" + FILL_ID + tag + dest_ph + ib(amount)).digest()


def arb_msg(payouts):
    acc = b""
    for ph, amt in payouts:
        acc = hashlib.sha256(acc + ph + ib(amt)).digest()
    return hashlib.sha256(b"arbitrate" + FILL_ID + acc).digest()


def htlc(preimage, arbiter=None):
    hashlock = hashlib.sha256(preimage).digest()
    return MOD.curry(hashlock, TIMELOCK, bytes(PK_C), bytes(PK_R),
                     CLAIM_PH, REFUND_PH, FILL_ID, arbiter)


def claim_spend(coin, puzzle, preimage, amount, add):
    sol = Program.to([0, preimage, amount])
    sig = AugSchemeMPL.sign(SK_C, sig_msg(b"claim", CLAIM_PH, amount) + coin.name() + add)
    return make_spend(coin, puzzle, sol), sig


def refund_spend(coin, puzzle, amount, add, payload=None):
    sol = Program.to([1, payload, amount])
    sig = AugSchemeMPL.sign(SK_R, sig_msg(b"refund", REFUND_PH, amount) + coin.name() + add)
    return make_spend(coin, puzzle, sol), sig


def arbitrate_spend(coin, puzzle, sol_payouts, signed_payouts, amount, add):
    sol = Program.to([2, sol_payouts, amount])
    sig = AugSchemeMPL.sign(SK_A, arb_msg(signed_payouts) + coin.name() + add)
    return make_spend(coin, puzzle, sol), sig


async def fund(sim, client, puzzle):
    """Farm a block whose rewards pay `puzzle`; return its unspent coins, largest first."""
    ph = puzzle.get_tree_hash()
    await sim.farm_block(ph)
    recs = await client.get_coin_records_by_puzzle_hash(ph, include_spent_coins=False)
    return sorted((r.coin for r in recs), key=lambda c: c.amount, reverse=True)


async def push(client, sim, label, spends, sigs, expect):
    """Push a bundle; `expect` is "ACCEPTED" or the pinned Err name of the refusal."""
    agg = AugSchemeMPL.aggregate(sigs) if sigs else G2Element()
    status, err = await client.push_tx(SpendBundle(spends, agg))
    if status == MIS.SUCCESS:
        verdict = "ACCEPTED"
    else:
        verdict = f"REFUSED {err.name if err else err}"
    ok = verdict == expect or verdict == f"REFUSED {expect}"
    RESULTS.append((label, ok))
    print(f"  [{'ok ' if ok else 'XX '}] {label}: {verdict}"
          + ("" if ok else f"   (expected {expect})"))
    if status == MIS.SUCCESS:
        await sim.farm_block()
    return status == MIS.SUCCESS


def note(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    print(f"  [{'ok ' if ok else 'XX '}] {name}" + (f": {detail}" if detail else ""))


async def main():
    logging.disable(logging.WARNING)  # the simulator's mempool chatter
    async with sim_and_client() as (sim, client):
        add = sim.defaults.AGG_SIG_ME_ADDITIONAL_DATA
        print(f"simulator up; htlc mod hash {MOD.get_tree_hash().hex()}")

        print("\n== control: honest 32-byte claim accepted; wrong preimage refused")
        P = htlc(S32)
        coins = await fund(sim, client, P)
        sp, sg = claim_spend(coins[0], P, b"x" * 32, coins[0].amount, add)
        await push(client, sim, "wrong preimage (32 bytes)", [sp], [sg], "GENERATOR_RUNTIME_ERROR")
        sp, sg = claim_spend(coins[0], P, S32, coins[0].amount, add)
        await push(client, sim, "correct 32-byte preimage", [sp], [sg], "ACCEPTED")
        by_hint = await client.get_coin_records_by_hint(CLAIM_PH, include_spent_coins=False)
        note("claimed coin is discoverable by hint == CLAIM_PH",
             any(r.coin.amount == coins[0].amount and r.coin.puzzle_hash == CLAIM_PH for r in by_hint),
             f"{len(by_hint)} coin(s) found by hint")

        print("\n== N1: preimage must be exactly 32 bytes (EVM bytes32 / Solana [u8; 32])")
        for n in (33, 1):
            s = bytes([n % 251]) * n
            P = htlc(s)
            coins = await fund(sim, client, P)
            sp, sg = claim_spend(coins[0], P, s, coins[0].amount, add)
            await push(client, sim, f"claim with {n}-byte preimage (sha256 matches)",
                       [sp], [sg], "GENERATOR_RUNTIME_ERROR")

        print("\n== N2: claim only BEFORE the timelock, refund only FROM it")
        P = htlc(S32)
        coins = await fund(sim, client, P)
        a, b = coins[0], coins[1]
        sp, sg = refund_spend(a, P, a.amount, add)
        await push(client, sim, "refund before timelock", [sp], [sg], "ASSERT_SECONDS_RELATIVE_FAILED")
        sp, sg = claim_spend(a, P, S32, a.amount, add)
        await push(client, sim, "claim before timelock", [sp], [sg], "ACCEPTED")
        sim.pass_time(TIMELOCK + 60)
        await sim.farm_block()
        sp, sg = claim_spend(b, P, S32, b.amount, add)
        await push(client, sim, "claim after timelock", [sp], [sg], "ASSERT_BEFORE_SECONDS_RELATIVE_FAILED")
        sp, sg = refund_spend(b, P, b.amount, add)
        await push(client, sim, "refund after timelock", [sp], [sg], "ACCEPTED")
        by_hint = await client.get_coin_records_by_hint(REFUND_PH, include_spent_coins=False)
        note("refunded coin is discoverable by hint == REFUND_PH",
             any(r.coin.amount == b.amount and r.coin.puzzle_hash == REFUND_PH for r in by_hint),
             f"{len(by_hint)} coin(s) found by hint")

        print("\n== N4: refund PAYLOAD must be ()")
        P = htlc(S32)
        coins = await fund(sim, client, P)
        sim.pass_time(TIMELOCK + 60)
        await sim.farm_block()
        sp, sg = refund_spend(coins[0], P, coins[0].amount, add, payload=b"J" * 500)
        await push(client, sim, "refund with 500-byte junk PAYLOAD", [sp], [sg], "GENERATOR_RUNTIME_ERROR")
        sp, sg = refund_spend(coins[0], P, coins[0].amount, add, payload=[b"a", [b"b", b"c"]])
        await push(client, sim, "refund with a list PAYLOAD", [sp], [sg], "GENERATOR_RUNTIME_ERROR")
        sp, sg = refund_spend(coins[0], P, coins[0].amount, add)
        await push(client, sim, "refund with () PAYLOAD (control)", [sp], [sg], "ACCEPTED")

        print("\n== N8: AMOUNT must equal the coin's value (ASSERT_MY_AMOUNT)")
        P = htlc(S32)
        coins = await fund(sim, client, P)
        c = coins[0]
        sp, sg = claim_spend(c, P, S32, c.amount - 12345, add)
        await push(client, sim, "claim with AMOUNT = coin.amount - 12345", [sp], [sg], "ASSERT_MY_AMOUNT_FAILED")
        sp, sg = claim_spend(c, P, S32, c.amount + 1, add)
        await push(client, sim, "claim with AMOUNT = coin.amount + 1", [sp], [sg], "ASSERT_MY_AMOUNT_FAILED")
        sp, sg = claim_spend(c, P, S32, c.amount, add)
        await push(client, sim, "claim with AMOUNT = coin.amount (control)", [sp], [sg], "ACCEPTED")

        print("\n== N4/N7: arbitrate payout pairs are exactly (ph amt) with a 32-byte ph")
        PA = htlc(S32, arbiter=bytes(PK_A))
        coins = await fund(sim, client, PA)
        c = coins[0]
        half, rest = c.amount // 2, c.amount - c.amount // 2
        payouts = [(PH1, half), (PH2, rest)]
        sp, sg = arbitrate_spend(c, PA, [[PH1, half, b"junk"], [PH2, rest]], payouts, c.amount, add)
        await push(client, sim, "arbitrate with a trailing element in a payout pair",
                   [sp], [sg], "GENERATOR_RUNTIME_ERROR")
        sp, sg = arbitrate_spend(c, PA, [[PH1[:31], half], [PH2, rest]], [(PH1[:31], half), (PH2, rest)],
                                 c.amount, add)
        await push(client, sim, "arbitrate with a 31-byte payout puzzle hash",
                   [sp], [sg], "GENERATOR_RUNTIME_ERROR")
        # the N8 burn: an under-total vector with an under-stated AMOUNT passes
        # the puzzle's `total <= AMOUNT` rule; ASSERT_MY_AMOUNT must catch it
        under = [(PH1, half - 1), (PH2, rest)]
        sp, sg = arbitrate_spend(c, PA, [list(p) for p in under], under, c.amount - 1, add)
        await push(client, sim, "arbitrate with payouts and AMOUNT both coin.amount - 1",
                   [sp], [sg], "ASSERT_MY_AMOUNT_FAILED")
        sp, sg = arbitrate_spend(c, PA, [list(p) for p in payouts], payouts, c.amount, add)
        await push(client, sim, "arbitrate with a well-formed payout vector (control)", [sp], [sg], "ACCEPTED")
        by_hint = await client.get_coin_records_by_hint(PH1, include_spent_coins=False)
        note("arbitrate payout coin is discoverable by hint == its puzzle hash",
             any(r.coin.amount == half for r in by_hint), f"{len(by_hint)} coin(s) found by hint")

        print("\n== E1: lock and claim cannot share a bundle (relative BEFORE on an ephemeral coin)")
        P = htlc(S32)
        htlc_ph = P.get_tree_hash()
        src = (await fund(sim, client, ANYONE))[0]
        lock_amount = src.amount
        lock = make_spend(src, ANYONE, Program.to([[51, htlc_ph, lock_amount, [htlc_ph]]]))
        child = Coin(src.name(), htlc_ph, lock_amount)
        sp, sg = claim_spend(child, P, S32, lock_amount, add)
        await push(client, sim, "lock + claim in ONE bundle", [lock, sp], [sg], "EPHEMERAL_RELATIVE_CONDITION")
        await push(client, sim, "lock alone (bundle 1)", [lock], [], "ACCEPTED")
        sp, sg = claim_spend(child, P, S32, lock_amount, add)
        await push(client, sim, "claim in a later block (bundle 2)", [sp], [sg], "ACCEPTED")

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} simulator checks passed"
          + (f"; FAILED: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
