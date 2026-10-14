import { PermissionDefinition } from '@vendure/core';

/**
 * Permission to view Spraay payout data.
 *
 * @category Plugin
 */
export const readSpraayPayoutsPermission = new PermissionDefinition({
    name: 'ReadSpraayPayouts',
    description: 'Allows viewing Spraay payout lines, batches and their audit log',
});

/**
 * Permission to manage Spraay payout lines and batches.
 *
 * @category Plugin
 */
export const manageSpraayPayoutsPermission = new PermissionDefinition({
    name: 'ManageSpraayPayouts',
    description:
        'Allows recording payout lines, building batches, preparing signing requests, submitting signed transactions and reconciling',
});

/**
 * Permission to approve Spraay payout batches.
 *
 * @category Plugin
 */
export const approveSpraayPayoutsPermission = new PermissionDefinition({
    name: 'ApproveSpraayPayouts',
    description: 'Allows approving Spraay payout batches and resolving batches that need review',
});
