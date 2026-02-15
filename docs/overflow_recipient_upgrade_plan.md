# Upgrade Plan — Overflow Recipient + Surplus Handling for DFSEscrowManager (Testnet)

This plan upgrades `DFSEscrowManager` to support **partial payouts** (prizes < pool) by introducing an **overflow recipient** (defaults to organizer), and by replacing the current ±3% tolerance rule with:

- **require**: `totalPayout <= maxWithdrawable`

Surplus funds are withdrawn and routed to the overflow recipient.

---

## Status

### ✅ Completed
- **Contract Implementation**: All contract changes implemented in `contracts/DFSEscrowManager.sol`
  - Overflow recipient storage mapping and events added
  - `createEscrow()` updated to accept optional overflow recipient parameter
  - `setOverflowRecipient()` setter function added
  - `distributeWinnings()` updated with new overflow handling logic
  - Custom errors `InsufficientPool` and `InsufficientWithdrawn` added
  - Contract compiles successfully

- **Test Suite**: All tests implemented and passing (73 tests)
  - Updated all existing `createEscrow` calls to include overflow recipient parameter
  - Updated `WinningsDistributed` event checks for new signature
  - Added tests for all scenarios (A, B, C, D, E, G) as specified in plan
  - All tests passing successfully

### ✅ Completed - Deployment
- **Deployment**: ✅ Successfully deployed to Flow EVM testnet
  - Contract Address: `0x700D1E5B9c66E58322f7aE6D154FcbB65165955b`
  - Explorer: https://evm-testnet.flowscan.io/address/0x700D1E5B9c66E58322f7aE6D154FcbB65165955b

### 🔄 Next Steps (Pending)
- **Frontend Updates**: Update testnet escrow manager address and event ABI
- **Backend Updates**: Update `createEscrow` signature and event parsing in `firebase_v2`
- **Smoke Testing**: Verify functionality on testnet

---

## Goals

- Allow `distributeWinnings` to succeed when:
  - pool is **greater than** the prize payouts (surplus)
  - pool is **equal to** the prize payouts (exact)
- Keep admin workflow simple for DFS:
  - winners get exact specified prizes
  - any leftover funds go to overflow recipient (default organizer)

---

## Non-Goals (for now)

- No overflow caps / rake caps
- No on-chain accounting of “rake” vs “prize pool”
- No migration of existing deployed escrow manager (testnet only; redeploy new manager)

---

## Contract Changes (`contracts/DFSEscrowManager.sol`)

### 1) Add overflow recipient storage + events

**State**
- Add mapping: `mapping(uint256 => address) public overflowRecipient;`
  - If unset / zero, treat as `escrow.organizer` (default behavior)

**Events**
- Add:
  - `event OverflowRecipientSet(uint256 indexed escrowId, address indexed recipient);`
- Update/replace `WinningsDistributed` event to include overflow info (recommended):
  - `event WinningsDistributed(uint256 indexed escrowId, address[] winners, uint256[] amounts, address overflowRecipient, uint256 overflowAmount);`

### 2) Update `createEscrow()` to accept optional overflow recipient

Modify `createEscrow()` signature to include optional overflow recipient parameter:

- **Add parameter**: `address _overflowRecipient` (last parameter, optional)
- **New signature**:
  ```solidity
  function createEscrow(
      address _token,
      uint256 _dues,
      uint256 _endTime,
      string calldata _vaultName,
      uint256 _maxParticipants,
      address _overflowRecipient  // <-- new optional parameter
  ) external nonReentrant onlyAuthorizedCreator
  ```

**Behavior**:
- If `_overflowRecipient != address(0)`, set `overflowRecipient[escrowId] = _overflowRecipient` and emit `OverflowRecipientSet(escrowId, _overflowRecipient)`
- If `_overflowRecipient == address(0)` (default), leave `overflowRecipient[escrowId]` unset (will default to organizer in `distributeWinnings`)

**Benefits**:
- Set overflow recipient at creation time (one transaction)
- Backward compatible (can pass `address(0)` to use organizer default)
- Still supports changing via `setOverflowRecipient()` later if needed

### 3) Add a setter for overflow recipient (for post-creation updates)

Add:
- `function setOverflowRecipient(uint256 escrowId, address recipient) external`
  - `require(msg.sender == escrow.organizer)` (or reuse `NotOrganizer()` custom error)
  - `require(recipient != address(0))`
  - `require(!escrow.payoutsComplete)`
  - Emit `OverflowRecipientSet(escrowId, recipient)`

