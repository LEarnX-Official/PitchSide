// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Minimal 6-decimal USDT-like token for local tests and BSC testnet.
 *      (BEP-20 USDT uses 18 decimals on BSC; we use 6 here to also mirror the
 *      more common ERC-20 USDT and to prove the contract is decimals-agnostic —
 *      all amounts are handled as opaque base units.)
 */
contract MockUSDT is ERC20 {
    constructor() ERC20("Mock USDT", "USDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
