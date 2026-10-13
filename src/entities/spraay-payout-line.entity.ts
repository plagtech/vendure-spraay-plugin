import { DeepPartial, EntityId, ID, Seller, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';

export enum SpraayPayoutLineState {
    /** Owed to the seller, not yet in a batch. */
    PENDING = 'PENDING',
    /** Locked into a batch that has not settled or been cancelled. */
    BATCHED = 'BATCHED',
    /** Settled on-chain and verified. Terminal. */
    PAID = 'PAID',
    /** Withdrawn by an administrator before batching. Terminal. */
    VOIDED = 'VOIDED',
}

/**
 * One amount owed to one seller. The unique `idempotencyKey` is the first line of defence
 * against double payment: the same obligation can never be recorded twice.
 */
@Entity('spraay_payout_line')
export class SpraayPayoutLine extends VendureEntity {
    constructor(input?: DeepPartial<SpraayPayoutLine>) {
        super(input);
    }

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 191 })
    idempotencyKey: string;

    @ManyToOne(() => Seller, { onDelete: 'RESTRICT' })
    seller: Seller;

    @EntityId()
    sellerId: ID;

    /** Raw USDC base units (6 decimals) as a canonical integer string. */
    @Column({ type: 'varchar', length: 78 })
    amount: string;

    @Index()
    @Column({ type: 'varchar', length: 16 })
    state: SpraayPayoutLineState;

    @Column({ type: 'varchar', length: 255, nullable: true })
    reference: string | null;

    @Column({ type: 'text', nullable: true })
    memo: string | null;

    @Index()
    @EntityId({ nullable: true })
    batchId: ID | null;

    @EntityId({ nullable: true })
    createdByUserId: ID | null;
}
