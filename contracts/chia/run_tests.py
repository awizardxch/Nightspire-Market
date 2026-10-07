#!/usr/bin/env python3
"""Nightspire Chia HTLC — local structural test suite.

Local tooling only: compiles with clvm_tools, executes with `brun`,
signs/verifies with throwaway blspy keys. NO chain interaction, NO mints,
NO persisted keys.

What this suite proves:
  * both puzzles compile from source and contain no unresolved symbols
  * the committed `.hex` files are byte-identical to a fresh build (the
    committed hex is the canonical artefact; drift fails the suite — run
    `run_tests.py --write-hex` to regenerate it deliberately)
  * curry is deterministic and fill-sensitive
  * every branch emits exactly the specified conditions (via brun), every
    CREATE_COIN carries its hint memo, and every malformed solution raises
  * every AGG_SIG_ME message byte-matches an independent Python
    implementation, and real BLS signatures verify accept/reject correctly
  * the HTLC reveal / puzzle hash / solution embedded in
    spend_bundle_template.json are real outputs of this build

What it does NOT prove (see sim_tests.py for the simulator lane, and
testnet11 for the real network):
  * consensus enforcement of AGG_SIG_ME, ASSERT_MY_AMOUNT and the
    ASSERT_SECONDS_RELATIVE / ASSERT_BEFORE_SECONDS_RELATIVE pair
  * time-wall behavior of the relative timelocks
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from io import BytesIO
from pathlib import Path

from blspy import AugSchemeMPL
from clvm import KEYWORD_TO_ATOM
from clvm.SExp import SExp
from clvm.serialize import sexp_from_stream
from clvm_tools import binutils
from clvm_tools.clvmc import compile_clvm_text
from clvm_tools.curry import curry
from chia_rs import Program

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "spend_bundle_template.json"
# `brun` ships as a console script with clvm_tools. Prefer PATH (CI installs
# pip packages system-wide) and fall back to the pip --user location so
# existing local setups keep working.
BRUN = shutil.which("brun") or str(Path.home() / ".local" / "bin" / "brun")
if not Path(BRUN).exists():
    sys.exit(
        f"error: `brun` not found (looked on PATH and at {BRUN}). "
        "Install it with: pip install -r contracts/chia/requirements.txt"
    )

# ---------------------------------------------------------------- test vectors
# Throwaway keys — generated fresh, never persisted, never funded.
SK_C = AugSchemeMPL.key_gen(b"\x11" * 32)   # claimer
SK_R = AugSchemeMPL.key_gen(b"\x22" * 32)   # refunder
SK_A = AugSchemeMPL.key_gen(b"\x33" * 32)   # arbiter
PK_C, PK_R, PK_A = (bytes(sk.get_g1()) for sk in (SK_C, SK_R, SK_A))

# Cross-chain invariant: the preimage is exactly 32 bytes on every leg
# (EVM `withdraw(bytes32)`, Solana `[u8; 32]`, Chia `(strlen s) == 32`).
PREIMAGE = b"nightspire-test-secret-00000001."
assert len(PREIMAGE) == 32
HASHLOCK = hashlib.sha256(PREIMAGE).digest()
FILL_ID = hashlib.sha256(b"offer-123" + b"fill-nonce-1").digest()
CLAIM_PH = bytes.fromhex("aa" * 32)
REFUND_PH = bytes.fromhex("bb" * 32)
AMOUNT = 600_000
T1_TIMELOCK = 43_200   # spec §9: Any↔Chia first (maker) leg = 12h
T2_TIMELOCK = 21_600   # spec §9: second leg = 6h

ATOM_FOR_OPCODE = {v[0]: k for k, v in KEYWORD_TO_ATOM.items() if len(v) == 1}

# Condition opcodes (chia consensus)
AGG_SIG_ME = 50
CREATE_COIN = 51
CREATE_PUZZLE_ANNOUNCEMENT = 62
ASSERT_MY_AMOUNT = 73
ASSERT_SECONDS_RELATIVE = 80
ASSERT_BEFORE_SECONDS_RELATIVE = 84

# ------------------------------------------------------------ small s-expr I/O
def sexp_hex(h):
    return sexp_from_stream(BytesIO(bytes.fromhex(h)), SExp.to)


def read_hex(p):
    return re.sub(r"\s", "", Path(p).read_text())


def tokenize(s):
    for m in re.finditer(r'\(|\)|0x[0-9a-fA-F]+|\d+|[A-Za-z_][A-Za-z0-9_]*', s):
        yield m.group(0)


def parse_brun(s):
    """Parse brun's printed s-expr into nested Python (ints/bytes)."""
    toks = list(tokenize(s))

    def atom(t):
        if t.startswith("0x"):
            return bytes.fromhex(t[2:])
        if t.isdigit():
            return int(t)
        return ATOM_FOR_OPCODE.get(t.encode(), t.encode())

    def expr(i):
        assert toks[i] == "("
        out, i = [], i + 1
        while toks[i] != ")":
            if toks[i] == "(":
                v, i = expr(i)
                out.append(v)
            else:
                out.append(atom(toks[i]))
                i += 1
        return out, i + 1

    v, _ = expr(0)
    return v


