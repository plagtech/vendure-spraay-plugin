import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import { computeProtocolFee, formatUsdc, normalizeAddress, parseRawAmount } from '../src/amounts';
import { computeContentHash, planBatch } from '../src/batch-plan';

import { ALICE, BOB } from './fixtures';

describe('parseRawAmount', () => {
    it('accepts canonical positive integers', () => {
        expect(parseRawAmount('1')).toBe(1n);
        expect(parseRawAmount('1500000')).toBe(1_500_000n);
        expect(parseRawAmount('115792089237316195423570985008687907853269984665640564039457584007913129639935')).toBe(
            (1n << 256n) - 1n,
        );
    });

    it.each(['', '0', '-1', '1.5', '1e6', ' 1', '01', '0x10', '+5', '1_000', 'NaN'])('rejects %j', value => {
        expect(() => parseRawAmount(value)).toThrow();
    });

    it('rejects non-strings (numbers lose precision)', () => {
        expect(() => parseRawAmount(1500000 as any)).toThrow();
    });

    it('rejects values beyond uint256', () => {
        expect(() => parseRawAmount((1n << 256n).toString())).toThrow(/uint256/);
    });
});

describe('fees and formatting', () => {
    it('matches SprayContract integer division', () => {
        expect(computeProtocolFee(3_750_001n, 30n)).toBe(11_250n);
        expect(computeProtocolFee(333n, 30n)).toBe(0n);
        expect(computeProtocolFee(10_000n, 30n)).toBe(30n);
    });

    it('formats raw USDC for display', () => {
        expect(formatUsdc(1_500_000n)).toBe('1.5');
        expect(formatUsdc(1n)).toBe('0.000001');
        expect(formatUsdc(42_000_000n)).toBe('42');
    });
});

describe('normalizeAddress', () => {
    it('checksums and rejects the zero address', () => {
        expect(normalizeAddress(ALICE)).toBe(getAddress(ALICE));
        expect(normalizeAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
        expect(() => normalizeAddress('0x0000000000000000000000000000000000000000')).toThrow(/zero/);
        expect(() => normalizeAddress('0x123')).toThrow();
    });
});

describe('planBatch', () => {
    const line = (id: string, sellerId: string, recipientAddress: string, amount: bigint) => ({
        id,
        sellerId,
        recipientAddress,
        amount,
    });

    it('aggregates lines per recipient with exact integer sums', () => {
        const plan = planBatch([
            line('1', 's1', BOB, 1n),
            line('2', 's2', ALICE, 999_999n),
            line('3', 's1', getAddress(BOB), 2_250_000n),
        ]);
        expect(plan.items).toHaveLength(2);
        expect(plan.items[0].recipient.toLowerCase()).toBe(ALICE.toLowerCase());
        expect(plan.items[1]).toMatchObject({ amount: 2_250_001n, lineIds: ['1', '3'], sellerIds: ['s1'] });
        expect(plan.totalAmount).toBe(3_250_000n);
    });

    it('is deterministic regardless of input order', () => {
        const a = planBatch([line('1', 's1', ALICE, 5n), line('2', 's2', BOB, 7n)]);
        const b = planBatch([line('2', 's2', BOB, 7n), line('1', 's1', ALICE, 5n)]);
        expect(a.contentHash).toBe(b.contentHash);
    });

    it('content hash changes when any amount or recipient changes', () => {
        const base = computeContentHash([{ recipient: ALICE, amount: 5n }]);
        expect(computeContentHash([{ recipient: ALICE, amount: 6n }])).not.toBe(base);
        expect(computeContentHash([{ recipient: BOB, amount: 5n }])).not.toBe(base);
    });

    it('allows exactly 200 recipients and rejects 201', () => {
        const mk = (n: number) =>
            Array.from({ length: n }, (_, i) =>
                line(String(i), `s${i}`, '0x' + (i + 1).toString(16).padStart(40, '0'), 1n),
            );
        expect(planBatch(mk(200)).items).toHaveLength(200);
        expect(() => planBatch(mk(201))).toThrow(/at most 200/);
    });

    it('rejects duplicate line ids, empty input and bad addresses', () => {
        expect(() => planBatch([])).toThrow();
        expect(() => planBatch([line('1', 's', ALICE, 1n), line('1', 's', ALICE, 1n)])).toThrow(/twice/);
        expect(() => planBatch([line('1', 's', '0x0000000000000000000000000000000000000000', 1n)])).toThrow(/zero/);
        expect(() => planBatch([line('1', 's', 'not-an-address', 1n)])).toThrow();
    });
});
