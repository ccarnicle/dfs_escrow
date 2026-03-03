# Direct Aave Pool Integration Plan — DFSEscrowManager (Flow EVM)

This document outlines a practical, hackathon-focused plan to integrate `DFSEscrowManager` with an Aave-style Pool on Flow EVM without requiring ERC-4626 in this phase.

The target flow is:
- users enter and fees are collected in escrow
- after contest entry closes, admin supplies pooled funds to Aave Pool once
- before payout, admin withdraws once
- winnings are distributed in one payout transaction

---

## Needed Information (Provide First)

### Required addresses

- **Flow EVM chain**
  - chain ID (expected mainnet: `747`)
- **Aave Pool proxy address** (for the market you will use)
  - candidate shared: `0xbC92aaC2DBBF42215248B5688eB3D3d2b32F2c8d`
- **Underlying token address** for contest funds
  - for hackathon path: Stargate USDC token address on Flow mainnet
- **aToken address** for that reserve
  - used for visibility/accounting checks

### Strongly recommended metadata

- **PoolAddressesProvider** address for this market
- confirmation that `asset` reserve is active and has available supply capacity
- confirmation there is no supply/withdraw pause on the reserve
- any protocol-specific constraints (caps, fee model, cooldowns if any)

### Access/ops info

- admin/owner wallet that will call invest/withdraw functions
- target contest timeline assumptions (e.g., invest window, expected holding period)
- preferred overflow policy (where yield surplus goes if payouts are less than withdrawn)

---

## Goal

Update `DFSEscrowManager` to support direct `IPool.supply/withdraw` integration for one-shot investment after entry close, while preserving current contest and payout semantics.

---

## Scope (Phase 1: Hackathon-Safe)

- keep existing escrow creation/join/distribution structure
- add explicit invest and unwind steps
- avoid per-join investing to reduce complexity and accounting risk
- enforce pool/asset guardrails
- maintain organizer-driven payout process

Out of scope for this phase:
- ERC-4626 adapter/wrapper standardization
- fully automated keeper scheduling
- multi-market routing/yield optimization

---

## Contract Design Changes

## 1) New interfaces and storage

- add minimal `IPool` interface with:
  - `supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)`
  - `withdraw(address asset, uint256 amount, address to) returns (uint256)`
- add per-escrow fields:
  - `address pool` (allowlisted pool for this escrow)
  - `uint256 pendingToInvest` (funds collected but not supplied yet)
  - `bool invested` (whether escrow has executed supply step)
  - optional: `uint256 principalInvested` (for reporting and guard checks)

## 2) Escrow creation path

- keep existing `createEscrow` behavior for contest metadata
- add a new creation function (or extend existing) to set:
  - `_pool` address
  - `_asset` token
- validate:
  - pool is in allowlist
  - token is in allowlist (USDC for hackathon path)

## 3) Join/add-to-pool changes

- on user join and top-up:
  - transfer tokens to `DFSEscrowManager` as today
  - **do not auto-deposit into external yield source**
  - increment `pendingToInvest` by amount received

## 4) Invest step (single-shot)

- add `investEscrowFunds(uint256 escrowId)` (organizer or owner):
  - require `block.timestamp >= escrow.endTime` (or configurable invest window)
  - require `pendingToInvest > 0`
  - approve pool for `pendingToInvest`
  - call `pool.supply(asset, pendingToInvest, address(this), 0)`
  - set `invested = true`
  - move `pendingToInvest` into `principalInvested` (if tracked), then zero pending

## 5) Withdraw step (single-shot)

- add `withdrawEscrowFunds(uint256 escrowId, uint256 minExpectedAssets)` (organizer or owner):
  - require escrow ended
  - require `invested == true`
  - call `pool.withdraw(asset, type(uint256).max, address(this))`
  - require `withdrawn >= minExpectedAssets` (slippage/safety guard)
  - keep funds in manager for distribution

## 6) Distribution step

- keep `distributeWinnings` winner checks and overflow logic
- source payout from manager’s token balance after withdraw
- if winnings are distributed without any invest step, behavior should still be deterministic (current non-yield fallback)

---

## Guardrails and Security

- add owner-controlled allowlists:
  - allowed pools
  - allowed tokens
- add pause mechanism for invest/withdraw functions
- use `SafeERC20.forceApprove` (reset to 0 then set) before `supply`
- apply CEI pattern and preserve `nonReentrant`
- emit events:
  - `EscrowInvested(escrowId, pool, asset, amount)`
  - `EscrowWithdrawn(escrowId, pool, asset, amount)`

---

## Suggested Function Sequence (Operational)

1. organizer creates escrow (pool + asset configured)
2. users join until `endTime`
3. organizer/admin calls `investEscrowFunds(escrowId)`
4. wait holding period (e.g., ~12h)
5. organizer/admin calls `withdrawEscrowFunds(escrowId, minExpectedAssets)`
6. organizer calls `distributeWinnings(escrowId, winners, amounts)`

---

## Testing Plan

- unit tests for:
  - invest requires ended escrow and positive pending amount
  - withdraw requires invested escrow
  - distribute fails if funds unavailable
  - overflow/yield recipient behavior
  - allowlist enforcement
  - paused invest/withdraw path
- integration test on Flow test environment (or fork-like setup):
  - supply/withdraw round-trip with Stargate USDC market
  - verify contest payout after unwind

---

## Rollout Plan

- Phase A: implement and test local/mocks
- Phase B: testnet dry run with known pool/token addresses
- Phase C: mainnet deploy with guarded allowlists
- Phase D: run first low-value contest and monitor all events/transfers

---

## TODO (Post-Hackathon)

- migrate lending integration behind an ERC-4626 wrapper/adapter for standardized vault abstraction
- optional: support per-escrow vault wrappers to improve composability and analytics

