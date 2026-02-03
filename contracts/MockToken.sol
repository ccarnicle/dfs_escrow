// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockToken
 * @author aiSports
 * @notice A standard ERC20 token for testing purposes.
 * @dev Includes a public mint function to allow any account to mint tokens for tests.
 */
contract MockToken is ERC20, Ownable {
    constructor() ERC20("Mock Token", "MTK") Ownable(msg.sender) {}

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
} 