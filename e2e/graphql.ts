import { gql } from 'graphql-tag';

const TX_REQUEST = `from to data value chainId nonce gas`;

export const BATCH_FIELDS = gql`
    fragment Batch on SpraayPayoutBatch {
        id
        state
        totalAmount
        totalAmountFormatted
        recipientCount
        contentHash
        sender
        feeBps
        requiredAllowance
        settledTxHash
        settledFeeAmount
        reviewReason
        items { position recipientAddress amount lineIds sellerIds }
        lines { id state idempotencyKey }
        attempts { id state nonce txHashes minedTxHash confirmations note }
        approvalRequest { ${TX_REQUEST} }
        signingRequest { ${TX_REQUEST} }
        auditLog { action }
    }
`;

export const CREATE_SELLER = gql`
    mutation CreateSeller($input: CreateSellerInput!) {
        createSeller(input: $input) { id name customFields { spraayPayoutAddress } }
    }
`;

export const CREATE_ROLE = gql`
    mutation CreateRole($input: CreateRoleInput!) {
        createRole(input: $input) { id }
    }
`;

export const CREATE_ADMIN = gql`
    mutation CreateAdministrator($input: CreateAdministratorInput!) {
        createAdministrator(input: $input) { id }
    }
`;

export const CREATE_LINES = gql`
    mutation CreateLines($input: [CreateSpraayPayoutLineInput!]!) {
        createSpraayPayoutLines(input: $input) { id state amount idempotencyKey sellerId }
    }
`;

export const CREATE_BATCH = gql`
    mutation CreateBatch($lineIds: [ID!]!) {
        createSpraayPayoutBatch(lineIds: $lineIds) { ...Batch }
    }
    ${BATCH_FIELDS}
`;

export const APPROVE_BATCH = gql`
    mutation Approve($id: ID!, $contentHash: String!) {
        approveSpraayPayoutBatch(id: $id, contentHash: $contentHash) { ...Batch }
    }
    ${BATCH_FIELDS}
`;

export const ESTIMATE_BATCH = gql`
    mutation Estimate($id: ID!, $sender: String!) {
        estimateSpraayPayoutBatch(id: $id, sender: $sender) { id gatewayEstimate }
    }
`;

export const PREPARE_BATCH = gql`
    mutation Prepare($id: ID!, $sender: String!) {
        prepareSpraayPayoutBatch(id: $id, sender: $sender) { ...Batch }
    }
    ${BATCH_FIELDS}
`;

export const SUBMIT_SIGNED = gql`
    mutation Submit($batchId: ID!, $signedTransaction: String!) {
        submitSpraaySignedTransaction(batchId: $batchId, signedTransaction: $signedTransaction) {
            txHash
            broadcastError
            batch { ...Batch }
        }
    }
    ${BATCH_FIELDS}
`;

export const REPORT_HASH = gql`
    mutation Report($batchId: ID!, $txHash: String!) {
        reportSpraayTransactionHash(batchId: $batchId, txHash: $txHash) { ...Batch }
    }
    ${BATCH_FIELDS}
`;

export const RECONCILE = gql`
    mutation Reconcile($id: ID!) {
        reconcileSpraayPayoutBatch(id: $id) { ...Batch }
    }
    ${BATCH_FIELDS}
`;

export const CANCEL = gql`
    mutation Cancel($id: ID!, $reason: String!) {
        cancelSpraayPayoutBatch(id: $id, reason: $reason) { ...Batch }
    }
    ${BATCH_FIELDS}
`;

export const RESOLVE = gql`
    mutation Resolve($id: ID!, $resolution: SpraayReviewResolution!, $note: String!, $txHash: String) {
        resolveSpraayPayoutBatchReview(id: $id, resolution: $resolution, note: $note, txHash: $txHash) { ...Batch }
    }
    ${BATCH_FIELDS}
`;

export const NONCE_CANCELLATION = gql`
    query NonceCancel($batchId: ID!) {
        spraayNonceCancellationRequest(batchId: $batchId) { ${TX_REQUEST} }
    }
`;

export const GET_LINES = gql`
    query Lines($state: SpraayPayoutLineState, $batchId: ID) {
        spraayPayoutLines(state: $state, batchId: $batchId) { totalItems items { id state batchId amount } }
    }
`;

export const GET_CONFIG = gql`
    query Config {
        spraayPayoutConfig { chainId contractAddress tokenAddress allowedSenders requiredConfirmations maxRecipientsPerBatch }
    }
`;
