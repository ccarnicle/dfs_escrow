// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "./IERC4626.sol";

interface IYearnVault is IERC4626 {
    // Functions required to configure a newly created vault.
    function set_role(address account, uint256 role) external;
    function set_deposit_limit(uint256 deposit_limit, bool _override) external;
} 