/**
 * xcm_htlc bankrun e2e -- the SAME 12 tests as xcm_htlc.ts, but executed
 * against solana-bankrun (in-process LiteSVM) instead of solana-test-validator.
 *
 * Why: this sandbox blocks UDP sends (even loopback), so solana-test-validator
 * can never land a transaction here -- slots are produced but every submission
 * times out. Bankrun executes the real compiled BPF program (`target/deploy/
 * xcm_htlc.so`, built by cargo-build-sbf from the same source) in-process, so
 * program-logic coverage is faithful; only the networking/consensus layer is
 * simulated. The 12 test cases, assertions, and error codes are unchanged.
 *
 * Deltas vs xcm_htlc.ts (all documented at each site):
 *  - `startAnchor` deploys the workspace program plus the real SPL Token
 *    program (built from the vendored spl-token 7.0.0 source in
 *    vendor/spl-token), at TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.
 *    SPL token accounts are ordinary accounts created via
 *    @solana/spl-token's createAccount (no ATA program needed -- the vault
 *    is a random token account whose owner is the escrow PDA).
 *  - On SOL fills, unused token-account fields use a real funded
 *    system-owned placeholder account (mutable), NOT the System Program
 *    (which is executable and unsuitable where Anchor requires a writable
 *    account). The unused non-mutable `tokenProgram` field still uses the
 *    System Program address.
 *  - funding is via `context.setAccount` (no RPC airdrop exists in-process)
 *  - timelocks are crossed with `warp()` (bankrun clock sysvar), not sleeps
 *  - `await nowPlus()` is anchored on the bankrun clock, not wall-clock time
 */
