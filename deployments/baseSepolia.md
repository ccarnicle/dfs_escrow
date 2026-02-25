# Base Sepolia Deployment

Deployed: 2026-02-25

## Addresses

| Contract            | Address |
|---------------------|---------|
| DFSEscrowManager    | `0x3819AC57110F008D491BBBba4fB14EcbFf45E5D0` |
| MockVaultFactory    | `0x1dCE6e45eaf73B15E26139F365d4Bf622D69fff0` |
| USDC (official)     | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Deployer wallet: `0xD7F0044096b602d017a8C4D7Be5dC33371f05ef5`

## Deployment Commands

```bash
npm run deploy:dfs:baseSepolia
```

## Verify on BaseScan

Both contracts are verified. Hardhat is configured to use a single `ETHERSCAN_API_KEY` in `.env` (Etherscan API v2; one key for all supported chains).

✅ **DFSEscrowManager**: Verified on [BaseScan](https://sepolia.basescan.org/address/0x3819AC57110F008D491BBBba4fB14EcbFf45E5D0#code)  
✅ **MockVaultFactory**: Verified on [BaseScan](https://sepolia.basescan.org/address/0x1dCE6e45eaf73B15E26139F365d4Bf622D69fff0#code)

To re-verify or verify on another deployment:

```bash
# DFSEscrowManager (constructor: vaultFactory address)
npx hardhat verify --network baseSepolia 0x3819AC57110F008D491BBBba4fB14EcbFf45E5D0 0x1dCE6e45eaf73B15E26139F365d4Bf622D69fff0

# MockVaultFactory (no constructor args)
npx hardhat verify --network baseSepolia 0x1dCE6e45eaf73B15E26139F365d4Bf622D69fff0
```

