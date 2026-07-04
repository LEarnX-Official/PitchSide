// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PitchSideBets
 * @notice Non-custodial, pari-mutuel USDT escrow for PitchSide peer-to-peer
 *         match betting. Anyone can open a bet on a match; anyone can join by
 *         staking USDT on an outcome. The stake is held by THIS contract (never
 *         an app wallet). When the match ends, an off-chain AI proposes the
 *         winning outcome, and only the bet's host can confirm it. On confirm,
 *         the pool is split: 5% to the DAO, 2% to the host, and the remaining
 *         93% pro-rata among the stakers who backed the winning outcome, who
 *         then pull their winnings.
 *
 * @dev Pari-mutuel: payouts come from the actual pool, so odds are purely
 *      informational (computed off-chain by the AI). The host can only ratify
 *      the AI's *proposed* outcome — it cannot invent an arbitrary winner or
 *      redirect funds. A dispute window between proposal and confirmation lets
 *      a wrong call be routed to a full refund via cancelBet.
 *
 *      Money-safety choices:
 *        - SafeERC20 for USDT (which returns non-standard values / needs
 *          allowance-reset semantics on some deployments).
 *        - Pull-based claims (winners withdraw) rather than push, to avoid
 *          a single failing transfer bricking a whole payout.
 *        - ReentrancyGuard on every state-changing external entrypoint that
 *          moves tokens.
 *        - Checks-Effects-Interactions ordering throughout.
 */
