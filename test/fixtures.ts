import { encodeAbiParameters, encodeEventTopics, Hex, pad } from 'viem';

import { erc20Abi, spraayBatchAbi } from '../src/chain/abi';
import { encodeSprayTokenCalldata, ExpectedTransfer } from '../src/chain/calldata';
import { ChainLog, ChainReceipt, ChainTransaction } from '../src/chain/verify-settlement';
import { SPRAAY_BATCH_CONTRACT_BASE, USDC_BASE } from '../src/constants';
import { GatewayExecuteResponse } from '../src/gateway/spraay-gateway.client';

export const SENDER = '0x1111111111111111111111111111111111111111';
export const FEE_RECIPIENT = '0x033d3ce3bfd69b1d180869308822075219e771b5';
export const ALICE = '0xa11ce00000000000000000000000000000000001';
export const BOB = '0xb0b0000000000000000000000000000000000002';

export const items: ExpectedTransfer[] = [
    { recipient: ALICE, amount: 1_500_000n },
    { recipient: BOB, amount: 2_250_001n },
];
export const total = 3_750_001n;
export const feeAt30Bps = (total * 30n) / 10_000n; // 11_250

export function transferLog(from: string, to: string, value: bigint): ChainLog {
    return {
        address: USDC_BASE,
        topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: from as Hex, to: to as Hex } }) as string[],
        data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    };
}

export function sprayEventLog(sender: string, totalAmount: bigint, count: bigint, fee: bigint, token: string = USDC_BASE): ChainLog {
    return {
        address: SPRAAY_BATCH_CONTRACT_BASE,
        topics: encodeEventTopics({
            abi: spraayBatchAbi,
            eventName: 'SprayTokenExecuted',
            args: { sender: sender as Hex, token: token as Hex },
        }) as string[],
        data: encodeAbiParameters(
            [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
            [totalAmount, count, fee, 1_760_000_000n],
        ),
    };
}

export function happyPath(overrides: { fee?: bigint } = {}) {
    const fee = overrides.fee ?? feeAt30Bps;
    const hash = pad('0xabc', { size: 32 });
    const tx: ChainTransaction = {
        hash,
        from: SENDER,
        to: SPRAAY_BATCH_CONTRACT_BASE,
        input: encodeSprayTokenCalldata(items),
        value: 0n,
        nonce: 7,
        chainId: 8453,
        blockNumber: 100n,
    };
    const receipt: ChainReceipt = {
        transactionHash: hash,
        status: 'success',
        blockNumber: 100n,
        from: SENDER,
        to: SPRAAY_BATCH_CONTRACT_BASE,
        logs: [
            transferLog(SENDER, SPRAAY_BATCH_CONTRACT_BASE, total + fee),
            transferLog(SPRAAY_BATCH_CONTRACT_BASE, ALICE, 1_500_000n),
            transferLog(SPRAAY_BATCH_CONTRACT_BASE, BOB, 2_250_001n),
            ...(fee > 0n ? [transferLog(SPRAAY_BATCH_CONTRACT_BASE, FEE_RECIPIENT, fee)] : []),
            sprayEventLog(SENDER, total, 2n, fee),
        ],
    };
    return { tx, receipt };
}

export function gatewayResponse(overrides: Partial<GatewayExecuteResponse> = {}): GatewayExecuteResponse {
    return {
        success: true,
        contract: SPRAAY_BATCH_CONTRACT_BASE,
        token: { symbol: 'USDC', address: USDC_BASE, decimals: 6, isETH: false },
        batch: { recipientCount: 2, totalAmount: '3.750001', fee: '0.01125', feePercent: '0.3%', totalWithFee: '3.761251' },
        transaction: {
            to: SPRAAY_BATCH_CONTRACT_BASE,
            data: encodeSprayTokenCalldata(items),
            value: '0',
            chainId: 8453,
            gasLimit: '0x38270',
        },
        approvalRequired: {
            token: USDC_BASE,
            spender: SPRAAY_BATCH_CONTRACT_BASE,
            amount: (total + feeAt30Bps).toString(),
            amountFormatted: '3.761251',
        },
        ...overrides,
    };
}
