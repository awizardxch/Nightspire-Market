// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {HTLCFactory} from "../src/HTLCFactory.sol";
import {HTLCEscrow} from "../src/HTLCEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice End-to-end test of spec §3.1 — the full 7-step DIRECT swap flow as ONE
///         test, simulating both agents (maker + taker) in-process:
///
///           1. OFFER      — maker & taker agree on terms (off-chain, in test setup)
///           2. COMMIT     — taker commits {offerId, f, fillNonce} (off-chain message);
///                           fillId = sha256(offerId || fillNonce)
///           3. MAKER LOCK — maker generates FRESH s, locks f of TKA in HTLC_A (T1 long,
///                           receiver=taker, refundAddr=maker)
///           4. TAKER LOCK — taker verifies HTLC_A ON-CHAIN (amount, hashlock, timelock,
///                           receiver, refundAddr, fillId), then locks f of TKB in
///                           HTLC_B (T2 < T1, receiver=maker, refundAddr=taker)
///           5. MAKER CLAIM — maker claims HTLC_B with s -> s is public (Withdrawn event)
///           6. TAKER CLAIM — taker reads s from chain B's Withdrawn event, claims HTLC_A
///           7. SETTLED    — final balances prove the atomic swap completed
///
///         This proves the maker-owned-secret choreography: the taker never creates
///         s, learns it only from the maker's on-chain claim, and both legs settle
///         atomically-or-not-at-all (refund paths remain available on ghosting).
contract DirectSwapE2ETest is Test {
    // "Chain A" and "chain B" are two factory instances — same codebase, independent state.
    HTLCFactory internal factoryA;
    HTLCFactory internal factoryB;
    MockERC20 internal tokenA; // maker's give asset, on chain A
    MockERC20 internal tokenB; // taker's give asset, on chain B

    address internal maker = address(0xA11CE);
    address internal taker = address(0xB0B);

    uint256 internal constant T0 = 1_700_000_000;
    uint256 internal constant FILL_A = 1_000e18; // maker gives 1000 TKA
    uint256 internal constant FILL_B = 500e18; // taker gives 500 TKB

    function setUp() public {
        vm.warp(T0);
        factoryA = new HTLCFactory();
        factoryB = new HTLCFactory();
        tokenA = new MockERC20("Token A", "TKA", 18);
        tokenB = new MockERC20("Token B", "TKB", 18);
        tokenA.mint(maker, 10 * FILL_A);
        tokenB.mint(taker, 10 * FILL_B);
    }

    function test_directSwap_fullFlow() public {
        // ---- 1. OFFER (off-chain agreement) ----
        // Maker offers: give 1000 TKA on chain A, want 500 TKB on chain B.
        // minFillAmount <= f <= remaining holds (f == full offer here).
        uint256 T1 = T0 + 6 hours; // maker leg locked FIRST -> expires LAST (§9 iron rule)
        uint256 T2 = T0 + 3 hours; // taker leg, shorter
        assertTrue(T1 > T2, "iron rule: first-locked leg expires last");

        // ---- 2. COMMIT (off-chain signed message) ----
        bytes32 offerId = keccak256("offer-uuid-e2e-1");
        uint256 fillNonce = 7;
        bytes32 fillId = sha256(abi.encodePacked(offerId, fillNonce)); // §7

        // ---- 3. MAKER LOCK ----
        // Maker generates a FRESH secret s (never reused across fills) and h = sha256(s).
        bytes32 s = keccak256("fresh maker secret for fillNonce 7");
        bytes32 h = sha256(abi.encodePacked(s));

        vm.startPrank(maker);
        tokenA.approve(address(factoryA), FILL_A);
        address escrowAAddr = factoryA.newContract(
            taker, // receiver: takerAddrs.giveChain
            maker, // refundAddr: maker's address on chain A — EXPLICIT, never msg.sender
            h,
            T1,
            address(tokenA),
            FILL_A,
            fillId,
            address(0), // arbiter: null -> pure HTLC, math-only trust
            address(0), // no exclusive claimer (direct mode)
            0
        );
        vm.stopPrank();
        HTLCEscrow escrowA = HTLCEscrow(payable(escrowAAddr));
        assertEq(tokenA.balanceOf(escrowAAddr), FILL_A, "maker leg funded");

        // ---- 4. TAKER LOCK ----
        // Taker VERIFIES HTLC_A on-chain before locking (chain is truth, §12 rule zero).
        assertEq(escrowA.RECEIVER(), taker, "receiver binding");
        assertEq(escrowA.REFUND_ADDR(), maker, "refund binding");
        assertEq(escrowA.HASHLOCK(), h, "hashlock matches maker's h");
        assertEq(escrowA.TIMELOCK(), T1, "timelock matches");
        assertEq(escrowA.TOKEN(), address(tokenA), "token matches");
        assertEq(escrowA.AMOUNT(), FILL_A, "amount matches");
        assertEq(escrowA.FILL_ID(), fillId, "fillId bound");

        vm.startPrank(taker);
        tokenB.approve(address(factoryB), FILL_B);
        address escrowBAddr = factoryB.newContract(
            maker, // receiver: makerRecvAddr on chain B
            taker, // refundAddr: taker's address on chain B
            h, // SAME h, from the maker's lock proof
            T2,
            address(tokenB),
            FILL_B,
            fillId,
            address(0),
            address(0),
            0
        );
        vm.stopPrank();
        HTLCEscrow escrowB = HTLCEscrow(payable(escrowBAddr));
        assertEq(tokenB.balanceOf(escrowBAddr), FILL_B, "taker leg funded");

        // ---- 5. MAKER CLAIM ----
        // Maker claims HTLC_B with s. s becomes public via the Withdrawn event —
        // the taker's watcher reads it from chain B (recorded logs here).
        vm.recordLogs();
        vm.prank(maker);
        escrowB.withdraw(s);
        assertEq(tokenB.balanceOf(maker), FILL_B, "maker received TKB");

        // Taker's watcher extracts s from the Withdrawn event (preimage is public).
        bytes32 revealed = _preimageFromWithdrawnLogs();
        assertEq(revealed, s, "taker learned s from chain B");

        // ---- 6. TAKER CLAIM ----
        // Taker claims HTLC_A with the revealed s, before T1.
        vm.prank(taker);
        escrowA.withdraw(revealed);
        assertEq(tokenA.balanceOf(taker), FILL_A, "taker received TKA");

        // ---- 7. SETTLED ----
        // Atomicity-or-nothing: maker gave TKA / got TKB; taker gave TKB / got TKA.
        assertEq(tokenA.balanceOf(maker), 9 * FILL_A, "maker TKA balance");
        assertEq(tokenB.balanceOf(maker), FILL_B, "maker TKB balance");
        assertEq(tokenA.balanceOf(taker), FILL_A, "taker TKA balance");
        assertEq(tokenB.balanceOf(taker), 9 * FILL_B, "taker TKB balance");
        assertEq(tokenA.balanceOf(escrowAAddr), 0, "escrow A drained");
        assertEq(tokenB.balanceOf(escrowBAddr), 0, "escrow B drained");
    }

    /// @dev Extract the preimage from the Withdrawn event in the recorded logs,
    ///      mimicking what the taker's watcher does on chain B.
    function _preimageFromWithdrawnLogs() internal returns (bytes32 preimage) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("Withdrawn(bytes32,bytes32,bytes32,address,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) {
                (preimage, ) = abi.decode(logs[i].data, (bytes32, uint256));
                return preimage;
            }
        }
        revert("Withdrawn event not found");
    }
}
