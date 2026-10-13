/**
 * Local demonstration: three marketplace sellers paid in ONE Spraay batch on a fork of Base mainnet.
 *
 *   npm run demo                # run the walkthrough and exit
 *   npm run demo -- --keep-alive  # leave Vendure (http://localhost:3000/admin-api), anvil and the gateway running
 *
 * What is real: Vendure + the plugin, the Spraay batch contract 0x1646…5eEC and Circle USDC (both
 * forked from Base mainnet by anvil), every on-chain transfer, receipt and event the plugin verifies.
 * What is simulated: the gateway runs locally (byte-identical responses to the production handler
 * for the two endpoints used) and x402 payment is a placeholder header; the merchant wallet is
 * anvil's public test key. Nothing touches mainnet and no real funds or fees are spent.
 */
import { AutoIncrementIdStrategy, mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import path from 'path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import * as Q from '../e2e/graphql';
import { initialData, MerchantWallet, merchant, startAnvilFork } from '../e2e/helpers';
import { formatUsdc } from '../src/amounts';
import { SPRAAY_BATCH_CONTRACT_BASE } from '../src/constants';
import { SpraayPayoutPlugin } from '../src';

import { simulatedX402Fetch, startLocalGateway } from './local-gateway';

const ANVIL_PORT = 8547;
const GATEWAY_PORT = 4547;
const VENDURE_PORT = 3000;
const CONFIRMATIONS = 3;
const keepAlive = process.argv.includes('--keep-alive');

const step = (n: number, text: string) => console.log(`\n\x1b[1m${n}. ${text}\x1b[0m`);
const info = (text: string) => console.log(`   ${text}`);

async function main() {
    step(1, 'Forking Base mainnet with anvil (real Spraay contract + real USDC)');
    const anvil = await startAnvilFork(ANVIL_PORT);
    const wallet = new MerchantWallet(anvil.rpcUrl);
    const code = await wallet.publicClient.getCode({ address: SPRAAY_BATCH_CONTRACT_BASE });
    info(`Spraay batch contract ${SPRAAY_BATCH_CONTRACT_BASE}: ${(code!.length - 2) / 2} bytes of code on the fork`);
    await wallet.dealUsdc(merchant.address, 10_000_000_000n);
    info(`Merchant treasury ${merchant.address} funded with ${formatUsdc(await wallet.usdcBalance(merchant.address))} USDC (fork only)`);

    step(2, 'Starting the local Spraay gateway stand-in (x402 simulated)');
    const gateway = await startLocalGateway({ port: GATEWAY_PORT, rpcUrl: anvil.rpcUrl });
    info(`http://127.0.0.1:${GATEWAY_PORT} — POST /api/v1/batch/execute, POST /api/v1/batch/estimate`);

    step(3, 'Booting Vendure with SpraayPayoutPlugin');
    registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));
    const config = mergeConfig(testConfig, {
        apiOptions: { port: VENDURE_PORT },
        entityOptions: { entityIdStrategy: new AutoIncrementIdStrategy() },
        plugins: [
            SpraayPayoutPlugin.init({
                rpcUrl: anvil.rpcUrl,
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
    await server.init({ initialData, customerCount: 0 });
    await adminClient.asSuperAdmin();
    info(`Admin API: http://localhost:${VENDURE_PORT}/admin-api (superadmin / superadmin)`);

    step(4, 'Creating three sellers with Base payout addresses, and a second admin who approves payouts');
    const sellers: Array<{ id: string; name: string; address: string }> = [];
    for (const name of ['Acme Ceramics', 'Birch & Co', 'Cobalt Prints']) {
        const address = privateKeyToAccount(generatePrivateKey()).address;
        const { createSeller } = await adminClient.query(Q.CREATE_SELLER, { input: { name, customFields: { spraayPayoutAddress: address } } });
        sellers.push({ id: createSeller.id, name, address });
        info(`${name.padEnd(14)} seller #${createSeller.id}  ${address}`);
    }
    const { createRole } = await adminClient.query(Q.CREATE_ROLE, {
        input: { code: 'payout-approver', description: 'Approves Spraay payouts', permissions: ['ReadSpraayPayouts', 'ApproveSpraayPayouts'] },
    });
    await adminClient.query(Q.CREATE_ADMIN, {
        input: { firstName: 'Ada', lastName: 'Approver', emailAddress: 'approver@demo.dev', password: 'approver', roleIds: [createRole.id] },
    });
    info('approver@demo.dev / approver  (role: ReadSpraayPayouts + ApproveSpraayPayouts)');

    step(5, 'Recording what each seller is owed (raw USDC base units, 6 decimals)');
    const lineInput = [
        { sellerId: sellers[0].id, amount: '12500000', idempotencyKey: 'order-1001', reference: 'Order 1001' },
        { sellerId: sellers[1].id, amount: '7333333', idempotencyKey: 'order-1002', reference: 'Order 1002' },
        { sellerId: sellers[0].id, amount: '4250000', idempotencyKey: 'order-1003', reference: 'Order 1003' },
        { sellerId: sellers[2].id, amount: '99000000', idempotencyKey: 'order-1004', reference: 'Order 1004' },
        { sellerId: sellers[1].id, amount: '666667', idempotencyKey: 'order-1005', reference: 'Order 1005' },
    ];
    const { createSpraayPayoutLines: lines } = await adminClient.query(Q.CREATE_LINES, { input: lineInput });
    for (const l of lines) info(`line #${l.id}  ${l.idempotencyKey}  seller #${l.sellerId}  ${formatUsdc(BigInt(l.amount))} USDC`);
    const { createSpraayPayoutLines: replay } = await adminClient.query(Q.CREATE_LINES, { input: [lineInput[0]] });
    info(`Re-sending order-1001 returns the existing line #${replay[0].id} — no duplicate obligation.`);

    step(6, 'Building ONE batch: lines are aggregated per recipient and locked');
    const { createSpraayPayoutBatch: draft } = await adminClient.query(Q.CREATE_BATCH, { lineIds: lines.map((l: any) => l.id) });
    for (const item of draft.items) {
        const seller = sellers.find(s => s.address.toLowerCase() === item.recipientAddress.toLowerCase())!;
        info(`#${item.position}  ${seller.name.padEnd(14)} ${formatUsdc(BigInt(item.amount)).padStart(10)} USDC  (lines ${item.lineIds.join(', ')})`);
    }
    info(`Total ${draft.totalAmountFormatted} USDC to ${draft.recipientCount} recipients. contentHash ${draft.contentHash}`);

    step(7, 'Approval by a different administrator (four-eyes)');
    try {
        await adminClient.query(Q.APPROVE_BATCH, { id: draft.id, contentHash: draft.contentHash });
    } catch (e: any) {
        info(`Creator tried to self-approve → refused (${e.message.split('\n')[0]})`);
    }
    await adminClient.asUserWithCredentials('approver@demo.dev', 'approver');
    const { approveSpraayPayoutBatch: approved } = await adminClient.query(Q.APPROVE_BATCH, { id: draft.id, contentHash: draft.contentHash });
    await adminClient.asSuperAdmin();
    info(`Approved: state ${approved.state}`);

    step(8, 'Preparing: gateway builds the unsigned tx, plugin verifies it against the approval and the chain');
    let batch = (await adminClient.query(Q.PREPARE_BATCH, { id: draft.id, sender: merchant.address })).prepareSpraayPayoutBatch;
    info(`State ${batch.state}: contract feeBps=${batch.feeBps}, required allowance ${formatUsdc(BigInt(batch.requiredAllowance))} USDC (total + 0.3% fee)`);
    info(`Merchant wallet signs the exact approve(): ${batch.approvalRequest.data.slice(0, 74)}…`);
    await wallet.signAndSend(batch.approvalRequest);
    batch = (await adminClient.query(Q.PREPARE_BATCH, { id: draft.id, sender: merchant.address })).prepareSpraayPayoutBatch;
    const req = batch.signingRequest;
    info(`State ${batch.state}: signing request → to ${req.to}, nonce ${req.nonce} (pinned), gas ${BigInt(req.gas)}`);
    info(`Gateway calls so far: ${gateway.calls.join(', ')} (the verified answer is cached, so retries are not re-billed)`);

    step(9, 'Merchant wallet signs; plugin checks the signed bytes, records the hash, then relays');
    const raw = await wallet.sign(req);
    const submitted = (await adminClient.query(Q.SUBMIT_SIGNED, { batchId: draft.id, signedTransaction: raw })).submitSpraaySignedTransaction;
    info(`tx ${submitted.txHash} → ${submitted.batch.state}`);
    const again = (await adminClient.query(Q.SUBMIT_SIGNED, { batchId: draft.id, signedTransaction: raw })).submitSpraaySignedTransaction;
    info(`Submitting the same bytes again → same hash, still ${again.batch.attempts.length} attempt (idempotent)`);
    try {
        await adminClient.query(Q.PREPARE_BATCH, { id: draft.id, sender: merchant.address });
    } catch (e: any) {
        info(`Trying to prepare it again while in flight → refused (${e.message.split('\n')[0]})`);
    }

    step(10, `Reconciling: waiting for ${CONFIRMATIONS} confirmations, then verifying receipt, calldata, event and transfers`);
    batch = (await adminClient.query(Q.RECONCILE, { id: draft.id })).reconcileSpraayPayoutBatch;
    info(`Right after mining: ${batch.state} (${batch.attempts[0].confirmations} confirmation)`);
    await wallet.mine(CONFIRMATIONS);
    batch = (await adminClient.query(Q.RECONCILE, { id: draft.id })).reconcileSpraayPayoutBatch;
    info(`After ${CONFIRMATIONS} more blocks: ${batch.state}  settledTxHash ${batch.settledTxHash}  fee ${formatUsdc(BigInt(batch.settledFeeAmount))} USDC`);
    info(`Lines: ${batch.lines.map((l: any) => `#${l.id} ${l.state}`).join(', ')}`);

    step(11, 'On-chain balances (read straight from USDC on the fork)');
    for (const s of sellers) info(`${s.name.padEnd(14)} ${formatUsdc(await wallet.usdcBalance(s.address)).padStart(10)} USDC`);
    info(`Leftover allowance: ${await wallet.allowance()} (exact approval was fully consumed)`);

    step(12, 'Audit trail');
    for (const entry of batch.auditLog) info(entry.action);

    if (keepAlive) {
        console.log(`\nStill running. Admin API http://localhost:${VENDURE_PORT}/admin-api — Ctrl+C to stop.`);
        await new Promise(() => undefined);
    }
    await server.destroy();
    await gateway.close();
    anvil.stop();
    console.log('\nDemo complete.');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
