# Phase 2 Implementation Plan — EVM Escrow Contract (PYUSD) for DFS Contests

This document is a **standalone implementation plan** for deploying and configuring an EVM escrow contract to support **PYUSD-based paid DFS contests** on **Flow EVM**.

It is based on Phase 2 of `aiSports_frontEnd/aiSports/docs/evm_usd_contests_plan.md`, with a few **critical clarifications** noted inline to make the contract workable for real DFS contest operations.

---

## Goal

- Deploy an escrow contract for **paid DFS contests** with:
  - **PYUSD (6 decimals)** support
  - **Multi-entry** support (e.g. up to **1000 entries per user**)
  - Higher caps for DFS scale (participants/entries, recipients)
  - Shorter minimum escrow duration for daily contests

---

## Key On-Chain Addresses / Networks

- **Flow EVM RPC**
  - **Testnet**: `https://testnet.evm.nodes.onflow.org`
  - **Mainnet**: `https://mainnet.evm.nodes.onflow.org`

- **Chain IDs**
  - **Testnet**: 545
  - **Mainnet**: 747

- **PYUSD**
  - **Mainnet PYUSD**: `0x99af3eea856556646c98c8b9b2548fe815240750`
  - **Testnet PYUSD0**: `0xd7d43ab7b365f0d0789aE83F4385fA710FfdC98F` (stand-in token for testing, has mint function and liquidity pool)

- **Yearn VaultFactory**
  - **Flow EVM mainnet (official)**: `0x770D0d1Fb036483Ed4AbB6d53c1C88fb277D812F`
  - **Testnet/local**: deploy `MockVaultFactory` from `contracts/mocks/`

---

## Repository Layout (this repo)

- **Contracts**: `contracts/`
  - `EscrowManager.sol` (baseline / starting point)
  - `contracts/mocks/*` (mock vault factory + mock yearn vault)
  - `MockToken.sol` (baseline ERC20 mock; may not match PYUSD decimals)

- **Tests**: `test/`
- **Deployment**: `scripts/`
- **Hardhat config**: `hardhat.config.ts`

---

## Important Clarifications (DFS-specific)

Phase 2 calls for multi-entry and daily contest escrows. Two behaviors in the baseline `EscrowManager.sol` are **not suitable** for DFS contest admin-created escrows:

1. **Organizer auto-joins on `createEscrow()`** in the baseline.
   - For DFS, the “organizer” is typically an admin/backend key and **should not be forced to pay dues** every time an escrow is created.
   - **Plan**: remove organizer auto-join (or make it optional) in the DFS version.

2. **“Participants list length” is not “total entries.”**
   - Multi-entry means you must track **total entries** separately from **unique participants**.
   - **Plan**: add a `totalEntries` counter per escrow and per-user entry counts per escrow.

These are addressed below in the contract change checklist.

---

## Step 1 — Create DFS Contract Variant (COMPLETE)

### 1.1 Create new contract file

- **Create**: `contracts/DFSEscrowManager.sol`
- **Base**: copy from `contracts/EscrowManager.sol`

### 1.2 Required constant updates (PYUSD + DFS)

Update the following constants in the DFS variant:

- `MINIMUM_DUES`
  - From: `1 * 1e18`
  - To: `1 * 1e6` (PYUSD has **6 decimals**)

- `MAX_PARTICIPANTS_CAP`
  - From: `10_000`
  - To: `100_000`

- `MAX_RECIPIENTS`
  - From: `30`
  - To: `100`

- `MINIMUM_ESCROW_DURATION`
  - From: `1 days`
  - To: `1 hours`

### 1.3 Add multi-entry state 

Add to the DFS contract:

- **Per-escrow total entries**:
  - `uint256 totalEntries;` inside `Escrow` struct, or
  - a mapping `mapping(uint256 => uint256) public escrowTotalEntries;`

- **Per-escrow per-user entry count**:
  - Recommended:
    - `mapping(uint256 => mapping(address => uint256)) public userEntryCount;`
  - Alternative:
    - store `mapping(address => uint256) entryCount;` inside `Escrow` struct

- **Config**:
  - `uint256 public maxEntriesPerUser = 1000;`
  - Consider whether this should be immutable/constant vs admin-settable.

### 1.4 Update `ParticipantJoined` event (recommended)

For backend verification and better analytics, update the event to include the number of entries:

- From:
  - `event ParticipantJoined(uint256 indexed escrowId, address indexed participant);`
- To:
  - `event ParticipantJoined(uint256 indexed escrowId, address indexed participant, uint256 numEntries);`

### 1.5 Modify `createEscrow()` (remove organizer auto-join)

In the DFS variant:

- **Remove** the “Organizer automatically joins upon creation” block:
  - setting `participants[msg.sender] = true`
  - pushing organizer to `participantsList`
  - pushing escrowId to `joinedEscrows[msg.sender]`
  - transferring dues from organizer and depositing into the vault

Rationale:
- Admin-created escrows should start empty; users join by paying dues.

### 1.6 Modify `joinEscrow()` for multi-entry

Change signature:

- From:
  - `joinEscrow(uint256 _escrowId)`
- To:
  - `joinEscrow(uint256 _escrowId, uint256 _numEntries)`

Behavior:

- Validate:
  - `_numEntries > 0`
  - `block.timestamp <= escrow.endTime`
  - `userEntryCount[_escrowId][msg.sender] + _numEntries <= maxEntriesPerUser`
  - `escrow.totalEntries + _numEntries <= escrow.maxParticipants`
    - **Note**: for DFS, interpret `maxParticipants` as **max entries** (not unique wallets)

- Update state:
  - `userEntryCount[_escrowId][msg.sender] += _numEntries`
  - `escrow.totalEntries += _numEntries`
  - If first time joining (no prior entries):
    - mark `participants[msg.sender] = true`
    - push into `participantsList`
    - append to `joinedEscrows[msg.sender]` **once**

- Token flow:
  - `totalDues = escrow.dues * _numEntries`
  - `safeTransferFrom(msg.sender, address(this), totalDues)`
  - approve + deposit `totalDues` into the escrow’s vault

- Emit:
  - `ParticipantJoined(_escrowId, msg.sender, _numEntries)`

### 1.7 Add view helper (optional)

Add:

- `getUserEntryCount(uint256 escrowId, address user) external view returns (uint256)`

---

## Step 2 — Update Tests for DFS Semantics (COMPLETE)

The baseline tests in `test/EscrowManager.ts` assume:
- organizer auto-joins in `createEscrow()`
- `joinEscrow(uint256)` (no multi-entry)
- 18-decimal dues

For the DFS variant, update tests to:

- **Target**: `DFSEscrowManager` instead of `EscrowManager`
- **Use 6 decimals** for dues in tests (e.g. `parseUnits("1", 6)`)
- **Create escrow without organizer deposit**:
  - `createEscrow()` should not require mint/approve for organizer
- **Join with entries**:
  - `joinEscrow(escrowId, numEntries)`
  - assert `userEntryCount` and `totalEntries` changes
- **Capacity checks**:
  - Fill `totalEntries` to `maxParticipants`, then assert next join reverts
- **Event assertions**:
  - `ParticipantJoined(escrowId, participant, numEntries)`

Recommended: keep the original baseline tests for `EscrowManager.sol` (as regression), and create a new file:

- `test/DFSEscrowManager.ts`

---

## Step 3 — Use Testnet PYUSD0 Contract (COMPLETE)

Phase 2 requires a testnet PYUSD. There is now a live testnet PYUSD0 contract available on Flow EVM testnet.

### Testnet PYUSD0 Contract

- **Address**: `0xd7d43ab7b365f0d0789aE83F4385fA710FfdC98F`
- **Purpose**: Stand-in token for testing purposes only
- **Features**:
  - Has a `mint()` function for testing
  - Has a liquidity pool for swapping tokens
  - Uses 6 decimals (PYUSD standard)

### Notes

- Mainnet PYUSD0 requires real PYUSD locked via LayerZero
- The testnet contract is sufficient for development and testing
- No deployment needed — use the existing contract address

### Configuration

- Use this address in:
  - deployment scripts (when creating escrows on testnet)
  - frontend `.env.local` later
  - backend config later

---

## Step 4 — Deploy `DFSEscrowManager`

### 4.1 Testnet deployment (COMPLETE)

On Flow EVM testnet:
- Deploy `MockVaultFactory` (already handled by the baseline `scripts/deploy.ts` pattern)
- Deploy `DFSEscrowManager` pointing at the mock vault factory address

Recommended: create a dedicated script:
- `scripts/deploy_dfs_escrow_manager.ts`

Inputs:
- `vaultFactoryAddress`:
  - testnet: deployed `MockVaultFactory` address
  - mainnet: official Yearn VaultFactory address

### 4.2 Mainnet deployment

Deploy `DFSEscrowManager` on Flow EVM mainnet with:
- `vaultFactoryAddress = 0x770D0d1Fb036483Ed4AbB6d53c1C88fb277D812F`

No PYUSD address is needed in the constructor if the escrow takes a token address per-escrow (as the baseline does).

---

## Step 5 — Create an Escrow for a Contest (Admin Script)