def int_bytes(n):
    """CLVM minimal big-endian encoding; the canonical zero is the empty atom."""
    if n == 0:
        return b""
    return n.to_bytes((n.bit_length() + 8) // 8, "big")


def same_atom(a, b):
    """CLVM atoms: ints and their minimal big-endian encodings are the same."""
    def norm(x):
        return int.from_bytes(x, "big") if isinstance(x, bytes) else x
    return norm(a) == norm(b)


def same_cond(c1, c2):
    return (len(c1) == len(c2)
            and all(same_atom(a, b) for a, b in zip(c1, c2)))


def sig_msg_py(branch_tag, dest_ph, amount):
    return hashlib.sha256(b"NS-HTLC-v1" + FILL_ID + branch_tag + dest_ph
                          + int_bytes(amount)).digest()


def payout_digest_py(payouts):
    acc = b""
    for ph, amt in payouts:
        acc = hashlib.sha256(acc + ph + int_bytes(amt)).digest()
    return acc


def arb_msg_py(payouts):
    return hashlib.sha256(b"arbitrate" + FILL_ID + payout_digest_py(payouts)).digest()


def curry_htlc(variant, arb_pk, timelock=T1_TIMELOCK, hashlock=HASHLOCK):
    mod = sexp_hex(read_hex(HERE / f"{variant}.hex"))
    args = [hashlock, timelock, PK_C, PK_R, CLAIM_PH, REFUND_PH, FILL_ID]
    if variant == "htlc":
        args.append(arb_pk)
    _, curried = curry(mod, SExp.to(args))
    return curried.as_bin().hex()


def brun(ch, mode, payload, amount=AMOUNT):
    sol = SExp.to([mode, payload, amount]).as_bin().hex()
    r = subprocess.run([BRUN, "-x", ch, sol], capture_output=True, text=True)
    conds = parse_brun(r.stdout.strip()) if r.returncode == 0 else None
    return r.returncode, conds


def create_coins(conds):
    return [c for c in conds if c[0] == CREATE_COIN]


def hinted(cond):
    """A CREATE_COIN whose memo list is exactly (puzzle_hash) — the CAT2 hint."""
    return len(cond) == 4 and cond[3] == [cond[1]]


def has_cond(conds, opcode, *args):
    return any(c[0] == opcode and same_cond(c, [opcode, *args]) for c in conds)


# ------------------------------------------------------------------- the tests
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail and not ok else ""))


def compile_all():
    """Compile both variants from source into memory. Returns {variant: hex}."""
    compiled = {}
    for variant in ("htlc", "htlc_noarb"):
        try:
            prog = compile_clvm_text((HERE / f"{variant}.clsp").read_text(), [str(HERE)])
            compiled[variant] = prog.as_bin().hex()
            check(f"compile {variant}.clsp", True)
        except Exception as e:  # noqa: BLE001
            check(f"compile {variant}.clsp", False, str(e)[:120])
            return None
    return compiled


def template_claim_spend(tpl):
    return tpl["claim_bundle"]["coin_spends"][0]


