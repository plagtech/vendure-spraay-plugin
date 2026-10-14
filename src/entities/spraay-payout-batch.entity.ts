import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';

/**
 * Lifecycle states of a {@link SpraayPayoutBatch}.
 *
 * @category Entities
 */
export enum SpraayPayoutBatchState {
    /** Created from pending lines; content may still be reviewed. */
    DRAFT = 'DRAFT',
    /** An administrator with ApproveSpraayPayouts approved the exact content hash. */
    APPROVED = 'APPROVED',
    /** Gateway transaction verified, but the sender's USDC allowance must be raised first. */
    AWAITING_ALLOWANCE = 'AWAITING_ALLOWANCE',
    /** A signing request with a pinned nonce has been issued to the merchant's wallet. */
    AWAITING_SIGNATURE = 'AWAITING_SIGNATURE',
    /** A transaction hash is known; waiting for inclusion and confirmations. */
    SUBMITTED = 'SUBMITTED',
    /** Verified on-chain with the required confirmations. Terminal. */
    SETTLED = 'SETTLED',
    /** The last attempt provably did not pay anyone (reverted or nonce consumed elsewhere). Retryable. */
    FAILED = 'FAILED',
    /** Something did not add up (mismatch, duplicate execution). Lines stay locked until a human decides. */
    NEEDS_REVIEW = 'NEEDS_REVIEW',
    /** Cancelled before any payment; lines released back to PENDING. Terminal. */
    CANCELLED = 'CANCELLED',
}

/**
 * A batch of payout lines grouped for on-chain settlement.
 *
 * @category Entities
 */
@Entity('spraay_payout_batch')
export class SpraayPayoutBatch extends VendureEntity {
    constructor(input?: DeepPartial<SpraayPayoutBatch>) {
        super(input);
    }

    @Index()
    @Column({ type: 'varchar', length: 24 })
    state: SpraayPayoutBatchState;

    /** Raw USDC, sum of items, excluding the protocol fee. */
    @Column({ type: 'varchar', length: 78 })
    totalAmount: string;

    @Column({ type: 'int' })
    recipientCount: number;

    @Column({ type: 'varchar', length: 66 })
    contentHash: string;

    @EntityId({ nullable: true })
    createdByUserId: ID | null;

    @EntityId({ nullable: true })
    approvedByUserId: ID | null;

    @Column({ type: Date, nullable: true })
    approvedAt: Date | null;

    @Index()
    @Column({ type: 'varchar', length: 42, nullable: true })
    sender: string | null;

    /** Fee rate read from the contract when the gateway response was verified. */
    @Column({ type: 'varchar', length: 10, nullable: true })
    feeBps: string | null;

    /** Raw USDC allowance needed: totalAmount + fee. */
    @Column({ type: 'varchar', length: 78, nullable: true })
    requiredAllowance: string | null;

    /** Verified sprayToken calldata from the gateway. Cached so retries do not pay the gateway again. */
    @Column({ type: 'text', nullable: true })
    verifiedCalldata: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    gatewayGasLimit: string | null;

    @Column({ type: 'simple-json', nullable: true })
    gatewayEstimate: Record<string, any> | null;

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 66, nullable: true })
    settledTxHash: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    settledBlockNumber: string | null;

    @Column({ type: 'varchar', length: 78, nullable: true })
    settledFeeAmount: string | null;

    @Column({ type: Date, nullable: true })
    settledAt: Date | null;

    @Column({ type: 'text', nullable: true })
    reviewReason: string | null;

    @Column({ type: 'text', nullable: true })
    cancelReason: string | null;

    @OneToMany(() => SpraayPayoutBatchItem, item => item.batch, { cascade: true })
    items: SpraayPayoutBatchItem[];

    @OneToMany(() => SpraayPayoutAttempt, attempt => attempt.batch)
    attempts: SpraayPayoutAttempt[];
}

/**
 * One on-chain transfer: the aggregate of every line in the batch paid to the same address.
 *
 * @category Entities
 */
@Entity('spraay_payout_batch_item')
export class SpraayPayoutBatchItem extends VendureEntity {
    constructor(input?: DeepPartial<SpraayPayoutBatchItem>) {
        super(input);
    }

    @ManyToOne(() => SpraayPayoutBatch, batch => batch.items, { onDelete: 'CASCADE' })
    batch: SpraayPayoutBatch;

