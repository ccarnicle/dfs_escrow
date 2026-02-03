// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IYearnVault} from "../interfaces/IYearnVault.sol";

/**
 * @title MockYearnVault
 * @author aiSports
 * @notice A simplified mock of a Yearn V3 Vault for testing purposes.
 * @dev It mimics the basic deposit/withdraw and asset tracking functionalities
 * required for the EscrowManager tests. It is not a full ERC4626 implementation.
 */
contract MockYearnVault is IYearnVault, ERC20 {
    using SafeERC20 for IERC20;

    IERC20 internal immutable _asset;

    // --- Mock state variables for testing ---
    mapping(address => uint256) public roles;
    uint256 public depositLimit;
    uint256 public slippageBps; // Slippage in basis points (e.g., 100 bps = 1%)

    // --- Constructor ---
    constructor(
        address assetAddress,
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) {
        _asset = IERC20(assetAddress);
    }

    // --- Mocked IYearnVault / ERC4626 Functions ---

    function totalAssets() external view override returns (uint256) {
        return _asset.balanceOf(address(this));
    }

    function deposit(uint256 _assets, address _receiver) external override returns (uint256) {
        // This mock now simulates the core logic of a deposit:
        // It transfers assets from the caller (EscrowManager) to itself.
        // It mints shares (this contract's own ERC20 tokens) to the receiver.
        _asset.safeTransferFrom(msg.sender, address(this), _assets);
        _mint(_receiver, _assets); // Simple 1:1 asset-to-share ratio for mock
        return _assets;
    }

    function withdraw(uint256 _assets, address _receiver, address _owner) external override returns (uint256) {
        // In this mock, the EscrowManager (`_owner`) calls withdraw and is also the `_receiver`.
        // We just need to ensure we transfer the assets out.
        require(_owner == msg.sender, "MockVault: Caller must be owner");
        
        uint256 amountToTransfer = _assets;
        if (slippageBps > 0) {
            amountToTransfer = (_assets * (10000 - slippageBps)) / 10000;
        }

        _asset.safeTransfer(_receiver, amountToTransfer);
        // We will return the amount of assets as a stand-in for shares.
        return amountToTransfer;
    }

    // --- Mocked implementations for new interface functions ---
    function set_role(address _account, uint256 _role) external override {
        // This mock stores the role for the account so tests can verify it.
        roles[_account] = _role;
    }

    function set_deposit_limit(uint256 _limit, bool) external override {
        // This mock stores the deposit limit so tests can verify it.
        depositLimit = _limit;
    }

    function set_slippage_bps(uint256 _slippageBps) external {
        require(_slippageBps <= 10000, "Slippage cannot exceed 100%");
        slippageBps = _slippageBps;
    }

    // --- Implemented ERC4626 Functions ---

    function asset() external view override returns (address) {
        return address(_asset);
    }

    // --- Unimplemented ERC4626 Functions ---
    // These are not required for our tests, but are part of the interface.

    function convertToShares(uint256) external pure override returns (uint256) {
        revert("Not implemented in mock");
    }

    function convertToAssets(uint256) external pure override returns (uint256) {
        revert("Not implemented in mock");
    }

    function maxDeposit(address) external pure override returns (uint256) {
        revert("Not implemented in mock");
    }

    function previewDeposit(uint256) external pure override returns (uint256) {
        revert("Not implemented in mock");
    }

    function maxMint(address) external pure override returns (uint256) {
        revert("Not implemented in mock");
    }

    function previewMint(uint256) external pure override returns (uint256) {
        revert("Not implemented in mock");
    }

    function mint(uint256, address) external pure override returns (uint256) {
        revert("Not implemented in mock");
    }

    function maxWithdraw(address) external view override returns (uint256) {
        return this.totalAssets();
    }

    function previewWithdraw(uint256) external pure override returns (uint256) {
        revert("Not implemented in mock");
    }

    function maxRedeem(address) external pure override returns (uint256) {
        revert("Not implemented in mock");
    }

    function previewRedeem(uint256) external pure override returns (uint256) {
        revert("Not implemented in mock");
    }

    function redeem(uint256, address, address) external pure override returns (uint256) {
        revert("Not implemented in mock");
    }
}