Create an off-chain admin script (Node/Hardhat task or standalone) that calls:

- `createEscrow(token, dues, endTime, vaultName, maxParticipants)`

Recommended parameters for DFS daily contests (`paid_pyusd_1`):

- `token`:
  - testnet: `0xd7d43ab7b365f0d0789aE83F4385fA710FfdC98F` (PYUSD0 testnet)
  - mainnet: `0x99af3eea856556646c98c8b9b2548fe815240750`
- `dues`: `1_000_000` (1 PYUSD with 6 decimals)
- `endTime`: contest lock timestamp (unix seconds)
- `vaultName`: e.g. `"PYUSD DFS 012526"` (format: `"PYUSD DFS {MMDDYY}"`)
- `maxParticipants`: interpret as **max total entries**, e.g. `100000`

Output:
- capture and persist `escrowId` (from tx receipt logs or contract state)

---

## Step 6 — Backend / Firestore Configuration Handoff

After creating the escrow, store `escrowId` in Firestore so the frontend can look it up for a given contest day:

- `contests/paid_pyusd_1/{MMDDYY}/meta`
  - field: `escrowId: <number>`

The contest document (`contests/paid_pyusd_1`) should also include:
- Standard contest fields: `entry_fee`, `total_prizes`, `max_prize`, `winners`
- Prize config fields: `prize_type="pyusd"`, `prize_label="pyUSD"`, `prize_prefix="$"`, `prize_unit="pyUSD"`, `prize_precision=2`

Also record:
- `escrowManagerAddress` (per environment)
- `pyusdAddress` (per environment)

---

## Step 7 — Environment Variables (for deploy scripts + later frontend)

### Local `.env` for this repo

Create `/Users/cjcarnicle/aiSports/dev/aiSports_evm_escrow/.env`:

```bash
# Testnet deploy key
DEPLOYER_PRIVATE_KEY=...

# Mainnet deploy key
MAINNET_PRIVATE_KEY=...
```

### Frontend env (document here for convenience)

Later in the frontend `.env.local`, you’ll need:

```bash
# Network selection
NEXT_PUBLIC_RUN_TESTNET=true  # or false for mainnet

# EVM contracts (Flow EVM)
NEXT_PUBLIC_EVM_ESCROW_ADDRESS=0x...  # mainnet address
NEXT_PUBLIC_PYUSD_ADDRESS=0x99af3eea856556646c98c8b9b2548fe815240750

NEXT_PUBLIC_EVM_ESCROW_ADDRESS_TESTNET=0x3819AC57110F008D491BBBba4fB14EcbFf45E5D0
NEXT_PUBLIC_PYUSD_ADDRESS_TESTNET=0xd7d43ab7b365f0d0789aE83F4385fA710FfdC98F

# Auth/profile collection (Option A: use dapperAuth even on testnet)
NEXT_PUBLIC_FIREBASE_AUTH_COLLECTION=dapperAuth

# UI gating (optional, for testnet entry control)
NEXT_PUBLIC_DISABLED_TESTNET_CONTEST_ENTRY=false
```

---

## Step 8 — Verification Checklist (Testnet)

- **Obtain** PYUSD0 from testnet contract (`0xd7d43ab7b365f0d0789aE83F4385fA710FfdC98F`)
  - Use `mint()` function or swap via liquidity pool
- **Deploy** `DFSEscrowManager` (testnet address: `0x3819AC57110F008D491BBBba4fB14EcbFf45E5D0`)
- **Create escrow** for a contest day (`paid_pyusd_1`)
- **Join escrow** with:
  - 1 entry (sanity)
  - 5 entries in one call
  - 5 more entries in a second call (ensure cumulative accounting works)
- Confirm:
  - `userEntryCount(escrowId, user)` increments correctly
  - `totalEntries` increments correctly
  - vault receives total assets equal to `dues * totalEntries`
  - `ParticipantJoined` logs include `numEntries`
- Verify Firestore entry docs include `chain_type="evm"` and `chain_network="flowTestnet"` (per Phase 3 Option A)

---

## Step 9 — Notes on Frontend Integration (context only)

Frontend integration is Phase 3, but the contract ABI must match the expected join flow:

- `joinEscrow(uint256 escrowId, uint256 numEntries)`
- `ParticipantJoined(uint256 escrowId, address participant, uint256 numEntries)`

This is important for:
- confirming entries in the backend (tx receipt parsing)
- enforcing per-user entry limits

---

## Phase 2.7 Cleanup (frontend repo)

After this repo is the source of truth and contracts are deployed and verified:

- remove `aiSports_frontEnd/aiSports/docs/example_contract/` from the frontend repo

