// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title HTLCEscrow
/// @notice Non-custodial hashed-timelock escrow for one leg of a cross-chain swap.
/// @dev Deployed per fill by HTLCFactory via CREATE2. All terms are immutable at
///      construction (spec §17: no proxies, no admin keys — nothing can alter an
///      in-flight escrow). Three branches:
///        1. withdraw  — claim with the SHA-256 preimage before timelock;
///        2. refund    — refund to refundAddr after timelock (NEVER msg.sender);
///        3. arbitrate — opt-in MEDIATED branch (see below), only if arbiter != address(0).
///      token == address(0) denotes the chain's native asset.
///      Has hlock uses SHA-256 (EVM precompile 0x02) to match Solana/Chia legs.
contract HTLCEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Who the claim branch pays. Hardcoded at lock time.
    address public immutable RECEIVER;
    /// @notice Who the refund branch pays. Explicit — refund never assumes msg.sender.
    address public immutable REFUND_ADDR;
    /// @notice SHA-256 hashlock; set by the maker at lock time, fresh (s, h) per fill.
    bytes32 public immutable HASHLOCK;
    /// @notice Unix timestamp at/after which refund() unlocks; before which withdraw() unlocks.
    uint256 public immutable TIMELOCK;
    /// @notice Escrowed asset; address(0) = native.
    address public immutable TOKEN;
    /// @notice Escrowed amount in base units.
    uint256 public immutable AMOUNT;
    /// @notice fillId = sha256(offerId || fillNonce); binds this fill, prevents replay confusion.
    bytes32 public immutable FILL_ID;
    /// @notice Deployment identifier (CREATE2 salt) from the factory.
    bytes32 public immutable CONTRACT_ID;
    /// @notice Opt-in arbiter; address(0) = pure HTLC, no third branch.
    address public immutable ARBITER;
    /// @notice Solver-mode exclusive claimer (auction winner); zero = none.
    address public immutable EXCLUSIVE_CLAIMER;
    /// @notice Exclusive window end (unix ts); withdraw restricted to EXCLUSIVE_CLAIMER before this.
    uint256 public immutable EXCLUSIVE_UNTIL;

    /// @notice Emitted on claim. Preimage included so watchers/relay can forward `s` to the counterparty.
    event Withdrawn(bytes32 indexed contractId, bytes32 indexed fillId, bytes32 preimage, address indexed receiver, uint256 amount);
    /// @notice Emitted on refund.
    event Refunded(bytes32 indexed contractId, bytes32 indexed fillId, address indexed refundAddr, uint256 amount);
    /// @notice Emitted on arbiter-directed split.
    event Arbitrated(bytes32 indexed contractId, bytes32 indexed fillId, address indexed arbiter);

    error BadPreimage();
    error TimelockNotReached();
    error TimelockExpired();
    error NotExclusiveClaimer();
    error NoArbiter();
    error BadSignature();
    error LengthMismatch();
    error BadSplit();
    error ZeroRecipient();

    constructor(
        address receiver,
        address refundAddr,
        bytes32 hashlock,
        uint256 timelock,
        address token,
        uint256 amount,
        bytes32 fillId,
        bytes32 contractId,
        address arbiter,
        address exclusiveClaimer,
        uint256 exclusiveUntil
    ) payable {
        RECEIVER = receiver;
        REFUND_ADDR = refundAddr;
        HASHLOCK = hashlock;
        TIMELOCK = timelock;
        TOKEN = token;
        AMOUNT = amount;
        FILL_ID = fillId;
        CONTRACT_ID = contractId;
        ARBITER = arbiter;
        EXCLUSIVE_CLAIMER = exclusiveClaimer;
        EXCLUSIVE_UNTIL = exclusiveUntil;
    }

    /// @notice Claim branch: reveal preimage `s` with sha256(s) == HASHLOCK before TIMELOCK.
    /// @dev During the exclusive window (block.timestamp < EXCLUSIVE_UNTIL) only
    ///      EXCLUSIVE_CLAIMER may call. Pays RECEIVER the full AMOUNT — no fee skim (§13).
    function withdraw(bytes32 preimage) external nonReentrant {
        if (block.timestamp >= TIMELOCK) revert TimelockExpired();
        if (sha256(abi.encodePacked(preimage)) != HASHLOCK) revert BadPreimage();
        if (block.timestamp < EXCLUSIVE_UNTIL && msg.sender != EXCLUSIVE_CLAIMER) {
            revert NotExclusiveClaimer();
        }
        _pay(RECEIVER, AMOUNT);
        emit Withdrawn(CONTRACT_ID, FILL_ID, preimage, RECEIVER, AMOUNT);
    }

    /// @notice Refund branch: after TIMELOCK, anyone may trigger; pays REFUND_ADDR.
    /// @dev Callable by any third party — refund NEVER assumes msg.sender.
    function refund() external nonReentrant {
        if (block.timestamp < TIMELOCK) revert TimelockNotReached();
        _pay(REFUND_ADDR, AMOUNT);
        emit Refunded(CONTRACT_ID, FILL_ID, REFUND_ADDR, AMOUNT);
    }

    /// @notice MEDIATED branch (spec §5 trust note): naming an arbiter converts this
    ///         swap from trustless to MEDIATED. The arbiter can unilaterally reassign
    ///         the locked funds before timelock expiry on its signature alone — no
    ///         counterparty signature required. Opt-in at lock time only; absent by
    ///         default (arbiter == address(0) = pure math-only HTLC).
    /// @dev Verifies the arbiter's ECDSA signature over the RAW digest
    ///      keccak256(abi.encode(address(this), CONTRACT_ID, recipients, amounts))
    ///      — i.e. the arbiter signs the exact 32-byte digest (no EIP-191 prefix).
    ///      Executes the split immediately, in one call. Sum of amounts must equal
    ///      AMOUNT so no dust is left behind.
    function arbitrate(address[] calldata recipients, uint256[] calldata amounts, bytes calldata sig)
        external
        nonReentrant
    {
        if (ARBITER == address(0)) revert NoArbiter();
        if (recipients.length != amounts.length || recipients.length == 0) revert LengthMismatch();
        bytes32 digest = keccak256(abi.encode(address(this), CONTRACT_ID, recipients, amounts));
        if (ECDSA.recover(digest, sig) != ARBITER) revert BadSignature();
        uint256 total;
        for (uint256 i = 0; i < amounts.length; i++) {
            if (recipients[i] == address(0)) revert ZeroRecipient();
            total += amounts[i];
        }
        if (total != AMOUNT) revert BadSplit();
        for (uint256 i = 0; i < recipients.length; i++) {
            _pay(recipients[i], amounts[i]);
        }
        emit Arbitrated(CONTRACT_ID, FILL_ID, ARBITER);
    }

    /// @dev Internal payout; native via call, ERC-20 via SafeERC20. Full amount — §13 no skim.
    function _pay(address to, uint256 value) internal {
        if (TOKEN == address(0)) {
            (bool ok, ) = to.call{value: value}("");
            require(ok, "native transfer failed");
        } else {
            IERC20(TOKEN).safeTransfer(to, value);
        }
    }

    receive() external payable {}
}
