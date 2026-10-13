import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
    EntityNotFoundError,
    ForbiddenError,
    ID,
    IllegalOperationError,
    Logger,
    RequestContext,
    Seller,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { In } from 'typeorm';

import { formatUsdc, normalizeAddress, parseRawAmount, sameAddress, SpraayValidationError } from '../amounts';
import { computeContentHash, planBatch } from '../batch-plan';
import { encodeApproveCalldata, ExpectedTransfer } from '../chain/calldata';
import { assertBaseChain, SpraayChainReader, ViemChainReader } from '../chain/chain-reader';
import { inspectSignedTransaction, SigningRequest } from '../chain/signed-transaction';
import { verifySettlement } from '../chain/verify-settlement';
import {
    BASE_CHAIN_ID,
    DEFAULT_LOG_SCAN_CHUNK_SIZE,
    DEFAULT_REQUIRED_CONFIRMATIONS,
    LOCAL_GAS_ESTIMATE_PADDING_PERCENT,
    loggerCtx,
    SPRAAY_BATCH_CONTRACT_BASE,
    SPRAAY_PLUGIN_OPTIONS,
    USDC_BASE,
} from '../constants';
import {
    SpraayPayoutAttempt,
    SpraayPayoutAttemptState,
    SpraayPayoutAuditEntry,
    SpraayPayoutBatch,
    SpraayPayoutBatchItem,
    SpraayPayoutBatchState,
    SpraaySenderLock,
} from '../entities/spraay-payout-batch.entity';
import { SpraayPayoutLine, SpraayPayoutLineState } from '../entities/spraay-payout-line.entity';
import { SpraayGatewayClient } from '../gateway/spraay-gateway.client';
import { verifyExecuteResponse } from '../gateway/verify-gateway-response';
import { SpraayPayoutPluginOptions } from '../types';

export interface CreatePayoutLineInput {
    sellerId: ID;
    amount: string;
    idempotencyKey: string;
    reference?: string | null;
    memo?: string | null;
}

export interface TransactionRequest {
    from: string;
    to: string;
    data: string;
    value: string;
    chainId: number;
    nonce?: number | null;
    gas?: string | null;
}

export enum SpraayReviewResolution {
    MARK_SETTLED = 'MARK_SETTLED',
    MARK_FAILED = 'MARK_FAILED',
}

const LIVE_ATTEMPT_STATES = [SpraayPayoutAttemptState.PREPARED, SpraayPayoutAttemptState.SUBMITTED];
const IN_FLIGHT_BATCH_STATES = [SpraayPayoutBatchState.AWAITING_SIGNATURE, SpraayPayoutBatchState.SUBMITTED];
const PREPARABLE_BATCH_STATES = [
    SpraayPayoutBatchState.APPROVED,
    SpraayPayoutBatchState.AWAITING_ALLOWANCE,
    SpraayPayoutBatchState.FAILED,
];
const CANCELLABLE_BATCH_STATES = [
    SpraayPayoutBatchState.DRAFT,
    SpraayPayoutBatchState.APPROVED,
    SpraayPayoutBatchState.AWAITING_ALLOWANCE,
    SpraayPayoutBatchState.FAILED,
];

export const SELLER_PAYOUT_ADDRESS_FIELD = 'spraayPayoutAddress';

/**
 * The payout state machine.
 *
 * Nothing in here signs a transaction or reacts to order events. Money only moves when an
 * administrator approves a batch and the merchant's own wallet signs the exact transaction
 * the plugin verified. Every state change is a compare-and-set on the current state, so
 * concurrent requests (two admins, the scheduler and an admin) cannot double-advance a batch.
 */
@Injectable()
export class SpraayPayoutService implements OnApplicationBootstrap {
    private reader: SpraayChainReader;
    private gateway: SpraayGatewayClient;
    private readonly requiredConfirmations: number;
    private readonly allowedSenders: string[];

    constructor(
        private connection: TransactionalConnection,
        @Inject(SPRAAY_PLUGIN_OPTIONS) private options: SpraayPayoutPluginOptions,
    ) {
        this.requiredConfirmations = Math.max(1, options.requiredConfirmations ?? DEFAULT_REQUIRED_CONFIRMATIONS);
        this.allowedSenders = (options.allowedSenders ?? []).map(a => normalizeAddress(a, 'allowedSenders entry'));
    }

    onApplicationBootstrap() {
        this.reader =
            this.options.chainReader ??
            new ViemChainReader(this.options.rpcUrl, BigInt(this.options.logScanChunkSize ?? DEFAULT_LOG_SCAN_CHUNK_SIZE));
        this.gateway = new SpraayGatewayClient({
            baseUrl: this.options.gatewayUrl,
            fetch: this.options.gatewayFetch,
            timeoutMs: this.options.gatewayTimeoutMs,
            headers: this.options.gatewayHeaders,
        });
    }

    getConfig() {
        return {
            chainId: BASE_CHAIN_ID,
            contractAddress: SPRAAY_BATCH_CONTRACT_BASE,
            tokenAddress: USDC_BASE,
            tokenSymbol: 'USDC',
            tokenDecimals: 6,
            allowedSenders: this.allowedSenders,
            requiredConfirmations: this.requiredConfirmations,
            requireDistinctApprover: !!this.options.requireDistinctApprover,
            maxRecipientsPerBatch: 200,
        };
    }

    // ------------------------------------------------------------------ lines

