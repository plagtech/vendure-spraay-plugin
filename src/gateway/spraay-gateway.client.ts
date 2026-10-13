import {
    DEFAULT_GATEWAY_URL,
    GATEWAY_CHAIN_SLUG,
    GATEWAY_ESTIMATE_PATH,
    GATEWAY_EXECUTE_PATH,
    USDC_SYMBOL,
} from '../constants';

/**
 * Request/response shapes for the two Spraay gateway endpoints this plugin uses, transcribed
 * from the published OpenAPI document (https://gateway.spraay.app/openapi.json, info.version 3.8.3).
 * Only fields documented there are read.
 */
export interface GatewayBatchRequest {
    /** Symbol or ERC-20 address. The plugin always sends "USDC". */
    token: string;
    /** Recipient addresses, parallel to `amounts`. Max 200. */
    recipients: string[];
    /** RAW base units as integer strings, parallel to `recipients`. */
    amounts: string[];
    /** Payer address. */
    sender: string;
    /** Settlement chain slug. The plugin always sends "base". */
    chain: string;
}

export interface GatewayTokenInfo {
    symbol?: string;
    address?: string;
    decimals?: number;
    isETH?: boolean;
}

export interface GatewayExecuteResponse {
    success?: boolean;
    contract?: string;
    token?: GatewayTokenInfo;
    batch?: {
        recipientCount?: number;
        /** HUMAN-DECIMAL strings, display only. */
        totalAmount?: string;
        fee?: string;
        feePercent?: string;
        totalWithFee?: string;
    };
    transaction?: {
        to?: string;
        data?: string;
        /** RAW wei as a decimal string. "0" for ERC-20 batches. */
        value?: string;
        chainId?: number;
        /** HEX quantity, e.g. "0x38270". */
        gasLimit?: string;
    };
    approvalRequired?: {
        token?: string;
        spender?: string;
        /** RAW base units. */
        amount?: string;
        amountFormatted?: string;
    };
}

export interface GatewayEstimateResponse {
    success?: boolean;
    token?: GatewayTokenInfo;
    recipientCount?: number;
    totalAmount?: string;
    fee?: string;
    feePercent?: string;
    totalWithFee?: string;
    /** DECIMAL string (unlike execute's hex gasLimit). */
    suggestedGasLimit?: string;
    estimatedGas?: string;
    note?: string;
}

export class SpraayGatewayError extends Error {
    constructor(
        message: string,
        readonly status?: number,
        readonly body?: unknown,
    ) {
        super(message);
        this.name = 'SpraayGatewayError';
    }
}

export class SpraayGatewayPaymentRequiredError extends SpraayGatewayError {
    constructor(body: unknown) {
        super(
            'The Spraay gateway answered 402 Payment Required. Configure `gatewayFetch` with an x402-capable ' +
                'fetch (for example `wrapFetchWithPaymentFromConfig` from @x402/fetch) funded by a merchant-controlled ' +
                'API-fee wallet. See the README section "Paying gateway fees with x402".',
            402,
            body,
        );
        this.name = 'SpraayGatewayPaymentRequiredError';
    }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SpraayGatewayClientOptions {
    baseUrl?: string;
    fetch?: FetchLike;
    timeoutMs?: number;
    headers?: Record<string, string>;
}

export class SpraayGatewayClient {
    private readonly baseUrl: string;
    private readonly fetchFn: FetchLike;
    private readonly timeoutMs: number;
    private readonly headers: Record<string, string>;

    constructor(options: SpraayGatewayClientOptions = {}) {
        this.baseUrl = (options.baseUrl ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
        this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.headers = options.headers ?? {};
    }

    /** POST /api/v1/batch/execute — returns an unsigned transaction. Never signs or broadcasts anything. */
    execute(input: { recipients: string[]; amounts: string[]; sender: string }): Promise<GatewayExecuteResponse> {
        return this.post<GatewayExecuteResponse>(GATEWAY_EXECUTE_PATH, this.body(input));
    }

    /** POST /api/v1/batch/estimate (detailed form). */
    estimate(input: { recipients: string[]; amounts: string[]; sender: string }): Promise<GatewayEstimateResponse> {
        return this.post<GatewayEstimateResponse>(GATEWAY_ESTIMATE_PATH, this.body(input));
    }

    private body(input: { recipients: string[]; amounts: string[]; sender: string }): GatewayBatchRequest {
        return {
            token: USDC_SYMBOL,
            recipients: input.recipients,
            amounts: input.amounts,
            sender: input.sender,
            chain: GATEWAY_CHAIN_SLUG,
        };
    }

    private async post<T>(path: string, body: GatewayBatchRequest): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response: Response;
        try {
            response = await this.fetchFn(`${this.baseUrl}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json', ...this.headers },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (e: any) {
            throw new SpraayGatewayError(`Spraay gateway request to ${path} failed: ${e?.message ?? e}`);
        } finally {
            clearTimeout(timer);
        }
        const text = await response.text();
        let parsed: unknown;
        try {
            parsed = text ? JSON.parse(text) : undefined;
        } catch {
            parsed = text;
        }
        if (response.status === 402) {
            throw new SpraayGatewayPaymentRequiredError(parsed);
        }
        if (!response.ok) {
            const message =
                parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as any).error) : text;
            throw new SpraayGatewayError(
                `Spraay gateway ${path} answered HTTP ${response.status}: ${message}`,
                response.status,
                parsed,
            );
        }
        if (!parsed || typeof parsed !== 'object') {
            throw new SpraayGatewayError(`Spraay gateway ${path} returned a non-JSON body`, response.status, text);
        }
        if ((parsed as { success?: unknown }).success !== true) {
            throw new SpraayGatewayError(`Spraay gateway ${path} did not report success`, response.status, parsed);
        }
        return parsed as T;
    }
}
