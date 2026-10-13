import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, RequestContext, Seller, Transaction, TransactionalConnection } from '@vendure/core';

import { formatUsdc } from '../amounts';
import { SpraayPayoutBatch, SpraayPayoutBatchItem, SpraayPayoutBatchState } from '../entities/spraay-payout-batch.entity';
import { SpraayPayoutLine, SpraayPayoutLineState } from '../entities/spraay-payout-line.entity';
import { CreatePayoutLineInput, SpraayPayoutService, SpraayReviewResolution } from '../service/spraay-payout.service';

import {
    approveSpraayPayoutsPermission,
    manageSpraayPayoutsPermission,
    readSpraayPayoutsPermission,
} from './permissions';

@Resolver()
export class SpraayPayoutAdminResolver {
    constructor(private service: SpraayPayoutService) {}

    @Query()
    @Allow(readSpraayPayoutsPermission.Permission)
    spraayPayoutConfig() {
        return this.service.getConfig();
    }

    @Query()
    @Allow(readSpraayPayoutsPermission.Permission)
    async spraayPayoutLines(
        @Ctx() ctx: RequestContext,
        @Args() args: { state?: SpraayPayoutLineState; sellerId?: ID; batchId?: ID; take?: number; skip?: number },
    ) {
        const [items, totalItems] = await this.service.findLines(ctx, args);
        return { items, totalItems };
    }

    @Query()
    @Allow(readSpraayPayoutsPermission.Permission)
    async spraayPayoutBatches(
        @Ctx() ctx: RequestContext,
        @Args() args: { state?: SpraayPayoutBatchState; take?: number; skip?: number },
    ) {
        const [items, totalItems] = await this.service.findBatches(ctx, args);
        return { items, totalItems };
    }

    @Query()
    @Allow(readSpraayPayoutsPermission.Permission)
    async spraayPayoutBatch(@Ctx() ctx: RequestContext, @Args() args: { id: ID }) {
        try {
            return await this.service.getBatch(ctx, args.id);
        } catch {
            return null;
        }
    }

    @Query()
    @Allow(manageSpraayPayoutsPermission.Permission)
    spraayNonceCancellationRequest(@Ctx() ctx: RequestContext, @Args() args: { batchId: ID }) {
        return this.service.nonceCancellationRequest(ctx, args.batchId);
    }

