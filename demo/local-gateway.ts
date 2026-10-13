/**
 * LOCAL STAND-IN for the Spraay gateway — for the demo and e2e tests only.
 *
 * It implements just the two documented endpoints the plugin calls
 * (POST /api/v1/batch/execute and POST /api/v1/batch/estimate, OpenAPI v3.8.3) and mirrors the
 * production handler's behaviour: flat format with RAW integer amounts, max 200 recipients,
 * 0.3% fee, `sprayToken` calldata for the Base contract, hex gasLimit = max(eth_estimateGas × 1.5,
 * 180k + 50k × (n − 1)), and `approvalRequired.amount = total + fee`.
 *
 * x402 is simulated: requests without an `X-PAYMENT` / `PAYMENT-SIGNATURE` header get a 402, and
 * any value is accepted. No payment is settled. Never point production at this server.
 */
import http from 'http';
import { createPublicClient, encodeFunctionData, formatUnits, getAddress, http as viemHttp, isAddress } from 'viem';

import { spraayBatchAbi } from '../src/chain/abi';
import { SPRAAY_BATCH_CONTRACT_BASE, USDC_BASE } from '../src/constants';

const FEE_BPS = 30n;

export interface LocalGatewayOptions {
    port: number;
    rpcUrl: string;
    /** Lets tests tamper with responses to prove the plugin rejects them. */
    transform?: (path: string, body: any) => any;
}

export function startLocalGateway(options: LocalGatewayOptions): Promise<{ close: () => Promise<void>; calls: string[] }> {
    const client = createPublicClient({ transport: viemHttp(options.rpcUrl) });
    const calls: string[] = [];

    const server = http.createServer(async (req, res) => {
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        const path = req.url ?? '';
        if (req.method !== 'POST' || !['/api/v1/batch/execute', '/api/v1/batch/estimate'].includes(path)) {
            return send(404, { error: 'not found' });
        }
        if (!req.headers['x-payment'] && !req.headers['payment-signature']) {
            return send(402, {
                x402Version: 2,
                error: 'Payment required',
                accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: path.endsWith('execute') ? '20000' : '1000', asset: USDC_BASE }],
            });
        }
        calls.push(path);
        let body: any;
        try {
            body = JSON.parse(await readBody(req));
        } catch {
            return send(400, { error: 'invalid JSON' });
        }
        try {
            const result = await handle(path, body, client);
            send(result.status, options.transform ? options.transform(path, result.body) : result.body);
        } catch (e: any) {
            send(500, { error: e?.message ?? String(e) });
        }
    });

    return new Promise(resolve => {
        server.listen(options.port, () =>
            resolve({ calls, close: () => new Promise<void>(r => server.close(() => r())) }),
        );
    });
}

async function handle(path: string, body: any, client: ReturnType<typeof createPublicClient>) {
    const { token = 'USDC', recipients, amounts, sender, chain } = body ?? {};
    if (chain !== undefined && chain !== 'base') {
        return { status: 400, body: { error: `Unsupported settlement chain "${chain}".` } };
    }
    if (String(token).toUpperCase() !== 'USDC' && String(token).toLowerCase() !== USDC_BASE.toLowerCase()) {
        return { status: 400, body: { error: 'This local stand-in only supports Base USDC' } };
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
        return { status: 400, body: { error: 'recipients array required' } };
    }
    // Production enforces the cap on execute only; estimate quotes any size (observed on v3.8.3).
    if (recipients.length > 200 && path.endsWith('execute')) {
        return { status: 400, body: { error: 'Maximum 200 recipients' } };
    }
    if (!Array.isArray(amounts) || amounts.length !== recipients.length) {
        return { status: 400, body: { error: "Flat format requires an 'amounts' array (raw base units) the same length as 'recipients'." } };
    }
    const onchain = recipients.map((r: string, i: number) => {
        if (!isAddress(r, { strict: false })) throw new Error(`recipients[${i}] must be an address string.`);
        return { recipient: getAddress(r), amount: BigInt(String(amounts[i])) };
    });
    const total = onchain.reduce((s: bigint, r: { amount: bigint }) => s + r.amount, 0n);
    const fee = (total * FEE_BPS) / 10_000n;
    const data = encodeFunctionData({ abi: spraayBatchAbi, functionName: 'sprayToken', args: [USDC_BASE, onchain] });
    const floor = 180_000n + 50_000n * BigInt(onchain.length - 1);
    let gas = floor;
    try {
        const estimated = await client.estimateGas({ account: sender, to: SPRAAY_BATCH_CONTRACT_BASE, data });
        const padded = (estimated * 3n) / 2n;
        gas = padded > floor ? padded : floor;
    } catch {
        // floor, exactly like production when the allowance is not granted yet
    }
    const tokenInfo = { symbol: 'USDC', address: USDC_BASE, decimals: 6, isETH: false };
    if (path.endsWith('estimate')) {
        return {
            status: 200,
            body: {
                success: true,
                token: tokenInfo,
                recipientCount: onchain.length,
                totalAmount: formatUnits(total, 6),
                fee: formatUnits(fee, 6),
                feePercent: '0.3%',
                totalWithFee: formatUnits(total + fee, 6),
                suggestedGasLimit: gas.toString(),
            },
        };
    }
    return {
        status: 200,
        body: {
            success: true,
            contract: SPRAAY_BATCH_CONTRACT_BASE,
            token: tokenInfo,
            batch: {
                recipientCount: onchain.length,
                totalAmount: formatUnits(total, 6),
                fee: formatUnits(fee, 6),
                feePercent: '0.3%',
                totalWithFee: formatUnits(total + fee, 6),
            },
            transaction: { to: SPRAAY_BATCH_CONTRACT_BASE, data, value: '0', chainId: 8453, gasLimit: '0x' + gas.toString(16) },
            approvalRequired: {
                token: USDC_BASE,
                spender: SPRAAY_BATCH_CONTRACT_BASE,
                amount: (total + fee).toString(),
                amountFormatted: formatUnits(total + fee, 6),
            },
        },
    };
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => (data += chunk));
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

/** The demo's "x402 fetch": adds a placeholder payment header. Replace with @x402/fetch in production. */
export const simulatedX402Fetch = (input: string, init?: RequestInit) =>
    fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), 'X-PAYMENT': 'local-demo-not-a-real-payment' } });
