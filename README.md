# aiSports EVM Escrow Contracts

Smart contracts for **stablecoin-based fantasy sports contests** across multiple EVM networks (starting with **Arbitrum Sepolia**), designed to be consumed by the broader aiSports app.

## Overview

The primary contract in this repo is **`DFSEscrowManager`** (`contracts/DFSEscrowManager.sol`). It manages:

- **Escrow creation** for a contest (organizer/authorized creator)
- **Joining** an escrow with **multi-entry** support (up to `maxEntriesPerUser`, default 1000)
- **Pool top-ups** (sponsors/organizer can add funds)
- **Payout distribution** after the contest ends (organizer-triggered)
- **Overflow handling** (any surplus funds go to an overflow recipient; defaults to organizer)
- **Authorized creators**: the owner can whitelist which addresses are allowed to create escrows

Funds are custody’d inside a **Yearn-style ERC-4626 vault per escrow**. On testnets (and networks without an official factory), the deployment uses `MockVaultFactory` / `MockYearnVault`.

> Note: `EscrowManager.sol` remains in the repo as an earlier version; `DFSEscrowManager.sol` is the DFS-specific, current contract.

## What’s deployed

### Arbitrum Sepolia (live)

See `deployments/arbitrumSepolia.md` for the canonical addresses and verification commands.

- **`DFSEscrowManager`**: `0x3819AC57110F008D491BBBba4fB14EcbFf45E5D0`
- **`MockVaultFactory`**: `0x1dCE6e45eaf73B15E26139F365d4Bf622D69fff0`
- **Official PYUSD (Arbitrum Sepolia)**: `0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1` (faucet-backed)

To mint Arbitrum Sepolia PYUSD for testing, use the Paxos faucet at `https://faucet.paxos.com/`.

## Supported networks (Hardhat)

Configured in `hardhat.config.ts`:

- **Flow EVM Testnet**: `flowTestnet` (chainId 545; explorer via FlowScan)
- **Flow EVM Mainnet**: `flowMainnet` (chainId 747)
- **Arbitrum Sepolia**: `arbitrumSepolia` (chainId 421614)
- **Base Sepolia**: `baseSepolia` (chainId 84532)
- **Mainnet placeholders**: `arbitrumOne` (42161), `base` (8453)

## Project structure

```
aiSports_evm_escrow/
├── contracts/
│   ├── DFSEscrowManager.sol            # Primary contract (DFS + PYUSD 6-decimals + multi-entry)
│   ├── EscrowManager.sol               # Legacy contract
│   ├── MockToken.sol                   # Mock ERC20 used for local/tests
│   ├── interfaces/
│   │   ├── IERC4626.sol
│   │   ├── IVaultFactory.sol
│   │   └── IYearnVault.sol
│   └── mocks/
│       ├── MockVaultFactory.sol
│       └── MockYearnVault.sol
├── scripts/
│   ├── deploy_dfs_escrow_manager.ts    # Deploy DFSEscrowManager (+ vault factory resolution)
│   └── deploy.ts                       # Deploy legacy EscrowManager
├── deployments/
│   └── arbitrumSepolia.md              # Deployed addresses + verification commands
├── test/
│   ├── DFSEscrowManager.ts
│   └── EscrowManager.ts
└── hardhat.config.ts
```

## Setup

Install:

```bash
npm install
```

Create `.env`:

```bash
# Used for testnets (flowTestnet, arbitrumSepolia, baseSepolia)
DEPLOYER_PRIVATE_KEY=...

# Used for mainnets/placeholders (flowMainnet, arbitrumOne, base)
MAINNET_PRIVATE_KEY=...

# Optional (contract verification). Hardhat is configured for Etherscan API v2.
ETHERSCAN_API_KEY=...
```

## Common commands

```bash
npm run compile
npm run test
npm run node
```

## Deploy

### Deploy `DFSEscrowManager` (recommended)

Local:

```bash
npm run deploy:dfs:localhost
```

Flow:

```bash
npm run deploy:dfs:testnet
npm run deploy:dfs:mainnet
```

Arbitrum / Base:

```bash
npm run deploy:dfs:arbitrumSepolia
npm run deploy:dfs:baseSepolia

# Placeholders (addresses TBD)
npm run deploy:dfs:arbitrumOne
npm run deploy:dfs:base
```

The deploy script prints the values you’ll want to paste into your frontend/backend env vars (for example `NEXT_PUBLIC_EVM_ESCROW_ADDRESS_ARB_SEPOLIA`).

### Deploy legacy `EscrowManager`

```bash
npm run deploy:flowTestnet
npm run deploy:flowMainnet
```

## Verify contracts

Arbitrum Sepolia verification commands are documented in `deployments/arbitrumSepolia.md`. Example:

```bash
# DFSEscrowManager (constructor arg: vaultFactoryAddress)
npx hardhat verify --network arbitrumSepolia <DFSEscrowManager_ADDRESS> <vaultFactoryAddress>

# MockVaultFactory (no constructor args)
npx hardhat verify --network arbitrumSepolia <MockVaultFactory_ADDRESS>
```

## Integration notes (aiSports app)

In the broader multi-chain aiSports system, each contest carries a `chain_network` (e.g. `"arbitrumSepolia"`, `"flowTestnet"`). The backend/frontend resolve the correct RPC + contract + token addresses from a per-network registry, so **multiple EVM networks can be supported at the same time**.

## License

MIT