    @Mutation()
    @Transaction()
    @Allow(manageSpraayPayoutsPermission.Permission)
    createSpraayPayoutLines(@Ctx() ctx: RequestContext, @Args() args: { input: CreatePayoutLineInput[] }) {
        return this.service.createLines(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(manageSpraayPayoutsPermission.Permission)
    voidSpraayPayoutLine(@Ctx() ctx: RequestContext, @Args() args: { id: ID; reason: string }) {
        return this.service.voidLine(ctx, args.id, args.reason);
    }

    @Mutation()
    @Transaction()
    @Allow(manageSpraayPayoutsPermission.Permission)
    createSpraayPayoutBatch(@Ctx() ctx: RequestContext, @Args() args: { lineIds: ID[] }) {
        return this.service.createBatch(ctx, args.lineIds);
    }

    @Mutation()
    @Transaction()
    @Allow(approveSpraayPayoutsPermission.Permission)
    approveSpraayPayoutBatch(@Ctx() ctx: RequestContext, @Args() args: { id: ID; contentHash: string }) {
        return this.service.approveBatch(ctx, args.id, args.contentHash);
    }

    @Mutation()
    @Allow(manageSpraayPayoutsPermission.Permission)
    estimateSpraayPayoutBatch(@Ctx() ctx: RequestContext, @Args() args: { id: ID; sender: string }) {
        return this.service.estimateBatch(ctx, args.id, args.sender);
    }

    // No @Transaction(): the verified (paid-for) gateway answer is cached even if a later check fails.
    @Mutation()
    @Allow(manageSpraayPayoutsPermission.Permission)
    prepareSpraayPayoutBatch(@Ctx() ctx: RequestContext, @Args() args: { id: ID; sender: string }) {
        return this.service.prepareBatch(ctx, args.id, args.sender);
    }

    // No @Transaction(): the transaction hash must be committed *before* the relay happens.
    @Mutation()
    @Allow(manageSpraayPayoutsPermission.Permission)
    submitSpraaySignedTransaction(@Ctx() ctx: RequestContext, @Args() args: { batchId: ID; signedTransaction: string }) {
        return this.service.submitSignedTransaction(ctx, args.batchId, args.signedTransaction);
    }

    @Mutation()
    @Allow(manageSpraayPayoutsPermission.Permission)
    reportSpraayTransactionHash(@Ctx() ctx: RequestContext, @Args() args: { batchId: ID; txHash: string }) {
        return this.service.reportTransactionHash(ctx, args.batchId, args.txHash);
    }

    @Mutation()
    @Allow(manageSpraayPayoutsPermission.Permission)
    rebroadcastSpraayTransaction(@Ctx() ctx: RequestContext, @Args() args: { batchId: ID }) {
        return this.service.rebroadcast(ctx, args.batchId);
    }

    // Reconciliation commits each conclusive step in its own transaction.
    @Mutation()
    @Allow(manageSpraayPayoutsPermission.Permission)
    reconcileSpraayPayoutBatch(@Ctx() ctx: RequestContext, @Args() args: { id: ID }) {
        return this.service.reconcileBatch(ctx, args.id);
    }

    @Mutation()
    @Allow(manageSpraayPayoutsPermission.Permission)
    cancelSpraayPayoutBatch(@Ctx() ctx: RequestContext, @Args() args: { id: ID; reason: string }) {
        return this.service.cancelBatch(ctx, args.id, args.reason);
    }

    @Mutation()
    @Allow(approveSpraayPayoutsPermission.Permission)
    resolveSpraayPayoutBatchReview(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID; resolution: SpraayReviewResolution; note: string; txHash?: string },
    ) {
        return this.service.resolveReview(ctx, args.id, args.resolution, args.note, args.txHash);
    }
}

@Resolver('SpraayPayoutBatch')
export class SpraayPayoutBatchEntityResolver {
    constructor(
        private service: SpraayPayoutService,
        private connection: TransactionalConnection,
    ) {}

    @ResolveField()
    totalAmountFormatted(@Parent() batch: SpraayPayoutBatch) {
        return formatUsdc(BigInt(batch.totalAmount));
    }

    @ResolveField()
    approvalRequest(@Parent() batch: SpraayPayoutBatch) {
        return this.service.approvalRequestFor(batch);
    }

    @ResolveField()
    signingRequest(@Parent() batch: SpraayPayoutBatch) {
        if (batch.state !== SpraayPayoutBatchState.AWAITING_SIGNATURE && batch.state !== SpraayPayoutBatchState.SUBMITTED) {
            return null;
        }
        return this.service.liveAttemptOf(batch)?.signingRequest ?? null;
    }

    @ResolveField()
    lines(@Ctx() ctx: RequestContext, @Parent() batch: SpraayPayoutBatch) {
        return this.connection.getRepository(ctx, SpraayPayoutLine).find({ where: { batchId: batch.id }, order: { id: 'ASC' } });
    }

    @ResolveField()
    auditLog(@Ctx() ctx: RequestContext, @Parent() batch: SpraayPayoutBatch) {
        return this.service.auditLog(ctx, batch.id);
    }
}

@Resolver('SpraayPayoutBatchItem')
export class SpraayPayoutBatchItemEntityResolver {
    @ResolveField()
    amountFormatted(@Parent() item: SpraayPayoutBatchItem) {
        return formatUsdc(BigInt(item.amount));
    }
}

@Resolver('SpraayPayoutLine')
export class SpraayPayoutLineEntityResolver {
    constructor(private connection: TransactionalConnection) {}

    @ResolveField()
    amountFormatted(@Parent() line: SpraayPayoutLine) {
        return formatUsdc(BigInt(line.amount));
    }

    @ResolveField()
    seller(@Ctx() ctx: RequestContext, @Parent() line: SpraayPayoutLine) {
        return this.connection.getRepository(ctx, Seller).findOne({ where: { id: line.sellerId } });
    }
}
