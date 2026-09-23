// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {HTLCEscrow} from "./HTLCEscrow.sol";

/// @title HTLCFactory
/// @notice Deploys per-fill HTLC escrows deterministically (CREATE2). One factory per
///         chain per version (spec §17: no upgrades — new versions deploy alongside).
/// @dev Salt is derived from ALL lock parameters including fillId, so each fill gets a
///      unique, recomputable escrow address. refundAddr is an explicit parameter —
///      refund never assumes msg.sender. No fees are taken anywhere (§13).
contract HTLCFactory {
    using SafeERC20 for IERC20;

    /// @notice salt (contract id) => deployed escrow address.
    mapping(bytes32 => address) public contracts;

    /// @notice Watcher index: every lock is discoverable off-chain from this event.
    event ContractCreated(
        bytes32 indexed id,
        address indexed escrow,
        address indexed token,
        address receiver,
        address refundAddr,
        bytes32 hashlock,
        uint256 timelock,
        uint256 amount,
        bytes32 fillId,
        address arbiter,
        address exclusiveClaimer,
        uint256 exclusiveUntil
    );

    error ZeroReceiver();
    error ZeroRefundAddr();
    error ZeroHashlock();
    error ZeroAmount();
    error TimelockInPast();
    error BadExclusiveWindow();
    error AlreadyDeployed();
    error BadNativeAmount();
    error EscrowNotFunded();

    /// @notice Lock funds into a new HTLC escrow (CREATE2, deterministic address).
    /// @param receiver      Claim branch pays this address.
    /// @param refundAddr    Refund branch pays this address — explicit, never msg.sender.
    /// @param hashlock      sha256(s); maker-generated, fresh per fill.
    /// @param timelock      Unix timestamp: withdraw before, refund at/after.
    /// @param token         Escrowed asset; address(0) = native (function must be payable).
    /// @param amount        Base units to escrow.
    /// @param fillId        sha256(offerId || fillNonce); binds this fill.
    /// @param arbiter       Opt-in MEDIATED arbiter; address(0) = pure HTLC.
    /// @param exclusiveClaimer  Solver-mode auction winner with exclusive claim rights; zero = none.
    /// @param exclusiveUntil    Exclusive window end (unix ts); 0 = no exclusivity.
    /// @return escrow       The deployed escrow address.
    function newContract(
        address receiver,
        address refundAddr,
        bytes32 hashlock,
        uint256 timelock,
        address token,
        uint256 amount,
        bytes32 fillId,
        address arbiter,
        address exclusiveClaimer,
        uint256 exclusiveUntil
    ) external payable returns (address escrow) {
        if (receiver == address(0)) revert ZeroReceiver();
        if (refundAddr == address(0)) revert ZeroRefundAddr();
        if (hashlock == bytes32(0)) revert ZeroHashlock();
        if (amount == 0) revert ZeroAmount();
        if (timelock <= block.timestamp) revert TimelockInPast();
        if (exclusiveUntil > block.timestamp && exclusiveClaimer == address(0)) revert BadExclusiveWindow();

        bytes32 id = computeId(
            receiver, refundAddr, hashlock, timelock, token, amount, fillId, arbiter, exclusiveClaimer, exclusiveUntil
        );
        if (contracts[id] != address(0)) revert AlreadyDeployed();

        if (token == address(0)) {
            // Native variant: msg.value funds the escrow directly.
            if (msg.value != amount) revert BadNativeAmount();
            escrow = address(new HTLCEscrow{salt: id, value: msg.value}(
                receiver, refundAddr, hashlock, timelock, token, amount, fillId, id, arbiter, exclusiveClaimer, exclusiveUntil
            ));
        } else {
            // ERC-20 variant: pulls via safeTransferFrom — caller must approve first.
            if (msg.value != 0) revert BadNativeAmount();
            escrow = address(new HTLCEscrow{salt: id}(
                receiver, refundAddr, hashlock, timelock, token, amount, fillId, id, arbiter, exclusiveClaimer, exclusiveUntil
            ));
            IERC20(token).safeTransferFrom(msg.sender, escrow, amount);
        }

        contracts[id] = escrow;
        emit ContractCreated(
            id, escrow, token, receiver, refundAddr, hashlock, timelock, amount, fillId, arbiter, exclusiveClaimer, exclusiveUntil
        );
    }

    /// @notice Deterministic contract id (CREATE2 salt) for a parameter set.
    function computeId(
        address receiver,
        address refundAddr,
        bytes32 hashlock,
        uint256 timelock,
        address token,
        uint256 amount,
        bytes32 fillId,
        address arbiter,
        address exclusiveClaimer,
        uint256 exclusiveUntil
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(receiver, refundAddr, hashlock, timelock, token, amount, fillId, arbiter, exclusiveClaimer, exclusiveUntil)
        );
    }

    /// @notice Escrow address for a contract id (address(0) if not deployed).
    function getContract(bytes32 id) external view returns (address) {
        return contracts[id];
    }

    /// @notice Predict the CREATE2 address for a parameter set WITHOUT deploying.
    /// @dev CREATE2 init code = creationCode ++ abi.encode(constructor args); the
    ///      factory deploys with salt = computeId(...), so recompute both here.
    function predictAddress(
        address receiver,
        address refundAddr,
        bytes32 hashlock,
        uint256 timelock,
        address token,
        uint256 amount,
        bytes32 fillId,
        address arbiter,
        address exclusiveClaimer,
        uint256 exclusiveUntil
    ) external view returns (address) {
        bytes32 id = computeId(
            receiver, refundAddr, hashlock, timelock, token, amount, fillId, arbiter, exclusiveClaimer, exclusiveUntil
        );
        bytes memory initCode = abi.encodePacked(
            type(HTLCEscrow).creationCode,
            abi.encode(receiver, refundAddr, hashlock, timelock, token, amount, fillId, id, arbiter, exclusiveClaimer, exclusiveUntil)
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), id, keccak256(initCode))))));
    }
}
