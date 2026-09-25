#!/usr/bin/env python3
"""Nightspire Chia HTLC — local structural test suite.

Local tooling only: compiles with clvm_tools, executes with `brun`,
signs/verifies with throwaway blspy keys. NO chain interaction, NO mints,
NO persisted keys.

What this suite proves:
  * both puzzles compile from source and contain no unresolved symbols
  * curry is deterministic and fill-sensitive
  * every branch emits exactly the specified conditions (via brun)
  * every AGG_SIG_ME message byte-matches an independent Python
    implementation, and real BLS signatures verify accept/reject correctly

What it does NOT prove (needs testnet11 + full node):
  * consensus enforcement of AGG_SIG_ME / ASSERT_SECONDS_RELATIVE
  * time-wall behavior of the relative timelock
"""
import hashlib
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
# clvm_tools installs `brun` next to the interpreter's scripts (PATH on CI,
# ~/.local/bin for `pip install --user`); fall back to the latter.
BRUN = shutil.which("brun") or str(Path.home() / ".local" / "bin" / "brun")

# ---------------------------------------------------------------- test vectors
# Throwaway keys — generated fresh, never persisted, never funded.
SK_C = AugSchemeMPL.key_gen(b"\x11" * 32)   # claimer
SK_R = AugSchemeMPL.key_gen(b"\x22" * 32)   # refunder
SK_A = AugSchemeMPL.key_gen(b"\x33" * 32)   # arbiter
PK_C, PK_R, PK_A = (bytes(sk.get_g1()) for sk in (SK_C, SK_R, SK_A))

PREIMAGE = b"nightspire-test-secret-1"
HASHLOCK = hashlib.sha256(PREIMAGE).digest()
FILL_ID = hashlib.sha256(b"offer-123" + b"fill-nonce-1").digest()
CLAIM_PH = bytes.fromhex("aa" * 32)
REFUND_PH = bytes.fromhex("bb" * 32)
AMOUNT = 600_000
T1_TIMELOCK = 43_200   # spec §9: Any↔Chia first (maker) leg = 12h
T2_TIMELOCK = 21_600   # spec §9: second leg = 6h

ATOM_FOR_OPCODE = {v[0]: k for k, v in KEYWORD_TO_ATOM.items() if len(v) == 1}

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
    return n.to_bytes(max(1, (n.bit_length() + 8) // 8), "big")


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


def curry_htlc(variant, arb_pk, timelock=T1_TIMELOCK):
    mod = sexp_hex(read_hex(HERE / f"{variant}.hex"))
    args = [HASHLOCK, timelock, PK_C, PK_R, CLAIM_PH, REFUND_PH, FILL_ID]
    if variant == "htlc":
        args.append(arb_pk)
    _, curried = curry(mod, SExp.to(args))
    return curried.as_bin().hex()


def brun(ch, mode, payload, amount=AMOUNT):
    sol = SExp.to([mode, payload, amount]).as_bin().hex()
    r = subprocess.run([BRUN, "-x", ch, sol], capture_output=True, text=True)
    conds = parse_brun(r.stdout.strip()) if r.returncode == 0 else None
    return r.returncode, conds


# ------------------------------------------------------------------- the tests
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail and not ok else ""))