    async createLines(ctx: RequestContext, inputs: CreatePayoutLineInput[]): Promise<SpraayPayoutLine[]> {
        const repo = this.connection.getRepository(ctx, SpraayPayoutLine);
        const maxLine = this.options.maxLineAmount ? parseRawAmount(this.options.maxLineAmount, 'maxLineAmount') : undefined;
        const seenKeys = new Set<string>();
        const result: SpraayPayoutLine[] = [];
        for (const input of inputs) {
            const key = (input.idempotencyKey ?? '').trim();
            if (!key || key.length > 191) {
                throw new UserInputError('idempotencyKey is required and must be at most 191 characters');
            }
            if (seenKeys.has(key)) {
                throw new UserInputError(`idempotencyKey "${key}" appears twice in the same request`);
            }
            seenKeys.add(key);
            const amount = this.wrapValidation(() => parseRawAmount(input.amount, `amount for "${key}"`));
            if (maxLine !== undefined && amount > maxLine) {
                throw new UserInputError(`amount for "${key}" exceeds maxLineAmount (${formatUsdc(maxLine)} USDC)`);
            }
            const existing = await repo.findOne({ where: { idempotencyKey: key } });
            if (existing) {
                if (String(existing.sellerId) === String(input.sellerId) && existing.amount === amount.toString()) {
                    result.push(existing); // idempotent replay
                    continue;
                }
                throw new UserInputError(
                    `idempotencyKey "${key}" already records a different payout (seller ${existing.sellerId}, amount ${existing.amount})`,
                );
            }
            const seller = await this.connection.getRepository(ctx, Seller).findOne({ where: { id: input.sellerId } });
            if (!seller || seller.deletedAt) {
                throw new EntityNotFoundError('Seller', input.sellerId);
            }
            const line = await repo.save(
                new SpraayPayoutLine({
                    idempotencyKey: key,
                    sellerId: seller.id,
                    amount: amount.toString(),
                    state: SpraayPayoutLineState.PENDING,
                    reference: input.reference ?? null,
                    memo: input.memo ?? null,
                    batchId: null,
                    createdByUserId: ctx.activeUserId ?? null,
                }),
            );
            result.push(line);
        }
        await this.audit(ctx, null, 'LINES_CREATED', { lineIds: result.map(l => String(l.id)) });
        return result;
    }

    async voidLine(ctx: RequestContext, lineId: ID, reason: string): Promise<SpraayPayoutLine> {
        const repo = this.connection.getRepository(ctx, SpraayPayoutLine);
        const res = await repo.update(
            { id: lineId, state: SpraayPayoutLineState.PENDING },
            { state: SpraayPayoutLineState.VOIDED, memo: reason },
        );
        if (res.affected !== 1) {
            throw new IllegalOperationError('Only PENDING payout lines can be voided');
        }
        await this.audit(ctx, null, 'LINE_VOIDED', { lineId: String(lineId), reason });
        return repo.findOneOrFail({ where: { id: lineId } });
    }

    findLines(ctx: RequestContext, opts: { state?: SpraayPayoutLineState; sellerId?: ID; batchId?: ID; take?: number; skip?: number }) {
        const where: Record<string, unknown> = {};
        if (opts.state) where.state = opts.state;
        if (opts.sellerId) where.sellerId = opts.sellerId;
        if (opts.batchId) where.batchId = opts.batchId;
        return this.connection.getRepository(ctx, SpraayPayoutLine).findAndCount({
            where,
            order: { id: 'ASC' },
            take: Math.min(opts.take ?? 100, 1000),
            skip: opts.skip ?? 0,
        });
    }

    // ---------------------------------------------------------------- batches

    async createBatch(ctx: RequestContext, lineIds: ID[]): Promise<SpraayPayoutBatch> {
        if (!lineIds.length) {
            throw new UserInputError('lineIds must not be empty');
        }
        const lineRepo = this.connection.getRepository(ctx, SpraayPayoutLine);
        const lines = await lineRepo.find({ where: { id: In(lineIds) } });
        if (lines.length !== new Set(lineIds.map(String)).size) {
            throw new UserInputError('Some payout lines do not exist');
        }
        const notPending = lines.filter(l => l.state !== SpraayPayoutLineState.PENDING);
        if (notPending.length) {
            throw new IllegalOperationError(
                `Payout lines must be PENDING to be batched: ${notPending.map(l => `${l.id}(${l.state})`).join(', ')}`,
            );
        }
        const sellerIds = [...new Set(lines.map(l => String(l.sellerId)))];
        const sellers = await this.connection.getRepository(ctx, Seller).find({ where: { id: In(sellerIds) } });
        const addressBySeller = new Map<string, string>();
        for (const seller of sellers) {
            const address = (seller.customFields as any)?.[SELLER_PAYOUT_ADDRESS_FIELD];
            if (!address) {
                throw new UserInputError(`Seller ${seller.id} ("${seller.name}") has no Spraay payout address`);
            }
            addressBySeller.set(String(seller.id), address);
        }
        const plan = this.wrapValidation(() =>
            planBatch(
                lines.map(l => ({
                    id: String(l.id),
                    sellerId: String(l.sellerId),
                    recipientAddress: addressBySeller.get(String(l.sellerId)) ?? '',
                    amount: BigInt(l.amount),
                })),
            ),
        );
        if (this.options.maxBatchTotal && plan.totalAmount > parseRawAmount(this.options.maxBatchTotal, 'maxBatchTotal')) {
            throw new UserInputError(`Batch total ${formatUsdc(plan.totalAmount)} USDC exceeds maxBatchTotal`);
        }
        const batch = await this.connection.getRepository(ctx, SpraayPayoutBatch).save(
            new SpraayPayoutBatch({
                state: SpraayPayoutBatchState.DRAFT,
                totalAmount: plan.totalAmount.toString(),
                recipientCount: plan.items.length,
                contentHash: plan.contentHash,
                createdByUserId: ctx.activeUserId ?? null,
                items: plan.items.map(
                    (item, position) =>
                        new SpraayPayoutBatchItem({
                            position,
                            recipientAddress: item.recipient,
                            amount: item.amount.toString(),
                            lineIds: item.lineIds,
                            sellerIds: item.sellerIds,
                        }),
                ),
            }),
        );
        // Lock the lines into this batch. The state predicate makes this a compare-and-set:
        // a line concurrently claimed by another batch makes the count differ and the transaction roll back.
        const locked = await lineRepo.update(
            { id: In(lines.map(l => l.id)), state: SpraayPayoutLineState.PENDING },
            { state: SpraayPayoutLineState.BATCHED, batchId: batch.id },
        );
        if (locked.affected !== lines.length) {
            throw new IllegalOperationError('Some payout lines were batched concurrently; nothing was changed');
        }
        await this.audit(ctx, batch.id, 'BATCH_CREATED', {
            lineIds: lines.map(l => String(l.id)),
            totalAmount: plan.totalAmount.toString(),
            contentHash: plan.contentHash,
        });
        return this.getBatch(ctx, batch.id);
    }

