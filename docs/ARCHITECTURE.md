# Architecture

## Components

```
Admin API (GraphQL)
   │  SpraayPayoutAdminResolver: permissions ReadSpraayPayouts / ManageSpraayPayouts / ApproveSpraayPayouts
   ▼
SpraayPayoutService: state machine; every transition is a compare-and-set on the current state
   ├─ batch-plan.ts               aggregate lines per recipient, deterministic order, contentHash
   ├─ SpraayGatewayClient         POST /api/v1/batch/execute and /estimate (x402 through gatewayFetch)
   ├─ verify-gateway-response.ts  never trust the unsigned transaction: decode it and compare
   ├─ signed-transaction.ts       check merchant-signed bytes against the signing request
   ├─ verify-settlement.ts        receipt + calldata + SprayTokenExecuted + USDC Transfer logs
   └─ SpraayChainReader (viem)    read-only Base RPC; can only relay already-signed transactions
ScheduledTask "spraay-payout-reconcile": read-only, runs reconcileInFlight()
```

## Data model

- `spraay_payout_line`: one obligation (unique `idempotencyKey`, `sellerId`, raw `amount`, `state`, `batchId`).
- `spraay_payout_batch`: state, totals, `contentHash`, approval, cached verified gateway calldata, settlement (unique `settledTxHash`).
- `spraay_payout_batch_item`: one transfer per recipient, with the line and seller ids it covers.
- `spraay_payout_attempt`: one try at execution: pinned `nonce`, `signingRequest`, every seen `txHashes`, mined info.
- `spraay_sender_lock`: unique `sender`; at most one batch per sender holds a pinned nonce at a time.
- `spraay_payout_audit_entry`: an append-only log of every decision, with the acting user.

## State machine

```
DRAFT ──approve──▶ APPROVED ──prepare──▶ AWAITING_ALLOWANCE ──prepare──┐
  │                   │                                                ▼
  └──cancel──┐        └──────────────prepare──────────────▶ AWAITING_SIGNATURE ──submit/report/found──▶ SUBMITTED
             ▼                                                   │                                    │
         CANCELLED ◀──cancel── FAILED ◀──dead / reverted─────────┴────────────────────────────────────┤
                                 │                                                                    │
                                 └──prepare (new attempt)──▶ …                verified + deep enough ─▶ SETTLED
                                                                    mismatch / duplicate ─▶ NEEDS_REVIEW ──resolve──▶ SETTLED | FAILED
```

## Transaction boundaries

These steps deliberately commit **before** any external side effect:

- `submitSpraaySignedTransaction` commits the transaction hash, then relays. A failed relay is safe to retry.
- `prepareSpraayPayoutBatch` caches the paid, verified gateway answer separately from the nonce-pinning transaction.
- Reconciliation commits each conclusive step (dead, reverted, anomalous, settled) in its own transaction.

## Gateway trust boundary

The gateway is a convenience for encoding and gas estimation. It is not trusted:

- Its `transaction.data` is decoded and must equal the approved items exactly.
- Its `approvalRequired.amount` must equal `total + floor(total × feeBps / 10000)`, where `feeBps` is read live from the contract.
- `contract`, `transaction.to` and `approvalRequired.spender` must all be `0x1646452F…5eEC`; `chainId` must be 8453 and `value` must be `"0"`.

Source of truth for the endpoints: `https://gateway.spraay.app/openapi.json` (info.version 3.8.3, retrieved 2026-10-13).
