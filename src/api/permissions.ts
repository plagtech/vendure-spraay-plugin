import { PermissionDefinition } from '@vendure/core';

export const readSpraayPayoutsPermission = new PermissionDefinition({
    name: 'ReadSpraayPayouts',
    description: 'Allows viewing Spraay payout lines, batches and their audit log',
});

export const manageSpraayPayoutsPermission = new PermissionDefinition({
    name: 'ManageSpraayPayouts',
    description:
        'Allows recording payout lines, building batches, preparing signing requests, submitting signed transactions and reconciling',
});

export const approveSpraayPayoutsPermission = new PermissionDefinition({
    name: 'ApproveSpraayPayouts',
    description: 'Allows approving Spraay payout batches and resolving batches that need review',
});