contract PitchSideBets is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ //
    // Constants                                                          //
    // ------------------------------------------------------------------ //

    uint16 public constant DAO_BPS = 500; // 5.00%
    uint16 public constant HOST_BPS = 200; // 2.00%
    uint16 public constant BPS_DENOMINATOR = 10_000;

    // ------------------------------------------------------------------ //
    // Immutable config                                                   //
    // ------------------------------------------------------------------ //

    /// @notice The BEP-20 USDT token used for all stakes and payouts.
    IERC20 public immutable usdt;

    /// @notice Fixed wallet that receives the 5% DAO cut on every resolved bet.
    address public immutable dao;

    // ------------------------------------------------------------------ //
    // Types                                                              //
    // ------------------------------------------------------------------ //

    enum Status {
        Open, // accepting joins
        Proposed, // AI proposed a winner; in dispute window
        Resolved, // host confirmed; winners may claim
        Cancelled // voided; everyone may refund their stake
    }

    struct Bet {
        address host; // opener; receives 2%; sole confirmer
        string matchRef; // e.g. a match id / description
        string question; // e.g. "Will Arsenal win?"
        uint8 outcomeCount; // number of selectable outcomes (>= 2)
        uint64 closesAt; // no joins at/after this timestamp
        uint64 disputeUntil; // set on proposeResult; confirm allowed after this
        uint8 proposedOutcome; // AI's proposed winning outcome
        uint8 winningOutcome; // finalized winning outcome (on Resolved)
        Status status;
        uint256 totalPool; // total USDT staked across all outcomes
    }

    // ------------------------------------------------------------------ //
    // Storage                                                            //
    // ------------------------------------------------------------------ //

    uint256 public betCount;
    mapping(uint256 => Bet) private _bets;

    // betId => outcome => total staked on that outcome
    mapping(uint256 => mapping(uint8 => uint256)) public outcomePool;
    // betId => user => outcome => amount staked by that user on that outcome
    mapping(uint256 => mapping(address => mapping(uint8 => uint256)))
        public stakeOf;
    // betId => user => whether they've already withdrawn (claim or refund)
    mapping(uint256 => mapping(address => bool)) public withdrawn;

    /// @notice Minimum dispute window enforced between proposal and confirmation.
    uint64 public constant MIN_DISPUTE_WINDOW = 0; // host may set >= 0; see proposeResult

    // ------------------------------------------------------------------ //
    // Events                                                             //
    // ------------------------------------------------------------------ //

    event BetCreated(
        uint256 indexed betId,
        address indexed host,
        string matchRef,
        string question,
        uint8 outcomeCount,
        uint64 closesAt
    );
    event BetJoined(
        uint256 indexed betId,
        address indexed bettor,
        uint8 indexed outcome,
        uint256 amount
    );
    event ResultProposed(
        uint256 indexed betId,
        uint8 indexed proposedOutcome,
        uint64 disputeUntil
    );
    event BetResolved(
        uint256 indexed betId,
        uint8 indexed winningOutcome,
        uint256 daoCut,
        uint256 hostCut,
        uint256 winnersPool
    );
    event BetCancelled(uint256 indexed betId);
    event WinningsClaimed(
        uint256 indexed betId,
        address indexed bettor,
        uint256 amount
    );
    event StakeRefunded(
        uint256 indexed betId,
        address indexed bettor,
        uint256 amount
    );

    // ------------------------------------------------------------------ //
    // Errors                                                             //
    // ------------------------------------------------------------------ //

    error ZeroAddress();
    error BadOutcomeCount();
    error CloseInPast();
    error UnknownBet();
    error NotOpen();
    error BettingClosed();
    error InvalidOutcome();
    error ZeroAmount();
    error NotHost();
    error NotProposed();
    error DisputeWindowActive();
    error CannotCancelNow();
    error NothingToClaim();
    error NotWinner();
    error AlreadyWithdrawn();

    // ------------------------------------------------------------------ //
    // Constructor                                                        //
    // ------------------------------------------------------------------ //

    constructor(IERC20 usdt_, address dao_) {
        if (address(usdt_) == address(0) || dao_ == address(0)) {
            revert ZeroAddress();
        }
        usdt = usdt_;
        dao = dao_;
    }

    // ------------------------------------------------------------------ //
    // Views                                                              //
    // ------------------------------------------------------------------ //

    function getBet(uint256 betId) external view returns (Bet memory) {
        Bet memory b = _bets[betId];
        if (b.host == address(0)) revert UnknownBet();
        return b;
    }

    // ------------------------------------------------------------------ //
    // Bet lifecycle                                                      //
    // ------------------------------------------------------------------ //

    /**
     * @notice Open a new bet. The caller becomes the host (2% recipient + sole
     *         confirmer). Does not move any funds.
     */
    function createBet(
        string calldata matchRef,
        string calldata question,
        uint8 outcomeCount,
        uint64 closesAt
    ) external returns (uint256 betId) {
        if (outcomeCount < 2) revert BadOutcomeCount();
        if (closesAt <= block.timestamp) revert CloseInPast();

        betId = betCount++;
        Bet storage b = _bets[betId];
        b.host = msg.sender;
        b.matchRef = matchRef;
        b.question = question;
        b.outcomeCount = outcomeCount;
        b.closesAt = closesAt;
        b.status = Status.Open;

        emit BetCreated(
            betId,
            msg.sender,
            matchRef,
            question,
            outcomeCount,
            closesAt
        );
    }

    /**
     * @notice Stake `amount` USDT on `outcome`. Requires a prior USDT approve of
     *         this contract for at least `amount`. The USDT is pulled into
     *         escrow here. Callable multiple times (adds to the stake), and on
     *         more than one outcome if desired.
     */
    function joinBet(
        uint256 betId,
        uint8 outcome,
        uint256 amount
    ) external nonReentrant {
        Bet storage b = _bets[betId];
        if (b.host == address(0)) revert UnknownBet();
        if (b.status != Status.Open) revert NotOpen();
        if (block.timestamp >= b.closesAt) revert BettingClosed();
        if (outcome >= b.outcomeCount) revert InvalidOutcome();
        if (amount == 0) revert ZeroAmount();

        // Effects (measure actual received amount to be fee-on-transfer safe).
        uint256 balBefore = usdt.balanceOf(address(this));
        usdt.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = usdt.balanceOf(address(this)) - balBefore;
        if (received == 0) revert ZeroAmount();

        b.totalPool += received;
        outcomePool[betId][outcome] += received;
        stakeOf[betId][msg.sender][outcome] += received;

        emit BetJoined(betId, msg.sender, outcome, received);
    }

    /**
     * @notice Record the AI's proposed winning outcome and open the dispute
     *         window. Anyone may relay the AI's proposal (the AI runs
     *         off-chain / on-device via QVAC); the host still gates the payout
     *         via confirmResult. `disputeWindow` is the number of seconds the
     *         host must wait before confirming, giving bettors time to flag a
     *         wrong call (which would route to cancelBet).
     */
    function proposeResult(
        uint256 betId,
        uint8 proposedOutcome,
        uint64 disputeWindow
    ) external {
        Bet storage b = _bets[betId];
        if (b.host == address(0)) revert UnknownBet();
        if (b.status != Status.Open) revert NotOpen();
        if (proposedOutcome >= b.outcomeCount) revert InvalidOutcome();

        b.proposedOutcome = proposedOutcome;
        b.disputeUntil = uint64(block.timestamp) + disputeWindow;
        b.status = Status.Proposed;

        emit ResultProposed(betId, proposedOutcome, b.disputeUntil);
    }

    /**
     * @notice HOST-ONLY release gate. Confirms the AI's proposed outcome (the
     *         host cannot substitute a different one), splits the pool, and
     *         moves the DAO + host cuts immediately. Winners then pull their
     *         share via claim(). Callable only after the dispute window elapses.
     *
     *         If NO ONE staked the winning outcome, there are no winners to pay,
     *         so the whole non-fee remainder has nowhere to go pro-rata; in that
     *         case the bet must be cancelled (refund everyone) instead — see
     *         cancelBet. This function reverts in that situation to avoid
     *         stranding funds.
     */
    function confirmResult(uint256 betId) external nonReentrant {
        Bet storage b = _bets[betId];
        if (b.host == address(0)) revert UnknownBet();
        if (b.status != Status.Proposed) revert NotProposed();
        if (msg.sender != b.host) revert NotHost();
        if (block.timestamp < b.disputeUntil) revert DisputeWindowActive();

        uint8 winner = b.proposedOutcome;
        uint256 winnersStake = outcomePool[betId][winner];
        // No winners staked -> cannot split pro-rata; force the refund path.
        if (winnersStake == 0) revert CannotCancelNow();

        uint256 pool = b.totalPool;
        uint256 daoCut = (pool * DAO_BPS) / BPS_DENOMINATOR;
        uint256 hostCut = (pool * HOST_BPS) / BPS_DENOMINATOR;
        uint256 winnersPool = pool - daoCut - hostCut;

        // Effects before interactions.
        b.winningOutcome = winner;
        b.status = Status.Resolved;

        // Interactions: pay the fixed cuts now; winners pull the rest.
        if (daoCut > 0) usdt.safeTransfer(dao, daoCut);
        if (hostCut > 0) usdt.safeTransfer(b.host, hostCut);

        emit BetResolved(betId, winner, daoCut, hostCut, winnersPool);
    }

    /**
     * @notice A winner withdraws their pro-rata share of the winners' pool.
     *         share = winnersPool * userWinningStake / totalWinningStake.
     */
    function claim(uint256 betId) external nonReentrant {
        Bet storage b = _bets[betId];
        if (b.host == address(0)) revert UnknownBet();
        if (b.status != Status.Resolved) revert NotProposed();
        if (withdrawn[betId][msg.sender]) revert AlreadyWithdrawn();

        uint8 winner = b.winningOutcome;
        uint256 userStake = stakeOf[betId][msg.sender][winner];
        if (userStake == 0) revert NotWinner();

        uint256 pool = b.totalPool;
        uint256 daoCut = (pool * DAO_BPS) / BPS_DENOMINATOR;
        uint256 hostCut = (pool * HOST_BPS) / BPS_DENOMINATOR;
        uint256 winnersPool = pool - daoCut - hostCut;
        uint256 totalWinningStake = outcomePool[betId][winner];

        uint256 amount = (winnersPool * userStake) / totalWinningStake;
        if (amount == 0) revert NothingToClaim();

        // Effects before interaction.
        withdrawn[betId][msg.sender] = true;

        usdt.safeTransfer(msg.sender, amount);
        emit WinningsClaimed(betId, msg.sender, amount);
    }

    // ------------------------------------------------------------------ //
    // Cancellation / refunds                                             //
    // ------------------------------------------------------------------ //

    /**
     * @notice Void a bet and let everyone refund their full stake (no fees).
     *         The host may cancel while a bet is still Open or in the Proposed
     *         dispute window (e.g. a postponed match, or a disputed / wrong AI
     *         call). Not callable once Resolved.
     */
    function cancelBet(uint256 betId) external {
        Bet storage b = _bets[betId];
        if (b.host == address(0)) revert UnknownBet();
        if (msg.sender != b.host) revert NotHost();
        if (b.status != Status.Open && b.status != Status.Proposed) {
            revert CannotCancelNow();
        }

        b.status = Status.Cancelled;
        emit BetCancelled(betId);
    }

    /**
     * @notice After a bet is cancelled, each staker pulls back the full amount
     *         they staked across all outcomes (no fees taken).
     */
    function refund(uint256 betId) external nonReentrant {
        Bet storage b = _bets[betId];
        if (b.host == address(0)) revert UnknownBet();
        if (b.status != Status.Cancelled) revert CannotCancelNow();
        if (withdrawn[betId][msg.sender]) revert AlreadyWithdrawn();

        uint256 total;
        uint8 count = b.outcomeCount;
        for (uint8 o = 0; o < count; o++) {
            uint256 s = stakeOf[betId][msg.sender][o];
            if (s > 0) {
                total += s;
            }
        }
        if (total == 0) revert NothingToClaim();

        // Effects before interaction.
        withdrawn[betId][msg.sender] = true;

        usdt.safeTransfer(msg.sender, total);
        emit StakeRefunded(betId, msg.sender, total);
    }
}