import { startAnchor, Clock } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Ed25519Program,
  Transaction,
  Signer,
} from "@solana/web3.js";
import {
  createMint,
  mintTo,
  createAccount,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import * as crypto from "crypto";
import * as assert from "assert";
import bs58 from "bs58";
import { XcmHtlc } from "../target/types/xcm_htlc";
import idl from "../target/idl/xcm_htlc.json";

// ---------------------------------------------------------------------------
// Same fixed cross-VM test vector as xcm_htlc.ts (documented there).
// ---------------------------------------------------------------------------
const VECTOR_SECRET = Buffer.from(
  "xcm-htlc-vector-v1-32bytes!!!!!!",
  "utf8"
);
const VECTOR_DIGEST_HEX =
  "5b9a96bad43ae10d584a4310b79d57d70e1b2f5ab89ea58b20f9f2091f3e463b";

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest();

// System program address: only for the UNUSED non-mutable `tokenProgram`
// field on SOL fills. Never use for mutable accounts (it is executable).
const SYS = SystemProgram.programId;

const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

describe("xcm_htlc (bankrun)", () => {
  let context: Awaited<ReturnType<typeof startAnchor>>;
  let provider: BankrunProvider;
  let program: Program<XcmHtlc>;
  let connection: any;
  let clockBase: bigint;
  // Ordinary funded system-owned account used as the mutable placeholder
  // for unused token accounts on SOL fills.
  let dummyToken: PublicKey;

  /** Advance the bankrun clock by `secs` (replaces wall-clock sleeps). */
  const warp = async (secs: number) => {
    const c = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        c.slot + BigInt(Math.max(1, Math.ceil(secs * 2.5))),
        c.epochStartTimestamp,
        c.epoch,
        c.leaderScheduleEpoch,
        c.unixTimestamp + BigInt(secs)
      )
    );
  };

  /** Timelock timestamps anchored on the CURRENT bankrun clock (not wall clock).
   * Reads the clock fresh each call because warp() advances it globally. */
  const nowPlus = async (secs: number) => {
    const c = await context.banksClient.getClock();
    return new BN((c.unixTimestamp + BigInt(secs)).toString());
  };

  /** Fund an account by writing state directly (no RPC airdrop in-process). */
  const airdrop = async (to: PublicKey, sol = 10) => {
    context.setAccount(to, {
      lamports: sol * LAMPORTS_PER_SOL,
      data: new Uint8Array(0),
      owner: SystemProgram.programId,
      executable: false,
      rentEpoch: 0,
    });
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

  /** getAccountInfo that returns null (not throw) when the account is closed. */
  const getAcct = async (pk: PublicKey) => {
    try {
      return await connection.getAccountInfo(pk);
    } catch (e: any) {
      if (String(e?.message || e).includes("Could not find")) return null;
      throw e;
    }
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

  /** Accounts for a SOL-fill initialize (unused token fields = placeholder). */
  const solInitAccounts = (
    maker: PublicKey,
    receiver: PublicKey,
    refundAddr: PublicKey
  ) => ({
    funder: maker,
    receiver,
    refundAddr,
    funderToken: dummyToken,
    escrowToken: dummyToken,
    tokenProgram: SYS,
  });

  /** Accounts for a SOL-fill withdraw. */
  const solWithdrawAccounts = (
    claimer: PublicKey,
    pda: PublicKey,
    receiver: PublicKey
  ) => ({
    claimer,
    escrow: pda,
    receiver,
    escrowToken: dummyToken,
    receiverToken: dummyToken,
    tokenProgram: SYS,
  });

  /** Accounts for a SOL-fill refund. */
  const solRefundAccounts = (
    caller: PublicKey,
    pda: PublicKey,
    refundAddr: PublicKey
  ) => ({
    caller,
    escrow: pda,
    refundAddr,
    escrowToken: dummyToken,
    refundToken: dummyToken,
    tokenProgram: SYS,
  });

  before(async () => {
    context = await startAnchor(
      __dirname + "/..",
      [{ name: "spl_token", programId: TOKEN_PROGRAM }],
      []
    );
    provider = new BankrunProvider(context);

    // Patch the bankrun connection proxy with the RPC-shaped helpers the
    // tests (and @solana/spl-token) expect. All state goes through the
    // in-process banks client; nothing touches the network.
    connection = provider.connection as any;
    const banksClient = context.banksClient;
    connection.requestAirdrop = async (to: PublicKey, lamports: number) => {
      await airdrop(to, lamports / LAMPORTS_PER_SOL);
      return bs58.encode(crypto.randomBytes(64));
    };
    connection.confirmTransaction = async () => ({ value: { err: null } });
    connection.getBalance = async (pk: PublicKey) =>
      Number((await banksClient.getAccount(pk))?.lamports ?? 0n);
    connection.getLatestBlockhash = async () => {
      const [blockhash] = await banksClient.getLatestBlockhash();
      return { blockhash, lastValidBlockHeight: Number.MAX_SAFE_INTEGER };
    };
    connection.sendTransaction = async (
      tx: Transaction,
      signers?: Signer[]
    ) => provider.sendAndConfirm(tx, signers ?? []);
    connection.getTokenAccountBalance = async (pk: PublicKey) => {
      const acc = await getAccount(connection, pk);
      return {
        value: { amount: acc.amount.toString(), decimals: 0, uiAmount: 0 },
      };
    };

    program = new Program<XcmHtlc>(idl as any, provider);
    anchor.setProvider(provider as any);
    clockBase = (await banksClient.getClock()).unixTimestamp;
    await airdrop(provider.wallet.publicKey, 100);

    // Create the mutable placeholder account for unused token fields.
    const dummy = Keypair.generate();
    await airdrop(dummy.publicKey, 1);
    dummyToken = dummy.publicKey;
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
        await nowPlus(3600),
        null, // mint: None = native SOL
        amount,
        Array.from(fillId),
        null, // arbiter
        null, // exclusive_claimer
        new BN(0)
      )
      .accounts(solInitAccounts(maker.publicKey, receiver, refundAddr))
      .signers([maker])
      .rpc();

    const escrowBefore = await getAcct(pda);
    assert.ok(escrowBefore, "escrow PDA should exist after initialize");
    const escrowRent = escrowBefore.lamports - amount.toNumber();

    // Anyone may submit the claim (payout is hardcoded); use a third party.
    const claimer = Keypair.generate();
    await airdrop(claimer.publicKey, 1);
    const recvBefore = await connection.getBalance(receiver);

    await program.methods
      .withdraw(Array.from(secret))
      .accounts(solWithdrawAccounts(claimer.publicKey, pda, receiver))
      .signers([claimer])
      .rpc();

    const recvAfter = await connection.getBalance(receiver);
    // Receiver gets the escrowed amount plus the PDA's rent (the close
    // sends remaining lamports to the receiver on SOL withdraws).
    assert.ok(
      recvAfter - recvBefore >= amount.toNumber(),
      "receiver should get at least the escrowed amount"
    );
    assert.strictEqual(
      await getAcct(pda),
      null,
      "escrow PDA should be closed after withdraw"
    );
    // Rent goes back to the funder implicitly via close; just check the
    // escrow no longer holds funds.
    assert.ok(escrowRent > 0, "escrow should have held rent");
  });

  // -------------------------------------------------------------------------
  it("SPL happy path: initialize -> withdraw pays receiver token account, vault closes", async () => {
    const maker = Keypair.generate();
    const receiver = Keypair.generate();
    const refundAddr = Keypair.generate().publicKey;
    await airdrop(maker.publicKey);
    await airdrop(receiver.publicKey, 1);

    // Locally-created test mint (throwaway, in-process bank only).
    // Use the provider wallet's payer Keypair so BankrunProvider's
    // sendAndConfirm (which always has the wallet sign) works.
    const payer = (provider.wallet as any).payer as Keypair;
    const mintAuthority = Keypair.generate();
    const mint = await createMint(
      connection,
      payer,
      mintAuthority.publicKey,
      null,
      6
    );
    // Ordinary token accounts (not ATAs): maker funds, vault owned by PDA.
    // Provide explicit keypairs so createAccount does NOT try to make an
    // associated token account (which would reject the off-curve PDA owner).
    const makerTokKeypair = Keypair.generate();
    const makerTok = await createAccount(
      connection,
      payer,
      mint,
      maker.publicKey,
      makerTokKeypair
    );
    await mintTo(connection, payer, mint, makerTok, mintAuthority, 2_000_000_000);

    const { secret, hashlock, fillId, pda } = newFill();
    const amount = new BN(750_000_000);

    // Pre-create the escrow vault token account (authority = escrow PDA).
    // The program does not require a canonical ATA; any token account
    // owned by the PDA works.
    const vaultKeypair = Keypair.generate();
    const vault = await createAccount(
      connection,
      payer,
      mint,
      pda,
      vaultKeypair
    );

    await program.methods
      .initialize(
        receiver.publicKey,
        refundAddr,
        Array.from(hashlock),
        await nowPlus(3600),
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
        funderToken: makerTok,
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

    const receiverTokKeypair = Keypair.generate();
    const receiverTok = await createAccount(
      connection,
      payer,
      mint,
      receiver.publicKey,
      receiverTokKeypair
    );

    await program.methods
      .withdraw(Array.from(secret))
      .accounts({
        claimer: receiver.publicKey,
        escrow: pda,
        receiver: receiver.publicKey,
        escrowToken: vault,
        receiverToken: receiverTok,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([receiver])
      .rpc();

    const recvTok = await getAccount(connection, receiverTok);
    assert.strictEqual(
      Number(recvTok.amount),
      amount.toNumber(),
      "receiver token account should get the full amount"
    );
    const vaultAfter = await getAcct(vault);
    assert.strictEqual(vaultAfter, null, "vault should be closed");
    const escrowAfter = await getAcct(pda);
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
        await nowPlus(3), // expires in 3s
        null,
        amount,
        Array.from(fillId),
        null,
        null,
        new BN(0)
      )
      .accounts(solInitAccounts(maker.publicKey, receiver, refundAddr))
      .signers([maker])
      .rpc();

    await warp(5); // cross the timelock via the bankrun clock

    const thirdParty = Keypair.generate();
    await airdrop(thirdParty.publicKey, 1);
    const refundBefore = await connection.getBalance(refundAddr);

    await program.methods
      .refund()
      .accounts(solRefundAccounts(thirdParty.publicKey, pda, refundAddr))
      .signers([thirdParty])
      .rpc();

    const refundAfter = await connection.getBalance(refundAddr);
    assert.ok(
      refundAfter - refundBefore >= amount.toNumber(),
      "refund_addr should receive amount (+ rent)"
    );
    assert.strictEqual(
      await getAcct(pda),
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
        receiver, refundAddr, Array.from(hashlock), await nowPlus(3600),
        null, new BN(100_000), Array.from(fillId), null, null, new BN(0)
      )
      .accounts(solInitAccounts(maker.publicKey, receiver, refundAddr))
      .signers([maker])
      .rpc();

    await expectCode(
      program.methods
        .withdraw(Array.from(crypto.randomBytes(32)))
        .accounts(solWithdrawAccounts(maker.publicKey, pda, receiver))
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
        receiver, refundAddr, Array.from(hashlock), await nowPlus(3),
        null, new BN(100_000), Array.from(fillId), null, null, new BN(0)
      )
      .accounts(solInitAccounts(maker.publicKey, receiver, refundAddr))
      .signers([maker])
      .rpc();

    await warp(5);

    await expectCode(
      program.methods
        .withdraw(Array.from(secret))
        .accounts(solWithdrawAccounts(maker.publicKey, pda, receiver))
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
        receiver, refundAddr, Array.from(hashlock), await nowPlus(3600),
        null, new BN(100_000), Array.from(fillId), null, null, new BN(0)
      )
      .accounts(solInitAccounts(maker.publicKey, receiver, refundAddr))
      .signers([maker])
      .rpc();

    await expectCode(
      program.methods
        .refund()
        .accounts(solRefundAccounts(maker.publicKey, pda, refundAddr))
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
        receiver, refundAddr, Array.from(f1.hashlock), await nowPlus(7200),
        null, new BN(100_000), Array.from(f1.fillId),
        null, winner.publicKey, await nowPlus(3600)
      )
      .accounts(solInitAccounts(maker.publicKey, receiver, refundAddr))
      .signers([maker])
      .rpc();

    await expectCode(
      program.methods
        .withdraw(Array.from(f1.secret))
        .accounts(solWithdrawAccounts(stranger.publicKey, f1.pda, receiver))
        .signers([stranger])
        .rpc(),
      "NotExclusiveClaimer"
    );

    // Fill 2: exclusivity expires in 3s; after that a stranger may claim.
    const f2 = newFill();
    await program.methods
      .initialize(
        receiver, refundAddr, Array.from(f2.hashlock), await nowPlus(7200),
        null, new BN(100_000), Array.from(f2.fillId),
        null, winner.publicKey, await nowPlus(3)
      )
      .accounts(solInitAccounts(maker.publicKey, receiver, refundAddr))
      .signers([maker])
      .rpc();

    await warp(5);

    const recvBefore = await connection.getBalance(receiver);
    await program.methods
      .withdraw(Array.from(f2.secret))
      .accounts(solWithdrawAccounts(stranger.publicKey, f2.pda, receiver))
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
    const amount = new BN(3_000_000);

    await program.methods
      .initialize(
        receiver, refundAddr, Array.from(hashlock), await nowPlus(3600),
        null, amount, Array.from(fillId),
        arbiter.publicKey, // arbiter set -> MEDIATED
        null, new BN(0)
      )
      .accounts(solInitAccounts(maker.publicKey, receiver, refundAddr))
      .signers([maker])
      .rpc();

    // Build the exact signed message:
    // "XCM-ARBITRATE-v1" || escrow_pda || recipients || amounts(u64 LE)
    // Amounts are rent-exempt (>= ~890k lamports for a new system account).
    const recipients = [payeeA, payeeB];
    const amounts = [new BN(2_000_000), new BN(1_000_000)];
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
        escrowToken: dummyToken,
        tokenProgram: SYS,
      })
      .preInstructions([edIx])
      .remainingAccounts(
        recipients.map((r) => ({ pubkey: r, isWritable: true, isSigner: false }))
      )
      .signers([caller])
      .rpc();

    assert.strictEqual(
      (await connection.getBalance(payeeA)) - aBefore,
      2_000_000,
      "payee A should receive 2M lamports"
    );
    assert.strictEqual(
      (await connection.getBalance(payeeB)) - bBefore,
      1_000_000,
      "payee B should receive 1M lamports"
    );
    assert.strictEqual(
      await getAcct(pda),
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
        receiver, refundAddr, Array.from(hashlock), await nowPlus(3600),
        null, new BN(100_000), Array.from(fillId),
        null, // no arbiter -> pure HTLC
        null, new BN(0)
      )
      .accounts(solInitAccounts(maker.publicKey, receiver, refundAddr))
      .signers([maker])
      .rpc();

    const payee = Keypair.generate().publicKey;
    await expectCode(
      program.methods
        .arbitrate([payee], [new BN(100_000)])
        .accounts({
          caller: maker.publicKey, escrow: pda, refundAddr,
          escrowToken: dummyToken, tokenProgram: SYS,
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
        receiver, refundAddr, Array.from(hashlock), await nowPlus(3600),
        null, new BN(100_000), Array.from(fillId),
        arbiter.publicKey, null, new BN(0)
      )
      .accounts(solInitAccounts(maker.publicKey, receiver, refundAddr))
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
          escrowToken: dummyToken, tokenProgram: SYS,
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
        receiver, refundAddr, Array.from(h), await nowPlus(3600),
        null, amount, Array.from(fillId), null, null, new BN(0)
      )
      .accounts(solInitAccounts(maker.publicKey, receiver, refundAddr))
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
      .accounts(solWithdrawAccounts(maker.publicKey, pda, receiver))
      .signers([maker])
      .rpc();
  });
});