This allows changing overflow recipient after escrow creation if needed (useful if organizer wants to change it before payouts).

### 4) Update `distributeWinnings` semantics

Replace the current tolerance logic:

- **Remove**: ±3% tolerance check using lowerBound/upperBound
- **Add**:
  - `maxWithdrawable = escrow.yearnVault.maxWithdraw(address(this));`
  - `require(totalPayout <= maxWithdrawable)` (custom error recommended: `error InsufficientPool(uint256 totalPayout, uint256 maxWithdrawable);`)

**Withdrawal + distribution**
- Compute `overflowTo = overflowRecipient[escrowId]; if (overflowTo == address(0)) overflowTo = escrow.organizer;`
- Withdraw:
  - `escrow.yearnVault.withdraw(maxWithdrawable, address(this), address(this));`
  - Compute `withdrawnAmount` (as current code does)
  - `require(withdrawnAmount >= totalPayout)` (custom error recommended: `error InsufficientWithdrawn(uint256 withdrawn, uint256 required);`)
    - This protects against unexpected vault withdrawal mechanics/slippage
- Distribute exactly `_amounts[i]` to winners (no “last winner remainder” behavior anymore)
- Compute `overflowAmount = withdrawnAmount - totalPayout`
  - If `overflowAmount > 0`, `safeTransfer(overflowTo, overflowAmount)`

**Edge cases**
- If `_winners.length == 0`:
  - If `maxWithdrawable > 0`, withdraw it and send entire `withdrawnAmount` to `overflowTo`
  - Mark `payoutsComplete = true` and emit event with overflowAmount
  - This replaces the current `CannotClosePoolWithFunds` behavior, which can strand funds.

### 5) Keep existing safety checks (unchanged)

Retain:
- **`NotOrganizer` check** — `require(msg.sender == escrow.organizer)` (line 343 in current contract)
  - This ensures **only the organizer** can call `distributeWinnings`
- `EscrowNotEnded` check
- `PayoutsAlreadyComplete`
- `TooManyRecipients`
- `PayoutArraysMismatch`
- `NoDuplicateWinners`
- `WinnerNotParticipant`

---

## Test Updates (`test/DFSEscrowManager.ts`)

Add/modify tests to cover:

### A) Surplus scenario (new behavior)
- Create escrow, participants join, then **top up** pool via `addToPool` so pool > prizes
- Call `distributeWinnings` with totalPayout < pool
- Assert:
  - winners received exact amounts
  - overflow recipient received remainder
  - escrow marked complete

### B) Exact payout scenario
- pool == prizes
- overflowAmount == 0

### C) Deficit scenario
- pool < prizes
- expect revert `InsufficientPool(totalPayout, maxWithdrawable)` (or generic revert if you don’t add custom error)

### D) Overflow defaults to organizer
- don’t call `setOverflowRecipient`
- ensure organizer receives surplus

### E) Overflow recipient setter restrictions
- only organizer can set
- cannot set after payouts complete
- cannot set to zero address

### G) Zero winners close-out with funds
- call `distributeWinnings(escrowId, [], [])` after endTime
- assert funds transferred to overflow recipient and escrow completes

---

## Deployment Plan (Testnet)

1) ✅ **Contract Implementation** - COMPLETED
- ✅ Implemented changes in `contracts/DFSEscrowManager.sol`
- ✅ Contract compiles successfully

2) ✅ **Test Suite** - COMPLETED
- ✅ `npm test` / hardhat test suite - All 73 tests passing
- ✅ New tests added and existing ones updated accordingly
- ✅ Test coverage includes all scenarios (A, B, C, D, E, G)

3) ✅ **Deploy new contract to Flow EVM testnet** - COMPLETED
- ✅ **Status**: Successfully deployed to Flow EVM Testnet
- ✅ Deployment script executed: `npm run deploy:dfs:testnet`
- ✅ Deployment details:
  - **DFSEscrowManager address**: `0x700D1E5B9c66E58322f7aE6D154FcbB65165955b`
  - **MockVaultFactory address**: `0x7832b3d3231b9de20e94Eb14671FfB98d86C39a7`
  - **Deployer address**: `0xD7F0044096b602d017a8C4D7Be5dC33371f05ef5`
  - **Network**: flowTestnet
  - **Deployment tx hash**: (check explorer for transaction hash)
