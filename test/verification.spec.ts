import { encodeFunctionData, pad } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { spraayBatchAbi } from '../src/chain/abi';
import { decodeSprayTokenCalldata, diffSprayTokenCalldata, encodeSprayTokenCalldata } from '../src/chain/calldata';
import { inspectSignedTransaction } from '../src/chain/signed-transaction';
import { verifySettlement } from '../src/chain/verify-settlement';
import { SPRAAY_BATCH_CONTRACT_BASE, USDC_BASE } from '../src/constants';
import { verifyExecuteResponse } from '../src/gateway/verify-gateway-response';

import {
    ALICE,
    BOB,
    FEE_RECIPIENT,
    feeAt30Bps,
    gatewayResponse,
    happyPath,
    items,
    SENDER,
    sprayEventLog,
    total,
    transferLog,
} from './fixtures';

describe('calldata', () => {
    it('round-trips sprayToken calldata', () => {
        const decoded = decodeSprayTokenCalldata(encodeSprayTokenCalldata(items));
        expect(diffSprayTokenCalldata(decoded, items)).toEqual([]);
    });

    it('detects reordering, amount changes and other functions', () => {
        const swapped = decodeSprayTokenCalldata(encodeSprayTokenCalldata([items[1], items[0]]));
        expect(diffSprayTokenCalldata(swapped, items).length).toBeGreaterThan(0);
        const off = decodeSprayTokenCalldata(encodeSprayTokenCalldata([items[0], { ...items[1], amount: items[1].amount + 1n }]));
        expect(diffSprayTokenCalldata(off, items)).toEqual([expect.stringContaining('amount #1')]);
        const eth = encodeFunctionData({ abi: spraayBatchAbi, functionName: 'sprayETH', args: [[]] });
        expect(decodeSprayTokenCalldata(eth)).toBeNull();
    });
});

