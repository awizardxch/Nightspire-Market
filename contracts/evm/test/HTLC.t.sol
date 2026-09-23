// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HTLCFactory} from "../src/HTLCFactory.sol";
import {HTLCEscrow} from "../src/HTLCEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Unit tests for the EVM HTLC escrow slice (spec §5a, §7 fillId, §8
///         exclusive windows, §9 timelocks, §13 no fee skim).
contract HTLCTest is Test {
    HTLCFactory internal factory;
    MockERC20 internal token;

    address internal maker = address(0xA11CE);
    address internal taker = address(0xB0B);
    address internal thirdParty = address(0xD00D);
    address internal winner = address(0xF111E1);
    uint256 internal arbiterPk = 0xC0FFEE;
    address internal arbiter;

    bytes32 internal secret; // maker-owned secret s (fresh per fill)
    bytes32 internal hashlock; // h = sha256(s)
    bytes32 internal fillId; // sha256(offerId || fillNonce)

    uint256 internal constant AMOUNT = 1_000e18;
    uint256 internal constant T0 = 1_700_000_000;

    function setUp() public {
        vm.warp(T0);
        factory = new HTLCFactory();
        token = new MockERC20("Test Token", "TT", 18);
        arbiter = vm.addr(arbiterPk);

        secret = keccak256("maker secret, fresh per fill #1");
        hashlock = sha256(abi.encodePacked(secret));
        bytes32 offerId = keccak256("offer-uuid-1");
        fillId = sha256(abi.encodePacked(offerId, uint256(1)));

        token.mint(maker, 10 * AMOUNT);
        token.mint(taker, 10 * AMOUNT);
        vm.deal(maker, 100_000 ether); // AMOUNT is 1000 ether — needs headroom
        vm.deal(taker, 100_000 ether);
    }

    /// @dev Lock helper for the ERC-20 path.
    function _lockERC20(
        address locker,
        address receiver,
        address refundAddr,
        uint256 timelock,
        uint256 amount,
        bytes32 _fillId,
        address _arbiter,
        address exclusiveClaimer,
        uint256 exclusiveUntil
    ) internal returns (HTLCEscrow escrow) {
        vm.startPrank(locker);
        token.approve(address(factory), amount);
        address escrowAddr = factory.newContract(
            receiver, refundAddr, hashlock, timelock, address(token), amount, _fillId, _arbiter, exclusiveClaimer, exclusiveUntil
        );
        vm.stopPrank();
        escrow = HTLCEscrow(payable(escrowAddr));
    }

    // ------------------------------------------------------------------
    // Happy paths
    // ------------------------------------------------------------------

    function test_happyPath_erc20() public {
        uint256 takerBefore = token.balanceOf(taker);

        HTLCEscrow escrow = _lockERC20(maker, taker, maker, T0 + 6 hours, AMOUNT, fillId, address(0), address(0), 0);
        assertEq(token.balanceOf(address(escrow)), AMOUNT, "escrow funded");

        // Watcher-facing event check: Withdrawn exposes the preimage.
        vm.expectEmit(true, true, true, true);
        emit HTLCEscrow.Withdrawn(escrow.CONTRACT_ID(), fillId, secret, taker, AMOUNT);

        vm.prank(taker);
        escrow.withdraw(secret);

        assertEq(token.balanceOf(taker), takerBefore + AMOUNT, "receiver got full amount");
        assertEq(token.balanceOf(address(escrow)), 0, "escrow drained");
    }

    function test_happyPath_native() public {
        uint256 takerBefore = taker.balance;

        vm.prank(maker);
        address escrowAddr = factory.newContract{value: AMOUNT}(
            taker, maker, hashlock, T0 + 6 hours, address(0), AMOUNT, fillId, address(0), address(0), 0
        );
        HTLCEscrow escrow = HTLCEscrow(payable(escrowAddr));
        assertEq(address(escrow).balance, AMOUNT, "escrow funded with native");

        vm.prank(taker);
        escrow.withdraw(secret);

        assertEq(taker.balance, takerBefore + AMOUNT, "receiver got full native amount");
        assertEq(address(escrow).balance, 0, "escrow drained");
    }

    // ------------------------------------------------------------------
    // Refund path (§9): refund pays refundAddr, callable by anyone
    // ------------------------------------------------------------------

    function test_refund_paysRefundAddr_evenWhenCalledByThirdParty() public {
        HTLCEscrow escrow = _lockERC20(maker, taker, maker, T0 + 6 hours, AMOUNT, fillId, address(0), address(0), 0);
        uint256 makerBefore = token.balanceOf(maker); // baseline AFTER the lock pulled funds

        vm.warp(T0 + 6 hours + 1);

        // A random third party triggers the refund — funds still go to refundAddr.
        vm.prank(thirdParty);
        escrow.refund();

        assertEq(token.balanceOf(maker), makerBefore + AMOUNT, "refundAddr (maker) made whole");
        assertEq(token.balanceOf(thirdParty), 0, "caller got nothing");
        assertEq(token.balanceOf(address(escrow)), 0, "escrow drained");
    }

    function test_refund_beforeTimelock_reverts() public {
        HTLCEscrow escrow = _lockERC20(maker, taker, maker, T0 + 6 hours, AMOUNT, fillId, address(0), address(0), 0);
        vm.expectRevert(HTLCEscrow.TimelockNotReached.selector);
        escrow.refund();
    }

    function test_withdraw_wrongPreimage_reverts() public {
        HTLCEscrow escrow = _lockERC20(maker, taker, maker, T0 + 6 hours, AMOUNT, fillId, address(0), address(0), 0);
        vm.expectRevert(HTLCEscrow.BadPreimage.selector);
        escrow.withdraw(bytes32(uint256(12345)));
    }

    function test_withdraw_afterTimelock_reverts() public {
        HTLCEscrow escrow = _lockERC20(maker, taker, maker, T0 + 6 hours, AMOUNT, fillId, address(0), address(0), 0);
        vm.warp(T0 + 6 hours + 1);
        vm.expectRevert(HTLCEscrow.TimelockExpired.selector);
        vm.prank(taker);
        escrow.withdraw(secret);
    }

    // ------------------------------------------------------------------
    // Arbitrate branch — MEDIATED (spec §5 trust note)
    // ------------------------------------------------------------------

    function _arbSig(HTLCEscrow escrow, address[] memory recipients, uint256[] memory amounts)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = keccak256(abi.encode(address(escrow), escrow.CONTRACT_ID(), recipients, amounts));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_arbitrate_validSig_splitsFunds() public {
        HTLCEscrow escrow = _lockERC20(maker, taker, maker, T0 + 6 hours, AMOUNT, fillId, arbiter, address(0), 0);

        address[] memory recipients = new address[](2);
        recipients[0] = maker;
        recipients[1] = taker;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 700e18;
        amounts[1] = 300e18;

        uint256 makerBefore = token.balanceOf(maker);
        uint256 takerBefore = token.balanceOf(taker);

        // Anyone may relay the arbiter's signed instruction; signature is the authority.
        vm.prank(thirdParty);
        escrow.arbitrate(recipients, amounts, _arbSig(escrow, recipients, amounts));

        assertEq(token.balanceOf(maker), makerBefore + 700e18, "maker got arbiter share");
        assertEq(token.balanceOf(taker), takerBefore + 300e18, "taker got arbiter share");
        assertEq(token.balanceOf(address(escrow)), 0, "escrow drained");
    }

    function test_arbitrate_noArbiter_reverts() public {
        HTLCEscrow escrow = _lockERC20(maker, taker, maker, T0 + 6 hours, AMOUNT, fillId, address(0), address(0), 0);
        address[] memory recipients = new address[](1);
        recipients[0] = maker;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = AMOUNT;
        vm.expectRevert(HTLCEscrow.NoArbiter.selector);
        escrow.arbitrate(recipients, amounts, "");
    }

    function test_arbitrate_badSig_reverts() public {
        HTLCEscrow escrow = _lockERC20(maker, taker, maker, T0 + 6 hours, AMOUNT, fillId, arbiter, address(0), 0);
        address[] memory recipients = new address[](1);
        recipients[0] = maker;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = AMOUNT;
        // Signed by a random key, not the arbiter.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEAD, keccak256(abi.encode(address(escrow), escrow.CONTRACT_ID(), recipients, amounts)));
        vm.expectRevert(HTLCEscrow.BadSignature.selector);
        escrow.arbitrate(recipients, amounts, abi.encodePacked(r, s, v));
    }

    function test_arbitrate_partialSplit_reverts() public {
        HTLCEscrow escrow = _lockERC20(maker, taker, maker, T0 + 6 hours, AMOUNT, fillId, arbiter, address(0), 0);
        address[] memory recipients = new address[](1);
        recipients[0] = maker;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = AMOUNT - 1; // would strand dust
        bytes memory sig = _arbSig(escrow, recipients, amounts); // hoisted: _arbSig makes an external call
        vm.expectRevert(HTLCEscrow.BadSplit.selector);
        escrow.arbitrate(recipients, amounts, sig);
    }

    // ------------------------------------------------------------------
    // Exclusive claim window (§8): only the winner may withdraw during it
    // ------------------------------------------------------------------

    function test_exclusiveWindow() public {
        uint256 exclusiveUntil = T0 + 1 hours;
        HTLCEscrow escrow =
            _lockERC20(maker, winner, maker, T0 + 6 hours, AMOUNT, fillId, address(0), winner, exclusiveUntil);

        // Non-winner with the correct preimage reverts during the window.
        vm.expectRevert(HTLCEscrow.NotExclusiveClaimer.selector);
        vm.prank(taker);
        escrow.withdraw(secret);

        // After the window (but before timelock), anyone with the preimage may claim.
        // Payout still goes to the hardcoded RECEIVER (winner) — the claimer gains nothing.
        vm.warp(exclusiveUntil + 1);
        uint256 winnerBefore = token.balanceOf(winner);
        uint256 takerBefore = token.balanceOf(taker);
        vm.prank(taker);
        escrow.withdraw(secret);
        assertEq(token.balanceOf(winner), winnerBefore + AMOUNT, "post-window claim pays receiver");
        assertEq(token.balanceOf(taker), takerBefore, "claimer got nothing");
    }

    function test_exclusiveWindow_winnerClaimsDuringWindow() public {
        HTLCEscrow escrow =
            _lockERC20(maker, winner, maker, T0 + 6 hours, AMOUNT, fillId, address(0), winner, T0 + 1 hours);
        uint256 winnerBefore = token.balanceOf(winner);
        vm.prank(winner);
        escrow.withdraw(secret);
        assertEq(token.balanceOf(winner), winnerBefore + AMOUNT, "winner claimed during exclusivity");
    }

    function test_exclusiveWindow_requiresClaimer() public {
        vm.startPrank(maker);
        token.approve(address(factory), AMOUNT);
        vm.expectRevert(HTLCFactory.BadExclusiveWindow.selector);
        factory.newContract(taker, maker, hashlock, T0 + 6 hours, address(token), AMOUNT, fillId, address(0), address(0), T0 + 1 hours);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Determinism (§5a, §7): same params -> same id/address; fillId differentiates
    // ------------------------------------------------------------------

    function test_determinism() public {
        bytes32 id1 = factory.computeId(taker, maker, hashlock, T0 + 6 hours, address(token), AMOUNT, fillId, address(0), address(0), 0);
        bytes32 id2 = factory.computeId(taker, maker, hashlock, T0 + 6 hours, address(token), AMOUNT, fillId, address(0), address(0), 0);
        assertEq(id1, id2, "computeId deterministic");

        address predicted = factory.predictAddress(
            taker, maker, hashlock, T0 + 6 hours, address(token), AMOUNT, fillId, address(0), address(0), 0
        );
        HTLCEscrow escrow = _lockERC20(maker, taker, maker, T0 + 6 hours, AMOUNT, fillId, address(0), address(0), 0);
        assertEq(address(escrow), predicted, "predicted address matches deployment");
        assertEq(factory.getContract(id1), address(escrow), "getContract resolves id");

        // A different fillId (different fillNonce) -> different id and address.
        bytes32 otherFillId = sha256(abi.encodePacked(keccak256("offer-uuid-1"), uint256(2)));
        bytes32 id3 = factory.computeId(taker, maker, hashlock, T0 + 6 hours, address(token), AMOUNT, otherFillId, address(0), address(0), 0);
        assertTrue(id3 != id1, "different fillId -> different id");
        address predicted3 = factory.predictAddress(
            taker, maker, hashlock, T0 + 6 hours, address(token), AMOUNT, otherFillId, address(0), address(0), 0
        );
        assertTrue(predicted3 != address(escrow), "different fillId -> different address");
    }

    function test_doubleLock_sameFill_reverts() public {
        _lockERC20(maker, taker, maker, T0 + 6 hours, AMOUNT, fillId, address(0), address(0), 0);
        vm.startPrank(maker);
        token.approve(address(factory), AMOUNT);
        vm.expectRevert(HTLCFactory.AlreadyDeployed.selector);
        factory.newContract(taker, maker, hashlock, T0 + 6 hours, address(token), AMOUNT, fillId, address(0), address(0), 0);
        vm.stopPrank();
    }
}
