import { computeProtocolFee, sameAddress } from '../amounts';
import { decodeSprayTokenCalldata, diffSprayTokenCalldata, ExpectedTransfer } from '../chain/calldata';
import { BASE_CHAIN_ID, MAX_RECIPIENTS_PER_BATCH, SPRAAY_BATCH_CONTRACT_BASE, USDC_BASE, USDC_DECIMALS } from '../constants';

import { GatewayExecuteResponse } from './spraay-gateway.client';

/** Upper bound for a sane gas limit: 200 cold ERC-20 transfers stay far below this. */
const MAX_REASONABLE_GAS_LIMIT = 15_000_000n;

export interface VerifiedExecuteResponse {
    calldata: `0x${string}`;
    gatewayGasLimit: bigint;
    /** Raw allowance the gateway says to approve (totalAmount + fee). */
    approvalAmount: bigint;
    fee: bigint;
}

export class GatewayResponseMismatchError extends Error {
    constructor(readonly problems: string[]) {
        super(`Refusing Spraay gateway response: ${problems.join('; ')}`);
        this.name = 'GatewayResponseMismatchError';
    }
}

/**
 * The gateway is not trusted blindly. Its unsigned transaction is decoded and compared,
 * field by field, with the batch the admin approved and with the fee rate read from the
 * contract itself. Any difference aborts before a signing request is ever produced.
 */
export function verifyExecuteResponse(
    response: GatewayExecuteResponse,
    expected: { items: ExpectedTransfer[]; feeBps: bigint },
): VerifiedExecuteResponse {
    const problems: string[] = [];
    const total = expected.items.reduce((sum, item) => sum + item.amount, 0n);
    const fee = computeProtocolFee(total, expected.feeBps);

    if (expected.items.length === 0 || expected.items.length > MAX_RECIPIENTS_PER_BATCH) {
        problems.push(`expected batch size ${expected.items.length} is outside 1..${MAX_RECIPIENTS_PER_BATCH}`);
    }
    if (response.success !== true) {
        problems.push('success is not true');
    }
    if (!sameAddress(response.contract, SPRAAY_BATCH_CONTRACT_BASE)) {
        problems.push(`contract ${response.contract} is not the Spraay Base contract ${SPRAAY_BATCH_CONTRACT_BASE}`);
    }
    const token = response.token ?? {};
    if (!sameAddress(token.address, USDC_BASE) || token.isETH !== false || token.decimals !== USDC_DECIMALS) {
        problems.push(`token ${JSON.stringify(token)} is not Base USDC (6 decimals)`);
    }
    if (response.batch?.recipientCount !== expected.items.length) {
        problems.push(`batch.recipientCount ${response.batch?.recipientCount} != ${expected.items.length}`);
    }

    const tx = response.transaction ?? {};
    if (!sameAddress(tx.to, SPRAAY_BATCH_CONTRACT_BASE)) {
        problems.push(`transaction.to ${tx.to} is not the Spraay Base contract`);
    }
    if (tx.chainId !== BASE_CHAIN_ID) {
        problems.push(`transaction.chainId ${tx.chainId} is not Base (${BASE_CHAIN_ID})`);
    }
    if (tx.value !== '0') {
        problems.push(`transaction.value ${tx.value} must be "0" for a USDC batch`);
    }
    problems.push(...diffSprayTokenCalldata(decodeSprayTokenCalldata(tx.data), expected.items));

    let gatewayGasLimit = 0n;
    if (typeof tx.gasLimit !== 'string' || !/^0x[0-9a-fA-F]+$/.test(tx.gasLimit)) {
        problems.push(`transaction.gasLimit ${tx.gasLimit} is not a hex quantity`);
    } else {
        gatewayGasLimit = BigInt(tx.gasLimit);
        if (gatewayGasLimit <= 0n || gatewayGasLimit > MAX_REASONABLE_GAS_LIMIT) {
            problems.push(`transaction.gasLimit ${gatewayGasLimit} is outside the sane range`);
        }
    }

    const approval = response.approvalRequired ?? {};
    let approvalAmount = 0n;
    if (!sameAddress(approval.token, USDC_BASE)) {
        problems.push(`approvalRequired.token ${approval.token} is not Base USDC`);
    }
    if (!sameAddress(approval.spender, SPRAAY_BATCH_CONTRACT_BASE)) {
        problems.push(`approvalRequired.spender ${approval.spender} is not the Spraay Base contract`);
    }
    if (typeof approval.amount !== 'string' || !/^[0-9]+$/.test(approval.amount)) {
        problems.push(`approvalRequired.amount ${approval.amount} is not a raw integer string`);
    } else {
        approvalAmount = BigInt(approval.amount);
        if (approvalAmount !== total + fee) {
            problems.push(
                `approvalRequired.amount ${approvalAmount} != total ${total} + on-chain fee ${fee} (feeBps ${expected.feeBps})`,
            );
        }
    }

    if (problems.length) {
        throw new GatewayResponseMismatchError(problems);
    }
    return { calldata: tx.data as `0x${string}`, gatewayGasLimit, approvalAmount, fee };
}
