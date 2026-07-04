// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IPitchSideBets {
    function claim(uint256 betId) external;
}

/**
 * @dev A malicious ERC-20 that attempts to re-enter PitchSideBets.claim during
 *      the safeTransfer payout. Used to prove ReentrancyGuard blocks a nested
 *      claim. The re-entrant call is expected to revert; we swallow it so the
 *      outer transfer still succeeds and the test can assert the guard held
 *      (exactly one payout, not two).
 */
contract ReentrantToken is ERC20 {
    address public bets;
    uint256 public targetBetId;
    bool public attackArmed;
    bool public reentered;

    constructor() ERC20("Reentrant USDT", "rUSDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address bets_, uint256 betId_) external {
        bets = bets_;
        targetBetId = betId_;
        attackArmed = true;
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        super._update(from, to, value);
        // Re-enter only on the payout transfer FROM the bets contract TO the
        // attacker (i.e. during claim's safeTransfer).
        if (attackArmed && from == bets && to != address(0) && !reentered) {
            reentered = true;
            // Attempt a nested claim; the guard should make it revert. We catch
            // so the legitimate outer transfer completes.
            try IPitchSideBets(bets).claim(targetBetId) {
                // If this ever succeeds, the guard failed.
            } catch {
                // Expected: ReentrancyGuardReentrantCall.
            }
        }
    }
}
