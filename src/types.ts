import { SpraayChainReader } from './chain/chain-reader';
import { FetchLike } from './gateway/spraay-gateway.client';

/**
 * Configuration options for the {@link SpraayPayoutPlugin}.
 *
 * @category Plugin options
 */
export interface SpraayPayoutPluginOptions {
    /**
     * JSON-RPC endpoint for Base mainnet (chain id 8453). Used for reads, simulation,
     * receipt verification and relaying already-signed transactions. Never for signing.
     */
    rpcUrl: string;
    /**
     * EOA addresses the merchant controls and allows to fund payouts. A batch can only be
     * prepared for one of these senders. The plugin never sees their private keys.
     */
    allowedSenders: string[];
    /**
     * Spraay gateway base URL.
     * @default 'https://gateway.spraay.app'
     */
    gatewayUrl?: string;
    /**
     * The fetch used for gateway calls. The gateway charges per call via x402, so production
     * deployments pass an x402-capable fetch here (e.g. `wrapFetchWithPaymentFromConfig` from
     * `@x402/fetch`) backed by a small, separate API-fee wallet — never the payout treasury.
     * @default globalThis.fetch (calls will fail with SpraayGatewayPaymentRequiredError)
     */
    gatewayFetch?: FetchLike;
    /** Extra headers sent to the gateway on every call. */
    gatewayHeaders?: Record<string, string>;
    /** @default 30000 */
    gatewayTimeoutMs?: number;
    /**
     * Blocks a settlement must be buried under before lines are marked PAID.
     * @default 10
     */
    requiredConfirmations?: number;
    /**
     * When true, the administrator who approves a batch must differ from the one who created it.
     * Strongly recommended in production.
     * @default false
     */
    requireDistinctApprover?: boolean;
    /** Optional safety cap on the raw USDC total (excluding fee) of a single batch. */
    maxBatchTotal?: string;
    /** Optional safety cap on a single payout line, raw USDC. */
    maxLineAmount?: string;
    /**
     * Cron expression for automatic reconciliation of in-flight batches, or `false` to disable
     * the scheduled task and only reconcile on demand. Reconciliation never initiates payouts.
     * @default '* * * * *' (every minute)
     */
    reconcileSchedule?: string | false;
    /** Block range per eth_getLogs call while searching for replaced transactions. @default 2000 */
    logScanChunkSize?: number;
    /** Override the chain reader (tests, custom RPC stacks). */
    chainReader?: SpraayChainReader;
}
