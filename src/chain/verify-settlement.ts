import { decodeEventLog, Hex } from 'viem';

import { sameAddress } from '../amounts';
import { SPRAAY_BATCH_CONTRACT_BASE, USDC_BASE } from '../constants';

import { erc20Abi, spraayBatchAbi } from './abi';
import { decodeSprayTokenCalldata, diffSprayTokenCalldata, ExpectedTransfer } from './calldata';

/**
 * A single log entry from a transaction receipt.
 *
 * @category Services
 */
export interface ChainLog {
    address: string;
    topics: readonly string[];
    data: string;
    logIndex?: number | null;
}

/**
 * Minimal transaction fields needed by settlement verification.
 *
 * @category Services
 */
export interface ChainTransaction {
    hash: string;
    from: string;
    to: string | null;
    input: string;
    value: bigint;
    nonce: number;
    chainId?: number | null;
    blockNumber?: bigint | null;
}

/**
 * Minimal receipt fields needed by settlement verification.
 *
 * @category Services
 */
export interface ChainReceipt {
    transactionHash: string;
    status: 'success' | 'reverted';
    blockNumber: bigint;
    from: string;
    to: string | null;
    logs: readonly ChainLog[];
}

/**
 * Result of {@link verifySettlement}: either a confirmed settlement or a mismatch/revert.
 *
 * @category Services
 */
export type SettlementVerification =
    | { ok: true; feeAmount: bigint; blockNumber: bigint }
    | { ok: false; kind: 'reverted' | 'mismatch'; problems: string[] };

interface DecodedTransfer {
    from: string;
    to: string;
    value: bigint;
}

/**
 * Decides whether a mined transaction is *this* batch's payout, using three independent sources:
 *  1. the transaction itself (to / from / value / decoded calldata),
 *  2. the contract's SprayTokenExecuted event,
 *  3. every USDC Transfer log in the receipt (pull from sender, one push per recipient, fee).
 * All three must agree with the approved batch before it is treated as settled.
 *
 * @category Services
 */
export function verifySettlement(input: {
    tx: ChainTransaction;
    receipt: ChainReceipt;
    sender: string;
    items: ExpectedTransfer[];
}): SettlementVerification {
    const { tx, receipt, sender, items } = input;
    if (receipt.status !== 'success') {
        return { ok: false, kind: 'reverted', problems: [`transaction ${receipt.transactionHash} reverted`] };
    }
    const problems: string[] = [];
    const total = items.reduce((sum, item) => sum + item.amount, 0n);

    if (tx.hash.toLowerCase() !== receipt.transactionHash.toLowerCase()) {
        problems.push('receipt does not belong to the transaction');
    }
    if (!sameAddress(tx.to, SPRAAY_BATCH_CONTRACT_BASE)) {
        problems.push(`tx.to ${tx.to} is not the Spraay Base contract`);
    }
    if (!sameAddress(tx.from, sender)) {
        problems.push(`tx.from ${tx.from} is not the approved sender ${sender}`);
    }
    if (tx.value !== 0n) {
        problems.push(`tx.value ${tx.value} is not zero`);
    }
    problems.push(...diffSprayTokenCalldata(decodeSprayTokenCalldata(tx.input), items));

    // --- SprayTokenExecuted ---
    const sprayEvents = receipt.logs
        .filter(log => sameAddress(log.address, SPRAAY_BATCH_CONTRACT_BASE))
        .map(log => safeDecode(spraayBatchAbi, log))
        .filter(
            (e): e is { eventName: 'SprayTokenExecuted'; args: any } => !!e && e.eventName === 'SprayTokenExecuted',
        );
    let feeAmount = 0n;
    if (sprayEvents.length !== 1) {
        problems.push(`expected exactly one SprayTokenExecuted event, found ${sprayEvents.length}`);
    } else {
        const args = sprayEvents[0].args;
        feeAmount = args.feeAmount as bigint;
        if (!sameAddress(args.sender, sender)) {
            problems.push(`SprayTokenExecuted.sender ${args.sender} != ${sender}`);
        }
        if (!sameAddress(args.token, USDC_BASE)) {
            problems.push(`SprayTokenExecuted.token ${args.token} is not Base USDC`);
        }
        if (args.totalAmount !== total) {
            problems.push(`SprayTokenExecuted.totalAmount ${args.totalAmount} != ${total}`);
        }
        if (args.recipientCount !== BigInt(items.length)) {
            problems.push(`SprayTokenExecuted.recipientCount ${args.recipientCount} != ${items.length}`);
        }
    }

    // --- USDC Transfer logs ---
    const transfers: DecodedTransfer[] = receipt.logs
        .filter(log => sameAddress(log.address, USDC_BASE))
        .map(log => safeDecode(erc20Abi, log))
        .filter((e): e is { eventName: 'Transfer'; args: any } => !!e && e.eventName === 'Transfer')
        .map(e => ({ from: e.args.from, to: e.args.to, value: e.args.value }));

    const pulls = transfers.filter(
        t => sameAddress(t.from, sender) && sameAddress(t.to, SPRAAY_BATCH_CONTRACT_BASE),
    );
    if (pulls.length !== 1 || pulls[0].value !== total + feeAmount) {
        problems.push(
            `expected one USDC transfer of ${total + feeAmount} from sender to contract, found [${pulls
                .map(p => p.value.toString())
                .join(', ')}]`,
        );
    }
    const pushes = transfers.filter(t => sameAddress(t.from, SPRAAY_BATCH_CONTRACT_BASE));
    const unmatched = [...pushes];
    for (const item of items) {
        const index = unmatched.findIndex(t => sameAddress(t.to, item.recipient) && t.value === item.amount);
        if (index === -1) {
            problems.push(`no USDC transfer of ${item.amount} from contract to ${item.recipient}`);
        } else {
            unmatched.splice(index, 1);
        }
    }
    const expectedLeftovers = feeAmount > 0n ? 1 : 0;
    if (unmatched.length !== expectedLeftovers || (expectedLeftovers === 1 && unmatched[0].value !== feeAmount)) {
        problems.push(
            `unexpected USDC transfers out of the contract: [${unmatched
                .map(t => `${t.to}:${t.value}`)
                .join(', ')}] (fee ${feeAmount})`,
        );
    }

    if (problems.length) {
        return { ok: false, kind: 'mismatch', problems };
    }
    return { ok: true, feeAmount, blockNumber: receipt.blockNumber };
}

function safeDecode(abi: typeof spraayBatchAbi | typeof erc20Abi, log: ChainLog): any {
    try {
        return decodeEventLog({ abi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
        return undefined;
    }
}