    @EntityId()
    batchId: ID;

    @Column({ type: 'int' })
    position: number;

    @Column({ type: 'varchar', length: 42 })
    recipientAddress: string;

    @Column({ type: 'varchar', length: 78 })
    amount: string;

    @Column({ type: 'simple-json' })
    lineIds: string[];

    @Column({ type: 'simple-json' })
    sellerIds: string[];
}

/**
 * Lifecycle states of a {@link SpraayPayoutAttempt}.
 *
 * @category Entities
 */
export enum SpraayPayoutAttemptState {
    /** Signing request issued; nothing known on-chain yet. */
    PREPARED = 'PREPARED',
    /** At least one transaction hash recorded. */
    SUBMITTED = 'SUBMITTED',
    /** Mined, verified and confirmed. */
    CONFIRMED = 'CONFIRMED',
    /** Mined but reverted; no funds moved. */
    REVERTED = 'REVERTED',
    /** Its nonce was consumed by another transaction and no matching execution exists. */
    DEAD = 'DEAD',
    /** Mined successfully but did not match the approved batch, or duplicated another execution. */
    ANOMALOUS = 'ANOMALOUS',
}

/**
 * One try at getting a batch on-chain. A batch has at most one live (PREPARED/SUBMITTED) attempt;
 * a new one can only be created after the previous one is provably dead or reverted.
 *
 * @category Entities
 */
@Entity('spraay_payout_attempt')
export class SpraayPayoutAttempt extends VendureEntity {
    constructor(input?: DeepPartial<SpraayPayoutAttempt>) {
        super(input);
    }

    @ManyToOne(() => SpraayPayoutBatch, batch => batch.attempts, { onDelete: 'CASCADE' })
    batch: SpraayPayoutBatch;

    @Index()
    @EntityId()
    batchId: ID;

    @Index()
    @Column({ type: 'varchar', length: 16 })
    state: SpraayPayoutAttemptState;

    @Column({ type: 'varchar', length: 42 })
    sender: string;

    /** The nonce the signer must use. Pinning it means at most one signed copy can ever be mined. */
    @Column({ type: 'int' })
    nonce: number;

    /** Block height when the attempt was prepared; the lower bound for replacement searches. */
    @Column({ type: 'varchar', length: 32 })
    preparedAtBlock: string;

    @Column({ type: 'simple-json' })
    signingRequest: {
        from: string;
        to: string;
        data: string;
        value: string;
        chainId: number;
        nonce: number;
        gas: string;
    };

    /** Every hash seen for this attempt (original plus wallet speed-ups / replacements). */
    @Column({ type: 'simple-json' })
    txHashes: string[];

    /** Last merchant-signed raw transaction submitted through the plugin, kept for rebroadcast. */
    @Column({ type: 'text', nullable: true })
    signedTransaction: string | null;

    @Column({ type: 'varchar', length: 66, nullable: true })
    minedTxHash: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    minedBlockNumber: string | null;

    @Column({ type: 'int', default: 0 })
    confirmations: number;

    @Column({ type: Date, nullable: true })
    lastCheckedAt: Date | null;

    @Column({ type: 'text', nullable: true })
    note: string | null;
}

/**
 * Immutable audit log entry for batch lifecycle events.
 *
 * @category Entities
 */
@Entity('spraay_payout_audit_entry')
export class SpraayPayoutAuditEntry extends VendureEntity {
    constructor(input?: DeepPartial<SpraayPayoutAuditEntry>) {
        super(input);
    }

    @Index()
    @EntityId({ nullable: true })
    batchId: ID | null;

    @EntityId({ nullable: true })
    userId: ID | null;

    @Column({ type: 'varchar', length: 64 })
    action: string;

    @Column({ type: 'simple-json', nullable: true })
    details: Record<string, any> | null;
}

/**
 * At most one batch per sender may hold a pinned nonce at a time. The unique index makes this
 * an atomic database-level guarantee rather than a read-then-write check.
 *
 * @category Entities
 */
@Entity('spraay_sender_lock')
export class SpraaySenderLock extends VendureEntity {
    constructor(input?: DeepPartial<SpraaySenderLock>) {
        super(input);
    }

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 42 })
    sender: string;

    @EntityId()
    batchId: ID;
}