    async approveBatch(ctx: RequestContext, batchId: ID, contentHash: string): Promise<SpraayPayoutBatch> {
        const batch = await this.getBatch(ctx, batchId);
        if (batch.state !== SpraayPayoutBatchState.DRAFT) {
            throw new IllegalOperationError(`Only DRAFT batches can be approved (batch is ${batch.state})`);
        }
        this.assertIntegrity(batch);
        if (contentHash.toLowerCase() !== batch.contentHash.toLowerCase()) {
            throw new UserInputError('contentHash does not match the batch; review the current batch content and approve again');
        }
        if (
            this.options.requireDistinctApprover &&
            batch.createdByUserId != null &&
            String(batch.createdByUserId) === String(ctx.activeUserId)
        ) {
            throw new ForbiddenError();
        }
        await this.transition(ctx, batchId, [SpraayPayoutBatchState.DRAFT], SpraayPayoutBatchState.APPROVED, {
            approvedByUserId: ctx.activeUserId ?? null,
            approvedAt: new Date(),
        });
        await this.audit(ctx, batchId, 'BATCH_APPROVED', { contentHash: batch.contentHash });
        return this.getBatch(ctx, batchId);
    }

    /** Paid gateway call (POST /api/v1/batch/estimate). Informational only. */
    async estimateBatch(ctx: RequestContext, batchId: ID, sender: string): Promise<SpraayPayoutBatch> {
        const batch = await this.getBatch(ctx, batchId);
        const from = this.assertAllowedSender(sender);
        const items = this.expectedTransfers(batch);
        const estimate = await this.gateway.estimate({
            recipients: items.map(i => i.recipient),
            amounts: items.map(i => i.amount.toString()),
            sender: from,
        });
        await this.connection
            .getRepository(ctx, SpraayPayoutBatch)
            .update({ id: batchId }, { gatewayEstimate: estimate as any });
        await this.audit(ctx, batchId, 'GATEWAY_ESTIMATE', { estimate });
        return this.getBatch(ctx, batchId);
    }

    /**
     * Turns an approved batch into a signing request for the merchant's wallet:
     *  1. calls the gateway (POST /api/v1/batch/execute) — or reuses its verified, cached answer,
     *  2. verifies the unsigned transaction against the approved content and on-chain fee rate,
     *  3. checks balance, allowance and simulates the call from the sender,
     *  4. pins the sender's next nonce and takes the per-sender lock.
     */
    async prepareBatch(ctx: RequestContext, batchId: ID, sender: string): Promise<SpraayPayoutBatch> {
        const from = this.assertAllowedSender(sender);
        let batch = await this.getBatch(ctx, batchId);
        if (!PREPARABLE_BATCH_STATES.includes(batch.state)) {
            throw new IllegalOperationError(`Batch in state ${batch.state} cannot be prepared`);
        }
        this.assertIntegrity(batch);
        const items = this.expectedTransfers(batch);

        await assertBaseChain(this.reader);
        const code = await this.reader.getCode(SPRAAY_BATCH_CONTRACT_BASE);
        if (!code || code === '0x') {
            throw new IllegalOperationError('The Spraay batch contract has no code on this RPC; refusing to continue');
        }
        if (await this.reader.isPaused()) {
            throw new IllegalOperationError('The Spraay batch contract is paused');
        }
        const feeBps = await this.reader.getFeeBps();

        const canReuse =
            batch.verifiedCalldata &&
            batch.feeBps === feeBps.toString() &&
            sameAddress(batch.sender, from) &&
            batch.requiredAllowance &&
            batch.gatewayGasLimit;
        if (!canReuse) {
            const response = await this.gateway.execute({
                recipients: items.map(i => i.recipient),
                amounts: items.map(i => i.amount.toString()),
                sender: from,
            });
            let verified;
            try {
                verified = verifyExecuteResponse(response, { items, feeBps });
            } catch (e: any) {
                await this.audit(ctx, batchId, 'GATEWAY_RESPONSE_REJECTED', { problems: e?.problems ?? [String(e)] });
                throw new IllegalOperationError(e.message);
            }
            await this.connection.getRepository(ctx, SpraayPayoutBatch).update(
                { id: batchId },
                {
                    sender: from,
                    feeBps: feeBps.toString(),
                    verifiedCalldata: verified.calldata,
                    gatewayGasLimit: verified.gatewayGasLimit.toString(),
                    requiredAllowance: verified.approvalAmount.toString(),
                },
            );
            await this.audit(ctx, batchId, 'GATEWAY_EXECUTE_VERIFIED', {
                sender: from,
                feeBps: feeBps.toString(),
                requiredAllowance: verified.approvalAmount.toString(),
                gatewayGasLimit: verified.gatewayGasLimit.toString(),
            });
            batch = await this.getBatch(ctx, batchId);
        }
        const required = BigInt(batch.requiredAllowance!);
        const calldata = batch.verifiedCalldata!;

        const balance = await this.reader.getUsdcBalance(from);
        if (balance < required) {
            throw new IllegalOperationError(
                `Sender ${from} holds ${formatUsdc(balance)} USDC but the batch needs ${formatUsdc(required)} USDC (including the protocol fee)`,
            );
        }
        const allowance = await this.reader.getUsdcAllowance(from);
        if (allowance < required) {
            if (batch.state !== SpraayPayoutBatchState.AWAITING_ALLOWANCE) {
                await this.transition(ctx, batchId, PREPARABLE_BATCH_STATES, SpraayPayoutBatchState.AWAITING_ALLOWANCE);
            }
            await this.audit(ctx, batchId, 'AWAITING_ALLOWANCE', {
                allowance: allowance.toString(),
                required: required.toString(),
            });
            return this.getBatch(ctx, batchId);
        }

        const simulationError = await this.reader.simulate({ from, to: SPRAAY_BATCH_CONTRACT_BASE, data: calldata });
        if (simulationError) {
            throw new IllegalOperationError(`Simulating the batch from ${from} failed: ${simulationError}`);
        }
        let gas = BigInt(batch.gatewayGasLimit!);
        try {
            const local = await this.reader.estimateGas({ from, to: SPRAAY_BATCH_CONTRACT_BASE, data: calldata });
            const padded = (local * BigInt(LOCAL_GAS_ESTIMATE_PADDING_PERCENT)) / 100n;
            if (padded > gas) gas = padded;
        } catch {
            // keep the gateway's limit
        }
        const nonce = await this.reader.getTransactionCount(from, 'pending');
        const preparedAtBlock = await this.reader.getBlockNumber();
        const signingRequest: SigningRequest = {
            from,
            to: SPRAAY_BATCH_CONTRACT_BASE,
            data: calldata,
            value: '0',
            chainId: BASE_CHAIN_ID,
            nonce,
            gas: '0x' + gas.toString(16),
        };

        let attempt!: SpraayPayoutAttempt;
        await this.connection.withTransaction(ctx, async txCtx => {
            const lockRepo = this.connection.getRepository(txCtx, SpraaySenderLock);
            const existingLock = await lockRepo.findOne({ where: { sender: from.toLowerCase() } });
            if (existingLock) {
                throw new IllegalOperationError(
                    `Sender ${from} already has batch ${existingLock.batchId} in flight; finish or recover it first`,
                );
            }
            await lockRepo.save(new SpraaySenderLock({ sender: from.toLowerCase(), batchId }));
            await this.transition(txCtx, batchId, PREPARABLE_BATCH_STATES, SpraayPayoutBatchState.AWAITING_SIGNATURE, {
                sender: from,
            });
            attempt = await this.connection.getRepository(txCtx, SpraayPayoutAttempt).save(
                new SpraayPayoutAttempt({
                    batchId,
                    state: SpraayPayoutAttemptState.PREPARED,
                    sender: from,
                    nonce,
                    preparedAtBlock: preparedAtBlock.toString(),
                    signingRequest,
                    txHashes: [],
                    signedTransaction: null,
                    minedTxHash: null,
                    minedBlockNumber: null,
                    confirmations: 0,
                    lastCheckedAt: null,
                    note: null,
                }),
            );
        });
        await this.audit(ctx, batchId, 'SIGNING_REQUEST_ISSUED', {
            attemptId: String(attempt.id),
            nonce,
            gas: signingRequest.gas,
            preparedAtBlock: preparedAtBlock.toString(),
        });
        return this.getBatch(ctx, batchId);
    }

