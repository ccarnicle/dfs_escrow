# aiSports EVM Escrow Contract

This repository contains the smart contracts for managing PYUSD-based DFS contests on Flow EVM.

## Overview

The `EscrowManager` contract manages the creation, participation, and payout of fantasy sports prize pools. It integrates with Yearn V3 Vaults for secure fund custody, where each escrow gets its own dedicated vault.

## Project Structure

```
aiSports_evm_escrow/
├── contracts/
│   ├── EscrowManager.sol          # Main escrow contract
│   ├── MockToken.sol               # Mock ERC20 token for testing
│   ├── interfaces/
│   │   ├── IERC4626.sol
│   │   ├── IVaultFactory.sol
│   │   └── IYearnVault.sol
│   └── mocks/
│       ├── MockVaultFactory.sol
│       └── MockYearnVault.sol
├── scripts/
│   └── deploy.ts                   # Deployment script
├── test/
│   └── EscrowManager.ts           # Test suite
├── docs/
│   └── implementation_plan.md     # Implementation plan (to be created)
└── hardhat.config.ts              # Hardhat configuration

```

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory:
```bash
DEPLOYER_PRIVATE_KEY=your_testnet_private_key
MAINNET_PRIVATE_KEY=your_mainnet_private_key
```

## Usage

### Compile Contracts
```bash
npm run compile
```

### Run Tests
```bash
npm run test
```

### Deploy to Localhost
```bash
npm run deploy:localhost
```

### Deploy to Flow Testnet
```bash
npm run deploy:flowTestnet
```

### Deploy to Flow Mainnet
```bash
npm run deploy:flowMainnet
```

## Development

This contract is based on the example contract from the frontend repo (`aiSports_frontEnd/aiSports/docs/example_contract/`). 

The contract will be updated in Phase 2.3 to support:
- PYUSD (6 decimals instead of 18)
- Multi-entry support (up to 1000 entries per user)
- DFS contest semantics (daily contests, higher participant caps)

## Networks

- **Flow Testnet**: Chain ID 545
- **Flow Mainnet**: Chain ID 747

## License

MIT