def write_artifacts(compiled):
    """Deliberate regeneration: the committed hex and the template's real fields."""
    for variant, hx in compiled.items():
        (HERE / f"{variant}.hex").write_text(hx + "\n")
        print(f"wrote {variant}.hex")
    ch = curry_htlc("htlc", PK_A)
    ph = Program.from_bytes(bytes.fromhex(ch)).get_tree_hash().hex()
    tpl = json.loads(TEMPLATE.read_text())
    lock = tpl["lock_bundle"]["coin_spends"][0]
    lock["_expected_conditions"][0] = re.sub(r"0x[0-9a-f]{64}", "0x" + ph,
                                             lock["_expected_conditions"][0])
    spend = template_claim_spend(tpl)
    spend["coin"]["puzzle_hash"] = "0x" + ph
    spend["coin"]["amount"] = AMOUNT
    spend["puzzle_reveal"] = "0x" + ch
    spend["solution"] = "0x" + SExp.to([0, PREIMAGE, AMOUNT]).as_bin().hex()
    spend["_solution_meaning"]["PAYLOAD"] = (
        "0x" + PREIMAGE.hex() + " (preimage s, exactly 32 bytes; sha256(s) == HASHLOCK)")
    spend["_solution_meaning"]["AMOUNT"] = AMOUNT
    TEMPLATE.write_text(json.dumps(tpl, indent=2) + "\n")
    print(f"wrote {TEMPLATE.name} (puzzle_hash {ph[:16]}…)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--write-hex", action="store_true",
                    help="regenerate htlc.hex / htlc_noarb.hex and the real fields of "
                         "spend_bundle_template.json from source, then run the suite")
    args = ap.parse_args()

    # 1-2: compile from source (to memory), no unresolved symbols
    compiled = compile_all()
    if compiled is None:
        return 1
    leak_words = ["HASHLOCK", "TIMELOCK", "CLAIMER_PK", "REFUNDER_PK",
                  "CLAIM_PUZZLE", "REFUND_PUZZLE", "FILL_ID", "ARBITER_PK"]
    for variant, hx in compiled.items():
        d = binutils.disassemble(sexp_hex(hx))
        leaks = [w for w in leak_words if f'"{w}' in d]
        check(f"{variant}: no unresolved curried symbols", not leaks, str(leaks))

    if args.write_hex:
        write_artifacts(compiled)

    # the committed hex is the canonical artefact: it must match a fresh build
    drift = False
    for variant, hx in compiled.items():
        committed = read_hex(HERE / f"{variant}.hex")
        ok = committed == hx
        drift |= not ok
        check(f"{variant}.hex matches a fresh build of {variant}.clsp", ok,
              f"committed sha256 {hashlib.sha256(committed.encode()).hexdigest()[:16]} != "
              f"built {hashlib.sha256(hx.encode()).hexdigest()[:16]}")
    if drift:
        print("\nerror: committed .hex differs from the source build. If the source change is "
              "intended, regenerate with `run_tests.py --write-hex` and commit the new hex "
              "(and the updated spend_bundle_template.json).")
        return 1

    def tree_hash_of(variant, args):
        mod = sexp_hex(compiled[variant])
        _, c = curry(mod, SExp.to(args))
        return Program.from_bytes(c.as_bin()).get_tree_hash()

    base = [HASHLOCK, T1_TIMELOCK, PK_C, PK_R, CLAIM_PH, REFUND_PH, FILL_ID]
    # 3-5: curry determinism + sensitivity
    h1 = tree_hash_of("htlc", base + [PK_A])
    h2 = tree_hash_of("htlc", base + [PK_A])
    check("curry deterministic (same params -> same tree hash)", h1 == h2)
    check("curry sensitive to ARBITER_PK",
          h1 != tree_hash_of("htlc", base + [PK_R]))
    alt = list(base)
    alt[6] = hashlib.sha256(b"other-fill").digest()
    check("curry sensitive to FILL_ID", h1 != tree_hash_of("htlc", alt + [PK_A]))
    check("noarb tree hash differs from arbiter variant",
          tree_hash_of("htlc_noarb", base) != h1)

    ch = curry_htlc("htlc", PK_A)
    ch_noarb = curry_htlc("htlc_noarb", b"")

    # 6-8: claim happy path
    rc, conds = brun(ch, 0, PREIMAGE)
    check("claim: exits 0", rc == 0)
    ok = (rc == 0 and len(conds) == 5
          and same_cond(conds[0], [ASSERT_MY_AMOUNT, AMOUNT])
          and same_cond(conds[1], [ASSERT_BEFORE_SECONDS_RELATIVE, T1_TIMELOCK])
          and same_cond(conds[2][:3], [CREATE_COIN, CLAIM_PH, AMOUNT])
          and conds[3][0] == AGG_SIG_ME and conds[3][1] == PK_C
          and conds[4][0] == CREATE_PUZZLE_ANNOUNCEMENT)
    check("claim: MY_AMOUNT/BEFORE_SECONDS_REL/CREATE_COIN/AGG_SIG_ME/announcement structure",
          ok, f"got {conds}" if rc == 0 and not ok else "")
    check("claim: emits ASSERT_MY_AMOUNT (73) for the solution amount",
          rc == 0 and has_cond(conds, ASSERT_MY_AMOUNT, AMOUNT))
    check("claim: emits ASSERT_BEFORE_SECONDS_RELATIVE (84) TIMELOCK — claim deadline",
          rc == 0 and has_cond(conds, ASSERT_BEFORE_SECONDS_RELATIVE, T1_TIMELOCK))
    check("claim: CREATE_COIN carries the hint memo (CLAIM_PUZZLE_HASH)",
          rc == 0 and all(hinted(c) for c in create_coins(conds)))
    claim_msg = sig_msg_py(b"claim", CLAIM_PH, AMOUNT)
    check("claim: AGG_SIG_ME message byte-matches Python impl",
          rc == 0 and conds[3][2] == claim_msg, claim_msg.hex()[:32])
    sig = AugSchemeMPL.sign(SK_C, claim_msg)
    check("claim: BLS verifies with claimer key",
          AugSchemeMPL.verify(SK_C.get_g1(), claim_msg, sig))
    check("claim: BLS rejects wrong key",
          not AugSchemeMPL.verify(SK_R.get_g1(), claim_msg, sig))

    # 9: wrong preimage (32 bytes, so only the hash check fails)
    rc, _ = brun(ch, 0, b"wrong-preimage-of-exactly-32-byt")
    check("claim: wrong preimage raises", rc != 0)
    # preimage width bound: |s| == 32 is the cross-chain invariant. Lock a coin
    # whose HASHLOCK really is sha256 of a 33-/1-byte secret, then claim with it:
    # the hash matches, the width does not, and the puzzle must raise.
    for width in (33, 1):
        s = bytes([0xC3]) * width
        rc, _ = brun(curry_htlc("htlc", PK_A, hashlock=hashlib.sha256(s).digest()), 0, s)
        check(f"claim: {width}-byte preimage raises even when sha256 matches", rc != 0)
    rc, _ = brun(ch, 0, [PREIMAGE])
    check("claim: non-atom preimage raises", rc != 0)
    rc, _ = brun(ch, 0, PREIMAGE, AMOUNT - 1)
    check("claim: AMOUNT - 1 still binds ASSERT_MY_AMOUNT to the stated amount (consensus fails it)",
          rc == 0 and has_cond(_, ASSERT_MY_AMOUNT, AMOUNT - 1))

    # 10-13: refund
    rc, conds = brun(ch, 1, b"")
    check("refund: exits 0", rc == 0)
    ok = (rc == 0 and len(conds) == 5
          and same_cond(conds[0], [ASSERT_MY_AMOUNT, AMOUNT])
          and same_cond(conds[1], [ASSERT_SECONDS_RELATIVE, T1_TIMELOCK])
          and same_cond(conds[2][:3], [CREATE_COIN, REFUND_PH, AMOUNT])
          and conds[3][0] == AGG_SIG_ME and conds[3][1] == PK_R
          and conds[4][0] == CREATE_PUZZLE_ANNOUNCEMENT)
    check("refund: MY_AMOUNT/SECONDS_RELATIVE/CREATE_COIN/AGG_SIG_ME/announcement structure",
          ok, f"got {conds}" if rc == 0 and not ok else "")
    check("refund: emits ASSERT_MY_AMOUNT (73) for the solution amount",
          rc == 0 and has_cond(conds, ASSERT_MY_AMOUNT, AMOUNT))
    check("refund: CREATE_COIN carries the hint memo (REFUND_PUZZLE_HASH)",
          rc == 0 and all(hinted(c) for c in create_coins(conds)))
    refund_msg = sig_msg_py(b"refund", REFUND_PH, AMOUNT)
    check("refund: AGG_SIG_ME message byte-matches Python impl",
          rc == 0 and conds[3][2] == refund_msg)
    sig_r = AugSchemeMPL.sign(SK_R, refund_msg)
    check("refund: BLS verifies with refunder key",
          AugSchemeMPL.verify(SK_R.get_g1(), refund_msg, sig_r))
    check("refund: BLS rejects wrong key",
          not AugSchemeMPL.verify(SK_C.get_g1(), refund_msg, sig_r))
    # timelock is consensus-enforced; brun only checks structure (documented)
    ch6 = curry_htlc("htlc", PK_A, T2_TIMELOCK)
    rc6, conds6 = brun(ch6, 1, b"")
    check("refund: second-leg timelock param honored (21600)",
          rc6 == 0 and same_cond(conds6[1], [ASSERT_SECONDS_RELATIVE, T2_TIMELOCK]))
    rc6, conds6 = brun(ch6, 0, PREIMAGE)
    check("claim: deadline uses the same TIMELOCK as refund (complementary 84/80 pair)",
          rc6 == 0 and same_cond(conds6[1], [ASSERT_BEFORE_SECONDS_RELATIVE, T2_TIMELOCK]))
    # PAYLOAD is unread by the refund branch, so it must be pinned to () —
    # otherwise a relayer could rewrite it under the same signature.
    rc, _ = brun(ch, 1, b"junk")
    check("refund: non-nil atom PAYLOAD raises", rc != 0)
    rc, _ = brun(ch, 1, [b"a", [b"b"]])
    check("refund: list PAYLOAD raises", rc != 0)

    # 14: cross-branch signature misuse
    check("cross-branch: claim sig rejected as refund auth",
          not AugSchemeMPL.verify(SK_C.get_g1(), refund_msg, sig))

    # 15-19: arbitrate
    PH1, PH2 = bytes.fromhex("cc" * 32), bytes.fromhex("dd" * 32)
    payouts = [(PH1, 400_000), (PH2, 200_000)]
    sol_payouts = [[ph, amt] for ph, amt in payouts]
    rc, conds = brun(ch, 2, sol_payouts)
    check("arbitrate: exits 0", rc == 0)
    amsg = arb_msg_py(payouts)
    ok = (rc == 0 and len(conds) == 5
          and same_cond(conds[0], [ASSERT_MY_AMOUNT, AMOUNT])
          and conds[1][0] == AGG_SIG_ME and conds[1][1] == PK_A and conds[1][2] == amsg
          and conds[2][0] == CREATE_PUZZLE_ANNOUNCEMENT
          and same_cond(conds[3][:3], [CREATE_COIN, PH1, 400_000])
          and same_cond(conds[4][:3], [CREATE_COIN, PH2, 200_000]))
    check("arbitrate: MY_AMOUNT/sig/announcement/payout conditions structure", ok,
          f"got {conds}" if rc == 0 and not ok else "")
    check("arbitrate: emits ASSERT_MY_AMOUNT (73) for the solution amount",
          rc == 0 and has_cond(conds, ASSERT_MY_AMOUNT, AMOUNT))
    check("arbitrate: every payout CREATE_COIN carries its hint memo",
          rc == 0 and len(create_coins(conds)) == 2
          and all(hinted(c) for c in create_coins(conds)))
    sig_a = AugSchemeMPL.sign(SK_A, amsg)
    check("arbitrate: BLS verifies with arbiter key",
          AugSchemeMPL.verify(SK_A.get_g1(), amsg, sig_a))
    check("arbitrate: BLS rejects non-arbiter key",
          not AugSchemeMPL.verify(SK_C.get_g1(), amsg, sig_a))
    rc, _ = brun(ch, 2, [[PH1, 400_000], [PH2, 200_001]])
    check("arbitrate: over-creation (total > amount) raises", rc != 0)
    rc, _ = brun(curry_htlc("htlc", b""), 2, sol_payouts)
    check("arbitrate: null ARBITER_PK raises", rc != 0)
    # payout-pair shape: unread trailing elements and non-32-byte puzzle
    # hashes are refused (malleable under the arbiter's signature otherwise)
    rc, _ = brun(ch, 2, [[PH1, 400_000, b"junk"], [PH2, 200_000]])
    check("arbitrate: payout pair with a trailing element raises", rc != 0)
    rc, _ = brun(ch, 2, [[PH1, 400_000], [PH2, 200_000, []]])
    check("arbitrate: payout pair with a trailing () raises", rc != 0)
    rc, _ = brun(ch, 2, [[bytes.fromhex("cc" * 31), 400_000], [PH2, 200_000]])
    check("arbitrate: 31-byte payout puzzle hash raises", rc != 0)
    rc, _ = brun(ch, 2, [[PH1, 400_000], [bytes.fromhex("dd" * 33), 200_000]])
    check("arbitrate: 33-byte payout puzzle hash raises", rc != 0)

    # 20-22: noarb variant
    rc, conds_nb = brun(ch_noarb, 0, PREIMAGE)
    check("noarb claim: exits 0 with identical conditions to arbiter variant",
          rc == 0 and conds_nb == parse_brun(
              subprocess.run([BRUN, "-x", ch,
                              SExp.to([0, PREIMAGE, AMOUNT]).as_bin().hex()],
                             capture_output=True, text=True).stdout.strip()))
    rc, _ = brun(ch_noarb, 2, sol_payouts)
    check("noarb: mode 2 raises (no arbitrate branch)", rc != 0)
    rc, conds_nb = brun(ch_noarb, 1, b"")
    check("noarb: refund works", rc == 0)
    check("noarb: refund emits ASSERT_MY_AMOUNT and a hinted CREATE_COIN",
          rc == 0 and has_cond(conds_nb, ASSERT_MY_AMOUNT, AMOUNT)
          and all(hinted(c) for c in create_coins(conds_nb)))
    rc, _ = brun(ch_noarb, 1, b"junk")
    check("noarb: non-nil refund PAYLOAD raises", rc != 0)
    s33 = bytes([0xC3]) * 33
    rc, _ = brun(curry_htlc("htlc_noarb", b"", hashlock=hashlib.sha256(s33).digest()), 0, s33)
    check("noarb: 33-byte preimage raises", rc != 0)

    # 23: unknown modes
    for m in (3, 7, 255):
        rc, _ = brun(ch, m, b"")
        check(f"arbiter variant: mode {m} raises", rc != 0)

    # 24: announcements differ per branch (fill attribution)
    rc_c, cc = brun(ch, 0, PREIMAGE)
    rc_r, cr = brun(ch, 1, b"")
    check("announcements differ per branch",
          rc_c == 0 and rc_r == 0 and cc[4][1] != cr[4][1])

    # 25: no fee — full amount moves on every spending branch
    def created_total(conds):
        total = 0
        for c in conds:
            if c[0] == CREATE_COIN:
                v = c[2]
                total += int.from_bytes(v, "big") if isinstance(v, bytes) else v
        return total

    rc, conds = brun(ch, 0, PREIMAGE)
    check("claim moves full amount, no fee skim",
          rc == 0 and created_total(conds) == AMOUNT)
    _, conds = brun(ch, 2, sol_payouts)
    check("arbitrate payouts sum to full amount", created_total(conds) == AMOUNT)

    # 26: the spend-bundle template embeds real outputs of this build
    tpl = json.loads(TEMPLATE.read_text())
    spend = template_claim_spend(tpl)
    check("template: HTLC puzzle_reveal is the test-vector curry of htlc.hex",
          spend["puzzle_reveal"] == "0x" + ch)
    ph_hex = "0x" + Program.from_bytes(bytes.fromhex(ch)).get_tree_hash().hex()
    check("template: HTLC coin puzzle_hash is the reveal's tree hash",
          spend["coin"]["puzzle_hash"] == ph_hex
          and ph_hex in tpl["lock_bundle"]["coin_spends"][0]["_expected_conditions"][0])
    check("template: claim solution is (0 PREIMAGE AMOUNT)",
          spend["solution"] == "0x" + SExp.to([0, PREIMAGE, AMOUNT]).as_bin().hex()
          and spend["coin"]["amount"] == AMOUNT)
    check("template: lock and claim are separate bundles (claim cannot be ephemeral)",
          set(tpl) >= {"lock_bundle", "claim_bundle"}
          and len(tpl["claim_bundle"]["coin_spends"]) == 1)

    failed = [n for n, ok, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
