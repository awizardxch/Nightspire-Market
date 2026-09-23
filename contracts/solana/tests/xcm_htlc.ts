/**
 * xcm_htlc test suite — runs against a local solana-test-validator (`anchor test`).
 *
 * Covers SPEC.md §5b: initialize / withdraw / refund / arbitrate (MEDIATED),
 * exclusive claim windows (§8), PDA determinism, and the cross-VM SHA-256
 * compatibility check (EVM `sha256` == Solana `hash::hash`).
 *
 * Time-based tests use short timelocks and real sleeps: the local validator's
 * `Clock::unix_timestamp` tracks wall-clock time.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Ed25519Program,
} from "@solana/web3.js";
import {
  createMint,
  mintTo,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import * as crypto from "crypto";
import * as assert from "assert";
import { XcmHtlc } from "../target/types/xcm_htlc";

// ---------------------------------------------------------------------------
// Fixed cross-VM test vector (documented).
//
// secret  = utf8("xcm-htlc-vector-v1-32bytes!!!!!!") — exactly 32 bytes
// sha256  = 5b9a96bad43ae10d584a4310b79d57d70e1b2f5ab89ea58b20f9f2091f3e463b
//           (ground truth from coreutils `sha256sum`, independent of node:crypto)
//
// The test asserts node:crypto's digest equals the hardcoded ground truth, then
// performs an on-chain withdraw with that secret. Withdraw succeeds only if
// `solana_program::hash::hash(preimage) == hashlock`, so success proves the
// on-chain SHA-256 is byte-identical to the off-chain one — and therefore to
// the EVM `sha256` precompile and Chia's `sha256` operator (same algorithm).
// ---------------------------------------------------------------------------
const VECTOR_SECRET = Buffer.from(
  "xcm-htlc-vector-v1-32bytes!!!!!!",
  "utf8"
);
const VECTOR_DIGEST_HEX =
  "5b9a96bad43ae10d584a4310b79d57d70e1b2f5ab89ea58b20f9f2091f3e463b";

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DUMMY = SystemProgram.programId; // placeholder for unused token accounts on SOL fills

describe("xcm_htlc", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.XcmHtlc as Program<XcmHtlc>;
  const connection = provider.connection;

  const airdrop = async (to: PublicKey, sol = 10) => {
    const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  };

  const expectCode = async (p: Promise<any>, code: string) => {
    try {
      await p;
    } catch (e: any) {
      const c =
        e?.error?.errorCode?.code ||
        e?.error?.errorCode ||
        JSON.stringify(e?.message || e);
      assert.ok(
        String(c).includes(code) || String(e?.message || e).includes(code),
        `expected error code ${code}, got: ${c}`
      );
      return;
    }
    assert.fail(`expected error ${code}, but the transaction succeeded`);
  };

  /** Fresh per-fill parameters. */
  const newFill = (secret?: Buffer) => {
    const s = secret ?? crypto.randomBytes(32);
    const hashlock = sha256(s);
    const fillId = sha256(Buffer.from(crypto.randomUUID()));
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("htlc"), fillId, hashlock],
      program.programId
    );
    return { secret: s, hashlock, fillId, pda };
  };

  const nowPlus = (secs: number) =>
    new BN(Math.floor(Date.now() / 1000) + secs);

  before(async () => {
    await airdrop(provider.wallet.publicKey, 100);
  });

  // -------------------------------------------------------------------------
  it("SOL happy path: initialize -> withdraw pays receiver, escrow closes", async () => {
    const maker = Keypair.generate();
    const receiver = Keypair.generate().publicKey;
    const refundAddr = Keypair.generate().publicKey;
    await airdrop(maker.publicKey);

    const { secret, hashlock, fillId, pda } = newFill();
    const amount = new BN(500_000_000); // 0.5 SOL

    await program.methods
      .initialize(
        receiver,
        refundAddr,
        Array.from(hashlock),
        nowPlus(3600),
        null, // mint: None = native SOL
        amount,
        Array.from(fillId),
        null, // arbiter
        null, // exclusive_claimer
        new BN(0)
      )
      .accounts({
        funder: maker.publicKey,
        receiver,
        refundAddr,
        funderToken: DUMMY,
        escrowToken: DUMMY,
        tokenProgram: DUMMY,
      })
      .signers([maker])
      .rpc();

    const escrowBefore = await connection.getAccountInfo(pda);
    assert.ok(escrowBefore, "escrow PDA should exist after initialize");
    const escrowRent = escrowBefore.lamports - amount.toNumber();

    // Anyone may submit the claim (payout is hardcoded); use a third party.
    const claimer = Keypair.generate();
    await airdrop(claimer.publicKey, 1);
    const recvBefore = await connection.getBalance(receiver);

    await program.methods
      .withdraw(Array.from(secret))
      .accounts({
        claimer: claimer.publicKey,
        escrow: pda,
        receiver,
        escrowToken: DUMMY,
        receiverToken: DUMMY,
        tokenProgram: DUMMY,
      })
      .signers([claimer])
      .rpc();

    const recvAfter = await connection.getBalance(receiver);
    assert.strictEqual(
      recvAfter - recvBefore,
      amount.toNumber() + escrowRent,
      "receiver should get amount + reclaimed rent"
    );
    const escrowAfter = await connection.getAccountInfo(pda);
    assert.strictEqual(escrowAfter, null, "escrow PDA should be closed");
  });

  // -------------------------------------------------------------------------
  it("SPL happy path: initialize -> withdraw pays receiver ATA, vault closes", async () => {
    const maker = Keypair.generate();
    const receiver = Keypair.generate();
    const refundAddr = Keypair.generate().publicKey;
    await airdrop(maker.publicKey);
    await airdrop(receiver.publicKey, 1);

    // Locally-created test mint (throwaway, local validator only).
    const mintAuthority = Keypair.generate();
    const mint = await createMint(
      connection,
      provider.wallet.payer,
      mintAuthority.publicKey,
      null,
      6
    );
    const makerAta = await createAssociatedTokenAccount(
      connection,
      provider.wallet.payer,
      mint,
      maker.publicKey
    );
    await mintTo(
      connection,
      provider.wallet.payer,
      mint,
      makerAta,
      mintAuthority,
      2_000_000_000
    );

    const { secret, hashlock, fillId, pda } = newFill();
    const amount = new BN(750_000_000);

    // Pre-create the escrow vault token account (authority = escrow PDA).
    const vault = await getAssociatedTokenAddress(mint, pda, true);
    await createAssociatedTokenAccount(
      connection,
      provider.wallet.payer,
      mint,
      pda,
      undefined, // confirmOptions
      undefined, // programId (default SPL Token)
      undefined, // associatedTokenProgramId (default)
      true // allowOwnerOffCurve: the vault owner is the escrow PDA
    );

    await program.methods
      .initialize(
        receiver.publicKey,
        refundAddr,
        Array.from(hashlock),
        nowPlus(3600),
        mint, // Some(mint) = SPL
        amount,
        Array.from(fillId),
        null,
        null,
        new BN(0)
      )
      .accounts({
        funder: maker.publicKey,
        receiver: receiver.publicKey,
        refundAddr,
        funderToken: makerAta,
        escrowToken: vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    const vaultAfterInit = await getAccount(connection, vault);
    assert.strictEqual(
      Number(vaultAfterInit.amount),
      amount.toNumber(),
      "vault should hold the escrowed tokens"
    );

    const receiverAta = await createAssociatedTokenAccount(
      connection,
      provider.wallet.payer,
      mint,
      receiver.publicKey
    );

    await program.methods
      .withdraw(Array.from(secret))
      .accounts({
        claimer: receiver.publicKey,
        escrow: pda,
        receiver: receiver.publicKey,
        escrowToken: vault,
        receiverToken: receiverAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([receiver])
      .rpc();

    const recvTok = await getAccount(connection, receiverAta);
    assert.strictEqual(
      Number(recvTok.amount),
      amount.toNumber(),
      "receiver ATA should get the full amount"
    );
    const vaultAfter = await connection.getAccountInfo(vault);
    assert.strictEqual(vaultAfter, null, "vault should be closed");
    const escrowAfter = await connection.getAccountInfo(pda);
    assert.strictEqual(escrowAfter, null, "escrow PDA should be closed");
  });

  // -------------------------------------------------------------------------
  it("refund after timelock: third party can trigger, funds land at refund_addr", async () => {
    const maker = Keypair.generate();
    const receiver = Keypair.generate().publicKey;
    const refundAddr = Keypair.generate().publicKey;
    await airdrop(maker.publicKey);

    const { hashlock, fillId, pda } = newFill();
    const amount = new BN(250_000_000);

    await program.methods
      .initialize(
        receiver,
        refundAddr,
        Array.from(hashlock),
        nowPlus(3), // expires in 3s
        null,
        amount,
        Array.from(fillId),
        null,
        null,
        new BN(0)
      )
      .accounts({
        funder: maker.publicKey,
        receiver,
        refundAddr,
        funderToken: DUMMY,
        escrowToken: DUMMY,
        tokenProgram: DUMMY,
      })
      .signers([maker])
      .rpc();

    await sleep(4500); // warp past the timelock (validator clock = wall clock)

    const thirdParty = Keypair.generate();
    await airdrop(thirdParty.publicKey, 1);
    const refundBefore = await connection.getBalance(refundAddr);

    await program.methods
      .refund()
      .accounts({
        caller: thirdParty.publicKey,
        escrow: pda,
        refundAddr,
        escrowToken: DUMMY,
        refundToken: DUMMY,
        tokenProgram: DUMMY,
      })
      .signers([thirdParty])
      .rpc();

    const refundAfter = await connection.getBalance(refundAddr);
    assert.ok(
      refundAfter - refundBefore >= amount.toNumber(),
      "refund_addr should receive amount (+ rent)"
    );
    assert.strictEqual(
      await connection.getAccountInfo(pda),
      null,
      "escrow PDA should be closed"
    );
  });

  // -------------------------------------------------------------------------
  it("rejects withdraw with a wrong preimage", async () => {
    const maker = Keypair.generate();
    await airdrop(maker.publicKey);
    const { hashlock, fillId, pda } = newFill();
    const receiver = Keypair.generate().publicKey;
    const refundAddr = Keypair.generate().publicKey;

    await program.methods
      .initialize(
        receiver, refundAddr, Array.from(hashlock), nowPlus(3600),
        null, new BN(100_000), Array.from(fillId), null, null, new BN(0)
      )
      .accounts({
        funder: maker.publicKey, receiver, refundAddr,
        funderToken: DUMMY, escrowToken: DUMMY, tokenProgram: DUMMY,
      })
      .signers([maker])
      .rpc();

    await expectCode(
      program.methods
        .withdraw(Array.from(crypto.randomBytes(32)))
        .accounts({
          claimer: maker.publicKey, escrow: pda, receiver,
          escrowToken: DUMMY, receiverToken: DUMMY, tokenProgram: DUMMY,
        })
        .signers([maker])
        .rpc(),
      "InvalidPreimage"
    );
  });

  // -------------------------------------------------------------------------
  it("rejects withdraw after the timelock", async () => {
    const maker = Keypair.generate();
    await airdrop(maker.publicKey);
    const { secret, hashlock, fillId, pda } = newFill();
    const receiver = Keypair.generate().publicKey;
    const refundAddr = Keypair.generate().publicKey;

    await program.methods
      .initialize(
        receiver, refundAddr, Array.from(hashlock), nowPlus(3),
        null, new BN(100_000), Array.from(fillId), null, null, new BN(0)
      )
      .accounts({
        funder: maker.publicKey, receiver, refundAddr,
        funderToken: DUMMY, escrowToken: DUMMY, tokenProgram: DUMMY,
      })
      .signers([maker])
      .rpc();

    await sleep(4500);

    await expectCode(
      program.methods
        .withdraw(Array.from(secret))
        .accounts({
          claimer: maker.publicKey, escrow: pda, receiver,
          escrowToken: DUMMY, receiverToken: DUMMY, tokenProgram: DUMMY,
        })
        .signers([maker])
        .rpc(),
      "TimelockExpired"
    );
  });

  // -------------------------------------------------------------------------
  it("rejects refund before the timelock", async () => {
    const maker = Keypair.generate();
    await airdrop(maker.publicKey);
    const { hashlock, fillId, pda } = newFill();
    const receiver = Keypair.generate().publicKey;
    const refundAddr = Keypair.generate().publicKey;

    await program.methods
      .initialize(
        receiver, refundAddr, Array.from(hashlock), nowPlus(3600),
        null, new BN(100_000), Array.from(fillId), null, null, new BN(0)
      )
      .accounts({
        funder: maker.publicKey, receiver, refundAddr,
        funderToken: DUMMY, escrowToken: DUMMY, tokenProgram: DUMMY,
      })
      .signers([maker])
      .rpc();

    await expectCode(
      program.methods
        .refund()
        .accounts({
          caller: maker.publicKey, escrow: pda, refundAddr,
          escrowToken: DUMMY, refundToken: DUMMY, tokenProgram: DUMMY,
        })
        .signers([maker])
        .rpc(),
      "TimelockNotExpired"
    );
  });

  // -------------------------------------------------------------------------
  it("exclusive claim window: non-winner rejected during, anyone succeeds after", async () => {
    const maker = Keypair.generate();
    const winner = Keypair.generate();
    const stranger = Keypair.generate();
    await airdrop(maker.publicKey);
    await airdrop(stranger.publicKey, 1);
    const receiver = Keypair.generate().publicKey;
    const refundAddr = Keypair.generate().publicKey;

    // Fill 1: exclusivity active for 1h.
    const f1 = newFill();
    await program.methods
      .initialize(
        receiver, refundAddr, Array.from(f1.hashlock), nowPlus(7200),
        null, new BN(100_000), Array.from(f1.fillId),
        null, winner.publicKey, nowPlus(3600)
      )
      .accounts({
        funder: maker.publicKey, receiver, refundAddr,
        funderToken: DUMMY, escrowToken: DUMMY, tokenProgram: DUMMY,
      })
      .signers([maker])
      .rpc();

    await expectCode(
      program.methods
        .withdraw(Array.from(f1.secret))
        .accounts({
          claimer: stranger.publicKey, escrow: f1.pda, receiver,
          escrowToken: DUMMY, receiverToken: DUMMY, tokenProgram: DUMMY,
        })
        .signers([stranger])
        .rpc(),
      "NotExclusiveClaimer"
    );

    // Fill 2: exclusivity expires in 3s; after that a stranger may claim.
    const f2 = newFill();
    await program.methods
      .initialize(
        receiver, refundAddr, Array.from(f2.hashlock), nowPlus(7200),
        null, new BN(100_000), Array.from(f2.fillId),
        null, winner.publicKey, nowPlus(3)
      )
      .accounts({
        funder: maker.publicKey, receiver, refundAddr,
        funderToken: DUMMY, escrowToken: DUMMY, tokenProgram: DUMMY,
      })
      .signers([maker])
      .rpc();

    await sleep(4500);

    const recvBefore = await connection.getBalance(receiver);
    await program.methods
      .withdraw(Array.from(f2.secret))
      .accounts({
        claimer: stranger.publicKey, escrow: f2.pda, receiver,
        escrowToken: DUMMY, receiverToken: DUMMY, tokenProgram: DUMMY,
      })
      .signers([stranger])
      .rpc();
    const recvAfter = await connection.getBalance(receiver);
    assert.ok(recvAfter > recvBefore, "stranger claim should succeed after exclusivity");
  });

  // -------------------------------------------------------------------------
  it("arbitrate: valid arbiter signature splits funds (MEDIATED)", async () => {
    const maker = Keypair.generate();
    const arbiter = Keypair.generate();
    const payeeA = Keypair.generate().publicKey;
    const payeeB = Keypair.generate().publicKey;
    const refundAddr = Keypair.generate().publicKey;
    const receiver = Keypair.generate().publicKey; // unused on this branch
    await airdrop(maker.publicKey);

    const { hashlock, fillId, pda } = newFill();
    const amount = new BN(1_000_000);

    await program.methods
      .initialize(
        receiver, refundAddr, Array.from(hashlock), nowPlus(3600),
        null, amount, Array.from(fillId),
        arbiter.publicKey, // arbiter set -> MEDIATED
        null, new BN(0)
      )
      .accounts({
        funder: maker.publicKey, receiver, refundAddr,
        funderToken: DUMMY, escrowToken: DUMMY, tokenProgram: DUMMY,
      })
      .signers([maker])
      .rpc();

    // Build the exact signed message:
    // "XCM-ARBITRATE-v1" || escrow_pda || recipients || amounts(u64 LE)
    const recipients = [payeeA, payeeB];
    const amounts = [new BN(600_000), new BN(400_000)];
    const msgParts: Buffer[] = [
      Buffer.from("XCM-ARBITRATE-v1"),
      pda.toBuffer(),
    ];
    for (const r of recipients) msgParts.push(r.toBuffer());
    for (const a of amounts) {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(a.toString()));
      msgParts.push(b);
    }
    const msg = Buffer.concat(msgParts);
    const sig = nacl.sign.detached(msg, arbiter.secretKey);
    // Authorization is proven by a native Ed25519Program precompile
    // instruction immediately before the program instruction; the runtime
    // verifies the cryptographic signature, the program binds pubkey+message.
    const edIx = Ed25519Program.createInstructionWithPublicKey({
      publicKey: arbiter.publicKey.toBuffer(),
      message: msg,
      signature: Buffer.from(sig),
    });

    const caller = Keypair.generate();
    await airdrop(caller.publicKey, 1);
    const aBefore = await connection.getBalance(payeeA);
    const bBefore = await connection.getBalance(payeeB);

    await program.methods
      .arbitrate(recipients, amounts)
      .accounts({
        caller: caller.publicKey,
        escrow: pda,
        refundAddr,
        escrowToken: DUMMY,
        tokenProgram: DUMMY,
      })
      .preInstructions([edIx])
      .remainingAccounts(
        recipients.map((r) => ({ pubkey: r, isWritable: true, isSigner: false }))
      )
      .signers([caller])
      .rpc();

    assert.strictEqual(
      (await connection.getBalance(payeeA)) - aBefore,
      600_000,
      "payee A should receive 600k lamports"
    );
    assert.strictEqual(
      (await connection.getBalance(payeeB)) - bBefore,
      400_000,
      "payee B should receive 400k lamports"
    );
    assert.strictEqual(
      await connection.getAccountInfo(pda),
      null,
      "escrow PDA should be closed"
    );
  });

  // -------------------------------------------------------------------------
  it("arbitrate: fails when no arbiter was set", async () => {
    const maker = Keypair.generate();
    await airdrop(maker.publicKey);
    const { hashlock, fillId, pda } = newFill();
    const receiver = Keypair.generate().publicKey;
    const refundAddr = Keypair.generate().publicKey;

    await program.methods
      .initialize(
        receiver, refundAddr, Array.from(hashlock), nowPlus(3600),
        null, new BN(100_000), Array.from(fillId),
        null, // no arbiter -> pure HTLC
        null, new BN(0)
      )
      .accounts({
        funder: maker.publicKey, receiver, refundAddr,
        funderToken: DUMMY, escrowToken: DUMMY, tokenProgram: DUMMY,
      })
      .signers([maker])
      .rpc();

    const payee = Keypair.generate().publicKey;
    await expectCode(
      program.methods
        .arbitrate([payee], [new BN(100_000)])
        .accounts({
          caller: maker.publicKey, escrow: pda, refundAddr,
          escrowToken: DUMMY, tokenProgram: DUMMY,
        })
        .remainingAccounts([{ pubkey: payee, isWritable: true, isSigner: false }])
        .signers([maker])
        .rpc(),
      "ArbiterNotSet"
    );
  });

  // -------------------------------------------------------------------------
  it("arbitrate: fails on a wrong-signer's signature", async () => {
    const maker = Keypair.generate();
    const arbiter = Keypair.generate();
    const impostor = Keypair.generate();
    await airdrop(maker.publicKey);
    const { hashlock, fillId, pda } = newFill();
    const receiver = Keypair.generate().publicKey;
    const refundAddr = Keypair.generate().publicKey;

    await program.methods
      .initialize(
        receiver, refundAddr, Array.from(hashlock), nowPlus(3600),
        null, new BN(100_000), Array.from(fillId),
        arbiter.publicKey, null, new BN(0)
      )
      .accounts({
        funder: maker.publicKey, receiver, refundAddr,
        funderToken: DUMMY, escrowToken: DUMMY, tokenProgram: DUMMY,
      })
      .signers([maker])
      .rpc();

    const payee = Keypair.generate().publicKey;
    const amounts = [new BN(100_000)];
    const msg = Buffer.concat([
      Buffer.from("XCM-ARBITRATE-v1"),
      pda.toBuffer(),
      payee.toBuffer(),
      (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(100_000n); return b; })(),
    ]);
    // Signed by the IMPOSTOR, not the arbiter. The runtime will accept the
    // precompile instruction (valid impostor signature), but the program
    // rejects it because the verified pubkey is not the escrow's arbiter.
    const badSig = nacl.sign.detached(msg, impostor.secretKey);
    const badEdIx = Ed25519Program.createInstructionWithPublicKey({
      publicKey: impostor.publicKey.toBuffer(),
      message: msg,
      signature: Buffer.from(badSig),
    });

    await expectCode(
      program.methods
        .arbitrate([payee], amounts)
        .accounts({
          caller: maker.publicKey, escrow: pda, refundAddr,
          escrowToken: DUMMY, tokenProgram: DUMMY,
        })
        .preInstructions([badEdIx])
        .remainingAccounts([{ pubkey: payee, isWritable: true, isSigner: false }])
        .signers([maker])
        .rpc(),
      "InvalidArbiterSignature"
    );
  });

  // -------------------------------------------------------------------------
  it("PDA derivation is deterministic per (fill_id, hashlock)", async () => {
    const fillId = sha256(Buffer.from("determinism-fill"));
    const hashlock = sha256(Buffer.from("determinism-secret"));
    const seeds = (f: Buffer, h: Buffer) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("htlc"), f, h],
        program.programId
      )[0];
    const pda1 = seeds(fillId, hashlock);
    const pda2 = seeds(fillId, hashlock);
    assert.ok(pda1.equals(pda2), "same (fill_id, hashlock) must give the same PDA");
    const pda3 = seeds(sha256(Buffer.from("other-fill")), hashlock);
    assert.ok(!pda1.equals(pda3), "different fill_id must give a different PDA");
    const pda4 = seeds(fillId, sha256(Buffer.from("other-secret")));
    assert.ok(!pda1.equals(pda4), "different hashlock must give a different PDA");
  });

  // -------------------------------------------------------------------------
  it("cross-VM: on-chain SHA-256 matches EVM sha256 (fixed vector)", async () => {
    // 1. node:crypto agrees with the independent coreutils ground truth.
    const h = sha256(VECTOR_SECRET);
    assert.strictEqual(
      h.toString("hex"),
      VECTOR_DIGEST_HEX,
      "node sha256 must match the documented vector digest"
    );

    // 2. An on-chain withdraw with the vector secret succeeds: the program
    //    asserts `solana_program::hash::hash(preimage) == hashlock`, so success
    //    proves the on-chain hash is byte-identical (EVM `sha256` compatible).
    const maker = Keypair.generate();
    const receiver = Keypair.generate().publicKey;
    const refundAddr = Keypair.generate().publicKey;
    await airdrop(maker.publicKey);

    const fillId = sha256(Buffer.from("cross-vm-fill"));
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("htlc"), fillId, h],
      program.programId
    );
    const amount = new BN(123_456);

    await program.methods
      .initialize(
        receiver, refundAddr, Array.from(h), nowPlus(3600),
        null, amount, Array.from(fillId), null, null, new BN(0)
      )
      .accounts({
        funder: maker.publicKey, receiver, refundAddr,
        funderToken: DUMMY, escrowToken: DUMMY, tokenProgram: DUMMY,
      })
      .signers([maker])
      .rpc();

    // 3. The stored hashlock equals the vector digest.
    const escrow = await program.account.htlcEscrow.fetch(pda);
    assert.deepStrictEqual(
      Buffer.from(escrow.hashlock as number[]),
      h,
      "stored hashlock must equal the vector digest"
    );

    await program.methods
      .withdraw(Array.from(VECTOR_SECRET))
      .accounts({
        claimer: maker.publicKey, escrow: pda, receiver,
        escrowToken: DUMMY, receiverToken: DUMMY, tokenProgram: DUMMY,
      })
      .signers([maker])
      .rpc();
  });
});