def main():
    # 1-2: compile from source, no unresolved symbols
    compiled = {}
    for variant in ("htlc", "htlc_noarb"):
        try:
            prog = compile_clvm_text((HERE / f"{variant}.clsp").read_text(), [str(HERE)])
            compiled[variant] = prog.as_bin().hex()
            (HERE / f"{variant}.hex").write_text(prog.as_bin().hex() + "\n")
            check(f"compile {variant}.clsp", True)
        except Exception as e:  # noqa: BLE001
            check(f"compile {variant}.clsp", False, str(e)[:120])
            return 1
    leak_words = ["HASHLOCK", "TIMELOCK", "CLAIMER_PK", "REFUNDER_PK",
                  "CLAIM_PUZZLE", "REFUND_PUZZLE", "FILL_ID", "ARBITER_PK"]
    for variant, hx in compiled.items():
        d = binutils.disassemble(sexp_hex(hx))
        leaks = [w for w in leak_words if f'"{w}' in d]
        check(f"{variant}: no unresolved curried symbols", not leaks, str(leaks))

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
    ok = (rc == 0 and len(conds) == 3
          and same_cond(conds[0], [51, CLAIM_PH, AMOUNT])
          and conds[1][0] == 50 and conds[1][1] == PK_C
          and conds[2][0] == 62)
    check("claim: CREATE_COIN/AGG_SIG_ME/announcement structure", ok)
    claim_msg = sig_msg_py(b"claim", CLAIM_PH, AMOUNT)
    check("claim: AGG_SIG_ME message byte-matches Python impl",
          rc == 0 and conds[1][2] == claim_msg, claim_msg.hex()[:32])
    sig = AugSchemeMPL.sign(SK_C, claim_msg)
    check("claim: BLS verifies with claimer key",
          AugSchemeMPL.verify(SK_C.get_g1(), claim_msg, sig))
    check("claim: BLS rejects wrong key",
          not AugSchemeMPL.verify(SK_R.get_g1(), claim_msg, sig))

    # 9: wrong preimage
    rc, _ = brun(ch, 0, b"wrong-preimage")
    check("claim: wrong preimage raises", rc != 0)

    # 10-13: refund
    rc, conds = brun(ch, 1, b"")
    check("refund: exits 0", rc == 0)
    ok = (rc == 0 and len(conds) == 4
          and same_cond(conds[0], [80, T1_TIMELOCK])
          and same_cond(conds[1], [51, REFUND_PH, AMOUNT])
          and conds[2][0] == 50 and conds[2][1] == PK_R
          and conds[3][0] == 62)
    check("refund: ASSERT_SECONDS_RELATIVE/CREATE_COIN/AGG_SIG_ME/announcement", ok)
    refund_msg = sig_msg_py(b"refund", REFUND_PH, AMOUNT)
    check("refund: AGG_SIG_ME message byte-matches Python impl",
          rc == 0 and conds[2][2] == refund_msg)
    sig_r = AugSchemeMPL.sign(SK_R, refund_msg)
    check("refund: BLS verifies with refunder key",
          AugSchemeMPL.verify(SK_R.get_g1(), refund_msg, sig_r))
    check("refund: BLS rejects wrong key",
          not AugSchemeMPL.verify(SK_C.get_g1(), refund_msg, sig_r))
    # timelock is consensus-enforced; brun only checks structure (documented)
    rc6, conds6 = brun(curry_htlc("htlc", PK_A, T2_TIMELOCK), 1, b"")
    check("refund: second-leg timelock param honored (21600)",
          rc6 == 0 and same_cond(conds6[0], [80, T2_TIMELOCK]))

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
    ok = (rc == 0 and len(conds) == 4
          and conds[0][0] == 50 and conds[0][1] == PK_A and conds[0][2] == amsg
          and conds[1][0] == 62
          and same_cond(conds[2], [51, PH1, 400_000])
          and same_cond(conds[3], [51, PH2, 200_000]))
    check("arbitrate: sig/announcement/payout conditions structure", ok,
          f"got {conds}" if rc == 0 and not ok else "")
    sig_a = AugSchemeMPL.sign(SK_A, amsg)
    check("arbitrate: BLS verifies with arbiter key",
          AugSchemeMPL.verify(SK_A.get_g1(), amsg, sig_a))
    check("arbitrate: BLS rejects non-arbiter key",
          not AugSchemeMPL.verify(SK_C.get_g1(), amsg, sig_a))
    rc, _ = brun(ch, 2, [[PH1, 400_000], [PH2, 200_001]])
    check("arbitrate: over-creation (total > amount) raises", rc != 0)
    rc, _ = brun(curry_htlc("htlc", b""), 2, sol_payouts)
    check("arbitrate: null ARBITER_PK raises", rc != 0)

    # 20-22: noarb variant
    rc, conds_nb = brun(ch_noarb, 0, PREIMAGE)
    check("noarb claim: exits 0 with identical conditions to arbiter variant",
          rc == 0 and conds_nb == parse_brun(
              subprocess.run([BRUN, "-x", ch,
                              SExp.to([0, PREIMAGE, AMOUNT]).as_bin().hex()],
                             capture_output=True, text=True).stdout.strip()))
    rc, _ = brun(ch_noarb, 2, sol_payouts)
    check("noarb: mode 2 raises (no arbitrate branch)", rc != 0)
    rc, _ = brun(ch_noarb, 1, b"")
    check("noarb: refund works", rc == 0)

    # 23: unknown modes
    for m in (3, 7, 255):
        rc, _ = brun(ch, m, b"")
        check(f"arbiter variant: mode {m} raises", rc != 0)

    # 24: announcements differ per branch (fill attribution)
    rc_c, cc = brun(ch, 0, PREIMAGE)
    rc_r, cr = brun(ch, 1, b"")
    check("announcements differ per branch",
          rc_c == 0 and rc_r == 0 and cc[2][1] != cr[3][1])

    # 25: no fee — full amount moves on every spending branch
    def created_total(conds):
        total = 0
        for c in conds:
            if c[0] == 51:
                v = c[2]
                total += int.from_bytes(v, "big") if isinstance(v, bytes) else v
        return total

    rc, conds = brun(ch, 0, PREIMAGE)
    check("claim moves full amount, no fee skim",
          rc == 0 and created_total(conds) == AMOUNT)
    _, conds = brun(ch, 2, sol_payouts)
    check("arbitrate payouts sum to full amount", created_total(conds) == AMOUNT)

    failed = [n for n, ok, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
