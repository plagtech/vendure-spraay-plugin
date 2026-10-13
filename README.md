# @plagtech/vendure-spraay-plugin

Pay your marketplace sellers in **USDC on Base**, many at once, with one transaction from **your own wallet**.

The plugin groups what you owe sellers into batches of up to **200 recipients**. An administrator approves each batch. Your wallet signs it, and the plugin marks sellers paid **only after** it has checked the result on-chain. It uses the [Spraay](https://spraay.app) batch contract and gateway.

- **Admin-approved only.** The plugin never subscribes to order events and never starts a payment by itself.
- **Noncustodial.** The plugin never holds a private key. It gives you an unsigned transaction. Your wallet signs it, and the plugin checks the signed bytes before relaying them.
- **Exact amounts.** Every amount is a raw integer in USDC base units (6 decimals; `"1500000"` = 1.50 USDC). The plugin never converts amounts to floats or decimals.
- **Duplicate-payment protection** in depth, plus verified settlement and safe recovery (see below).

| | |
|---|---|
| Chain | Base mainnet (8453) only in v1 |
| Token | Circle USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` only in v1 |
| Batch contract | Spraay `0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC` |
| Gateway | `https://gateway.spraay.app`: `POST /api/v1/batch/execute`, `POST /api/v1/batch/estimate` (x402) |
| Vendure | `@vendure/core` `^3.6.0-0` (tested on 3.6.5 and 3.8.0) |
| Node.js | ≥ 20 |
| License | MIT |

## Installation

```bash
npm install @plagtech/vendure-spraay-plugin
```

```ts
import { SpraayPayoutPlugin } from '@plagtech/vendure-spraay-plugin';

export const config: VendureConfig = {
    // ...
    plugins: [
        SpraayPayoutPlugin.init({
            rpcUrl: process.env.BASE_RPC_URL!,            // Base mainnet JSON-RPC
            allowedSenders: ['0xYourTreasuryEOA'],        // wallets allowed to fund payouts
            gatewayFetch: x402Fetch,                      // see "Paying gateway fees with x402"
            requireDistinctApprover: true,                // recommended
        }),
    ],
};
```

The plugin adds database tables, so generate and run a migration afterwards (`npx vendure migrate`).

### Options

| Option | Default | |
|---|---|---|
| `rpcUrl` | required | Base mainnet RPC. The plugin uses it for reads, simulation, verification and relaying already-signed transactions. |
| `allowedSenders` | required | EOAs you control that may fund batches. |
| `gatewayUrl` | `https://gateway.spraay.app` | |
| `gatewayFetch` | `globalThis.fetch` | An x402-capable fetch. Without one, gateway calls fail with a clear 402 error. |
| `gatewayHeaders` | none | Extra headers for gateway calls. |
| `gatewayTimeoutMs` | `30000` | |
| `requiredConfirmations` | `10` | Blocks a payout must be buried under before its lines become `PAID`. |
| `requireDistinctApprover` | `false` | Requires the approver to be a different administrator from the batch creator. |
| `maxBatchTotal`, `maxLineAmount` | none | Optional safety caps, as raw USDC integer strings. |
| `reconcileSchedule` | `'* * * * *'` | Cron for the read-only reconciliation task, or `false` to disable it. |
| `logScanChunkSize` | `2000` | Block range per `eth_getLogs` call when searching for replaced transactions. |

### Paying gateway fees with x402

The Spraay gateway charges per call ($0.001 for estimate, $0.02 for execute at the time of writing) using [x402](https://x402.org). Fund a **small, separate API-fee wallet** for these fees. It should never be your payout treasury.

```ts
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const feeAccount = privateKeyToAccount(process.env.SPRAAY_API_FEE_KEY as `0x${string}`);
const x402Fetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(feeAccount) }],
});
```

The plugin caches the verified `execute` answer for each batch, so a retry does not pay for a second call unless the sender or the contract's fee rate has changed.

## Permissions and seller setup

The plugin adds three permissions:

- `ReadSpraayPayouts`: view lines, batches and audit logs.
- `ManageSpraayPayouts`: record lines, build and prepare batches, submit or report transactions, reconcile, cancel.
- `ApproveSpraayPayouts`: approve batches and resolve batches marked `NEEDS_REVIEW`.

Each `Seller` gets a custom field, `spraayPayoutAddress`, which holds the seller's payout address on Base. It is validated as a non-zero EVM address. A batch copies the address when the batch is created, and the approver reviews that copy.

## Workflow (Admin API)

```graphql
# 1. Record what is owed. idempotencyKey is unique: replaying the same key and content returns the
#    existing line, and reusing a key with different content is rejected.
mutation { createSpraayPayoutLines(input: [
  { sellerId: "2", amount: "12500000", idempotencyKey: "order-1001", reference: "Order 1001" }
]) { id state } }

# 2. Build a batch: lines are combined into one transfer per recipient and locked to this batch.
mutation { createSpraayPayoutBatch(lineIds: ["1","2","3"]) { id contentHash items { recipientAddress amount } } }

# 3. Approve the exact content you reviewed (needs ApproveSpraayPayouts).
mutation { approveSpraayPayoutBatch(id: "1", contentHash: "0x…") { state } }

# 4. Prepare. The plugin calls the gateway, verifies its unsigned transaction, checks balance and
#    allowance, simulates the call, and pins the sender's nonce.
mutation { prepareSpraayPayoutBatch(id: "1", sender: "0xTreasury") {
  state                         # AWAITING_ALLOWANCE or AWAITING_SIGNATURE
  approvalRequest { to data }   # sign this first if AWAITING_ALLOWANCE, then prepare again
  signingRequest { from to data value chainId nonce gas }
} }

# 5a. Your wallet signs signingRequest and gives the plugin the raw bytes. The plugin verifies
#     them, records the hash, then relays.
mutation { submitSpraaySignedTransaction(batchId: "1", signedTransaction: "0x02f8…") { txHash broadcastError batch { state } } }
# 5b. …or your wallet broadcasts the transaction itself and you report the hash.
mutation { reportSpraayTransactionHash(batchId: "1", txHash: "0x…") { state } }

# 6. Reconcile. This runs automatically every minute and can also be triggered by hand.
mutation { reconcileSpraayPayoutBatch(id: "1") { state settledTxHash } }
```

Signing example (any wallet works; this one uses viem with a key you hold):

```ts
const raw = await account.signTransaction({
    type: 'eip1559', chainId: 8453, to: req.to, data: req.data, value: 0n,
    nonce: req.nonce,                // use the pinned nonce exactly
    gas: BigInt(req.gas), maxFeePerGas, maxPriorityFeePerGas,
});
```

## How double payment is prevented

The plugin does **not** rely on ERC-20 allowances to stop duplicate payments. These are the actual guards:

1. **Unique `idempotencyKey` per obligation**, enforced by a unique index in the database.
2. **Line locking.** A line moves `PENDING → BATCHED` by compare-and-set, so it can belong to only one batch. It becomes `PAID` only through verified settlement and returns to `PENDING` only when the batch is cancelled.
3. **Approval is tied to the exact content.** The `contentHash` covers chain, contract, token and the ordered (recipient, amount) pairs. The plugin recomputes it from the stored items before preparing.
4. **One live attempt per batch, and one in-flight batch per sender.** The second rule is enforced by a unique sender-lock row.
5. **Pinned nonce.** Every signed copy of a batch transaction shares one nonce, so at most one of them can ever be mined.
6. **Signed bytes are verified before relay**: signer, target, calldata, value, chain, nonce and gas. The hash is committed to the database *before* the transaction is broadcast.
7. **A settlement transaction can settle only one batch**, enforced by a unique `settledTxHash`. Identical recurring batches cannot claim each other's transactions.
8. **Duplicate-execution scan before settling.** Before settling, the plugin searches every `SprayTokenExecuted` event from the sender since the batch was first prepared. A second matching execution puts the batch in `NEEDS_REVIEW`.
9. **Cancellation needs proof.** An in-flight batch can only be cancelled after its pinned nonce has been consumed by another transaction (the plugin provides a 0-value nonce-burn request) and no matching execution exists.

## Settlement verification

A batch is `SETTLED` only when **all** of the following hold, at `requiredConfirmations` depth:

- the receipt status is `success`
- `tx.from` is the approved sender, `tx.to` is the Spraay contract, `tx.value` is 0, and the decoded calldata is `sprayToken(USDC, [...])` with exactly the approved recipients and amounts in order
- exactly one `SprayTokenExecuted(sender, USDC, total, count, fee)` event comes from the contract, with the expected total and count
- USDC `Transfer` logs show exactly one pull of `total + fee` from the sender, exactly one transfer per recipient for the exact amount, and nothing else leaving the contract except the fee

The plugin also checks the gateway's **unsigned** transaction before anything is signed: contract, chain, token, calldata, `value: "0"`, hex gas limit, and an approval amount equal to `total + fee`, where the fee is computed from the contract's live `feeBps()`.

## States and recovery

| Batch state | Meaning | What happens next |
|---|---|---|
| `DRAFT` | Built from pending lines | approve, or cancel |
| `APPROVED` | Content approved | prepare, or cancel |
| `AWAITING_ALLOWANCE` | Sender must approve `total + fee` | sign `approvalRequest`, then prepare again |
| `AWAITING_SIGNATURE` | Signing request issued with a pinned nonce | submit the signed transaction or report its hash; reconciliation also finds unreported broadcasts |
| `SUBMITTED` | Hash known; waiting for inclusion and depth | reconcile; `rebroadcastSpraayTransaction` if it was dropped |
| `SETTLED` | Verified on-chain; lines `PAID` | terminal |
| `FAILED` | The attempt reverted, or its nonce was consumed elsewhere with no matching execution. No funds moved. | prepare again (a new attempt), or cancel |
| `NEEDS_REVIEW` | Mismatch or duplicate execution. Lines stay locked. | `resolveSpraayPayoutBatchReview`: `MARK_SETTLED` (requires a fully verified tx hash) or `MARK_FAILED` (requires a note) |
| `CANCELLED` | Lines returned to `PENDING` | terminal |

**If a batch is stuck in flight:** query `spraayNonceCancellationRequest(batchId)` and sign it (a 0-value self-transfer at the pinned nonce). Once it is buried, `cancelSpraayPayoutBatch` succeeds. If the batch transaction wins the race instead, reconciliation settles it. Either way, nothing is paid twice. [docs/OPERATIONS.md](docs/OPERATIONS.md) is the full runbook.

## Limitations (v1)

- Base and USDC only. Other chains and tokens are refused by design.
- Senders must be EOAs. Safe and other smart-account execution wraps the calldata and is not verified yet.
- If a wallet ignores the pinned nonce **and** holds back a signed copy, the plugin can only *detect* a later duplicate execution (→ `NEEDS_REVIEW`), not prevent it. Use signers that honour the nonce, such as raw signing with `submitSpraaySignedTransaction`.
- No Dashboard UI yet. Everything is available through the Admin API.

## Local demo and tests

The demo and the e2e tests need [Foundry](https://getfoundry.sh)'s `anvil` and access to a Base RPC (default `https://mainnet.base.org`, override with `BASE_FORK_URL`). Both fork Base mainnet, so the **real** Spraay contract and **real** USDC run every payout. The gateway is a local stand-in that produced byte-identical responses to the production handler (v3.8.3) for the two endpoints used, in a side-by-side run. The x402 payment is a placeholder header. No real funds are used.

```bash
npm run demo                      # three sellers, one batch, verified settlement
npm run demo -- --keep-alive      # keep Vendure at http://localhost:3000/admin-api
npm test                          # unit tests
npm run e2e                       # Vendure + anvil fork: happy path, tampering, reverts, nonce burn,
                                  # unreported broadcasts, duplicate detection, 200/201 recipients
```

## License

MIT © Plagtech
