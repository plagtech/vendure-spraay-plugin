import { decodeFunctionData, encodeFunctionData, Hex } from 'viem';

import { sameAddress } from '../amounts';
import { USDC_BASE } from '../constants';

import { erc20Abi, spraayBatchAbi } from './abi';

/**
 * A recipient–amount pair expected in the on-chain calldata.
 *
 * @category Services
 */
export interface ExpectedTransfer {
    recipient: string;
    amount: bigint;
}

/**
 * Decoded result of a `sprayToken` function call.
 *
 * @category Services
 */
export interface DecodedSprayToken {
    token: `0x${string}`;
    recipients: Array<{ recipient: `0x${string}`; amount: bigint }>;
}

/**
 * Decodes `sprayToken(address,(address,uint256)[])` calldata. Returns null for anything else.
 *
 * @category Services
 */
export function decodeSprayTokenCalldata(data: string | undefined | null): DecodedSprayToken | null {
    if (!data || !/^0x[0-9a-fA-F]*$/.test(data)) {
        return null;
    }
    try {
        const decoded = decodeFunctionData({ abi: spraayBatchAbi, data: data as Hex });
        if (decoded.functionName !== 'sprayToken') {
            return null;
        }
        const [token, recipients] = decoded.args as readonly [
            `0x${string}`,
            ReadonlyArray<{ recipient: `0x${string}`; amount: bigint }>,
        ];
        return { token, recipients: recipients.map(r => ({ recipient: r.recipient, amount: r.amount })) };
    } catch {
        return null;
    }
}

/**
 * Lists every difference between decoded calldata and the planned transfers. Order matters:
 * the plugin always submits items in its deterministic order, so a reordering is a mismatch too.
 *
 * @category Services
 */
export function diffSprayTokenCalldata(decoded: DecodedSprayToken | null, expected: ExpectedTransfer[]): string[] {
    if (!decoded) {
        return ['calldata is not a sprayToken(address,(address,uint256)[]) call'];
    }
    const problems: string[] = [];
    if (!sameAddress(decoded.token, USDC_BASE)) {
        problems.push(`calldata token ${decoded.token} is not Base USDC ${USDC_BASE}`);
    }
    if (decoded.recipients.length !== expected.length) {
        problems.push(`calldata has ${decoded.recipients.length} recipients, expected ${expected.length}`);
        return problems;
    }
    expected.forEach((item, i) => {
        const actual = decoded.recipients[i];
        if (!sameAddress(actual.recipient, item.recipient)) {
            problems.push(`calldata recipient #${i} is ${actual.recipient}, expected ${item.recipient}`);
        }
        if (actual.amount !== item.amount) {
            problems.push(`calldata amount #${i} is ${actual.amount}, expected ${item.amount}`);
        }
    });
    return problems;
}

/**
 * Encodes the `sprayToken` calldata from the planned transfers.
 *
 * @category Services
 */
export function encodeSprayTokenCalldata(expected: ExpectedTransfer[]): Hex {
    return encodeFunctionData({
        abi: spraayBatchAbi,
        functionName: 'sprayToken',
        args: [USDC_BASE, expected.map(e => ({ recipient: e.recipient as `0x${string}`, amount: e.amount }))],
    });
}

/**
 * Encodes an ERC-20 `approve` calldata for the given spender and amount.
 *
 * @category Services
 */
export function encodeApproveCalldata(spender: string, amount: bigint): Hex {
    return encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as `0x${string}`, amount] });
}
