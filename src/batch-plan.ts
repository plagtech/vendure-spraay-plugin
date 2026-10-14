import { keccak256, toHex } from 'viem';

import { normalizeAddress, SpraayValidationError } from './amounts';
import { BASE_CHAIN_ID, MAX_RECIPIENTS_PER_BATCH, SPRAAY_BATCH_CONTRACT_BASE, USDC_BASE } from './constants';

/**
 * A payout line ready to be planned into a batch.
 *
 * @category Services
 */
export interface PlannableLine {
    id: string;
    sellerId: string;
    recipientAddress: string;
    amount: bigint;
}

/**
 * One aggregated transfer produced by {@link planBatch}.
 *
 * @category Services
 */
export interface PlannedItem {
    /** EIP-55 checksummed recipient address. */
    recipient: `0x${string}`;
    /** Exact sum of every line paid to this recipient, in raw USDC base units. */
    amount: bigint;
    lineIds: string[];
    sellerIds: string[];
}

/**
 * The output of {@link planBatch}: items, total and a content hash for approval.
 *
 * @category Services
 */
export interface BatchPlan {
    items: PlannedItem[];
    totalAmount: bigint;
    contentHash: `0x${string}`;
}

/**
 * Aggregates payout lines into one on-chain transfer per recipient address.
 *
 * Aggregating (rather than emitting one transfer per line) keeps each recipient's
 * Transfer log unambiguous during settlement verification and saves gas. Items are
 * ordered deterministically by lower-cased address so the same set of lines always
 * produces the same calldata and the same content hash.
 *
 * @category Services
 */
export function planBatch(lines: PlannableLine[]): BatchPlan {
    if (lines.length === 0) {
        throw new SpraayValidationError('A batch needs at least one payout line');
    }
    const seenLineIds = new Set<string>();
    const byRecipient = new Map<string, PlannedItem>();
    for (const line of lines) {
        if (seenLineIds.has(line.id)) {
            throw new SpraayValidationError(`Payout line ${line.id} was included twice`);
        }
        seenLineIds.add(line.id);
        if (line.amount <= 0n) {
            throw new SpraayValidationError(`Payout line ${line.id} has a non-positive amount`);
        }
        const recipient = normalizeAddress(line.recipientAddress, `recipient of payout line ${line.id}`);
        const key = recipient.toLowerCase();
        const existing = byRecipient.get(key);
        if (existing) {
            existing.amount += line.amount;
            existing.lineIds.push(line.id);
            if (!existing.sellerIds.includes(line.sellerId)) {
                existing.sellerIds.push(line.sellerId);
            }
        } else {
            byRecipient.set(key, {
                recipient,
                amount: line.amount,
                lineIds: [line.id],
                sellerIds: [line.sellerId],
            });
        }
    }
    if (byRecipient.size > MAX_RECIPIENTS_PER_BATCH) {
        throw new SpraayValidationError(
            `A batch can pay at most ${MAX_RECIPIENTS_PER_BATCH} distinct recipients; these lines resolve to ${byRecipient.size}`,
        );
    }
    const items = [...byRecipient.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, item]) => item);
    const totalAmount = items.reduce((sum, item) => sum + item.amount, 0n);
    return { items, totalAmount, contentHash: computeContentHash(items) };
}

/**
 * The hash an approver signs off on. It commits to the chain, contract, token and the
 * exact ordered (recipient, amount) pairs, so any change after review invalidates approval.
 *
 * @category Services
 */
export function computeContentHash(items: Array<{ recipient: string; amount: bigint }>): `0x${string}` {
    const canonical = [
        'spraay-vendure-batch:v1',
        String(BASE_CHAIN_ID),
        SPRAAY_BATCH_CONTRACT_BASE.toLowerCase(),
        USDC_BASE.toLowerCase(),
        ...items.map(item => `${item.recipient.toLowerCase()}:${item.amount.toString()}`),
    ].join('|');
    return keccak256(toHex(canonical));
}
