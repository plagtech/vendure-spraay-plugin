import { LanguageCode, PluginCommonModule, RequestContextService, ScheduledTask, Type, VendurePlugin } from '@vendure/core';
import { isAddress } from 'viem';

import { adminApiExtensions } from './api/api-extensions';
import {
    approveSpraayPayoutsPermission,
    manageSpraayPayoutsPermission,
    readSpraayPayoutsPermission,
} from './api/permissions';
import {
    SpraayPayoutAdminResolver,
    SpraayPayoutBatchEntityResolver,
    SpraayPayoutBatchItemEntityResolver,
    SpraayPayoutLineEntityResolver,
} from './api/spraay-payout.resolver';
import { SPRAAY_PLUGIN_OPTIONS } from './constants';
import {
    SpraayPayoutAttempt,
    SpraayPayoutAuditEntry,
    SpraayPayoutBatch,
    SpraayPayoutBatchItem,
    SpraaySenderLock,
} from './entities/spraay-payout-batch.entity';
import { SpraayPayoutLine } from './entities/spraay-payout-line.entity';
import { SELLER_PAYOUT_ADDRESS_FIELD, SpraayPayoutService } from './service/spraay-payout.service';
import { SpraayPayoutPluginOptions } from './types';

/**
 * @description
 * Admin-approved, noncustodial USDC batch payouts to marketplace sellers on Base, using the
 * Spraay batch contract (0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC) and the Spraay gateway's
 * `POST /api/v1/batch/execute` and `POST /api/v1/batch/estimate` endpoints.
 *
 * The plugin never holds a private key and never reacts to order events. Payout lines are
 * recorded explicitly, grouped into batches of up to 200 recipients, approved by an
 * administrator, signed by the merchant's own wallet and only marked paid after the receipt,
 * calldata, contract event and every USDC transfer have been verified on-chain.
 *
 * @example
 * ```ts
 * SpraayPayoutPlugin.init({
 *     rpcUrl: process.env.BASE_RPC_URL!,
 *     allowedSenders: ['0xYourTreasuryEOA'],
 *     gatewayFetch: x402Fetch, // see README: "Paying gateway fees with x402"
 *     requireDistinctApprover: true,
 * })
 * ```
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [
        {
            provide: SPRAAY_PLUGIN_OPTIONS,
            useFactory: (): SpraayPayoutPluginOptions => SpraayPayoutPlugin.options,
        },
        SpraayPayoutService,
    ],
    entities: [
        SpraayPayoutLine,
        SpraayPayoutBatch,
        SpraayPayoutBatchItem,
        SpraayPayoutAttempt,
        SpraayPayoutAuditEntry,
        SpraaySenderLock,
    ],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [
            SpraayPayoutAdminResolver,
            SpraayPayoutBatchEntityResolver,
            SpraayPayoutBatchItemEntityResolver,
            SpraayPayoutLineEntityResolver,
        ],
    },
    configuration: config => {
        config.authOptions.customPermissions.push(
            readSpraayPayoutsPermission,
            manageSpraayPayoutsPermission,
            approveSpraayPayoutsPermission,
        );
        config.customFields.Seller.push({
            name: SELLER_PAYOUT_ADDRESS_FIELD,
            type: 'string',
            nullable: true,
            public: false,
            label: [{ languageCode: LanguageCode.en, value: 'Spraay payout address (Base)' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'EVM address on Base that receives this seller’s USDC payouts. Batches snapshot it when created.',
                },
            ],
            requiresPermission: [manageSpraayPayoutsPermission.Permission],
            validate: (value: string | null | undefined) => {
                if (value && (!isAddress(value, { strict: false }) || /^0x0{40}$/i.test(value))) {
                    return 'Must be a valid, non-zero EVM address';
                }
            },
        });
        const schedule = SpraayPayoutPlugin.options.reconcileSchedule ?? '* * * * *';
        if (schedule !== false) {
            config.schedulerOptions.tasks = [
                ...(config.schedulerOptions.tasks ?? []),
                new ScheduledTask({
                    id: 'spraay-payout-reconcile',
                    description:
                        'Verifies in-flight Spraay payout batches on Base. Read-only: it never initiates or signs a payment.',
                    schedule,
                    preventOverlap: true,
                    async execute({ injector }) {
                        const ctx = await injector.get(RequestContextService).create({ apiType: 'admin' });
                        return injector.get(SpraayPayoutService).reconcileInFlight(ctx);
                    },
                }),
            ];
        }
        return config;
    },
    exports: [SpraayPayoutService],
    compatibility: '^3.6.0-0',
})
export class SpraayPayoutPlugin {
    static options: SpraayPayoutPluginOptions;

    static init(options: SpraayPayoutPluginOptions): Type<SpraayPayoutPlugin> {
        if (!options?.rpcUrl) {
            throw new Error('SpraayPayoutPlugin: `rpcUrl` (a Base mainnet JSON-RPC URL) is required');
        }
        if (!options.allowedSenders?.length) {
            throw new Error('SpraayPayoutPlugin: `allowedSenders` must list at least one merchant-controlled address');
        }
        this.options = options;
        return SpraayPayoutPlugin;
    }
}
