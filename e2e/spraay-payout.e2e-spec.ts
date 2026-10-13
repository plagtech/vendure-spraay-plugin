/**
 * End-to-end: a real Vendure server with the plugin, an anvil fork of Base mainnet (so the real
 * Spraay batch contract 0x1646…5eEC and real USDC execute every payout), and the local gateway
 * stand-in (byte-identical to the production handler for the endpoints used).
 *
 * Requires Foundry's `anvil` and network access to a Base RPC for forking. Skipped otherwise.
 */
import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import path from 'path';
import { encodeFunctionData, Hex, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { spraayBatchAbi } from '../src/chain/abi';
import { SPRAAY_BATCH_CONTRACT_BASE, USDC_BASE } from '../src/constants';
import { SpraayPayoutPlugin } from '../src';
import { simulatedX402Fetch, startLocalGateway } from '../demo/local-gateway';

import * as Q from './graphql';
import { findAnvil, initialData, MerchantWallet, merchant, startAnvilFork } from './helpers';

const ANVIL_PORT = 8546;
const GATEWAY_PORT = 4546;
const CONFIRMATIONS = 3;

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));

const anvilAvailable = !!findAnvil() && process.env.SKIP_FORK_E2E !== '1';

describe.skipIf(!anvilAvailable)('Spraay payouts on a Base mainnet fork', () => {
    let gatewayTransform: ((path: string, body: any) => any) | undefined;
    let stopAnvil: () => void;
    let closeGateway: () => Promise<void>;
    let gatewayCalls: string[];
    let wallet: MerchantWallet;
    let keyCounter = 0;

    const config = mergeConfig(testConfig, {
        apiOptions: { port: 3150 },
        plugins: [
            SpraayPayoutPlugin.init({
                rpcUrl: `http://127.0.0.1:${ANVIL_PORT}`,
                allowedSenders: [merchant.address],
                gatewayUrl: `http://127.0.0.1:${GATEWAY_PORT}`,
                gatewayFetch: simulatedX402Fetch,
                requiredConfirmations: CONFIRMATIONS,
                requireDistinctApprover: true,
                reconcileSchedule: false,
            }),
        ],
    });
    const { server, adminClient } = createTestEnvironment(config);

    const sellers: Array<{ id: string; address: string }> = [];

    beforeAll(async () => {
        const anvil = await startAnvilFork(ANVIL_PORT);
        stopAnvil = anvil.stop;
        wallet = new MerchantWallet(anvil.rpcUrl);
        await wallet.dealUsdc(merchant.address, 1_000_000_000_000n); // 1,000,000 USDC on the fork
        const gw = await startLocalGateway({
            port: GATEWAY_PORT,
            rpcUrl: anvil.rpcUrl,
            transform: (p, body) => (gatewayTransform ? gatewayTransform(p, body) : body),
        });
        closeGateway = gw.close;
        gatewayCalls = gw.calls;
        await server.init({ initialData, customerCount: 0 });
        await adminClient.asSuperAdmin();
        for (const name of ['Acme Ceramics', 'Birch & Co', 'Cobalt Prints']) {
            sellers.push(await createSeller(name));
        }
        const { createRole } = await adminClient.query(Q.CREATE_ROLE, {
            input: { code: 'payout-approver', description: 'Approves Spraay payouts', permissions: ['ReadSpraayPayouts', 'ApproveSpraayPayouts'] },
        });
        await adminClient.query(Q.CREATE_ADMIN, {
            input: { firstName: 'Ada', lastName: 'Approver', emailAddress: 'approver@test.dev', password: 'approver', roleIds: [createRole.id] },
        });
    }, 240_000);

    afterAll(async () => {
        await server.destroy();
        await closeGateway?.();
        stopAnvil?.();
    });

    async function createSeller(name: string) {
        const address = privateKeyToAccount(generatePrivateKey()).address;
        const { createSeller: s } = await adminClient.query(Q.CREATE_SELLER, {
            input: { name, customFields: { spraayPayoutAddress: address } },
        });
        return { id: s.id as string, address };
    }

    async function createLines(entries: Array<{ seller: { id: string }; amount: string }>) {
        const { createSpraayPayoutLines } = await adminClient.query(Q.CREATE_LINES, {
            input: entries.map(e => ({ sellerId: e.seller.id, amount: e.amount, idempotencyKey: `k-${++keyCounter}`, reference: `order-${keyCounter}` })),
        });
        return createSpraayPayoutLines as Array<{ id: string; amount: string }>;
    }

    async function approvedBatch(lineIds: string[]) {
        const { createSpraayPayoutBatch: batch } = await adminClient.query(Q.CREATE_BATCH, { lineIds });
        await adminClient.asUserWithCredentials('approver@test.dev', 'approver');
        try {
            const { approveSpraayPayoutBatch } = await adminClient.query(Q.APPROVE_BATCH, { id: batch.id, contentHash: batch.contentHash });
            return approveSpraayPayoutBatch;
        } finally {
            await adminClient.asSuperAdmin();
        }
    }

    const prepare = async (id: string) => (await adminClient.query(Q.PREPARE_BATCH, { id, sender: merchant.address })).prepareSpraayPayoutBatch;
    const reconcile = async (id: string) => (await adminClient.query(Q.RECONCILE, { id })).reconcileSpraayPayoutBatch;
    const submit = async (batchId: string, signedTransaction: string) =>
        (await adminClient.query(Q.SUBMIT_SIGNED, { batchId, signedTransaction })).submitSpraaySignedTransaction;

    /** Grants exactly the allowance the plugin asks for (if it asks), then returns the signing-ready batch. */
    async function prepareWithAllowance(id: string) {
        let batch = await prepare(id);
        if (batch.state === 'AWAITING_ALLOWANCE') {
            await wallet.signAndSend(batch.approvalRequest);
            batch = await prepare(id);
        }
        expect(batch.state).toBe('AWAITING_SIGNATURE');
        return batch;
    }

    it('exposes the pinned v1 configuration', async () => {
        const { spraayPayoutConfig } = await adminClient.query(Q.GET_CONFIG);
        expect(spraayPayoutConfig).toMatchObject({
            chainId: 8453,
            contractAddress: SPRAAY_BATCH_CONTRACT_BASE,
            tokenAddress: USDC_BASE,
            allowedSenders: [merchant.address],
            maxRecipientsPerBatch: 200,
        });
    });

    describe('payout lines', () => {
        it('are idempotent per key and reject conflicting reuse', async () => {
            const input = [{ sellerId: sellers[0].id, amount: '1000000', idempotencyKey: 'order-ABC' }];
            const first = (await adminClient.query(Q.CREATE_LINES, { input })).createSpraayPayoutLines;
            const replay = (await adminClient.query(Q.CREATE_LINES, { input })).createSpraayPayoutLines;
            expect(replay[0].id).toBe(first[0].id);
            await expect(
                adminClient.query(Q.CREATE_LINES, { input: [{ ...input[0], amount: '1000001' }] }),
            ).rejects.toThrow(/already records a different payout/);
        });

        it.each(['1.5', '0', '-1', '1e6', '00100'])('reject non-canonical amount %j', async amount => {
            await expect(
                adminClient.query(Q.CREATE_LINES, { input: [{ sellerId: sellers[0].id, amount, idempotencyKey: `bad-${amount}` }] }),
            ).rejects.toThrow(/positive integer string|greater than zero/);
        });
    });

    describe('approval', () => {
        it('requires a distinct approver and the exact content hash', async () => {
            const lines = await createLines([{ seller: sellers[0], amount: '10' }]);
            const { createSpraayPayoutBatch: batch } = await adminClient.query(Q.CREATE_BATCH, { lineIds: lines.map(l => l.id) });
            await expect(adminClient.query(Q.APPROVE_BATCH, { id: batch.id, contentHash: batch.contentHash })).rejects.toThrow(
                /not currently authorized|Forbidden/i,
            );
            await adminClient.asUserWithCredentials('approver@test.dev', 'approver');
            await expect(
                adminClient.query(Q.APPROVE_BATCH, { id: batch.id, contentHash: '0x' + '0'.repeat(64) }),
            ).rejects.toThrow(/contentHash does not match/);
            await adminClient.asSuperAdmin();
            await expect(prepare(batch.id)).rejects.toThrow(/cannot be prepared/);
            const cancelled = (await adminClient.query(Q.CANCEL, { id: batch.id, reason: 'test' })).cancelSpraayPayoutBatch;
            expect(cancelled.state).toBe('CANCELLED');
        });
    });

    describe('happy path: three sellers, one batch', () => {
        let batchId: string;
        let lineIds: string[];

        it('builds, approves and settles a multi-seller batch with exact amounts', async () => {
            const before = await Promise.all(sellers.map(s => wallet.usdcBalance(s.address)));
            const lines = await createLines([
                { seller: sellers[0], amount: '12500000' }, // 12.50
                { seller: sellers[1], amount: '7333333' }, //  7.333333
                { seller: sellers[0], amount: '1' }, //         0.000001 (aggregates with the first)
                { seller: sellers[2], amount: '99000000' }, // 99.00
                { seller: sellers[1], amount: '666667' }, //    0.666667
            ]);
            lineIds = lines.map(l => l.id);
            const batch = await approvedBatch(lineIds);
            batchId = batch.id;
            expect(batch).toMatchObject({ state: 'APPROVED', recipientCount: 3, totalAmount: '119500001' });

            await adminClient.query(Q.ESTIMATE_BATCH, { id: batchId, sender: merchant.address });
            expect(gatewayCalls).toContain('/api/v1/batch/estimate');

            const awaitingAllowance = await prepare(batchId);
            expect(awaitingAllowance.state).toBe('AWAITING_ALLOWANCE');
            expect(awaitingAllowance.requiredAllowance).toBe((119_500_001n + (119_500_001n * 30n) / 10_000n).toString());
            await wallet.signAndSend(awaitingAllowance.approvalRequest);

            const ready = await prepare(batchId);
            expect(ready.state).toBe('AWAITING_SIGNATURE');
            expect(gatewayCalls.filter(c => c.endsWith('execute'))).toHaveLength(1); // cached: no second paid call
            const request = ready.signingRequest;
            expect(request).toMatchObject({ from: merchant.address, to: SPRAAY_BATCH_CONTRACT_BASE, value: '0', chainId: 8453 });
            expect(request.nonce).toBe(await wallet.publicClient.getTransactionCount({ address: merchant.address }));

            const raw = await wallet.sign(request);
            const submitted = await submit(batchId, raw);
            expect(submitted.broadcastError).toBeNull();
            expect(submitted.batch.state).toBe('SUBMITTED');

            // Submitting the identical signed bytes again is harmless and idempotent.
            const again = await submit(batchId, raw);
            expect(again.txHash).toBe(submitted.txHash);
            expect(again.batch.attempts).toHaveLength(1);
            expect(again.batch.attempts[0].txHashes).toEqual([submitted.txHash]);

            const shallow = await reconcile(batchId);
            expect(shallow.state).toBe('SUBMITTED'); // mined but not deep enough yet
            await wallet.mine(CONFIRMATIONS);
            const settled = await reconcile(batchId);
            expect(settled.state).toBe('SETTLED');
            expect(settled.settledTxHash).toBe(submitted.txHash);
            expect(settled.settledFeeAmount).toBe(((119_500_001n * 30n) / 10_000n).toString());
            expect(settled.lines.every((l: any) => l.state === 'PAID')).toBe(true);

            const after = await Promise.all(sellers.map(s => wallet.usdcBalance(s.address)));
            expect(after[0] - before[0]).toBe(12_500_001n);
            expect(after[1] - before[1]).toBe(8_000_000n);
            expect(after[2] - before[2]).toBe(99_000_000n);
            expect(await wallet.allowance()).toBe(0n); // exact approval fully consumed
        });

        it('refuses to pay a settled batch or its lines again', async () => {
            await expect(prepare(batchId)).rejects.toThrow(/cannot be prepared/);
            await expect(reconcile(batchId)).resolves.toMatchObject({ state: 'SETTLED' });
            await expect(adminClient.query(Q.CREATE_BATCH, { lineIds })).rejects.toThrow(/must be PENDING/);
        });
    });

    it('rejects a tampered gateway response before anything is signed', async () => {
        const lines = await createLines([{ seller: sellers[2], amount: '5000000' }]);
        const batch = await approvedBatch(lines.map(l => l.id));
        const attacker = '0x000000000000000000000000000000000000dEaD';
        gatewayTransform = (p, body) => {
            if (!p.endsWith('execute') || !body.transaction) return body;
            const data = encodeFunctionData({
                abi: spraayBatchAbi,
                functionName: 'sprayToken',
                args: [USDC_BASE, [{ recipient: attacker, amount: 5_000_000n }]],
            });
            return { ...body, transaction: { ...body.transaction, data } };
        };
        try {
            await expect(prepare(batch.id)).rejects.toThrow(/Refusing Spraay gateway response.*calldata recipient #0/);
        } finally {
            gatewayTransform = undefined;
        }
        const after = (await adminClient.query(Q.RECONCILE, { id: batch.id })).reconcileSpraayPayoutBatch;
        expect(after.state).toBe('APPROVED');
        expect(after.attempts).toHaveLength(0);
        expect(after.auditLog.map((a: any) => a.action)).toContain('GATEWAY_RESPONSE_REJECTED');
        await adminClient.query(Q.CANCEL, { id: batch.id, reason: 'tamper test' });
    });

    it('finds a transaction the wallet broadcast without reporting it (pending → settled)', async () => {
        const lines = await createLines([{ seller: sellers[1], amount: '3000000' }]);
        const batch = await prepareWithAllowance((await approvedBatch(lines.map(l => l.id))).id);
        await wallet.setAutomine(false);
        try {
            await wallet.broadcast(await wallet.sign(batch.signingRequest)); // never reported to the plugin
            const pending = await reconcile(batch.id);
            expect(pending.state).toBe('AWAITING_SIGNATURE'); // nonce not consumed yet: keep waiting
        } finally {
            await wallet.setAutomine(true);
        }
        await wallet.mine(1);
        const found = await reconcile(batch.id);
        expect(found.state).toBe('SUBMITTED');
        expect(found.auditLog.map((a: any) => a.action)).toContain('REPLACEMENT_DETECTED');
        await wallet.mine(CONFIRMATIONS);
        expect((await reconcile(batch.id)).state).toBe('SETTLED');
    });

    it('accepts a hash reported by a self-broadcasting wallet, and rejects unrelated hashes', async () => {
        const lines = await createLines([{ seller: sellers[0], amount: '4200000' }]);
        const batch = await prepareWithAllowance((await approvedBatch(lines.map(l => l.id))).id);
        const unrelated = await wallet.approve(4_212_600n); // a real tx from the same sender, but not the batch
        await expect(adminClient.query(Q.REPORT_HASH, { batchId: batch.id, txHash: unrelated.hash })).rejects.toThrow(
            /does not match the signing request/,
        );
        // The approve above consumed the pinned nonce, so the wallet sends at its next nonce.
        const sent = await wallet.signAndSend({ ...batch.signingRequest, nonce: null });
        const reported = (await adminClient.query(Q.REPORT_HASH, { batchId: batch.id, txHash: sent.hash })).reportSpraayTransactionHash;
        expect(reported.state).toBe('SUBMITTED');
        expect(reported.auditLog.map((a: any) => a.action)).toContain('NONCE_OVERRIDDEN_BY_WALLET');
        await wallet.mine(CONFIRMATIONS);
        expect((await reconcile(batch.id)).state).toBe('SETTLED');
    });

    it('recovers from a reverted transaction and settles on retry', async () => {
        const lines = await createLines([{ seller: sellers[2], amount: '8000000' }]);
        const batch = await prepareWithAllowance((await approvedBatch(lines.map(l => l.id))).id);
        const balance = await wallet.usdcBalance(merchant.address);
        await wallet.dealUsdc(merchant.address, 0n); // treasury drained between prepare and signing
        const submitted = await submit(batch.id, await wallet.sign(batch.signingRequest));
        expect(submitted.broadcastError).toBeNull();
        await wallet.mine(CONFIRMATIONS);
        const failed = await reconcile(batch.id);
        expect(failed.state).toBe('FAILED');
        expect(failed.attempts[0].state).toBe('REVERTED');
        expect(failed.lines.every((l: any) => l.state === 'BATCHED')).toBe(true); // still locked: no double counting

        await wallet.dealUsdc(merchant.address, balance);
        const retry = await prepareWithAllowance(batch.id);
        expect(retry.attempts).toHaveLength(2);
        await submit(batch.id, await wallet.sign(retry.signingRequest));
        await wallet.mine(CONFIRMATIONS);
        const settled = await reconcile(batch.id);
        expect(settled.state).toBe('SETTLED');
        expect(settled.attempts.map((a: any) => a.state)).toEqual(['REVERTED', 'CONFIRMED']);
    });

    it('only cancels an in-flight batch after its pinned nonce is provably burned', async () => {
        const lines = await createLines([{ seller: sellers[1], amount: '2500000' }]);
        const batch = await prepareWithAllowance((await approvedBatch(lines.map(l => l.id))).id);

        // While it is in flight, the sender is locked for other batches.
        const otherLines = await createLines([{ seller: sellers[0], amount: '1' }]);
        const other = await approvedBatch(otherLines.map(l => l.id));
        await expect(prepare(other.id)).rejects.toThrow(/already has batch .* in flight/);

        // A signed copy may exist somewhere: cancelling now is refused.
        await wallet.sign(batch.signingRequest);
        await expect(adminClient.query(Q.CANCEL, { id: batch.id, reason: 'changed my mind' })).rejects.toThrow(/pinned nonce/);

        const { spraayNonceCancellationRequest: burn } = await adminClient.query(Q.NONCE_CANCELLATION, { batchId: batch.id });
        expect(burn).toMatchObject({ from: merchant.address, to: merchant.address, value: '0', nonce: batch.signingRequest.nonce });
        await wallet.signAndSend(burn);
        await expect(adminClient.query(Q.CANCEL, { id: batch.id, reason: 'changed my mind' })).rejects.toThrow(/pinned nonce/); // not deep yet
        await wallet.mine(CONFIRMATIONS);
        const cancelled = (await adminClient.query(Q.CANCEL, { id: batch.id, reason: 'changed my mind' })).cancelSpraayPayoutBatch;
        expect(cancelled.state).toBe('CANCELLED');
        expect(cancelled.attempts[0].state).toBe('DEAD');
        const { spraayPayoutLines } = await adminClient.query(Q.GET_LINES, { state: 'PENDING' });
        expect(spraayPayoutLines.items.map((l: any) => l.id)).toEqual(expect.arrayContaining(lines.map(l => l.id)));

        // The lock is released: the other batch can now go.
        const otherReady = await prepareWithAllowance(other.id);
        await submit(other.id, await wallet.sign(otherReady.signingRequest));
        await wallet.mine(CONFIRMATIONS);
        expect((await reconcile(other.id)).state).toBe('SETTLED');
    });

    it('detects a duplicate execution (wallet that ignored the pinned nonce) and holds it for review', async () => {
        const lines = await createLines([{ seller: sellers[0], amount: '6000000' }]);
        const batch = await prepareWithAllowance((await approvedBatch(lines.map(l => l.id))).id);
        // Simulate a careless second signing: approve enough for two runs and broadcast a copy at nonce+2.
        await wallet.approve(BigInt(batch.requiredAllowance) * 2n); // takes the pinned nonce N
        const copy = await wallet.signAndSend({ ...batch.signingRequest, nonce: null }); // nonce N+1, unreported
        const sanctioned = await wallet.signAndSend({ ...batch.signingRequest, nonce: null }); // nonce N+2
        expect(parseTransaction(copy.raw).nonce).toBe(batch.signingRequest.nonce + 1);
        await adminClient.query(Q.REPORT_HASH, { batchId: batch.id, txHash: sanctioned.hash });
        await wallet.mine(CONFIRMATIONS);
        const review = await reconcile(batch.id);
        expect(review.state).toBe('NEEDS_REVIEW');
        expect(review.reviewReason).toMatch(/DUPLICATE EXECUTION/);
        expect(review.lines.every((l: any) => l.state === 'BATCHED')).toBe(true);

        await adminClient.asUserWithCredentials('approver@test.dev', 'approver');
        try {
            await expect(
                adminClient.query(Q.RESOLVE, { id: batch.id, resolution: 'MARK_SETTLED', note: 'x', txHash: '0x' + '1'.repeat(64) }),
            ).rejects.toThrow(/not mined/);
            const resolved = (
                await adminClient.query(Q.RESOLVE, {
                    id: batch.id,
                    resolution: 'MARK_SETTLED',
                    note: 'Settled by the reported tx; duplicate recovered from seller off-chain',
                    txHash: sanctioned.hash,
                })
            ).resolveSpraayPayoutBatchReview;
            expect(resolved.state).toBe('SETTLED');
            expect(resolved.lines.every((l: any) => l.state === 'PAID')).toBe(true);
        } finally {
            await adminClient.asSuperAdmin();
        }
    });

    describe('200-recipient limit', () => {
        let many: Array<{ id: string; address: string }> = [];

        beforeAll(async () => {
            for (let i = 0; i < 201; i++) many.push(await createSeller(`Seller ${i}`));
        }, 240_000);

        it('rejects 201 distinct recipients', async () => {
            const lines = await createLines(many.map((s, i) => ({ seller: s, amount: String(1_000_000 + i) })));
            await expect(adminClient.query(Q.CREATE_BATCH, { lineIds: lines.map(l => l.id) })).rejects.toThrow(/at most 200/);
            many = many.slice(0, 200);
            (globalThis as any).__spraayManyLines = lines.slice(0, 200);
        });

        it('settles a full 200-recipient batch with exact per-recipient amounts', async () => {
            const lines = (globalThis as any).__spraayManyLines as Array<{ id: string; amount: string }>;
            const batch = await prepareWithAllowance((await approvedBatch(lines.map(l => l.id))).id);
            expect(batch.recipientCount).toBe(200);
            const result = await submit(batch.id, await wallet.sign(batch.signingRequest));
            expect(result.broadcastError).toBeNull();
            await wallet.mine(CONFIRMATIONS);
            const settled = await reconcile(batch.id);
            expect(settled.state).toBe('SETTLED');
            const balances = await Promise.all(many.map(s => wallet.usdcBalance(s.address)));
            balances.forEach((b, i) => expect(b).toBe(BigInt(1_000_000 + i)));
            const receipt = await wallet.publicClient.getTransactionReceipt({ hash: result.txHash as Hex });
            console.log(`200-recipient batch gas used: ${receipt.gasUsed}`);
        }, 120_000);
    });
});