    /** The ERC-20 approve() the sender must sign while the batch is AWAITING_ALLOWANCE. */
    approvalRequestFor(batch: SpraayPayoutBatch): TransactionRequest | null {
        if (batch.state !== SpraayPayoutBatchState.AWAITING_ALLOWANCE || !batch.sender || !batch.requiredAllowance) {
            return null;
        }
        return {
            from: batch.sender,
            to: USDC_BASE,
            data: encodeApproveCalldata(SPRAAY_BATCH_CONTRACT_BASE, BigInt(batch.requiredAllowance)),
            value: '0',
            chainId: BASE_CHAIN_ID,
            nonce: null,
            gas: null,
        };
    }

    /**
     * Accepts the merchant-signed raw transaction, proves it is byte-for-byte the requested one,
     * records its hash durably, and only then relays it. If relaying fails the hash is already
     * known, so reconciliation (or a rebroadcast) can continue safely.
     */
    async submitSignedTransaction(ctx: RequestContext, batchId: ID, signedTransaction: string) {
        const { attempt } = await this.getLiveAttempt(ctx, batchId);
        const inspected = await inspectSignedTransaction(signedTransaction, attempt.signingRequest);
        if (!inspected.ok) {
            await this.audit(ctx, batchId, 'SIGNED_TX_REJECTED', { problems: inspected.problems });
            throw new UserInputError(`Signed transaction rejected: ${inspected.problems.join('; ')}`);
        }
        await this.connection.withTransaction(ctx, async txCtx => {
            await this.recordHash(txCtx, batchId, attempt.id, inspected.tx.hash, signedTransaction);
        });
        const broadcastError = await this.broadcast(signedTransaction);
        await this.audit(ctx, batchId, 'SIGNED_TX_RELAYED', {
            attemptId: String(attempt.id),
            txHash: inspected.tx.hash,
            broadcastError: broadcastError ?? null,
        });
        return { batch: await this.getBatch(ctx, batchId), txHash: inspected.tx.hash, broadcastError };
    }