- 🔗 **Explorer**: https://evm-testnet.flowscan.io/address/0x700D1E5B9c66E58322f7aE6D154FcbB65165955b

4) 🔄 **Update configuration in downstream repos** - PENDING
- `firebase_v2/`
  - Update `EVM_ESCROW_MANAGER_ADDRESS_TESTNET` (env var / config)
  - Update `ESCROW_MANAGER_ABI` in `firebase_v2/functions/modules/evm.js`:
    - **Update `createEscrow` signature** to include optional `_overflowRecipient` parameter (can pass `ethers.ZeroAddress` or `null` to use organizer default)
    - Add `setOverflowRecipient` to ABI if backend needs to call it for post-creation updates
    - Event shape changed (`WinningsDistributed` includes overflow fields) — update if backend parses events
  - Update `create_evm_contest()` in `evm.js`:
    - Add optional `overflowRecipient` parameter to function params
    - Pass `overflowRecipient` (or `null`/`ZeroAddress`) when calling `createEscrow` contract method
  - Update any payout simulation that assumes tolerance rule
- `aiSports_frontEnd/`
  - Update testnet escrow manager address in whatever config file stores it
  - If frontend reads events, update event ABI/decoding for new `WinningsDistributed` fields

5) 🔄 **Smoke test on testnet** - PENDING
- ⏸️ **Status**: Waiting for Flow testnet to come back online
- Test plan:
  - Create escrow with optional overflow recipient parameter (test both with and without)
  - Have 1–2 wallets join
  - AddToPool a top-up
  - Set winners list with prizes < pool
  - Distribute and verify winners + overflow transfers to correct recipient

---

## Operational Notes (Backend/Firestore)

- With the new rules, backend no longer needs “payout must be ~pool” logic.
- Recommended backend preflight (optional):
  - Read `yearnVault.maxWithdraw(manager)` and compare to totalPayout
  - If deficit: call `addToPool` (or alert)
  - If surplus: proceed; overflow will receive remainder

---

## Backward Compatibility / Breaking Changes

- This is a **new deployed manager** address. Existing escrows on the old manager remain there.
- Event shape change (`WinningsDistributed`) is technically breaking for any off-chain log parsing.
- If you keep the same `distributeWinnings` signature, backend call sites remain mostly unchanged.
  - Only semantics change (tolerance removed, overflow behavior added).

---

## Deployment Checklist (When Testnet Available)

### Pre-Deployment
- [x] Contract changes implemented
- [x] All tests passing locally
- [ ] Verify Flow testnet is online
- [ ] Confirm deployment script is ready (`scripts/deploy_dfs_escrow_manager.ts`)

### Deployment
- [x] Run `npm run deploy:dfs:testnet`
- [x] Record new contract address: `0x700D1E5B9c66E58322f7aE6D154FcbB65165955b`
- [ ] Record deployment tx hash: `_________________` (check explorer)
- [ ] Verify contract on Flow EVM explorer

### Frontend Updates (`aiSports_frontEnd/`)
- [ ] Update testnet escrow manager address in config:
  - Set `NEXT_PUBLIC_EVM_ESCROW_ADDRESS_TESTNET=0x700D1E5B9c66E58322f7aE6D154FcbB65165955b`
- [ ] Update `WinningsDistributed` event ABI if frontend parses events
- [ ] Test frontend integration

### Backend Updates (`firebase_v2/`)
- [ ] Update `EVM_ESCROW_MANAGER_ADDRESS_TESTNET` environment variable
- [ ] Update `ESCROW_MANAGER_ABI` in `functions/modules/evm.js`:
  - [ ] Add `_overflowRecipient` parameter to `createEscrow` function signature
  - [ ] Add `setOverflowRecipient` function to ABI (if needed)
  - [ ] Update `WinningsDistributed` event signature
- [ ] Update `create_evm_contest()` function:
  - [ ] Add optional `overflowRecipient` parameter
  - [ ] Pass `overflowRecipient` (or `null`/`ZeroAddress`) to contract
- [ ] Remove/update any payout validation logic that assumes tolerance rule
- [ ] Test backend integration

### Post-Deployment Testing
- [ ] Create escrow without overflow recipient (should default to organizer)
- [ ] Create escrow with overflow recipient set
- [ ] Test `setOverflowRecipient()` function
- [ ] Test surplus scenario (pool > prizes)
- [ ] Test exact payout scenario (pool == prizes)
- [ ] Test zero winners scenario (all funds to overflow recipient)
- [ ] Verify event emissions include overflow fields