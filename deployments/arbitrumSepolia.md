# Arbitrum Sepolia Deployment

Deployed: 2026-02-16 (Phase 1 multi-chain EVM support)

## Addresses

| Contract            | Address |
|---------------------|---------|
| DFSEscrowManager    | `0x3819AC57110F008D491BBBba4fB14EcbFf45E5D0` |
| MockVaultFactory    | `0x1dCE6e45eaf73B15E26139F365d4Bf622D69fff0` |
| PYUSD (official)    | `0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1` |

Use these in backend/frontend env (Steps 2, 7, 8, 12 of multi_chain_evm_support plan).

## Verify on Arbiscan

Both contracts are verified. Hardhat is configured to use a single `ETHERSCAN_API_KEY` in `.env` (Etherscan API v2; one key for all supported chains).

To re-verify or verify on another deployment:

```bash
# DFSEscrowManager (constructor: vaultFactory address)
npx hardhat verify --network arbitrumSepolia <DFSEscrowManager_ADDRESS> <vaultFactoryAddress>

# MockVaultFactory (no constructor args)
npx hardhat verify --network arbitrumSepolia <MockVaultFactory_ADDRESS>
```