    /** For wallets that broadcast themselves (e.g. a browser wallet): record and verify the hash. */
    async reportTransactionHash(ctx: RequestContext, batchId: ID, txHash: string): Promise<SpraayPayoutBatch> {
        if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
            throw new UserInputError('txHash must be a 32-byte 0x-prefixed hex string');
        }
        const { attempt } = await this.getLiveAttempt(ctx, batchId);
        const tx = await this.reader.getTransaction(txHash);
        if (!tx) {
            throw new UserInputError(`Transaction ${txHash} is not known to the RPC node yet; retry once it is broadcast`);
        }
        const request = attempt.signingRequest;
        const problems: string[] = [];
        if (!sameAddress(tx.from, request.from)) problems.push(`from ${tx.from} != ${request.from}`);
        if (!sameAddress(tx.to, request.to)) problems.push(`to ${tx.to} != ${request.to}`);
        if (tx.input.toLowerCase() !== request.data.toLowerCase()) problems.push('calldata differs from the signing request');
        if (tx.value !== 0n) problems.push(`value ${tx.value} != 0`);
        if (tx.chainId != null && tx.chainId !== BASE_CHAIN_ID) problems.push(`chainId ${tx.chainId} != ${BASE_CHAIN_ID}`);
        if (problems.length) {
            await this.audit(ctx, batchId, 'REPORTED_TX_REJECTED', { txHash, problems });
            throw new UserInputError(`Transaction ${txHash} does not match the signing request: ${problems.join('; ')}`);
        }
        await this.connection.withTransaction(ctx, async txCtx => {
            if (tx.nonce !== attempt.nonce) {
                // The wallet ignored the pinned nonce. Track the nonce actually used so that
                // dead-attempt detection keys off the transaction that really exists.
                await this.connection
                    .getRepository(txCtx, SpraayPayoutAttempt)
                    .update({ id: attempt.id }, { nonce: tx.nonce, note: `wallet used nonce ${tx.nonce} instead of pinned ${attempt.nonce}` });
                await this.audit(txCtx, batchId, 'NONCE_OVERRIDDEN_BY_WALLET', { pinned: attempt.nonce, used: tx.nonce });
            }
            await this.recordHash(txCtx, batchId, attempt.id, tx.hash, null);
        });
        return this.getBatch(ctx, batchId);
    }

    async rebroadcast(ctx: RequestContext, batchId: ID) {
        const { attempt } = await this.getLiveAttempt(ctx, batchId);
        if (!attempt.signedTransaction) {
            throw new IllegalOperationError('No signed transaction stored for this attempt; rebroadcast from the wallet');
        }
        const broadcastError = await this.broadcast(attempt.signedTransaction);
        await this.audit(ctx, batchId, 'REBROADCAST', { broadcastError: broadcastError ?? null });
        return { batch: await this.getBatch(ctx, batchId), txHash: attempt.txHashes[attempt.txHashes.length - 1], broadcastError };
    }

    /**
     * A 0-value self-transfer at the pinned nonce. Once mined it makes every signed copy of the
     * batch transaction permanently invalid, which is what allows a stuck batch to be cancelled.
     */
    async nonceCancellationRequest(ctx: RequestContext, batchId: ID): Promise<TransactionRequest> {
        const { attempt } = await this.getLiveAttempt(ctx, batchId);
        return {
            from: attempt.sender,
            to: attempt.sender,
            data: '0x',
            value: '0',
            chainId: BASE_CHAIN_ID,
            nonce: attempt.nonce,
            gas: '0x5208',
        };
    }

    async cancelBatch(ctx: RequestContext, batchId: ID, reason: string): Promise<SpraayPayoutBatch> {
        if (!reason?.trim()) {
            throw new UserInputError('A cancellation reason is required');
        }
        let batch = await this.getBatch(ctx, batchId);
        if (IN_FLIGHT_BATCH_STATES.includes(batch.state)) {
            // Only cancellable once reconciliation proves the live attempt can never execute.
            batch = await this.reconcileBatch(ctx, batchId);
            if (IN_FLIGHT_BATCH_STATES.includes(batch.state)) {
                throw new IllegalOperationError(
                    `Batch ${batchId} has a signing request with pinned nonce that may still be executed. ` +
                        'Either wait for it to settle, or sign the nonce-cancellation transaction ' +
                        '(spraayNonceCancellationRequest), wait for confirmations, then cancel again.',
                );
            }
        }
        if (!CANCELLABLE_BATCH_STATES.includes(batch.state)) {
            throw new IllegalOperationError(`Batch in state ${batch.state} cannot be cancelled`);
        }
        await this.connection.withTransaction(ctx, async txCtx => {
            await this.transition(txCtx, batchId, CANCELLABLE_BATCH_STATES, SpraayPayoutBatchState.CANCELLED, {
                cancelReason: reason,
            });
            await this.connection
                .getRepository(txCtx, SpraayPayoutLine)
                .update(
                    { batchId, state: SpraayPayoutLineState.BATCHED },
                    { state: SpraayPayoutLineState.PENDING, batchId: null },
                );
            await this.audit(txCtx, batchId, 'BATCH_CANCELLED', { reason });
        });
        return this.getBatch(ctx, batchId);
    }

    // ---------------------------------------------------------- reconciliation

    async reconcileInFlight(ctx: RequestContext): Promise<{ checked: number; errors: number }> {
        const batches = await this.connection
            .getRepository(ctx, SpraayPayoutBatch)
            .find({ where: { state: In(IN_FLIGHT_BATCH_STATES) }, select: ['id'] });
        let errors = 0;
        for (const { id } of batches) {
            try {
                await this.reconcileBatch(ctx, id);
            } catch (e: any) {
                errors++;
                Logger.error(`Reconciling Spraay batch ${id} failed: ${e?.message ?? e}`, loggerCtx);
            }
        }
        return { checked: batches.length, errors };
    }

    /**
     * Idempotent. Reads chain state and moves an in-flight batch forward only when the evidence is
     * conclusive; otherwise it leaves the batch where it is. Never initiates a payment.
     */
    async reconcileBatch(ctx: RequestContext, batchId: ID): Promise<SpraayPayoutBatch> {
        const batch = await this.getBatch(ctx, batchId);
        if (!IN_FLIGHT_BATCH_STATES.includes(batch.state)) {
            return batch;
        }
        const attempt = this.liveAttemptOf(batch);
        if (!attempt) {
            await this.flagForReview(ctx, batch, 'In-flight batch has no live attempt');
            return this.getBatch(ctx, batchId);
        }
        const items = this.expectedTransfers(batch);
        const head = await this.reader.getBlockNumber();
        const attemptRepo = this.connection.getRepository(ctx, SpraayPayoutAttempt);

        // 1. Did any hash we know of get mined?
        let mined: { hash: string; receipt: NonNullable<Awaited<ReturnType<SpraayChainReader['getTransactionReceipt']>>> } | undefined;
        for (const hash of attempt.txHashes) {
            const receipt = await this.reader.getTransactionReceipt(hash);
            if (receipt) {
                mined = { hash, receipt };
                break;
            }
        }

        // 2. If not, was the nonce consumed by something we have not been told about?
        if (!mined) {
            const confirmedHead = head - BigInt(this.requiredConfirmations) + 1n;
            const consumedNonce =
                confirmedHead > 0n ? await this.reader.getTransactionCount(attempt.sender, confirmedHead) : 0;
            const consumedOrPending = await this.reader.getTransactionCount(attempt.sender, 'latest');
            if (consumedOrPending > attempt.nonce) {
                const replacement = await this.findMatchingExecution(ctx, attempt, items, head, []);
                if (replacement) {
                    mined = replacement;
                    await this.audit(ctx, batchId, 'REPLACEMENT_DETECTED', { txHash: replacement.hash });
                } else if (consumedNonce > attempt.nonce && !(await this.anyHashStillPending(attempt))) {
                    await this.connection.withTransaction(ctx, async txCtx => {
                        await this.connection.getRepository(txCtx, SpraayPayoutAttempt).update(
                            { id: attempt.id },
                            {
                                state: SpraayPayoutAttemptState.DEAD,
                                lastCheckedAt: new Date(),
                                note: `nonce ${attempt.nonce} consumed by another transaction; no matching execution since block ${attempt.preparedAtBlock}`,
                            },
                        );
                        await this.releaseSenderLock(txCtx, batchId);
                        await this.transition(txCtx, batchId, IN_FLIGHT_BATCH_STATES, SpraayPayoutBatchState.FAILED);
                        await this.audit(txCtx, batchId, 'ATTEMPT_DEAD', { attemptId: String(attempt.id), nonce: attempt.nonce });
                    });
                    return this.getBatch(ctx, batchId);
                }
            }
            if (!mined) {
                await attemptRepo.update({ id: attempt.id }, { lastCheckedAt: new Date() });
                return this.getBatch(ctx, batchId);
            }
        }

        // 3. A transaction is mined. Verify it and wait for depth.
        const confirmations = Number(head - mined.receipt.blockNumber + 1n);
        if (mined.receipt.status === 'reverted') {
            await attemptRepo.update(
                { id: attempt.id },
                {
                    minedTxHash: mined.hash,
                    minedBlockNumber: mined.receipt.blockNumber.toString(),
                    confirmations,
                    lastCheckedAt: new Date(),
                },
            );
            if (confirmations >= this.requiredConfirmations) {
                await this.connection.withTransaction(ctx, async txCtx => {
                    await this.connection
                        .getRepository(txCtx, SpraayPayoutAttempt)
                        .update({ id: attempt.id }, { state: SpraayPayoutAttemptState.REVERTED, note: 'transaction reverted; no funds moved' });
                    await this.releaseSenderLock(txCtx, batchId);
                    await this.transition(txCtx, batchId, IN_FLIGHT_BATCH_STATES, SpraayPayoutBatchState.FAILED);
                    await this.audit(txCtx, batchId, 'ATTEMPT_REVERTED', { txHash: mined!.hash });
                });
            }
            return this.getBatch(ctx, batchId);
        }

        const tx = await this.reader.getTransaction(mined.hash);
        const verification = tx
            ? verifySettlement({ tx, receipt: mined.receipt, sender: attempt.sender, items })
            : ({ ok: false, kind: 'mismatch', problems: ['mined transaction body not available'] } as const);
        if (!verification.ok) {
            await this.connection.withTransaction(ctx, async txCtx => {
                await this.connection.getRepository(txCtx, SpraayPayoutAttempt).update(
                    { id: attempt.id },
                    {
                        state: SpraayPayoutAttemptState.ANOMALOUS,
                        minedTxHash: mined!.hash,
                        minedBlockNumber: mined!.receipt.blockNumber.toString(),
                        confirmations,
                        note: verification.problems.join('; '),
                    },
                );
                await this.releaseSenderLock(txCtx, batchId);
                await this.flagForReview(txCtx, batch, `Mined transaction ${mined!.hash} failed verification: ${verification.problems.join('; ')}`);
            });
            return this.getBatch(ctx, batchId);
        }

        if (!attempt.txHashes.includes(mined.hash.toLowerCase())) {
            // Also moves AWAITING_SIGNATURE → SUBMITTED.
            await this.recordHash(ctx, batchId, attempt.id, mined.hash, null);
        }
        await attemptRepo.update(
            { id: attempt.id },
            {
                minedTxHash: mined.hash,
                minedBlockNumber: mined.receipt.blockNumber.toString(),
                confirmations,
                lastCheckedAt: new Date(),
            },
        );
        if (confirmations < this.requiredConfirmations) {
            return this.getBatch(ctx, batchId);
        }

        // 4. Before settling, make sure this batch was not executed more than once (e.g. by a
        //    signed copy of an older attempt from a wallet that ignored the pinned nonce).
        const duplicate = await this.findMatchingExecution(ctx, attempt, items, head, [mined.hash], this.earliestPreparedBlock(batch));
        if (duplicate) {
            await this.connection.withTransaction(ctx, async txCtx => {
                await this.connection
                    .getRepository(txCtx, SpraayPayoutAttempt)
                    .update({ id: attempt.id }, { state: SpraayPayoutAttemptState.ANOMALOUS, note: `duplicate execution ${duplicate.hash}` });
                await this.releaseSenderLock(txCtx, batchId);
                await this.flagForReview(
                    txCtx,
                    batch,
                    `DUPLICATE EXECUTION: both ${mined!.hash} and ${duplicate.hash} paid this batch. Recover the excess off-chain, then resolve.`,
                );
            });
            return this.getBatch(ctx, batchId);
        }

        await this.connection.withTransaction(ctx, async txCtx => {
            await this.settle(txCtx, batch, attempt.id, mined!.hash, mined!.receipt.blockNumber, verification.feeAmount);
        });
        return this.getBatch(ctx, batchId);
    }

    /**
     * Human decision for a NEEDS_REVIEW batch. MARK_SETTLED requires a transaction that passes
     * full verification; MARK_FAILED returns the batch to FAILED so it can be retried or cancelled.
     */
    async resolveReview(
        ctx: RequestContext,
        batchId: ID,
        resolution: SpraayReviewResolution,
        note: string,
        txHash?: string | null,
    ): Promise<SpraayPayoutBatch> {
        if (!note?.trim()) {
            throw new UserInputError('A note explaining the resolution is required');
        }
        const batch = await this.getBatch(ctx, batchId);
        if (batch.state !== SpraayPayoutBatchState.NEEDS_REVIEW) {
            throw new IllegalOperationError('Only NEEDS_REVIEW batches can be resolved');
        }
        if (resolution === SpraayReviewResolution.MARK_SETTLED) {
            if (!txHash) {
                throw new UserInputError('txHash is required to mark a batch settled');
            }
            const sender = batch.sender;
            const [tx, receipt] = await Promise.all([this.reader.getTransaction(txHash), this.reader.getTransactionReceipt(txHash)]);
            if (!sender || !tx || !receipt) {
                throw new UserInputError(`Transaction ${txHash} is not mined`);
            }
            const verification = verifySettlement({ tx, receipt, sender, items: this.expectedTransfers(batch) });
            if (!verification.ok) {
                throw new UserInputError(`Transaction ${txHash} does not settle this batch: ${verification.problems.join('; ')}`);
            }
            const attempt = [...(batch.attempts ?? [])].sort((a, b) => Number(b.id) - Number(a.id))[0];
            await this.connection.withTransaction(ctx, async txCtx => {
                await this.settle(txCtx, batch, attempt?.id ?? null, txHash, receipt.blockNumber, verification.feeAmount, [
                    SpraayPayoutBatchState.NEEDS_REVIEW,
                ]);
                await this.audit(txCtx, batchId, 'REVIEW_RESOLVED', { resolution, note, txHash });
            });
        } else {
            await this.transition(ctx, batchId, [SpraayPayoutBatchState.NEEDS_REVIEW], SpraayPayoutBatchState.FAILED, {
                reviewReason: `${batch.reviewReason ?? ''}\nResolved as FAILED: ${note}`.trim(),
            });
            await this.audit(ctx, batchId, 'REVIEW_RESOLVED', { resolution, note });
        }
        return this.getBatch(ctx, batchId);
    }

    // ----------------------------------------------------------------- queries

    async getBatch(ctx: RequestContext, batchId: ID): Promise<SpraayPayoutBatch> {
        const batch = await this.connection.getRepository(ctx, SpraayPayoutBatch).findOne({
            where: { id: batchId },
            relations: { items: true, attempts: true },
        });
        if (!batch) {
            throw new EntityNotFoundError('SpraayPayoutBatch' as any, batchId);
        }
        batch.items.sort((a, b) => a.position - b.position);
        batch.attempts.sort((a, b) => Number(a.id) - Number(b.id));
        return batch;
    }

    findBatches(ctx: RequestContext, opts: { state?: SpraayPayoutBatchState; take?: number; skip?: number }) {
        return this.connection.getRepository(ctx, SpraayPayoutBatch).findAndCount({
            where: opts.state ? { state: opts.state } : {},
            order: { id: 'DESC' },
            take: Math.min(opts.take ?? 50, 500),
            skip: opts.skip ?? 0,
            relations: { items: true, attempts: true },
        });
    }

    auditLog(ctx: RequestContext, batchId: ID) {
        return this.connection
            .getRepository(ctx, SpraayPayoutAuditEntry)
            .find({ where: { batchId }, order: { id: 'ASC' } });
    }

    liveAttemptOf(batch: SpraayPayoutBatch): SpraayPayoutAttempt | undefined {
        const live = (batch.attempts ?? []).filter(a => LIVE_ATTEMPT_STATES.includes(a.state));
        return live.sort((a, b) => Number(b.id) - Number(a.id))[0];
    }

    // ----------------------------------------------------------------- helpers

    private async settle(
        ctx: RequestContext,
        batch: SpraayPayoutBatch,
        attemptId: ID | null,
        txHash: string,
        blockNumber: bigint,
        feeAmount: bigint,
        from: SpraayPayoutBatchState[] = IN_FLIGHT_BATCH_STATES,
    ) {
        await this.transition(ctx, batch.id, from, SpraayPayoutBatchState.SETTLED, {
            settledTxHash: txHash.toLowerCase(),
            settledBlockNumber: blockNumber.toString(),
            settledFeeAmount: feeAmount.toString(),
            settledAt: new Date(),
        });
        if (attemptId != null) {
            await this.connection
                .getRepository(ctx, SpraayPayoutAttempt)
                .update({ id: attemptId }, { state: SpraayPayoutAttemptState.CONFIRMED });
        }
        const lineIds = batch.items.flatMap(i => i.lineIds);
        const paid = await this.connection
            .getRepository(ctx, SpraayPayoutLine)
            .update(
                { id: In(lineIds), batchId: batch.id, state: SpraayPayoutLineState.BATCHED },
                { state: SpraayPayoutLineState.PAID },
            );
        if (paid.affected !== lineIds.length) {
            throw new IllegalOperationError(`Expected ${lineIds.length} lines to settle, updated ${paid.affected}`);
        }
        await this.releaseSenderLock(ctx, batch.id);
        await this.audit(ctx, batch.id, 'BATCH_SETTLED', {
            txHash,
            blockNumber: blockNumber.toString(),
            feeAmount: feeAmount.toString(),
        });
        Logger.info(`Spraay batch ${batch.id} settled in ${txHash}`, loggerCtx);
    }

    /**
     * Searches SprayTokenExecuted(sender, USDC) logs for a transaction whose calldata and logs
     * match this batch exactly, skipping hashes in `exclude` and hashes that already settled
     * another batch (identical recurring payouts must not be confused with one another).
     */
    private async findMatchingExecution(
        ctx: RequestContext,
        attempt: SpraayPayoutAttempt,
        items: ExpectedTransfer[],
        head: bigint,
        exclude: string[],
        fromBlock: bigint = BigInt(attempt.preparedAtBlock),
    ) {
        const events = await this.reader.findSprayTokenExecutions(attempt.sender, fromBlock, head);
        const excluded = new Set(exclude.map(h => h.toLowerCase()));
        for (const event of events) {
            const hash = event.transactionHash.toLowerCase();
            if (excluded.has(hash)) continue;
            excluded.add(hash);
            const claimed = await this.connection
                .getRepository(ctx, SpraayPayoutBatch)
                .findOne({ where: { settledTxHash: hash }, select: ['id'] });
            if (claimed && String(claimed.id) !== String(attempt.batchId)) continue;
            const [tx, receipt] = await Promise.all([
                this.reader.getTransaction(hash),
                this.reader.getTransactionReceipt(hash),
            ]);
            if (!tx || !receipt) continue;
            if (verifySettlement({ tx, receipt, sender: attempt.sender, items }).ok) {
                return { hash, receipt };
            }
        }
        return undefined;
    }

    private async anyHashStillPending(attempt: SpraayPayoutAttempt): Promise<boolean> {
        for (const hash of attempt.txHashes) {
            const tx = await this.reader.getTransaction(hash);
            if (tx && tx.blockNumber == null) return true;
        }
        return false;
    }

    private earliestPreparedBlock(batch: SpraayPayoutBatch): bigint {
        return (batch.attempts ?? []).reduce(
            (min, a) => (BigInt(a.preparedAtBlock) < min ? BigInt(a.preparedAtBlock) : min),
            BigInt(batch.attempts[0]?.preparedAtBlock ?? '0'),
        );
    }

    private async recordHash(ctx: RequestContext, batchId: ID, attemptId: ID, hash: string, signedTransaction: string | null) {
        const repo = this.connection.getRepository(ctx, SpraayPayoutAttempt);
        const attempt = await repo.findOneOrFail({ where: { id: attemptId } });
        const hashes = attempt.txHashes.map(h => h.toLowerCase());
        const isNew = !hashes.includes(hash.toLowerCase());
        if (isNew) hashes.push(hash.toLowerCase());
        await repo.update(
            { id: attemptId },
            {
                txHashes: hashes,
                state: SpraayPayoutAttemptState.SUBMITTED,
                ...(signedTransaction ? { signedTransaction } : {}),
            },
        );
        const batch = await this.connection.getRepository(ctx, SpraayPayoutBatch).findOneOrFail({ where: { id: batchId } });
        if (batch.state === SpraayPayoutBatchState.AWAITING_SIGNATURE) {
            await this.transition(ctx, batchId, [SpraayPayoutBatchState.AWAITING_SIGNATURE], SpraayPayoutBatchState.SUBMITTED);
        }
        if (isNew) {
            await this.audit(ctx, batchId, 'TX_HASH_RECORDED', { attemptId: String(attemptId), txHash: hash });
        }
    }

    private async broadcast(raw: string): Promise<string | undefined> {
        try {
            await this.reader.sendRawTransaction(raw);
            return undefined;
        } catch (e: any) {
            const message = e?.details ?? e?.shortMessage ?? e?.message ?? String(e);
            Logger.warn(`Relaying signed Spraay transaction failed: ${message}`, loggerCtx);
            return message;
        }
    }

    private async getLiveAttempt(ctx: RequestContext, batchId: ID) {
        const batch = await this.getBatch(ctx, batchId);
        if (!IN_FLIGHT_BATCH_STATES.includes(batch.state)) {
            throw new IllegalOperationError(`Batch ${batchId} is ${batch.state}; it has no signing request in flight`);
        }
        const attempt = this.liveAttemptOf(batch);
        if (!attempt) {
            throw new IllegalOperationError(`Batch ${batchId} has no live attempt`);
        }
        return { batch, attempt };
    }

    private async flagForReview(ctx: RequestContext, batch: SpraayPayoutBatch, reason: string) {
        await this.transition(
            ctx,
            batch.id,
            [...IN_FLIGHT_BATCH_STATES, SpraayPayoutBatchState.NEEDS_REVIEW],
            SpraayPayoutBatchState.NEEDS_REVIEW,
            { reviewReason: reason },
        );
        await this.audit(ctx, batch.id, 'NEEDS_REVIEW', { reason });
        Logger.error(`Spraay batch ${batch.id} needs review: ${reason}`, loggerCtx);
    }

    private async releaseSenderLock(ctx: RequestContext, batchId: ID) {
        await this.connection.getRepository(ctx, SpraaySenderLock).delete({ batchId });
    }

    private async transition(
        ctx: RequestContext,
        batchId: ID,
        from: SpraayPayoutBatchState[],
        to: SpraayPayoutBatchState,
        patch: Partial<SpraayPayoutBatch> = {},
    ) {
        const res = await this.connection
            .getRepository(ctx, SpraayPayoutBatch)
            .update({ id: batchId, state: In(from) }, { ...patch, state: to } as any);
        if (res.affected !== 1) {
            throw new IllegalOperationError(
                `Batch ${batchId} could not move to ${to}: it is no longer in ${from.join('/')} (concurrent change?)`,
            );
        }
    }

    private assertAllowedSender(sender: string): `0x${string}` {
        const normalized = this.wrapValidation(() => normalizeAddress(sender, 'sender'));
        if (!this.allowedSenders.some(a => sameAddress(a, normalized))) {
            throw new UserInputError(`${normalized} is not one of the configured allowedSenders`);
        }
        return normalized;
    }

    /** Re-derives the content hash from the stored items so tampering at rest is caught before money moves. */
    private assertIntegrity(batch: SpraayPayoutBatch) {
        const recomputed = computeContentHash(
            batch.items.map(i => ({ recipient: i.recipientAddress, amount: BigInt(i.amount) })),
        );
        const total = batch.items.reduce((sum, i) => sum + BigInt(i.amount), 0n);
        if (recomputed !== batch.contentHash || total.toString() !== batch.totalAmount || batch.items.length !== batch.recipientCount) {
            throw new IllegalOperationError(`Batch ${batch.id} failed its integrity check; refusing to continue`);
        }
    }

    private expectedTransfers(batch: SpraayPayoutBatch): ExpectedTransfer[] {
        return batch.items.map(i => ({ recipient: i.recipientAddress, amount: BigInt(i.amount) }));
    }

    private wrapValidation<T>(fn: () => T): T {
        try {
            return fn();
        } catch (e) {
            if (e instanceof SpraayValidationError) {
                throw new UserInputError(e.message);
            }
            throw e;
        }
    }

    private async audit(ctx: RequestContext, batchId: ID | null, action: string, details: Record<string, unknown>) {
        await this.connection.getRepository(ctx, SpraayPayoutAuditEntry).save(
            new SpraayPayoutAuditEntry({
                batchId,
                userId: ctx.activeUserId ?? null,
                action,
                details: JSON.parse(JSON.stringify(details, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
            }),
        );
    }
}

