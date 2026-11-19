// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Read {
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title AuditSealRegistry
 * @notice Immutable hourly Merkle commitment registry for CurveGuard sniper-wall & swarm audits
 *         on Robinhood Chain (4663).
 *
 * Security & Trust Properties:
 *  1. Zero custody / zero approvals: this contract never holds ETH or tokens and never calls transferFrom.
 *  2. Append-only seals: once `epochHour` is sealed, its `merkleRoot` cannot be overwritten or deleted
 *     by anyone (including owner or sealer). Missed hours stay visibly unsealed (`sealedAt == 0`).
 *  3. Sorted-pair Keccak-256 verification: anyone can verify any token's audit leaf onchain via
 *     `verifyAuditLeaf` or client-side in browser/CLI against `getSeal(epochHour)`.
 *  4. One-time token binding: `bindToken` sets the CurveGuard ERC-20 address once for read-only `tierOf`.
 */
contract AuditSealRegistry {
    struct EpochSeal {
        bytes32 merkleRoot;
        uint64 sealedAt;
        uint32 tokenCount;
        uint32 cleanCount;
    }

    error Unauthorized();
    error ZeroValue();
    error AlreadySealed(uint64 epochHour);
    error TokenAlreadyBound();

    uint256 public constant HOLDER_TIER_1 = 1_000_000 ether;
    uint256 public constant HOLDER_TIER_2 = 5_000_000 ether;

    address public owner;
    address public sealer;
    address public guardToken;

    uint64 public latestEpoch;
    uint64 public totalEpochsSealed;

    mapping(uint64 => EpochSeal) private _seals;

    event EpochSealed(
        uint64 indexed epochHour,
        bytes32 indexed merkleRoot,
        uint32 tokenCount,
        uint32 cleanCount,
        uint64 sealedAt
    );
    event SealerUpdated(address indexed previousSealer, address indexed newSealer);
    event GuardTokenBound(address indexed token);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor() {
        owner = msg.sender;
        sealer = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit SealerUpdated(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlySealer() {
        if (msg.sender != sealer && msg.sender != owner) revert Unauthorized();
        _;
    }

    /**
     * @notice Commits an immutable Merkle root for `epochHour` (UTC unix timestamp floored to 3600s or 1800s).
     */
    function sealEpoch(
        uint64 epochHour,
        bytes32 merkleRoot,
        uint32 tokenCount,
        uint32 cleanCount
    ) external onlySealer {
        if (epochHour == 0 || merkleRoot == bytes32(0) || tokenCount == 0) revert ZeroValue();
        if (_seals[epochHour].sealedAt != 0) revert AlreadySealed(epochHour);

        uint64 ts = uint64(block.timestamp);
        _seals[epochHour] = EpochSeal({
            merkleRoot: merkleRoot,
            sealedAt: ts,
            tokenCount: tokenCount,
            cleanCount: cleanCount
        });

        unchecked {
            totalEpochsSealed += 1;
        }
        if (epochHour > latestEpoch) {
            latestEpoch = epochHour;
        }

        emit EpochSealed(epochHour, merkleRoot, tokenCount, cleanCount, ts);
    }

    /**
     * @notice Returns the immutable seal metadata for `epochHour`.
     */
    function getSeal(uint64 epochHour)
        external
        view
        returns (
            bytes32 merkleRoot,
            uint64 sealedAt,
            uint32 tokenCount,
            uint32 cleanCount
        )
    {
        EpochSeal memory s = _seals[epochHour];
        return (s.merkleRoot, s.sealedAt, s.tokenCount, s.cleanCount);
    }

    /**
     * @notice Verifies a sorted-pair Keccak-256 Merkle proof against the onchain root for `epochHour`.
     */
    function verifyAuditLeaf(
        uint64 epochHour,
        bytes32 leafHash,
        bytes32[] calldata proof
    ) external view returns (bool) {
        bytes32 expectedRoot = _seals[epochHour].merkleRoot;
        if (expectedRoot == bytes32(0)) return false;

        bytes32 computed = leafHash;
        uint256 len = proof.length;
        for (uint256 i = 0; i < len; ) {
            bytes32 sibling = proof[i];
            if (computed <= sibling) {
                computed = keccak256(abi.encodePacked(computed, sibling));
            } else {
                computed = keccak256(abi.encodePacked(sibling, computed));
            }
            unchecked {
                ++i;
            }
        }
        return computed == expectedRoot;
    }

    /**
     * @notice Binds the CurveGuard token address once at T=0 for read-only holder tier lookups.
     */
    function bindToken(address token_) external onlyOwner {
        if (token_ == address(0)) revert ZeroValue();
        if (guardToken != address(0)) revert TokenAlreadyBound();
        guardToken = token_;
        emit GuardTokenBound(token_);
    }

    /**
     * @notice Pure read-only balance tier check (`0` = Free, `1` = 1M Clean-Feed, `2` = 5M Pro Swarm-Watch).
     */
    function tierOf(address wallet) external view returns (uint8 tier, uint256 balance) {
        address tok = guardToken;
        if (tok == address(0) || wallet == address(0)) return (0, 0);
        balance = IERC20Read(tok).balanceOf(wallet);
        if (balance >= HOLDER_TIER_2) return (2, balance);
        if (balance >= HOLDER_TIER_1) return (1, balance);
        return (0, balance);
    }

    function setSealer(address newSealer) external onlyOwner {
        if (newSealer == address(0)) revert ZeroValue();
        emit SealerUpdated(sealer, newSealer);
        sealer = newSealer;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroValue();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
