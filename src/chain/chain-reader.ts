import { createPublicClient, Hex, http, PublicClient } from 'viem';
import { base } from 'viem/chains';

import { BASE_CHAIN_ID, SPRAAY_BATCH_CONTRACT_BASE, USDC_BASE } from '../constants';

import { erc20Abi, spraayBatchAbi } from './abi';
import { ChainReceipt, ChainTransaction } from './verify-settlement';

export interface SprayEventRef {
    transactionHash: `0x${string}`;
    blockNumber: bigint;
}

/**
 * Read-only access to Base. The plugin never holds a key: the only write it can perform is
 * relaying a transaction the merchant already signed (`sendRawTransaction`).
 * Implementations must be safe to call repeatedly (reconciliation is idempotent).
 *
 * @category Services
 */
export interface SpraayChainReader {
    getChainId(): Promise<number>;
    getBlockNumber(): Promise<bigint>;
    /**
     * Nonce of the next transaction. `latest` counts mined transactions, `pending` includes the
     * mempool, and a block number gives the count as of that block (used for confirmation depth).
     */
    getTransactionCount(address: string, at: 'latest' | 'pending' | bigint): Promise<number>;
    getFeeBps(): Promise<bigint>;
    isPaused(): Promise<boolean>;
    getUsdcBalance(owner: string): Promise<bigint>;
    getUsdcAllowance(owner: string): Promise<bigint>;
    getCode(address: string): Promise<string | undefined>;
    /** Simulates the call (eth_call). Resolves to an error message, or undefined when it would succeed. */
    simulate(call: { from: string; to: string; data: string }): Promise<string | undefined>;
    estimateGas(call: { from: string; to: string; data: string }): Promise<bigint>;
    /** Resolves to null when the node does not know the transaction (never seen, or dropped). */
    getTransaction(hash: string): Promise<ChainTransaction | null>;
    /** Resolves to null while the transaction is not mined. */
    getTransactionReceipt(hash: string): Promise<ChainReceipt | null>;
    sendRawTransaction(raw: string): Promise<string>;
    /** SprayTokenExecuted(sender, USDC) logs in [fromBlock, toBlock]. */
    findSprayTokenExecutions(sender: string, fromBlock: bigint, toBlock: bigint): Promise<SprayEventRef[]>;
}

/**
 * Default {@link SpraayChainReader} implementation backed by a viem `PublicClient`.
 *
 * @category Services
 */
export class ViemChainReader implements SpraayChainReader {
    private readonly client: PublicClient;

    constructor(
        rpcUrl: string,
        private readonly logScanChunkSize: bigint,
    ) {
        this.client = createPublicClient({ chain: base, transport: http(rpcUrl, { retryCount: 2 }) }) as PublicClient;
    }

    getChainId() {
        return this.client.getChainId();
    }

    getBlockNumber() {
        return this.client.getBlockNumber({ cacheTime: 0 });
    }

    getTransactionCount(address: string, at: 'latest' | 'pending' | bigint) {
        return typeof at === 'bigint'
            ? this.client.getTransactionCount({ address: address as Hex, blockNumber: at })
            : this.client.getTransactionCount({ address: address as Hex, blockTag: at });
    }

    getFeeBps() {
        return this.client.readContract({
            address: SPRAAY_BATCH_CONTRACT_BASE,
            abi: spraayBatchAbi,
            functionName: 'feeBps',
        });
    }

    isPaused() {
        return this.client.readContract({
            address: SPRAAY_BATCH_CONTRACT_BASE,
            abi: spraayBatchAbi,
            functionName: 'paused',
        });
    }

    getUsdcBalance(owner: string) {
        return this.client.readContract({
            address: USDC_BASE,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [owner as Hex],
        });
    }

    getUsdcAllowance(owner: string) {
        return this.client.readContract({
            address: USDC_BASE,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [owner as Hex, SPRAAY_BATCH_CONTRACT_BASE],
        });
    }

    getCode(address: string) {
        return this.client.getCode({ address: address as Hex });
    }

    async simulate(call: { from: string; to: string; data: string }) {
        try {
            await this.client.call({ account: call.from as Hex, to: call.to as Hex, data: call.data as Hex });
            return undefined;
        } catch (e: any) {
            return e?.shortMessage ?? e?.message ?? String(e);
        }
    }

    estimateGas(call: { from: string; to: string; data: string }) {
        return this.client.estimateGas({ account: call.from as Hex, to: call.to as Hex, data: call.data as Hex });
    }

    async getTransaction(hash: string): Promise<ChainTransaction | null> {
        try {
            const tx = await this.client.getTransaction({ hash: hash as Hex });
            return {
                hash: tx.hash,
                from: tx.from,
                to: tx.to,
                input: tx.input,
                value: tx.value,
                nonce: tx.nonce,
                chainId: tx.chainId ?? null,
                blockNumber: tx.blockNumber,
            };
        } catch (e: any) {
            if (e?.name === 'TransactionNotFoundError') {
                return null;
            }
            throw e;
        }
    }

    async getTransactionReceipt(hash: string): Promise<ChainReceipt | null> {
        try {
            const receipt = await this.client.getTransactionReceipt({ hash: hash as Hex });
            return {
                transactionHash: receipt.transactionHash,
                status: receipt.status,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to,
                logs: receipt.logs.map(log => ({
                    address: log.address,
                    topics: log.topics,
                    data: log.data,
                    logIndex: log.logIndex,
                })),
            };
        } catch (e: any) {
            if (e?.name === 'TransactionReceiptNotFoundError') {
                return null;
            }
            throw e;
        }
    }

    sendRawTransaction(raw: string) {
        return this.client.sendRawTransaction({ serializedTransaction: raw as Hex });
    }

    async findSprayTokenExecutions(sender: string, fromBlock: bigint, toBlock: bigint): Promise<SprayEventRef[]> {
        const found: SprayEventRef[] = [];
        const event = spraayBatchAbi.find(item => item.type === 'event' && item.name === 'SprayTokenExecuted')!;
        for (let start = fromBlock; start <= toBlock; start += this.logScanChunkSize) {
            const end = start + this.logScanChunkSize - 1n < toBlock ? start + this.logScanChunkSize - 1n : toBlock;
            const logs = await this.client.getLogs({
                address: SPRAAY_BATCH_CONTRACT_BASE,
                event: event as any,
                args: { sender: sender as Hex, token: USDC_BASE } as any,
                fromBlock: start,
                toBlock: end,
            });
            for (const log of logs) {
                if (log.transactionHash && log.blockNumber !== null) {
                    found.push({ transactionHash: log.transactionHash, blockNumber: log.blockNumber });
                }
            }
        }
        return found;
    }
}

export async function assertBaseChain(reader: SpraayChainReader): Promise<void> {
    const chainId = await reader.getChainId();
    if (chainId !== BASE_CHAIN_ID) {
        throw new Error(`Spraay payout RPC is on chain ${chainId}; v1 only supports Base (${BASE_CHAIN_ID})`);
    }
}
