import { gql } from 'graphql-tag';

export const adminApiExtensions = gql`
    enum SpraayPayoutLineState {
        PENDING
        BATCHED
        PAID
        VOIDED
    }

    enum SpraayPayoutBatchState {
        DRAFT
        APPROVED
        AWAITING_ALLOWANCE
        AWAITING_SIGNATURE
        SUBMITTED
        SETTLED
        FAILED
        NEEDS_REVIEW
        CANCELLED
    }

    enum SpraayPayoutAttemptState {
        PREPARED
        SUBMITTED
        CONFIRMED
        REVERTED
        DEAD
        ANOMALOUS
    }

    enum SpraayReviewResolution {
        MARK_SETTLED
        MARK_FAILED
    }

    type SpraayPayoutConfig {
        chainId: Int!
        contractAddress: String!
        tokenAddress: String!
        tokenSymbol: String!
        tokenDecimals: Int!
        allowedSenders: [String!]!
        requiredConfirmations: Int!
        requireDistinctApprover: Boolean!
        maxRecipientsPerBatch: Int!
    }

    "An EVM transaction for the merchant's own wallet to sign. Amount fields are raw integer strings."
    type SpraayTransactionRequest {
        from: String!
        to: String!
        data: String!
        value: String!
        chainId: Int!
        "Pinned nonce. Signers must use exactly this value. Null for allowance approvals."
        nonce: Int
        "Hex gas limit, or null to let the wallet estimate."
        gas: String
    }

    type SpraayPayoutLine implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        idempotencyKey: String!
        sellerId: ID!
        seller: Seller
        "Raw USDC base units (6 decimals)."
        amount: String!
        amountFormatted: String!
        state: SpraayPayoutLineState!
        reference: String
        memo: String
        batchId: ID
    }

    type SpraayPayoutLineList {
        items: [SpraayPayoutLine!]!
        totalItems: Int!
    }

    type SpraayPayoutBatchItem {
        position: Int!
        recipientAddress: String!
        amount: String!
        amountFormatted: String!
        lineIds: [ID!]!
        sellerIds: [ID!]!
    }

    type SpraayPayoutAttempt {
        id: ID!
        createdAt: DateTime!
        state: SpraayPayoutAttemptState!
        sender: String!
        nonce: Int!
        preparedAtBlock: String!
        signingRequest: SpraayTransactionRequest!
        txHashes: [String!]!
        minedTxHash: String
        minedBlockNumber: String
        confirmations: Int!
        lastCheckedAt: DateTime
        note: String
    }

    type SpraayPayoutAuditEntry {
        id: ID!
        createdAt: DateTime!
        action: String!
        userId: ID
        details: JSON
    }

    type SpraayPayoutBatch implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        state: SpraayPayoutBatchState!
        "Raw USDC, excluding the protocol fee."
        totalAmount: String!
        totalAmountFormatted: String!
        recipientCount: Int!
        "Approvers must pass this exact value to approveSpraayPayoutBatch."
        contentHash: String!
        createdByUserId: ID
        approvedByUserId: ID
        approvedAt: DateTime
        sender: String
        feeBps: String
        "Raw USDC allowance the sender must grant the Spraay contract (total + fee)."
        requiredAllowance: String
        gatewayGasLimit: String
        gatewayEstimate: JSON
        settledTxHash: String
        settledBlockNumber: String
        settledFeeAmount: String
        settledAt: DateTime
        reviewReason: String
        cancelReason: String
        items: [SpraayPayoutBatchItem!]!
        lines: [SpraayPayoutLine!]!
        attempts: [SpraayPayoutAttempt!]!
        "The approve() transaction to sign while the batch is AWAITING_ALLOWANCE."
        approvalRequest: SpraayTransactionRequest
        "The batch transaction to sign while the batch is AWAITING_SIGNATURE or SUBMITTED."
        signingRequest: SpraayTransactionRequest
        auditLog: [SpraayPayoutAuditEntry!]!
    }

    type SpraayPayoutBatchList {
        items: [SpraayPayoutBatch!]!
        totalItems: Int!
    }

    type SpraaySubmitTransactionResult {
        batch: SpraayPayoutBatch!
        txHash: String!
        "Non-null if relaying to the RPC failed. The hash is recorded either way; reconcile or rebroadcast."
        broadcastError: String
    }

    input CreateSpraayPayoutLineInput {
        sellerId: ID!
        "Raw USDC base units as a positive integer string, e.g. \\"1500000\\" = 1.50 USDC."
        amount: String!
        "Unique key for this obligation (e.g. an order or settlement period id). Replays are idempotent."
        idempotencyKey: String!
        reference: String
        memo: String
    }

    extend type Query {
        spraayPayoutConfig: SpraayPayoutConfig!
        spraayPayoutLines(
            state: SpraayPayoutLineState
            sellerId: ID
            batchId: ID
            take: Int
            skip: Int
        ): SpraayPayoutLineList!
        spraayPayoutBatches(state: SpraayPayoutBatchState, take: Int, skip: Int): SpraayPayoutBatchList!
        spraayPayoutBatch(id: ID!): SpraayPayoutBatch
        "A 0-value self-transfer at the live attempt's pinned nonce; mining it invalidates the batch transaction."
        spraayNonceCancellationRequest(batchId: ID!): SpraayTransactionRequest!
    }

    extend type Mutation {
        createSpraayPayoutLines(input: [CreateSpraayPayoutLineInput!]!): [SpraayPayoutLine!]!
        voidSpraayPayoutLine(id: ID!, reason: String!): SpraayPayoutLine!
        createSpraayPayoutBatch(lineIds: [ID!]!): SpraayPayoutBatch!
        approveSpraayPayoutBatch(id: ID!, contentHash: String!): SpraayPayoutBatch!
        "Paid gateway call (POST /api/v1/batch/estimate). Informational only."
        estimateSpraayPayoutBatch(id: ID!, sender: String!): SpraayPayoutBatch!
        prepareSpraayPayoutBatch(id: ID!, sender: String!): SpraayPayoutBatch!
        submitSpraaySignedTransaction(batchId: ID!, signedTransaction: String!): SpraaySubmitTransactionResult!
        reportSpraayTransactionHash(batchId: ID!, txHash: String!): SpraayPayoutBatch!
        rebroadcastSpraayTransaction(batchId: ID!): SpraaySubmitTransactionResult!
        reconcileSpraayPayoutBatch(id: ID!): SpraayPayoutBatch!
        cancelSpraayPayoutBatch(id: ID!, reason: String!): SpraayPayoutBatch!
        resolveSpraayPayoutBatchReview(
            id: ID!
            resolution: SpraayReviewResolution!
            note: String!
            txHash: String
        ): SpraayPayoutBatch!
    }
`;