describe('verifyExecuteResponse (gateway output is not trusted)', () => {
    it('accepts a response that matches the approved batch and on-chain fee', () => {
        const verified = verifyExecuteResponse(gatewayResponse(), { items, feeBps: 30n });
        expect(verified.approvalAmount).toBe(total + feeAt30Bps);
        expect(verified.gatewayGasLimit).toBe(0x38270n);
    });

    const cases: Array<[string, Parameters<typeof gatewayResponse>[0]]> = [
        ['wrong contract', { contract: '0x08fA5D1c16CD6E2a16FC0E4839f262429959E073' }],
        ['native ETH token', { token: { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', decimals: 18, isETH: true } }],
        [
            'tampered recipient',
            {
                transaction: {
                    to: SPRAAY_BATCH_CONTRACT_BASE,
                    data: encodeSprayTokenCalldata([{ recipient: '0x000000000000000000000000000000000000dEaD', amount: items[0].amount }, items[1]]),
                    value: '0',
                    chainId: 8453,
                    gasLimit: '0x38270',
                },
            },
        ],
        ['wrong chain', { transaction: { ...gatewayResponse().transaction, chainId: 3338 } }],
        ['non-zero value', { transaction: { ...gatewayResponse().transaction, value: '1' } }],
        ['decimal gas limit', { transaction: { ...gatewayResponse().transaction, gasLimit: '230000' } }],
        ['inflated approval', { approvalRequired: { ...gatewayResponse().approvalRequired, amount: (total + feeAt30Bps + 1n).toString() } }],
        ['wrong spender', { approvalRequired: { ...gatewayResponse().approvalRequired, spender: SENDER } }],
        ['recipient count', { batch: { recipientCount: 3 } }],
        ['not success', { success: false }],
    ];
    it.each(cases)('rejects %s', (_label, override) => {
        expect(() => verifyExecuteResponse(gatewayResponse(override), { items, feeBps: 30n })).toThrow(/Refusing/);
    });

    it('rejects when the contract fee rate differs from what the gateway priced', () => {
        expect(() => verifyExecuteResponse(gatewayResponse(), { items, feeBps: 50n })).toThrow(/approvalRequired.amount/);
    });
});

describe('verifySettlement', () => {
    it('accepts a matching execution', () => {
        const { tx, receipt } = happyPath();
        expect(verifySettlement({ tx, receipt, sender: SENDER, items })).toEqual({
            ok: true,
            feeAmount: feeAt30Bps,
            blockNumber: 100n,
        });
    });

    it('reports reverts separately from mismatches', () => {
        const { tx, receipt } = happyPath();
        const result = verifySettlement({ tx, receipt: { ...receipt, status: 'reverted' }, sender: SENDER, items });
        expect(result).toMatchObject({ ok: false, kind: 'reverted' });
    });

    it('rejects a different sender', () => {
        const { tx, receipt } = happyPath();
        const other = '0x2222222222222222222222222222222222222222';
        expect(verifySettlement({ tx: { ...tx, from: other }, receipt, sender: SENDER, items }).ok).toBe(false);
    });

    it('rejects when a recipient transfer is missing or short', () => {
        const { tx, receipt } = happyPath();
        const logs = receipt.logs.filter((_, i) => i !== 2).concat(transferLog(SPRAAY_BATCH_CONTRACT_BASE, BOB, 2_250_000n));
        const result = verifySettlement({ tx, receipt: { ...receipt, logs }, sender: SENDER, items });
        expect(result).toMatchObject({ ok: false, kind: 'mismatch' });
    });

    it('rejects an extra transfer out of the contract', () => {
        const { tx, receipt } = happyPath();
        const logs = [...receipt.logs, transferLog(SPRAAY_BATCH_CONTRACT_BASE, ALICE, 1n)];
        expect(verifySettlement({ tx, receipt: { ...receipt, logs }, sender: SENDER, items }).ok).toBe(false);
    });

    it('rejects a missing or wrong SprayTokenExecuted event', () => {
        const { tx, receipt } = happyPath();
        const noEvent = receipt.logs.slice(0, -1);
        expect(verifySettlement({ tx, receipt: { ...receipt, logs: noEvent }, sender: SENDER, items }).ok).toBe(false);
        const wrongTotal = [...noEvent, sprayEventLog(SENDER, total + 1n, 2n, feeAt30Bps)];
        expect(verifySettlement({ tx, receipt: { ...receipt, logs: wrongTotal }, sender: SENDER, items }).ok).toBe(false);
        const wrongToken = [...noEvent, sprayEventLog(SENDER, total, 2n, feeAt30Bps, ALICE)];
        expect(verifySettlement({ tx, receipt: { ...receipt, logs: wrongToken }, sender: SENDER, items }).ok).toBe(false);
    });

    it('ignores look-alike logs emitted by other contracts', () => {
        const { tx, receipt } = happyPath();
        const fake = { ...transferLog(SPRAAY_BATCH_CONTRACT_BASE, ALICE, 1_500_000n), address: FEE_RECIPIENT };
        expect(verifySettlement({ tx, receipt: { ...receipt, logs: [...receipt.logs, fake] }, sender: SENDER, items }).ok).toBe(true);
    });

    it('accepts a zero fee (tiny batches round the fee down to 0)', () => {
        const { tx, receipt } = happyPath({ fee: 0n });
        expect(verifySettlement({ tx, receipt, sender: SENDER, items })).toMatchObject({ ok: true, feeAmount: 0n });
    });
});

describe('inspectSignedTransaction', () => {
    const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const request = {
        from: account.address,
        to: SPRAAY_BATCH_CONTRACT_BASE,
        data: encodeSprayTokenCalldata(items),
        value: '0',
        chainId: 8453,
        nonce: 3,
        gas: '0x50000',
    };
    const sign = (overrides: Record<string, unknown> = {}) =>
        account.signTransaction({
            type: 'eip1559',
            chainId: 8453,
            nonce: 3,
            to: SPRAAY_BATCH_CONTRACT_BASE,
            data: request.data as `0x${string}`,
            value: 0n,
            gas: 0x50000n,
            maxFeePerGas: 1_000_000_000n,
            maxPriorityFeePerGas: 1_000_000n,
            ...overrides,
        } as any);

    it('accepts the exact requested transaction and computes its hash', async () => {
        const result = await inspectSignedTransaction(await sign(), request);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.tx.hash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it.each([
        ['another nonce', { nonce: 4 }],
        ['another chain', { chainId: 1 }],
        ['another target', { to: USDC_BASE }],
        ['other calldata', { data: encodeSprayTokenCalldata([items[0]]) }],
        ['a value', { value: 1n }],
        ['less gas', { gas: 21_000n }],
    ])('rejects %s', async (_label, overrides) => {
        expect((await inspectSignedTransaction(await sign(overrides), request)).ok).toBe(false);
    });

    it('rejects a different signer and garbage', async () => {
        const other = privateKeyToAccount(pad('0x01', { size: 32 }));
        const raw = await other.signTransaction({
            type: 'eip1559', chainId: 8453, nonce: 3, to: SPRAAY_BATCH_CONTRACT_BASE, data: request.data as `0x${string}`,
            gas: 0x50000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n,
        });
        expect((await inspectSignedTransaction(raw, request)).ok).toBe(false);
        expect((await inspectSignedTransaction('0xdeadbeef', request)).ok).toBe(false);
        expect((await inspectSignedTransaction('nope', request)).ok).toBe(false);
    });
});
