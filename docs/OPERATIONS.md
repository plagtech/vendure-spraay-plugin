# Operations runbook

Reconciliation is **read-only and idempotent**. It never signs anything and never starts a payment. When in doubt, run `reconcileSpraayPayoutBatch` and read the batch's `auditLog` and `attempts`.

## Before going live

- Use a dedicated treasury EOA for `allowedSenders`, and fund it only with what the next batches need.
- Use a separate small API-fee wallet for x402 gateway fees.
- Set `requireDistinctApprover: true` and give `ApproveSpraayPayouts` to a different role than `ManageSpraayPayouts`.
- Use a reliable Base RPC. Public endpoints limit `eth_getLogs` ranges, so tune `logScanChunkSize` if needed.
- Keep `requiredConfirmations` at 10 or more.

## Situations

**`prepare` says the gateway answered 402.** `gatewayFetch` is not x402-capable, or the fee wallet is empty.

**`prepare` refused the gateway response.** The unsigned transaction differed from the approved batch, or its approval amount did not match the contract's live `feeBps()`. Nothing was signed. Check the `GATEWAY_RESPONSE_REJECTED` audit entry. Do not work around this check.

**`AWAITING_ALLOWANCE`.** Sign `approvalRequest` (an exact `approve(spraayContract, total + fee)`) and prepare again. Approving a larger amount does not make the payout less safe, because allowance is not what prevents duplicates here. It does widen what the contract can pull from the treasury.

**`AWAITING_SIGNATURE` for a long time.** If you signed and broadcast but did not report the hash, the next reconciliation finds the transaction through `SprayTokenExecuted` logs once it is mined. If nothing was ever signed and you want to stop, see "Cancel an in-flight batch".

**`SUBMITTED`, but the transaction is not mined.**
- `broadcastError` was set, or the node dropped the transaction: run `rebroadcastSpraayTransaction` (for raw submissions), or rebroadcast from the wallet.
- Fee too low: a speed-up from the wallet with the same nonce is fine. Reconciliation finds the replacement hash.

**`FAILED`.** The last attempt reverted (for example, insufficient balance or allowance at execution time), or its nonce was used by another transaction with no matching execution. No funds moved and the lines are still locked to the batch. Fix the cause, then `prepareSpraayPayoutBatch` again, or cancel.

**Cancel an in-flight batch.** `cancelSpraayPayoutBatch` refuses while a signed copy could still be mined. To unblock it:
1. Query `spraayNonceCancellationRequest(batchId)`.
2. Sign it and broadcast it: a 0-value self-transfer at the pinned nonce, at a higher fee than any pending copy.
3. Wait for `requiredConfirmations`.
4. Cancel again. The attempt becomes `DEAD`, the batch becomes `CANCELLED`, and the lines return to `PENDING`.

If the batch transaction gets mined instead of the cancellation, reconciliation settles the batch.

**`NEEDS_REVIEW`.** Read `reviewReason`.
- *DUPLICATE EXECUTION*: two transactions each paid the full batch. Recover the excess from recipients off-chain. Then `resolveSpraayPayoutBatchReview(resolution: MARK_SETTLED, txHash: <the one you treat as canonical>, note: …)`.
- *failed verification*: a transaction from your sender changed state, but not the way the batch should have. Investigate it on a block explorer before doing anything. `MARK_FAILED` returns the batch to `FAILED` (retry or cancel). Only do this once you are sure no recipient was paid.

Every resolution needs a note and is recorded in the audit log.

## Reorgs

Base has a single sequencer and does not reorg deep in practice. Lines become `PAID` only at `requiredConfirmations` depth, and attempts are declared `DEAD` only when the nonce was consumed at that same depth.
