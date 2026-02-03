// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IVaultFactory} from "../../contracts/interfaces/IVaultFactory.sol";
import {MockYearnVault} from "./MockYearnVault.sol";

/**
 * @title MockVaultFactory
 * @author aiSports
 * @notice A mock of the Yearn V3 Vault Factory for testing purposes.
 * @dev It deploys instances of MockYearnVault.
 */
contract MockVaultFactory is IVaultFactory {
    event MockVaultDeployed(address vaultAddress);

    /**
     * @notice Deploys a new MockYearnVault.
     * @dev The role_manager and profit_max_unlock_time parameters are ignored in this mock.
     * @return The address of the newly deployed mock vault.
     */
    function deploy_new_vault(
        address asset,
        string calldata name,
        string calldata symbol,
        address, // role_manager is ignored in mock
        uint256 // profit_max_unlock_time is ignored in mock
    ) external returns (address) {
        MockYearnVault newVault = new MockYearnVault(asset, name, symbol);
        address newVaultAddress = address(newVault);
        emit MockVaultDeployed(newVaultAddress);
        return newVaultAddress;
    }
} 